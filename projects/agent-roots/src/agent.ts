import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import type { TreeState, RunConfig, SubagentTask, ToolCallRecord } from "./types.js";
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
      if (Array.isArray(parsed.prompts)) {
        const tasks = parsed.prompts
          .filter((p: any) => typeof p === "string")
          .map((p: string) => ({ name: p.slice(0, 40), prompt: p }));
        if (tasks.length > 0) return { tasks };
      }
    } catch { /* fall through */ }
  }

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

// Extract individual tool calls from DeepSeek text output.
// Handles two formats:
//   1. <function-call>{"name":"...","arguments":{...}}</function-call>
//   2. <toolname><param>value</param></toolname>  (XML-style, specific to known tools)
function extractToolCalls(
  text: string,
  knownTools: Set<string>,
): Array<{ name: string; args: Record<string, any> }> {
  const calls: Array<{ name: string; args: Record<string, any> }> = [];

  // Format 1: <function-call> JSON blocks
  const fcRe = /<function-call>\s*(\{[\s\S]*?\})\s*<\/function-call>/gi;
  let match;
  while ((match = fcRe.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed.name && parsed.arguments) {
        calls.push({ name: parsed.name, args: parsed.arguments });
      }
    } catch { /* skip */ }
  }

  // Format 2: <toolname><param>value</param></toolname>  XML-style
  // Also handles: <toolname attr="value" />  HTML-attribute style
  // Only match tool names we know about
  if (knownTools.size > 0) {
    const toolPattern = [...knownTools].join("|");

    // XML child-element style: <read><path>file.txt</path></read>
    const xmlRe = new RegExp(
      `<(${toolPattern})\\b[^>]*>([\\s\\S]*?)<\\/\\1>`,
      "gi",
    );
    while ((match = xmlRe.exec(text)) !== null) {
      const toolName = match[1];
      const inner = match[2].trim();
      if (calls.some((c) => c.name === toolName)) continue;

      const args: Record<string, any> = {};
      // Try child-element params
      const paramRe = /<(\w+)>([\s\S]*?)<\/\1>/gi;
      let pm;
      while ((pm = paramRe.exec(inner)) !== null) {
        args[pm[1]] = pm[2].trim();
      }
      // Also try attribute-style params: attr="value"
      if (Object.keys(args).length === 0) {
        const attrRe = /(\w+)="([^"]*)"/gi;
        let am;
        while ((am = attrRe.exec(inner)) !== null) {
          args[am[1]] = am[2];
        }
      }
      calls.push({ name: toolName, args });
    }
  }

  return calls;
}

type ToolInstance = { execute: (...args: any[]) => Promise<any> };

// Common parameter name aliases for built-in tools (models sometimes guess wrong)
const PARAM_ALIASES: Record<string, Record<string, string>> = {
  read: { file: "path", file_path: "path" },
  write: { file: "path", file_path: "path" },
  edit: { file: "path", file_path: "path" },
  bash: { cmd: "command", run: "command" },
  grep: { regex: "pattern", query: "pattern" },
  find: { glob: "pattern", query: "pattern" },
  ls: { dir: "path", directory: "path" },
};

function normalizeArgs(name: string, args: Record<string, any>): Record<string, any> {
  const aliases = PARAM_ALIASES[name];
  if (!aliases) return args;
  const normalized = { ...args };
  for (const [alias, canonical] of Object.entries(aliases)) {
    if (alias in normalized && !(canonical in normalized)) {
      normalized[canonical] = normalized[alias];
    }
  }
  return normalized;
}

async function executeToolByName(
  name: string,
  args: Record<string, any>,
  toolMap: Map<string, ToolInstance>,
): Promise<{ content: string; isError: boolean }> {
  const tool = toolMap.get(name);
  if (!tool) {
    return { content: `Tool "${name}" not found. Available: ${[...toolMap.keys()].join(", ")}`, isError: true };
  }
  try {
    const result = await tool.execute(`call_${Date.now()}`, args, undefined as any, undefined as any, {} as any);
    const text = result?.content?.map((c: any) => c.text).join("\n") || JSON.stringify(result);
    return { content: text, isError: result?.isError || false };
  } catch (err: any) {
    return { content: err?.message || String(err), isError: true };
  }
}

function formatToolResults(
  results: Array<{ name: string; args: Record<string, any>; content: string; isError: boolean }>,
): string {
  let text = "Tool results:\n\n";
  for (const r of results) {
    const icon = r.isError ? "✗" : "✓";
    text += `[${icon}] ${r.name}(${JSON.stringify(r.args)}):\n${r.content}\n\n`;
  }
  text += "Continue based on these results.";
  return text;
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

  // Track tool calls for the tree display
  const node = treeState.nodes.get(nodeId);
  session.subscribe((event: any) => {
    if (event.type === "tool_execution_start" && node) {
      const existing = node.toolCalls.find(
        (tc) => tc.name === event.toolName && !tc.success && !tc.error,
      );
      if (!existing) {
        node.toolCalls.push({
          name: event.toolName,
          success: false, // will be updated on end
          timestamp: Date.now(),
        });
      }
    }
    if (event.type === "tool_execution_end" && node) {
      // Update the last matching pending call
      for (let i = node.toolCalls.length - 1; i >= 0; i--) {
        const tc = node.toolCalls[i];
        if (tc.name === event.toolName && !tc.success && !tc.error) {
          tc.success = !event.isError;
          if (event.isError) {
            tc.error =
              event.result?.content?.[0]?.text?.slice(0, 60) ||
              "tool error";
          }
          break;
        }
      }
    }
  });

  const budget = { value: maxAgents };
  let currentPrompt = prompt;

  // Build tool lookup map for text-based tool execution
  const toolMap = new Map<string, ToolInstance>();
  for (const t of builtin) toolMap.set(t.name, t as any);
  for (const t of custom) toolMap.set(t.name, t as any);

  try {
    for (let turn = 0; turn < 10; turn++) {
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

      // 1. Check for delegation plan (if budget allows)
      if (maxAgents > 1 && budget.value > 0) {
        const plan = extractDelegationPlan(response);

        if (plan && plan.tasks.length > 0) {
          const cappedTasks = plan.tasks.slice(0, budget.value);
          const childBudget = budget.value - 1;

          const results = await executeSubagents(
            cappedTasks,
            childBudget,
            toolNames,
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

      // 2. Check for tool calls (text-based, for DeepSeek compat)
      const toolCalls = extractToolCalls(response, new Set(toolNames));
      if (toolCalls.length > 0) {
        const results = await Promise.all(
          toolCalls.map(async (tc) => {
            const { content, isError } = await executeToolByName(
              tc.name,
              normalizeArgs(tc.name, tc.args),
              toolMap,
            );
            // Track in node for tree display
            if (node) {
              node.toolCalls.push({
                name: tc.name,
                success: !isError,
                error: isError ? content.slice(0, 60) : undefined,
                timestamp: Date.now(),
              });
            }
            return { name: tc.name, args: tc.args, content, isError };
          }),
        );

        currentPrompt = formatToolResults(results);
        continue;
      }

      // 3. No delegation or tool calls — final response
      session.dispose();
      return response;
    }

    session.dispose();
    return "(Max turns exceeded)";
  } catch (err: any) {
    session.dispose();
    throw err;
  }
}
