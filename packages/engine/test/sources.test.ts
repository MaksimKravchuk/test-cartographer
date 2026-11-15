import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Project, Workspace } from '@tc/model';
import { checkSources, insideCode, searchCode } from '../src/sources.ts';

test('checkSources: file, code folder (skipping node_modules), missing folder, MCP tool outside the allowlist', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-sources-'));
  try {
    const ws = new Workspace(dir);
    await mkdir(join(dir, 'app', 'src'), { recursive: true });
    await mkdir(join(dir, 'app', 'node_modules', 'x'), { recursive: true });
    await writeFile(join(dir, 'app', 'src', 'a.ts'), '');
    await writeFile(join(dir, 'app', 'b.ts'), '');
    await writeFile(join(dir, 'app', 'node_modules', 'x', 'c.js'), '');
    await ws.addSource({ name: 'spec.md', content: 'one\ntwo' });
    await ws.addLinkedSource({ kind: 'code', path: 'app' });
    await ws.addLinkedSource({ kind: 'code', path: 'nope', title: 'Missing' });
    await ws.addLinkedSource({ kind: 'mcp', read: { tool: 'wiki.list_pages', args: {} }, title: 'Wiki' });
    const project = Project.parse({
      name: 't',
      interfaces: [{ id: 'ui', title: 'UI', baseUrl: 'http://localhost' }],
      roles: [{ id: 'user', title: 'User', interface: 'ui' }],
      mcp: { wiki: { command: 'false', allow: { read: [] } } },
    });
    const byId = Object.fromEntries((await checkSources(ws, project)).map((c) => [c.id, c]));
    assert.deepEqual(byId.spec, { id: 'spec', ok: true, detail: '2 lines' });
    assert.deepEqual(byId.app, { id: 'app', ok: true, detail: '2 files' });
    assert.equal(byId.missing.ok, false);
    assert.match(byId.missing.detail, /No folder/);
    assert.equal(byId.wiki.ok, false);
    assert.match(byId.wiki.detail, /not allowed/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('insideCode: symlinks out of the folder or to a .env file are refused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-code-'));
  try {
    await mkdir(join(dir, 'app'));
    await writeFile(join(dir, 'secret.txt'), 'x');
    await writeFile(join(dir, 'app', '.env'), 'TOKEN=1');
    await writeFile(join(dir, 'app', 'ok.ts'), '');
    await symlink(join(dir, 'secret.txt'), join(dir, 'app', 'out.ts'));
    await symlink(join(dir, 'app', '.env'), join(dir, 'app', 'config.ts'));
    const root = join(dir, 'app');
    assert.equal((await insideCode(root, 'ok.ts')).rel, 'ok.ts');
    await assert.rejects(() => insideCode(root, 'out.ts'), /outside/);
    await assert.rejects(() => insideCode(root, 'config.ts'), /outside/);
    await assert.rejects(() => insideCode(root, '../secret.txt'), /outside/);
    await assert.rejects(() => insideCode(root, 'missing.ts'), /No file/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('searchCode: hits carry file and line; no match says how much was searched; .env and node_modules stay out', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-search-'));
  try {
    await mkdir(join(dir, 'src'), { recursive: true });
    await mkdir(join(dir, 'node_modules'), { recursive: true });
    await writeFile(join(dir, 'src', 'routes.ts'), "const x = 1;\napp.post('/orders/:id/cancel', cancel);\n");
    await writeFile(join(dir, 'node_modules', 'lib.js'), "app.post('/hidden')");
    await writeFile(join(dir, '.env'), "SECRET=app.post('/secret')");
    assert.equal(await searchCode(dir, 'app\\.(get|post)\\('), "src/routes.ts:2: app.post('/orders/:id/cancel', cancel);\n(searched 1 of 1 files)");
    assert.equal(await searchCode(dir, 'CRON', { dir: 'src', ignoreCase: true }), 'no match (searched 1 of 1 files under src/)');
    await assert.rejects(searchCode(dir, '('), /Bad pattern/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
