import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyDecisions,
  applyProjectDecisions,
  Backlog,
  backlogCoverage,
  buildPlan,
  conflicts,
  Entity,
  Project,
  Proposal,
  scenarioActions,
  traceScenario,
  validateBacklog,
  validateEntity,
  Workspace,
  type BacklogCoverage,
  type ProjectState,
} from '../src/index.ts';

const project = Project.parse({
  name: 'Test',
  interfaces: [{ id: 'ui', title: 'UI', baseUrl: 'http://localhost/ui' }],
  roles: [
    { id: 'client', title: 'Client', interface: 'ui' },
    { id: 'seller', title: 'Seller', interface: 'ui' },
  ],
  mcp: { shop: { command: 'node', allow: { prepare: ['create'], read: ['get'] } } },
});

// A small order model with one of each scenario kind: a transition (pay), a
// permit (view-order), an entity-state rule that can't resolve (needs-stock —
// blocked, but still a `rule`-kind scenario), and a journey (happy).
function baseEntity(extra: Partial<Record<string, unknown>> = {}) {
  return Entity.parse({
    id: 'order',
    title: 'Order',
    reader: { tool: 'shop.get', args: { id: '{{key}}' } },
    variants: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }],
    states: [
      { id: 'new', title: 'New', initial: true, match: { status: 'new' }, setup: [{ kind: 'tool', tool: 'shop.create', args: {} }] },
      { id: 'paid', title: 'Paid', match: { status: 'paid' } },
      { id: 'shipped', title: 'Shipped', variants: ['a'], match: { status: 'shipped' } },
      { id: 'done', title: 'Done', match: { status: 'done' } },
    ],
    actions: [
      { id: 'pay', title: 'Pay', kind: 'update', run: 'o.pay' },
      { id: 'ship', title: 'Ship', kind: 'update', run: 'o.ship' },
      { id: 'finish', title: 'Finish', kind: 'update', run: 'o.finish' },
      { id: 'view', title: 'View', kind: 'read', run: 'o.view' },
    ],
    transitions: [
      { id: 'pay', title: 'Pay', from: 'new', to: 'paid', action: 'pay', by: ['client'] },
      { id: 'ship', title: 'Ship', from: 'paid', to: 'shipped', action: 'ship', by: ['seller'] },
      { id: 'finish', title: 'Finish', from: 'shipped', to: 'done', action: 'finish', by: ['client'] },
    ],
    permits: [{ id: 'view-order', title: 'View order', action: 'view', by: ['client'] }],
    rules: [{ id: 'needs-stock', title: 'Needs stock', text: 'Only ships in stock', transition: 'ship', requires: [{ kind: 'entity-state', relation: 'stock', states: ['available'] }] }],
    scenarios: [{ id: 'happy', title: 'Happy path', start: 'new', path: ['pay', 'ship'] }],
    ...extra,
  });
}

// A backlog exercising every `covers` kind, an action-level cover that matches
// both a positive and a deny scenario, an orphan (no feature or epic), an
// unmapped story, and a rejected one that must never surface.
function makeBacklog() {
  return Backlog.parse({
    epics: [{ id: 'checkout', title: 'Checkout' }],
    features: [{ id: 'pay-feature', title: 'Payment', epic: 'checkout', actions: ['order.pay'] }],
    stories: [
      { id: 'story-pay', title: 'Pay for order', feature: 'pay-feature', covers: ['transition:order.pay'] },
      { id: 'story-action-cover', title: 'Pay, by action ref', covers: ['action:order.pay'] },
      { id: 'story-rule', title: 'Stock rule', epic: 'checkout', covers: ['rule:order.needs-stock'] },
      { id: 'story-view', title: 'View order', covers: ['permit:order.view-order'] },
      { id: 'story-journey', title: 'Happy path', covers: ['journey:order.happy'] },
      { id: 'story-unmapped', title: 'Not modeled yet', covers: ['action:order.archive'] },
      { id: 'story-rejected', title: 'Rejected', status: 'rejected', covers: ['transition:order.pay'] },
    ],
  });
}

