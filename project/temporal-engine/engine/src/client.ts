import { Client, Connection } from '@temporalio/client';
import type { WorkflowDefinition, RunStatus, RunSummary } from './types';
import { getProgress } from './workflow';

let connection: Connection | null = null;
let client: Client | null = null;

async function getClient(): Promise<Client> {
  if (!client) {
    connection = await Connection.connect({ address: 'localhost:7233' });
    client = new Client({ connection, namespace: 'default' });
  }
  return client;
}

/**
 * Start a workflow from a definition. Returns immediately with the workflow ID.
 */
export async function start(def: WorkflowDefinition): Promise<{ id: string; name: string; status: 'running' }> {
  const c = await getClient();
  const workflowId = `${def.name.replace(/\s+/g, '-')}-${Date.now()}`;

  await c.workflow.start('workflowRunner', {
    args: [def],
    taskQueue: 'dynamic-workflows',
    workflowId,
  });

  return { id: workflowId, name: def.name, status: 'running' };
}

/**
 * Query live progress of a running workflow (non-blocking).
 */
export async function status(workflowId: string): Promise<RunStatus> {
  const c = await getClient();
  const handle = c.workflow.getHandle(workflowId);
  const desc = await handle.describe();

  // Check if completed/failed first
  if (desc.status.name === 'COMPLETED') {
    const result = await handle.result();
    return {
      id: workflowId,
      name: (result as any)?.name ?? '',
      status: 'completed',
      stepsExecuted: (result as any)?.stepsExecuted,
      results: (result as any)?.results,
      startedAt: desc.startTime?.toString(),
      completedAt: desc.closeTime?.toString(),
    };
  }

  if (desc.status.name === 'FAILED') {
    return {
      id: workflowId,
      name: '',
      status: 'failed',
      error: 'Workflow execution failed',
      startedAt: desc.startTime?.toString(),
      completedAt: desc.closeTime?.toString(),
    };
  }

  if (desc.status.name === 'CANCELLED') {
    return {
      id: workflowId,
      name: '',
      status: 'cancelled',
      startedAt: desc.startTime?.toString(),
      completedAt: desc.closeTime?.toString(),
    };
  }

  // Running: query progress
  try {
    const progress = await handle.query(getProgress);
    if (progress) {
      return {
        id: workflowId,
        name: progress.name,
        status: progress.status,
        currentStep: progress.currentStep,
        totalSteps: progress.totalSteps,
        completedSteps: progress.completedSteps,
        partialResults: progress.partialResults,
        startedAt: desc.startTime?.toString(),
      };
    }
  } catch {
    // Query might fail if workflow hasn't started yet
  }

  return {
    id: workflowId,
    name: '',
    status: 'running',
    startedAt: desc.startTime?.toString(),
  };
}

/**
 * Block until the workflow completes, then return the final result.
 */
export async function result(workflowId: string): Promise<RunStatus> {
  const c = await getClient();
  const handle = c.workflow.getHandle(workflowId);

  try {
    const desc = await handle.describe();
    const final = await handle.result();
    return {
      id: workflowId,
      name: (final as any)?.name ?? '',
      status: 'completed',
      stepsExecuted: (final as any)?.stepsExecuted,
      results: (final as any)?.results,
      startedAt: desc.startTime?.toString(),
      completedAt: desc.closeTime?.toString(),
    };
  } catch (err: unknown) {
    const desc = await handle.describe();
    return {
      id: workflowId,
      name: '',
      status: desc.status.name === 'CANCELLED' ? 'cancelled' : 'failed',
      error: (err as Error).message,
      startedAt: desc.startTime?.toString(),
      completedAt: desc.closeTime?.toString(),
    };
  }
}

/**
 * List recent workflow executions.
 */
export async function list(options?: { limit?: number }): Promise<RunSummary[]> {
  const c = await getClient();
  const limit = options?.limit ?? 20;
  const resp = await c.workflow.list({
    query: 'TaskQueue = "dynamic-workflows"',
    pageSize: limit,
  });

  const summaries: RunSummary[] = [];
  for await (const info of resp) {
    summaries.push({
      id: (info as any).execution?.workflowId ?? (info as any).workflowId ?? '',
      name: (info as any).type?.name ?? (info as any).execution?.workflowId ?? '',
      status: info.status.name,
      startedAt: info.startTime?.toString(),
    });
  }
  return summaries;
}

/**
 * Cancel a running workflow.
 */
export async function cancel(workflowId: string): Promise<void> {
  const c = await getClient();
  const handle = c.workflow.getHandle(workflowId);
  await handle.cancel();
}

/**
 * Close the underlying Temporal connection.
 */
export async function disconnect(): Promise<void> {
  if (connection) {
    connection.close();
    connection = null;
    client = null;
  }
}
