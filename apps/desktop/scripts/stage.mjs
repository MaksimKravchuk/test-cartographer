// Stages what the packaged app ships next to Electron (see "build" in
// package.json): the engine with its production dependencies, the built GUI
// and the demo project. Electron runs the engine as Node (ELECTRON_RUN_AS_NODE).
import { execFileSync } from 'node:child_process';
import { cpSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(desktop, '../..');
const out = join(desktop, 'build');
rmSync(out, { recursive: true, force: true });

const engine = join(out, 'engine');
execFileSync('pnpm', ['--filter', '@tc/engine', 'deploy', '--prod', '--config.node-linker=hoisted', engine], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
rmSync(join(engine, 'test'), { recursive: true, force: true });

// Node won't strip types from .ts files under node_modules, so @tc/model ships
// compiled. Its own dependencies stay external to share one zod with the engine.
const model = join(engine, 'node_modules/@tc/model');
rmSync(model, { recursive: true, force: true });
await build({
  entryPoints: { index: join(root, 'packages/model/src/index.ts'), schema: join(root, 'packages/model/src/schema.ts') },
  outdir: model,
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'node',
  external: ['zod', 'yaml'],
});
writeFileSync(join(model, 'package.json'), JSON.stringify({ name: '@tc/model', type: 'module', exports: { '.': './index.js', './schema': './schema.js' } }, null, 2));

// The demo shop goes inside the engine folder to resolve the engine's dependencies.
cpSync(join(root, 'demo/shop'), join(engine, 'demo-shop'), { recursive: true, filter: (src) => !/[\\/]node_modules$/.test(src) });
cpSync(join(desktop, 'dist'), join(out, 'gui'), { recursive: true });
cpSync(join(root, 'workspace'), join(out, 'demo'), {
  recursive: true,
  filter: (src) => !/[\\/](node_modules|runs|generated|export)$/.test(src),
});
