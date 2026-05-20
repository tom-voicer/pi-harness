/**
 * web_extract custom node — extracts clean content from a URL.
 * Uses @mozilla/readability + turndown for article extraction.
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

export function createWebExtractNode(): CustomNodeHandler {
  return async (step) => {
    const urls = step.urls;
    const format = (step.format as string) || 'markdown';

    const urlList: string[] = Array.isArray(urls) ? urls : (typeof urls === 'string' ? [urls] : []);
    if (urlList.length === 0) throw new Error('web_extract requires a "urls" field (string or array)');

    console.log(`[web_extract] Extracting ${urlList.length} URL(s)`);
    await ensureDeps();

    const results: Array<{ url: string; title: string; content: string; wordCount: number; error?: string }> = [];

    for (const url of urlList) {
      try {
        const resp = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; temporal-engine/1.0)' },
          signal: AbortSignal.timeout(15_000),
        });
        if (!resp.ok) {
          results.push({ url, title: '', content: '', wordCount: 0, error: `HTTP ${resp.status}` });
          continue;
        }

        const html = await resp.text();
        const doc = new _JSDOM(html, { url }).window.document;

        let title = doc.title || new URL(url).hostname;
        let content = '';
        let wordCount = 0;

        try {
          const reader = new _readability(doc);
          const article = reader.parse();
          if (article?.textContent && article.textContent.length > 50) {
            title = article.title || title;
            content = article.content?.includes('<')
              ? _turndown.turndown(new _JSDOM(`<html><body>${article.content}</body></html>`).window.document.body)
              : article.textContent;
            wordCount = article.textContent.split(/\s+/).length;
          }
        } catch {
          // Readability failed, use body text
          content = doc.body?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 25_000) || '';
          wordCount = content.split(/\s+/).length;
        }

        results.push({
          url,
          title,
          content: format === 'text' ? content.replace(/[#*`\[\]\(\)]/g, '') : content,
          wordCount,
        });
      } catch (err: any) {
        results.push({ url, title: '', content: '', wordCount: 0, error: err.message });
      }
    }

    return JSON.stringify({ count: results.length, results });
  };
}
