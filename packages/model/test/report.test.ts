import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allFindings, checkRoles, disagreements, Entity, lintModel, Project, Proposal, renderSpec, reviewMatrix, validateEntity } from '@tc/model';

const project = Project.parse({
  name: 'Shop',
  interfaces: [{ id: 'ui', title: 'UI', baseUrl: 'http://localhost' }],
  roles: [{ id: 'buyer', title: 'Buyer', interface: 'ui' }],
});
const order = Entity.parse({
  id: 'order',
  title: 'Order',
  variants: [{ id: 'std', title: 'Standard' }],
  actions: [{ id: 'cancel', title: 'Cancel', by: ['buyer'], run: 'order.cancel' }],
  rules: [
    { id: 'until-paid', title: 'Until paid', text: 'A buyer can cancel only until payment.', action: 'cancel' },
    { id: 'struck', title: 'Struck', text: 'Anyone can cancel.', action: 'cancel', status: 'rejected' },
  ],
});

test('a text-only rule on an action is valid and lands in the specification; rejected ones do not', () => {
  const issues = validateEntity(order, project).filter((i) => i.path.startsWith('rules'));
  assert.deepEqual(issues, []);
  const md = renderSpec(project, [order], [], []);
  assert.match(md, /### Buyer → Cancel/);
  assert.match(md, /- Rule: A buyer can cancel only until payment\./);
  assert.doesNotMatch(md, /Anyone can cancel/);
  const bad = Entity.parse({ ...order, rules: [{ id: 'x', title: 'x', text: 'x' }] });
  assert.match(validateEntity(bad, project).find((i) => i.path === 'rules.x')!.message, /needs an action or a transition/);
});

test('lintModel: an action nobody performs, an action with nothing known, vague rule words', () => {
  const e = Entity.parse({
    ...order,
    actions: [...order.actions, { id: 'refund', title: 'Refund' }],
    rules: [{ id: 'r', title: 'r', text: 'Refunds usually arrive in a week.', action: 'cancel' }],
  });
  const msgs = lintModel([e]).map((l) => `${l.ref}: ${l.message}`);
  assert.ok(msgs.some((m) => m.startsWith('action:order.refund: Nobody performs')));
  assert.ok(msgs.some((m) => m.startsWith('action:order.refund: Nothing is known')));
  assert.ok(msgs.some((m) => m.startsWith('rule:order.r: “usually”')));
  assert.ok(!msgs.some((m) => m.startsWith('action:order.cancel')));
  assert.ok(msgs.some((m) => m.startsWith('rule:order.r: No source backs')));
  const sourced = Entity.parse({ ...e, rules: [{ ...e.rules[0], text: 'Refunds arrive within 7 days.', provenance: { source: 'agent', sources: ['wiki'] } }] });
  assert.ok(!lintModel([sourced]).some((l) => l.ref === 'rule:order.r'));
});

test('action.by: an unknown role is caught by validation and by checkRoles', () => {
  const e = Entity.parse({ ...order, actions: [{ id: 'cancel', title: 'Cancel', by: ['customer'], run: 'order.cancel' }] });
  assert.ok(validateEntity(e, project).some((i) => i.path === 'actions.cancel' && /Unknown role “customer”/.test(i.message)));
  assert.match(checkRoles({ op: 'add', kind: 'action', value: { id: 'x', title: 'x', by: ['Buyer'] }, evidence: [] }, project.roles) ?? '', /Buyer/);
});

test('reviewMatrix: provenance confirms, an open finding quoting a source overrides it, a settled one does not', () => {
  const e = Entity.parse({
    ...order,
    rules: [{ id: 'until-paid', title: 'Until paid', text: 'Cancel only until payment.', action: 'cancel', provenance: { source: 'agent', sources: ['wiki', 'code'] } }],
  });
  const finding = (resolution?: object) => ({
    proposal: 'p', entity: 'order', index: 0, createdAt: '',
    finding: { kind: 'contradiction' as const, note: 'code lets a paid order be cancelled', refs: ['rule:order.until-paid'], evidence: ['e1'] },
    quotes: [{ evidence: { id: 'e1', kind: 'source' as const, summary: 'cancel()', source: 'code' } }],
    resolution: resolution as never,
  });
  const row = (fs: Parameters<typeof reviewMatrix>[1]) => reviewMatrix([e], fs).find((r) => r.ref === 'rule:order.until-paid')!;
  assert.deepEqual(row([]).cells, { wiki: 'confirms', code: 'confirms' });
  assert.deepEqual(row([finding()]).cells, { wiki: 'confirms', code: 'contradicts' });
  assert.deepEqual(row([finding({ finding: 0, verdict: 'fine' })]).cells, { wiki: 'confirms', code: 'confirms' });
  const both = { ...finding(), winner: 'wiki', quotes: [...finding().quotes, { evidence: { id: 'e2', kind: 'source' as const, summary: 'until paid', source: 'wiki' } }] };
  assert.deepEqual(row([both]).cells, { wiki: 'confirms', code: 'contradicts' });
  const question = { ...finding(), finding: { ...finding().finding, kind: 'question' as const } };
  assert.deepEqual(row([finding(), question]).cells, { wiki: 'confirms', code: 'contradicts' }, 'an older question does not mask a contradiction');
  assert.deepEqual(row([finding(), { ...finding(), winner: 'code' }]).cells, { wiki: 'confirms', code: 'contradicts' });
  assert.deepEqual(reviewMatrix([e], []).find((r) => r.ref === 'action:order.cancel')!.cells, {});
  // Marks: wiki is a requirement, code is code; a contradiction quoting the code shows under Code.
  const marks = reviewMatrix([e], [finding()], [{ id: 'wiki', kind: 'doc' }, { id: 'code', kind: 'code' }]).find((r) => r.ref === 'rule:order.until-paid')!.marks;
  assert.deepEqual(marks, { requirements: 'confirms', code: 'contradicts', app: false });
  const confirmed = { ...finding(), finding: { ...finding().finding, kind: 'confirmation' as const, refs: ['action:order.cancel'] } };
  assert.deepEqual(reviewMatrix([e], [confirmed]).find((r) => r.ref === 'action:order.cancel')!.cells, { code: 'confirms' }, 'a confirmation fills the cell');
  const notFound = { ...finding(), quotes: [], finding: { ...finding().finding, kind: 'gap' as const, refs: ['action:order.cancel'], evidence: [], searched: ['wiki'] } };
  assert.deepEqual(reviewMatrix([e], [notFound]).find((r) => r.ref === 'action:order.cancel')!.cells, { wiki: 'gap' }, 'a searched source with nothing found shows as a gap');
  const seen = Entity.parse({ ...e, rules: [{ ...e.rules[0], provenance: { source: 'agent', sources: [], seen: true } }] });
  assert.equal(reviewMatrix([seen], []).find((r) => r.ref === 'rule:order.until-paid')!.marks.app, true);
});

test('disagreements leave confirmations out; allFindings keeps them for the review table', () => {
  const p = Proposal.parse({
    id: 'p', entity: 'order', agent: 'reviewer', createdAt: '2026-01-01T00:00:00Z', baseRevision: 'r', rationale: 'r',
    evidence: [{ id: 'e1', kind: 'source', summary: 'expires after 30 minutes', source: 'wiki' }],
    findings: [
      { kind: 'confirmation', note: 'wiki agrees', refs: ['action:order.expire'], evidence: ['e1'] },
      { kind: 'question', note: 'when?', refs: [] },
    ],
  });
  const sources = [{ id: 'wiki', kind: 'doc' as const, title: 'Wiki', priority: 1, enabled: true }] as never;
  assert.deepEqual(disagreements([p], sources, true).map((d) => d.finding.kind), ['question']);
  assert.deepEqual(allFindings([p], sources, true).map((d) => d.finding.kind), ['confirmation', 'question']);
});

test('renderSpec with plans: a rule names its tests; what no test checks is listed', () => {
  const plan = (rules: string[]) => [{ entity: 'order', scenarios: [{ id: 'order/until-paid', kind: 'rule', target: 'x', rules, blocked: null }] }] as never;
  assert.match(renderSpec(project, [order], [], [], plan(['until-paid'])), /- Rule: A buyer can cancel only until payment\. — tests: `order\/until-paid`/);
  const md = renderSpec(project, [order], [], [], plan([]));
  assert.match(md, /until payment\. _\(no test\)_/);
  assert.match(md, /## Not checked by any test\n\n- Order: rule “A buyer can cancel only until payment\.”/);
  assert.doesNotMatch(renderSpec(project, [order], [], []), /Not checked/);
});

test('planned elements: listed in the spec as not built yet, no tests', () => {
  const e = Entity.parse({ ...order, rules: [...order.rules, { id: 'refund', title: 'Refund', text: 'A cancelled paid order is refunded in full.', action: 'cancel', status: 'planned' }] });
  const md = renderSpec(project, [e], [], [], [{ entity: 'order', scenarios: [] }] as never);
  assert.match(md, /### Planned, not built yet\n\n- Rule: A cancelled paid order is refunded in full\./);
  assert.doesNotMatch(md, /Not checked by any test\n\n- Order: rule “A cancelled paid order/);
  const more = Entity.parse({ ...order, states: [{ id: 'refunded', title: 'Refunded', match: { status: 'refunded' }, status: 'planned' }], permits: [{ id: 'see', title: 'See', action: 'cancel', by: ['buyer'], status: 'planned' }] });
  const md2 = renderSpec(project, [more], [], []);
  assert.match(md2, /- State: Refunded/);
  assert.match(md2, /- Buyer may Cancel/);
});
