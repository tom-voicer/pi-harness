/**
 * Log a message (prints to worker stdout).
 */
export async function logActivity(message: string): Promise<string> {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${message}`;
  console.log(line);
  return line;
}

/**
 * Make an HTTP request.
 */
export async function httpActivity(
  method: string,
  url: string,
  headers?: Record<string, string>,
  body?: unknown,
): Promise<{ status: number; statusText: string; data: unknown }> {
  console.log(`[HTTP] ${method} ${url}`);

  const fetchHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    ...headers,
  };

  const response = await fetch(url, {
    method,
    headers: fetchHeaders,
    body: body ? JSON.stringify(body) : undefined,
  });

  let data: unknown;
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    data = await response.json();
  } else {
    data = await response.text();
  }

  return {
    status: response.status,
    statusText: response.statusText,
    data,
  };
}

/**
 * Resolve a workflow definition from a file path or workflow ID.
 * Called by the workflow_run step to load sub-workflow definitions at runtime.
 */
export async function resolveWorkflowDefActivity(
  workflowFile?: string,
  workflowId?: string,
): Promise<{ name: string; steps: unknown[]; input?: Record<string, unknown> }> {
  if (workflowFile) {
    const fs = await import('fs/promises');
    const path = await import('path');
    const resolved = path.isAbsolute(workflowFile) ? workflowFile : path.resolve(workflowFile);
    console.log(`[workflow_run] Loading definition from: ${resolved}`);
    const content = await fs.readFile(resolved, 'utf-8');
    return JSON.parse(content);
  }
  if (workflowId) {
    // Future: DB lookup — look up the definition by its stored ID
    throw new Error(`Workflow ID lookup not yet implemented: "${workflowId}". Use "definition" or "workflow_file" instead.`);
  }
  throw new Error('workflow_run requires one of: definition, workflow_file, workflow_id');
}

/**
 * Dispatch a custom node to its registered handler.
 * The registry is populated at worker startup (before Worker.create).
 */
export async function customNodeActivity(
  nodeType: string,
  step: Record<string, unknown>,
  vars: Record<string, unknown>,
): Promise<string> {
  const { getHandler } = require('./nodes/registry');
  const handler = getHandler(nodeType);
  if (!handler) {
    throw new Error(`Unknown custom node type: "${nodeType}"`);
  }
  return handler(step, { vars });
}
