/**
 * workflow_run custom node — run a sub-workflow from within another workflow.
 *
 * This is a metadata-only registration. The actual execution happens as a
 * built-in case in workflow.ts using Temporal's executeChild() for native
 * child workflow support (proper parent-child tree, cancellation cascade,
 * no activity timeout constraints).
 *
 * Registration here keeps the node discoverable via listCustomNodes()
 * and documents its shape alongside other library nodes.
 */
import type { CustomNodeHandler } from '../registry';

export function createWorkflowRunNode(): CustomNodeHandler {
  return async (_step) => {
    // This handler is never actually called — the workflow_run step is
    // intercepted and executed by a built-in case in workflow.ts before
    // it reaches the default: → customNodeActivity dispatch path.
    //
    // If it is reached (e.g., worker started without the updated workflow.ts),
    // surface a clear error.
    throw new Error(
      'workflow_run must be handled as a built-in step by workflow.ts. ' +
      'Make sure you are running the latest version of the engine.',
    );
  };
}