// ── Workspace: sources ────────────────────────────────────────────────────
test('workspace: addSource makes a unique slug id, rejects binary content, removeSource moves to trash', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-model-'));
  try {
    const ws = new Workspace(dir);
    const first = await ws.addSource({ name: 'Product Overview.md', content: '# Product\n\nSome text.' });
    assert.equal(first.id, 'product-overview');
    assert.equal(first.file, 'product-overview.md');
    assert.equal(first.title, 'Product Overview.md'); // title defaults to the name
    assert.equal(first.kind, 'doc');
    assert.equal(await ws.sourceText(first.id), '# Product\n\nSome text.');

    // Same name again: made unique with a numeric suffix.
    const second = await ws.addSource({ name: 'Product Overview.md', content: 'more text', kind: 'note', title: 'Second copy' });
    assert.equal(second.id, 'product-overview-2');
    assert.equal(second.title, 'Second copy');
    assert.equal((await ws.sources()).length, 2);

    await assert.rejects(() => ws.addSource({ name: 'weird.md', content: 'a\0b' }), /binary/);

    await ws.removeSource(first.id);
    const remaining = await ws.sources();
    assert.deepEqual(remaining.map((s) => s.id), ['product-overview-2']);
    const { readdir } = await import('node:fs/promises');
    const trashed = await readdir(join(dir, 'sources', '.trash'));
    assert.equal(trashed.length, 1);
    assert.match(trashed[0], /^product-overview-.*\.md$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Workspace: backlog ────────────────────────────────────────────────────
test('workspace: backlog round-trips, an absent file is an empty backlog with revision "", and a stale revision conflicts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-model-'));
  try {
    const ws = new Workspace(dir);
    const empty = await ws.backlog();
    assert.deepEqual(empty.backlog, { epics: [], features: [], stories: [] });
    assert.equal(empty.revision, '');

    const bl = Backlog.parse({ epics: [{ id: 'checkout', title: 'Checkout' }] });
    const rev1 = await ws.saveBacklog(bl);
    const read = await ws.backlog();
    assert.equal(read.revision, rev1);
    assert.equal(read.backlog.epics[0].title, 'Checkout');

    // Someone else saves first — a save against the now-stale revision conflicts.
    await ws.saveBacklog(Backlog.parse({ epics: [{ id: 'checkout', title: 'Checkout v2' }] }), rev1);
    await assert.rejects(() => ws.saveBacklog(bl, rev1), /has changed/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── applyProjectDecisions ─────────────────────────────────────────────────
test('applyProjectDecisions: role and interface ops, and entity creation defaults', () => {
  const proposal = Proposal.parse({
    id: 'pp1',
    agent: 'onboarding',
    createdAt: '2026-01-01T00:00:00Z',
    baseRevision: '',
    rationale: 'onboarding',
    ops: [
      { op: 'add', kind: 'role', value: { id: 'auditor', title: 'Auditor', kind: 'human', interface: 'ui' } },
      { op: 'add', kind: 'interface', value: { id: 'admin-ui', title: 'Admin', baseUrl: 'http://localhost/admin' } },
      { op: 'add', kind: 'entity', value: { id: 'review', title: 'Review' } },
      { op: 'add', kind: 'entity', value: { id: 'coupon', title: 'Coupon', variants: [{ id: 'percent', title: 'Percent off' }] } },
    ],
  });
  const state: ProjectState = { project, backlog: Backlog.parse({}), entityIds: ['order'] };
  const result = applyProjectDecisions(state, proposal, [
    { op: 0, verdict: 'accept' },
    { op: 1, verdict: 'accept' },
    { op: 2, verdict: 'accept' },
    { op: 3, verdict: 'accept' },
  ]);

  assert.ok(result.project.roles.some((r) => r.id === 'auditor'));
  assert.ok(result.project.interfaces.some((i) => i.id === 'admin-ui'));
  assert.equal(result.created.length, 2);

  const review = result.created.find((e) => e.id === 'review')!;
  assert.equal(review.key, 'id');
  assert.deepEqual(review.variants.map((v) => v.id), ['default']);
  assert.deepEqual(review.states, []);
  assert.deepEqual(review.transitions, []);

  const coupon = result.created.find((e) => e.id === 'coupon')!;
  assert.deepEqual(coupon.variants.map((v) => v.id), ['percent']);
});

test('applyProjectDecisions: "observe" is not a valid verdict for role, interface, or entity ops', () => {
  const proposal = Proposal.parse({
    id: 'pp2',
    agent: 'onboarding',
    createdAt: '2026-01-01T00:00:00Z',
    baseRevision: '',
    rationale: 'x',
    ops: [
      { op: 'add', kind: 'role', value: { id: 'auditor', title: 'Auditor' } },
      { op: 'add', kind: 'interface', value: { id: 'admin-ui', title: 'Admin', baseUrl: 'http://localhost/admin' } },
      { op: 'add', kind: 'entity', value: { id: 'review', title: 'Review' } },
    ],
  });
  const state: ProjectState = { project, backlog: Backlog.parse({}), entityIds: ['order'] };
  for (let i = 0; i < 3; i++) assert.throws(() => applyProjectDecisions(state, proposal, [{ op: i, verdict: 'observe' }]), /not a valid verdict/);
});

test('applyProjectDecisions: epic/feature/story ops follow accept/observe/reject, and provenance.sources comes from source evidence', () => {
  const proposal = Proposal.parse({
    id: 'pp3',
    agent: 'onboarding',
    createdAt: '2026-01-01T00:00:00Z',
    baseRevision: '',
    rationale: 'x',
    evidence: [{ id: 'e1', kind: 'source', summary: 'Buyers can leave a review after delivery', source: 'product-overview' }],
    ops: [
      { op: 'add', kind: 'epic', value: { id: 'reviews', title: 'Reviews' }, evidence: ['e1'] },
      { op: 'add', kind: 'feature', value: { id: 'leave-review', title: 'Leave a review', actions: ['review.write'] } },
      { op: 'add', kind: 'story', value: { id: 'story-review', title: 'As a buyer I leave a review' } },
    ],
  });
  const state: ProjectState = { project, backlog: Backlog.parse({}), entityIds: ['order'] };
  const result = applyProjectDecisions(state, proposal, [
    { op: 0, verdict: 'accept' },
    { op: 1, verdict: 'observe' },
    { op: 2, verdict: 'reject' },
  ]);
  const epic = result.backlog.epics.find((e) => e.id === 'reviews')!;
  assert.equal(epic.status, 'confirmed');
  assert.deepEqual(epic.provenance?.sources, ['product-overview']);
  assert.equal(result.backlog.features.find((f) => f.id === 'leave-review')!.status, 'observed');
  assert.equal(result.backlog.stories.find((s) => s.id === 'story-review')!.status, 'rejected');
});

test('applyProjectDecisions: an entity-level op kind is a scope-mismatch error', () => {
  const proposal = Proposal.parse({
    id: 'pp4',
    agent: 'onboarding',
    createdAt: '2026-01-01T00:00:00Z',
    baseRevision: '',
    rationale: 'x',
    ops: [{ op: 'add', kind: 'transition', value: { id: 'x', title: 'X', from: 'new', to: 'paid', action: 'pay', by: ['client'] } }],
  });
  const state: ProjectState = { project, backlog: Backlog.parse({}), entityIds: ['order'] };
  assert.throws(() => applyProjectDecisions(state, proposal, [{ op: 0, verdict: 'accept' }]), /not a project-level operation/);
});

test('applyDecisions: a project-level op kind is a scope-mismatch error, the reverse direction', () => {
  const proposal = Proposal.parse({
    id: 'pp5',
    entity: 'order',
    agent: 'onboarding',
    createdAt: '2026-01-01T00:00:00Z',
    baseRevision: 'x',
    rationale: 'x',
    ops: [{ op: 'add', kind: 'role', value: { id: 'auditor', title: 'Auditor' } }],
  });
  assert.throws(() => applyDecisions(baseEntity(), proposal, [{ op: 0, verdict: 'accept' }], project), /not an entity-level operation/);
});

test('proposals: an entity-level proposal for an entity that does not exist yet reports a conflict on every op', () => {
  const proposal = Proposal.parse({
    id: 'pp6',
    entity: 'review',
    agent: 'onboarding',
    createdAt: '2026-01-01T00:00:00Z',
    baseRevision: 'new',
    rationale: 'x',
    ops: [
      { op: 'add', kind: 'action', value: { id: 'write', title: 'Write review' } },
      { op: 'add', kind: 'transition', value: { id: 'submit', title: 'Submit', from: '@new', to: 'new', action: 'write', by: ['client'] } },
    ],
  });
  const cs = conflicts(undefined, proposal, project);
  assert.equal(cs.length, 2);
  for (const c of cs) assert.match(c.message, /Entity “review” doesn't exist yet — accept it in the project proposal first/);
});

// ── scenarioActions ────────────────────────────────────────────────────────
test('scenarioActions: resolves the acting "<entity>.<action>" per scenario kind', () => {
  const e = baseEntity();
  const plan = buildPlan(e, project);
  const find = (kind: string, target: string) => plan.scenarios.find((s) => s.kind === kind && s.target === target && s.variant === 'a')!;

  assert.deepEqual(scenarioActions(e, find('transition', 'pay')), ['order.pay']);
  assert.deepEqual(scenarioActions(e, find('permit', 'view-order')), ['order.view']);
  assert.deepEqual(scenarioActions(e, find('rule', 'needs-stock')), ['order.ship']); // needs-stock is tied to the "ship" transition
  assert.deepEqual(scenarioActions(e, plan.scenarios.find((s) => s.kind === 'journey' && s.target === 'happy')!), ['order.pay', 'order.ship']);

  const deny = plan.scenarios.find((s) => s.kind === 'deny' && s.target === 'pay@paid' && s.role === 'client')!;
  assert.deepEqual(scenarioActions(e, deny), ['order.pay']);
});

// ── traceScenario ──────────────────────────────────────────────────────────
test('traceScenario: a feature via its actions, an epic through the feature, and each `covers` kind', () => {
  const e = baseEntity();
  const plan = buildPlan(e, project);
  const bl = makeBacklog();
  const find = (kind: string, target: string) => plan.scenarios.find((s) => s.kind === kind && s.target === target && s.variant === 'a')!;

  const pay = find('transition', 'pay');
  const payTrace = traceScenario(bl, e, pay);
  assert.deepEqual(payTrace.features, ['pay-feature']);
  assert.deepEqual(payTrace.epics, ['checkout']); // through the feature
  assert.ok(payTrace.stories.includes('story-pay'));
  assert.ok(payTrace.stories.includes('story-action-cover'));
  assert.ok(!payTrace.stories.includes('story-rejected'), 'a rejected story is never traced to');

  const rule = find('rule', 'needs-stock');
  assert.ok(traceScenario(bl, e, rule).stories.includes('story-rule'));
  assert.deepEqual(traceScenario(bl, e, rule).epics, ['checkout']); // the story's own direct epic

  assert.ok(traceScenario(bl, e, find('permit', 'view-order')).stories.includes('story-view'));
  assert.ok(traceScenario(bl, e, plan.scenarios.find((s) => s.kind === 'journey' && s.target === 'happy')!).stories.includes('story-journey'));

  const deny = plan.scenarios.find((s) => s.kind === 'deny' && s.target === 'pay@paid' && s.role === 'client')!;
  const denyTrace = traceScenario(bl, e, deny);
  assert.deepEqual(denyTrace.features, ['pay-feature']); // the action ref still matches a deny scenario
  assert.ok(denyTrace.stories.includes('story-action-cover')); // an `action:` cover matches every kind, deny included
  assert.ok(!denyTrace.stories.includes('story-pay'), 'a `transition:` cover does not match a deny scenario');
});

// ── backlogCoverage ────────────────────────────────────────────────────────
test('backlogCoverage: totals are unique per scenario, rejected items are excluded, unmapped stories are surfaced', () => {
  const e = baseEntity();
  const plan = buildPlan(e, project);
  const bl = makeBacklog();
  const catalog = { order: e };
  const coverage: BacklogCoverage = backlogCoverage(bl, project, catalog, { order: plan }, {});

  assert.equal(coverage.totals.scenarios, plan.scenarios.length);

  const checkout = coverage.epics.find((ep) => ep.id === 'checkout')!;
  const feature = checkout.features.find((f) => f.id === 'pay-feature')!;
  // The feature's own action match and its story's `covers` match overlap on the same transition — still counted once.
  assert.equal(new Set(feature.scenarios).size, feature.scenarios.length);
  const payScenarioIds = plan.scenarios.filter((s) => s.target === 'pay').map((s) => s.id);
  for (const id of payScenarioIds) assert.ok(feature.scenarios.includes(id));

  const action = feature.actions.find((a) => a.ref === 'order.pay')!;
  assert.equal(action.resolved, true);
  assert.equal(action.kind, 'update');
  assert.deepEqual(action.allowed, [{ element: 'pay', kind: 'transition', by: ['client'], from: 'new', to: 'paid' }]);
  assert.equal(action.undecided, 0);

  // A story directly under the epic (no feature).
  assert.ok(checkout.stories.some((s) => s.id === 'story-rule'));

  // Orphans: no feature, no epic.
  const orphanIds = coverage.orphanStories.map((s) => s.id);
  assert.ok(orphanIds.includes('story-view'));
  assert.ok(orphanIds.includes('story-journey'));
  assert.ok(orphanIds.includes('story-unmapped'));

  assert.deepEqual(coverage.unmappedStories, ['story-unmapped']);

  // Nothing rejected ever surfaces.
  const allStoryIds = [
    ...checkout.stories.map((s) => s.id),
    ...checkout.features.flatMap((f) => f.stories.map((s) => s.id)),
    ...coverage.orphanFeatures.flatMap((f) => f.stories.map((s) => s.id)),
    ...coverage.orphanStories.map((s) => s.id),
  ];
  assert.ok(!allStoryIds.includes('story-rejected'));
});

// ── validateBacklog ────────────────────────────────────────────────────────
test('validateBacklog: duplicate ids, unknown references, and unresolved actions/covers are warnings', () => {
  const catalog = { order: baseEntity() };
  const bl = Backlog.parse({
    epics: [{ id: 'checkout', title: 'Checkout' }, { id: 'checkout', title: 'Dup' }],
    features: [{ id: 'pay-feature', title: 'Payment', epic: 'ghost-epic', actions: ['order.pay', 'order.archive'] }],
    stories: [{ id: 'story-1', title: 'x', feature: 'ghost-feature', epic: 'ghost-epic', covers: ['transition:order.ghost'] }],
  });
  const issues = validateBacklog(bl, catalog);
  const messages = issues.map((i) => i.message).join('\n');
  assert.match(messages, /Duplicate id/);
  assert.match(messages, /Unknown epic “ghost-epic”/);
  assert.match(messages, /Action “order\.archive” is not in the model yet/);
  assert.match(messages, /Unknown feature “ghost-feature”/);
  assert.match(messages, /“transition:order\.ghost” is not in the model yet/);
  assert.ok(issues.every((i) => i.level === 'warning'));
});

// ── Entity.reader optional ─────────────────────────────────────────────────
test('plan + validate: an entity without a reader has every scenario blocked, and validateEntity warns', () => {
  const { reader: _reader, ...rest } = baseEntity();
  const withoutReader = Entity.parse(rest);
  const plan = buildPlan(withoutReader, project);
  assert.ok(plan.scenarios.length > 0);
  assert.ok(plan.scenarios.every((s) => s.blocked && /No reader/.test(s.blocked)));
  assert.match(validateEntity(withoutReader, project).map((i) => i.message).join('\n'), /No reader/);
});
