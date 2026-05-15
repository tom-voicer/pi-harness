---
name: llm-cli
description: >-
  Use this skill when the user wants to run LLM prompts from the command line,
  chat interactively with models, extract structured JSON via schemas, manage
  prompt templates, or work with the `llm` CLI tool by Simon Willison. Activates
  for any mention of `llm` as a command, "llm prompt", "llm chat", "llm models",
  "llm logs", "llm schemas", "llm templates", or questions about running LLMs
  from the terminal.

  The `llm` tool is a command-line utility for interacting with large language
  models. It supports OpenAI, Anthropic, Google Gemini, local models via plugins,
  and many other providers.
---

# LLM CLI Tool

The `llm` command is a Python CLI for interacting with large language models. Install with:

```bash
pip install llm
# or: pipx install llm
# or: brew install llm
```

Set API keys before first use:

```bash
llm keys set openai
# Paste your key when prompted

# Other providers:
llm keys set anthropic
llm keys set gemini
```

Install plugins for additional providers:

```bash
llm install llm-claude-3    # Anthropic Claude models
llm install llm-gemini      # Google Gemini models
llm install llm-mistral     # Mistral models
llm install llm-ollama      # Local models via Ollama
llm install llm-groq        # Groq hosted models
```

## Core Commands

### llm prompt — send a prompt (default command)

```bash
# Simple prompt
llm "Write a haiku about coding"

# Shorthand: llm 'prompt' is the default, so these are equivalent:
llm prompt "hello"
llm "hello"

# Pipe content as part of prompt
cat file.py | llm "Explain this code"

# Use a specific model
llm -m gpt-4o "Explain quantum computing"
llm -m 4o "Explain quantum computing"          # alias
llm -m claude-3.5-sonnet "Explain ..."         # from a plugin

# Search for a model by partial name match
llm -q turbo "Hello"                           # finds shortest match

# No streaming (wait for full response)
llm --no-stream "Write a poem"

# Change default model for session
export LLM_MODEL=claude-3.5-sonnet
```

### llm chat — interactive conversation

```bash
# Start interactive chat
llm chat
llm chat -m gpt-4o
llm chat -m 4o -o temperature 0.7

# Continue most recent conversation
llm chat -c

# With a system prompt
llm chat -s 'You are a helpful Python expert'

# With a saved template (persona)
llm chat -t cheesecake

# Inside chat:
#   Type '!multi' to enter multi-line mode, end with '!end'
#   Type '!edit' to open editor for current prompt
#   Type 'quit' or 'exit' to leave

# Chat with tools enabled
llm chat -T simple_eval
```

### llm models — list and configure models

```bash
# List all available models and their aliases
llm models

# Search by term
llm models -q anthropic

# Show options supported by each model
llm models --options

# Set default options for a model
llm models options set gpt-4o temperature 0.5

# List all default model options
llm models options list

# Show options for a specific model
llm models options show gpt-4o

# Clear a default option
llm models options clear gpt-4o temperature

# List models that support schemas
llm models --schemas
```

### llm logs — browse conversation history

```bash
# View recent conversations
llm logs

# View most recent conversation
llm logs -c

# View with full prompts and responses
llm logs -c --full

# Output just the JSON data from responses
llm logs -c --data

# Output as a JSON array
llm logs -c --data-array

# Filter by schema
llm logs --schema t:people --data-array

# Query by conversation ID
llm logs --cid 01abc123
```

### llm templates — manage reusable prompts

```bash
# List saved templates
llm templates

# Save a template
llm --save cheesecake -s 'You are a sentient cheesecake' ''

# Use a template
llm -t cheesecake "Tell me about yourself"

# Save a schema as a template
llm --save dogs --schema 'name, age int, one_sentence_bio' ''

# Use a schema template
llm -t dogs 'invent a cool dog'

# Show template YAML
llm templates show cheesecake

# Edit a template
llm templates edit cheesecake

# Extract code blocks from template output
llm -t pytest <(cat file.py) -x
```

## System Prompts

```bash
# Inline system prompt
llm -s 'You are an expert SQL developer' 'Write a query to find duplicate users'

# System prompt from a file
llm --system "$(cat instructions.txt)" 'Analyze this data'

# System prompt via fragment
llm --sf explain_code 'Describe this code'

# Saved as template (recommended for reuse)
llm --save sql-expert -s 'You are an expert SQL developer. Always use CTEs.' ''
llm -t sql-expert 'Query to find top customers by revenue'
```

## Attachments (multimodal)

```bash
# Attach an image
llm -a photo.jpg "Describe this image"

# Attach from URL
llm -a https://example.com/chart.png "What does this chart show?"

# Multiple attachments
llm -a photo1.jpg -a photo2.jpg "Compare these images"

# Pipe an attachment
cat image.png | llm -a - "Describe this image"

# Specify content type for piped attachment
cat data.bin | llm -a - --attachment-type image/png "Describe"
```

## Continuing Conversations

```bash
# Continue most recent conversation
llm -c "Tell me more"

# Continue a specific conversation by ID
llm -c --cid 01abc123 "Elaborate on that"

# Note: `-c` auto-uses the same model as the original conversation
```

## Extracting Code Blocks

```bash
# Extract the FIRST fenced code block (omit markdown explanation)
llm "Write a Python function to sort a list" -x

# Extract the LAST fenced code block
llm "Write a function" -xl

# Pipe extracted code directly to a file
llm "Write a factorial function in Python" -x > factorial.py
```

