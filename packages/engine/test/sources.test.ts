import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Project, Workspace } from '@tc/model';
import { checkSources } from '../src/sources.ts';

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
