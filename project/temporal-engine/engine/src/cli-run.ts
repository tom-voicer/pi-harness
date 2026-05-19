const { start, status, result, disconnect } = require('./client');
const fs = require('fs');

async function run(def: any) {
  console.log(`📤 Starting: ${def.name}`);
  const { id } = await start(def);
  console.log(`   ID: ${id}\n`);

  for (let i = 0; i < 45; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const s = await status(id);
    const pct = s.totalSteps ? Math.round((s.completedSteps ?? 0) / s.totalSteps * 100) : 0;
    process.stdout.write(`\r   [${s.status}] step ${s.currentStep}/${s.totalSteps} (${pct}%)`);
    if (s.status !== 'running') break;
  }
  console.log('');

  const r = await result(id);
  console.log(`\n📊 ${r.status} — ${r.stepsExecuted} steps`);
  if (r.results) {
    for (const s of r.results) {
      console.log(`   ${s.ok ? '✅' : '❌'} [${s.type}] ${s.output.slice(0, 80)}`);
    }
  }
  if (r.error) console.log(`   ❌ ${r.error}`);

  await disconnect();
}

// CLI
const arg = process.argv[2];
if (!arg) {
  console.error('Usage:');
  console.error('  npx ts-node src/cli-run.ts <file.json>');
  console.error('  npx ts-node src/cli-run.ts --inline \'{"name":"t","steps":[...]}\'');
  console.error('  echo \'{"name":"t",...}\' | npx ts-node src/cli-run.ts -');
  process.exit(1);
}

let def: any;
if (arg === '--inline') {
  def = JSON.parse(process.argv[3]);
} else if (arg === '-') {
  def = JSON.parse(fs.readFileSync(0, 'utf8'));
} else {
  def = JSON.parse(fs.readFileSync(arg, 'utf8'));
}

run(def).catch(e => { console.error('❌', e.message); process.exit(1); });
