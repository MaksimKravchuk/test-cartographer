// Shared by integration and e2e tests: a throwaway copy of the demo workspace
// and the demo shop it models.
import { spawn, type ChildProcess } from 'node:child_process';
import { cp, mkdtemp, rm, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export const repo = resolve(import.meta.dirname, '..');
export const SHOP_URL = 'http://localhost:4400';

// The copy sits next to workspace/: cartographer.yaml reaches the demo MCP
// server by a relative path (../demo/shop/mcp.ts) and generated specs resolve
// @playwright/test and @tc/engine through workspace/node_modules.
export async function copyWorkspace(): Promise<{ root: string; remove(): Promise<void> }> {
  const root = await mkdtemp(join(repo, '.tc-test-'));
  await cp(join(repo, 'workspace'), root, {
    recursive: true,
    filter: (src) => !/[\\/]workspace[\\/](node_modules|runs|generated|export)([\\/]|$)/.test(src),
  });
  await symlink(join(repo, 'workspace', 'node_modules'), join(root, 'node_modules'), 'dir');
  return { root, remove: () => rm(root, { recursive: true, force: true }) };
}

async function up(url: string): Promise<boolean> {
  return fetch(url, { signal: AbortSignal.timeout(1000) }).then((r) => r.ok, () => false);
}

export async function waitFor(url: string, ms = 20_000): Promise<void> {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await new Promise((r) => setTimeout(r, 200))) if (await up(url)) return;
  throw new Error(`${url} did not come up in ${ms} ms`);
}

// Starts the demo shop unless one is already running; stop() only stops ours.
export async function startShop(): Promise<{ stop(): void }> {
  if (await up(`${SHOP_URL}/api/openapi.json`)) return { stop() {} };
  const child: ChildProcess = spawn(process.execPath, [join(repo, 'demo/shop/server.ts')], { stdio: 'ignore' });
  await waitFor(`${SHOP_URL}/api/openapi.json`);
  return { stop: () => child.kill() };
}
