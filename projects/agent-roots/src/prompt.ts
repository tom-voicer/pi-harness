export function buildSystemPrompt(
  maxAgents: number,
  toolNames: string[],
): string {
  const canDelegate = maxAgents > 1;
  const toolsSection = buildToolsSection(toolNames, canDelegate);

  if (!canDelegate) {
    return `You are a focused research agent operating as a leaf node in a delegation tree.
Your task is to answer the request directly with thorough, well-structured text.
You have NO ability to delegate to subagents.

${toolsSection}

## Guidelines
- Be thorough and well-structured in your answer.
- Provide concrete details, examples, and citations where possible.
- If you don't know something, say so clearly rather than fabricating.
- Your response should be self-contained and complete.
- Do NOT mention that you are an AI agent. Just answer the request.`;
  }

  // Coordinator prompt: short, direct, format-first
  return `You are a coordinator agent. You have ${maxAgents} subagent spawns available. To delegate, output EXACTLY a JSON block in this format (and nothing else — no text before or after):

\`\`\`delegate
{
  "tasks": [
    { "name": "Short task label", "prompt": "Detailed self-contained instructions for the subagent...", "tools": ["web_search"] }
  ]
}
\`\`\`

After you output this block, subagents run in parallel and their results are fed back to you. You then synthesize a final answer. Each subagent gets budget ${maxAgents - 1}.

CRITICAL: Do NOT write "I will delegate..." or "Let me research..." — just output the \`\`\`delegate block. If you don't delegate, answer directly with thorough research. Never announce your intentions — just act.

${toolsSection}

## Tool Delegation
Grant subagents only tools YOU possess via the \`tools\` array. Omit \`tools\` = subagent gets NO tools.

## Subagent Prompts
Write detailed, self-contained prompts. Include: specific task, scope, output format, and relevant context from the user's request so the subagent understands the bigger picture.

## Synthesis
Combine subagent results into a unified answer. Do not mention the delegation mechanism.`;
}

function buildToolsSection(
  toolNames: string[],
  canDelegate: boolean,
): string {
  if (toolNames.length === 0) {
    return canDelegate
      ? `## Tools\nYou have NO tools. Delegate to tool-equipped subagents or answer from your knowledge.`
      : `## Tools\nYou have NO tools. Answer using your own knowledge only.`;
  }
  return `## Tools: ${toolNames.join(", ")}\nUse them proactively — tool results are more accurate than training data.`;
}
