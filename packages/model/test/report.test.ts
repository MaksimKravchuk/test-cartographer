import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Entity, lintModel, Project, renderSpec, validateEntity } from '@tc/model';

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
