# temporal-engine — YAML → Temporal Workflow (POC)

> **Status:** Fully working. All 6 workflow types validated, tested, and verified against a local Temporal server.
> **Date:** 2026-05-19
> **Location on disk:** `~/.pi/agent/project/temporal-engine`

---

## What this project is

A local proof-of-concept that takes **YAML workflow definitions** and runs them on **Temporal** (durable execution engine). The bridge between YAML and Temporal is **[Zigflow](https://zigflow.dev/)** (v0.11.3), an open-source Go binary that implements the CNCF Serverless Workflow DSL and compiles it into native Temporal workflows.

**The flow:** `YAML file → zigflow validate → zigflow run (worker) → temporal workflow start (trigger) → Temporal executes → results returned`

## Why Zigflow and not hand-rolled

Initially I built a custom TypeScript service that parsed YAML and ran it as a generic Temporal workflow. I then discovered that **Zigflow already exists** and does exactly this — but better:

- Implements the CNCF Serverless Workflow specification (industry standard)
- Has built-in validation with clear error messages
- Supports the full control-flow surface: `if`, `switch`, `for`, `fork` (parallel), `try/catch`, `raise`, signals, queries, schedules
- Handles child workflows, continue-as-new, retries, and Temporal-specific concerns automatically
- No SDK boilerplate — the YAML IS the implementation

The hand-rolled code was deleted. We use the real `zigflow` binary.

## What's installed (and how)

| Tool | Version | How installed | Notes |
|------|---------|---------------|-------|
| **zigflow** | 0.11.3 | `brew tap zigflow/tap && brew install zigflow` | Go binary at `/opt/homebrew/bin/zigflow` |
| **temporal CLI** | 1.7.0 | `brew install temporal` | At `/opt/homebrew/bin/temporal` |
| **Docker** | 27.4.0 | Pre-existing | Runs Temporal server + Postgres + UI |
| **Context7** | Extension | Custom pi extension | At `~/.pi/agent/extensions/context7/index.ts`, API key: `ctx7sk-bd47ce2b-2dda-4113-81e8-c96a8e0623e3` |

### Temporal server (Docker Compose)

Three containers defined in `docker-compose.yml`:
- `temporal-postgres` — PostgreSQL 16 (internal, port 5432 exposed to Docker network only)
- `temporal-server` — Temporal auto-setup, connects to localhost:7233
- `temporal-ui` — Web UI at http://localhost:8080

**Important:** The initial `DB=sqlite` config failed because `temporalio/auto-setup` only supports `postgres12`, `mysql8`, or `cassandra`. Switched to `DB=postgres12` with a separate Postgres container. Also `DEFAULT_NAMESPACE_RETENTION=1` needed to be `1d` (duration unit required).

### Zigflow worker

Run via `make worker` which calls:
```bash
zigflow run \
  --health-listen-address 0.0.0.0:3001 \   # Port 3000 was already in use
  --metrics-listen-address 0.0.0.0:9091 \   # Port 9090 may conflict too
  -f workflows/hello.yaml \
  -f workflows/if-else.yaml \
  # ... etc
```

The worker registers all workflow types on task queue `zigflow` and polls Temporal for tasks. It connects to `localhost:7233` by default.

## Project structure on disk

```
~/.pi/agent/project/temporal-engine/
├── docker-compose.yml          # Temporal + Postgres + UI (all 3 containers)
├── Makefile                    # up/down/worker/validate/start-*
├── README.md                   # This file
├── docs/                       # Full Zigflow documentation (offline reference)
│   └── zigflow/
│       ├── index.md            # Docs table of contents (quick nav)
│       └── docs/
│           ├── dsl/intro.md    # Full DSL spec (478 lines)
│           ├── dsl/tasks/      # Task type reference
│           ├── dsl/metadata/   # Activity options, retry policies
│           ├── concepts/       # data flow, how-zigflow-runs, error handling
│           ├── cli/            # CLI commands, MCP server
│           ├── deployment/     # Docker, Kubernetes, observability
│           ├── examples/       # hello-world, http-call, parallel-tasks
│           └── getting-started/
└── workflows/
    ├── hello.yaml              # Minimal: set + output.as
    ├── if-else.yaml            # if property + then:end flow directive
    ├── for-loop.yaml           # for loop + if-based per-item branching + export.as accumulation
    ├── repeat.yaml             # Integer repeat loop (for: in: ${ 5 })
    ├── parallel.yaml           # fork (3 concurrent branches) + export.as
    └── full-demo.yaml          # All constructs: for + if + fork + wait + summary
```

### Key doc files (read these when context-switching back in)

| File | Why |
|------|-----|
| `docs/zigflow/docs/dsl/intro.md` | Full DSL spec: document, do, input, output, export, schema, timeout, schedule |
| `docs/zigflow/docs/dsl/tasks/intro.md` | Task types overview, runtime expressions (`$context`, `$data`, `$input`), flow directives |
| `docs/zigflow/docs/concepts/data-and-expressions.md` | `$context` vs `$data`, `export.as` vs `output.as`, jq syntax reference |
| `docs/zigflow/docs/concepts/how-zigflow-runs.md` | Worker lifecycle, child workflows, how for/fork spawn children |
| `docs/zigflow/docs/concepts/error-handling-and-retries.md` | `try`/`catch`, retry policies, `raise` task |
| `docs/zigflow/docs/dsl/metadata/activity-options.md` | `startToCloseTimeout`, `retryPolicy`, heartbeat config |
| `docs/zigflow/index.md` | Full documentation index (find any doc quickly) |

## DSL rules (discovered through testing + Context7 docs)

These are the non-obvious rules I learned by validating YAML files and running workflows:

### Task properties — what can coexist

| Combination | Valid? | Notes |
|-------------|--------|-------|
| `set` only | ✅ | |
| `export` + `set` | ✅ | `export` needs a companion action |
| `export` + `set` + `then: end` | ✅ | |
| `export` + `then: continue` | ✅ | Tested: `export` + `set` + `then: continue` works |
| `export` ALONE (no action) | ❌ | `export` must be paired with `set`/`call`/`wait`/`do` |
| `if` + `export` + `set` | ✅ | At top level or inside for `do` block |
| `do` + `then: end` | ✅ | |
| `set` + `then: end` | ✅ | |
| `set` + `then: continue` | ✅ | |
| `output.as` + `set` | ✅ | |

### Data flow: `$context` vs `$data` vs `$output`

- **`set`** → stores in `$data` (workflow state, accessed via `$data.<key>`)
- **`export.as`** → stores in `$context` (accumulated state, persists across tasks, accessed via `$context.<key>`)
- **`output.as`** → transforms the task output, which gets stored under `$data.<taskName>`
- **`$context`** is accessible in runtime expressions of subsequent tasks
- **`$data`** persists across the entire workflow

### For loop behavior (critical)

- Each iteration runs as a **child workflow** (visible in Temporal history)
- Inner subtask `export.as` writes to the **child's** `$context` (not the parent's)
- To accumulate results into the parent: use `export.as` on the **for task itself**
  ```yaml
  - processUsers:
      export:
        as: "${ $context + { classified: . } }"   # . = combined output of all iterations
      for: ...
  ```
