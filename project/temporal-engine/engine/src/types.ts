// ─── Condition types ──────────────────────────────────────────

export type Condition =
  | { type: 'eq';  left: unknown; right: unknown }
  | { type: 'neq'; left: unknown; right: unknown }
  | { type: 'gt';  left: unknown; right: unknown }
  | { type: 'gte'; left: unknown; right: unknown }
  | { type: 'lt';  left: unknown; right: unknown }
  | { type: 'lte'; left: unknown; right: unknown }
  | { type: 'and'; conditions: Condition[] }
  | { type: 'or';  conditions: Condition[] }
  | { type: 'not'; condition: Condition };

// ─── Step types ───────────────────────────────────────────────

export interface SetStep {
  type: 'set';
  variable: string;
  value: unknown;
}

export interface LogStep {
  type: 'log';
  message: string;
}

export interface HttpStep {
  type: 'http';
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface SleepStep {
  type: 'sleep';
  duration: number;
}

export interface IfStep {
  type: 'if';
  condition: Condition;
  then: Step[];
  else?: Step[];
}

export interface ForStep {
  type: 'for';
  over: unknown;              // array literal or "{{vars.x}}"
  as: string;                 // variable name for the current item
  steps: Step[];
}

export interface ForkStep {
  type: 'fork';
  branches: { name: string; steps: Step[] }[];
}

export interface WorkflowRunStep {
  type: 'workflow_run';
  definition?: WorkflowDefinition;
  workflow_file?: string;
  workflow_id?: string;
  input?: Record<string, unknown>;
  result_as?: string;
}

export type Step =
  | SetStep
  | LogStep
  | HttpStep
  | SleepStep
  | IfStep
  | ForStep
  | ForkStep
  | WorkflowRunStep;

// ─── Workflow definition ──────────────────────────────────────

export interface WorkflowDefinition {
  name: string;
  steps: Step[];
  input?: Record<string, unknown>;
}

// ─── Execution context ────────────────────────────────────────

export interface ExecutionContext {
  vars: Record<string, unknown>;
}

// ─── Step result ──────────────────────────────────────────────

export interface StepResult {
  step: number;
  type: string;
  ok: boolean;
  output: string;
  durationMs: number;
}

// ─── Progress (queryable mid-execution) ───────────────────────

export interface WorkflowProgress {
  name: string;
  status: 'running';
  currentStep: number;
  totalSteps: number;
  completedSteps: number;
  partialResults: StepResult[];
}

// ─── Final result ─────────────────────────────────────────────

export type WorkflowStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface RunStatus {
  id: string;
  name: string;
  status: WorkflowStatus;
  currentStep?: number;
  totalSteps?: number;
  completedSteps?: number;
  partialResults?: StepResult[];
  stepsExecuted?: number;
  results?: StepResult[];
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface RunSummary {
  id: string;
  name: string;
  status: string;
  startedAt?: string;
}
