import type { Step, Condition, ExecutionContext } from './types';

// ─── Variable resolution ─────────────────────────────────────

const VAR_RE = /\{\{vars\.(.+?)\}\}/g;

/**
 * Resolve {{vars.x.y}} references in a string against the context.
 */
export function interpolate(template: string, ctx: ExecutionContext): string {
  return template.replace(VAR_RE, (_match, path: string) => {
    const value = getByPath(ctx.vars, path.trim());
    return value === undefined ? `{{vars.${path.trim()}}}` : String(value);
  });
}

/**
 * Resolve a value — if it's a var reference like "{{vars.x}}" resolve it,
 * otherwise return as-is. Works for strings, numbers, booleans.
 */
export function resolveValue(value: unknown, ctx: ExecutionContext): unknown {
  if (typeof value === 'string') {
    const match = value.match(/^\{\{vars\.(.+?)\}\}$/);
    if (match) {
      const resolved = getByPath(ctx.vars, match[1].trim());
      return resolved !== undefined ? resolved : value;
    }
    return interpolate(value, ctx);
  }
  return value;
}

function getByPath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function setByPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!(parts[i] in current) || typeof current[parts[i]] !== 'object') {
      current[parts[i]] = {};
    }
    current = current[parts[i]] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}

// ─── Condition evaluation ────────────────────────────────────

export function evaluateCondition(cond: Condition, ctx: ExecutionContext): boolean {
  switch (cond.type) {
    case 'eq':
    case 'neq':
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const c = cond as { left: unknown; right: unknown };
      const left = resolveValue(c.left, ctx);
      const right = resolveValue(c.right, ctx);
      switch (cond.type) {
        case 'eq':  return left == right;
        case 'neq': return left != right;
        case 'gt':  return Number(left) >  Number(right);
        case 'gte': return Number(left) >= Number(right);
        case 'lt':  return Number(left) <  Number(right);
        case 'lte': return Number(left) <= Number(right);
      }
    }
    case 'and': return cond.conditions.every(c => evaluateCondition(c, ctx));
    case 'or':  return cond.conditions.some(c => evaluateCondition(c, ctx));
    case 'not': return !evaluateCondition(cond.condition, ctx);
    default:    return false;
  }
}

// ─── Step counting (for totalSteps in progress) ──────────────

export function countSteps(steps: Step[]): number {
  let count = 0;
  for (const step of steps) {
    count++;
    switch (step.type) {
      case 'if':
        count += countSteps(step.then);
        if (step.else) count += countSteps(step.else);
        break;
      case 'for':
        count += countSteps(step.steps);
        break;
      case 'fork':
        for (const branch of step.branches) {
          count += countSteps(branch.steps);
        }
        break;
    }
  }
  return count;
}

// ─── Variable setting (exports for workflow use) ─────────────

export function setVariable(ctx: ExecutionContext, variable: string, value: unknown): void {
  setByPath(ctx.vars, variable, value);
}
