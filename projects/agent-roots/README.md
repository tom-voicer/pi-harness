# agent-roots (`roots`)

Recursive agent delegation CLI — bounded tree of AI agents collaborating on complex tasks, built on `pi`.

```
roots -a 3 "Write a comprehensive comparison of SQL and NoSQL databases"
```

> **For coding agents**: this README is your context document. It explains _why_ things are the way they are — design decisions, gotchas, and lessons learned. Read it before making changes.

---

## Product Overview

### What it does

`roots` takes a user prompt and a `maxAgents` budget (via `-a`). It creates a tree of AI agents where:

- The **root agent** receives the user's prompt and budget _n_
- It can spawn up to _n_ subagents, each receiving budget _n−1_
- Subagents can spawn further subagents until budget reaches 1
- When budget = 1, the agent is a **leaf** — it answers directly
- Results **bubble up**: each agent waits for its subagents, then synthesizes their outputs

### The termination guarantee

The budget strictly decreases at each level. A tree of depth _d_ with branching factor _b_ has at most:

```
1 + b + b(b−1) + b(b−1)(b−2) + ... (until budget = 1)
```

This is bounded because `maxAgents` is finite and monotonically decreasing. There's no risk of infinite recursion.

### Why this exists

Complex research tasks benefit from parallel exploration of independent subtopics. A single agent can only think linearly. `roots` lets an agent _structure_ its work: identify independent facets, delegate each to a focused subagent, and synthesize the results. It's like MapReduce for LLM reasoning.

---

## Core Concepts

### Delegation budget (`maxAgents`)

