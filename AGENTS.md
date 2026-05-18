# Global Guidelines

## Research before you build

When given a task that involves implementing a feature, utility, or integration, always ask first: **has this already been solved?**

- **If you know** existing libraries, packages, or tools that solve the task, use them. Do not rewrite from scratch what already exists and works.
- **If you are unsure**, search for existing solutions before writing any code. Use `web_search` to find libraries and `web_extract` to read their documentation. Use `context7` to look up API references and usage examples for candidate libraries.
- **Only build from scratch** when no adequate existing solution exists, or when integrating one would be more complex than writing a minimal implementation.

Writing code from scratch for a solved problem wastes time, burns tokens, and shifts focus away from the actual goal. The best code is often the code you don't write.

## Spawning subagents

You have a `subagent` tool that can spawn specialized child agents for delegation, parallel work, review, research, and implementation. Use subagents to:

- **Fan out parallel work**: run multiple read-only tasks (research, review, codebase recon) concurrently
- **Delegate specialized roles**: hand off to `scout`, `planner`, `worker`, `reviewer`, `researcher`, `oracle`, `context-builder`, or custom agents
- **Get adversarial review**: launch fresh-context `reviewer` agents with distinct angles (correctness, tests, simplicity)
- **Isolate writes**: keep one writer thread; parallelize reading, review, and validation instead

Prefer `async: true` for all subagent launches unless you intentionally need a blocking foreground run.

For complete workflows, syntax, agent authoring, intercom coordination, and best practices, read the full skill:
- **Skill**: `skills/pi-subagents/SKILL.md` (in the pi-subagents package)
- **Extension source**: `npm/node_modules/pi-subagents/src/extension/`

### Intercom: child-to-parent coordination

When `pi-intercom` is installed (it is), child agents get a private coordination channel back to the parent session automatically — no extra config needed. Use it when a child might need a decision instead of guessing:

- **`contact_supervisor` with `reason: "need_decision"`** — the child blocks until you reply. Use for blocking decisions, clarification, or approval before continuing.
- **`contact_supervisor` with `reason: "progress_update"`** — non-blocking ping when a discovery changes the plan or a checkpoint is reached.

You reply with `intercom({ action: "reply", message: "..." })`. Inspect pending asks with `intercom({ action: "pending" })`.

If a child appears stalled, needs-attention notices surface in the parent session with actionable next steps (status check, interrupt, nudge).

If intercom messages don't show up, run `subagent({ action: "doctor" })` or `/subagents-doctor`.

Most users don't call `intercom` directly — the bridge wires it automatically. Child-side routine completion handoffs are not expected; the parent receives grouped completion results through the bridge.
