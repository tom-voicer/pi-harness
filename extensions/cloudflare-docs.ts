/**
 * Cloudflare Documentation Tool for pi
 *
 * Provides direct access to Cloudflare's developer documentation via their
 * LLM-friendly endpoints. No API key or OAuth required — uses the same
 * markdown endpoints that power Cloudflare's official Docs MCP server.
 *
 * Endpoints used:
 *   https://developers.cloudflare.com/llms.txt          — product index
 *   https://developers.cloudflare.com/{product}/llms.txt — page listing per product
 *   https://developers.cloudflare.com/{product}/llms-full.txt — full docs per product
 *   https://developers.cloudflare.com/{path}/index.md   — individual page
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DOCS_BASE = "https://developers.cloudflare.com";

// ── Cache ──────────────────────────────────────────────────────────────

interface ProductInfo {
  slug: string;
  name: string;
  description: string;
}

interface PageInfo {
  title: string;
  path: string;
}

let productIndex: ProductInfo[] | null = null;
const pageCache = new Map<string, { data: string; ts: number }>();
const PAGE_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function getProductIndex(): Promise<ProductInfo[]> {
  if (productIndex) return productIndex;

  const res = await fetch(`${DOCS_BASE}/llms.txt`);
  if (!res.ok) throw new Error(`Failed to fetch product index: ${res.status}`);

  const text = await res.text();
  const products: ProductInfo[] = [];

  // Parse the llms.txt format:
  // ## Category
  // - [Product Name](https://.../product/llms.txt): Description
  const lines = text.split("\n");
  for (const line of lines) {
    const match = line.match(
      /^-\s+\[([^\]]+)\]\(https:\/\/developers\.cloudflare\.com\/([^/]+)\/llms\.txt\):\s*(.+)$/,
    );
    if (match) {
      products.push({
        name: match[1]!,
        slug: match[2]!,
        description: match[3]!,
      });
    }
  }

  productIndex = products;
  return products;
}

async function getProductPages(slug: string): Promise<PageInfo[]> {
  const cacheKey = `pages:${slug}`;
  const cached = pageCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < PAGE_CACHE_TTL) {
    return JSON.parse(cached.data);
  }

  const res = await fetch(`${DOCS_BASE}/${slug}/llms.txt`);
  if (!res.ok) {
    throw new Error(
      `Product "${slug}" not found (${res.status}). Use list_products to see available products.`,
    );
  }

  const text = await res.text();
  const pages: PageInfo[] = [];

  // Parse product llms.txt — each line is: [Title](path) | description
  // Also handles: [Title](path): description
  const lines = text.split("\n");
  for (const line of lines) {
    // Match both absolute and relative URLs:
    //   [Title](https://developers.cloudflare.com/path/index.md): desc
    //   [Title](/path) | desc
    //   [Title](/path): desc
    const match = line.match(
      /^-\s+\[([^\]]+)\]\((?:https:\/\/developers\.cloudflare\.com)?(\/[^)]+)\)/,
    );
    if (match) {
      // Strip /index.md suffix, trailing slashes
      const path = match[2]!.replace(/\/index\.md$/, "").replace(/\/$/, "");
      // Skip external/non-doc links
      if (path.startsWith("/")) {
        pages.push({ title: match[1]!, path });
      }
    }
  }

  const data = JSON.stringify(pages);
  pageCache.set(cacheKey, { data, ts: Date.now() });
  return pages;
}

async function getPage(path: string): Promise<string> {
  const cacheKey = `page:${path}`;
  const cached = pageCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < PAGE_CACHE_TTL) {
    return cached.data;
  }

  // Strip leading /docs if present, normalize path
  const cleanPath = path.replace(/^\/docs\//, "/").replace(/\/$/, "");
  const url = `${DOCS_BASE}${cleanPath}/index.md`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Page not found (${res.status}): ${url}`);
  }

  const text = await res.text();
  pageCache.set(cacheKey, { data: text, ts: Date.now() });
  return text;
}

async function getFullDocs(slug: string): Promise<string> {
  const cacheKey = `full:${slug}`;
  const cached = pageCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < PAGE_CACHE_TTL * 2) {
    return cached.data;
  }

  const res = await fetch(`${DOCS_BASE}/${slug}/llms-full.txt`);
  if (!res.ok) {
    throw new Error(
      `Full docs not available for "${slug}" (${res.status}). Try list_pages + get_page instead.`,
    );
  }

  const text = await res.text();
  pageCache.set(cacheKey, { data: text, ts: Date.now() });
  return text;
}

/**
 * Search Cloudflare products by name/description keyword matching.
 */
