import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withPrices } from '../src/agents/runtime.ts';

test('estimates cost and context window for a run whose runtime gave tokens only', () => {
  const u = withPrices({ model: 'gpt-5', input: 1_000_000, output: 100_000, context: { used: 50_000 } });
  assert.equal(u.estimated, true);
  assert.ok(u.costUsd! > 0);
  assert.equal(u.context?.window, 400_000);
});

test('keeps the cost a runtime reported and leaves unknown models alone', () => {
  assert.equal(withPrices({ model: 'claude-opus-5-5', input: 10, output: 10, costUsd: 0.5 }).costUsd, 0.5);
  assert.deepEqual(withPrices({ model: 'no-such-model', input: 1, output: 1 }), { model: 'no-such-model', input: 1, output: 1 });
  assert.deepEqual(withPrices({ input: 1, output: 1 }), { input: 1, output: 1 });
});