## Model Options

```bash
# Set temperature
llm -o temperature 0.2 "Be more deterministic"

# Multiple options
llm -o temperature 0.2 -o max_tokens 500 "Short answer"

# Available options vary by model — check with:
llm models -m gpt-4o --options
```

## Fragments (long context, stored once)

```bash
# Use a URL as context (stored once, referenced by hash)
llm -f https://example.com/large-doc.txt "Summarize this"

# Use a local file as a fragment
llm -f long_file.py "Refactor this code"

# Multiple fragments (concatenated in order)
llm -f part1.txt -f part2.txt -f part3.txt "Analyze these"

# Save a fragment with an alias
llm fragments set python-api https://docs.python.org/3/library/functions.html

# List all fragments
llm fragments

# Search fragments by content
llm fragments -q python -q api

# Remove an alias (doesn't delete fragment data)
llm fragments remove python-api
```

## Schemas — Structured JSON Output

`llm` supports requesting structured JSON output via JSON schemas. This works with OpenAI, Anthropic, and Google Gemini models.

### Concise schema DSL

```bash
# Simple schema (comma-separated field:type pairs)
llm --schema 'name, age int, bio' 'invent a dog'

# With field descriptions
llm --schema 'name: the full name, age int: age in years' 'invent a dog'

# Multi-line schema with descriptions
llm --schema '
  name: the person name
  organization: who they represent
  role: their job title
  learned: what we learned about them
  article_headline: headline of the story
  article_date: publication date YYYY-MM-DD
' 'extract people mentioned in this article'

# Types: str (default), int, float, bool
llm --schema 'product str, price float, in_stock bool' 'list 3 products'
```

### Multi-item schemas

```bash
# Return multiple items matching the schema
llm --schema-multi 'name, age int, bio' 'invent 3 cool dogs'
# Returns: {"items": [{"name": "Echo", "age": 3, "bio": "..."}, ...]}
```

### Full JSON Schema

```bash
# Use a raw JSON schema
llm --schema '{
  "type": "object",
  "properties": {
    "name": {"type": "string"},
    "age": {"type": "integer"}
  },
  "required": ["name", "age"]
}' 'invent a dog'

# From a file
llm --schema dogs.schema.json 'invent a dog'
```

### Saving and reusing schemas

```bash
# Save a schema as a template
llm --save dogs --schema 'name, age int, one_sentence_bio' ''

# Use it later
llm -t dogs 'invent a dog'
llm -m gpt-4o -t dogs 'invent a dog'

# Save schema + system prompt as a template
llm --save people \
  -s 'extract people mentioned in this article' \
  --schema 'name, organization, role, learned, article_headline, article_date' ''

# Use against a URL
curl -s https://example.com/article | llm -t people
```

### Browsing logged schemas

```bash
# List all recorded schemas
llm schemas

# Show full schema detail
llm schemas --full

# Convert concise DSL to JSON schema
llm schemas dsl 'name, age int, bio: a short bio'
```

### Querying logged JSON data

```bash
# Get all items logged with a specific schema (newline-delimited JSON)
llm logs --schema t:people --data

# Get as a JSON array
llm logs --schema t:people --data-array

# Pipe into sqlite-utils to build a database
llm logs --schema t:people --data-array | \
  sqlite-utils insert people.db people -

# Explore with Datasette
datasette people.db
```

## Tools (Function Calling)

```bash
# Define a tool inline as a Python function
llm --functions 'def multiply(x: int, y: int) -> int:
    """Multiply two numbers."""
    return x * y' \
  'what is 34234 * 213345'

# Debug tool calls
llm --functions 'def add(a: int, b: int) -> int: return a + b' \
  'what is 123 + 456' --tools-debug

# Approve each tool call interactively
llm --functions '...' 'prompt' --tools-approve

# Use a tool from a plugin
llm install llm-tools-simpleeval
llm -T simple_eval "4444 * 233423"

# List available tools from plugins
llm tools

# Toolbox — a collection of related tools
llm -T Datasette 'Datasette("https://datasette.io/content")' "Show tables"
```

## Other Useful Patterns

```bash
# Embed shell command output
llm "Tell me about my OS: $(uname -a)"

# Combine pipe + arguments (piped content prepended to prompt)
cat myscript.py | llm "explain this code"

# Run against a URL (via curl pipe or fragment)
curl -s https://example.com/article | llm "summarize this"

# Strip HTML before sending
curl -s https://example.com | uvx strip-tags | llm "summarize this"

# Use with Git
git diff | llm "Describe these changes as a bullet list"

# Set default model via environment variable
export LLM_MODEL=gpt-4o
```

## Common Mistakes

- Always set API keys first with `llm keys set <provider>` before using a model
- `-c` (continue) uses the same model as the original conversation — no need to pass `-m`
- Schema templates should be used with `-t name`, not `--schema t:name` (that's for `llm logs`)
- `--schema-multi` wraps results in `{"items": [...]}`, while `--schema` returns a single object
- When piping content, it becomes the first part of the prompt, with CLI arguments appended
- Different models support different subsets of JSON Schema — not all features work universally
- For Claude models, you need `llm install llm-claude-3` and `llm keys set anthropic`
- Fragments are stored once in the database and referenced by hash — great for large, repeated context
