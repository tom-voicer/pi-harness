export type AgentStatus = "pending" | "running" | "success" | "error";

export interface AgentNode {
  id: string;
  name: string;
  prompt: string;
  maxAgents: number;
  toolNames: string[];
  parentId: string | null;
  status: AgentStatus;
  output: string | null;
  error: string | null;
  children: string[];
  startTime: number;
  endTime: number | null;
}

export interface TreeState {
  rootId: string | null;
  nodes: Map<string, AgentNode>;
}

export function createTreeState(): TreeState {
  return { rootId: null, nodes: new Map() };
}

export function addNode(
  state: TreeState,
  parentId: string | null,
  name: string,
  prompt: string,
  maxAgents: number,
  toolNames: string[],
): AgentNode {
  const id = crypto.randomUUID();
  const node: AgentNode = {
    id,
    name,
    prompt,
    maxAgents,
    toolNames,
    parentId,
    status: "pending",
    output: null,
    error: null,
    children: [],
    startTime: 0,
    endTime: null,
  };
  state.nodes.set(id, node);

  if (parentId) {
    const parent = state.nodes.get(parentId);
    if (parent) parent.children.push(id);
  } else {
    state.rootId = id;
  }

  return node;
}

export interface SubagentTask {
  name: string;
  prompt: string;
  tools?: string[];
}

export interface RunConfig {
  model?: string;
  thinkingLevel?: string;
  cwd: string;
  toolNames?: string[];
}
