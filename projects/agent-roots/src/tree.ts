import type { AgentNode, TreeState } from "./types.js";
import { rawWrite } from "./stdout.js";

// ── Append-only tree rendering ───────────────────────────────────────
//
// Design: each frame is written as a new snapshot. The terminal scrolls
// naturally. The user can scroll up at any time to see the full tree —
// no "update in place" that would reset their scroll position.
//
// Why append instead of "update in place":
//   - "Update in place" (clear + redraw) inherently resets the user's
//     scroll position. Alternate screen, log-update, manual ANSI —
//     they all fight the terminal's natural scrolling behavior.
//   - Append works WITH the terminal: each tree snapshot is logged.
//     The terminal scrolls to the latest frame. User scrolls up for
//     history or to see parts of the tree that scrolled off.
//
// Why "update in place" approaches all broke:
//   - Manual \x1b[H\x1b[J: absolute cursor positioning fails when the
//     terminal scrolls past the home position.
//   - log-update: tracks cursor with line counts, but line counts
//     become wrong after terminal scrolls.
//   - Alternate screen: no scrollback = no scrolling at all.
//
// Append has none of these problems. No cursor tracking, no ANSI
// manipulation, no line counting. Just write the tree and let the
// terminal do what it does best.

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

export function liveRender(state: TreeState): void {
  const tree = renderTreeText(state);

  // No subagents yet — show a compact one-liner
  if (!tree) {
    const root = state.rootId ? state.nodes.get(state.rootId) : null;
    if (root) {
      const statusLine = `\x1b[1m🌳 roots\x1b[0m  \x1b[2mbudget=${root.maxAgents}\x1b[0m` +
        (root.toolNames.length > 0 ? ` \x1b[2m[${root.toolNames.join(", ")}]\x1b[0m` : "") +
        ` \x1b[2m(thinking...)\x1b[0m`;
      if (statusLine !== lastRendered) {
        lastRendered = statusLine;
        rawWrite(statusLine + "\n");
      }
    }
    return;
  }

  // Skip if unchanged
  if (tree === lastRendered) return;
  lastRendered = tree;

  // Append the new frame. Terminal scrolls to show it. User can scroll
  // up through the scrollback to see the full tree at any point.
  rawWrite(tree + "\n");
}

export function finalRender(state: TreeState): void {
  lastRendered = "";

  const tree = renderTreeText(state);
  if (tree) {
    rawWrite(tree + "\n\n");
  }
}
