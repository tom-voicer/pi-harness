/**
 * /commit — Summarize git changes, commit, and push.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("commit", {
    description: "Summarize git changes, commit, and push",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();

      // Check if we're in a git repo
      const revParse = await pi.exec("git", ["rev-parse", "--show-toplevel"], { timeout: 5000 });
      if (revParse.code !== 0) {
        ctx.ui.notify("Not in a git repository.", "error");
        return;
      }

      // Check for changes
      const status = await pi.exec("git", ["status", "--porcelain"], { timeout: 5000 });
      if (!status.stdout.trim()) {
        ctx.ui.notify("Nothing to commit — working tree clean.", "info");
        return;
      }

      // Gather context: diff stat, status, and recent commit history
      const diffStat = await pi.exec("git", ["diff", "--stat", "--cached"], { timeout: 10000 });
      const diffCached = await pi.exec("git", ["diff", "--cached"], { timeout: 10000 });
      const diffUnstaged = await pi.exec("git", ["diff", "--stat"], { timeout: 10000 });
      const log = await pi.exec("git", ["log", "--oneline", "-5"], { timeout: 5000 });

      const pendingStatus = status.stdout.trim();
      const stagedStat = diffStat.stdout.trim();
      const unstagedStat = diffUnstaged.stdout.trim();
      const recentLog = log.stdout.trim();
      const stagedDiff = diffCached.stdout.trim();

      // Truncate large diffs to avoid overwhelming context
      const maxDiffLen = 8000;
      const stagedDiffSnippet =
        stagedDiff.length > maxDiffLen
          ? stagedDiff.slice(0, maxDiffLen) + "\n... (diff truncated)"
          : stagedDiff;

      // Build the prompt for pi
      const prompt = [
        "## /commit — Summarize, commit, and push",
        "",
        "**Pending changes (git status --porcelain):**",
        "```",
        pendingStatus,
        "```",
        "",
      ];

      if (stagedStat) {
        prompt.push("**Staged changes (git diff --stat --cached):**", "```", stagedStat, "```", "");
      }
      if (unstagedStat) {
        prompt.push("**Unstaged changes (git diff --stat):**", "```", unstagedStat, "```", "");
      }
      if (stagedDiffSnippet) {
        prompt.push("**Staged diff (git diff --cached):**", "```diff", stagedDiffSnippet, "```", "");
      }

      prompt.push(
        "**Recent commits:**",
        "```",
        recentLog || "(no commits)",
        "```",
        "",
        "## Instructions",
        "",
        "1. Review the changes above.",
        "2. Write a concise, conventional commit message (e.g., `feat(scope): description` or `fix: description`). Keep the subject line under 72 chars.",
        "3. If there are unstaged changes, stage them first: `git add -A`",
        "4. Commit: `git commit -m \"...\"` (use a multi-line message with body if needed, via `git commit -m \"subject\" -m \"body\"`)",
        "5. Push: `git push`",
        "",
        "Execute all steps. Do NOT ask for confirmation — just do it.",
      );

      pi.sendUserMessage(prompt.join("\n"));
    },
  });
}
