/**
 * web_search — Self-hosted web search engine
 *
 * Search backends (tried in order):
 *   1. Local SearXNG (127.0.0.1:8081, or SEARXNG_URL env var)
 *   2. DuckDuckGo direct API (filters out ads)
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
// Backend 1: DuckDuckGo direct API (bypasses duck-duck-scrape to filter ads)
// ===========================================================================
// We call DDG's internal JSON API directly instead of using the duck-duck-scrape
// library because that library drops the `da` (CSS class) field from results,
// making it impossible to distinguish ads from organic results.
// Ad results have da containing "result--ad"; we filter them out.

const DDG_DJS_URL = "https://links.duckduckgo.com/d.js";

// Regex to extract the main search results array from DDG's JS callback
const SEARCH_REGEX =
  /DDG\.pageLayout\.load\('d',(\[.+\])\);DDG\.duckbar\.load(?:Module)?\('/;

interface DDGRawResult {
  t?: string; // title
  u?: string; // url
  a?: string; // description
  i?: string; // hostname
  da?: string; // CSS class associations (e.g. "result result--ad")
  n?: string; // pagination marker — skip
  d?: string; // domain
}

async function ddgDirectSearch(query: string): Promise<SearchResult[]> {
  // Lazily import just the utilities we need from duck-duck-scrape
  const { getVQD, COMMON_HEADERS } = await import(
    "duck-duck-scrape/lib/util.js"
  );

  try {
    // Step 1: Get a VQD token (required for the search API)
    const vqd = await getVQD(query, "web", { headers: COMMON_HEADERS });

    // Step 2: Build query params matching what the library sends
    const params = new URLSearchParams({
      q: query,
      t: "D",
      l: "en-us",
      kl: "wt-wt",
      s: "0",
      dl: "en",
      ct: "US",
      bing_market: "en-US",
      df: "",
      vqd,
      ex: "-2", // SafeSearch OFF
      sp: "1",
      bpa: "1",
      biaexp: "b",
      msvrtexp: "b",
      nadse: "b",
      eclsexp: "b",
      tjsexp: "b",
    });

    // Step 3: Fetch from DDG's internal JSON API
    const result = await fetchWithTimeout(`${DDG_DJS_URL}?${params}`, {
      headers: {
        ...COMMON_HEADERS,
        Accept: "*/*",
      },
      timeout: 10_000,
    });

    if ("error" in result) return [];
    const body = await result.resp.text();

    // Check for blocks
    if (body.includes("DDG.deep.is506")) return [];
    if (body.includes("DDG.deep.anomalyDetectionBlock")) return [];

    // Step 4: Parse the JS callback to extract results
    const match = SEARCH_REGEX.exec(body);
    if (!match) return [];

    const raw: DDGRawResult[] = JSON.parse(
      match[1].replace(/\t/g, "    "),
    );

    // Step 5: Filter out ads and pagination markers, map to SearchResult
    const results: SearchResult[] = [];
    for (const r of raw) {
      // Skip pagination markers
      if ("n" in r) continue;

      // Skip ads — da field contains "result--ad" class for sponsored results
      if (r.da?.split(/\s+/).includes("result--ad")) continue;

      // Skip placeholder/empty results
      if (!r.t || !r.u) continue;

      results.push({
        title: r.t,
        url: r.u,
        content: r.a ?? "",
      });
    }

    return results;
  } catch (err: any) {
    if (
      err.message?.includes("anomaly") ||
      err.message?.includes("too quickly")
    ) {
      return [];
    }
    // Don't throw — fall back to next backend silently
    return [];
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

  // 2. Try DuckDuckGo direct API (filters ads by da field)
  const ddgResults = await ddgDirectSearch(query);
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
      "Search the web using local SearXNG (set SEARXNG_URL), DuckDuckGo direct API (ads filtered), or public SearXNG instances. Returns results with titles, URLs, and content snippets.",
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
