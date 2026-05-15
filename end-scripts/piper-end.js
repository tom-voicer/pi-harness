/**
 * Piper End Script — validates and sanitizes generated pipe commands.
 *
 * Runs after the piper agent finishes. Two-phase pipeline:
 *
 *   Phase 1 (LLM extraction): uses `llm --schema` to extract a clean
 *     pipe command from piper's raw output — strips markdown fences,
 *     explanations, multiple versions, and any non-command text.
 *
 *   Phase 2 (Deterministic validation): 7 rule-based checks on the
 *     extracted command — allowlist, pi must have -p, balanced quotes,
 *     no empty segments, dangerous patterns, pi/llm have prompts,
 *     no file redirects.
 *
 * Interface: module.exports = function(input) => { ok, error? }
 */

const { spawnSync } = require("child_process");

// ─── Config ──────────────────────────────────────────────────────────

const ALLOWED_COMMANDS = new Set([
  "pi", "llm",
  "curl", "wget",
  "jq",
  "grep", "sed", "awk", "tr", "cut",
  "sort", "uniq", "wc",
  "head", "tail", "column", "tee", "cat", "echo",
  "xargs", "pv",
  "bat", "rich",
  "find", "ls",
  "python3", "python",
  "set", "export", "source", ".",
]);

const DANGEROUS_PATTERNS = [
  { pattern: /\brm\b/, name: "rm" },
  { pattern: /\bsudo\b/, name: "sudo" },
  { pattern: /\bchmod\b/, name: "chmod" },
  { pattern: /\bchown\b/, name: "chown" },
  { pattern: /\bmv\b/, name: "mv" },
  { pattern: /\bdd\b/, name: "dd" },
  { pattern: /\bmkfs\./, name: "mkfs" },
  { pattern: />\s*\/dev\//, name: "> /dev/ redirect (destructive)" },
  { pattern: /\beval\b/, name: "eval" },
  { pattern: /\bexec\b(?!\s+-[a-z])/, name: "exec" },
  { pattern: /\bshutdown\b/, name: "shutdown" },
  { pattern: /\breboot\b/, name: "reboot" },
  { pattern: /\bkill\b/, name: "kill" },
  { pattern: /\bpkill\b/, name: "pkill" },
  { pattern: /\bgit\s+push\b/, name: "git push" },
  { pattern: /\bgit\s+reset\b/, name: "git reset" },
  { pattern: /\bdocker\s+(rm|kill|prune|system\s+prune)\b/, name: "docker destructive" },
];

// ─── Quote-aware utilities ───────────────────────────────────────────

function splitRespectingQuotes(str, delimiter) {
  const result = [];
  let current = "";
  let inSingle = false, inDouble = false;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (!inSingle && !inDouble && str.slice(i, i + delimiter.length) === delimiter) {
      result.push(current);
      current = "";
      i += delimiter.length - 1;
      continue;
    }
    current += ch;
  }
  result.push(current);
  return result;
}

function tokenizeRespectingQuotes(str) {
  const tokens = [];
  let tok = "";
  let inSingle = false, inDouble = false;
  for (const ch of str) {
    if (ch === "'" && !inDouble) { inSingle = !inSingle; tok += ch; }
    else if (ch === '"' && !inSingle) { inDouble = !inDouble; tok += ch; }
    else if ((ch === " " || ch === "\t") && !inSingle && !inDouble) {
      if (tok) tokens.push(tok);
      tok = "";
    } else tok += ch;
  }
  if (tok) tokens.push(tok);
  return tokens;
}

function extractCommandName(segment) {
  const tokens = tokenizeRespectingQuotes(segment);
  const skip = new Set(["env", "sudo", "timeout", "nice", "stdbuf", "unbuffer", "nohup", "exec"]);
  for (const t of tokens) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) continue;
    if (skip.has(t)) continue;
    return t;
  }
  return null;
}

function getPipeSegments(code) {
  const collapsed = code.replace(/\\\s*\n\s*/g, " ");
  return splitRespectingQuotes(collapsed, "|").map(s => s.trim()).filter(Boolean);
}

// ─── Phase 1: LLM-based extraction ───────────────────────────────────

/**
 * Use `llm --schema` to extract the clean pipe command from raw output.
 * Returns the command string, or null if extraction failed.
 */
