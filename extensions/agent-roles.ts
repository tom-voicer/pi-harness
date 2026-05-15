/**
 * Agent Roles Extension
 *
 * Define named agent personas with custom system prompts, models, thinking levels,
 * tool/skill restrictions, and optional end-scripts for output validation.
 *
 * Invoke via `--agent <name>` CLI flag or `/agent <name>` in interactive mode.
 *
 * Configuration files (merged, project overrides global):
 *   ~/.pi/agent/agents.json   — global agents
 *   .pi/agents.json           — project agents
 *
 * End scripts:
 *   ~/.pi/agent/end-scripts/  — JS files that post-process agent output
 *   Export: module.exports = function(input) => { ok: true } | { ok: false, error: string }
 *   input = { agentName, messages, config }
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

interface AgentConfig {
  description?: string;
  systemPrompt: string;
  model?: string;
  thinking?: string;
  tools?: string;
  blockedTools?: string;
  skills?: string;
  blockedSkills?: string;
  /** JS file in ~/.pi/agent/end-scripts/ that runs after each agent turn */
  endScript?: string;
}

type AgentRegistry = Record<string, AgentConfig>;

function loadAgents(filePath: string): AgentRegistry {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return {};
  }
}

function mergeAgents(global: AgentRegistry, project: AgentRegistry): AgentRegistry {
  return { ...global, ...project };
}

