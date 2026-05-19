import {
  proxyActivities,
  sleep,
  log,
  setHandler,
  defineQuery,
} from '@temporalio/workflow';
import type * as activities from './activities';
import {
  interpolate,
  resolveValue,
  evaluateCondition,
  setVariable,
  countSteps,
} from './executor';
import type {
  WorkflowDefinition,
  ExecutionContext,
  StepResult,
  WorkflowProgress,
  WorkflowStatus,
} from './types';

const { logActivity, httpActivity } = proxyActivities<typeof activities>({
  startToCloseTimeout: '2 minutes',
  retry: { maximumAttempts: 1 },
});

// ─── Progress (mutable during execution, exposed via query) ──

interface ProgressState {
  name: string;
  status: WorkflowStatus;
  currentStep: number;
  totalSteps: number;
  completedSteps: number;
  partialResults: StepResult[];
}

let progress: ProgressState = {
  name: '',
  status: 'running',
  currentStep: 0,
  totalSteps: 0,
  completedSteps: 0,
  partialResults: [],
};

export const getProgress = defineQuery<WorkflowProgress | null>('getProgress');

// ─── Step counter (deterministic, runs once) ─────────────────

let stepCounter = 0;

// ─── Recursive step executor ─────────────────────────────────

async function executeSteps(
  steps: import('./types').Step[],
  ctx: ExecutionContext,
): Promise<StepResult[]> {
  const results: StepResult[] = [];

  for (const step of steps) {
    stepCounter++;
    progress.currentStep = stepCounter;

    const stepStart = Date.now();
    let ok = true;
    let output = '';

    try {
      switch (step.type) {
        // ── leaf actions ──────────────────────────────────
        case 'log': {
          const msg = interpolate(step.message, ctx);
          output = await logActivity(msg);
          break;
        }

        case 'http': {
          const url = interpolate(step.url, ctx);
          const hdrs = step.headers
            ? Object.fromEntries(
                Object.entries(step.headers).map(([k, v]) => [k, interpolate(v, ctx)]),
              )
            : undefined;
          const res = await httpActivity(
            interpolate(step.method, ctx) as string,
            url,
            hdrs,
            step.body,
          );
          output = JSON.stringify(res);
          break;
        }

        case 'sleep': {
          const seconds = step.duration || 1;
          await sleep(seconds * 1000);
          output = `Slept for ${seconds}s`;
          break;
        }

        // ── variable manipulation ─────────────────────────
        case 'set': {
          const val = resolveValue(step.value, ctx);
          setVariable(ctx, step.variable, val);
          output = `${step.variable} = ${JSON.stringify(val)}`;
          break;
        }

        // ── control flow ─────────────────────────────────
        case 'if': {
          const cond = evaluateCondition(step.condition, ctx);
          const branch = cond ? step.then : step.else;
          if (branch) {
            const sub = await executeSteps(branch, ctx);
            results.push(...sub);
          }
          output = `branch: ${cond ? 'then' : (step.else ? 'else' : 'skipped')}`;
          break;
        }

        case 'for': {
          const items = resolveValue(step.over, ctx);
          if (!Array.isArray(items)) {
            throw new Error(`for: "over" must resolve to an array, got ${typeof items}`);
          }
          if (items.length === 0) {
            output = 'no items';
            break;
          }
          log.info(`🔁 for over ${items.length} items`);
          for (let i = 0; i < items.length; i++) {
            ctx.vars[step.as] = items[i];
            const sub = await executeSteps(step.steps, ctx);
            results.push(...sub);
          }
          output = `iterated ${items.length} items`;
          break;
        }

        case 'fork': {
          log.info(`⚡ fork: ${step.branches.length} branches`);
          const branchPromises = step.branches.map((branch) => {
            const branchCtx: ExecutionContext = { vars: { ...ctx.vars } };
            return executeSteps(branch.steps, branchCtx);
          });
          const branchResults = await Promise.all(branchPromises);
          for (const br of branchResults) {
            results.push(...br);
          }
          output = `${step.branches.length} branches completed`;
          break;
        }

        default:
          throw new Error(`Unknown step type: ${(step as any).type}`);
      }

      progress.completedSteps++;
      const sr: StepResult = {
        step: stepCounter,
        type: step.type,
        ok,
        output,
        durationMs: Date.now() - stepStart,
      };
      results.push(sr);
      progress.partialResults.push(sr);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`❌ Step ${stepCounter} [${step.type}] failed: ${message}`);

      const sr: StepResult = {
        step: stepCounter,
        type: step.type,
        ok: false,
        output: message,
        durationMs: Date.now() - stepStart,
      };
      results.push(sr);

      // Fail-fast: stop executing further steps
      throw err;
    }
  }

  return results;
}

// ─── Main workflow function ──────────────────────────────────

export async function workflowRunner(input: WorkflowDefinition): Promise<{
  name: string;
  status: 'completed';
  stepsExecuted: number;
  results: StepResult[];
}> {
  log.info(`🏁 Starting workflow: ${input.name}`);
  const t0 = Date.now();

  // Initialize progress
  progress = {
    name: input.name,
    status: 'running',
    currentStep: 0,
    totalSteps: countSteps(input.steps),
    completedSteps: 0,
    partialResults: [],
  };

  // Register query handler for live progress inspection
  setHandler(getProgress, (): WorkflowProgress | null => {
    if (progress.status !== 'running') return null;
    return { ...progress, status: 'running' };
  });

  // Reset step counter (deterministic — runs once per workflow)
  stepCounter = 0;

  const ctx: ExecutionContext = { vars: {} };

  // Inject external input if provided
  if (input.input) {
    ctx.vars.input = input.input;
  }
  const results = await executeSteps(input.steps, ctx);

  progress.status = 'completed';
  log.info(`✅ Workflow complete: ${input.name} (${Date.now() - t0}ms)`);

  return {
    name: input.name,
    status: 'completed',
    stepsExecuted: results.length,
    results,
  };
}
