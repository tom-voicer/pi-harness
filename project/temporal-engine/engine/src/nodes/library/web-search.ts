/**
 * web_search custom node — SearXNG-powered web search.
 * Configure with server URL. Falls back to DuckDuckGo if SearXNG is unreachable.
 */
import type { CustomNodeHandler } from '../registry';

export interface WebSearchConfig {
  searxngUrl: string; // e.g. "http://localhost:8081" or "https://search.example.com"
}

export function createWebSearchNode(config: WebSearchConfig): CustomNodeHandler {
  const baseUrl = config.searxngUrl.replace(/\/+$/, '');

  return async (step) => {
    const query = (step.query as string) || '';
    if (!query) throw new Error('web_search requires a "query" field');

    const maxResults = (step.max_results as number) || 5;

    // Try SearXNG
    const params = new URLSearchParams({ q: query, format: 'json', language: 'en' });
    const url = `${baseUrl}/search?${params}`;

    console.log(`[web_search] Searching: "${query}" via ${baseUrl}`);

    let results: Array<{ title: string; url: string; content: string }> = [];

    try {
      const resp = await fetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': 'temporal-engine/1.0' },
        signal: AbortSignal.timeout(10_000),
      });
      if (resp.ok) {
        const data = (await resp.json()) as any;
        results = ((data?.results ?? []) as any[]).slice(0, maxResults).map((r: any) => ({
          title: r.title ?? '',
          url: r.url ?? '',
          content: r.content ?? '',
        }));
      }
    } catch (err) {
      console.log(`[web_search] SearXNG unreachable, trying DuckDuckGo fallback`);
    }

    // DuckDuckGo fallback
    if (results.length === 0) {
      try {
        const { search } = await import('duck-duck-scrape');
        const ddgResult = await search(query, { safeSearch: 0 as any });
        if (ddgResult.results?.length) {
          results = ddgResult.results.slice(0, maxResults).map((r: any) => ({
            title: r.title ?? '',
            url: r.url ?? '',
            content: r.description ?? '',
          }));
        }
      } catch {
        // Both backends failed
      }
    }

    return JSON.stringify({ query, count: results.length, results });
  };
}
