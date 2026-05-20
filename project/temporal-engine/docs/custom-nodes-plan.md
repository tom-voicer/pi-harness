# Custom Nodes Implementation Plan

> Core feature for the temporal-engine. Custom nodes make the engine extensible — new step types are registered as Temporal activities and dispatched at runtime.

## Architecture Overview

```
┌──────────────────────────────────────────────────────────┐
│                      ENGINE                               │
│                                                           │
│  registerNode("web_search", handler)  ←─ user code       │
│  registerNode("send_email", handler)  ←─ user code       │
│              │                                            │
│              ▼                                            │
│  ┌──────────────────────┐    ┌──────────────────────────┐ │
│  │   Node Registry       │    │   Worker                 │ │
│  │   (module-level Map)  │───→│   collects all handlers  │ │
│  │                       │    │   passes to Worker.create│ │
│  └──────────────────────┘    └──────────┬───────────────┘ │
│                                         │                  │
│  ┌──────────────────────┐               │                  │
│  │   Workflow            │               ▼                  │
│  │   executeSteps()      │    ┌──────────────────────────┐ │
│  │                       │    │   Activities              │ │
│  │  case "set": ...      │    │   logActivity             │ │
│  │  case "for": ...      │    │   httpActivity            │ │
│  │  default:             │    │   customNodeActivity ←─── │ │
│  │    customNodeActivity │───→│     reads registry        │ │
│  │                       │    │     calls handler(step)   │ │
│  └──────────────────────┘    └──────────────────────────┘ │
│                                                           │
└──────────────────────────────────────────────────────────┘
```

**Key insight:** Custom node handlers are Temporal activities. This means they automatically get retries, timeouts, heartbeat support, and all Temporal guarantees — for free.

## File Structure

```
engine/src/
├── nodes/
│   ├── registry.ts          # registerNode(), getHandler(), listNodes()
│   ├── builtins.ts          # Built-in step types (set, log, http, sleep, if, for, fork)
│   └── handlers.ts          # Activity handler for custom nodes (dispatches via registry)
├── activities.ts            # logActivity, httpActivity, customNodeActivity
├── executor.ts              # Pure functions: resolveValue, evaluateCondition, countSteps
├── workflow.ts              # workflowRunner + progress query (updated: dispatch unknown types)
├── worker.ts                # Worker entry (updated: collect custom activities)
├── client.ts                # Engine API: start, status, result, list, cancel
├── types.ts                 # All shared types (updated: CustomNodeHandler)
└── index.ts                 # Public exports (updated: export registerNode)
```

## 1. Node Registry (`nodes/registry.ts`)

```typescript
type CustomNodeHandler = (
  step: Record<string, unknown>,   // Step object from the workflow JSON
  ctx: { vars: Record<string, unknown> }  // Execution context (vars already interpolated)
) => Promise<string>;              // String result (appears in step output)

// Module-level state — populated at worker startup, never mutated during execution
const handlers = new Map<string, CustomNodeHandler>();

function registerNode(type: string, handler: CustomNodeHandler): void {
  if (BUILTIN_TYPES.has(type)) {
    throw new Error(`Cannot override built-in step type: ${type}`);
  }
  handlers.set(type, handler);
}

function getHandler(type: string): CustomNodeHandler | undefined {
  return handlers.get(type);
}

function listCustomNodes(): string[] {
  return [...handlers.keys()];
}
```

**Rules:**
- Registration must happen BEFORE `Worker.create()` (before worker starts)
- Built-in types (`set`, `log`, `http`, `sleep`, `if`, `for`, `fork`) cannot be overridden
- Handlers are async → can do HTTP, DB queries, file I/O, anything
- Handlers receive the step with `{{vars}}` already interpolated by the engine

## 2. Custom Node Activity (`nodes/handlers.ts` and `activities.ts`)

The workflow can't call arbitrary functions — only proxied activities. So we register ONE generic activity that dispatches to the right handler:

```typescript
// activities.ts
export async function customNodeActivity(
  nodeType: string,
  step: Record<string, unknown>,
  vars: Record<string, unknown>,
): Promise<string> {
  const handler = getHandler(nodeType);
  if (!handler) {
    throw new Error(`Unknown custom node type: ${nodeType}. Registered: ${listCustomNodes().join(', ')}`);
  }
  return handler(step, { vars });
}
```

The workflow calls this activity for any unrecognized step type:

```typescript
// workflow.ts — inside executeSteps()
default:
  // Try custom node
  output = await customNodeActivity(step.type, step, ctx.vars);
```

## 3. Worker Integration (`worker.ts`)

The worker must register `customNodeActivity` as an activity, and `registerNode()` must be called before `Worker.create()`:

```typescript
// worker.ts
import * as builtinActivities from './activities';
import { listCustomNodes } from './nodes/registry';

// User calls registerNode() here (via imports that run before Worker.create)

const worker = await Worker.create({
  workflowsPath: require.resolve('./workflow'),
  activities: {
    ...builtinActivities,
    // customNodeActivity is already in builtinActivities
  },
  taskQueue: 'dynamic-workflows',
});
```

