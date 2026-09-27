import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyDecisions, arrange, buildPlan, conflicts, coverage, Entity, Project, Proposal, renderMarkdown, template, validateEntity,
  type Scenario,
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
    transitions: [
      { id: 'pay', title: 'Pay', from: 'new', to: 'paid', role: 'client', action: 'o.pay', effects: [{ description: 'Charged', field: 'payment', equals: 'captured' }] },
      { id: 'ship', title: 'Ship', from: 'paid', to: 'shipped', role: 'seller', action: 'o.ship' },
      { id: 'finish', title: 'Finish', from: 'shipped', to: 'done', role: 'client', action: 'o.finish' },
    ],
    forbidden: [{ id: 'client-ship', role: 'client', state: 'paid', transition: 'ship' }],
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

test('plan: a forbidden action checks the action is unavailable and the state is unchanged', () => {
  const s = buildPlan(entity()).scenarios.find((x) => x.id === 'order/forbid-client-ship/a')!;
  assert.deepEqual(s.steps.slice(-2).map((x) => x.do), ['expectUnavailable', 'expectState']);
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

test('validate: catches broken references and disallowed tools', () => {
  const e = entity();
  e.transitions.push({ id: 'bad', title: 'x', from: 'nowhere', to: 'paid', role: 'ghost', action: 'o.bad', guards: [], effects: [], status: 'confirmed' });
  e.states[0].setup = [{ kind: 'tool', tool: 'shop.drop_db', args: {}, key: 'id' }];
  const messages = validateEntity(e, project, new Set(['o.pay'])).map((i) => i.message).join('\n');
  assert.match(messages, /Unknown state “nowhere”/);
  assert.match(messages, /Unknown role “ghost”/);
  assert.match(messages, /shop\.drop_db.*not allowed/);
  assert.match(messages, /Action “o\.ship” is not implemented/);
});

const proposal = Proposal.parse({
  id: 'p1',
  entity: 'order',
  agent: 'explorer',
  createdAt: '2026-01-01T00:00:00Z',
  baseRevision: 'old',
  rationale: 'test',
  evidence: [{ id: 'e1', kind: 'note', summary: 'seen' }],
  ops: [
    { op: 'add', kind: 'transition', value: { id: 'cancel', title: 'Cancel', from: 'paid', to: 'new', role: 'client', action: 'o.cancel' }, evidence: ['e1'] },
    { op: 'add', kind: 'transition', value: { id: 'refund', title: 'Refund', from: 'done', to: 'new', role: 'seller', action: 'o.refund' } },
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
  e.forbidden = [];
  assert.deepEqual(conflicts(e, proposal).map((c) => c.op), [2]);
  assert.throws(() => applyDecisions(e, proposal, [{ op: 2, verdict: 'accept' }]), /is not in the model/);
});

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

test('template: a whole placeholder keeps its type, a partial one is interpolated', () => {
  assert.deepEqual(template({ a: '{{n}}', b: 'x-{{n}}', c: ['{{m}}'], d: '{{missing}}' }, { n: 5, m: true }), { a: 5, b: 'x-5', c: [true], d: '{{missing}}' });
});

// ── Creation, business rules, journeys ─────────────────────────────────
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
    transitions: [{ id: 'create', title: 'Create', from: '@new', to: 'new', role: 'client', action: 'o.create' }, ...e.transitions],
    ...extra,
  });
}

test('arrange: a creating transition from @new replaces the setup tool', () => {
  const a = arrange(withCreate(), 'a', 'paid')!;
  assert.equal(a.method, 'auto');
  assert.deepEqual(a.steps.filter((s) => s.do === 'transition').map((s) => s.do === 'transition' && s.transition), ['create', 'pay']);
  assert.equal(arrange(withCreate(), 'a', '@new')!.method, 'none');
});

test('rules: “authenticated” yields a negative scenario per role without login', () => {
  const e = withCreate({ rules: [{ id: 'signed-in', title: 'Sign in first', text: 'Only signed-in users create', transition: 'create', requires: [{ kind: 'authenticated' }] }] });
  const rules = buildPlan(e, withAuth).scenarios.filter((s) => s.kind === 'rule');
  assert.deepEqual(rules.map((s) => s.id), ['order/rule-signed-in-guest/a', 'order/rule-signed-in-guest/b']);
  assert.deepEqual(rules[0].steps.map((s) => s.do), ['expectUnavailable']);
  // When every role signs in, there is no guest to check with, and the scenario says so.
  const everyoneSignsIn = Project.parse({ ...withAuth, roles: withAuth.roles.filter((r) => r.login) });
  const blocked = buildPlan(e, everyoneSignsIn).scenarios.filter((s) => s.kind === 'rule');
  assert.equal(blocked.length, 2);
  assert.ok(blocked.every((s) => /Add a role without login/.test(s.blocked ?? '')));
});

test('rules: “roles” checks every other role; a related-state condition without the related model is blocked', () => {
  const e = entity({
    rules: [{ id: 'seller-ships', title: 'Only sellers ship', text: 'x', transition: 'ship', requires: [{ kind: 'roles', roles: ['seller'] }, { kind: 'entity-state', relation: 'stock', states: ['available'] }] }],
  });
  const rules = buildPlan(e, withAuth).scenarios.filter((s) => s.kind === 'rule' && s.variant === 'a');
  assert.deepEqual(rules.map((s) => [s.id, !!s.blocked]), [
    ['order/rule-seller-ships-guest/a', false],
    ['order/rule-seller-ships-client/a', false],
    ['order/rule-seller-ships-stock/a', true],
  ]);
  const c = coverage(e, buildPlan(e, withAuth), {});
  assert.equal(c.rules[0].cells.a!.status, 'blocked');
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

test('template: dotted placeholders read nested values such as env', () => {
  assert.deepEqual(template({ p: '{{env.PASS}}', q: 'x-{{env.USER}}' }, { env: { PASS: 's3cret', USER: 'bob' } }), { p: 's3cret', q: 'x-bob' });
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
    transitions: [
      { id: 'publish', title: 'Publish', from: 'draft', to: 'published', role: 'seller', action: 'l.publish' },
      { id: 'sell-out', title: 'Sell out', from: 'published', to: 'sold-out', role: 'seller', action: 'l.sell-out' },
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
  assert.deepEqual(rel.steps.map((s) => s.do === 'transition' ? s.transition : s.do), ['prepare', 'expectState', 'publish', 'expectState']);
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
