/**
 * Agent Roles Extension
 *
 * Define named agent personas with custom system prompts, models, thinking levels,
 * tool/skill arrays, and optional end-scripts for output validation.
 *
 * Invoke via `--agent <name>` CLI flag or `/agent <name>` in interactive mode.
 *
 * Configuration files (merged, project overrides global):
 *   ~/.pi/agent/agents.json   — global agents
 *   .pi/agents.json           — project agents
 *
 * Model: pure opt-in via two arrays.
 *   tools  — comma-separated tool names. Only these tools are active.
 *            If omitted, the agent has NO tools.
 *   skills — comma-separated skill names. Only these skills are allowed.
 *            If omitted, the agent has NO skills.
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
  /** Comma-separated tool names — opt-in. Omit for NO tools. */
  tools?: string;
  /** Comma-separated skill names — opt-in. Omit for NO skills. */
  skills?: string;
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

/** Parse a comma-separated config string into a trimmed array, filtering empties. */
function parseList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export default function (pi: ExtensionAPI) {
  let currentAgent: string | undefined;
  let agents: AgentRegistry = {};

  // ── Load agent configs on startup ──────────────────────────────────

  pi.on("session_start", (_event, ctx) => {
    const homeDir =
      process.env.PI_CODING_AGENT_DIR ||
      path.join(require("node:os").homedir(), ".pi", "agent");
    const globalPath = path.join(homeDir, "agents.json");
    const projectPath = path.join(ctx.cwd, ".pi", "agents.json");
    agents = mergeAgents(loadAgents(globalPath), loadAgents(projectPath));

    // Apply agent thinking level immediately (before any message is sent)
    const flagAgent = pi.getFlag("agent") as string | undefined;
    if (flagAgent) {
      const config = agents[flagAgent];
      if (config?.thinking && !process.argv.includes("--thinking")) {
        const valid = ["off", "minimal", "low", "medium", "high", "xhigh"];
        if (valid.includes(config.thinking)) {
          pi.setThinkingLevel(
            config.thinking as
              | "off"
              | "minimal"
              | "low"
              | "medium"
              | "high"
              | "xhigh",
          );
        }
      }

      // Show agent capabilities in startup notification
      const toolList = parseList(config?.tools);
      const skillList = parseList(config?.skills);

      ctx.ui.notify(
        [
          `[Agent: ${flagAgent}]`,
          config?.description ?? "",
          `Tools: ${toolList.length > 0 ? toolList.join(", ") : "none"}`,
          `Skills: ${skillList.length > 0 ? skillList.join(", ") : "none"}`,
          `Thinking: ${config?.thinking ?? pi.getThinkingLevel()}`,
        ]
          .filter(Boolean)
          .join("\n"),
        "info",
      );
    }
  });

  // ── Register CLI flag ──────────────────────────────────────────────

  pi.registerFlag("agent", {
    description: "Activate a named agent role (from agents.json)",
    type: "string",
  });

  // ── Apply agent config on each turn ────────────────────────────────

  pi.on("before_agent_start", async (event, ctx) => {
    const flagAgent = pi.getFlag("agent") as string | undefined;
    const agentName = flagAgent || currentAgent;
    if (!agentName) return;

    const config = agents[agentName];
    if (!config) {
      ctx.ui.notify(
        `Agent "${agentName}" not found. Available: ${Object.keys(agents).join(", ") || "none"}`,
        "error",
      );
      return;
    }

    // CLI flags win over agent config
    const argv = process.argv;
    const userSetModel = argv.includes("--model") || argv.includes("-m");
    const userSetThinking = argv.includes("--thinking");
    const userSetTools = argv.includes("--tools") || argv.includes("-t");
    const userSetSkills = argv.includes("--skill") || argv.includes("--no-skills");

    // ── Model ──
    if (config.model && !userSetModel) {
      const parts = config.model.split("/");
      const provider =
        parts.length === 2 ? parts[0] : (ctx.model?.provider ?? "");
      const modelId = parts.length === 2 ? parts[1] : parts[0];
      const model = ctx.modelRegistry.find(provider, modelId);
      if (model) {
        const ok = await pi.setModel(model);
        if (!ok && ctx.hasUI)
          ctx.ui.notify(
            `Model "${config.model}" not available (no API key?)`,
            "warn",
          );
      } else if (ctx.hasUI) {
        ctx.ui.notify(`Model "${config.model}" not found in registry`, "warn");
      }
    }

    // ── Thinking ──
    if (config.thinking && !userSetThinking) {
      const valid = ["off", "minimal", "low", "medium", "high", "xhigh"];
      if (valid.includes(config.thinking)) {
        pi.setThinkingLevel(
          config.thinking as
            | "off"
            | "minimal"
            | "low"
            | "medium"
            | "high"
            | "xhigh",
        );
      }
    }

    // ── Tools — pure opt-in array ──
    if (!userSetTools) {
      const toolList = parseList(config.tools);
      pi.setActiveTools(toolList);
    }

    // ── Skills — pure opt-in array ──
    let skillBlock = "";
    if (!userSetSkills) {
      const skillList = parseList(config.skills);
      if (skillList.length > 0) {
        skillBlock =
          `\n## Skill Restrictions\n` +
          `You are ONLY allowed to use these skills: ${skillList.join(", ")}.\n` +
          `NEVER invoke any other skill via /skill:name.\n` +
          `If you need documentation not covered by these skills, use your available tools instead.\n`;
      } else {
        skillBlock =
          `\n## Skill Restrictions\n` +
          `Skills are DISABLED for this agent. Do NOT invoke /skill: commands.\n`;
      }
    }

    return {
      systemPrompt: config.systemPrompt + skillBlock,
    };
  });

  // ── Block /skill: commands for skills not in the opt-in array ─────

  pi.on("input", async (event, ctx) => {
    const flagAgent = pi.getFlag("agent") as string | undefined;
    const agentName = flagAgent || currentAgent;
    if (!agentName) return;

    const config = agents[agentName];
    if (!config) return;

    const skillMatch = event.text.match(/^\/skill:(\S+)/);
    if (!skillMatch) return;

    // CLI --skill / --no-skills overrides agent config
    if (process.argv.includes("--skill") || process.argv.includes("--no-skills")) return;

    const skillName = skillMatch[1];
    const allowed = parseList(config.skills);

    if (!allowed.includes(skillName)) {
      ctx.ui.notify(
        `Skill "${skillName}" is not in the agent's skills array.` +
          (allowed.length > 0
            ? ` Allowed: ${allowed.join(", ")}`
            : " Skills are disabled for this agent."),
        "error",
      );
      return { action: "handled" };
    }
  });

  // ── End script: run on each assistant message ──────────────────────

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return;

    const hasTextContent = event.message.content?.some(
      (c: any) => c.type === "text",
    );
    if (!hasTextContent) return;

    const flagAgent = pi.getFlag("agent") as string | undefined;
    const agentName = flagAgent || currentAgent;
    if (!agentName) return;

    const config = agents[agentName];
    if (!config?.endScript) return;

    const homeDir =
      process.env.PI_CODING_AGENT_DIR ||
      path.join(require("node:os").homedir(), ".pi", "agent");
    const scriptPath = path.resolve(homeDir, "end-scripts", config.endScript);

    let scriptFn:
      | ((input: {
          agentName: string;
          messages: Array<typeof event.message>;
          config: AgentConfig;
        }) =>
          | { ok: true; cleanCommand?: string; extractionMethod?: string }
          | { ok: false; error: string })
      | undefined;
    try {
      delete require.cache[require.resolve(scriptPath)];
      scriptFn = require(scriptPath);
    } catch {
      return;
    }
    if (typeof scriptFn !== "function") return;

    const result = scriptFn({
      agentName,
      messages: [event.message],
      config,
    });

    if (result && !result.ok) {
      return {
        message: {
          ...event.message,
          content: [
            { type: "text", text: result.error || "Validation failed." },
          ],
        },
      };
    }

    if (result && result.ok && result.cleanCommand) {
      return {
        message: {
          ...event.message,
          content: [{ type: "text", text: result.cleanCommand }],
        },
      };
    }
  });

  // ── Interactive /agent command ─────────────────────────────────────

  pi.registerCommand("agent", {
    description:
      "Set or list agent roles. Usage: /agent <name> or /agent list",
    handler: async (args, ctx) => {
      const trimmed = args?.trim();
      if (!trimmed || trimmed === "list") {
        const names = Object.keys(agents);
        if (names.length === 0) {
          ctx.ui.notify(
            "No agents configured. Create ~/.pi/agent/agents.json or .pi/agents.json",
            "info",
          );
          return;
        }
        const lines = names.map((name) => {
          const c = agents[name];
          const toolList = parseList(c.tools);
          const skillList = parseList(c.skills);
          return [
            name,
            c.description ? ` — ${c.description}` : "",
            c.model ? ` [model: ${c.model}]` : "",
            c.thinking ? ` [thinking: ${c.thinking}]` : "",
            toolList.length > 0 ? ` [tools: ${toolList.join(",")}]` : "",
            skillList.length > 0 ? ` [skills: ${skillList.join(",")}]` : "",
          ].join("");
        });
        ctx.ui.notify(
          `Available agents:\n${lines.join("\n")}`,
          "info",
        );
      } else if (trimmed === "off" || trimmed === "clear") {
        currentAgent = undefined;
        ctx.ui.notify("Agent role cleared. Back to default.", "info");
      } else {
        if (!agents[trimmed]) {
          ctx.ui.notify(
            `Unknown agent "${trimmed}". Available: ${Object.keys(agents).join(", ") || "none"}`,
            "error",
          );
          return;
        }
        currentAgent = trimmed;
        const c = agents[trimmed];
        ctx.ui.notify(
          `Agent set to "${trimmed}"${c.description ? ` — ${c.description}` : ""}. It will activate on your next message.`,
          "info",
        );
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
