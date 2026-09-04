import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const CTX7_API = "https://context7.com/api/v2";
const API_KEY = "ctx7sk-bd47ce2b-2dda-4113-81e8-c96a8e0623e3";

async function ctx7Get(path: string, signal?: AbortSignal) {
  const url = `${CTX7_API}${path}`;
  const res = await fetch(url, {
    headers: { Authorization: API_KEY },
    signal,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Context7 ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

export default function (pi: ExtensionAPI) {
  // ── resolve-library-id ──────────────────────────────────
  pi.registerTool({
    name: "resolve_library_id",
    label: "Resolve Library ID",
    description:
      "Resolves a package/product name to a Context7-compatible library ID. " +
      "Returns matching libraries with IDs like /org/project. " +
      "You MUST call this before query_docs to get a valid library ID. " +
      "Limit: 3 calls per question max.",
    promptSnippet: "Resolve a library name to a Context7-compatible library ID",
    promptGuidelines: [
      "Use resolve_library_id before query_docs to obtain a valid Context7 library ID. " +
        "Skip only if the user already provides an ID in /org/project format.",
    ],
    parameters: Type.Object({
      libraryName: Type.String({ description: "Library name, e.g. 'react', 'zigflow'" }),
      query: Type.String({
        description:
          "The user's full question — used to rank results by relevance. Do NOT include API keys or sensitive data.",
      }),
    }),
    async execute(_id, params, signal) {
      const data = await ctx7Get(
        `/libs/search?query=${encodeURIComponent(params.query)}&libraryName=${encodeURIComponent(params.libraryName)}`,
        signal,
      );
      const results = (data as any).results ?? [];
      if (!results.length) {
        return {
          content: [{ type: "text", text: `No libraries found for "${params.libraryName}".` }],
        };
      }
      const lines = results.map(
        (r: any) =>
          `- **${r.name}** (${r.id}) — ${r.description ?? "no description"}\n` +
          `  snippets: ${r.codeSnippets ?? "?"} | benchmark: ${r.benchmarkScore ?? "?"} | source: ${r.sourceReputation ?? "?"}`,
      );
      return {
        content: [{ type: "text", text: `Libraries matching "${params.libraryName}":\n\n${lines.join("\n\n")}` }],
        details: { results },
      };
    },
  });

  // ── query-docs ──────────────────────────────────────────
  pi.registerTool({
    name: "query_docs",
    label: "Query Docs",
    description:
      "Retrieves up-to-date documentation and code examples from Context7 for a library. " +
      "Requires a library ID from resolve_library_id (or user-provided /org/project). " +
      "Pass a specific, natural-language query. Limit: 3 calls per question.",
    promptSnippet: "Fetch current documentation for a library from Context7",
    promptGuidelines: [
      "Use query_docs with the library ID from resolve_library_id. " +
        "Make queries specific (e.g. 'How to configure retry policies' not just 'retry'). " +
        "If results are unsatisfactory, retry once with researchMode: true.",
    ],
    parameters: Type.Object({
      libraryId: Type.String({
        description: "Exact Context7 library ID, e.g. /vercel/next.js or /zigflow/zigflow",
      }),
      query: Type.String({
        description:
          "Specific natural-language question about the library's API, configuration, or usage.",
      }),
      researchMode: Type.Optional(
        Type.Boolean({
          description: "Retry with deeper research (uses sandboxed agents + web search). More costly.",
        }),
      ),
    }),
    async execute(_id, params, signal) {
      const q = encodeURIComponent(params.query);
      const lid = encodeURIComponent(params.libraryId);
      let url = `/context?query=${q}&libraryId=${lid}`;
      if (params.researchMode) url += "&researchMode=true";

      const data = await ctx7Get(url, signal);
      const text = (data as any).data ?? (data as any).text ?? JSON.stringify(data, null, 2);
      return {
        content: [{ type: "text", text: typeof text === "string" ? text : JSON.stringify(text, null, 2) }],
        details: data,
      };
    },
  });

}
