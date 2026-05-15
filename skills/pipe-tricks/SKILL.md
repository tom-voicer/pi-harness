---
name: pipe-tricks
description: >-
  Shell piping techniques — composing commands with |, peeking at intermediate
  output with tee /dev/tty, formatting with jq/bat/column, and advanced
  multi-stage pipelines. Use this skill when the user wants to chain shell
  commands, debug a pipeline, format output, or learn piping tricks.
---

# Shell Pipe Tricks

Pipes (`|`) connect stdout of one command to stdin of the next. This skill covers practical patterns beyond the basics.

## The Absolute Basics

```bash
# Pipe stdout to stdin of the next command
cat file.txt | grep "error"

# Chain multiple times
cat access.log | grep "500" | cut -d' ' -f1 | sort | uniq -c | sort -rn

# Pipe into a file (redirect, not pipe — but often used together)
cat file.txt | grep "error" > errors.txt

# Append instead of overwrite
cat file.txt | grep "warn" >> warnings.txt
```

## Peeking at Intermediate Output — `tee /dev/tty`

The most underrated piping trick. `tee` writes to a file AND passes through to stdout. Use `/dev/tty` as the "file" to print to the terminal mid-pipeline:

```bash
# See what comes out of step 1 before it goes into step 2
cat data.json | tee /dev/tty | jq '.items[] | .name'

# Debug a broken pipeline — peek at each stage
cat huge.log \
  | grep "ERROR" | tee /dev/tty \
  | awk '{print $5}' | tee /dev/tty \
  | sort | uniq -c | sort -rn

# Check if grep is actually matching anything
ps aux | tee /dev/tty | grep node
```

**Pro tip:** If `tee /dev/tty` messes up your terminal, use `tee /dev/stderr` instead — it writes to stderr while stdout continues down the pipe:

```bash
cat data.json | tee /dev/stderr | jq '.results[]' 2>&1
```

## Pretty-Printing Pipe Output

### JSON — `jq`

```bash
# Pretty-print compact JSON
curl -s https://api.example.com/data | jq '.'

# Extract and format specific fields
cat data.json | jq '.users[] | {name: .name, email: .email}'

# Colorize JSON (jq does this by default when output is a terminal)
curl -s https://api.example.com/data | jq '.'

# Force color when piping further
curl -s https://api.example.com/data | jq -C '.' | less -R

# Compact JSON to single line
cat pretty.json | jq -c '.'
```

### Tables and columns

```bash
# Align columns
mount | column -t

# Pretty-print CSV as a table
cat data.csv | column -t -s ','

# Use `bat` for syntax-highlighted output
cat script.py | bat -l python

# JSON log files readable with bat
tail -f app.log | bat -l json

# Use `rich-cli` for markdown, JSON, CSV rendering
cat README.md | rich -
cat data.json | rich -
```

## Filtering and Transforming

### `grep` tricks

```bash
# Show lines before and after matches (context)
tail -f app.log | grep -A 3 -B 2 "ERROR"

# Invert match — show everything EXCEPT matches
cat file.txt | grep -v "DEBUG"

# Only show filenames that match (when piping from find)
find . -name "*.ts" | xargs grep -l "TODO"

# Count matches
cat app.log | grep -c "ERROR"
```

### `sed` one-liners

```bash
# Replace text mid-pipeline
cat template.txt | sed 's/{{NAME}}/Alice/g' | sed 's/{{DATE}}/2026-05-15/g'

# Delete lines matching a pattern
cat file.txt | sed '/^#/d' | sed '/^$/d'  # remove comments and blank lines

# Extract text between markers
cat file.html | sed -n '/<body>/,/<\/body>/p'
```

### `awk` for column work

```bash
# Print specific columns
ps aux | awk '{print $2, $11}'           # PID and command

# Conditional filtering
df -h | awk '$5 > 80 {print $1, $5}'    # disks over 80% full

# Sum a column
cat sales.csv | awk -F',' '{sum+=$3} END {print sum}'

# Reformat output
docker ps | awk '{printf "%-20s %s\n", $NF, $2}'
```

## Multi-Stage Pipeline Patterns

### Sort, deduplicate, count

```bash
# Find most frequent IPs in an access log
cat access.log | awk '{print $1}' | sort | uniq -c | sort -rn | head -10
```

### Filter, transform, aggregate

```bash
# Average response time by endpoint
cat api.log \
  | grep "response_time" \
  | awk '{print $7, $NF}' \
  | awk '{sum[$1]+=$2; count[$1]++} END {for(k in sum) print k, sum[k]/count[k]}' \
  | column -t
```

