# agent-roots (roots)

A CLI tool for **bounded recursive agent delegation** built on `pi`.

```
roots -a 3 "Write a comprehensive comparison of SQL and NoSQL databases"
```

The root agent receives a `maxAgents` budget. It can spawn up to that many subagents, each receiving `maxAgents - 1`. Subagents can spawn further subagents until budget reaches 1 (leaf). The tree is **guaranteed to terminate** because the budget strictly decreases.

## Architecture

```
User prompt, maxAgents=3
    │
    ▼
Root agent (budget 3)
    │  Plans delegation, outputs ```delegate``` block
    │
    ├──► Subagent 1 (budget 2) ──► Leaf (budget 1)
    ├──► Subagent 2 (budget 2) ──► Leaf (budget 1)
    └──► Subagent 3 (budget 2) ──► answers directly
    │
    │  Waits for all to finish
    ▼
Synthesis ──► Final answer to user
```

## Rules

1. Each agent receives `maxAgents`
2. If `maxAgents > 1`, the agent may spawn up to `maxAgents` subagents
3. Each subagent receives `maxAgents - 1`
4. Budget only decrements on **successful** spawns
5. Agents wait for subagents before synthesizing their response

## Installation

```bash
cd agent-roots
npm install
npm link   # makes 'roots' available globally
```

Requires a configured LLM provider (see pi's auth setup).

## Usage

```bash
# No delegation — agent answers directly
roots "What is a monad?"

# Allow up to 2 subagents
roots -a 2 "Compare REST vs GraphQL vs gRPC"

# Deeper tree with 3 levels
roots -a 3 "Write a comprehensive report on programming paradigms"

# Custom model
roots -a 2 --model openai/gpt-4o "Explain quantum computing vs classical computing"
```

Options:

| Flag | Description |
|------|-------------|
| `-a, --agents <n>` | Max subagents per node (default: 1) |
| `--model <model>` | Model (e.g., `deepseek/deepseek-v4-flash`) |
| `--thinking <level>` | Thinking level (off, minimal, low, medium, high) |
| `-h, --help` | Show help |

## Live Tree View

During execution, a live tree shows the delegation state:

```
🌳 roots  budget=2
│
├── ✅ Research Python asyncio (b=1) [2.3s]
│      Python's asyncio provides single-threaded cooperative...
└── 🟢 Research JS Promises (b=1) [1.5s]

1 done, 1 running (2 subagents)
```

Status indicators:
- 🟢 running (with elapsed time)
- ✅ completed (with duration)
- ❌ error (with message)
- ⏳ pending

## Delegation Format

Agents output a JSON delegation plan using a fenced code block:

````
```delegate
{
  "prompts": [
    "Research topic A focusing on X and Y...",
    "Research topic B focusing on Z and W..."
  ]
}
```
````

The system spawns subagents in parallel, feeds results back, and the agent synthesizes a final answer.

## Project Structure

```
agent-roots/
├── bin/roots          # CLI entry point
├── src/
│   ├── cli.ts         # CLI argument parsing
│   ├── agent.ts       # runAgent(): session lifecycle, delegation loop
│   ├── prompt.ts      # System prompt builder (leaf vs coordinator)
│   ├── tree.ts        # Live ANSI tree rendering
│   └── types.ts       # AgentNode, TreeState, RunConfig
├── package.json
└── tsconfig.json
```

## License

MIT
