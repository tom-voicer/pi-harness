import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// Set your Tavily API key here, or use an env var
const TAVILY_API_KEY = process.env.TAVILY_API_KEY || "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";

interface TavilySearchResult {
  title: string;
  url: string;
  content: string;
  score: number;
  raw_content?: string;
}

interface TavilySearchResponse {
  query: string;
  answer?: string;
  results: TavilySearchResult[];
  response_time: number;
}

interface TavilyExtractResult {
  url: string;
  raw_content: string;
  images?: string[];
  favicon?: string;
}

interface TavilyExtractFailedResult {
  url: string;
  error: string;
}

interface TavilyExtractResponse {
  results: TavilyExtractResult[];
  failed_results: TavilyExtractFailedResult[];
  response_time: number;
  usage?: {
    extract_credits?: number;
    search_credits?: number;
  };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "tavily_search",
    label: "Tavily Search",
    description:
      "Search the web using Tavily. Returns results with titles, URLs, and content snippets. Useful for finding current information, documentation, or answering questions that require up-to-date web data.",
    promptSnippet: "Web search via Tavily — returns titles, URLs, and content",
    promptGuidelines: [
      "Use tavily_search when you need current, up-to-date information from the web.",
      "Use tavily_search when the user asks about recent events, news, or documentation that may have changed.",
      "Always cite sources from tavily_search results with URLs.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search query string" }),
      search_depth: Type.Optional(
        Type.String({
          description: "Search depth: 'basic' (faster) or 'advanced' (more thorough). Default: basic",
        }),
      ),
      max_results: Type.Optional(
        Type.Number({
          description: "Maximum number of results to return (1-20). Default: 5",
        }),
      ),
      include_answer: Type.Optional(
        Type.Boolean({
          description: "Include an AI-generated answer summary. Default: true",
        }),
      ),
      include_raw_content: Type.Optional(
        Type.Boolean({
          description: "Include raw page content. Default: false",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const {
        query,
        search_depth = "basic",
        max_results = 5,
        include_answer = true,
        include_raw_content = false,
      } = params;

      const response = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TAVILY_API_KEY}`,
        },
        body: JSON.stringify({
          query,
          search_depth,
          max_results,
          include_answer,
          include_raw_content,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Tavily API error (${response.status}): ${errorText}`,
            },
          ],
          details: {},
        };
      }

      const data: TavilySearchResponse = await response.json();

      // Format results nicely
      let output = "";

      if (include_answer && data.answer) {
        output += `**Answer:** ${data.answer}\n\n`;
      }

      output += `**Search results for "${data.query}"** (${data.results.length} results, ${data.response_time.toFixed(2)}s):\n\n`;

      for (const result of data.results) {
        output += `### [${result.title}](${result.url})\n`;
        output += `${result.content}\n`;
        if (include_raw_content && result.raw_content) {
          output += `\n<details>\n<summary>Raw content</summary>\n\n${result.raw_content.slice(0, 5000)}\n</details>\n`;
        }
        output += "\n---\n\n";
      }

      return {
        content: [{ type: "text", text: output }],
        details: { query, resultCount: data.results.length, responseTime: data.response_time },
      };
    },
  });

  // --- Tavily Extract Tool ---
  pi.registerTool({
    name: "tavily_extract",
    label: "Tavily Extract",
    description:
      "Extract clean, raw content from one or more web page URLs using Tavily Extract. Returns the page content in markdown or plain text. Useful for fetching full documentation pages, articles, or any web content the LLM needs to read in detail.",
    promptSnippet: "Extract clean content from URLs via Tavily — returns raw markdown/text",
    promptGuidelines: [
      "Use tavily_extract to pull the full content of a web page from a URL when you need detailed information.",
      "Use tavily_extract after tavily_search returns promising URLs that need deeper reading.",
      "When extracting from multiple URLs, batch them into a single tavily_extract call (up to 20 URLs).",
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
            "User intent for reranking extracted content chunks. When provided, only the most relevant chunks (by default 3) are returned instead of the full page.",
        }),
      ),
      chunks_per_source: Type.Optional(
        Type.Number({
          description:
            "Maximum number of relevant chunks per source (1-5). Only applies when query is provided. Default: 3.",
          minimum: 1,
          maximum: 5,
        }),
      ),
      extract_depth: Type.Optional(
        Type.String({
          description:
            "Extraction depth: 'basic' (faster, 1 credit per 5 URLs) or 'advanced' (includes tables/embedded content, 2 credits per 5 URLs). Default: basic",
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
          description:
            "Format of extracted content: 'markdown' or 'text'. Default: markdown",
        }),
      ),
      timeout: Type.Optional(
        Type.Number({
          description:
            "Maximum time in seconds to wait for extraction (1-60). Default: 10s for basic, 30s for advanced.",
          minimum: 1,
          maximum: 60,
        }),
      ),
      include_usage: Type.Optional(
        Type.Boolean({
          description:
            "Include credit usage info in the response. Default: false",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const {
        urls,
        query,
        chunks_per_source,
        extract_depth = "basic",
        include_images = false,
        include_favicon = false,
        format = "markdown",
        timeout,
        include_usage = false,
      } = params;

      const body: Record<string, unknown> = {
        urls,
        extract_depth,
        include_images,
        include_favicon,
        format,
        include_usage,
      };
      if (query) body.query = query;
      if (chunks_per_source !== undefined) body.chunks_per_source = chunks_per_source;
      if (timeout !== undefined) body.timeout = timeout;

      const response = await fetch("https://api.tavily.com/extract", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TAVILY_API_KEY}`,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorText = await response.text();
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Tavily Extract API error (${response.status}): ${errorText}`,
            },
          ],
          details: {},
        };
      }

      const data: TavilyExtractResponse = await response.json();

      // Build formatted output
      let output = "";
      const urlList = Array.isArray(urls) ? urls : [urls];
      output += `**Tavily Extract results** (${data.results.length}/${urlList.length} URLs extracted, ${data.response_time.toFixed(2)}s):\n\n`;

      for (const result of data.results) {
        output += `### [${result.url}](${result.url})\n`;
        if (include_favicon && result.favicon) {
          output += `Favicon: ${result.favicon}\n\n`;
        }
        output += `Content length: ${result.raw_content.length} chars\n\n`;

        // Truncate very long content to prevent context blowup
        const maxContentLen = 25000;
        const content =
          result.raw_content.length > maxContentLen
            ? result.raw_content.slice(0, maxContentLen) +
              `\n\n[...truncated ${result.raw_content.length - maxContentLen} chars...]`
            : result.raw_content;
        output += content + "\n";

        if (include_images && result.images && result.images.length > 0) {
          output += `\n**Images:** ${result.images.join(", ")}\n`;
        }
        output += "\n---\n\n";
      }

      // Report failed URLs
      if (data.failed_results && data.failed_results.length > 0) {
        output += "\n**Failed extractions:**\n";
        for (const fail of data.failed_results) {
          output += `- [${fail.url}](${fail.url}): ${fail.error}\n`;
        }
        output += "\n";
      }

      return {
        content: [{ type: "text", text: output }],
        details: {
          extractedCount: data.results.length,
          failedCount: data.failed_results?.length ?? 0,
          responseTime: data.response_time,
          usage: data.usage,
        },
      };
    },
  });
}