### Find → filter → act

```bash
# Find large JS files, show sizes, format nicely
find . -name "*.js" -type f -exec wc -c {} \; \
  | sort -rn \
  | head -10 \
  | awk '{printf "%-10s %s\n", $1, $2}' \
  | numfmt --to=iec --field=1
```

## Real-Time Pipeline Watching

### `pv` — pipe viewer with progress bar

```bash
# Show progress when processing large files
pv huge-file.csv | grep "error" > errors.csv

# With rate limiting
pv -L 1m large-file.txt | remote-upload-command

# Monitor how fast data flows
tar czf - /big/dir | pv | ssh host "tar xzf -"
```

### `stdbuf` — disable buffering for real-time output

```bash
# Some commands buffer output when piped. stdbuf -oL forces line buffering:
stdbuf -oL python slow_script.py | grep "progress"

# Or use unbuffer (from expect package)
unbuffer python slow_script.py | grep "progress"
```

## Named Pipes (FIFOs) for Complex Routing

When a simple linear pipe isn't enough:

```bash
# Create a named pipe
mkfifo mypipe

# Terminal 1: write to the pipe
tail -f /var/log/app.log > mypipe

# Terminal 2: read from the pipe, split to multiple consumers
cat mypipe | tee >(grep ERROR > errors.log) >(grep WARN > warnings.log) > /dev/null

# Clean up
rm mypipe
```

## Process Substitution — `>(cmd)` and `<(cmd)`

```bash
# Compare two command outputs without temp files
diff <(ls dir1) <(ls dir2)

# Pipe to multiple destinations at once
cat data.txt | tee >(grep "error" > errors.txt) >(grep "warn" > warnings.txt) > /dev/null

# Use command output as a file argument
jq '.users[]' <(curl -s https://api.example.com/users)
```

## Interactive Pipe Debugging

```bash
# Step through a pipeline one command at a time
cat access.log | grep "500"                # check first step
cat access.log | grep "500" | awk '{print $1}'  # add second step
# ...build up incrementally

# Use `less` to pause and inspect mid-pipeline
cat huge.json | jq '.' | less -R          # scroll through formatted output

# Use `head` to sample while building
cat huge.csv | head -5 | awk -F',' '{print $1, $3}'
```

## Common Pitfalls & Fixes

| Problem | Fix |
|---|---|
| Command buffers output when piped | Use `stdbuf -oL` or `unbuffer` |
| Pipe exits early (SIGPIPE) | The downstream command closed — expected with `head` |
| `grep` shows no color in pipe | Add `--color=always` |
| `ls` formats differently in pipe | Use `ls -1` or replace with `find` |
| stderr is lost in pipe | Redirect with `2>&1` or use `|&` in zsh/bash |
| `jq` loses color when piped | Use `jq -C '.'` |
| Need both stdout+stderr in pipe | `command 2>&1 | next` or `command |& next` (bash/zsh) |
| Pipe a string (not file) | `echo "text" | cmd` or `<<<"text" cmd` (here-string) |

## Cool One-Liners

```bash
# Random hex color
openssl rand -hex 3

# Pretty-print PATH
echo $PATH | tr ':' '\n' | nl

# Watch command output with highlighting
watch -n 1 -d "docker ps --format 'table {{.Names}}\t{{.Status}}'"

# Find duplicate files by checksum
find . -type f -exec md5sum {} \; | sort | uniq -w32 -d

# Quick HTTP server for current directory
python3 -m http.server 8080

# Get your public IP
curl -s https://api.ipify.org

# JSON to CSV conversion
cat data.json | jq -r '.[] | [.name, .email, .age] | @csv'

# Strip ANSI color codes from piped output
some-command | sed 's/\x1b\[[0-9;]*m//g'

# List processes by memory, human-readable
ps aux --sort=-%mem | head -11 | numfmt --to=iec --field=5,6
```

## Use with pi in Print Mode

```bash
# Pipe file contents to pi for analysis
cat error.log | pi -p "What went wrong?" --tools read

# Pipe pi's output to a file (code extraction)
pi -p "Write a Python factorial function" -x > factorial.py

# Review code and format output
git diff HEAD~1 | pi -p "Review these changes" --tools read

# Chain: find files → pi analyzes → format result
find src -name "*.ts" | head -5 | xargs cat | pi -p "Find security issues" --tools read
```
