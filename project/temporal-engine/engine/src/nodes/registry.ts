/**
 * Node Registry — extensible step-type registration for the workflow engine.
 * Handlers are Temporal activities: they get retries, timeouts, and all Temporal guarantees.
 */

const BUILTIN_TYPES = new Set(['set', 'log', 'http', 'sleep', 'if', 'for', 'fork']);

export type CustomNodeHandler = (
  step: Record<string, unknown>,
  ctx: { vars: Record<string, unknown> },
) => Promise<string>;

const handlers = new Map<string, CustomNodeHandler>();

/**
 * Register a custom step type. Must be called BEFORE Worker.create().
 * Throws if the type name collides with a built-in.
 */
export function registerNode(type: string, handler: CustomNodeHandler): void {
  if (BUILTIN_TYPES.has(type)) {
    throw new Error(`Cannot override built-in step type: "${type}"`);
  }
  if (handlers.has(type)) {
    throw new Error(`Custom node type already registered: "${type}"`);
  }
  handlers.set(type, handler);
}

/**
 * Look up a handler by type name.
 */
export function getHandler(type: string): CustomNodeHandler | undefined {
  return handlers.get(type);
}

/**
 * List all registered custom node type names.
 */
export function listCustomNodes(): string[] {
  return [...handlers.keys()];
}

/**
 * Collect all registered handlers as Temporal activities (keyed by prefixed name).
 */
export function getCustomActivities(): Record<string, (...args: any[]) => Promise<unknown>> {
  const acts: Record<string, (...args: any[]) => Promise<unknown>> = {};
  for (const [name, handler] of handlers) {
    acts[`custom_${name}`] = async (step: Record<string, unknown>, vars: Record<string, unknown>) => {
      return handler(step, { vars });
    };
  }
  return acts;
}
