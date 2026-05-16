import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { TreeState, RunConfig, SubagentTask } from "./types.js";
import { addNode } from "./types.js";
import { resolveTools } from "./tools.js";

let _authStorage: AuthStorage | null = null;
let _modelRegistry: ModelRegistry | null = null;

function getAuth(): AuthStorage {
  if (!_authStorage) _authStorage = AuthStorage.create();
  return _authStorage;
}

function getRegistry(): ModelRegistry {
  if (!_modelRegistry) {
    _modelRegistry = ModelRegistry.create(getAuth());
  }
  return _modelRegistry;
}

function buildUserPrompt(task: string, maxAgents: number, toolNames: string[]): string {
  if (maxAgents <= 1) return task;

  const toolList = toolNames.length > 0
    ? `\nAvailable tools: ${toolNames.join(", ")}`
    : "";

  return `You MUST delegate this task to subagents. Output EXACTLY a JSON delegation plan in this format (nothing else):

\`\`\`delegate
{
  "tasks": [
    { "name": "Task label", "prompt": "Detailed instructions...", "tools": ["web_search"] }
  ]
}
\`\`\`

Rules:
- Each subagent gets budget ${maxAgents - 1}${toolList}
- Grant tools via the "tools" array (subset of your tools). Omit = no tools.
- Each subagent prompt must be detailed, self-contained, and goal-oriented.
- Include relevant context from the user's request so subagents understand the bigger picture.
- Output ONLY the delegate block — no text before or after.

Task to delegate: ${task}`;
}

interface DelegationPlan {
  tasks: SubagentTask[];
}

function extractDelegationPlan(text: string): DelegationPlan | null {
  const match = text.match(/```(?:json\s*)?delegate\s*([\s\S]*?)```/i);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    if (Array.isArray(parsed.tasks)) {
      const tasks = parsed.tasks
        .filter((t: any) => typeof t.prompt === "string")
        .map((t: any) => ({
          name: typeof t.name === "string" ? t.name : t.prompt.slice(0, 40),
          prompt: t.prompt,
          tools: Array.isArray(t.tools) ? t.tools : undefined,
        }));
      if (tasks.length > 0) return { tasks };
    }
    if (Array.isArray(parsed.prompts)) {
      const tasks = parsed.prompts
        .filter((p: any) => typeof p === "string")
        .map((p: string) => ({ name: p.slice(0, 40), prompt: p }));
      if (tasks.length > 0) return { tasks };
    }
  } catch {}
  return null;
}

function validateTools(
  requested: string[],
  parentTools: string[],
): string[] {
  return requested.filter((t) => parentTools.includes(t));
}

async function executeSubagents(
  tasks: SubagentTask[],
  childBudget: number,
  parentTools: string[],
  treeState: TreeState,
  parentId: string,
  config: RunConfig,
  signal: AbortSignal,
  remainingBudget: { value: number },
): Promise<
  Array<{ name: string; prompt: string; output: string; status: "success" | "error"; error?: string }>
> {
  const results = await Promise.all(
    tasks.map(async (task) => {
      if (remainingBudget.value <= 0) {
        return {
          name: task.name,
          prompt: task.prompt,
          output: "Budget exhausted.",
          status: "error" as const,
          error: "Budget exhausted",
        };
      }

      const childTools = task.tools
        ? validateTools(task.tools, parentTools)
        : [];

      const childNode = addNode(
        treeState, parentId, task.name, task.prompt,
        childBudget, childTools,
      );

      try {
        childNode.status = "running";
        childNode.startTime = Date.now();
        remainingBudget.value--;

        const output = await runAgent(
          task.prompt, childBudget, childTools,
          treeState, childNode.id, config, signal,
        );

        childNode.status = "success";
        childNode.output = output;
        childNode.endTime = Date.now();
        return { name: task.name, prompt: task.prompt, output, status: "success" as const };
      } catch (err: any) {
        childNode.status = "error";
        childNode.error = err?.message || String(err);
        childNode.endTime = Date.now();
        return {
          name: task.name, prompt: task.prompt,
          output: err?.message || String(err),
          status: "error" as const, error: err?.message,
        };
      }
    }),
  );
  return results;
}

function formatResultsForSynthesis(
  results: Array<{ name: string; prompt: string; output: string; status: string }>,
): string {
  let text = "Subagent results:\n\n";
  for (const r of results) {
    text += `--- ${r.name} (${r.status}) ---\nTask: ${r.prompt}\nOutput:\n${r.output}\n\n`;
  }
  text += "Synthesize these into a comprehensive final answer. Do not mention subagents.";
  return text;
}

export async function runAgent(
  prompt: string,
  maxAgents: number,
  toolNames: string[],
  treeState: TreeState,
  nodeId: string,
  config: RunConfig,
  signal: AbortSignal,
): Promise<string> {
  const registry = getRegistry();
  let model = config.model
    ? registry.find(
        config.model.includes("/") ? config.model.split("/")[0] : "anthropic",
        config.model.includes("/") ? config.model.split("/")[1] : config.model,
      )
    : undefined;

  if (!model) {
    const available = await registry.getAvailable();
    model = available[0];
  }
  if (!model) throw new Error("No model available.");

  const { custom } = resolveTools(toolNames, config.cwd);

  // Minimal session: pi defaults, no prompt manipulation
  const { session } = await createAgentSession({
    cwd: config.cwd,
    sessionManager: SessionManager.inMemory(),
    authStorage: getAuth(),
    modelRegistry: registry,
    model,
    thinkingLevel: (config.thinkingLevel as any) ?? "high",
    tools: toolNames,
    customTools: custom,
  });

  const budget = { value: maxAgents };
  let currentPrompt = buildUserPrompt(prompt, maxAgents, toolNames);

  try {
    for (let turn = 0; turn < 10; turn++) {
      if (signal.aborted) throw new Error("Aborted");

      let response = "";
      const unsub = session.subscribe((event: any) => {
        if (
          event.type === "message_update" &&
          event.assistantMessageEvent.type === "text_delta"
        ) {
          response += event.assistantMessageEvent.delta;
        }
      });

      await session.prompt(currentPrompt);
      unsub();
      if (signal.aborted) throw new Error("Aborted");

      response = response.trim();

      // Check for delegation plan
      if (maxAgents > 1 && budget.value > 0) {
        const plan = extractDelegationPlan(response);
        if (plan && plan.tasks.length > 0) {
          const cappedTasks = plan.tasks.slice(0, budget.value);
          const childBudget = budget.value - 1;
          const results = await executeSubagents(
            cappedTasks, childBudget, toolNames,
            treeState, nodeId, config, signal, budget,
          );
          currentPrompt = formatResultsForSynthesis(results);
          continue;
        }
      }

      session.dispose();
      return response;
    }

    session.dispose();
    return "(max turns)";
  } catch (err: any) {
    session.dispose();
    throw err;
  }
}
