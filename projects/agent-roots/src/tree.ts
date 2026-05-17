import type { AgentNode, TreeState } from "./types.js";
import { rawWrite } from "./stdout.js";

// ── Scrollable tree viewport in alternate screen ────────────────────
//
// Uses the alternate screen buffer (like vim/htop/lazygit). Renders a
// scrollable viewport of the full tree. Keyboard (j/k/arrows/PgUp/PgDn)
// controls scroll position. Auto-follows new content at the bottom
// until the user manually scrolls away.
//
// Why this instead of the previous attempts:
//   - Manual ANSI / log-update: cursor tracking breaks when terminal
//     scrolls past the tracked position → duplication.
//   - Alternate screen without scrolling: tree clipped to terminal
//     height → can't view full tree.
//   - Append-only: forces scroll-to-bottom every 250ms → impossible
//     to read.
//
// This approach solves all three: no cursor tracking (full clear +
// redraw each frame in alt screen), no clipping (scrollable viewport),
// no forced scroll (user controls position via keyboard).

const ENTER_ALT = "\x1b[?1049h\x1b[?25l"; // alt screen + hide cursor
const EXIT_ALT = "\x1b[?25h\x1b[?1049l";  // show cursor + exit alt
const CLEAR = "\x1b[2J\x1b[H";              // clear display + home

let inAltScreen = false;
let scrollOffset = 0;
let userScrolled = false; // true once user presses a scroll key
let treeLineCount = 0;
let latestState: TreeState | null = null;

function termHeight(): number { return process.stdout.rows || 24; }

function enter(): void {
  if (inAltScreen || !process.stdout.isTTY) return;
  rawWrite(ENTER_ALT);
  inAltScreen = true;
  setupKeyboard();
}

function exit(): void {
  if (!inAltScreen) return;
  teardownKeyboard();
  rawWrite(EXIT_ALT);
  inAltScreen = false;
}

// Clean up on abnormal termination
process.on("exit", exit);
process.on("SIGINT", () => { exit(); process.exit(1); });
process.on("SIGTERM", () => { exit(); process.exit(1); });

// ── Keyboard input ──────────────────────────────────────────────────

let stdinActive = false;

function setupKeyboard(): void {
  if (stdinActive || !process.stdin.isTTY) return;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", onKey);
  stdinActive = true;
  process.stdout.on("resize", () => triggerRender());
}

function teardownKeyboard(): void {
  if (!stdinActive) return;
  process.stdin.removeListener("data", onKey);
  process.stdin.setRawMode(false);
  process.stdin.pause();
  stdinActive = false;
}

function triggerRender(): void {
  if (latestState) doLiveRender(latestState);
}

function onKey(data: Buffer): void {
  const s = data.toString();
  const th = termHeight();

  // Quit: q or Ctrl-C
  if (s === "\x03" || s === "q") { exit(); process.exit(0); return; }

  // Arrow up / k
  if (s === "\x1b[A" || s === "k") { scrollOffset--; userScrolled = true; triggerRender(); return; }
  // Arrow down / j
  if (s === "\x1b[B" || s === "j") { scrollOffset++; userScrolled = true; triggerRender(); return; }
  // Page Up (half screen)
  if (s === "\x1b[5~" || s === "\x15") { scrollOffset -= Math.floor(th / 2); userScrolled = true; triggerRender(); return; }
  // Page Down (half screen)
  if (s === "\x1b[6~" || s === "\x04") { scrollOffset += Math.floor(th / 2); userScrolled = true; triggerRender(); return; }
  // Home / gg — jump to top
  if (s === "\x1b[H" || s === "\x1b[1~") { scrollOffset = 0; userScrolled = true; triggerRender(); return; }
  // End / G — jump to bottom
  if (s === "\x1b[F" || s === "\x1b[4~" || s === "G") { scrollOffset = Infinity; userScrolled = false; triggerRender(); return; }
  // gg — double-tap g to jump to top (vim convention)
  if (s === "g") {
    if (pendingG) { scrollOffset = 0; userScrolled = true; pendingG = false; triggerRender(); return; }
    pendingG = true; setTimeout(() => { pendingG = false; }, 500); return;
  }
  pendingG = false;
  // Escape (some PgUp/PgDn sequences start with \x1b, already handled above)
}

let pendingG = false;

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
  latestState = state;
  doLiveRender(state);
}

function doLiveRender(state: TreeState): void {
  const tree = renderTreeText(state);

  // No subagents yet — show a compact one-liner in alt screen
  if (!tree) {
    const root = state.rootId ? state.nodes.get(state.rootId) : null;
    if (root) {
      const statusLine = `\x1b[1m🌳 roots\x1b[0m  \x1b[2mbudget=${root.maxAgents}\x1b[0m` +
        (root.toolNames.length > 0 ? ` \x1b[2m[${root.toolNames.join(", ")}]\x1b[0m` : "") +
        ` \x1b[2m(thinking...)\x1b[0m`;
      if (statusLine !== lastRendered) {
        lastRendered = statusLine;
        enter();
        rawWrite(CLEAR + statusLine);
      }
    }
    return;
  }

  // Skip if unchanged
  if (tree === lastRendered) return;
  lastRendered = tree;

  const lines = tree.split("\n");
  const th = termHeight();
  const newLineCount = lines.length;

  // ── Scroll management ──────────────────────────────────────────
  // Auto-follow bottom if user hasn't manually scrolled, or if they
  // were already at the bottom (so new content is visible).
  const maxOffset = Math.max(0, newLineCount - th);

  if (!userScrolled) {
    scrollOffset = maxOffset;
  } else if (scrollOffset >= maxOffset - 1) {
    // User is at/near bottom — keep them there as tree grows
    scrollOffset = maxOffset;
  }
  // Clamp to valid range
  scrollOffset = Math.max(0, Math.min(scrollOffset, maxOffset));

  // ── Build viewport ─────────────────────────────────────────────
  const visible: string[] = [];
  // Reserve up to 1 line for top indicator, 1 for bottom help bar
  const contentHeight = th - (scrollOffset > 0 ? 1 : 0) - (scrollOffset < maxOffset ? 1 : 0);

  // Top scroll indicator
  if (scrollOffset > 0) {
    visible.push(`\x1b[2m↑ ${scrollOffset} lines above\x1b[0m`);
  }

  // Visible tree slice
  const end = Math.min(scrollOffset + contentHeight, newLineCount);
  for (let i = scrollOffset; i < end; i++) {
    visible.push(lines[i]);
  }

  // Bottom help bar
  if (scrollOffset < maxOffset) {
    const below = maxOffset - scrollOffset;
    visible.push(`\x1b[2m↓ ${below} lines below  j/k scroll · PgUp/PgDn page · gg/G top/bottom · q quit\x1b[0m`);
  } else if (newLineCount > th) {
    // At bottom but tree is taller — show minimal help
    visible.push(`\x1b[2mj/k scroll · gg/G top/bottom · q quit\x1b[0m`);
  } else {
    // Tree fits entirely — show subtle help
    visible.push(`\x1b[2mtree fits · q quit\x1b[0m`);
  }

  treeLineCount = newLineCount;
  enter();
  rawWrite(CLEAR + visible.join("\n"));
}

export function finalRender(state: TreeState): void {
  exit();
  lastRendered = "";
  latestState = null;

  const tree = renderTreeText(state);
  if (tree) {
    rawWrite(tree + "\n\n");
  }
}
