# temporal-engine — Dynamic Workflow Executor

> **Status:** Engine implemented, tested against local Temporal server.
> **Location:** `~/.pi/agent/project/temporal-engine`

## What it is

A **self-contained engine** that accepts JSON workflow definitions at runtime and executes them on Temporal. One registered workflow type that interprets any valid definition — no files, no static registration.

The engine is designed to be embedded in a larger service (API + DB) that you'll build later. The engine itself knows nothing about persistence, HTTP routes, or auth — it exposes four functions.

## Architecture

```
                      ┌──────────────────────────────────┐
                      │            ENGINE                 │
                      │                                  │
   start(def)  ──────→│  ┌──────────┐    ┌───────────┐  │
   status(id)  ←──────│  │  Client  │───→│  Worker   │  │
   result(id)  ←──────│  │  module  │←───│  (1 type) │  │
   list()      ←──────│  └──────────┘    └─────┬─────┘  │
                      │                       │        │
                      │                  ┌─────┴─────┐  │
                      │                  │ Activities │  │
                      │                  │ HTTP, Log  │  │
                      │                  └───────────┘  │
                      └──────────────────────────────────┘
                                │
                                ▼
                      ┌──────────────────┐
                      │  Temporal Server  │
                      │  localhost:7233   │
                      └──────────────────┘
```

**Worker** registers one workflow type (`workflowRunner`) on the `dynamic-workflows` task queue. It polls Temporal for tasks and executes workflow definitions received as input.

**Client** connects to Temporal to start workflows, query live progress, await results, and list executions.

## API Surface

```typescript
import { start, status, result, list, cancel } from "./engine";

// Start a workflow with external input
const { id } = await start({
  name: "order-pipeline",
  input: { userId: 42, tier: "premium" },
  steps: [
    { type: "set",  variable: "threshold", value: 500 },
    { type: "log",  message: "Starting workflow for {{vars.customer}}" },
    { type: "http", method: "GET", url: "https://api.example.com/data" },
    { type: "sleep", duration: 2 },
    { type: "if",
      condition: { type: "gt", left: "{{vars.total}}", right: "{{vars.threshold}}" },
      then: [
        { type: "log", message: "Above threshold — requires approval" }
      ],
      else: [
        { type: "log", message: "Below threshold — auto-approved" }
      ]
    },
    { type: "for",
      over: "{{vars.items}}",
      as: "item",
      steps: [
        { type: "log", message: "Processing {{vars.item.name}}" },
        { type: "http", method: "GET", url: "{{vars.item.endpoint}}" }
      ]
    },
    { type: "fork",
      branches: [
        { name: "payment",   steps: [...] },
        { name: "inventory", steps: [...] }
      ]
    }
  ]
});
// → { id: "order-abc123", name: "order-pipeline", status: "running" }

// Query live progress (non-blocking)
const s = await status(id);
// → { status: "running", currentStep: 3, totalSteps: 12, completedSteps: 2, partialResults: [...] }

// Block until complete
const r = await result(id);
// → { status: "completed", stepsExecuted: 12, results: [...], startedAt: "...", completedAt: "..." }

// List recent executions
const runs = await list({ limit: 10 });
// → [{ id, name, status, startedAt }, ...]

// Cancel a running workflow
await cancel(id);
```

## Workflow Definition Format (JSON)

### Top-level

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Display name for the workflow |
| `steps` | Step[] | yes | Ordered list of steps to execute |
| `input` | object | no | External data passed at trigger time, available as `{{vars.input.x}}` in expressions |

### Step types

| Type | Properties | What it does |
|------|-----------|-------------|
| `set` | `variable` (string), `value` (any) | Store a variable in the execution context |
| `log` | `message` (string) | Log a message to worker stdout |
| `http` | `method` (GET/POST/PUT/DELETE), `url` (string), `headers?`, `body?` | Make an HTTP request |
| `sleep` | `duration` (number, seconds) | Pause execution for N seconds |
| `if` | `condition` (Condition), `then` (Step[]), `else?` (Step[]) | Conditional branching |
| `for` | `over` (array or var ref), `as` (string), `steps` (Step[]) | Iterate over array, sequential |
| `fork` | `branches` ({name, steps}[]) | Run branches in parallel |
| `workflow_run` | `definition?`, `workflow_file?`, `workflow_id?`, `input?`, `result_as?` | Run a sub-workflow (as Temporal child workflow) |

### workflow_run — Sub-workflow Execution

