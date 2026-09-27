import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  accessMatrix, applyDecisions, arrange, buildPlan, conflicts, coverage, Entity, performer, Project, Proposal, renderMarkdown, template,
  validateEntity, type Scenario,
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

const tool = (status: string) => ({ kind: 'tool', tool: 'shop.create', args: { variant: '{{variant}}', status } });

// Actions and transitions shared by most tests, as plain arrays so tests can
// extend them (`[...baseActions(), extra]`) without losing the defaults.
const baseActions = () => [
  { id: 'pay', title: 'Pay', kind: 'update', run: 'o.pay' },
  { id: 'ship', title: 'Ship', kind: 'update', run: 'o.ship' },
  { id: 'finish', title: 'Finish', kind: 'update', run: 'o.finish' },
];
const baseTransitions = () => [
  { id: 'pay', title: 'Pay', from: 'new', to: 'paid', action: 'pay', by: ['client'], effects: [{ description: 'Charged', field: 'payment', equals: 'captured' }] },
  { id: 'ship', title: 'Ship', from: 'paid', to: 'shipped', action: 'ship', by: ['seller'] },
  { id: 'finish', title: 'Finish', from: 'shipped', to: 'done', action: 'finish', by: ['client'] },
];

function entity(extra: Partial<Record<string, unknown>> = {}) {
  return Entity.parse({
    id: 'order',
    title: 'Order',
    reader: { tool: 'shop.get', args: { id: '{{key}}' } },
    variants: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }],
    states: [
      { id: 'new', title: 'New', initial: true, match: { status: 'new' }, setup: [tool('new')] },
      { id: 'paid', title: 'Paid', match: { status: 'paid' } },
      { id: 'shipped', title: 'Shipped', variants: ['a'], match: { status: 'shipped' } },
      { id: 'done', title: 'Done', match: { status: 'done' } },
    ],
    actions: baseActions(),
    transitions: baseTransitions(),
    ...extra,
  });
}

test('arrange: a direct tool recipe substitutes the variant', () => {
  const a = arrange(entity(), 'a', 'new')!;
  assert.equal(a.method, 'tool');
  assert.deepEqual(a.steps[0], { do: 'prepare', state: 'new', tool: 'shop.create', args: { variant: 'a', status: 'new' }, key: 'id' });
  assert.equal(a.steps[1].do, 'expectState');
});

test('arrange: without a recipe it takes the shortest path through confirmed transitions', () => {
  const a = arrange(entity(), 'a', 'shipped')!;
  assert.equal(a.method, 'auto');
  assert.deepEqual(a.steps.filter((s) => s.do === 'transition').map((s) => s.do === 'transition' && s.transition), ['pay', 'ship']);
});

test('arrange: an unconfirmed transition is not used for setup', () => {
  const e = entity();
  e.transitions[0].status = 'observed';
  assert.equal(arrange(e, 'a', 'paid'), null);
});

test('arrange: explicit path recipe', () => {
  const e = entity();
  e.states[3].setup = [{ kind: 'path', from: 'paid', via: ['ship', 'finish'] }];
  const a = arrange(e, 'a', 'done')!;
  assert.equal(a.method, 'path');
  assert.equal(a.steps.filter((s) => s.do === 'transition').length, 3);
});

test('plan: a transition is not planned for a variant its state does not apply to', () => {
  const ids = buildPlan(entity()).scenarios.map((s) => s.id);
  assert.ok(ids.includes('order/ship/a'));
  assert.ok(!ids.includes('order/ship/b'));
  assert.ok(!ids.includes('order/finish/b'));
});

test('plan: scenario = arrange → act → assert state and effects', () => {
  const s = buildPlan(entity()).scenarios.find((x) => x.id === 'order/pay/a')!;
  assert.deepEqual(s.steps.map((x) => `${x.phase}:${x.do}`), [
    'arrange:prepare', 'arrange:expectState', 'act:transition', 'assert:expectState', 'assert:expectField',
  ]);
});

test('plan: observations and proposals are not planned', () => {
  const e = entity();
  e.transitions[2].status = 'observed';
  assert.ok(!buildPlan(e).scenarios.some((s) => s.target === 'finish'));
});

test('plan: an unreachable source state yields a blocked scenario', () => {
  const e = entity();
  e.states[0].setup = [];
  const s = buildPlan(e).scenarios.find((x) => x.id === 'order/pay/a')!;
  assert.match(s.blocked!, /No way/);
});

