/**
 * Custom nodes test — register web_search, web_crawl, web_extract and run a chained workflow.
 * Start this as the worker: npx ts-node src/worker-with-nodes.ts
 */
import { Worker } from '@temporalio/worker';
import * as activities from './activities';
import { registerNode } from './nodes/registry';
import { createWebSearchNode } from './nodes/library/web-search';
import { createWebCrawlNode } from './nodes/library/web-crawl';
import { createWebExtractNode } from './nodes/library/web-extract';
import { createWorkflowRunNode } from './nodes/library/workflow-run';

// Register custom nodes BEFORE Worker.create()
const searxngUrl = process.env.SEARXNG_URL || 'http://127.0.0.1:8081';
registerNode('web_search', createWebSearchNode({ searxngUrl }));
registerNode('web_crawl', createWebCrawlNode());
registerNode('web_extract', createWebExtractNode());
registerNode('workflow_run', createWorkflowRunNode());

console.log(`Custom nodes registered: web_search (${searxngUrl}), web_crawl, web_extract, workflow_run`);

async function main() {
  const worker = await Worker.create({
    workflowsPath: require.resolve('./workflow'),
    activities,
    taskQueue: 'dynamic-workflows',
  });
  console.log('🚀 Engine worker running (with custom nodes)');
  await worker.run();
}

main().catch(err => { console.error(err); process.exit(1); });