If some custom nodes need their own dedicated activities (e.g., a `send_email` node that has a long timeout), users pass them explicitly:

```typescript
registerNode('send_email', sendEmailHandler);

const worker = await Worker.create({
  activities: {
    ...builtinActivities,
    sendEmailActivity,  // ← dedicated activity with its own timeout config
  },
});
```

## 4. Public API (`index.ts`)

```typescript
export { registerNode } from './nodes/registry';
export { start, status, result, list, cancel } from './client';
export type { CustomNodeHandler } from './nodes/registry';
```

## 5. Node Library (`nodes/library/`)

A collection of pre-built reusable nodes. Each is a function that returns a `CustomNodeHandler`:

```typescript
// nodes/library/web-search.ts
export function webSearchHandler(apiKey: string): CustomNodeHandler {
  return async (step) => {
    const query = step.query as string;
    const results = await fetch(`https://api.search.example.com?q=${encodeURIComponent(query)}&key=${apiKey}`);
    const data = await results.json();
    return JSON.stringify(data.results.slice(0, 5));
  };
}

// nodes/library/send-email.ts
export function sendEmailHandler(smtp: SmtpConfig): CustomNodeHandler {
  return async (step) => {
    await transporter.sendMail({
      to: step.to as string,
      subject: step.subject as string,
      body: step.body as string,
    });
    return `Email sent to ${step.to}`;
  };
}
```

Users compose them:

```typescript
import { registerNode } from 'temporal-engine';
import { webSearchHandler } from 'temporal-engine/nodes/library/web-search';
import { sendEmailHandler } from 'temporal-engine/nodes/library/send-email';

registerNode('web_search', webSearchHandler(process.env.SEARCH_API_KEY!));
registerNode('send_email', sendEmailHandler({ host: 'smtp.example.com' }));

// Start worker (picks up registered nodes)
```

## 6. Workflow JSON Using Custom Nodes

```json
{
  "name": "Research & Notify",
  "input": { "topic": "quantum computing", "email": "alice@example.com" },
  "steps": [
    { "type": "log", "message": "Researching: {{vars.input.topic}}" },
    {
      "type": "web_search",
      "query": "latest breakthroughs in {{vars.input.topic}}"
    },
    { "type": "log", "message": "Search complete — sending email" },
    {
      "type": "send_email",
      "to": "{{vars.input.email}}",
      "subject": "Research results for {{vars.input.topic}}",
      "body": "Here are the results..."
    }
  ]
}
```

The engine:
1. Encounters `web_search` → not in builtins → calls `customNodeActivity("web_search", step, ctx.vars)`
2. Registry dispatches to `webSearchHandler` with the step object (`query` already interpolated to "latest breakthroughs in quantum computing")
3. Handler runs, returns JSON string
4. Output appears in step results like any built-in step

## 7. Handler Contract

Every custom node handler receives:

| Input | Type | Description |
|-------|------|-------------|
| `step` | `Record<string, unknown>` | The step object from JSON, with all `{{vars.x}}` already interpolated into string values |
| `ctx.vars` | `Record<string, unknown>` | Full execution context (read-only snapshot) — includes all variables set by previous steps |

Every handler must return:

| Output | Type | Description |
|--------|------|-------------|
| (return value) | `Promise<string>` | String result — appears as the step's `output` in results |

**Handler guidelines:**
- Treat `step` as the node's configuration — read any custom fields you defined
- Use `ctx.vars` to access workflow state set by previous `set` steps
- Return a meaningful string — it's what users see in results and what downstream steps can reference
- Throw on failure — Temporal retries kick in automatically (configure `retry` policy on the activity)
- Keep handlers stateless — they may be retried

## 8. Refactoring Built-ins

After custom nodes land, we refactor built-in step types to use the same handler pattern internally — not required for v1, but cleans up the codebase:

```
src/nodes/
├── builtins/
│   ├── set.ts         # setNode handler
│   ├── log.ts         # logNode handler
│   ├── http.ts        # httpNode handler
│   ├── sleep.ts       # (stays in workflow — deterministic)
│   ├── if.ts          # (stays in workflow — deterministic)
│   ├── for.ts         # (stays in workflow — deterministic)
│   └── fork.ts        # (stays in workflow — deterministic)
```

Control-flow steps (`if`, `for`, `fork`, `sleep`) remain in the workflow because they're deterministic orchestration. Leaf steps (`set`, `log`, `http`) become registered handlers like custom nodes — just built-in.

## Implementation Order

1. **Create `nodes/registry.ts`** — the Map + registerNode/getHandler/listCustomNodes
2. **Add `customNodeActivity` to `activities.ts`** — dispatches via registry
3. **Update `workflow.ts`** — `default:` case calls `customNodeActivity`
4. **Update `worker.ts`** — expose `registerNode`, ensure customNodeActivity is in activities
5. **Update `index.ts`** — export `registerNode` and `CustomNodeHandler` type
6. **Create `nodes/library/web-search.ts`** — first library node (uses the existing `web_search` tool or a real search API)
7. **Test** — register a custom node, run a workflow that uses it, verify dispatch
8. **Document** — update README with custom node authoring guide