test('validate: catches broken references, disallowed tools, and an action missing from the library', () => {
  const e = entity();
  e.transitions.push({ id: 'bad', title: 'x', from: 'nowhere', to: 'paid', action: 'pay', by: ['ghost'], guards: [], effects: [], status: 'confirmed' });
  e.states[0].setup = [{ kind: 'tool', tool: 'shop.drop_db', args: {}, key: 'id' }];
  const messages = validateEntity(e, project, new Set(['o.pay'])).map((i) => i.message).join('\n');
  assert.match(messages, /Unknown state “nowhere”/);
  assert.match(messages, /Unknown role “ghost”/);
  assert.match(messages, /shop\.drop_db.*not allowed/);
  assert.match(messages, /Action “o\.ship” is not implemented/);
});

// ── Performer: human roles run, system roles invoke ─────────────────────
function withSystemRole() {
  return Project.parse({
    ...project,
    roles: [...project.roles, { id: 'system', title: 'System', kind: 'system' }],
    mcp: { shop: { command: 'node', allow: { prepare: ['create'], read: ['get'], trigger: ['expire'] } } },
  });
}

function withExpire() {
  return entity({
    actions: [...baseActions(), { id: 'expire', title: 'Expire', kind: 'command', invoke: { tool: 'shop.expire', args: {} } }],
    transitions: [...baseTransitions(), { id: 'expire', title: 'Expire', from: 'paid', to: 'new', action: 'expire', by: ['system'] }],
  });
}

test('performer: a human role uses `run`, a system role uses `invoke`, and a missing binding is null', () => {
  const sysProject = withSystemRole();
  const e = withExpire();
  const pay = e.transitions.find((t) => t.id === 'pay')!;
  assert.deepEqual(performer(e, pay, 'client', sysProject), { role: 'client', run: 'o.pay' });
  const expire = e.transitions.find((t) => t.id === 'expire')!;
  assert.deepEqual(performer(e, expire, 'system', sysProject), { role: 'system', invoke: { tool: 'shop.expire', args: {} } });
  // Without the project every role defaults to human (Role.kind's own default) — “system” then has no `run`.
  assert.equal(performer(e, expire, 'system'), null);
  // No performer at all: the action doesn't exist.
  assert.equal(performer(e, { ...expire, action: 'ghost' }, 'system', sysProject), null);
  // Without an explicit role, the first role in `by` that can perform it wins.
  assert.deepEqual(performer(e, pay, undefined, sysProject), { role: 'client', run: 'o.pay' });
});

test('plan + validate: a system role in `by` without an invoke tool is a warning and a blocked scenario', () => {
  const sysProject = withSystemRole();
  const e = entity({ transitions: [...baseTransitions(), { id: 'auto-cancel', title: 'Auto-cancel', from: 'new', to: 'new', action: 'pay', by: ['system'] }] });
  const messages = validateEntity(e, sysProject).map((i) => i.message).join('\n');
  assert.match(messages, /Role “system” is system, but action “pay” has no invoke tool/);
  const s = buildPlan(e, sysProject).scenarios.find((x) => x.id === 'order/auto-cancel/a')!;
  assert.match(s.blocked!, /Nothing makes the system perform “Pay” in a test/);
});

// ── Multi-role transitions and permits ───────────────────────────────────
test('plan: several roles in `by` get one scenario each (`.role` id); a single role keeps the plain id', () => {
  const e = entity({
    actions: [...baseActions(), { id: 'cancel', title: 'Cancel', kind: 'command', run: 'o.cancel' }],
    transitions: [...baseTransitions(), { id: 'cancel', title: 'Cancel', from: 'new', to: 'new', action: 'cancel', by: ['client', 'seller'] }],
  });
  const plan = buildPlan(e);
  const cancelIds = plan.scenarios.filter((s) => s.target === 'cancel').map((s) => s.id).sort();
  assert.deepEqual(cancelIds, ['order/cancel.client/a', 'order/cancel.client/b', 'order/cancel.seller/a', 'order/cancel.seller/b']);
  assert.ok(plan.scenarios.some((s) => s.id === 'order/pay/a')); // a single-role transition's id is unchanged
});

