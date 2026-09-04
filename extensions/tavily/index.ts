/**
 * Tavily-powered web tools for pi
 *
 * Replaces the self-hosted web_search, web_extract, and web_crawl extensions
 * with Tavily's API — real-time web search, clean content extraction, and
 * agent-first intelligent crawling.
 *
 * API key: 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
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const TAVILY_API_KEY = "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";

// ---------------------------------------------------------------------------
// Lazy Tavily client
// ---------------------------------------------------------------------------

let _tvly: any = null;

async function getTavily(): Promise<any> {
  if (!_tvly) {
    const { tavily } = await import("@tavily/core");
    _tvly = tavily({ apiKey: TAVILY_API_KEY });
  }
  return _tvly;
}

// ===========================================================================
// web_search — Tavily Search
// ===========================================================================

function registerWebSearch(pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Web search via Tavily — real-time web search optimized for AI agents. Returns results with titles, URLs, content snippets, and scores.",
    promptSnippet: "Web search via Tavily — returns titles, URLs, and content",
    promptGuidelines: [
      "Use web_search when you need current, up-to-date information from the web.",
      "Use web_search when the user asks about recent events, news, or documentation that may have changed.",
      "Always cite sources from web_search results with URLs.",
      "Prefer search_depth='advanced' for thorough results, 'basic' for speed.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search query string" }),
      search_depth: Type.Optional(
        Type.String({
          description:
            "Search depth: 'basic' (faster), 'advanced' (more thorough), 'fast', or 'ultra-fast'. Default: basic",
        }),
      ),
      max_results: Type.Optional(
        Type.Number({
          description: "Maximum number of results to return (1-20). Default: 5",
        }),
      ),
      include_answer: Type.Optional(
        Type.Boolean({
          description:
            "Include an AI-generated answer summary. Default: false",
        }),
      ),
      include_raw_content: Type.Optional(
        Type.Boolean({
          description:
            "Include raw page content as markdown. Default: false",
        }),
      ),
      include_domains: Type.Optional(
        Type.Array(Type.String(), {
          description: "Only include results from these domains",
        }),
      ),
      exclude_domains: Type.Optional(
        Type.Array(Type.String(), {
          description: "Exclude results from these domains",
        }),
      ),
      topic: Type.Optional(
        Type.String({
          description: "Topic: 'general', 'news', or 'finance'. Default: general",
        }),
      ),
      days: Type.Optional(
        Type.Number({
          description: "Only include results from the last N days",
        }),
      ),
      time_range: Type.Optional(
        Type.String({
          description: "Time range: 'year', 'month', 'week', 'day'",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const client = await getTavily();

      const options: Record<string, any> = {
        searchDepth: params.search_depth ?? "basic",
        maxResults: params.max_results ?? 5,
        includeAnswer: params.include_answer ?? false,
        includeRawContent: params.include_raw_content ? "markdown" : false,
      };

      if (params.include_domains) options.includeDomains = params.include_domains;
      if (params.exclude_domains) options.excludeDomains = params.exclude_domains;
      if (params.topic) options.topic = params.topic;
      if (params.days) options.days = params.days;
      if (params.time_range) options.timeRange = params.time_range;

      const response = await client.search(params.query, options);

      if (!response.results || response.results.length === 0) {
        let msg = `**Web search for "${params.query}"** — No results found.`;
        if (response.answer) {
          msg += `\n\n**Answer:** ${response.answer}`;
        }
        return {
          content: [{ type: "text", text: msg }],
          details: { query: params.query, resultCount: 0, responseTime: response.responseTime },
        };
      }

      let output = `**Search results for "${params.query}"** `;
      output += `(${response.results.length} results, ${response.responseTime.toFixed(2)}s)\n\n`;

      if (response.answer) {
        output += `> **Answer:** ${response.answer}\n\n`;
      }

      for (const r of response.results) {
        const dateStr = r.publishedDate ? ` — *${r.publishedDate}*` : "";
        output += `### [${r.title}](${r.url})${dateStr}\n`;
        output += `${r.content}\n`;
        if (r.rawContent) {
          output += `\n<details><summary>Raw content</summary>\n\n${r.rawContent.slice(0, 3000)}\n\n</details>\n`;
        }
        output += "\n---\n\n";
      }

      if (response.usage) {
        output += `\n*Credits used: ${response.usage.credits}*\n`;
      }

      return {
        content: [{ type: "text", text: output }],
        details: {
          query: params.query,
          resultCount: response.results.length,
          responseTime: response.responseTime,
          credits: response.usage?.credits,
        },
      };
    },
  });
}

// ===========================================================================
// web_extract — Tavily Extract
// ===========================================================================

function registerWebExtract(pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_extract",
    label: "Web Extract",
    description:
      "Extract clean, raw content from one or more web page URLs using Tavily Extract. Returns markdown or text. Useful for fetching full documentation pages, articles, or any web content in detail.",
    promptSnippet:
      "Extract clean content from URLs via Tavily Extract — returns raw markdown/text",
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
      extract_depth: Type.Optional(
        Type.String({
          description:
            "Extraction depth: 'basic' (faster) or 'advanced' (Readability + markdown). Default: basic",
        }),
      ),
      format: Type.Optional(
        Type.String({
          description: "Format: 'markdown' or 'text'. Default: markdown",
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
      query: Type.Optional(
        Type.String({
          description: "User intent for reranking extracted content chunks.",
        }),
      ),
      chunks_per_source: Type.Optional(
        Type.Number({
          description: "Maximum number of relevant chunks per source. Default: all",
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
      const client = await getTavily();
      const urlArray: string[] = Array.isArray(params.urls)
        ? (params.urls as string[]).slice(0, 20)
        : [params.urls as string];

      const options: Record<string, any> = {
        extractDepth: params.extract_depth ?? "basic",
        format: params.format ?? "markdown",
        includeImages: params.include_images ?? false,
        includeFavicon: params.include_favicon ?? false,
      };

      if (params.query) options.query = params.query;
      if (params.chunks_per_source) options.chunksPerSource = params.chunks_per_source;
      if (params.timeout) options.timeout = params.timeout;
      if (params.include_usage) options.includeUsage = true;

      const response = await client.extract(urlArray, options);
      const successes = response.results ?? [];
      const failures = response.failedResults ?? [];

      let output = `**Web Extraction results** `;
      output += `(${successes.length}/${urlArray.length} URLs extracted, ${response.responseTime.toFixed(2)}s):\n\n`;

      for (const result of successes) {
        output += `### [${result.title ?? result.url}](${result.url})\n\n`;

        const maxLen = 30_000;
        const content =
          result.rawContent.length > maxLen
            ? result.rawContent.slice(0, maxLen) +
              `\n\n[...truncated ${result.rawContent.length - maxLen} chars...]`
            : result.rawContent;
        output += content + "\n\n---\n\n";
      }

      if (failures.length > 0) {
        output += "\n**Failed extractions:**\n";
        for (const fail of failures) {
          output += `- [${fail.url}](${fail.url}): ${fail.error}\n`;
        }
        output += "\n";
      }

      if (response.usage) {
        output += `\n*Credits used: ${response.usage.credits}*\n`;
      }

      return {
        content: [{ type: "text", text: output }],
        details: {
          extractedCount: successes.length,
          failedCount: failures.length,
          responseTime: response.responseTime,
          credits: response.usage?.credits,
        },
      };
    },
  });
}

// ===========================================================================
// web_crawl — Tavily Crawl
// ===========================================================================

function registerWebCrawl(pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_crawl",
    label: "Web Crawl",
    description:
      "Crawl a website using Tavily's agent-first intelligent crawler. Discovers and extracts content from multiple pages on a site. Use this for downloading documentation or exploring a website's content.",
    promptSnippet:
      "Crawl a website via Tavily — intelligent discovery and extraction, returns clean content",
    promptGuidelines: [
      "Use web_crawl when the user wants to download or mirror documentation from a website.",
      "Use web_crawl to extract content from an entire documentation site in one shot.",
      "Provide clear instructions to focus the crawl on relevant content.",
      "Start with low depth (2-3) and increase if the crawl was incomplete.",
    ],
    parameters: Type.Object({
      start_url: Type.String({
        description: "Starting URL to crawl from.",
      }),
      instructions: Type.Optional(
        Type.String({
          description:
            "Natural-language instructions for what content to find and extract. E.g., 'Find all pages about the Python SDK' or 'Extract API reference documentation only'.",
        }),
      ),
      max_depth: Type.Optional(
        Type.Number({
          description: "Maximum crawl depth. Default: 4. Max: 10.",
          minimum: 1,
          maximum: 10,
        }),
      ),
      max_pages: Type.Optional(
        Type.Number({
          description: "Maximum total pages to crawl. Default: 50.",
          minimum: 1,
          maximum: 500,
        }),
      ),
      extract_depth: Type.Optional(
        Type.String({
          description: "Extraction depth: 'basic' or 'advanced'. Default: basic",
        }),
      ),
      format: Type.Optional(
        Type.String({
          description: "Format: 'markdown' or 'text'. Default: markdown",
        }),
      ),
      include_images: Type.Optional(
        Type.Boolean({
          description: "Include image URLs. Default: false",
        }),
      ),
      include_favicon: Type.Optional(
        Type.Boolean({
          description: "Include favicon URLs. Default: false",
        }),
      ),
      select_paths: Type.Optional(
        Type.Array(Type.String(), {
          description: "Only crawl URLs matching these path patterns",
        }),
      ),
      exclude_paths: Type.Optional(
        Type.Array(Type.String(), {
          description: "Skip URLs matching these path patterns",
        }),
      ),
      select_domains: Type.Optional(
        Type.Array(Type.String(), {
          description: "Only crawl pages on these domains",
        }),
      ),
      exclude_domains: Type.Optional(
        Type.Array(Type.String(), {
          description: "Skip pages on these domains",
        }),
      ),
      allow_external: Type.Optional(
        Type.Boolean({
          description: "Allow crawling external domains linked from the start URL. Default: false",
        }),
      ),
      timeout: Type.Optional(
        Type.Number({
          description: "Timeout in seconds (1-120). Default: 30.",
          minimum: 1,
          maximum: 120,
        }),
      ),
      include_usage: Type.Optional(
        Type.Boolean({
          description: "Include credit usage info. Default: false",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const client = await getTavily();

      const options: Record<string, any> = {
        extractDepth: params.extract_depth ?? "basic",
        format: params.format ?? "markdown",
        includeImages: params.include_images ?? false,
        includeFavicon: params.include_favicon ?? false,
      };

      if (params.instructions) options.instructions = params.instructions;
      if (params.max_depth) options.maxDepth = params.max_depth;
      if (params.max_pages) options.limit = params.max_pages;
      if (params.select_paths) options.selectPaths = params.select_paths;
      if (params.exclude_paths) options.excludePaths = params.exclude_paths;
      if (params.select_domains) options.selectDomains = params.select_domains;
      if (params.exclude_domains) options.excludeDomains = params.exclude_domains;
      if (params.allow_external) options.allowExternal = params.allow_external;
      if (params.timeout) options.timeout = params.timeout;
      if (params.include_usage) options.includeUsage = true;

      const response = await client.crawl(params.start_url, options);

      if (!response.results || response.results.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `**Crawl of "${params.start_url}"** — No pages found matching the criteria.`,
            },
          ],
          details: { startUrl: params.start_url, pagesCrawled: 0, responseTime: response.responseTime },
        };
      }

      let output = `## Crawl results: \`${params.start_url}\`\n\n`;
      output += `| Metric | Value |\n|---|---|\n`;
      output += `| Pages crawled | ${response.results.length} |\n`;
      output += `| Duration | ${response.responseTime.toFixed(2)}s |\n`;
      if (response.usage) {
        output += `| Credits used | ${response.usage.credits} |\n`;
      }
      output += "\n";

      for (let i = 0; i < response.results.length; i++) {
        const r = response.results[i];
        output += `### [${i + 1}. ${r.url}](${r.url})\n\n`;
        output += r.rawContent.slice(0, 10_000);
        if (r.rawContent.length > 10_000) {
          output += `\n\n[...truncated ${r.rawContent.length - 10_000} chars...]`;
        }
        output += "\n\n---\n\n";
      }

      return {
        content: [{ type: "text", text: output }],
        details: {
          startUrl: params.start_url,
          pagesCrawled: response.results.length,
          responseTime: response.responseTime,
          credits: response.usage?.credits,
        },
      };
    },
  });
}

// ===========================================================================
// Extension entry point
// ===========================================================================

export default function (pi: ExtensionAPI) {
  registerWebSearch(pi);
  registerWebExtract(pi);
  registerWebCrawl(pi);
}