Every agent in the tree has a budget. The budget controls two things:
1. **How many subagents** this agent can spawn
2. **What budget** those subagents receive (parent's budget − 1)

The budget is the **maximum number of successful subagent spawns**. Currently, both successful and failed spawns consume budget (see [Current Limitations](#multilevel-deep-trees)).

### Leaf agents (budget = 1)

Leaf agents receive a simplified system prompt. They have no delegation capability — they just answer the prompt directly. This is enforced structurally: the delegation extraction code only runs when `maxAgents > 1`.

### Coordinator agents (budget > 1)

Coordinator agents receive a system prompt that explains:
- Their delegation budget
- The ` ```delegate ``` ` JSON format for spawning subagents
- Guidelines for when to delegate vs. answer directly
- How to synthesize subagent results

### The tree

Agents are organized as an n-ary tree:
- Each node has an `AgentNode` (id, name, prompt, maxAgents, status, output, children)
- The tree is stored in a `Map<string, AgentNode>` keyed by UUID
- Status transitions: `pending` → `running` → `success` | `error`

---

## Architecture

### Directory structure

```
agent-roots/
├── bin/roots              # Shell entry point (symlinked by npm link)
├── src/
│   ├── cli.ts             # Argument parsing, main(), tree rendering timer
│   ├── agent.ts           # runAgent(), extractDelegationPlan(), executeSubagents()
│   ├── prompt.ts          # buildSystemPrompt(): leaf vs coordinator
│   ├── tree.ts            # renderTreeText(), liveRender(), finalRender()
│   └── types.ts           # AgentNode, TreeState, SubagentTask, RunConfig
├── package.json
├── tsconfig.json
└── README.md
```

### Flow

```
CLI (cli.ts)
  │
  ├─ parseArgs() → { maxAgents, model, prompt }
  ├─ addNode(tree, null, "root", prompt, maxAgents)
  │
  ├─ Start live render timer (250ms interval)
  │
  └─ runAgent(prompt, maxAgents, tree, rootNode.id, config, signal)
       │
       ├─ 1. Auto-detect model (ModelRegistry.getAvailable())
       ├─ 2. Build system prompt (leaf vs coordinator)
       ├─ 3. Create SDK session (in-memory, no built-in tools)
       │
       └─ 4. Multi-turn loop (max 5 turns):
            ├─ session.prompt(currentPrompt) → collect response
            ├─ extractDelegationPlan(response)
            │    ├─ Found? → executeSubagents() in parallel
            │    │            └─ runAgent() recursively for each
            │    └─ Not found? → return response (final answer)
            └─ Feed subagent results back as next prompt
```

### Why text-based delegation (not custom SDK tools)

**Original plan**: Register a `spawn_subagent` custom tool via pi's SDK. The LLM would call it natively.

**What went wrong**: DeepSeek models (the only available models) output tool calls as text (`<function-call>{"name": "spawn_subagent", ...}</function-call>`) rather than native tool_call blocks that pi's SDK can parse. This is a provider compatibility issue — pi's tool-calling pipeline expects Anthropic/OpenAI-format tool calls.

**Solution**: Agents output a ` ```delegate ``` ` JSON code fence block instead. The orchestrator parses this text, spawns subagents, and feeds results back as the next prompt. This works with any model.

**Trade-off**: The agent can't call the tool mid-response — it must output the delegate block and stop. Synthesis happens in a follow-up turn. This is slightly less natural but functionally equivalent.

### Multi-turn loop

Each agent runs in a single SDK session with up to 5 turns:

1. **Turn 1**: Agent receives the prompt, outputs a delegate block (or answers directly)
2. **Orchestrator**: Parses the block, spawns subagents, collects results
3. **Turn 2**: Agent receives subagent results, synthesizes final answer

The loop supports agents that want to delegate in multiple rounds (though in practice, most agents delegate once and synthesize).

### Session lifecycle

- Each agent gets a **fresh, in-memory SDK session** (`SessionManager.inMemory()`)
- No session persistence — agents don't write to disk
- `tools: []` and `customTools: []` — agents are text-only, no read/write/bash
- System prompt set via `DefaultResourceLoader.systemPromptOverride()`
- `session.dispose()` called in `finally` block to prevent leaks

### Model auto-detection

```typescript
const available = await registry.getAvailable();
model = available[0];
```

Gets the first available model from `~/.pi/agent/models.json` (respecting API keys). No hardcoded default — falls back to whatever the user has configured.

### Tree rendering

The live tree renders every 250ms using ANSI escape codes:

1. **Calculate tree text**: Walk the node tree recursively, building box-drawing lines
2. **Check for changes**: Skip re-render if tree text hasn't changed (avoids flicker)
3. **Clear previous**: Move cursor up N lines (`\x1b[{N}A`) and clear to end (`\x1b[J`)
4. **Render new**: Print the tree

The renderer skips rendering entirely when there are no subagent nodes (doesn't show empty tree).

Key rendering details:
- Node names are shown (set by delegator), falling back to truncated prompt
- Running nodes show elapsed time with millisecond precision
- Completed nodes show final duration and output preview (first 56 chars)
- Status line at bottom shows aggregate counts with ANSI colors
- Only renders when `hasSubagents()` returns true (no flickering during leaf-agent runs)

---

## Design Decisions & Rationale

### 1. In-memory sessions (not persistent)

Subagent sessions are ephemeral — they live only during the tree execution. Benefits:
- No disk clutter from hundreds of temporary sessions
- No session cleanup needed
- Simpler lifecycle management

### 2. No built-in tools

Agents have `tools: []` and `customTools: []`. They're pure reasoning/deliberation agents. This was a deliberate choice:
- Keeps agents focused on their task
- Prevents agents from modifying the filesystem
- Reduces token usage (no tool descriptions in system prompt)
- Faster responses (no tool-calling turns)

### 3. Parallel subagent execution

All subagents at the same level run in parallel via `Promise.all()`. No concurrency limit (unlike pi's built-in subagent extension which caps at 4). This is safe because:
- Each subagent is an independent SDK session
- No shared mutable state between subagents
- Total concurrency is bounded by the budget (typically ≤ 8)

### 4. Budget consumed by all spawns

Currently, both successful AND failed subagent spawns consume budget. The original spec said "only successful spawns count," but this creates a race condition: if we decrement only on success, all parallel subagents check the budget simultaneously and all pass, potentially exceeding the limit.

Fixing this requires either:
- Sequential budget checking (slower)
- Preallocating budget slots (current approach)

### 5. Shell script entry point (not pure Node.js)

The `bin/roots` entry is a shell script that resolves symlinks and calls `tsx`. Why not `#!/usr/bin/env node`?
- `npm link` creates a symlink chain: `/opt/homebrew/bin/roots` → `node_modules/agent-roots/bin/roots` → actual file
- We need `tsx` to transpile TypeScript
- A pure Node.js shebang can't load `.ts` files
- The shell script follows symlinks to find the project root, then invokes `tsx`

---

## Gotchas & Lessons Learned

### DeepSeek tool-calling incompatibility

**Problem**: DeepSeek V4 models output tool calls as XML-ish text blocks rather than native tool_call deltas. pi's SDK doesn't parse these.

**Symptom**: Agent outputs `<function-call>{"name":"spawn_subagent",...}</function-call>` as text, but pi reports no tool call was made.

**Solution**: Abandoned custom SDK tools. Switched to text-based delegation with regex extraction. See `extractDelegationPlan()` for the parsing logic, which handles multiple formats (```delegate fence, `<function-call>` blocks, bare JSON arrays).

### Session subscription leak

**Problem**: `session.subscribe(handler)` adds a new subscription each turn without removing the old one. After N turns, N handlers fire on each event.

**Symptom**: Duplicate or stale response text accumulation.

**Fix**: Capture the unsubscribe function:
```typescript
const unsub = session.subscribe(onEvent);
await session.prompt(currentPrompt);
unsub();
```

### npm link shebang doubling

**Problem**: When `bin/roots` used `#!/usr/bin/env -S npx tsx`, the npm link wrapper AND the shebang both tried to execute, causing double output.

**Symptom**: Two identical answers printed.

**Fix**: Switched to a shell script that resolves the real project path and invokes `tsx` directly, avoiding the double-execution.

### typebox version

pi bundles `typebox@1.1.38`. The package.json must use `^1.1.0`, not `^2.0.0` (which doesn't exist).

### DefaultResourceLoader needs agentDir

Without `agentDir`, `DefaultResourceLoader` throws `"path" argument must be of type string`. Always pass `getAgentDir()` from `@earendil-works/pi-coding-agent`.

---

## Current State

### Working
- `-a 1`: Direct answers (no delegation), ~1-3 seconds
- `-a 2`: Two subagents in parallel + synthesis, ~30-70 seconds
- `-a 3`: Three subagents in parallel + synthesis, ~40-60 seconds
- Live tree rendering with status, elapsed time, output preview
- Model auto-detection from user's pi config
- Clean error propagation (failed subagents report to parent)
- Abort handling via AbortSignal

### Current model
Tested exclusively with `deepseek/deepseek-v4-flash` (configured in `~/.pi/agent/models.json`). Should work with any model pi supports.

### Limitations
- **No mid-response tool calls**: Agents use text-based delegation instead of native tool calling (see Architecture section for why)
- **Single-turn delegation**: Most agents delegate once and synthesize. Deep delegation chains (agent → subagent → sub-subagent) are theoretically supported but rarely triggered because initial prompts don't demand it
- **Budget consumed on failure**: Failed subagents still consume budget (prevents race conditions with parallel spawns)
- **Max 5 turns**: Hardcoded safety limit per agent to prevent infinite loops
- **No streaming output**: Users see only the tree until the final answer appears (the synthesis response is not streamed)
- **Tree output preview truncated**: Only first 56 chars of subagent output shown in tree

---

## Development

### Running locally

```bash
cd ~/.pi/agent/projects/agent-roots
npx tsx src/cli.ts -a 2 "prompt"
```

### Running the linked binary

```bash
roots -a 2 "prompt"
```

### Testing without spending tokens

```bash
# Single agent, simple prompt
roots -a 1 "What is 2+2?"

# Quick delegation test
roots -a 2 "Compare A and B. Delegate each to a subagent with a short name."
```

### Key files to edit

| File | When you want to... |
|------|---------------------|
| `src/prompt.ts` | Change agent behavior, delegation instructions |
| `src/agent.ts` | Change delegation parsing, budget logic, session config |
| `src/tree.ts` | Change tree rendering, status display |
| `src/types.ts` | Change data model (add fields to AgentNode, etc.) |
| `src/cli.ts` | Change CLI flags, main loop |
| `bin/roots` | Change how the binary is invoked |

### Dependencies

- `@earendil-works/pi-coding-agent` — pi's SDK (`createAgentSession`, `DefaultResourceLoader`, etc.)
- `typebox` — Schema definitions (transitive dep of pi, also listed directly)
- `tsx` — TypeScript execution (dev dependency)

### .gitignore

Only `node_modules/` is ignored. All source files are tracked.

---

## Future Ideas

- **Native tool calling**: If pi adds proper DeepSeek tool-calling support (or the user gets an Anthropic key), switch back to custom SDK tools for more natural delegation
- **Smarter budget**: Only decrement budget on successful spawns (requires sequential budget checking or atomic counter)
- **Streaming synthesis**: Stream the final synthesis response as it's generated
- **Persistent sessions**: Option to save agent sessions for debugging/inspection
- **Configurable concurrency**: Allow limiting parallel subagent count
- **Agent-specific models**: Let coordinators use a different (cheaper/faster) model than leaf agents
- **Sub-subagent depth**: Create prompts that naturally trigger deeper delegation chains
- **Tree export**: Export the tree structure as JSON for visualization/analysis

## License

MIT
