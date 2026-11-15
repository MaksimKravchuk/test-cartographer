// The product end to end: the model compiles to Playwright tests, they run
// against the demo shop, and they catch exactly the behaviours the demo shop
// gets wrong on purpose (see demo/shop/domain.ts).
import { expect, test } from '@playwright/test';

const KNOWN_DEMO_BUGS = [
  'listing/deny-archive-seller-out-of-stock/physical',
  'order/deny-cancel-client-accepted/standard',
  'order/deny-cancel-client-paid/standard',
];

test('Run all tests: generated tests pass except for the demo shop’s planted bugs', async ({ request }) => {
  test.setTimeout(8 * 60_000);
  const { job } = await (await request.post('/api/runs', { data: {} })).json();
  await expect
    .poll(async () => (await (await request.get('/api/project')).json()).jobs.find((j: { id: string }) => j.id === job)?.state, { timeout: 7 * 60_000, intervals: [2000] })
    .toBe('done');

  const entities: { totals: { scenarios: number; passed: number; failed: number } }[] = await (await request.get('/api/entities')).json();
  const sum = entities.reduce((a, e) => ({ scenarios: a.scenarios + e.totals.scenarios, passed: a.passed + e.totals.passed, failed: a.failed + e.totals.failed }), { scenarios: 0, passed: 0, failed: 0 });
  expect(sum.failed).toBe(KNOWN_DEMO_BUGS.length);
  expect(sum.passed).toBeGreaterThan(0.9 * (sum.scenarios - 30));

  const failed: string[] = [];
  for (const id of ['order', 'listing', 'line-item']) {
    const { results } = await (await request.get(`/api/entities/${id}`)).json();
    for (const [sc, r] of Object.entries(results as Record<string, { status: string }>)) if (r.status === 'failed') failed.push(sc);
  }
  expect(failed.sort()).toEqual(KNOWN_DEMO_BUGS);
});