test('plan: a permit checks the action stays available in its first applicable state', () => {
  const e = entity({
    actions: [...baseActions(), { id: 'view', title: 'View', kind: 'read', run: 'o.view' }],
    permits: [{ id: 'view-order', title: 'View order', action: 'view', by: ['client'] }],
  });
  const s = buildPlan(e).scenarios.find((x) => x.id === 'order/permit-view-order/a')!;
  assert.equal(s.kind, 'permit');
  assert.deepEqual(s.steps.map((x) => `${x.phase}:${x.do}`), ['arrange:prepare', 'arrange:expectState', 'act:perform', 'assert:expectState']);
  const perform = s.steps.find((x) => x.do === 'perform')! as Extract<Scenario['steps'][number], { do: 'perform' }>;
  assert.equal(perform.state, 'new'); // the first active state of the variant — states[0] wasn't given
  assert.equal(perform.run, 'o.view');
});

test('plan: a multi-role transition or permit names the performing role in its title; no two scenarios share a title+variant', () => {
  const e = entity({
    actions: [...baseActions(), { id: 'cancel', title: 'Cancel', kind: 'command', run: 'o.cancel' }, { id: 'view', title: 'View', kind: 'read', run: 'o.view' }],
    transitions: [...baseTransitions(), { id: 'cancel', title: 'Cancel', from: 'new', to: 'new', action: 'cancel', by: ['client', 'seller'] }],
    permits: [{ id: 'view-order', title: 'View order', action: 'view', by: ['client', 'seller'] }],
  });
  const plan = buildPlan(e, project);

  const cancelClient = plan.scenarios.find((s) => s.id === 'order/cancel.client/a')!;
  const cancelSeller = plan.scenarios.find((s) => s.id === 'order/cancel.seller/a')!;
  assert.equal(cancelClient.title, 'Cancel: new → new — Client');
  assert.equal(cancelSeller.title, 'Cancel: new → new — Seller');

  const viewClient = plan.scenarios.find((s) => s.id === 'order/permit-view-order.client/a')!;
  const viewSeller = plan.scenarios.find((s) => s.id === 'order/permit-view-order.seller/a')!;
  assert.equal(viewClient.title, 'View order in “New” — Client');
  assert.equal(viewSeller.title, 'View order in “New” — Seller');

  // A single-role transition keeps its plain title — no role suffix.
  const pay = plan.scenarios.find((s) => s.id === 'order/pay/a')!;
  assert.equal(pay.title, 'Pay: new → paid');

  const pairs = plan.scenarios.map((s) => `${s.title}|${s.variant}`);
  assert.equal(new Set(pairs).size, pairs.length, 'every scenario in the plan has a unique title+variant pair');
});

// ── Creation, access matrix, deny scenarios ──────────────────────────────
const withAuth = Project.parse({
  ...project,
  roles: [
    { id: 'guest', title: 'Guest', interface: 'ui' },
    { id: 'client', title: 'Client', interface: 'ui', login: { action: 'auth.login', args: { username: 'u' } } },
    { id: 'seller', title: 'Seller', interface: 'ui', login: { action: 'auth.login' } },
  ],
});

function withCreate(extra: Partial<Record<string, unknown>> = {}) {
  const e = entity();
  e.states[0].setup = [];
  return Entity.parse({
    ...e,
    actions: [...e.actions, { id: 'create', title: 'Create', kind: 'create', run: 'o.create' }],
    transitions: [{ id: 'create', title: 'Create', from: '@new', to: 'new', action: 'create', by: ['client'] }, ...e.transitions],
    ...extra,
  });
}

test('arrange: a creating transition from @new replaces the setup tool', () => {
  const a = arrange(withCreate(), 'a', 'paid')!;
  assert.equal(a.method, 'auto');
  assert.deepEqual(a.steps.filter((s) => s.do === 'transition').map((s) => s.do === 'transition' && s.transition), ['create', 'pay']);
  assert.equal(arrange(withCreate(), 'a', '@new')!.method, 'none');
});

test('validate: a create action must start from @new, and only a create action may', () => {
  const e = withCreate();
  e.transitions[0].from = 'new';
  assert.match(
    validateEntity(e, withAuth).map((i) => i.message).join('\n'),
    /Action “create” creates the instance; the transition must start from “@new”/,
  );
  const e2 = entity();
  e2.transitions[0].from = '@new';
  assert.match(
    validateEntity(e2, withAuth).map((i) => i.message).join('\n'),
    /A transition from “@new” must use a create action/,
  );
});

