/**
 * web_extract — Self-hosted web content extraction engine
 *
 * Extracts clean content from web pages:
 *   • Fetch → JSDOM + Readability → Turndown (markdown)
 *
 * No API keys required. Returns clean markdown/text from any URL.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface ExtractResult {
  url: string;
  content: string;
  title?: string;
  wordCount?: number;
}

interface ExtractFailedResult {
  url: string;
  error: string;
}

// ===========================================================================
// HTTP helpers
// ===========================================================================

async function fetchWithTimeout(
  url: string,
  opts: RequestInit & { timeout?: number } = {},
): Promise<{ resp: Response } | { error: string }> {
  const timeout = opts.timeout ?? 15_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const resp = await fetch(url, { ...opts, signal: controller.signal });
    return { resp };
  } catch (err: any) {
    return { error: err.name === "AbortError" ? `Timeout after ${timeout}ms` : err.message };
  } finally {
    clearTimeout(timer);
  }
}

// ===========================================================================
// Content extraction (fetch → Readability → Turndown)
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

async function extractUrl(
  url: string,
  timeoutMs: number = 15_000,
): Promise<ExtractResult | ExtractFailedResult> {
  await ensureExtractDeps();

  try {
    const result = await fetchWithTimeout(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; pi-web-extract/1.0)",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      timeout: timeoutMs,
      redirect: "follow",
    });

    if ("error" in result) {
      return { url, error: result.error };
    }

    const resp = result.resp;
    if (!resp.ok) {
      return { url, error: `HTTP ${resp.status} ${resp.statusText}` };
    }

    const contentType = resp.headers.get("content-type") ?? "";

    // Non-HTML content — return as plain text if small enough
    if (!contentType.includes("text/html") && !contentType.includes("text/plain")) {
      const text = await resp.text();
      if (text.length > 500_000) {
        return { url, error: "Content too large (binary or >500KB)" };
      }
      return {
        url,
        content: text.slice(0, 100_000),
        title: new URL(url).hostname,
        wordCount: text.split(/\s+/).length,
      };
    }

    const html = await resp.text();
    const doc = new _jsdom(html, { url }).window.document;

    // Try Readability extraction
    let readableArticle: any = null;
    try {
      const reader = new _readability(doc);
      readableArticle = reader.parse();
    } catch {
      // Readability can throw on some malformed documents
    }

    if (readableArticle?.textContent && readableArticle.textContent.length > 100) {
      const article = readableArticle;

      // Convert HTML content to markdown
      let markdown: string;
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

      return {
        url,
        content: markdown.slice(0, 50_000),
        title: article.title ?? doc.title ?? new URL(url).hostname,
        wordCount: article.textContent.split(/\s+/).length,
      };
    }

    // Readability failed — fall back to body text
    const bodyText = doc.body?.textContent?.replace(/\s+/g, " ").trim() ?? "";
    return {
      url,
      content: bodyText.slice(0, 25_000),
      title: doc.title ?? new URL(url).hostname,
      wordCount: bodyText.split(/\s+/).length,
    };
  } catch (err: any) {
    return { url, error: err.message ?? String(err) };
  }
}

// ===========================================================================
// Extension
// ===========================================================================

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_extract",
    label: "Web Extract",
    description:
      "Extract clean, raw content from one or more web page URLs using local extraction (Readability + Turndown). Returns the page content in markdown or plain text. Useful for fetching full documentation pages, articles, or any web content the LLM needs to read in detail.",
    promptSnippet:
      "Extract clean content from URLs via local extraction — returns raw markdown/text",
    promptGuidelines: [
      "Use web_extract to pull the full content of a web page from a URL when you need detailed information.",
      "Use web_extract after web_search returns promising URLs that need deeper reading.",
      "When extracting from multiple URLs, batch them into a single web_extract call (up to 20 URLs).",
      "Always cite extracted sources with their URLs.",
    ],
    parameters: Type.Object({
      urls: Type.Union([
        Type.String({ description: "A single URL to extract content from" }),
        Type.Array(Type.String(), {
          description: "A list of URLs to extract content from (max 20)",
        }),
      ]),
      query: Type.Optional(
        Type.String({
          description:
            "User intent for reranking extracted content chunks. (Not supported — ignored.)",
        }),
      ),
      chunks_per_source: Type.Optional(
        Type.Number({
          description: "Maximum number of relevant chunks per source (not supported — ignored).",
        }),
      ),
      extract_depth: Type.Optional(
        Type.String({
          description:
            "Extraction depth: 'basic' (faster) or 'advanced' (Readability + markdown). Default: basic",
        }),
      ),
      include_images: Type.Optional(
        Type.Boolean({
          description: "Include a list of image URLs extracted from the page. Default: false",
        }),
      ),
      include_favicon: Type.Optional(
        Type.Boolean({
          description: "Include the favicon URL for each result. Default: false",
        }),
      ),
      format: Type.Optional(
        Type.String({
          description: "Format: 'markdown' or 'text'. Default: markdown",
        }),
      ),
      timeout: Type.Optional(
        Type.Number({
          description: "Maximum time in seconds to wait for each URL (1-60). Default: 15s.",
          minimum: 1,
          maximum: 60,
        }),
      ),
      include_usage: Type.Optional(
        Type.Boolean({
          description: "Include credit usage info. Default: false",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const urlArray: string[] = Array.isArray(params.urls)
        ? (params.urls as string[]).slice(0, 20)
        : [params.urls as string];
      const timeoutMs = (params.timeout ?? 15) * 1000;

      const startTime = Date.now();

      // Extract all URLs in parallel
      const results = await Promise.all(
        urlArray.map((url) => extractUrl(url, timeoutMs)),
      );

      const responseTime = (Date.now() - startTime) / 1000;
      const successes = results.filter(
        (r): r is ExtractResult => "content" in r,
      );
      const failures = results.filter(
        (r): r is ExtractFailedResult => "error" in r,
      );

      let output =
        `**Web Extraction results** ` +
        `(${successes.length}/${urlArray.length} URLs extracted, ${responseTime.toFixed(2)}s):\n\n`;

      for (const result of successes) {
        output += `### [${result.title ?? result.url}](${result.url})\n`;
        output += `*${result.wordCount?.toLocaleString() ?? "?"} words*\n\n`;

        const maxLen = 30_000;
        const content =
          result.content.length > maxLen
            ? result.content.slice(0, maxLen) +
              `\n\n[...truncated ${result.content.length - maxLen} chars...]`
            : result.content;
        output += content + "\n\n---\n\n";
      }

      if (failures.length > 0) {
        output += "\n**Failed extractions:**\n";
        for (const fail of failures) {
          output += `- [${fail.url}](${fail.url}): ${fail.error}\n`;
        }
        output += "\n";
      }

      return {
        content: [{ type: "text", text: output }],
        details: {
          extractedCount: successes.length,
          failedCount: failures.length,
          responseTime,
        },
      };
    },
  });
}
