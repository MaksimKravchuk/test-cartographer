import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { disagreements, Proposal, Workspace } from '@tc/model';
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

test('clarify (scripted): replaces a finding a person could not answer with single-topic ones, and closes it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-clarify-'));
  try {
    await cp(join(repo, 'workspace'), dir, { recursive: true, filter: (src) => !src.includes('node_modules') && !src.includes(`${join('workspace', 'proposals')}`) });
    const ws = new Workspace(dir);
    await ws.saveProposal(Proposal.parse({
      id: 'bundled', entity: 'order', agent: 'onboarding', createdAt: '2026-11-15T00:00:00Z', baseRevision: 'x', rationale: '',
      findings: [{ kind: 'question', note: 'Where is cancelled shown in the API? Also, is refund built?', refs: ['action:order.cancel'] }],
    }));

    const [p] = await onboard(ws, undefined, { provider: 'scripted', mode: 'clarify', target: { proposal: 'bundled', index: 0 } });
    assert.match(p.id, /-clarify-order$/);
    assert.deepEqual(p.findings.map((f) => f.kind), ['confirmation', 'question']);
    assert.equal(p.evidence[0].source, 'product-overview');

    const [r] = (await ws.proposal('bundled')).resolutions;
    assert.equal(r.verdict, 'clarified');
    assert.match(r.note!, new RegExp(p.id));
    await assert.rejects(onboard(ws, undefined, { provider: 'scripted', mode: 'clarify', target: { proposal: 'bundled', index: 5 } }), /No finding #5/);

    // An answer a person gave while the agent worked stands.
    const answered = await ws.proposal('bundled');
    await ws.saveProposal({ ...answered, resolutions: [{ finding: 0, verdict: 'answered', note: 'Only on the project page', at: '' }] });
    await onboard(ws, undefined, { provider: 'scripted', mode: 'clarify', target: { proposal: 'bundled', index: 0 } });
    assert.equal((await ws.proposal('bundled')).resolutions[0].verdict, 'answered');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a transition that names an action the entity lacks is refused, unless the same call adds the action', async () => {
  const dir = join(repo, `.tc-test-${process.pid}-action`);
  const script = (ops: string) => `steps:\n  - call: propose\n    input: { rationale: r, entities: { order: { ops: [${ops}] } } }\n`;
  const transition = '{ op: add, kind: transition, value: { id: t1, title: T, from: paid, to: cancelled, action: nope, by: [seller] } }';
  try {
    await cp(join(repo, 'workspace'), dir, { recursive: true, filter: (src) => !src.includes('node_modules') });
    await writeFile(join(dir, 'agents/onboarding.yaml'), script(transition));
    await assert.rejects(onboard(new Workspace(dir), undefined, { provider: 'scripted' }), /transition “t1” names action “nope”, which “order” doesn't have/);
    await writeFile(join(dir, 'agents/onboarding.yaml'), script(`{ op: add, kind: action, value: { id: nope, title: Nope } }, ${transition}`));
    assert.equal((await onboard(new Workspace(dir), undefined, { provider: 'scripted' }))[0].ops.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('declare: a type’s fields become parameters of an entity, each quoting its line; ones proposed already are left out', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-declare-'));
  try {
    await cp(join(repo, 'workspace'), dir, { recursive: true, filter: (src) => !src.includes('node_modules') && !src.includes(`${join('workspace', 'proposals')}`) });
    const reg = join(dir, 'sources.yaml');
    await writeFile(reg, (await readFile(reg, 'utf8')).replace('../demo/shop', join(repo, 'demo/shop')));
    const call = 'call: declare\n    input: { entity: order, source: shop-code, path: domain.ts, type: Order, as: attributes, skip: [history] }';
    await writeFile(join(dir, 'agents/onboarding.yaml'), `steps:\n  - ${call}\n  - ${call}\n  - call: propose\n    input: { rationale: r }\n`);
    const saved = await onboard(new Workspace(dir), undefined, { provider: 'scripted' });
    assert.equal(saved.length, 1, 'the second call finds nothing new');
    const ids = saved[0].ops.map((o) => o.op === 'add' && o.value.id);
    assert.ok(ids.includes('status') && !ids.includes('history'), ids.join());
    assert.match(saved[0].evidence.find((e) => e.summary.startsWith('status'))!.path!, /^domain\.ts#L22-L22$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
