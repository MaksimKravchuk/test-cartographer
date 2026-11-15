import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { disagreements, Workspace } from '@tc/model';
import { onboard } from '../src/agents/onboard.ts';

const repo = resolve(import.meta.dirname, '../../..');

test('review (scripted): reads code, quotes both sides, and the requirement wins over the code', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-review-'));
  try {
    await cp(join(repo, 'workspace'), dir, { recursive: true, filter: (src) => !src.includes('node_modules') && !src.includes(`${join('workspace', 'proposals')}`) });
    // The example workspace points at the demo code relatively; the copy needs it absolute.
    const reg = join(dir, 'sources.yaml');
    await writeFile(reg, (await readFile(reg, 'utf8')).replace('../demo/shop', join(repo, 'demo/shop')));
    const ws = new Workspace(dir);

    const [p] = await onboard(ws, undefined, { provider: 'scripted', mode: 'review' });
    assert.match(p.id, /-review-order$/);
    assert.deepEqual(p.ops.map((o) => o.op === 'add' && o.value.action), ['cancel', 'expire']);
    const code = p.evidence.find((e) => e.source === 'shop-code' && e.path?.startsWith('domain.ts#L45'));
    assert.ok(code, 'the code quote carries its file and line');

    const { sources, usePriority } = await ws.sourceRegistry();
    const [d] = disagreements([p], sources, usePriority);
    assert.equal(d.finding.kind, 'contradiction');
    assert.equal(d.winner, 'product-overview');
    assert.equal(disagreements([p], sources, false)[0].winner, undefined); // priorities off: nobody wins
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('model() lists entities; model({ entity }) gives one, and an unknown id says which exist', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-model-'));
  try {
    await cp(join(repo, 'workspace'), dir, { recursive: true, filter: (src) => !src.includes('node_modules') });
    await writeFile(join(dir, 'agents/onboarding.yaml'), 'steps:\n  - call: model\n  - call: model\n    input: { entity: order }\n  - call: model\n    input: { entity: nope }\n');
    await assert.rejects(onboard(new Workspace(dir), undefined, { provider: 'scripted' }), /No entity “nope”: there are .*order/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('onboarding refuses changes to an entity that is neither in the model nor added', async () => {
  const dir = join(repo, `.tc-test-${process.pid}-stray`);
  try {
    await cp(join(repo, 'workspace'), dir, { recursive: true, filter: (src) => !src.includes('node_modules') });
    await writeFile(
      join(dir, 'agents/onboarding.yaml'),
      'steps:\n  - call: propose\n    input: { rationale: r, entities: { ghost: { ops: [], findings: [] } } }\n',
    );
    await assert.rejects(onboard(new Workspace(dir), undefined, { provider: 'scripted' }), /No entity “ghost”: there are .*order/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an entity group with nothing in it leaves no proposal', async () => {
  const dir = join(repo, `.tc-test-${process.pid}-empty`);
  try {
    await cp(join(repo, 'workspace'), dir, { recursive: true, filter: (src) => !src.includes('node_modules') });
    await writeFile(join(dir, 'agents/onboarding.yaml'), 'steps:\n  - call: propose\n    input: { rationale: r, entities: { order: { ops: [], findings: [] } } }\n');
    assert.deepEqual(await onboard(new Workspace(dir), undefined, { provider: 'scripted' }), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