- Inner subtasks just use `set` to produce output (no need for inner `export`)
- After the for task, results are in `$context.classified` (not `$data.classified`)

### Fork behavior (parallel)

- Each branch runs as a **child workflow**
- Fork output shape: `{ branchName: branchOutput, ... }`
- To access fork results in subsequent tasks: use `export.as` on the fork task
  ```yaml
  - fanOut:
      export:
        as: "${ $context + { forkResults: . } }"
      fork: ...
  ```
- Then reference `$context.forkResults` in later tasks
- Fork output is NOT automatically in `$data.<taskName>` — must go through `export.as`

### If/else patterns

- **Simple if:** `if` property on any task gates execution
  ```yaml
  - gradeA:
      if: "${ $data.score >= 90 }"
      set: { grade: A }
      then: end    # Flow directive: stop workflow
  ```
- **If/else-if/else chain:** multiple tasks with `if`, last one without `if` (fallback). Each uses `then: end` to prevent fall-through.
- **Switch:** for complex multi-branch routing. Cases evaluated in order, first match wins. `then:` redirects to named task. The named task executes, then flow continues from AFTER that task in the `do` list (doesn't return to the switch).

### Flow directives

- `then: continue` — proceed to next task in `do` list
- `then: end` — terminate workflow immediately
- `then: exit` — leave current scope
- `then: <taskName>` — jump to named task (used in switch cases)

### Runtime expression gotchas

- Strings with jq operators need YAML quoting: `"${ $data.item.role == \"admin\" }"` — note the escaped quotes inside
- jq functions: `| length`, `| tostring`, `// []` (default empty array), `map(select(...))`
- `${ uuid }` and `${ timestamp_iso8601 }` are available (wrapped as Temporal side effects)
- The for loop provides: `$data.item` (current element), `$data.index`/`$data.idx` (current index)
- In for loops, `$data.item` is the raw element; `.priority` etc. work on objects

## Running the project (from scratch)

```bash
cd ~/.pi/agent/project/temporal-engine

# 1. Start Temporal server (Docker)
make up
# → Postgres, Temporal, UI at localhost:7233, http://localhost:8080

# 2. Start zigflow worker (blocking, keep running)
make worker
# → Registers all 6 workflow types on task queue "zigflow"

# 3. In another terminal, trigger workflows:
make start-if-else     # if/else demo
make start-for-loop    # for loop demo
make start-parallel    # fork/parallel demo
make start-full        # all constructs combined

# 4. Inspect results:
temporal workflow result --workflow-id <id>
temporal workflow show --workflow-id <id>
# or open http://localhost:8080
```

## Verified test results

| Workflow | Workflow ID | Result |
|----------|------------|--------|
| if-else-demo | `if-else-test-1` | `{"grade":"B","remark":"Good job! 👍"}` (score 85) |
| for-loop-demo | `for-loop-v2` | 3 users classified: admin→full, editor→write, viewer→read + countdown [3,2,1] |
| parallel-demo | `parallel-v3` | 3 branches: HTTP post fetched, 2s wait completed, 21*2=42 computed |
| full-demo | `full-v2` | 5 items → 2 urgent, 1 normal, 2 low + external post title + user name |

## Port usage

| Port | Service | Notes |
|------|---------|-------|
| 7233 | Temporal gRPC | zigflow worker connects here |
| 8080 | Temporal UI | Web dashboard |
| 5432 | Postgres | Internal to Docker network |
| 3001 | Zigflow healthcheck | Changed from 3000 (was in use) |
| 9091 | Zigflow Prometheus metrics | Changed from 9090 (conflict risk) |

## Troubleshooting reference

- **"No workers for task queue"** → Worker isn't running; start `make worker`
- **"Workflow type not found"** → `document.workflowType` doesn't match the `--type` argument
- **"Ports are not available: 5432"** → Local Postgres running; changed to `expose` instead of `ports`
- **"invalid argument for --retention"** → Needed `1d` not `1` (duration unit)
- **"Unsupported driver: DB=sqlite"** → Changed to `DB=postgres12` with separate Postgres container
- **Validate YAML before running:** `zigflow validate workflows/foo.yaml`
- **Worker crashes on port 3000/9090** → Use `--health-listen-address` and `--metrics-listen-address` flags
- **Context7 extension** → Lives at `~/.pi/agent/extensions/context7/index.ts`; loads on next pi restart; provides `resolve_library_id` and `query_docs` tools

## If I need to extend this later

- **New workflow pattern:** Add a `.yaml` file to `workflows/`, validate with `zigflow validate`, add `-f` flag to `make worker`
- **Custom Temporal activities:** Write an activity worker in any Temporal SDK language; reference it from Zigflow via `call: activity` task type
- **Scheduled workflows:** Add `schedule:` block to the YAML `document` section
- **Error handling:** Use `try:` task to wrap fallible tasks
- **Signals/queries:** Use `listen:` task type
- **Multiple task queues:** Set different `document.taskQueue` values; zigflow auto-creates separate workers per queue
- **Context7 for docs:** The extension at `~/.pi/agent/extensions/context7/` provides `resolve_library_id` and `query_docs` — query Zigflow (library ID: `/zigflow/zigflow`) or any other library's docs directly from within pi conversations
