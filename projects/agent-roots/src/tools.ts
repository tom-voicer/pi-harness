import {
  createReadTool,
  createBashTool,
  createEditTool,
  createWriteTool,
  createGrepTool,
  createFindTool,
  createLsTool,
  defineTool,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

// Built-in pi tools that can be created per-cwd
type ToolFactory = (cwd: string) => AgentTool;

const BUILTIN_FACTORIES: Record<string, ToolFactory> = {
  read: createReadTool,
  bash: createBashTool,
  edit: createEditTool,
  write: createWriteTool,
  grep: createGrepTool,
  find: createFindTool,
  ls: createLsTool,
};

export const AVAILABLE_TOOLS = [
  ...Object.keys(BUILTIN_FACTORIES),
  "web_search",
  "web_extract",
] as const;

function getTavilyKey(): string {
  const key = process.env.TAVILY_API_KEY;
  if (!key) throw new Error("TAVILY_API_KEY environment variable is not set");
  return key;
}

function createWebSearchTool(): ToolDefinition {
  return defineTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web using Tavily. Returns titles, URLs, and content snippets.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query string" }),
      search_depth: Type.Optional(
        Type.String({ description: "basic or advanced. Default: basic" }),
      ),
      max_results: Type.Optional(
        Type.Number({ description: "Maximum results (1-20). Default: 5" }),
      ),
    }),
    async execute(_id, params) {
      const apiKey = getTavilyKey();
      const body: Record<string, unknown> = {
        query: params.query,
        search_depth: params.search_depth || "basic",
        max_results: params.max_results || 5,
        include_answer: true,
      };

      const res = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Tavily search failed: ${res.status} ${res.statusText}`,
            },
          ],
          details: {},
          isError: true,
        };
      }

      const data = (await res.json()) as any;
      let text = data.answer
        ? `Answer: ${data.answer}\n\nResults:\n`
        : "Results:\n";

      for (const r of data.results || []) {
        text += `- **${r.title}**\n  ${r.url}\n  ${r.content}\n\n`;
      }

      return {
        content: [{ type: "text" as const, text: text.trim() || "(no results)" }],
        details: data,
      };
    },
  });
}

function createWebExtractTool(): ToolDefinition {
  return defineTool({
    name: "web_extract",
    label: "Web Extract",
    description:
      "Extract clean content from web pages via Tavily Extract. Returns markdown or text.",
    parameters: Type.Object({
      urls: Type.Array(Type.String(), {
        description: "URLs to extract content from",
      }),
      query: Type.Optional(
        Type.String({
          description:
            "User intent for reranking. When provided, only most relevant chunks are returned.",
        }),
      ),
      extract_depth: Type.Optional(
        Type.String({ description: "basic or advanced. Default: basic" }),
      ),
      format: Type.Optional(
        Type.String({ description: "markdown or text. Default: markdown" }),
      ),
    }),
    async execute(_id, params) {
      const apiKey = getTavilyKey();
      const body: Record<string, unknown> = {
        urls: params.urls,
        extract_depth: params.extract_depth || "basic",
        format: params.format || "markdown",
      };
      if (params.query) body.query = params.query;

      const res = await fetch("https://api.tavily.com/extract", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Tavily extract failed: ${res.status} ${res.statusText}`,
            },
          ],
          details: {},
          isError: true,
        };
      }

      const data = (await res.json()) as any;
      let text = "";
      for (const r of data.results || []) {
        text += `## ${r.url}\n\n${r.raw_content || "(no content)"}\n\n---\n\n`;
      }

      return {
        content: [
          { type: "text" as const, text: text.trim() || "(no content extracted)" },
        ],
        details: data,
      };
    },
  });
}

const CUSTOM_TOOL_FACTORIES: Record<string, () => ToolDefinition> = {
  web_search: createWebSearchTool,
  web_extract: createWebExtractTool,
};

export interface ResolvedTools {
  builtin: AgentTool[];
  custom: ToolDefinition[];
  names: string[];
}

export function resolveTools(names: string[], cwd: string): ResolvedTools {
  const builtin: AgentTool[] = [];
  const custom: ToolDefinition[] = [];

  for (const name of names) {
    if (BUILTIN_FACTORIES[name]) {
      builtin.push(BUILTIN_FACTORIES[name](cwd));
    } else if (CUSTOM_TOOL_FACTORIES[name]) {
      custom.push(CUSTOM_TOOL_FACTORIES[name]());
    }
    // Unknown tool names are silently ignored
  }

  return { builtin, custom, names };
}
