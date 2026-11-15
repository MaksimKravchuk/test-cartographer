// Playwright's web server for e2e: the demo shop plus `tc serve` with the
// built GUI over a throwaway copy of the demo workspace.
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyWorkspace, repo, startShop } from '../fixtures.ts';

const [ws, shop] = await Promise.all([copyWorkspace(), startShop()]);
const engine = spawn(process.execPath, [join(repo, 'packages/engine/src/cli.ts'), 'serve', '--port', process.env.TC_E2E_PORT ?? '4319', '--ws', ws.root], {
  stdio: 'inherit',
  env: { ...process.env, TC_HOME: process.env.TC_HOME ?? (await mkdtemp(join(tmpdir(), 'tc-home-'))) },
});
const stop = async () => {
  engine.kill();
  shop.stop();
  await ws.remove();
  process.exit(0);
};
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => void stop());
engine.on('exit', (code) => {
  if (code) process.exit(code);
});