function searchProducts(products: ProductInfo[], query: string): ProductInfo[] {
  const q = query.toLowerCase();
  return products.filter(
    (p) =>
      p.name.toLowerCase().includes(q) ||
      p.description.toLowerCase().includes(q) ||
      p.slug.toLowerCase().includes(q),
  );
}

// ── Extension ──────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "cloudflare_docs",
    label: "Cloudflare Docs",
    description:
      "Access Cloudflare's official developer documentation. Browse products, list pages, get full page content in markdown, or retrieve complete product documentation. Uses the same endpoints as Cloudflare's official Docs MCP server.",
    promptSnippet:
      "Retrieve Cloudflare docs — list products, browse pages, get markdown content from developers.cloudflare.com",
    promptGuidelines: [
      "Use cloudflare_docs to look up Cloudflare API references, configuration options, guides, and best practices when working on Cloudflare-related code.",
      "Use cloudflare_docs with action='list_products' to find the correct product, then list_pages to browse, and get_page to read specific documentation.",
      "For comprehensive knowledge about a product, use action='get_full_docs' to retrieve all documentation at once (caution: can be large).",
      "When using cloudflare_docs for API-specific questions, prefer the product-specific docs over the general API reference.",
      "Always cite the documentation page URL when using information from cloudflare_docs.",
    ],
    parameters: Type.Object({
      action: Type.String({
        description:
          "Action to perform: 'list_products' (list all Cloudflare products), " +
          "'search_products' (search products by name/description), " +
          "'list_pages' (list all pages for a product), " +
          "'get_page' (get a specific page as markdown), " +
          "'get_full_docs' (get complete docs for a product as a single markdown file)",
      }),
      query: Type.Optional(
        Type.String({
          description:
            "Search query (for 'search_products' action). Searches product names, slugs, and descriptions.",
        }),
      ),
      product: Type.Optional(
        Type.String({
          description:
            "Product slug (e.g., 'workers', 'd1', 'durable-objects', 'agents'). Required for 'list_pages', 'get_full_docs', and 'search_products' (optional, narrows results).",
        }),
      ),
      path: Type.Optional(
        Type.String({
          description:
            "Documentation page path (e.g., '/workers/get-started/'). Required for 'get_page'.",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const { action, query, product, path } = params;

      try {
        switch (action) {
          case "list_products": {
            const products = await getProductIndex();

            let output = `# Cloudflare Products (${products.length} total)\n\n`;
            output += `> Each product has detailed documentation at \`https://developers.cloudflare.com/{slug}/\`\n`;
            output += `> Use \`cloudflare_docs\` with \`action='list_pages'\` and \`product='{slug}'\` to browse a product's documentation.\n\n`;

            // Group by category (inferred from order — actual categories from the source)
            const chunkSize = 15;
            for (let i = 0; i < products.length; i += chunkSize) {
              const chunk = products.slice(i, i + chunkSize);
              for (const p of chunk) {
                output += `- **${p.name}** (\`${p.slug}\`) — ${p.description}\n`;
              }
              output += "\n";
            }

            return {
              content: [{ type: "text", text: output }],
              details: { productCount: products.length },
            };
          }

          case "search_products": {
            if (!query) {
              return {
                isError: true,
                content: [{ type: "text", text: "Error: 'query' parameter is required for 'search_products' action." }],
                details: {},
              };
            }

            const products = await getProductIndex();
            const results = searchProducts(products, query);

            if (results.length === 0) {
              return {
                content: [
                  {
                    type: "text",
                    text: `No Cloudflare products found matching "${query}".\n\nTry \`action='list_products'\` to see all available products, or try a different search term.`,
                  },
                ],
                details: { query, matchCount: 0 },
              };
            }

            let output = `# Search results for "${query}" (${results.length} matches)\n\n`;
            for (const p of results) {
              output += `- **${p.name}** (\`${p.slug}\`) — ${p.description}\n`;
              output += `  Docs: https://developers.cloudflare.com/${p.slug}/\n`;
              output += `  Pages: use \`cloudflare_docs\` with \`action='list_pages'\` and \`product='${p.slug}'\`\n\n`;
            }

            return {
              content: [{ type: "text", text: output }],
              details: { query, matchCount: results.length },
            };
          }

          case "list_pages": {
            if (!product) {
              return {
                isError: true,
                content: [{ type: "text", text: "Error: 'product' parameter is required for 'list_pages' action." }],
                details: {},
              };
            }

            const pages = await getProductPages(product);

            if (pages.length === 0) {
              return {
                content: [
                  {
                    type: "text",
                    text: `No documentation pages found for product "${product}".\n\nVerify the slug with \`action='list_products'\`.`,
                  },
                ],
                details: { product, pageCount: 0 },
              };
            }

            let output = `# ${product} — Documentation Pages (${pages.length} total)\n\n`;
            output += `> Full URL: https://developers.cloudflare.com${pages[0]?.path?.split("/").slice(0, 2).join("/") || `/${product}`}\n`;
            output += `> Use \`cloudflare_docs\` with \`action='get_page'\` and \`path='...'\` to read a page.\n\n`;

            for (const page of pages) {
              output += `- [${page.title}](https://developers.cloudflare.com${page.path}) — \`${page.path}\`\n`;
            }

            return {
              content: [{ type: "text", text: output }],
              details: { product, pageCount: pages.length },
            };
          }

          case "get_page": {
            if (!path) {
              return {
                isError: true,
                content: [{ type: "text", text: "Error: 'path' parameter is required for 'get_page' action." }],
                details: {},
              };
            }

            const content = await getPage(path);
            const fullUrl = `${DOCS_BASE}${path.replace(/\/$/, "")}`;

            const maxLen = 30000;
            const truncated =
              content.length > maxLen
                ? content.slice(0, maxLen) +
                  `\n\n[...truncated ${content.length - maxLen} chars. Use get_page with offset/limit or get_full_docs for complete content...]`
                : content;

            return {
              content: [
                {
                  type: "text",
                  text: `**Source:** ${fullUrl}\n\n${truncated}`,
                },
              ],
              details: {
                path,
                url: fullUrl,
                contentLength: content.length,
                truncated: content.length > maxLen,
              },
            };
          }

          case "get_full_docs": {
            if (!product) {
              return {
                isError: true,
                content: [{ type: "text", text: "Error: 'product' parameter is required for 'get_full_docs' action." }],
                details: {},
              };
            }

            const content = await getFullDocs(product);
            const fullUrl = `${DOCS_BASE}/${product}/llms-full.txt`;

            const maxLen = 50000;
            const truncated =
              content.length > maxLen
                ? content.slice(0, maxLen) +
                  `\n\n[...truncated ${content.length - maxLen} chars from full docs. Total: ${content.length} chars...]`
                : content;

            return {
              content: [
                {
                  type: "text",
                  text: `**Full docs for \`${product}\`:** ${fullUrl}\n\n${truncated}`,
                },
              ],
              details: {
                product,
                url: fullUrl,
                contentLength: content.length,
                truncated: content.length > maxLen,
              },
            };
          }

          default:
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: `Unknown action "${action}". Valid actions: list_products, search_products, list_pages, get_page, get_full_docs.`,
                },
              ],
              details: {},
            };
        }
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: "text", text: `Cloudflare Docs error: ${err.message}` }],
          details: {},
        };
      }
    },
  });
}