test('accessMatrix: allowed / undecided / denied, `@new` for create actions, and a rejected element stays denied', () => {
  const e = Entity.parse({
    ...entity(),
    actions: [...baseActions(), { id: 'create', title: 'Create', kind: 'create', run: 'o.create' }, { id: 'view', title: 'View', kind: 'read', run: 'o.view' }],
    transitions: [
      { id: 'create', title: 'Create', from: '@new', to: 'new', action: 'create', by: ['client'] },
      ...baseTransitions(),
      { id: 'seller-pay', title: 'Seller pay (rejected)', from: 'new', to: 'paid', action: 'pay', by: ['seller'], status: 'rejected' },
    ],
    permits: [{ id: 'seller-view', title: 'Seller view', action: 'view', by: ['seller'], states: ['paid'], status: 'proposed' }],
  });
  const cells = accessMatrix(e, withAuth, 'a');
  const cell = (role: string, action: string, state: string) => cells.find((c) => c.role === role && c.action === action && c.state === state);
  assert.deepEqual(cell('client', 'create', '@new'), { role: 'client', action: 'create', state: '@new', decision: 'allowed', by: 'create' });
  assert.equal(cell('seller', 'create', '@new')?.decision, 'denied');
  assert.equal(cell('client', 'pay', 'new')?.decision, 'allowed');
  // Only a rejected transition would allow it — still denied.
  assert.equal(cell('seller', 'pay', 'new')?.decision, 'denied');
  // Only a proposed permit allows it — undecided, not allowed.
  assert.equal(cell('seller', 'view', 'paid')?.decision, 'undecided');
});

