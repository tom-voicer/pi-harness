import type { AgentNode, TreeState } from "./types.js";
import { rawWrite } from "./stdout.js";

// ── Alternate screen buffer ──────────────────────────────────────────
// The conventional paradigm for live-updating terminal views (used by
// vim, less, htop, lazygit, git diff, and thousands of other tools).
//
// Why this instead of log-update:
//   log-update tracks cursor position by counting lines. When the tree
//   exceeds terminal height and the terminal scrolls, the cursor position
//   is no longer where log-update thinks it is. Its eraseLines(N) moves
//   up N lines from the WRONG position, so old content is never erased —
//   it just accumulates in the scrollback.
//
// The alternate screen buffer has no scrollback. We clear and redraw
// every frame. No cursor tracking, no line counting, no diffing.
//
// Escape sequences (ANSI X3.64 / ECMA-48):
//   \x1b[?1049h — enter alt screen (save cursor, switch to clean buffer)
//   \x1b[?1049l — exit alt screen (restore cursor and original buffer)
//   \x1b[2J    — erase entire display
//   \x1b[H     — cursor to home (row 1, column 1)
//   \x1b[3J    — erase scrollback (prevent accumulation if alt screen
//                isn't supported; ignored by terminals that lack it)

const ENTER_ALT = "\x1b[?1049h";
const EXIT_ALT = "\x1b[?1049l";
const CLEAR = "\x1b[2J\x1b[H";
const CLEAR_SCROLLBACK = "\x1b[3J";

let inAltScreen = false;

function enterAltScreen(): void {
  if (!inAltScreen && process.stdout.isTTY) {
    rawWrite(ENTER_ALT);
    inAltScreen = true;
  }
}

function exitAltScreen(): void {
  if (inAltScreen) {
    rawWrite(EXIT_ALT);
    inAltScreen = false;
  }
}

// Ensure alt screen is exited on abnormal termination
process.on("exit", exitAltScreen);
process.on("SIGINT", () => { exitAltScreen(); process.exit(1); });
process.on("SIGTERM", () => { exitAltScreen(); process.exit(1); });

function redrawFrame(output: string): void {
  enterAltScreen();
  // Clear display + clear scrollback + home cursor, then write the frame.
  // \x1b[3J clears the scrollback buffer (supported by xterm, iTerm2,
  // Windows Terminal, kitty, alacritty; silently ignored elsewhere).
  rawWrite(CLEAR + CLEAR_SCROLLBACK + output);
}

const STATUS_ICONS: Record<string, string> = {
  pending: "⏳",
  running: "🔄",
  success: "✅",
  error: "❌",
};

