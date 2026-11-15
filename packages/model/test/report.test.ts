import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkRoles, Entity, lintModel, Project, renderSpec, reviewMatrix, validateEntity } from '@tc/model';

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
});
