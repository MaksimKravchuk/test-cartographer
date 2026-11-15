// The `tc` command line over a copy of the demo workspace.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import YAML from 'yaml';
import { copyWorkspace, repo } from '../../../../tests/fixtures.ts';

let ws: Awaited<ReturnType<typeof copyWorkspace>>;
before(async () => (ws = await copyWorkspace()));
after(() => ws.remove());

const tc = (...args: string[]) =>
  promisify(execFile)(process.execPath, [join(repo, 'packages/engine/src/cli.ts'), ...args, '--ws', ws.root]).then(
    (r) => ({ code: 0, out: r.stdout }),
    (e) => ({ code: e.code as number, out: `${e.stdout}${e.stderr}` }),
  );

test('validate passes on the demo model', async () => {
  const r = await tc('validate');
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /✖/);
});

test('compile writes Playwright specs and a config', async () => {
  const r = await tc('compile');
  assert.equal(r.code, 0, r.out);
  const files = await readdir(join(ws.root, 'generated'));
  assert.ok(files.includes('playwright.config.ts'));
  assert.ok(files.some((f) => f.endsWith('.spec.ts')));
});

test('plan and backlog print without errors', async () => {
  for (const cmd of ['plan', 'backlog']) {
    const r = await tc(cmd);
    assert.equal(r.code, 0, `${cmd}: ${r.out}`);
    assert.ok(r.out.trim().length > 0);
  }
});

test('validate fails with exit code 1 on a broken model', async () => {
  const file = join(ws.root, 'entities', 'listing.yaml');
  const listing = YAML.parse(await readFile(file, 'utf8'));
  listing.transitions[0].to = 'no-such-state';
  await writeFile(file, YAML.stringify(listing));
  const r = await tc('validate');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /✖ .*no-such-state/);
});