function truncate(text: string, maxLen: number): string {
  const singleLine = text.replace(/\n/g, " ").trim();
  if (singleLine.length <= maxLen) return singleLine;
  return singleLine.slice(0, maxLen - 1) + "…";
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function renderNode(
  node: AgentNode,
  nodes: Map<string, AgentNode>,
  prefix: string,
  isLast: boolean,
): string[] {
  const lines: string[] = [];
  const connector = isLast ? "└── " : "├── ";
  const icon = STATUS_ICONS[node.status] ?? "  ";
  const shortPrompt = node.name || truncate(node.prompt, 48);
  const budget = node.maxAgents > 1 ? ` (b=${node.maxAgents})` : "";

  let line = `${prefix}${connector}${icon} ${shortPrompt}${budget}`;

  if (node.toolNames.length > 0) {
    line += ` \x1b[2m[${node.toolNames.join(", ")}]\x1b[0m`;
  }

  if (node.status === "running" && node.startTime) {
    line += ` \x1b[2m[${formatDuration(Date.now() - node.startTime)}]\x1b[0m`;
  } else if (node.status === "success" && node.endTime && node.startTime) {
    line += ` \x1b[2m[${formatDuration(node.endTime - node.startTime)}]\x1b[0m`;
  } else if (node.status === "error" && node.error) {
    line += ` \x1b[2m[${truncate(node.error, 30)}]\x1b[0m`;
  }

  lines.push(line);

  // Output preview intentionally omitted — suspected cause of terminal flickering.

  const childPrefix = prefix + (isLast ? "    " : "│   ");
  node.children.forEach((childId, i) => {
    const child = nodes.get(childId);
    if (child) {
      lines.push(
        ...renderNode(
          child,
          nodes,
          childPrefix,
          i === node.children.length - 1,
        ),
      );
    }
  });

  return lines;
}

function countStatuses(state: TreeState) {
  let completed = 0;
  let running = 0;
  let pending = 0;
  let errors = 0;

  for (const node of state.nodes.values()) {
    if (node.id === state.rootId) continue;
    switch (node.status) {
      case "success":
        completed++;
        break;
      case "running":
        running++;
        break;
      case "pending":
        pending++;
        break;
      case "error":
        errors++;
        break;
    }
  }

  return { completed, running, pending, errors };
}

function hasSubagents(state: TreeState): boolean {
  const root = state.rootId ? state.nodes.get(state.rootId) : null;
  return root ? root.children.length > 0 : false;
}

export function renderTreeText(state: TreeState): string {
  const root = state.rootId ? state.nodes.get(state.rootId) : null;
  if (!root) return "";
  if (!hasSubagents(state)) return ""; // Don't render empty tree

  const lines: string[] = [];
  lines.push(
    `\x1b[1m🌳 roots\x1b[0m  \x1b[2mbudget=${root.maxAgents}\x1b[0m` +
      (root.toolNames.length > 0
        ? ` \x1b[2m[${root.toolNames.join(", ")}]\x1b[0m`
        : ""),
  );
  lines.push("│");

  const { completed, running, pending, errors } = countStatuses(state);
  const total = completed + running + pending + errors;

  root.children.forEach((childId, i) => {
    const child = state.nodes.get(childId);
    if (child) {
      lines.push(
        ...renderNode(
          child,
          state.nodes,
          "",
          i === root.children.length - 1,
        ),
      );
    }
  });

  lines.push("│");
  const parts: string[] = [];
  if (completed) parts.push(`\x1b[32m${completed} done\x1b[0m`);
  if (running) parts.push(`\x1b[33m${running} running\x1b[0m`);
  if (pending) parts.push(`\x1b[2m${pending} pending\x1b[0m`);
  if (errors) parts.push(`\x1b[31m${errors} failed\x1b[0m`);
  lines.push(`${parts.join(", ")}  (${total} subagents)`);

  return lines.join("\n");
}

// Track the last rendered string so we can skip no-op updates.
let lastRendered = "";

function getTerminalHeight(): number {
  return process.stdout.rows || 24;
}

/**
 * Clip the tree to terminal height, keeping the ROOT visible at the top.
 * If the tree is too tall, the bottom is cut and a truncation indicator
 * is appended. This avoids the terminal scrolling within the alt screen
 * and ensures the cursor tracking issues that plagued log-update cannot
 * recur.
 */
function clipToTerminal(tree: string): string {
  const maxRows = getTerminalHeight();
  const lines = tree.split("\n");
  if (lines.length <= maxRows) return tree;

  // Keep root + as many children as fit. Reserve 1 line for truncation indicator.
  const visible = lines.slice(0, maxRows - 1);
  visible.push(`\x1b[2m… ${lines.length - visible.length} more lines (resize terminal to see full tree)\x1b[0m`);
  return visible.join("\n");
}

export function liveRender(state: TreeState): void {
  const tree = renderTreeText(state);

  // No subagents yet — show a compact status line at the top of the alt screen
  if (!tree) {
    const root = state.rootId ? state.nodes.get(state.rootId) : null;
    if (root) {
      const statusLine = `\x1b[1m🌳 roots\x1b[0m  \x1b[2mbudget=${root.maxAgents}\x1b[0m` +
        (root.toolNames.length > 0 ? ` \x1b[2m[${root.toolNames.join(", ")}]\x1b[0m` : "") +
        ` \x1b[2m(thinking...)\x1b[0m`;
      if (statusLine !== lastRendered) {
        lastRendered = statusLine;
        redrawFrame(statusLine);
      }
    }
    return;
  }

  // Skip if unchanged
  if (tree === lastRendered) return;
  lastRendered = tree;

  const output = clipToTerminal(tree);
  redrawFrame(output);
}

export function finalRender(state: TreeState): void {
  // Exit the alternate screen — restores the original terminal buffer
  // and cursor position where the user was before roots started.
  exitAltScreen();
  lastRendered = "";

  const tree = renderTreeText(state);
  if (tree) {
    rawWrite(tree + "\n\n");
  }
}
