/**
 * web_search — Self-hosted web search engine
 *
 * Search backends (tried in order):
 *   1. Local SearXNG (127.0.0.1:8081, or SEARXNG_URL env var)
 *   2. DuckDuckGo via duck-duck-scrape
 *   3. Public SearXNG instances (raced)
 *
 * No API keys required. Set SEARXNG_URL env var for best results.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface SearchResult {
  title: string;
  url: string;
  content: string;
  publishedDate?: string;
}

// ===========================================================================
// Rate limiting
// ===========================================================================

let _lastSearchTime = 0;
const MIN_SEARCH_INTERVAL = 1500; // ms between searches

async function throttleSearch(): Promise<void> {
  const now = Date.now();
  const elapsed = now - _lastSearchTime;
  if (elapsed < MIN_SEARCH_INTERVAL) {
    await new Promise((r) => setTimeout(r, MIN_SEARCH_INTERVAL - elapsed));
  }
  _lastSearchTime = Date.now();
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
// Backend 1: DuckDuckGo via duck-duck-scrape (primary fallback)
// ===========================================================================

let _ddgSearch: any = null;

async function getDdgClient() {
  if (!_ddgSearch) {
    const dds = await import("duck-duck-scrape");
    _ddgSearch = dds;
  }
  return _ddgSearch;
}

async function ddgScrapeSearch(query: string): Promise<SearchResult[]> {
  try {
    const dds = await getDdgClient();
    const response = await dds.search(query, {
      safeSearch: dds.SafeSearchType.OFF,
    });

    if (response.noResults || !response.results.length) return [];

    return response.results.map((r: any) => ({
      title: r.title ?? "",
      url: r.url ?? "",
      content: r.description ?? "",
    }));
  } catch (err: any) {
    // Rate-limited or blocked
    if (err.message?.includes("anomaly") || err.message?.includes("too quickly")) {
      return []; // silent fallback to next backend
    }
    throw err; // unexpected error
  }
}

// ===========================================================================
// Backend 2: SearXNG (local or public)
// ===========================================================================

function getLocalSearXNGUrl(): string {
  return process.env.SEARXNG_URL?.replace(/\/+$/, "") ?? "";
}

const SEARXNG_PUBLIC = [
  "https://searx.be",
  "https://paulgo.io",
  "https://search.sapti.me",
  "https://searx.tiekoetter.com",
  "https://searx.work",
  "https://searx.ro",
  "https://search.mdosch.de",
  "https://searx.party",
  "https://searx.tuxcloud.net",
];

async function searxngSearch(baseUrl: string, query: string): Promise<SearchResult[]> {
  const params = new URLSearchParams({ q: query, format: "json", language: "en" });
  const url = `${baseUrl}/search?${params}`;

  const result = await fetchWithTimeout(url, {
    headers: { Accept: "application/json", "User-Agent": "pi-web-search/1.0" },
    timeout: 10_000,
  });

  if ("error" in result) return [];
  if (!result.resp.ok) return [];

  try {
    const data = (await result.resp.json()) as any;
    const items: any[] = data?.results ?? [];
    return items.slice(0, 20).map((r: any) => ({
      title: r.title ?? "",
      url: r.url ?? "",
      content: r.content ?? "",
      publishedDate: r.publishedDate ?? undefined,
    }));
  } catch {
    return [];
  }
}

async function searxngRace(
  instances: string[],
  query: string,
): Promise<{ results: SearchResult[]; instance: string } | null> {
  const results = await Promise.allSettled(
    instances.map(async (url) => ({
      url,
      results: await searxngSearch(url, query),
    })),
  );

  for (const r of results) {
    if (r.status === "fulfilled" && r.value.results.length > 0) {
      return { results: r.value.results, instance: r.value.url };
    }
  }
  return null;
}

// ===========================================================================
// Main search orchestrator
// ===========================================================================

async function searchWeb(
  query: string,
): Promise<{ results: SearchResult[]; source: string }> {
  await throttleSearch();

  // 1. Try local SearXNG (SEARXNG_URL, then 127.0.0.1:8081)
  for (const baseUrl of [getLocalSearXNGUrl(), "http://127.0.0.1:8081"]) {
    const url = baseUrl.replace(/\/+$/, "");
    if (!url) continue;
    const results = await searxngSearch(url, query);
    if (results.length > 0) {
      return { results, source: "searxng (local)" };
    }
  }

  // 2. Try DuckDuckGo via duck-duck-scrape
  const ddgResults = await ddgScrapeSearch(query);
  if (ddgResults.length > 0) {
    return { results: ddgResults, source: "duckduckgo" };
  }

  // 3. Try public SearXNG instances (race)
  const sxngResult = await searxngRace(SEARXNG_PUBLIC, query);
  if (sxngResult) {
    return {
      results: sxngResult.results,
      source: `searxng (${new URL(sxngResult.instance).hostname})`,
    };
  }

  return { results: [], source: "none" };
}

// ===========================================================================
// Extension
// ===========================================================================

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web using DuckDuckGo, local SearXNG (set SEARXNG_URL), or public SearXNG instances. Returns results with titles, URLs, and content snippets.",
    promptSnippet: "Web search via local DDG/SearXNG — returns titles, URLs, and content",
    promptGuidelines: [
      "Use web_search when you need current, up-to-date information from the web.",
      "Use web_search when the user asks about recent events, news, or documentation that may have changed.",
      "Always cite sources from web_search results with URLs.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search query string" }),
      search_depth: Type.Optional(
        Type.String({
          description:
            "Search depth: 'basic' (faster) or 'advanced' (more thorough). Default: basic",
        }),
      ),
      max_results: Type.Optional(
        Type.Number({
          description: "Maximum number of results to return (1-20). Default: 5",
        }),
      ),
      include_answer: Type.Optional(
        Type.Boolean({
          description: "Include an AI-generated answer summary (not supported — ignored).",
        }),
      ),
      include_raw_content: Type.Optional(
        Type.Boolean({
          description: "Include raw page content. Default: false",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const { query, max_results = 5 } = params;

      const startTime = Date.now();
      const { results, source } = await searchWeb(query);
      const responseTime = (Date.now() - startTime) / 1000;

      const limitedResults = results.slice(0, Math.min(max_results, 20));

      if (limitedResults.length === 0) {
        return {
          content: [
            {
              type: "text",
              text:
                `**Web search for "${query}"** — No results found.\n\n` +
                `All search backends are currently unreachable. ` +
                `Consider setting the SEARXNG_URL environment variable to a local SearXNG instance.`,
            },
          ],
          details: { query, resultCount: 0, source, responseTime },
        };
      }

      let output =
        `**Search results for "${query}"** ` +
        `(${limitedResults.length} results via ${source}, ${responseTime.toFixed(2)}s):\n\n`;

      for (const result of limitedResults) {
        const dateStr = result.publishedDate ? ` — *${result.publishedDate}*` : "";
        output += `### [${result.title}](${result.url})${dateStr}\n`;
        output += `${result.content}\n`;
        output += "\n---\n\n";
      }

      return {
        content: [{ type: "text", text: output }],
        details: { query, resultCount: limitedResults.length, source, responseTime },
      };
    },
  });
}
