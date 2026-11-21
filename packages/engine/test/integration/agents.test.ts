// Agents with the model mocked out: scripted runs replay a fixed list of tool
// calls through the same tools a live agent gets, and a fake agent talks MCP
// to the bridge the way Claude Code / Codex do.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Workspace } from '@tc/model';
import { copyWorkspace, startShop } from '../../../../tests/fixtures.ts';
import { createApp } from '../../src/server.ts';
import { onboard } from '../../src/agents/onboard.ts';
import { explore } from '../../src/agents/explore.ts';
import { openBridge } from '../../src/agents/bridge.ts';
import { McpPool } from '../../src/mcp.ts';

process.env.TC_HOME = await mkdtemp(join(tmpdir(), 'tc-home-'));

let ws: Awaited<ReturnType<typeof copyWorkspace>>;
let shop: Awaited<ReturnType<typeof startShop>>;
let app: ReturnType<typeof createApp>;
const post = (path: string, body: unknown) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

// Jobs report progress over SSE; the project endpoint lists their state too.
async function finished(job: string, ms = 90_000) {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await new Promise((r) => setTimeout(r, 250))) {
    const { jobs } = await (await app.request('/api/project')).json();
    const j = jobs.find((x: any) => x.id === job);
    if (j && j.state !== 'running') return j.state;
  }
  throw new Error(`job ${job} still running after ${ms} ms`);
}

before(async () => {
  [ws, shop] = await Promise.all([copyWorkspace(), startShop()]);
  app = createApp(new Workspace(ws.root));
});
after(async () => {
  shop.stop();
  await ws.remove();
});

describe('scripted onboarding', () => {
  test('reads the sources and proposes a model; accepting it grows the model', async () => {
    const { job } = await (await post('/api/onboarding/run', { provider: 'scripted' })).json();
    assert.equal(await finished(job), 'done');

    const pending = (await (await app.request('/api/proposals')).json()).filter((p: any) => p.agent === 'onboarding' && p.status === 'pending');
    const projectLevel = pending.find((p: any) => !p.entity);
    const review = pending.find((p: any) => p.entity === 'review');
    assert.ok(projectLevel && review, 'a project proposal (new entity + backlog) and one for the new entity');

    // The new entity's own proposal waits until the entity itself is accepted.
    const accept = (p: any) => post(`/api/proposals/${p.id}/decide`, { decisions: p.ops.map((_: unknown, op: number) => ({ op, verdict: 'accept' })) });
    assert.equal((await accept(review)).status, 409);
    const created = await accept(projectLevel);
    assert.equal(created.status, 200, await created.clone().text());
    assert.deepEqual((await created.json()).created, ['review']);
    assert.ok((await (await app.request('/api/backlog')).json()).backlog.epics.length > 0);

    const res = await accept(review);
    assert.equal(res.status, 200, await res.clone().text());
    const state = await res.json();
    assert.ok(state.entity.states.length >= 2 && state.plan.scenarios.length > 0, 'accepted ops became a test plan');
    assert.equal((await accept(review)).status, 409, 'a decided proposal cannot be decided twice');
  });
});

describe('findings arrive while the agent works', () => {
  test('what record() hands in is in the inbox before the agent finishes', async () => {
    const own = await copyWorkspace();
    try {
      const w = new Workspace(own.root);
      let before: Promise<string[]> | undefined;
      const proposals = await onboard(w, undefined, {
        provider: 'scripted',
        onLog: (line) => {
          if (line.startsWith('🔧 propose')) before = w.proposals().then((ps) => ps.map((p) => p.id));
        },
      });
      const early = await before!;
      const batch = proposals.find((p) => !p.entity)!;
      assert.ok(early.includes(batch.id), `the project-level batch was saved before propose(): ${early.join(', ')}`);
      assert.ok(proposals.some((p) => p.entity === 'listing' && !early.includes(p.id)), 'the final call adds its own proposals');
    } finally {
      await own.remove();
    }
  });
});

