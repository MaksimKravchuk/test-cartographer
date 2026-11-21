// The explorer's Playwright browser tools stay inside the role's interface and type data references.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium } from '@playwright/test';
import { browserTools, BROWSER_TOOLS } from '../../src/agents/browser.ts';

test('browser tools: Playwright MCP narrowed to one interface', async () => {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(req.url === '/app/form' ? '<input aria-label="Password">' : '<button data-testid="go">Go</button>');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/app`;
  const browser = await chromium.launch();
  const page = await (await browser.newContext()).newPage();
  const { tools, close } = await browserTools(page, {
    base,
    fill: (text) => text.replace('{{roles.buyer.password}}', 'hunter2'),
    onSnapshot: async (text) => `evidence e1\n${text}`,
    onNetwork: async (text) => `evidence e2\n${text}`,
  });
  const run = (name: string, args: Record<string, unknown>) => tools.find((t) => t.name === name)!.run(args);
  try {
    assert.deepEqual(tools.map((t) => t.name).sort(), [...BROWSER_TOOLS].sort());
    assert.ok(tools.every((t) => !JSON.stringify(t.schema).includes('filename')), 'no tool writes files');

    await run('browser_navigate', { url: '/' });
    assert.equal(page.url(), `${base}/`);
    const snap = await run('browser_snapshot', {});
    assert.match(snap, /^evidence e1\n/);
    assert.match(snap, /button "Go" \[ref=e\d+\]/);
    await assert.rejects(run('browser_navigate', { url: 'https://example.com/' }), /own interface/);

    await run('browser_navigate', { url: 'form' });
    await run('browser_type', { target: "getByLabel('Password')", text: '{{roles.buyer.password}}' });
    assert.equal(await page.inputValue('input'), 'hunter2');
    assert.match(await run('browser_network_requests', {}), /^evidence e2\n/);
  } finally {
    await close();
    await browser.close();
    server.close();
  }
});
