import { addNode, createTreeState, type RunConfig } from "./types.js";
import { runAgent } from "./agent.js";
import { liveRender, finalRender } from "./tree.js";

function parseArgs(): { maxAgents: number; model?: string; thinking?: string; prompt: string } {
  const args = process.argv.slice(2);

  let maxAgents = 1;
  let model: string | undefined;
  let thinking: string | undefined;
  const remaining: string[] = [];

  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    if (arg === "-a" || arg === "--agents") {
      const val = args[++i];
      if (!val) {
        console.error("Error: -a/--agents requires a value");
        process.exit(1);
      }
      maxAgents = parseInt(val, 10);
      if (isNaN(maxAgents) || maxAgents < 1) {
        console.error("Error: --agents must be a positive integer");
        process.exit(1);
      }
    } else if (arg === "--model") {
      const val = args[++i];
      if (!val) {
        console.error("Error: --model requires a value");
        process.exit(1);
      }
      model = val;
    } else if (arg === "--thinking") {
      const val = args[++i];
      if (!val) {
        console.error("Error: --thinking requires a value");
        process.exit(1);
      }
      thinking = val;
    } else if (arg === "-h" || arg === "--help") {
      console.log(`roots — recursive agent delegation

Usage: roots [options] "prompt"

Options:
  -a, --agents <n>       Max subagents per agent (default: 1, no delegation)
  --model <model>        Model to use (e.g., "anthropic/claude-sonnet-4-20250514")
  --thinking <level>     Thinking level: off, minimal, low, medium, high, xhigh
  -h, --help             Show this help

Example:
  roots -a 3 "Write a comprehensive report on quantum computing"
  roots -a 2 --model openai/gpt-4o "Compare functional vs OOP paradigms"
  roots "What is the capital of France?"               # no delegation`);
      process.exit(0);
    } else {
      remaining.push(arg);
    }
    i++;
  }

  const prompt = remaining.join(" ");
  if (!prompt.trim()) {
    console.error("Error: A prompt is required.");
    console.error('Usage: roots [-a N] [--model model] "prompt"');
    process.exit(1);
  }

  return { maxAgents, model, thinking, prompt };
}

export async function main() {
  const { maxAgents, model, thinking, prompt: userPrompt } = parseArgs();

  const config: RunConfig = {
    model,
    thinkingLevel: thinking,
    cwd: process.cwd(),
  };

  const treeState = createTreeState();
  const rootNode = addNode(treeState, null, "root", userPrompt, maxAgents);

  // Start live tree rendering
  const renderInterval = setInterval(() => {
    liveRender(treeState);
  }, 250);

  // Run the agent tree
  const signal = new AbortController().signal;
  rootNode.status = "running";
  rootNode.startTime = Date.now();

  let finalOutput = "";

  try {
    finalOutput = await runAgent(
      userPrompt,
      maxAgents,
      treeState,
      rootNode.id,
      config,
      signal,
    );

    rootNode.status = "success";
    rootNode.output = finalOutput;
    rootNode.endTime = Date.now();
  } catch (err: any) {
    rootNode.status = "error";
    rootNode.error = err?.message || String(err);
    rootNode.endTime = Date.now();
  }

  // Stop live rendering
  clearInterval(renderInterval);

  // Print final tree and output
  finalRender(treeState);

  const elapsed = rootNode.endTime
    ? ((rootNode.endTime - rootNode.startTime) / 1000).toFixed(1)
    : "?";

  if (rootNode.status === "success") {
    console.log(`\x1b[1mAnswer\x1b[0m \x1b[2m(${elapsed}s)\x1b[0m:`);
    console.log("─".repeat(60));
    console.log(finalOutput);
    console.log("─".repeat(60));
  } else {
    console.log(`\x1b[1;31mError\x1b[0m \x1b[2m(${elapsed}s)\x1b[0m: ${rootNode.error}`);
    process.exit(1);
  }

  // Count stats
  let totalNodes = treeState.nodes.size;
  let leafNodes = 0;
  for (const node of treeState.nodes.values()) {
    if (node.children.length === 0 && node.id !== treeState.rootId) {
      leafNodes++;
    }
  }

  console.log(
    `\x1b[2m${totalNodes} agents total, ${leafNodes} leaf agents, max depth: ${maxAgents}\x1b[0m`,
  );
}

main().catch((err) => {
  console.error("\x1b[31mFatal:\x1b[0m", err);
  process.exit(1);
});
