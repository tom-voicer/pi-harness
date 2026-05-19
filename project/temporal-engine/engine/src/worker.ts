import { Worker } from '@temporalio/worker';
import * as activities from './activities';

async function main() {
  const worker = await Worker.create({
    workflowsPath: require.resolve('./workflow'),
    activities,
    taskQueue: 'dynamic-workflows',
  });

  console.log('🚀 Engine worker running');
  console.log('   Task queue : dynamic-workflows');
  console.log('   Server     : localhost:7233');
  console.log('   UI         : http://localhost:8080');
  console.log('   (Press Ctrl+C to stop)');
  console.log('');

  await worker.run();
}

main().catch((err) => {
  console.error('Worker crashed:', err);
  process.exit(1);
});