Runs another workflow as a [Temporal Child Workflow](https://docs.temporal.io/child-workflows). The child inherits the parent's task queue and is linked in Temporal's parent-child execution tree (cancellation propagates, UI shows the hierarchy).

**Resolution strategies** (one required):

| Field | Type | Description |
|-------|------|-------------|
| `definition` | WorkflowDefinition | Inline workflow definition |
| `workflow_file` | string | Path to a JSON workflow file (resolved relative to cwd) |
| `workflow_id` | string | Future: lookup workflow by ID from DB (not yet implemented) |

**Optional fields:**

| Field | Type | Description |
|-------|------|-------------|
| `input` | object | External input passed to the child workflow (merged with child's own input) |
| `result_as` | string | Variable name to save the child's result into (accessible as `{{vars.result_as}}` downstream) |

The child result shape saved into `result_as`:
```json
{ "name": "sub-workflow", "status": "completed", "stepsExecuted": 5, "results": [...] }
```

**Examples:**

```json
// Inline definition
{ "type": "workflow_run",
  "definition": {
    "name": "Fraud Check",
    "steps": [
      { "type": "log", "message": "Checking {{vars.input.userId}}" },
      { "type": "set", "variable": "approved", "value": true }
    ]
  },
  "input": { "userId": "{{vars.input.userId}}" },
  "result_as": "fraud_result"
}

// From file (path relative to engine/ directory)
{ "type": "workflow_run",
  "workflow_file": "../test/fraud-check.json",
  "input": { "userId": 42, "tier": "premium" },
  "result_as": "fraud_result"
}

// From DB (future)
{ "type": "workflow_run",
  "workflow_id": "wf-abc123",
  "input": { "customer": "acme" }
}
```

### Condition types

| Type | Properties | Evaluates |
|------|-----------|-----------|
| `eq` | `left`, `right` | left == right |
| `neq` | `left`, `right` | left != right |
| `gt` | `left`, `right` | left > right |
| `gte` | `left`, `right` | left >= right |
| `lt` | `left`, `right` | left < right |
| `lte` | `left`, `right` | left <= right |
| `and` | `conditions` (Condition[]) | All conditions true |
| `or` | `conditions` (Condition[]) | Any condition true |
| `not` | `condition` (Condition) | Negation |

### Variable references

Use `{{vars.x.y}}` to access variables set by `set` steps or injected via `input`. Works in any string field (`message`, `url`).

```
{{vars.input.userId}}            — external input passed at trigger time
{{vars.customer.name}}           — dotted path access
{{vars.items}}                   — array reference (for loop over)
{{vars.threshold}}               — number reference (in conditions)
```

Type-typed fields like `condition` values, `duration`, and `over` arrays are passed as-is.

### Step result shape

Each step produces:
```typescript
{
  step: number,          // Step index (1-based, flattened across nesting)
  type: string,          // "set" | "log" | "http" | "sleep" | "if" | "for" | "fork" | "workflow_run" | custom node type
  ok: boolean,           // Did it succeed?
  output: string,        // String representation of the result
  durationMs: number     // How long it took
}
```

## Execution Model

### Sequential by default

Steps execute in order. Each step waits for the previous one to complete.

### `for` loops — sequential iterations

Each iteration runs one after another. The loop variable `"{{vars.item}}"` is set to the current element on each iteration. This is deterministic and avoids child-workflow overhead.

### `fork` — true parallel

Branches run concurrently via `Promise.all()`. Each branch gets a **shallow copy** of the current variable context — branch A's `set` steps don't affect branch B's variables.

### Fail-fast

If any step fails, the workflow stops immediately. The error propagates to the `result()` call. No retries, no graceful degradation.

### Variable scope

Variables (`set`) are scoped to their execution context. A variable set inside an `if/then` block is visible to steps after that block. A variable set inside a `for` loop iteration persists across iterations. A variable set inside a `fork` branch is visible only within that branch.

### `workflow_run` — child workflows

Each `workflow_run` step starts a [Temporal Child Workflow](https://docs.temporal.io/child-workflows). The child gets its own execution context — it does **not** inherit the parent's variables. Pass data explicitly via `input`. To bring results back, use `result_as` — it saves the child's `{ name, status, stepsExecuted, results }` into the parent's variable context.

Child workflows count as **1 step** in the parent's progress (via `countSteps`). The child tracks its own progress independently via its own Temporal query.

Fail-fast applies: if a child workflow fails, the parent stops immediately (same as any other step failure). Cancelling the parent cascades to all running children via Temporal's native cancellation propagation.

Child workflows run on the same task queue as the parent (`dynamic-workflows`). For file-based definitions, the JSON file is read by the `resolveWorkflowDefActivity` activity (subject to the 2-minute activity timeout) — inline definitions bypass this entirely.

## Custom Nodes

Register new step types as Temporal activities. Handlers receive the step object (with `{{vars}}` already interpolated) and return a string result. Registration must happen before the worker starts.

> **Note:** The built-in `workflow_run` step also registers via this pattern for discoverability, but its actual execution uses Temporal's native `executeChild()` for proper parent-child visibility, cancellation cascade, and no activity timeout constraints.

### Registering a custom node

```typescript
import { registerNode } from './nodes/registry';
import type { CustomNodeHandler } from './nodes/registry';

const myHandler: CustomNodeHandler = async (step, ctx) => {
  // step — the step object from JSON, with {{vars}} already interpolated
  // ctx.vars — read-only snapshot of workflow state
  const query = step.query as string;
  const results = await fetch(`https://api.example.com?q=${query}`);
  return JSON.stringify(await results.json());
};

registerNode('my_api_call', myHandler);
```

Then use it in workflow JSON:
```json
{ "type": "my_api_call", "query": "search for {{vars.input.topic}}" }
```

Start the worker with nodes registered:
```bash
npx ts-node src/worker-with-nodes.ts
```

### Built-in library nodes

Three nodes ship with the engine, adapted from pi's web tools:

| Node | Step fields | Does |
|------|------------|------|
| `web_search` | `query` (string), `max_results?` (number) | SearXNG search (configurable URL) + DuckDuckGo fallback |
| `web_crawl` | `start_url` (string), `depth?`, `max_pages?`, `path_prefix?` | Crawls a site, extracts pages with Readability |
| `web_extract` | `urls` (string or array), `format?` ("markdown" or "text") | Extracts clean content from URLs |

```json
{
  "name": "Research Pipeline",
  "steps": [
    { "type": "web_search", "query": "{{vars.input.topic}}", "max_results": 3 },
    { "type": "web_crawl", "start_url": "https://zigflow.dev", "depth": 1, "max_pages": 5 },
    { "type": "web_extract", "urls": ["https://zigflow.dev/docs/dsl/intro"] }
  ]
}
```

---

## How the future service sits on top

```
┌────────────────────────────────────────┐
│           Future Service                │
│  POST /workflows     → DB.insert(def)  │
│  GET  /workflows/:id → DB.fetch(id)    │
│  POST /workflows/:id/run → engine.start(def)
│  GET  /runs/:id       → engine.status(id)
│                                         │
│          │          │          │        │
│    ┌─────┴─────┐    │    ┌─────┴─────┐ │
│    │  SQLite   │    │    │  Engine   │ │
│    │  (defs)   │    │    │  (this)   │ │
│    └───────────┘    │    └───────────┘ │
└─────────────────────┴──────────────────┘
```

The future service calls `engine.start(def)` with a definition fetched from DB. The engine returns a workflow ID. The service can poll `engine.status(id)` or await `engine.result(id)`. The engine handles all Temporal concerns — the service just passes JSON through.

## Project structure

```
temporal-engine/
├── docker-compose.yml        # Temporal + Postgres + UI
├── Makefile                  # up, down, worker, demo
├── README.md                 # This file
├── engine/
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── types.ts           # All shared types
│       ├── executor.ts        # Pure logic: resolveValue, evaluateCondition, countSteps
│       ├── activities.ts      # Temporal activities: httpActivity, logActivity, customNodeActivity
│       ├── workflow.ts        # The one workflow + progress query handler
│       ├── worker.ts          # Worker entry (exports registerNode)
│       ├── worker-with-nodes.ts  # Worker with library nodes registered
│       ├── client.ts          # Engine API: start, status, result, list, cancel
│       ├── cli-run.ts         # CLI: submit workflows from file/inline/stdin
│       ├── index.ts           # Public exports
│       └── nodes/
│           ├── registry.ts    # registerNode(), getHandler(), listCustomNodes()
│           └── library/
│               ├── web-search.ts   # SearXNG + DuckDuckGo search
│               ├── web-crawl.ts    # Site crawler with Readability
│               └── web-extract.ts  # Single-URL content extractor
│               └── workflow-run.ts # Sub-workflow execution (metadata)
└── test/
    ├── demo.json               # Simple demo workflow
    ├── order-fulfillment.json  # Complex multi-branch workflow
    ├── research-pipeline.json  # Uses custom nodes
    ├── fraud-check.json        # Child workflow (used by sub-workflow tests)
    ├── inventory-check.json    # Child workflow (used by sub-workflow tests)
    ├── sub-workflow-inline.json    # Parent → child via inline definition
    └── sub-workflow-from-file.json # Parent → child via JSON file
```

## Quickstart

```bash
cd ~/.pi/agent/project/temporal-engine

# 1. Start Temporal
make up

# 2. Start the engine worker
make worker

# 3. Run the smoke test (in another terminal)
make test

# 4. Inspect at http://localhost:8080
```

## Commands

```
make up        Start Temporal + UI (Docker)
make down      Stop Temporal
make worker    Start engine worker
make worker-nodes  Start worker with library nodes (web_search, web_crawl, web_extract, workflow_run)
make install   Install engine dependencies
make run WF=../test/demo.json    Run a workflow from a JSON file
make test-sub-inline  Run sub-workflow demo (inline definition)
make test-sub-file    Run sub-workflow demo (from file + parallel)
```

### CLI usage

```bash
# From a file
npx ts-node src/cli-run.ts ../test/demo.json

# From a file with external input
npx ts-node src/cli-run.ts ../test/demo.json -i '{"userId":42,"tier":"premium"}'

# Inline JSON
npx ts-node src/cli-run.ts --inline '{"name":"test","steps":[{"type":"log","message":"hi"}]}'

# Inline with input
npx ts-node src/cli-run.ts --inline '...' -i '{"key":"value"}'

# From stdin
echo '{"name":"test",...}' | npx ts-node src/cli-run.ts -

# With make (from project root)
make run WF=../test/demo.json
```
