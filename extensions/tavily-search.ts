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

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Tavily Search",
    description:
      "Search the web using Tavily. Returns results with titles, URLs, and content snippets. Useful for finding current information, documentation, or answering questions that require up-to-date web data.",
    promptSnippet: "Web search via Tavily — returns titles, URLs, and content",
    promptGuidelines: [
      "Use web_search when you need current, up-to-date information from the web.",
      "Use web_search when the user asks about recent events, news, or documentation that may have changed.",
      "Always cite sources from web_search results with URLs.",
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
}