export default function (pi: ExtensionAPI) {
  let currentAgent: string | undefined;
  let agents: AgentRegistry = {};

  // --- Load agent configs on startup ---
  pi.on("session_start", (_event, ctx) => {
    const homeDir = process.env.PI_CODING_AGENT_DIR || path.join(require("node:os").homedir(), ".pi", "agent");
    const globalPath = path.join(homeDir, "agents.json");
    const projectPath = path.join(ctx.cwd, ".pi", "agents.json");
    agents = mergeAgents(loadAgents(globalPath), loadAgents(projectPath));
  });

  // --- Register CLI flag ---
  pi.registerFlag("agent", {
    description: "Activate a named agent role (from agents.json)",
    type: "string",
  });

  // --- Inject system prompt, model, tools, skills when agent is active ---
  pi.on("before_agent_start", async (event, ctx) => {
    const flagAgent = pi.getFlag("agent") as string | undefined;
    const agentName = flagAgent || currentAgent;
    if (!agentName) return;

    const config = agents[agentName];
    if (!config) {
      ctx.ui.notify(`Agent "${agentName}" not found. Available: ${Object.keys(agents).join(", ") || "none"}`, "error");
      return;
    }

    // Check which flags the user explicitly passed on the CLI (these win over agent config)
    const argv = process.argv;
    const userSetModel = argv.includes("--model") || argv.includes("-m");
    const userSetThinking = argv.includes("--thinking");
    const userSetTools = argv.includes("--tools") || argv.includes("-t");
    const userSetSkills = argv.includes("--skill") || argv.includes("--no-skills");

    // --- Model ---
    if (config.model && !userSetModel) {
      const parts = config.model.split("/");
      const provider = parts.length === 2 ? parts[0] : (ctx.model?.provider ?? "");
      const modelId = parts.length === 2 ? parts[1] : parts[0];
      const model = ctx.modelRegistry.find(provider, modelId);
      if (model) {
        const ok = await pi.setModel(model);
        if (!ok && ctx.hasUI) ctx.ui.notify(`Model "${config.model}" not available (no API key?)`, "warn");
      } else if (ctx.hasUI) {
        ctx.ui.notify(`Model "${config.model}" not found in registry`, "warn");
      }
    }

    // --- Thinking ---
    if (config.thinking && !userSetThinking) {
      const valid = ["off", "minimal", "low", "medium", "high", "xhigh"];
      if (valid.includes(config.thinking)) {
        pi.setThinkingLevel(config.thinking as "off" | "minimal" | "low" | "medium" | "high" | "xhigh");
      }
    }

    // --- Tools ---
    if (!userSetTools) {
      if (config.tools) {
        pi.setActiveTools(config.tools.split(",").map((t) => t.trim()).filter(Boolean));
      } else if (config.blockedTools) {
        const blocked = new Set(config.blockedTools.split(",").map((t) => t.trim()).filter(Boolean));
        pi.setActiveTools(pi.getAllTools().map((t) => t.name).filter((n) => !blocked.has(n)));
      }
    }

    // --- Skills (soft: prompt instruction; hard: input handler below) ---
    let skillInstruction = "";
    if (!userSetSkills) {
      if (config.skills) {
        const allowed = config.skills.split(",").map((s) => s.trim()).filter(Boolean);
        skillInstruction = `\n## Skill Restrictions\nYou are ONLY allowed to use these skills: ${allowed.join(", ")}. NEVER invoke any other skill via /skill:name. If you need documentation not covered by these skills, use your available tools instead.\n`;
      } else if (config.blockedSkills) {
        const blocked = config.blockedSkills.split(",").map((s) => s.trim()).filter(Boolean);
        skillInstruction = `\n## Skill Restrictions\nYou are NOT allowed to use these skills: ${blocked.join(", ")}. All other skills are available. If you need documentation covered by a blocked skill, use your tools instead.\n`;
      }
    }

    // Append a hard output constraint AFTER the base system prompt so it's
    // the LAST thing the model reads (models weight later text more heavily).
    // The base pi prompt says "be helpful" which can override piper's output
    // format rules when they're only at the beginning.
    const outputConstraint = "\n\n## ⛔ OUTPUT CONSTRAINT — READ THIS LAST\n\n" +
      "You are the pipe architect. Your ONLY allowed output is a raw shell pipe command. " +
      "You must NEVER output markdown, explanations, tables, summaries, or answers of any kind. " +
      "Output the pipe command and nothing else — no text before, no text after, no code fences, no backticks. " +
      "Your entire response must be a single line: the raw pipe command.";

    return {
      systemPrompt: config.systemPrompt + skillInstruction + "\n\n" + event.systemPrompt + outputConstraint,
    };
  });

  // --- Block /skill: commands for disallowed skills ---
  pi.on("input", async (event, ctx) => {
    const flagAgent = pi.getFlag("agent") as string | undefined;
    const agentName = flagAgent || currentAgent;
    if (!agentName) return;
    const config = agents[agentName];
    if (!config) return;

    const skillMatch = event.text.match(/^\/skill:(\S+)/);
    if (!skillMatch) return;
    const skillName = skillMatch[1];

    if (process.argv.includes("--skill") || process.argv.includes("--no-skills")) return;

    if (config.skills) {
      const allowed = config.skills.split(",").map((s) => s.trim()).filter(Boolean);
      if (!allowed.includes(skillName)) {
        ctx.ui.notify(`Skill "${skillName}" is blocked for agent "${agentName}". Allowed: ${allowed.join(", ")}`, "error");
        return { action: "handled" };
      }
    } else if (config.blockedSkills) {
      const blocked = config.blockedSkills.split(",").map((s) => s.trim()).filter(Boolean);
      if (blocked.includes(skillName)) {
        ctx.ui.notify(`Skill "${skillName}" is blocked for agent "${agentName}".`, "error");
        return { action: "handled" };
      }
    }
  });

  // --- End script: run on each assistant message to sanitize output ---
  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return;

    // Skip tool-call messages — only validate final text responses.
    // Tool calls have no text content yet; validating them would block the
    // agent from using tools (tavily_search, etc.) before producing output.
    const hasTextContent = event.message.content?.some((c: any) => c.type === "text");
    if (!hasTextContent) return;

    const flagAgent = pi.getFlag("agent") as string | undefined;
    const agentName = flagAgent || currentAgent;
    if (!agentName) return;
    const config = agents[agentName];
    if (!config?.endScript) return;

    const homeDir = process.env.PI_CODING_AGENT_DIR ||
      path.join(require("node:os").homedir(), ".pi", "agent");
    const scriptPath = path.resolve(homeDir, "end-scripts", config.endScript);

    let scriptFn: ((input: { agentName: string; messages: Array<typeof event.message>; config: AgentConfig }) => { ok: true; cleanCommand?: string; extractionMethod?: string } | { ok: false; error: string }) | undefined;
    try {
      delete require.cache[require.resolve(scriptPath)];
      scriptFn = require(scriptPath);
    } catch {
      return;
    }
    if (typeof scriptFn !== "function") return;

    const result = scriptFn({ agentName, messages: [event.message], config });

    if (result && !result.ok) {
      // Validation failed — replace message with error
      return {
        message: {
          ...event.message,
          content: [{ type: "text", text: result.error || `Pipe validation failed.` }],
        },
      };
    }

    if (result && result.ok && result.cleanCommand) {
      // Validation passed — replace message with the clean command
      return {
        message: {
          ...event.message,
          content: [{ type: "text", text: result.cleanCommand }],
        },
      };
    }
  });

  // --- Interactive /agent command ---
  pi.registerCommand("agent", {
    description: "Set or list agent roles. Usage: /agent <name> or /agent list",
    handler: async (args, ctx) => {
      const trimmed = args?.trim();
      if (!trimmed || trimmed === "list") {
        const names = Object.keys(agents);
        if (names.length === 0) {
          ctx.ui.notify("No agents configured. Create ~/.pi/agent/agents.json or .pi/agents.json", "info");
          return;
        }
        const lines = names.map((name) => {
          const c = agents[name];
          return `${name}${c.description ? ` — ${c.description}` : ""}${c.model ? ` [model: ${c.model}]` : ""}${c.thinking ? ` [thinking: ${c.thinking}]` : ""}`;
        });
        ctx.ui.notify(`Available agents:\n${lines.join("\n")}`, "info");
      } else if (trimmed === "off" || trimmed === "clear") {
        currentAgent = undefined;
        ctx.ui.notify("Agent role cleared. Back to default.", "info");
      } else {
        if (!agents[trimmed]) {
          ctx.ui.notify(`Unknown agent "${trimmed}". Available: ${Object.keys(agents).join(", ") || "none"}`, "error");
          return;
        }
        currentAgent = trimmed;
        const c = agents[trimmed];
        ctx.ui.notify(`Agent set to "${trimmed}"${c.description ? ` — ${c.description}` : ""}. It will activate on your next message.`, "info");
      }
    },
    getArgumentCompletions: (prefix: string) => {
      const items = Object.keys(agents)
        .concat(["list", "off", "clear"])
        .filter((name) => name.startsWith(prefix))
        .map((name) => ({ value: name, label: name }));
      return items.length > 0 ? items : null;
    },
  });
}
