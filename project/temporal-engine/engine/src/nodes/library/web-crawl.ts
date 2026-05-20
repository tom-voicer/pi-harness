/**
 * web_crawl custom node — crawls a website and extracts clean content.
 * Follows same-domain links within a path prefix. Extracts each page via Readability.
 */
import type { CustomNodeHandler } from '../registry';

let _readability: any = null;
let _turndown: any = null;
let _JSDOM: any = null;

async function ensureDeps() {
  if (!_readability) {
    const [{ Readability }, TurndownService, { JSDOM }] = await Promise.all([
      import('@mozilla/readability'),
      import('turndown').then(m => m.default),
      import('jsdom'),
    ]);
    _readability = Readability;
    _turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
    _JSDOM = JSDOM;
  }
}

function normalizeUrl(url: string, base: string): string | null {
  try {
    const resolved = new URL(url, base);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return null;
    resolved.hash = '';
    if (resolved.pathname.length > 1 && resolved.pathname.endsWith('/')) {
      resolved.pathname = resolved.pathname.slice(0, -1);
    }
    return resolved.href;
  } catch {
    return null;
  }
}

function urlMatchesPrefix(url: string, prefix: string): boolean {
  const pathname = new URL(url).pathname.replace(/\/+$/, '') || '/';
  const cleanPrefix = prefix.replace(/\/+$/, '') || '/';
  if (cleanPrefix === '/') return true;
  return pathname === cleanPrefix || pathname.startsWith(cleanPrefix + '/');
}

interface CrawlPage {
  url: string;
  title: string;
  markdown: string;
  wordCount: number;
  links: string[];
}

async function extractPage(url: string, html: string): Promise<CrawlPage> {
  await ensureDeps();
  const doc = new _JSDOM(html, { url }).window.document;

  // Collect links
  const links: string[] = [];
  doc.querySelectorAll('a[href]').forEach((a: any) => {
    const href = a.getAttribute('href');
    if (href) links.push(href);
  });

  let title = doc.title || new URL(url).hostname;
  let markdown = '';

  try {
    const reader = new _readability(doc);
    const article = reader.parse();
    if (article?.textContent && article.textContent.length > 50) {
      title = article.title || title;
      markdown = article.content?.includes('<')
        ? _turndown.turndown(new _JSDOM(`<html><body>${article.content}</body></html>`).window.document.body)
        : article.textContent;
      return { url, title, markdown, wordCount: article.textContent.split(/\s+/).length, links };
    }
  } catch { /* fall through */ }

  const bodyText = doc.body?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 25_000) || '';
  return { url, title, markdown: bodyText, wordCount: bodyText.split(/\s+/).length, links };
}

export function createWebCrawlNode(): CustomNodeHandler {
  return async (step) => {
    const startUrl = step.start_url as string;
    if (!startUrl) throw new Error('web_crawl requires a "start_url" field');

    const maxDepth = (step.depth as number) || 2;
    const pathPrefix = (step.path_prefix as string) || new URL(startUrl).pathname.replace(/\/[^/]+$/, '') || '/';
    const maxPages = Math.min((step.max_pages as number) || 50, 200);
    const concurrency = Math.min((step.concurrency as number) || 2, 3);
    const delayMs = (step.delay_ms as number) || 200;

    console.log(`[web_crawl] Starting crawl: ${startUrl} (depth=${maxDepth}, prefix=${pathPrefix})`);

    const startHostname = new URL(startUrl).hostname;
    const visited = new Set<string>();
    const pages: Array<{ url: string; title: string; wordCount: number }> = [];
    const errors: string[] = [];

    const queue: { url: string; depth: number }[] = [{ url: startUrl, depth: 0 }];
    visited.add(startUrl);

    while (queue.length > 0 && pages.length < maxPages) {
      const batch = queue.splice(0, concurrency);
      const batchResults = await Promise.allSettled(
        batch.map(async ({ url, depth }) => {
          if (depth > maxDepth) return null;

          const resp = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; temporal-engine/1.0)' },
            signal: AbortSignal.timeout(10_000),
          });
          if (!resp.ok || !(resp.headers.get('content-type') || '').includes('text/html')) return null;

          const html = await resp.text();
          const page = await extractPage(url, html);

          // Discover new links
          const newUrls: string[] = [];
          for (const rawHref of page.links) {
            const normalized = normalizeUrl(rawHref, url);
            if (normalized && new URL(normalized).hostname === startHostname
              && urlMatchesPrefix(normalized, pathPrefix) && !visited.has(normalized)) {
              newUrls.push(normalized);
            }
          }

          return { page, newUrls };
        }),
      );

      for (const r of batchResults) {
        if (r.status !== 'fulfilled' || !r.value) continue;
        const { page, newUrls } = r.value;
        pages.push({ url: page.url, title: page.title, wordCount: page.wordCount });

        for (const u of newUrls) {
          if (visited.size >= maxPages) break;
          visited.add(u);
          queue.push({ url: u, depth: (pages[pages.length - 1] ? (queue.length > 0 ? (batch[0]?.depth ?? 0) + 1 : 1) : 1) });
        }
      }

      // Track depth per queued item more carefully
      // (Simplified: depth tracking could be improved)

      if (queue.length > 0) {
        await new Promise(r => setTimeout(r, delayMs));
      }
    }

    return JSON.stringify({
      start_url: startUrl,
      pages_crawled: pages.length,
      total_words: pages.reduce((s, p) => s + p.wordCount, 0),
      errors: errors.length,
      pages,
    });
  };
}
