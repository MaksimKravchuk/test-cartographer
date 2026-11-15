// Smoke test of the packaged app: `node scripts/smoke.mjs <app executable>`.
// Starts it like a first launch and checks the engine, GUI, demo shop and a test run.
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const port = 4398;
const api = `http://127.0.0.1:${port}`;
const app = spawn(process.argv[2], process.platform === 'linux' ? ['--no-sandbox'] : [], { env: { ...process.env, TC_PORT: String(port) }, stdio: 'inherit' });
const until = async (what, fn, seconds) => {
  for (let i = 0; i < seconds; i++) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Timed out waiting for ${what}`);
};

try {
  const { root } = await until('the engine', async () => (await fetch(`${api}/api/project`)).json(), 90);
  assert.match(root, /Test Cartographer[\\/]Demo shop$/);
  assert.match(await (await fetch(api)).text(), /<!doctype html>/i);
  assert.equal((await until('the demo shop', () => fetch('http://localhost:4400/client/'), 30)).status, 200);

  await fetch(`${api}/api/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ entity: 'order' }) });
  const runs = join(root, 'runs');
  const report = await until('the test run', async () => readdirSync(runs).find((f) => /Z\.json$/.test(f) && !f.includes('playwright')), 240);
  const results = Object.values(JSON.parse(readFileSync(join(runs, report), 'utf8')).results);
  const passed = results.filter((r) => r.status === 'passed').length;
  console.log(`Packaged app ran ${results.length} scenarios, ${passed} passed`);
  assert.ok(passed > 100, 'most demo scenarios should pass');
} finally {
  app.kill();
}
