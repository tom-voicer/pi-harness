# pi-harness

Custom agent roles, extensions, skills, and tools for [pi](https://github.com/earendil-works/pi-coding-agent) — the AI coding agent.

## Quick start

```bash
git clone https://github.com/tom-voicer/pi-harness.git ~/.pi/agent
```

Then set your API keys (pi stores them in `auth.json`, which is gitignored — never committed):

```bash
# LLM providers
llm keys set openai
llm keys set anthropic

# Tavily web search (used by web_search / web_extract tools)
export TAVILY_API_KEY="your-key"
```

---

## Agents

Agents are defined in [`agents.json`](agents.json). Activate with `--agent <name>`:

```bash
pi --agent piper "build a wooden chair"
pi --agent doug "review my code"
```

### Piper — goal-driven shell pipeline architect

```
pi --agent piper "query"      # or just: piper "query"
```

Piper takes ambiguous user goals and outputs executable shell pipe commands. It never answers questions directly — it builds the pipeline that will answer them.

**Configuration:**

| Setting | Value |
|---------|-------|
| Thinking | `low` |
| Tools | `web_search`, `web_extract` |
| Skills | `pipe-tricks`, `llm-cli` |
| End script | `piper-end.js` |
| Model | default |

**Philosophy:** Goal-driven, empathetic, decomposes workflows into small pipe stages. Structured output (lists, tables) gets `llm --schema-multi`; free text gets plain `llm` prompts.

**CLI shortcut:** `piper` command (via [`bin/piper`](bin/piper)). Add `~/.pi/agent/bin` to your PATH.

### Doug — chaotic NJ senior dev

```
pi --agent doug "review this code"
```

Doug vapes, crashes environments, loves his dog Joker, calls out nonsense — and is genuinely brilliant. Great for code review with personality.

**Configuration:**

| Setting | Value |
|---------|-------|
| Thinking | `off` |
| Blocked tools | `bash`, `edit`, `write` |
| Blocked skills | all (context7-mcp, find-docs, find-skills, llm-cli, pipe-tricks) |
| End script | none |
| Model | default |

---

## Extensions

Located in [`extensions/`](extensions/). pi auto-loads all `.ts` files on startup.

### agent-roles.ts

The agent system itself. Registers the `--agent` flag and the `/agent` interactive command.

| Hook / API | Purpose |
|------------|---------|
| `registerFlag("agent")` | Registers `--agent <name>` CLI flag |
| `registerCommand("agent")` | Registers `/agent` interactive command |
| `on("session_start")` | Loads `agents.json` |
| `on("before_agent_start")` | Injects agent system prompt, tools, skills, thinking, model |
| `on("input")` | Blocks `/skill:` commands for disallowed skills |
| `on("message_end")` | Runs end scripts on final text output; appends output constraint after base pi prompt |

**Key design:** The output constraint (`⛔ OUTPUT CONSTRAINT — READ THIS LAST`) is appended *after* pi's base system prompt so it's the last thing the model reads, preventing the base prompt's "be helpful" from overriding agent-specific output rules.

### web_search (tavily-search.ts)

Registers the `web_search` tool. Uses the Tavily Search API. Supports `query`, `search_depth`, `max_results`, `include_answer`, `include_raw_content`.

### web_extract (tavily-extract.ts)

Registers the `web_extract` tool. Uses the Tavily Extract API to pull clean markdown/text from web pages. Supports single URLs, batch extraction (up to 20), relevance-based chunking, image/favicon extraction.

---

## End Scripts

Located in [`end-scripts/`](end-scripts/). Run on each assistant message to validate/sanitize output. Configured per-agent via `endScript` in `agents.json`.

### piper-end.js

Two-phase pipeline that validates piper's pipe commands:

**Phase 1 — LLM extraction:** Uses `llm --schema` to extract clean pipe commands from raw agent output, stripping markdown fences, explanations, and non-command text. Falls back to regex extraction if `llm` is unavailable.

**Phase 2 — 7 deterministic validators:**

1. **Command allowlist** — only pi, llm, and safe CLI tools (curl, jq, grep, awk, sort, etc.). Rejects destructive commands (rm, sudo, git push, etc.)
2. **pi must have `-p`** — rejects bare `pi` without `-p`
3. **Balanced quotes** — detects unclosed quote pairs
4. **No empty segments** — catches `| |`, leading/trailing pipes
5. **Dangerous patterns** — blocks rm, sudo, chmod, git push, docker rm, eval, exec, file redirects to /dev/
6. **pi/llm have prompts** — ensures every command has arguments
7. **No file redirects** — output goes to stdout only

---

## Skills

Custom skills in [`skills/`](skills/). pi auto-loads from `~/.pi/agent/skills/`.

### pipe-tricks

Shell piping techniques — composing commands with `|`, peeking at intermediate output with `tee /dev/tty`, formatting with `jq`/`bat`/`column`, and advanced multi-stage pipelines.

### llm-cli

Reference for the `llm` CLI tool by Simon Willison — schema syntax (`--schema`, `--schema-multi`), templates, fragments, tools, logging, and all provider/model options.

---

## CLI

### piper

```bash
piper "how do I build a wooden chair"
piper "list top 10 sci-fi movies"
piper "summarize https://example.com"
```

Shell script at [`bin/piper`](bin/piper). Wraps `pi -p --agent piper "$@"`.

---

## Repo layout

```
~/.pi/agent/
├── .gitignore                   # auth.json, sessions/, bin/* (except bin/piper)
├── agents.json                  # Agent definitions (piper, doug)
├── settings.json                # Pi settings
├── models.json                  # Custom model configs
├── bin/
│   └── piper                    # CLI shortcut script
├── extensions/
│   ├── agent-roles.ts           # --agent flag, system prompt injection, output constraints
│   ├── tavily-search.ts         # web_search tool
│   └── tavily-extract.ts        # web_extract tool
├── end-scripts/
│   └── piper-end.js             # Pipe validation + extraction (7 validators + LLM extractor)
└── skills/
    ├── llm-cli/SKILL.md         # llm CLI reference
    └── pipe-tricks/SKILL.md     # Shell piping patterns
```

## Gitignored (not in repo)

| Path | Reason |
|------|--------|
| `auth.json` | API keys / secrets |
| `sessions/` | Conversation history — personal + large |
| `bin/fd`, `bin/rg` | Binary tools (not custom) |
| `convert`, `write` | Pi internals |
