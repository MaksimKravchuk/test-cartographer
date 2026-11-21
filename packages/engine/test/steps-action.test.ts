import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stepsAction, type ActionContext } from '../src/runtime/actions.ts';

test('stepsAction: refuses what is not a known step or has no target', () => {
  assert.throws(() => stepsAction({ steps: [{ eval: 'process.exit()' }] }));
  assert.throws(() => stepsAction({ steps: [{ click: {} }] }), /a target needs/);
  assert.throws(() => stepsAction({ steps: [] }));
});

test('stepsAction: fills references and takes the new key from the URL', async () => {
  const done: string[] = [];
  let url = '';
  const page = {
    getByLabel: (label: string) => ({ fill: async (v: string) => void done.push(`${label}=${v}`) }),
    url: () => url,
  };
  const ctx = {
    page, key: '7', variant: 'standard', related: {}, data: { roles: { buyer: { card: '4242' } }, entities: {} },
    open: async (path: string) => {
      done.push(`open ${path}`);
      url = `http://shop${path}/order/42`;
    },
  } as unknown as ActionContext;
  const a = stepsAction({ steps: [{ open: '/o/{{key}}' }, { fill: { label: 'Card' }, value: '{{roles.buyer.card}}' }, { keyFromUrl: '/order/(\\d+)' }] });
  assert.equal(await a.run(ctx), '42');
  assert.deepEqual(done, ['open /o/7', 'Card=4242']);
  assert.equal(a.available, undefined);
});