describe('scripted explorer against the demo shop', () => {
  test('walks the seller UI in a real browser and proposes what it saw', { timeout: 120_000 }, async () => {
    const { job } = await (await post('/api/agents/seller-explorer/run', { provider: 'scripted' })).json();
    assert.equal(await finished(job, 110_000), 'done');
    const proposals = await (await app.request('/api/proposals')).json();
    const mine = proposals.filter((p: any) => p.agent === 'seller-explorer' && p.status === 'pending');
    assert.ok(mine.length > 0);
    assert.ok(mine.at(-1).ops.length > 0);
  });

  test('a second run of the same job kind is refused while one runs', async () => {
    const first = await post('/api/agents/client-explorer/run', { provider: 'scripted' });
    const second = await post('/api/agents/client-explorer/run', { provider: 'scripted' });
    assert.equal(second.status, 409);
    const { job } = await first.json();
    await post(`/api/jobs/${job}/cancel`, {});
    assert.ok(['done', 'failed'].includes(await finished(job, 110_000)));
  });
});

describe('the engine sets up state for the explorer', () => {
  test('reach() runs the known path with no clicking by the agent; act() runs a library action', { timeout: 120_000 }, async () => {
    const own = await copyWorkspace();
    try {
      // paid comes from a setup tool, then the seller's own actions accept and ship it.
      await writeFile(join(own.root, 'agents/seller-explorer.yaml'), `steps:
  - call: reach
    input: { state: shipped, variant: standard }
  - call: read
    input: {}
  - call: reach
    input: { state: paid, variant: standard }
  - call: act
    input: { action: order.accept }
  - call: read
    input: {}
  - call: propose
    input: { rationale: setup check, findings: [{ kind: gap, note: nothing new, evidence: [e1, e2] }] }
`);
      const log: string[] = [];
      const p = await explore(new Workspace(own.root), 'seller-explorer', { provider: 'scripted', onLog: (l) => log.push(l) });
      assert.ok(log.some((l) => l.includes('⚙️') && l.includes('Ship')), log.join('\n'));
      assert.match(p.evidence[0].summary, /"status":"shipped"/);
      assert.match(p.evidence[1].summary, /"status":"accepted"/);
    } finally {
      await own.remove();
    }
  });
});

describe('MCP tools of the system under test', () => {
  test('allowlisted tools prepare and read state; others are refused', async () => {
    const project = await new Workspace(ws.root).project();
    const pool = new McpPool(project, ws.root);
    try {
      const order: any = await pool.call('shop.create_order', { variant: 'standard', status: 'paid' }, 'prepare');
      assert.ok(order.id ?? order.key ?? order, 'create_order returned the order');
      await assert.rejects(pool.call('shop.create_order', {}, 'read'), /not allowed for reading/);
      await assert.rejects(pool.call('shop.drop_database', {}, 'prepare'), /not allowed/);
    } finally {
      await pool.close();
    }
  });
});

describe('tool bridge (how Claude Code / Codex reach the tools)', () => {
  test('a fake agent lists and calls tools over MCP; calls are serialized; no token, no access', async () => {
    const order: string[] = [];
    const bridge = await openBridge(
      [
        { name: 'ping', description: 'Returns a word', inputSchema: { properties: {} } },
        { name: 'echo', description: 'Echoes', inputSchema: { properties: { text: { type: 'string' } } } },
      ],
      async (name, input: any) => {
        order.push(`start ${name}`);
        await new Promise((r) => setTimeout(r, name === 'ping' ? 50 : 0));
        order.push(`end ${name}`);
        return name === 'ping' ? { content: 'meridian' } : { content: String(input.text), isError: input.text === 'boom' };
      },
    );
    const client = new Client({ name: 'fake-agent', version: '0' });
    try {
      assert.equal((await fetch(bridge.url, { method: 'POST' })).status, 401);
      await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url), { requestInit: { headers: { authorization: `Bearer ${bridge.token}` } } }));
      assert.deepEqual((await client.listTools()).tools.map((t) => t.name), ['ping', 'echo']);
      const [a, b] = await Promise.all([client.callTool({ name: 'ping', arguments: {} }), client.callTool({ name: 'echo', arguments: { text: 'hi' } })]);
      assert.deepEqual([(a.content as any)[0].text, (b.content as any)[0].text], ['meridian', 'hi']);
      assert.deepEqual(order, ['start ping', 'end ping', 'start echo', 'end echo']);
      assert.equal((await client.callTool({ name: 'echo', arguments: { text: 'boom' } })).isError, true);
    } finally {
      await client.close();
      await bridge.close();
    }
  });
});
