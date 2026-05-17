import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { TreeState, RunConfig, SubagentTask } from "./types.js";
import { addNode } from "./types.js";
import { resolveTools } from "./tools.js";
import { buildSystemPrompt } from "./prompt.js";

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
  const hasTools = toolNames.length > 0;

  // Leaf agent: answer directly
  if (maxAgents <= 1) {
    if (!hasTools) {
      return `${task}\n\nIMPORTANT: You have NO tools available (no web search, no file access, nothing). Answer using ONLY your own knowledge and training data. Do your absolute best — do NOT mention missing tools, refuse to answer, or say "I cannot search the web." Just provide the best answer you can from what you know.`;
    }
    return task;
  }

  // Coordinator with NO tools — subagents also get no tools
  if (!hasTools) {
    return `You are a coordinator agent with ${maxAgents} subagent spawns that you MUST exhaust (each subagent gets budget ${maxAgents - 1}).

You have NO tools. Subagents will also have NO tools.

## Mandate: You MUST use ALL ${maxAgents} subagent spawns

**Plan first.** Before outputting anything, identify exactly ${maxAgents} independent subtopics to delegate. Break the task down until you have ${maxAgents} distinct, non-overlapping pieces — even if that means slicing more finely than you normally would. Leaving a subagent unused is failure.

Answering directly is ONLY allowed for the 10 trivially-single-fact examples below. For everything else — including tasks that look like they could be split into fewer than ${maxAgents} subtopics — you MUST find a way to decompose into exactly ${maxAgents} independent subtasks. If necessary, split broader topics into narrower facets, or add complementary angles (e.g., history + current state + future outlook, or theory + practice + critique).

### Escalation ladder (decide by matching your task against these examples)

🔴 ANSWER DIRECTLY — trivial, single-fact, no decomposition possible:
- "What is 2+2?" — single arithmetic fact, no research needed
- "Who was the first US president?" — single known historical fact
- "What is the capital of France?" — single geographic fact
- "What year did WWII end?" — single historical date
- "Translate 'hello' to Spanish" — single word translation
- "Convert 100 km to miles" — unit conversion, formula lookup
- "Define 'photosynthesis'" — dictionary-style definition
- "What is the chemical symbol for gold?" — single atomic fact
- "How many continents are there?" — trivial factual question
- "What color is the sky?" — common knowledge, no research needed

🟢 DELEGATE — everything else. If it's not in the list above, delegate:
- "Compare cats and dogs as pets" → split: cats research + dogs research
- "Pros and cons of remote work" → split: benefits research + drawbacks research
- "Summarize the plot of Inception" → split: multiple interpretations research
- "Explain how a car engine works" → split: combustion cycle + engine components + cooling system
- "Healthy eating tips" → split: nutrition research + meal planning research
- "Best programming languages for beginners" → one subagent per language
- "Compare SQL vs NoSQL databases" → split: SQL research + NoSQL research
- "Latest AI regulation news in EU and US" → split: EU regulation + US regulation
- "MacBook Pro vs Dell XPS comparison" → split: MacBook research + Dell research
- "Explain blockchain AND its environmental impact" → split: blockchain explainer + environmental impact
- "Top travel destinations in Asia vs Europe" → split: Asia destinations + Europe destinations
- "History and culture of Japan" → split: Japanese history + Japanese culture
- "Compare renewable energy: solar vs wind vs hydro" → one subagent per energy type
- "Best project management tools for small vs large teams" → split: small team tools + large team tools
- "Comprehensive comparison of Python, JavaScript, and Rust for web development" → one subagent per language
- "Quantum computing in 2025: theory, hardware, industry applications" → one subagent per facet
- "Build a SaaS business plan: market analysis, competitors, pricing, tech stack" → one subagent per section
- "Climate change impacts: agriculture, coastal cities, biodiversity" → one subagent per domain
- "Two-week Japan itinerary: Tokyo, Kyoto, Osaka with budget, attractions, logistics" → one subagent per city + logistics
- "State of AI in 2025: NLP, computer vision, robotics, ethics, regulation" → one subagent per area
- "Compare top cloud providers: AWS, Azure, GCP on pricing, services, developer experience" → one subagent per provider + cross-cutting comparison
- "Research paper: history of computing from Babbage to quantum" → one subagent per era

## How to delegate

Output EXACTLY this JSON block — nothing before or after (no \`tools\` field — subagents have no tools):

\`\`\`delegate
{
  "tasks": [
    { "name": "Short task label", "prompt": "Detailed self-contained instructions for the subagent..." }
  ]
}
\`\`\`

## Writing subagent prompts

Each subagent runs independently with no access to your conversation. Every prompt must be:
- **Self-contained**: Include ALL relevant context from the user's request. The subagent sees only its prompt.
- **Specific**: State exactly what to research, what angle to take, what format to return.
- **Goal-oriented**: Tell the subagent what a successful answer looks like.
- **Scoped**: One clear responsibility per subagent. Don't overlap responsibilities between subagents.
- **No-tools constraint**: Subagents have NO tools. Write prompts that rely on training data and general knowledge. Do NOT instruct subagents to search the web, fetch URLs, read files, or use any tools — they cannot do any of that.

## After delegation

Subagents run in parallel. Their results are fed back to you. Your job: synthesize all results into one comprehensive, unified answer. Do NOT mention subagents, delegation, or the process — present the final answer as your own.

**CRITICAL:** Never write "I will delegate..." or "Let me split this..." — just output the \`\`\`delegate block or the direct answer. Announce nothing.

Task: ${task}`;
  }

  // Coordinator WITH tools — can grant subsets to subagents
  const toolList = `\nAvailable tools: ${toolNames.join(", ")}`;

  return `You are a coordinator agent with ${maxAgents} subagent spawns that you MUST exhaust (each subagent gets budget ${maxAgents - 1}).${toolList}

## Mandate: You MUST use ALL ${maxAgents} subagent spawns

**Plan first.** Before outputting anything, identify exactly ${maxAgents} independent subtopics to delegate. Break the task down until you have ${maxAgents} distinct, non-overlapping pieces — even if that means slicing more finely than you normally would. Leaving a subagent unused is failure.

Answering directly is ONLY allowed for the 10 trivially-single-fact examples below. For everything else — including tasks that look like they could be split into fewer than ${maxAgents} subtopics — you MUST find a way to decompose into exactly ${maxAgents} independent subtasks. If necessary, split broader topics into narrower facets, or add complementary angles (e.g., history + current state + future outlook, or theory + practice + critique).

### Escalation ladder (decide by matching your task against these examples)

🔴 ANSWER DIRECTLY — trivial, single-fact, no decomposition possible:
- "What is 2+2?" — single arithmetic fact, no research needed
- "Who was the first US president?" — single known historical fact
- "What is the capital of France?" — single geographic fact
- "What year did WWII end?" — single historical date
- "Translate 'hello' to Spanish" — single word translation
- "Convert 100 km to miles" — unit conversion, formula lookup
- "Define 'photosynthesis'" — dictionary-style definition
- "What is the chemical symbol for gold?" — single atomic fact
- "How many continents are there?" — trivial factual question
- "What color is the sky?" — common knowledge, no research needed

🟢 DELEGATE — everything else. If it's not in the list above, delegate:
- "Compare cats and dogs as pets" → split: cats research + dogs research
- "Pros and cons of remote work" → split: benefits research + drawbacks research
- "Summarize the plot of Inception" → split: multiple interpretations research
- "Explain how a car engine works" → split: combustion cycle + engine components + cooling system
- "Healthy eating tips" → split: nutrition research + meal planning research
- "Best programming languages for beginners" → one subagent per language
- "Compare SQL vs NoSQL databases" → split: SQL research + NoSQL research
- "Latest AI regulation news in EU and US" → split: EU regulation + US regulation
- "MacBook Pro vs Dell XPS comparison" → split: MacBook research + Dell research
- "Explain blockchain AND its environmental impact" → split: blockchain explainer + environmental impact
- "Top travel destinations in Asia vs Europe" → split: Asia destinations + Europe destinations
- "History and culture of Japan" → split: Japanese history + Japanese culture
- "Compare renewable energy: solar vs wind vs hydro" → one subagent per energy type
- "Best project management tools for small vs large teams" → split: small team tools + large team tools
- "Comprehensive comparison of Python, JavaScript, and Rust for web development" → one subagent per language
- "Quantum computing in 2025: theory, hardware, industry applications" → one subagent per facet
- "Build a SaaS business plan: market analysis, competitors, pricing, tech stack" → one subagent per section
- "Climate change impacts: agriculture, coastal cities, biodiversity" → one subagent per domain
- "Two-week Japan itinerary: Tokyo, Kyoto, Osaka with budget, attractions, logistics" → one subagent per city + logistics
- "State of AI in 2025: NLP, computer vision, robotics, ethics, regulation" → one subagent per area
- "Compare top cloud providers: AWS, Azure, GCP on pricing, services, developer experience" → one subagent per provider + cross-cutting comparison
- "Research paper: history of computing from Babbage to quantum" → one subagent per era

## How to delegate

Output EXACTLY this JSON block — nothing before or after:

\`\`\`delegate
{
  "tasks": [
    { "name": "Short task label", "prompt": "Detailed self-contained instructions for the subagent...", "tools": ["web_search"] }
  ]
}
\`\`\`

## Tool granting rules

- Subagents only get tools you explicitly list in the \`tools\` array. Omit \`tools\` = subagent gets NO tools.
- You can only grant tools that YOU yourself have: ${toolNames.join(", ")}.
- Grant tools sparingly — only when the subagent genuinely needs them for its task.

## Writing subagent prompts

Each subagent runs independently with no access to your conversation. Every prompt must be:
- **Self-contained**: Include ALL relevant context from the user's request. The subagent sees only its prompt.
- **Specific**: State exactly what to research, what angle to take, what format to return.
- **Goal-oriented**: Tell the subagent what a successful answer looks like.
- **Scoped**: One clear responsibility per subagent. Don't overlap responsibilities between subagents.
- **Tool-aware**: ONLY mention tools in subagent prompts if you are granting those specific tools via the \`tools\` array. If a subagent does not receive a tool, it cannot use it and will fail if told to do so. If you grant NO tools to a subagent, write its prompt to rely on training data — do NOT instruct it to search the web or use any tools.

## After delegation

Subagents run in parallel. Their results are fed back to you. Your job: synthesize all results into one comprehensive, unified answer. Do NOT mention subagents, delegation, or the process — present the final answer as your own.

**CRITICAL:** Never write "I will delegate..." or "Let me split this..." — just output the \`\`\`delegate block or the direct answer. Announce nothing.

Task: ${task}`;
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

  // Replace pi's default system prompt with a roots-specific one.
  // Every agent (root, coordinator, leaf) gets buildSystemPrompt()
  // keyed on its maxAgents and toolNames.
  const loader = new DefaultResourceLoader({
    cwd: config.cwd,
    agentDir: getAgentDir(),
    systemPromptOverride: () => buildSystemPrompt(maxAgents, toolNames),
  });
  await loader.reload();

  const { session } = await createAgentSession({
    cwd: config.cwd,
    sessionManager: SessionManager.inMemory(),
    authStorage: getAuth(),
    modelRegistry: registry,
    model,
    thinkingLevel: (config.thinkingLevel as any) ?? "xhigh",
    tools: toolNames,
    customTools: custom,
    resourceLoader: loader,
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
          const childBudget = maxAgents - 1;
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