test('plan: a deny scenario per denied cell, blocked when the state can’t be reached', () => {
  const plan = buildPlan(entity(), withAuth);
  const deny = plan.scenarios.find((s) => s.id === 'order/deny-pay-seller-new/a')!;
  assert.equal(deny.kind, 'deny');
  assert.match(deny.title, /Denied: Seller can't “Pay” in New/);
  assert.deepEqual(deny.steps.slice(-2).map((s) => s.do), ['expectUnavailable', 'expectState']);
  // The client is allowed to pay from “new” — no deny scenario for that cell.
  assert.ok(!plan.scenarios.some((s) => s.id === 'order/deny-pay-client-new/a'));

  const unreachable = entity();
  unreachable.states[0].setup = [];
  const blocked = buildPlan(unreachable, withAuth).scenarios.find((s) => s.id === 'order/deny-pay-seller-new/a')!;
  assert.match(blocked.blocked!, /No way to reach/);
});

// ── Business rules ────────────────────────────────────────────────────────
test('rules: `roles`/`authenticated` conditions produce no scenarios of their own — they tag the matching deny scenarios', () => {
  const e = entity({
    rules: [{ id: 'seller-ships', title: 'Only sellers ship', text: 'Only the seller ships', transition: 'ship', requires: [{ kind: 'roles', roles: ['seller'] }] }],
  });
  const plan = buildPlan(e, withAuth);
  assert.deepEqual(plan.scenarios.filter((s) => s.kind === 'rule'), []);
  assert.deepEqual(plan.scenarios.find((s) => s.id === 'order/deny-ship-client-paid/a')!.rules, ['seller-ships']);
  assert.deepEqual(plan.scenarios.find((s) => s.id === 'order/deny-ship-guest-paid/a')!.rules, ['seller-ships']);
});

test('rules: `authenticated` tags every guest’s deny scenario; no guest at all means no tags and a validation warning', () => {
  const e = withCreate({ rules: [{ id: 'signed-in', title: 'Sign in first', text: 'Only signed-in users create', transition: 'create', requires: [{ kind: 'authenticated' }] }] });
  const plan = buildPlan(e, withAuth);
  assert.deepEqual(plan.scenarios.filter((s) => s.kind === 'rule'), []);
  assert.deepEqual(plan.scenarios.find((s) => s.id === 'order/deny-create-guest-new/a')!.rules, ['signed-in']);

  const everyoneSignsIn = Project.parse({ ...withAuth, roles: withAuth.roles.filter((r) => r.login) });
  assert.ok(!buildPlan(e, everyoneSignsIn).scenarios.some((s) => s.rules.includes('signed-in')));
  assert.match(validateEntity(e, everyoneSignsIn).map((i) => i.message).join('\n'), /No role without login/);
});

test('rules: an entity-state condition still gets its own (blocked) scenario when the related model is missing', () => {
  const e = entity({
    rules: [{ id: 'needs-stock', title: 'Needs stock', text: 'x', transition: 'ship', requires: [{ kind: 'entity-state', relation: 'stock', states: ['available'] }] }],
  });
  const rules = buildPlan(e, withAuth).scenarios.filter((s) => s.kind === 'rule' && s.variant === 'a');
  assert.equal(rules.length, 1);
  assert.match(rules[0].blocked!, /Needs the model of the related/);
  const c = coverage(e, buildPlan(e, withAuth), {});
  assert.equal(c.rules[0].cells.a!.status, 'blocked');
});

test('validate: a rule’s conditions must be consistent with its transition’s `by`', () => {
  const e = entity({
    rules: [{ id: 'seller-only', title: 'Seller only', text: 'x', transition: 'pay', requires: [{ kind: 'roles', roles: ['seller'] }] }],
  });
  assert.match(
    validateEntity(e, withAuth).map((i) => i.message).join('\n'),
    /Role “client” performs the transition but is outside this rule's roles/,
  );
  const guestLogin = Project.parse({ ...withAuth, roles: withAuth.roles.map((r) => (r.id === 'client' ? { id: 'client', title: 'Client', interface: 'ui' } : r)) });
  const e2 = withCreate({ rules: [{ id: 'signed-in', title: 'Sign in first', text: 'x', transition: 'create', requires: [{ kind: 'authenticated' }] }] });
  assert.match(
    validateEntity(e2, guestLogin).map((i) => i.message).join('\n'),
    /Role “client” performs the transition but has no login/,
  );
});

test('journeys: a path chains transitions and checks every state on the way', () => {
  const e = withCreate({ scenarios: [{ id: 'happy', title: 'Happy path', start: '@new', path: ['create', 'pay', 'ship'] }] });
  const plan = buildPlan(e, withAuth).scenarios.filter((s) => s.kind === 'journey');
  assert.deepEqual(plan.map((s) => s.id), ['order/scenario-happy/a']); // “shipped” doesn't apply to b
  assert.equal(plan[0].role, 'client+seller');
  assert.equal(plan[0].steps.filter((s) => s.do === 'expectState').length, 3);
});

test('journeys: a broken path is a validation error and a blocked scenario', () => {
  const e = withCreate({ scenarios: [{ id: 'broken', title: 'Broken', start: 'new', path: ['ship'] }] });
  assert.match(validateEntity(e, withAuth).map((i) => i.message).join('\n'), /“Ship” starts in “paid”, but the path is in “new”/);
  const s = buildPlan(e, withAuth).scenarios.find((x) => x.kind === 'journey')!;
  assert.match(s.blocked!, /starts in “paid”/);
});

test('template: a whole placeholder keeps its type, a partial one is interpolated', () => {
  assert.deepEqual(template({ a: '{{n}}', b: 'x-{{n}}', c: ['{{m}}'], d: '{{missing}}' }, { n: 5, m: true }), { a: 5, b: 'x-5', c: [true], d: '{{missing}}' });
});

test('template: dotted placeholders read nested values such as env', () => {
  assert.deepEqual(template({ p: '{{env.PASS}}', q: 'x-{{env.USER}}' }, { env: { PASS: 's3cret', USER: 'bob' } }), { p: 's3cret', q: 'x-bob' });
});

// ── Proposals ─────────────────────────────────────────────────────────────
const proposal = Proposal.parse({
  id: 'p1',
  entity: 'order',
  agent: 'explorer',
  createdAt: '2026-01-01T00:00:00Z',
  baseRevision: 'old',
  rationale: 'test',
  evidence: [{ id: 'e1', kind: 'note', summary: 'seen' }],
  ops: [
    { op: 'add', kind: 'transition', value: { id: 'cancel', title: 'Cancel', from: 'paid', to: 'new', action: 'cancel', by: ['client'] }, evidence: ['e1'] },
    { op: 'add', kind: 'transition', value: { id: 'refund', title: 'Refund', from: 'done', to: 'new', action: 'refund', by: ['seller'] } },
    { op: 'update', kind: 'state', id: 'shipped', set: { variants: ['a', 'b'] } },
    { op: 'add', kind: 'variant', value: { id: 'c', title: 'C' } },
  ],
});

test('proposals: accept → requirement, observe → observation, reject is kept as rejected', () => {
  const next = applyDecisions(entity(), proposal, [
    { op: 0, verdict: 'accept' },
    { op: 1, verdict: 'observe', note: 'looks like a bug' },
    { op: 2, verdict: 'accept' },
    { op: 3, verdict: 'reject' },
  ]);
  const cancel = next.transitions.find((t) => t.id === 'cancel')!;
  assert.equal(cancel.status, 'confirmed');
  assert.deepEqual(cancel.provenance, { source: 'agent', agent: 'explorer', proposal: 'p1', evidence: ['e1'] });
  const refund = next.transitions.find((t) => t.id === 'refund')!;
  assert.equal(refund.status, 'observed');
  assert.equal(refund.provenance?.note, 'looks like a bug');
  assert.deepEqual(next.states.find((s) => s.id === 'shipped')!.variants, ['a', 'b']);
  assert.equal(next.variants.find((v) => v.id === 'c')!.status, 'rejected');
  // A rejected variant is not planned, and neither is an observation.
  const plan = buildPlan(next);
  assert.ok(!plan.scenarios.some((s) => s.variant === 'c' || s.target === 'refund'));
  assert.ok(plan.scenarios.some((s) => s.id === 'order/cancel/a'));
});

test('proposals: conflicts are computed per operation, not per revision', () => {
  assert.deepEqual(conflicts(entity(), proposal), []);
  const e = entity();
  e.states = e.states.filter((s) => s.id !== 'shipped');
  e.transitions = e.transitions.filter((t) => t.to !== 'shipped' && t.from !== 'shipped');
  assert.deepEqual(conflicts(e, proposal).map((c) => c.op), [2]);
  assert.throws(() => applyDecisions(e, proposal, [{ op: 2, verdict: 'accept' }]), /is not in the model/);
});

// ── Coverage and Markdown ─────────────────────────────────────────────────
test('coverage and markdown take run results into account', () => {
  const e = entity();
  const plan = buildPlan(e);
  const results = { 'order/pay/a': { status: 'passed' as const, durationMs: 10, at: 'now' }, 'order/pay/b': { status: 'failed' as const, durationMs: 10, at: 'now', error: 'boom' } };
  const c = coverage(e, plan, results);
  assert.equal(c.totals.passed, 1);
  assert.equal(c.totals.failed, 1);
  assert.equal(c.transitions.find((t) => t.id === 'ship')!.cells.b, null);
  assert.equal(c.states.find((s) => s.id === 'paid')!.cells.a, 'verified');
  const md = renderMarkdown(project, e, plan, results);
  assert.match(md, /## ✅ Pay: new → paid — A/);
  assert.match(md, /Last run: failed, now — boom/);
});

test('coverage: access rows and combined cells across roles', () => {
  const e = entity({
    actions: [...baseActions(), { id: 'cancel', title: 'Cancel', kind: 'command', run: 'o.cancel' }],
    transitions: [...baseTransitions(), { id: 'cancel', title: 'Cancel', from: 'new', to: 'new', action: 'cancel', by: ['client', 'seller'] }],
  });
  const plan = buildPlan(e, withAuth);
  const results = {
    'order/cancel.client/a': { status: 'passed' as const, durationMs: 1, at: 'now' },
    'order/cancel.seller/a': { status: 'failed' as const, durationMs: 1, at: 'now', error: 'boom' },
  };
  const c = coverage(e, plan, results, withAuth);
  // Combined cell of several roles: the worst status wins (failed beats passed).
  assert.equal(c.transitions.find((t) => t.id === 'cancel')!.cells.a!.status, 'failed');
  // Access row for (client, pay, new): allowed, backed by the positive scenario.
  const allowedRow = c.access.find((r) => r.role === 'client' && r.action === 'pay' && r.state === 'new')!;
  assert.equal(allowedRow.cells.a!.decision, 'allowed');
  assert.equal(allowedRow.cells.a!.result?.scenario, 'order/pay/a');
  // Access row for (seller, pay, new): denied, backed by the deny scenario.
  const deniedRow = c.access.find((r) => r.role === 'seller' && r.action === 'pay' && r.state === 'new')!;
  assert.equal(deniedRow.cells.a!.decision, 'denied');
  assert.equal(deniedRow.cells.a!.result?.scenario, 'order/deny-pay-seller-new/a');
});

// ── Relations ───────────────────────────────────────────────────────────
function catalogWithListing() {
  const listing = Entity.parse({
    id: 'listing',
    title: 'Listing',
    reader: { tool: 'shop.get', args: { id: '{{key}}' } },
    variants: [{ id: 'physical', title: 'Physical' }, { id: 'digital', title: 'Digital' }],
    states: [
      { id: 'draft', title: 'Draft', match: { status: 'draft' }, setup: [tool('draft')] },
      { id: 'published', title: 'Published', match: { status: 'published' } },
      { id: 'sold-out', title: 'Sold out', variants: ['physical'], match: { status: 'sold_out' } },
    ],
    actions: [
      { id: 'publish', title: 'Publish', kind: 'update', run: 'l.publish' },
      { id: 'sell-out', title: 'Sell out', kind: 'update', run: 'l.sell-out' },
    ],
    transitions: [
      { id: 'publish', title: 'Publish', from: 'draft', to: 'published', action: 'publish', by: ['seller'] },
      { id: 'sell-out', title: 'Sell out', from: 'published', to: 'sold-out', action: 'sell-out', by: ['seller'] },
    ],
  });
  const order = withCreate({
    relations: [{ id: 'listing', entity: 'listing', field: 'listingId', requires: 'published', variants: { a: 'physical', b: 'digital' } }],
    rules: [{ id: 'published-only', title: 'Published only', text: 'x', transition: 'create', requires: [{ kind: 'entity-state', relation: 'listing', states: ['published'] }] }],
  });
  order.transitions.find((t) => t.id === 'pay')!.effects.push({ description: 'Stock down', relation: 'listing', field: 'stock', delta: -1, variants: ['a'] });
  return { order, catalog: { order, listing } };
}

test('relations: setup prepares the related instance first, in the required state and mapped variant', () => {
  const { order, catalog } = catalogWithListing();
  const a = arrange(order, 'b', 'new', new Set(), { catalog })!;
  assert.equal(a.steps[0].do, 'related');
  const rel = a.steps[0] as Extract<(typeof a.steps)[number], { do: 'related' }>;
  assert.deepEqual([rel.relation, rel.variant, rel.state], ['listing', 'digital', 'published']);
  assert.deepEqual(rel.steps.map((s) => (s.do === 'transition' ? s.transition : s.do)), ['prepare', 'expectState', 'publish', 'expectState']);
  // Without the catalog the order can't be prepared at all.
  assert.equal(arrange(order, 'b', 'new'), null);
});

test('relations: effects on the related instance are checked per variant', () => {
  const { order, catalog } = catalogWithListing();
  const plan = buildPlan(order, withAuth, catalog);
  const pay = (v: string) => plan.scenarios.find((s) => s.id === `order/pay/${v}`)!;
  assert.ok(pay('a').steps.some((s) => s.do === 'expectRelated' && s.delta === -1));
  assert.ok(!pay('b').steps.some((s) => s.do === 'expectRelated'));
});

test('relations: a rule on the related state yields one negative scenario per other reachable state', () => {
  const { order, catalog } = catalogWithListing();
  const rules = buildPlan(order, withAuth, catalog).scenarios.filter((s) => s.target === 'published-only');
  assert.deepEqual(rules.map((s) => s.id), [
    'order/rule-published-only-listing-draft/a',
    'order/rule-published-only-listing-sold-out/a',
    'order/rule-published-only-listing-draft/b',
  ]);
  const draft = rules[0].steps[0] as Extract<Scenario['steps'][number], { do: 'related' }>;
  assert.equal(draft.state, 'draft');
  assert.equal(rules[0].steps.at(-1)!.do, 'expectUnavailable');
});

test('relations: validation checks the related entity, its states and variants', () => {
  const { order, catalog } = catalogWithListing();
  order.relations[0].requires = 'gone';
  order.relations[0].variants = { a: 'vinyl' };
  const messages = validateEntity(order, withAuth, undefined, catalog).map((i) => i.message).join('\n');
  assert.match(messages, /Listing has no state “gone”/);
  assert.match(messages, /Listing has no variant “vinyl”/);
});
