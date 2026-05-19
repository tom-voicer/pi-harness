/**
 * Smoke test: exercises all step types end-to-end.
 * Run with: npx ts-node test/smoke.ts
 */
import {
  start,
  status,
  result,
  disconnect,
} from '../engine/src/index';
import type { WorkflowDefinition } from '../engine/src/types';

const definition: WorkflowDefinition = {
  name: 'Smoke Test',
  steps: [
    // set — store variables
    { type: 'set', variable: 'threshold', value: 500 },
    { type: 'set', variable: 'greeting', value: 'Hello from engine' },

    // log — print to stdout (with var interpolation)
    { type: 'log', message: '{{vars.greeting}} — threshold is {{vars.threshold}}' },

    // http — fetch external API
    {
      type: 'http',
      method: 'GET',
      url: 'https://jsonplaceholder.typicode.com/posts/1',
    },

    // sleep — pause 1 second
    { type: 'sleep', duration: 1 },

    // if/else — conditional branching
    {
      type: 'if',
      condition: { type: 'gte', left: '{{vars.threshold}}', right: 500 },
      then: [
        { type: 'log', message: 'Threshold met (>= 500) — taking then branch' },
        { type: 'set', variable: 'branch', value: 'then' },
      ],
      else: [
        { type: 'log', message: 'Threshold not met — taking else branch' },
        { type: 'set', variable: 'branch', value: 'else' },
      ],
    },

    // for — iterate over array
    { type: 'set', variable: 'items', value: [
      { name: 'Alice', role: 'admin' },
      { name: 'Bob', role: 'editor' },
    ]},
    {
      type: 'for',
      over: '{{vars.items}}',
      as: 'item',
      steps: [
        { type: 'log', message: 'Processing {{vars.item.name}} ({{vars.item.role}})' },
        { type: 'http', method: 'GET', url: 'https://jsonplaceholder.typicode.com/posts/1' },
      ],
    },

    // fork — run two branches in parallel
    {
      type: 'fork',
      branches: [
        {
          name: 'branch-a',
          steps: [
            { type: 'log', message: 'Branch A: starting' },
            { type: 'sleep', duration: 1 },
            { type: 'log', message: 'Branch A: done' },
          ],
        },
        {
          name: 'branch-b',
          steps: [
            { type: 'log', message: 'Branch B: starting' },
            { type: 'http', method: 'GET', url: 'https://jsonplaceholder.typicode.com/users/1' },
            { type: 'log', message: 'Branch B: done' },
          ],
        },
      ],
    },

    // Final log
    { type: 'log', message: '✅ Smoke test complete — branch: {{vars.branch}}' },
  ],
};

async function main() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Engine Smoke Test');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');

  // 1. Start workflow
  console.log('1. Starting workflow...');
  const { id } = await start(definition);
  console.log(`   ID: ${id}`);
  console.log('');

  // 2. Poll status while running
  console.log('2. Polling status...');
  for (let i = 0; i < 8; i++) {
    await new Promise(r => setTimeout(r, 1500));
    const s = await status(id);
    const pct = s.totalSteps ? Math.round((s.completedSteps ?? 0) / s.totalSteps * 100) : 0;
    console.log(`   [${s.status}] step ${s.currentStep ?? '?'}/${s.totalSteps ?? '?'} (${pct}%) ${s.completedSteps ?? 0} done`);
    if (s.status !== 'running') break;
  }
  console.log('');

  // 3. Get final result
  console.log('3. Final result...');
  const r = await result(id);
  console.log(`   Status: ${r.status}`);
  console.log(`   Steps executed: ${r.stepsExecuted}`);
  if (r.results) {
    for (const step of r.results) {
      const icon = step.ok ? '✅' : '❌';
      const dur = (step.durationMs / 1000).toFixed(2);
      const out = step.output.slice(0, 80);
      console.log(`   ${icon} Step ${step.step} [${step.type}] (${dur}s) ${out}`);
    }
  }
  if (r.error) {
    console.log(`   ❌ Error: ${r.error}`);
  }
  console.log('');

  await disconnect();
  console.log('✅ Smoke test passed');
}

main().catch((err) => {
  console.error('❌ Smoke test failed:', err);
  process.exit(1);
});
