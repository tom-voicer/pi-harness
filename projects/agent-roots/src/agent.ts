import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import type { TreeState, RunConfig, SubagentTask } from "./types.js";
import { addNode } from "./types.js";
import { buildSystemPrompt } from "./prompt.js";
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

interface DelegationPlan {
  tasks: SubagentTask[];
}

function extractDelegationPlan(text: string): DelegationPlan | null {
  // Try JSON code fence with "delegate" tag
  const delegateMatch = text.match(
    /```(?:json\s*)?delegate\s*([\s\S]*?)```/i,
  );
  if (delegateMatch) {
    try {
      const parsed = JSON.parse(delegateMatch[1]);
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
      // Old format: { prompts: [...] }
      if (Array.isArray(parsed.prompts)) {
        const tasks = parsed.prompts
          .filter((p: any) => typeof p === "string")
          .map((p: string) => ({ name: p.slice(0, 40), prompt: p }));
        if (tasks.length > 0) return { tasks };
      }
    } catch { /* fall through */ }
  }

  // Try DeepSeek <function-call> format
  const fcMatch = text.match(
    /<function-call>\s*(\{[\s\S]*?\})\s*<\/function-call>/i,
  );
  if (fcMatch) {
    try {
      const parsed = JSON.parse(fcMatch[1]);
      const prompts = parsed.arguments?.prompts;
      if (Array.isArray(prompts)) {
        const tasks = prompts
          .filter((p: any) => typeof p === "string")
          .map((p: string) => ({ name: p.slice(0, 40), prompt: p }));
        if (tasks.length > 0) return { tasks };
      }
    } catch { /* fall through */ }
  }

  // Try bare JSON array of {name, prompt} objects
  const jsonBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonBlockMatch) {
    try {
      const parsed = JSON.parse(jsonBlockMatch[1]);
      if (Array.isArray(parsed)) {
        const tasks = parsed
          .filter((item: any) => typeof item.prompt === "string")
          .map((item: any) => ({
            name: typeof item.name === "string" ? item.name : item.prompt.slice(0, 40),
            prompt: item.prompt,
            tools: Array.isArray(item.tools) ? item.tools : undefined,
          }));
        if (tasks.length > 0) return { tasks };
      }
    } catch { /* fall through */ }
  }

  return null;
}

function validateTools(
  requested: string[],
  parentTools: string[],
  taskName: string,
): string[] {
  const valid = requested.filter((t) => parentTools.includes(t));
  const rejected = requested.filter((t) => !parentTools.includes(t));

  if (rejected.length > 0) {
    // Tools not in parent's set are silently dropped
  }

  return valid;
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
          output: "Budget exhausted. No more subagents can be spawned.",
          status: "error" as const,
          error: "Budget exhausted",
        };
      }

      // Resolve child's tools: subset of parent's tools
      const childTools = task.tools
        ? validateTools(task.tools, parentTools, task.name)
        : [];

      const childNode = addNode(
        treeState,
        parentId,
        task.name,
        task.prompt,
        childBudget,
        childTools,
      );

      try {
        childNode.status = "running";
        childNode.startTime = Date.now();
        remainingBudget.value--;

        const output = await runAgent(
          task.prompt,
          childBudget,
          childTools,
          treeState,
          childNode.id,
          config,
          signal,
        );

        childNode.status = "success";
        childNode.output = output;
        childNode.endTime = Date.now();

        return { name: task.name, prompt: task.prompt, output, status: "success" as const };
      } catch (err: any) {
        const errorMsg = err?.message || String(err) || "Unknown error";
        childNode.status = "error";
        childNode.error = errorMsg;
        childNode.endTime = Date.now();

        return {
          name: task.name,
          prompt: task.prompt,
          output: errorMsg,
          status: "error" as const,
          error: errorMsg,
        };
      }
    }),
  );

  return results;
}

function formatResultsForSynthesis(
  results: Array<{ name: string; prompt: string; output: string; status: string }>,
): string {
  let text =
    "Here are the results from your subagents. Synthesize them into a comprehensive final answer:\n\n";

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    text += `--- Subagent: ${r.name} (${r.status}) ---\n`;
    text += `Task: ${r.prompt}\n`;
    text += `Output:\n${r.output}\n\n`;
  }

  text +=
    "Now provide your final synthesized answer. Be thorough and well-structured. Do not mention subagents or the delegation mechanism.";

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
        config.model.includes("/")
          ? config.model.split("/")[0]
          : "anthropic",
        config.model.includes("/")
          ? config.model.split("/")[1]
          : config.model,
      )
    : undefined;

  if (!model) {
    const available = await registry.getAvailable();
    model = available[0];
  }

  if (!model) {
    throw new Error(
      "No model available. Set an API key or configure a provider in ~/.pi/agent/models.json",
    );
  }

  const thinkingLevel = (config.thinkingLevel as any) ?? "off";

  // Resolve tools
  const { builtin, custom } = resolveTools(toolNames, config.cwd);

  // Build system prompt
  const systemPrompt = buildSystemPrompt(maxAgents, toolNames);

  const loader = new DefaultResourceLoader({
    cwd: config.cwd,
    agentDir: getAgentDir(),
    systemPromptOverride: () => systemPrompt,
  });
  await loader.reload();

  const { session } = await createAgentSession({
    cwd: config.cwd,
    sessionManager: SessionManager.inMemory(),
    authStorage: getAuth(),
    modelRegistry: registry,
    model,
    thinkingLevel,
    tools: builtin,
    customTools: custom,
    resourceLoader: loader,
  });

  // Log tool calls via session events
  const node = treeState.nodes.get(nodeId);
  const toolSub = session.subscribe((event: any) => {
    if (event.type === "tool_execution_start" && node) {
      node.toolCalls.push({
        name: event.toolName,
        success: false,
        timestamp: Date.now(),
      });
    }
    if (event.type === "tool_execution_end" && node) {
      for (let i = node.toolCalls.length - 1; i >= 0; i--) {
        const tc = node.toolCalls[i];
        if (tc.name === event.toolName && !tc.success && !tc.error) {
          tc.success = !event.isError;
          if (event.isError) {
            tc.error =
              event.result?.content?.[0]?.text?.slice(0, 60) || "tool error";
          }
          break;
        }
      }
    }
  });

  const budget = { value: maxAgents };
  let currentPrompt = prompt;

  try {
    for (let turn = 0; turn < 5; turn++) {
      if (signal.aborted) throw new Error("Aborted");

      let response = "";

      const onEvent = (event: any) => {
        if (
          event.type === "message_update" &&
          event.assistantMessageEvent.type === "text_delta"
        ) {
          response += event.assistantMessageEvent.delta;
        }
      };

      const unsub = session.subscribe(onEvent);
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
            cappedTasks,
            childBudget,
            toolNames, // parent tools are the valid set for children
            treeState,
            nodeId,
            config,
            signal,
            budget,
          );

          currentPrompt = formatResultsForSynthesis(results);
          continue;
        }
      }

      session.dispose();
      return response;
    }

    session.dispose();
    return "(Max delegation turns exceeded)";
  } catch (err: any) {
    session.dispose();
    throw err;
  }
}