function extractWithLlm(rawText) {
  // Check if llm is available (with 2s timeout)
  const check = spawnSync("which", ["llm"], { timeout: 2000, stdio: "pipe" });
  if (check.status !== 0) return null;

  const schema = "command: the full raw shell pipe command string with no markdown formatting, no code fences, no explanations — just the command";
  const prompt = "Extract ONLY the shell pipe command from this text. Return the raw command string — strip all markdown code fences, all explanations, all stage descriptions, all tables, all alternatives. If there are multiple versions, pick the first complete one. Do NOT modify the command itself — just extract it as-is.";

  try {
    const result = spawnSync(
      "llm",
      ["--schema", schema, prompt],
      {
        input: rawText,
        timeout: 15000,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
    if (result.status !== 0 || !result.stdout) return null;
    const parsed = JSON.parse(result.stdout.trim());
    if (parsed.command && typeof parsed.command === "string") {
      const cmd = parsed.command.trim();
      // Sanity: must contain a pipe or start with pi/llm/curl/cat/echo
      if (/\||^(pi|llm|curl|cat|echo)\s/.test(cmd)) {
        return cmd;
      }
    }
    return null;
  } catch {
    return null; // llm call failed — fall through to regex extraction
  }
}

/**
 * Fallback: regex-based extraction of code blocks or bare commands.
 */
function extractWithRegex(rawText) {
  // Try fenced code blocks first
  const codeBlockRe = /```(?:bash|sh|shell)?\n([\s\S]*?)```/g;
  let match;
  const codes = [];
  while ((match = codeBlockRe.exec(rawText)) !== null) {
    codes.push(match[1].trim());
  }
  if (codes.length > 0) return codes[0]; // first code block

  // Try bare pipe-like text
  const trimmed = rawText.trim();
  if (trimmed && (trimmed.includes("|") || /^(pi|llm|curl|cat|echo)\s/.test(trimmed))) {
    return trimmed;
  }
  return null;
}

// ─── Phase 2: Deterministic validators ───────────────────────────────

function validateCommandAllowlist(code) {
  const errors = [];
  const segments = getPipeSegments(code);
  for (const seg of segments) {
    for (const part of splitRespectingQuotes(seg, "&&")) {
      for (const orp of splitRespectingQuotes(part, "||")) {
        for (const chunk of orp.split(";")) {
          const cmd = extractCommandName(chunk.trim());
          if (cmd && !ALLOWED_COMMANDS.has(cmd)) {
            const idx = code.indexOf(cmd);
            const ctx = code.slice(Math.max(0, idx - 15), Math.min(code.length, idx + cmd.length + 25));
            errors.push(`Forbidden command \`${cmd}\` near \`...${ctx.trim()}...\``);
          }
        }
      }
    }
  }
  return errors;
}

function validatePiMustHaveP(code) {
  const errors = [];
  const re = /\bpi\b(?!\s+-p\b)/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    const after = code.slice(m.index).trim();
    if (!/^pi\s+-p\b/.test(after)) {
      errors.push("`pi` used without `-p` flag. Always use `pi -p`.");
    }
  }
  return errors;
}

function validateBalancedQuotes(code) {
  let inSingle = false, inDouble = false;
  let singleOpen = 0, doubleOpen = 0;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (ch === "\\" && i + 1 < code.length) { i++; continue; } // skip escaped chars
    if (ch === "'" && !inDouble) { inSingle = !inSingle; singleOpen++; }
    else if (ch === '"' && !inSingle) { inDouble = !inDouble; doubleOpen++; }
  }
  const errors = [];
  if (inSingle) errors.push(`Unbalanced single quotes — missing closing '`);
  if (inDouble) errors.push(`Unbalanced double quotes — missing closing "`);
  return errors;
}

function validateNoEmptySegments(code) {
  const errors = [];
  if (/^\s*\|/.test(code)) errors.push("Pipe starts with `|` (leading pipe)");
  if (/\|\s*$/.test(code)) errors.push("Pipe ends with `|` (trailing pipe)");
  if (/\|\s*\|/.test(code)) errors.push("Empty pipe segment (`||` or `| |`)");
  return errors;
}

function validateDangerousPatterns(code) {
  const errors = [];
  for (const { pattern, name } of DANGEROUS_PATTERNS) {
    if (pattern.test(code)) {
      const m = code.match(pattern);
      errors.push(`Dangerous pattern detected: \`${m ? m[0] : name}\` (${name} is forbidden)`);
    }
  }
  return errors;
}

function validatePiHasPrompt(code) {
  const errors = [];
  const re = /pi\s+-p(\s+--?\S+(?:\s+\S+)?)*\s*/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    const rest = code.slice(m.index + m[0].length).trim();
    if (!rest || rest.startsWith("|")) {
      errors.push("`pi -p` is missing a prompt argument (empty command)");
    }
  }
  return errors;
}

