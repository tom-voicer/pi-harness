import type { AgentNode, TreeState, ToolCallRecord } from "./types.js";

const STATUS_ICONS: Record<string, string> = {
  pending: "⏳",
  running: "🟢",
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

function formatToolCalls(calls: ToolCallRecord[]): string {
  if (calls.length === 0) return "";
  return calls
    .map((tc) => {
      const icon = tc.success ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
      let s = `${tc.name} ${icon}`;
      if (!tc.success && tc.error) s += ` \x1b[2m(${tc.error})\x1b[0m`;
      return s;
    })
    .join(" · ");
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

  // Show tool calls if any were logged
  if (node.toolCalls.length > 0) {
    const tcLine = formatToolCalls(node.toolCalls);
    if (tcLine) {
      lines.push(
        `${prefix}${isLast ? "    " : "│   "}  \x1b[2m${tcLine}\x1b[0m`,
      );
    }
  }

  // Show brief output preview for success nodes
  if (node.status === "success" && node.output) {
    const preview = truncate(node.output, 56);
    const childConnector =
      node.children.length > 0 ? "│" : " ";
    lines.push(
      `${prefix}${isLast ? "    " : "│   "}${childConnector}  \x1b[2m${preview}\x1b[0m`,
    );
  }

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
  if (!hasSubagents(state) && root.toolCalls.length === 0) return "";

  const lines: string[] = [];
  lines.push(
    `\x1b[1m🌳 roots\x1b[0m  \x1b[2mbudget=${root.maxAgents}\x1b[0m` +
      (root.toolNames.length > 0
        ? ` \x1b[2m[${root.toolNames.join(", ")}]\x1b[0m`
        : ""),
  );

  // Root tool calls
  const rootTc = formatToolCalls(root.toolCalls);
  if (rootTc) lines.push(`  \x1b[2m${rootTc}\x1b[0m`);

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

// Track state for live rendering
let previousLineCount = 0;
let previousTreeText = "";

export function liveRender(state: TreeState): void {
  const tree = renderTreeText(state);

  // No subagents yet, show simple status line
  if (!tree) {
    if (previousLineCount > 0) {
      process.stdout.write(`\x1b[${previousLineCount}A\x1b[J`);
      previousLineCount = 0;
      previousTreeText = "";
    }
    return;
  }

  // Skip if unchanged
  if (tree === previousTreeText) return;
  previousTreeText = tree;

  const newLines = tree.split("\n").length;

  if (previousLineCount > 0) {
    process.stdout.write(`\x1b[${previousLineCount}A\x1b[J`);
  }

  process.stdout.write(tree + "\n");
  previousLineCount = newLines + 1; // +1 for newline
}

export function finalRender(state: TreeState): void {
  // Clear live render area
  if (previousLineCount > 0) {
    process.stdout.write(`\x1b[${previousLineCount}A\x1b[J`);
    previousLineCount = 0;
    previousTreeText = "";
  }

  const tree = renderTreeText(state);
  if (tree) {
    process.stdout.write(tree + "\n\n");
  }
}
