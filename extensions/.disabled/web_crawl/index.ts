/**
 * web_crawl — Website crawler and content extractor
 *
 * Crawls a website starting from a given URL, follows same-domain links
 * within a path prefix, extracts clean content via Readability + Turndown,
 * and saves each page as a markdown file.
 *
 * No API keys required. Uses the same extraction pipeline as web_extract.
 *
 * Output:
 *   ./crawl-output/{hostname}/
 *     ├── index.md              — index of all crawled pages
 *     ├── path/to/page.md       — individual page content
 *     └── ...
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CrawlEntry {
  url: string;
  filePath: string;
  title: string;
  wordCount: number;
  depth: number;
}

interface CrawlError {
  url: string;
  error: string;
  depth: number;
}

interface QueueItem {
  url: string;
  depth: number;
}

// ===========================================================================
// HTTP helpers
// ===========================================================================

async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ resp: Response } | { error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // Link external signal so either timeout or external abort stops the request
  if (signal) {
    if (signal.aborted) {
      clearTimeout(timer);
      return { error: "Aborted" };
    }
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  try {
    const resp = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; pi-web-crawl/1.0)",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    return { resp };
  } catch (err: any) {
    if (err.name === "AbortError") {
      return { error: signal?.aborted ? "Aborted" : `Timeout after ${timeoutMs}ms` };
    }
    return { error: err.message ?? String(err) };
  } finally {
    clearTimeout(timer);
  }
}

// ===========================================================================
// Content extraction (fetch → JSDOM → Readability → Turndown)
// ===========================================================================

let _readability: any = null;
let _turndownService: any = null;
let _jsdom: any = null;

async function ensureExtractDeps() {
  if (!_readability) {
    const { Readability } = await import("@mozilla/readability");
    _readability = Readability;
  }
  if (!_turndownService) {
    const TurndownService = (await import("turndown")).default;
    _turndownService = new TurndownService({
      headingStyle: "atx",
      codeBlockStyle: "fenced",
      emDelimiter: "*",
    });
  }
  if (!_jsdom) {
    const { JSDOM } = await import("jsdom");
    _jsdom = JSDOM;
  }
}

interface PageResult {
  title: string;
  markdown: string;
  wordCount: number;
  links: string[];
}

async function extractPage(
  url: string,
  html: string,
): Promise<PageResult> {
  await ensureExtractDeps();

  const doc = new _jsdom(html, { url }).window.document;

  // ---- Extract links from raw HTML (before Readability strips nav) ----
  const links: string[] = [];
  const anchors = doc.querySelectorAll("a[href]");
  for (const a of anchors) {
    const href = a.getAttribute("href");
    if (href) links.push(href);
  }

  // ---- Extract article content via Readability ----
  let title = doc.title ?? new URL(url).hostname;
  let markdown = "";

  try {
    const reader = new _readability(doc);
    const article = reader.parse();

    if (article?.textContent && article.textContent.length > 100) {
      title = article.title ?? title;
      const wordCount = article.textContent.split(/\s+/).length;

      if (article.content && article.content.includes("<")) {
        try {
          const tmpDoc = new _jsdom(
            `<html><body>${article.content}</body></html>`,
          ).window.document;
          markdown = _turndownService.turndown(tmpDoc.body);
        } catch {
          markdown = article.textContent;
        }
      } else {
        markdown = article.textContent;
      }

      return { title, markdown, wordCount, links };
    }
  } catch {
    // Readability threw — fall back to body text
  }

  // ---- Fallback: use body text ----
  const bodyText = doc.body?.textContent?.replace(/\s+/g, " ").trim() ?? "";
  return {
    title,
    markdown: bodyText.slice(0, 25_000),
    wordCount: bodyText.split(/\s+/).length,
    links,
  };
}

// ===========================================================================
// URL utilities
// ===========================================================================

function normalizeUrl(url: string, baseUrl: string): string | null {
  // Resolve relative URLs
  let resolved: URL;
  try {
    resolved = new URL(url, baseUrl);
  } catch {
    return null;
  }

  // Only http/https
  if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
    return null;
  }

  // Remove fragment
  resolved.hash = "";

  // Remove query string for dedup (most doc sites don't use meaningful query params)
  resolved.search = "";

  // Normalize path: strip trailing slash (except root "/")
  if (resolved.pathname.length > 1 && resolved.pathname.endsWith("/")) {
    resolved.pathname = resolved.pathname.slice(0, -1);
  }

  return resolved.href;
}

function urlMatchesPrefix(url: string, prefix: string): boolean {
  const { pathname } = new URL(url);
  const cleanPath = pathname.replace(/\/+$/, "") || "/";
  const cleanPrefix = prefix.replace(/\/+$/, "") || "/";

  if (cleanPrefix === "/") return true;
  return cleanPath === cleanPrefix || cleanPath.startsWith(cleanPrefix + "/");
}

function urlToFilePath(urlStr: string, outputDir: string): string {
  const url = new URL(urlStr);
  const hostname = url.hostname;
  let filePath = url.pathname;

  // Remove trailing slash
  if (filePath.length > 1 && filePath.endsWith("/")) {
    filePath = filePath.slice(0, -1);
  }

  // Root → index
  if (filePath === "" || filePath === "/") {
    filePath = "/index";
  }

  // Remove leading slash
  filePath = filePath.replace(/^\//, "");

  // Sanitize path segments
  const segments = filePath.split("/").map((seg) => {
    // Replace characters unsafe for filenames
    return seg.replace(/[<>:"|?*\\]/g, "_").slice(0, 200);
  });

  // Append .md extension
  const fileName = segments.pop()!;
  segments.push(fileName + ".md");

  return path.join(outputDir, hostname, ...segments);
}

// ===========================================================================
// Crawl engine
// ===========================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function crawl(
  startUrl: string,
  opts: {
    maxDepth: number;
    pathPrefix: string;
    outputDir: string;
    maxPages: number;
    concurrency: number;
    delayMs: number;
    timeoutMs: number;
    signal?: AbortSignal;
    onUpdate?: (update: any) => void;
  },
): Promise<{ entries: CrawlEntry[]; errors: CrawlError[]; startTime: number }> {
  const startTime = Date.now();
  const startHostname = new URL(startUrl).hostname;
  const visited = new Set<string>();
  const entries: CrawlEntry[] = [];
  const errors: CrawlError[] = [];

  // Seed the queue
  const queue: QueueItem[] = [{ url: startUrl, depth: 0 }];
  visited.add(startUrl);

  let batchNum = 0;

  while (queue.length > 0) {
    // Check for abort
    if (opts.signal?.aborted) {
      errors.push({ url: "—", error: "Aborted by user", depth: -1 });
      break;
    }

    // Check page limit
    if (entries.length >= opts.maxPages) {
      break;
    }

    // Take next chunk
    const chunk = queue.splice(0, opts.concurrency);
    batchNum++;

    // Fetch chunk in parallel
    const chunkResults = await Promise.allSettled(
      chunk.map(async (item) => {
        // Check depth
        if (item.depth > opts.maxDepth) return null;

        // Fetch
        const fetchResult = await fetchWithTimeout(
          item.url,
          opts.timeoutMs,
          opts.signal,
        );
        if ("error" in fetchResult) {
          errors.push({ url: item.url, error: fetchResult.error, depth: item.depth });
          return null;
        }

        const resp = fetchResult.resp;

        // Check content type — only process HTML
        const contentType = resp.headers.get("content-type") ?? "";
        if (!contentType.includes("text/html") && !contentType.includes("text/plain")) {
          // Skip non-HTML pages silently (PDFs, images, etc.)
          return null;
        }

        if (!resp.ok) {
          errors.push({
            url: item.url,
            error: `HTTP ${resp.status} ${resp.statusText}`,
            depth: item.depth,
          });
          return null;
        }

        // Read HTML
        const html = await resp.text();

        // Extract content and links
        const page = await extractPage(item.url, html);

        // Resolve and filter links
        const newUrls: string[] = [];
        for (const rawHref of page.links) {
          const normalized = normalizeUrl(rawHref, item.url);
          if (!normalized) continue;

          // Same domain check
          const linkHostname = new URL(normalized).hostname;
          if (linkHostname !== startHostname) continue;

          // Path prefix check
          if (!urlMatchesPrefix(normalized, opts.pathPrefix)) continue;

          // Already visited?
          if (visited.has(normalized)) continue;

          newUrls.push(normalized);
        }

        // Generate file path and save
        const filePath = urlToFilePath(item.url, opts.outputDir);
        const dir = path.dirname(filePath);
        fs.mkdirSync(dir, { recursive: true });

        const fileContent =
          `# ${page.title}\n\n` +
          `> Source: [${item.url}](${item.url})\n\n` +
          page.markdown;

        fs.writeFileSync(filePath, fileContent, "utf-8");

        const entry: CrawlEntry = {
          url: item.url,
          filePath,
          title: page.title,
          wordCount: page.wordCount,
          depth: item.depth,
        };

        return { entry, newUrls };
      }),
    );

    // Process chunk results — deduplicate across the batch
    let newQueueItems = 0;
    const batchSeen = new Set<string>();
    for (const result of chunkResults) {
      if (result.status !== "fulfilled" || !result.value) continue;
      const { entry, newUrls } = result.value;

      entries.push(entry);

      // Add new URLs to queue and visited set (skip duplicates within this batch)
      for (const newUrl of newUrls) {
        if (visited.has(newUrl) || batchSeen.has(newUrl)) continue;
        if (visited.size >= opts.maxPages) break;
        batchSeen.add(newUrl);
        visited.add(newUrl);
        queue.push({ url: newUrl, depth: entry.depth + 1 });
        newQueueItems++;
      }
    }

    // Report progress
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    opts.onUpdate?.({
      content: [
        {
          type: "text" as const,
          text:
            `**Crawling batch ${batchNum}** — ` +
            `${entries.length} pages saved, ` +
            `${queue.length} queued ` +
            `(${newQueueItems} new), ` +
            `${errors.length} errors ` +
            `(${elapsed}s)`,
        },
      ],
    });

    // Rate limiting between batches
    if (queue.length > 0 && opts.delayMs > 0) {
      await sleep(opts.delayMs);
    }
  }

  // Check page limit exceeded
  if (entries.length >= opts.maxPages && queue.length > 0) {
    errors.push({
      url: "—",
      error: `Reached max_pages limit (${opts.maxPages}). ${queue.length} URLs left in queue.`,
      depth: -1,
    });
  }

  return { entries, errors, startTime };
}

// ===========================================================================
// Extension
// ===========================================================================

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_crawl",
    label: "Web Crawl",
    description:
      "Crawl a website starting from a URL, follow same-domain links within a path prefix, extract each page to a clean markdown file using Readability + Turndown. Saves files locally and returns an index. Useful for downloading documentation sites, blogs, or any structured website for offline reference.",
    promptSnippet:
      "Crawl a website — extracts every page to local markdown files, returns an index",
    promptGuidelines: [
      "Use web_crawl when the user wants to download or mirror documentation from a website.",
      "Use web_crawl to extract content from an entire documentation site in one shot.",
      "After crawling, use read to examine individual markdown files or the index.md.",
      "Start with low depth (2-3) and increase if the crawl was incomplete.",
    ],
    parameters: Type.Object({
      start_url: Type.String({
        description:
          "Starting URL to crawl from. The crawler will follow links on the same domain.",
      }),
      depth: Type.Optional(
        Type.Number({
          description:
            "Maximum crawl depth — how many links away from the start URL. Default: 4. Max: 10.",
          minimum: 1,
          maximum: 10,
        }),
      ),
      path_prefix: Type.Optional(
        Type.String({
          description:
            "Only crawl URLs whose path starts with this prefix. " +
            "Default: auto-detected from the directory of start_url " +
            "(e.g., /docs/intro → prefix /docs). Set to '/' to crawl the entire domain.",
        }),
      ),
      output_dir: Type.Optional(
        Type.String({
          description:
            "Directory to save crawled markdown files. Default: ./crawl-output",
        }),
      ),
      max_pages: Type.Optional(
        Type.Number({
          description:
            "Maximum total pages to crawl before stopping. Default: 200.",
          minimum: 1,
          maximum: 2000,
        }),
      ),
      concurrency: Type.Optional(
        Type.Number({
          description:
            "Number of simultaneous page fetches. Default: 3. Max: 5.",
          minimum: 1,
          maximum: 5,
        }),
      ),
      delay_ms: Type.Optional(
        Type.Number({
          description:
            "Delay in milliseconds between batches of requests. Default: 300.",
          minimum: 0,
          maximum: 5000,
        }),
      ),
      timeout_sec: Type.Optional(
        Type.Number({
          description:
            "Maximum time in seconds to wait for each page request. Default: 15.",
          minimum: 1,
          maximum: 60,
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate) {
      const startUrl = params.start_url;

      // Validate and normalize URL
      let parsedStart: URL;
      try {
        parsedStart = new URL(startUrl);
      } catch {
        return {
          content: [
            {
              type: "text" as const,
              text: `**Error:** Invalid URL: \`${startUrl}\``,
            },
          ],
        };
      }

      if (parsedStart.protocol !== "http:" && parsedStart.protocol !== "https:") {
        return {
          content: [
            {
              type: "text" as const,
              text: `**Error:** Only http/https URLs are supported: \`${startUrl}\``,
            },
          ],
        };
      }

      // Normalize the start URL (strip fragment, trailing slash, etc.)
      const normalizedStart = normalizeUrl(startUrl, startUrl) ?? startUrl;

      const maxDepth = params.depth ?? 4;
      const outputDir = params.output_dir ?? "./crawl-output";
      const maxPages = params.max_pages ?? 200;
      const concurrency = params.concurrency ?? 3;
      const delayMs = params.delay_ms ?? 300;
      const timeoutMs = (params.timeout_sec ?? 15) * 1000;

      // Auto-detect path prefix: use the parent directory of the start URL.
      // - /docs/intro     → /docs
      // - /docs/api/auth  → /docs/api
      // - /docs           → /docs (parent would be /, so keep /docs)
      const defaultPrefix = (() => {
        const p = new URL(normalizedStart).pathname.replace(/\/+$/, "") || "/";
        const lastSlash = p.lastIndexOf("/");
        if (lastSlash <= 0) return p; // root or top-level page
        const parent = p.substring(0, lastSlash);
        return parent || "/";
      })();
      const pathPrefix = params.path_prefix ?? defaultPrefix;

      // Create output directory
      const hostname = parsedStart.hostname;
      const baseDir = path.join(outputDir, hostname);
      fs.mkdirSync(baseDir, { recursive: true });

      // Report start
      onUpdate?.({
        content: [
          {
            type: "text" as const,
            text:
              `**Crawl started**\n` +
              `- Start URL: ${startUrl}\n` +
              `- Path prefix: \`${pathPrefix}\`\n` +
              `- Max depth: ${maxDepth}\n` +
              `- Output: \`${baseDir}\`\n`,
          },
        ],
      });

      // Run crawl (use normalized start URL)
      const { entries, errors, startTime } = await crawl(normalizedStart, {
        maxDepth,
        pathPrefix,
        outputDir,
        maxPages,
        concurrency,
        delayMs,
        timeoutMs,
        signal,
        onUpdate,
      });

      const responseTime = ((Date.now() - startTime) / 1000).toFixed(1);
      const totalWords = entries.reduce((sum, e) => sum + e.wordCount, 0);

      // ---- Build index file ----
      let indexContent = `# Crawl Index: ${startUrl}\n\n`;
      indexContent += `- **Date:** ${new Date().toISOString()}\n`;
      indexContent += `- **Pages:** ${entries.length}\n`;
      indexContent += `- **Depth:** ${maxDepth}\n`;
      indexContent += `- **Path prefix:** \`${pathPrefix}\`\n`;
      indexContent += `- **Total words:** ${totalWords.toLocaleString()}\n`;
      indexContent += `- **Duration:** ${responseTime}s\n`;
      indexContent += `- **Errors:** ${errors.length}\n\n`;

      if (entries.length === 0) {
        indexContent += `*No pages were crawled.*\n`;
      } else {
        indexContent += `## Pages by depth\n\n`;
        const byDepth = new Map<number, CrawlEntry[]>();
        for (const e of entries) {
          const list = byDepth.get(e.depth) ?? [];
          list.push(e);
          byDepth.set(e.depth, list);
        }
        for (const [depth, pages] of [...byDepth.entries()].sort(
          (a, b) => a[0] - b[0],
        )) {
          indexContent += `### Depth ${depth} (${pages.length} pages)\n\n`;
          for (const p of pages) {
            const relPath = path.relative(outputDir, p.filePath);
            indexContent += `- [${p.title}](${relPath}) — *${p.wordCount.toLocaleString()} words* — <${p.url}>\n`;
          }
          indexContent += "\n";
        }
      }

      if (errors.length > 0) {
        indexContent += `## Errors\n\n`;
        for (const err of errors) {
          indexContent += `- [${err.url}](${err.url}) (depth ${err.depth}): ${err.error}\n`;
        }
        indexContent += "\n";
      }

      const indexPath = path.join(baseDir, "index.md");
      fs.writeFileSync(indexPath, indexContent, "utf-8");

      // ---- Build summary for LLM ----
      let summary = "";
      summary += `## Crawl complete: \`${startUrl}\`\n\n`;
      summary += `| Metric | Value |\n|---|---|\n`;
      summary += `| Pages crawled | ${entries.length} |\n`;
      summary += `| Max depth | ${maxDepth} |\n`;
      summary += `| Total words | ${totalWords.toLocaleString()} |\n`;
      summary += `| Duration | ${responseTime}s |\n`;
      summary += `| Output directory | \`${baseDir}/\` |\n`;
      summary += `| Index file | \`${path.relative(".", indexPath)}\` |\n`;
      if (errors.length > 0) {
        summary += `| Errors | ${errors.length} |\n`;
      }
      summary += "\n";

      // List all pages
      summary += `### Crawled pages (${entries.length})\n\n`;
      summary += `| # | Title | Depth | Words | File |\n`;
      summary += `|---|-------|-------|-------|------|\n`;
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        const relPath = path.relative(".", e.filePath);
        summary += `| ${i + 1} | ${e.title.slice(0, 50)} | ${e.depth} | ${e.wordCount.toLocaleString()} | \`${relPath}\` |\n`;
      }
      summary += "\n";

      // Errors summary
      if (errors.length > 0) {
        summary += `### Errors (${errors.length})\n\n`;
        for (const err of errors.slice(0, 10)) {
          summary += `- [${err.url}](${err.url}): ${err.error}\n`;
        }
        if (errors.length > 10) {
          summary += `- ...and ${errors.length - 10} more (see index.md)\n`;
        }
        summary += "\n";
      }

      summary += `---\n`;
      summary += `**Next steps:** Read \`${path.relative(".", indexPath)}\` for full index, or individual \`.md\` files for page content.`;

      return {
        content: [{ type: "text" as const, text: summary }],
        details: {
          startUrl,
          pathPrefix,
          maxDepth,
          pagesCrawled: entries.length,
          totalWords,
          errors: errors.length,
          outputDir: path.relative(".", baseDir),
          responseTime: parseFloat(responseTime),
        },
      };
    },
  });
}