function validateLlmHasPrompt(code) {
  const errors = [];
  const segments = getPipeSegments(code);
  for (const seg of segments) {
    const tokens = tokenizeRespectingQuotes(seg);
    const llmIdx = tokens.findIndex(t => t === "llm");
    if (llmIdx === -1) continue;

    let i = llmIdx + 1;
    let hasPrompt = false;
    const skipFlags = ["-m", "--model", "-s", "--system", "-t", "--template",
      "-o", "--option", "--schema", "--schema-multi",
      "--no-stream", "-c", "--continue", "--cid", "--conversation"];
    while (i < tokens.length) {
      const t = tokens[i];
      if (skipFlags.includes(t)) { i += 2; }
      else if (t.startsWith("-")) { i++; }
      else { hasPrompt = true; break; }
    }
    if (!hasPrompt) errors.push("`llm` command is missing a prompt argument");
  }
  return errors;
}

function validateNoFileRedirects(code) {
  const errors = [];
  const re = /(?<!\d\s)(?<!\d)>>?\s*(?!\/dev\/null|\/dev\/tty|\/dev\/stderr|\/dev\/stdout|&[12])[^\s|&;]+/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    const redirect = m[0].trim();
    if (redirect.startsWith("|")) continue;
    errors.push(`File redirect detected: \`${redirect}\`. Never write to files — output goes to stdout only.`);
  }
  return errors;
}

// ─── Main entry point ────────────────────────────────────────────────

module.exports = function (input) {
  // Step 1: Collect raw text from all assistant messages
  const rawTexts = [];
  for (const msg of input.messages) {
    if (msg.role !== "assistant") continue;
    for (const block of msg.content) {
      if (block.type === "text") rawTexts.push(block.text);
    }
  }
  const rawOutput = rawTexts.join("\n");

  // Step 2: Extract clean pipe command (llm first, regex fallback)
  let cleanCommand = extractWithLlm(rawOutput);
  const extractionMethod = cleanCommand ? "llm" : "regex";

  if (!cleanCommand) {
    cleanCommand = extractWithRegex(rawOutput);
  }

  // Strip leading/trailing backticks from extracted commands (handles inline
  // code wrappers like `llm "..." | jq '.'` that models sometimes produce)
  if (cleanCommand) {
    cleanCommand = cleanCommand.replace(/^`+|`+$/g, "").trim();
  }

  if (!cleanCommand) {
    const isEmpty = !rawOutput || rawOutput.trim() === "";
    const hint = isEmpty
      ? `\n\n💡 **Empty output detected.** The agent produced no text at all.\n` +
        `This usually means the agent was confused by an ambiguous request.\n` +
        `**For the piper agent:** When a user asks something open-ended like\n` +
        `\"I want to build X\" or \"Help me with Y\", always default to the\n` +
        `search→extract→organize pattern:\n` +
        `\`pi -p "search the web for [topic] and extract top results" | llm "organize into a helpful guide"\``
      : "";
    return {
      ok: false,
      error:
        `## 🚫 Pipe Validation FAILED\n\n` +
        `Could not extract a pipe command from the agent's output. ` +
        `Expected a raw shell pipe command (e.g. \`pi -p "..." | llm "..."\`). ` +
        `Agent output was:\n\n\`\`\`\n${rawOutput.slice(0, 500) || "(completely empty)"}\n\`\`\`` +
        hint,
    };
  }

  // Step 3: Run all deterministic validators on the clean command
  const allErrors = [
    ...validateCommandAllowlist(cleanCommand),
    ...validatePiMustHaveP(cleanCommand),
    ...validateBalancedQuotes(cleanCommand),
    ...validateNoEmptySegments(cleanCommand),
    ...validateDangerousPatterns(cleanCommand),
    ...validatePiHasPrompt(cleanCommand),
    ...validateLlmHasPrompt(cleanCommand),
    ...validateNoFileRedirects(cleanCommand),
  ];

  if (allErrors.length > 0) {
    const deduped = [...new Set(allErrors)];
    return {
      ok: false,
      error:
        `## 🚫 Pipe Validation FAILED\n\n` +
        `Agent **${input.agentName}** produced a pipe with ${deduped.length} issue(s):\n\n` +
        deduped.map((e, i) => `${i + 1}. ${e}`).join("\n") +
        `\n\n**Extracted command:**\n\`\`\`\n${cleanCommand}\n\`\`\`\n\n` +
        `**Allowed commands:** ${[...ALLOWED_COMMANDS].sort().join(", ")}\n\n` +
        `Rules:\n` +
        `- Always use \`pi -p\` (never \`pi\` alone)\n` +
        `- Every command needs a prompt/argument\n` +
        `- No file redirects (\`>\`)\n` +
        `- No destructive commands\n` +
        `- Output goes to stdout only`,
    };
  }

  // Step 4: All checks passed — output the clean command for display
  return {
    ok: true,
    // Pass through the clean command so the extension can display it nicely
    cleanCommand,
    extractionMethod,
  };
};
