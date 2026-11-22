// The engine's HTTP API over a real workspace on disk: what the GUI relies on.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { appendFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspace } from '@tc/model';
import { copyWorkspace } from '../../../../tests/fixtures.ts';
import { createApp } from '../../src/server.ts';

process.env.TC_HOME = await mkdtemp(join(tmpdir(), 'tc-home-')); // keep the recent-projects list out of ~

let ws: Awaited<ReturnType<typeof copyWorkspace>>;
let app: ReturnType<typeof createApp>;
const json = (method: string, body?: unknown) => ({ method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
const get = async (path: string) => {
  const res = await app.request(path);
  assert.equal(res.status, 200, `${path}: ${res.status}`);
  return res.json() as Promise<any>;
};

before(async () => {
  ws = await copyWorkspace();
  app = createApp(new Workspace(ws.root));
});
after(() => ws.remove());

describe('project and entities', () => {
  test('GET /api/project describes the workspace', async () => {
    const p = await get('/api/project');
    assert.equal(p.root, ws.root);
    assert.deepEqual([...p.entities].sort(), ['line-item', 'listing', 'order']);
    assert.ok(p.actions.length > 0, 'the action library is loaded');
  });

  test('GET /api/project tells what each agent task’s latest finished run used', async () => {
    const w = new Workspace(ws.root);
    await w.saveUsage('explore:client-explorer', { model: 'opus', input: 10, output: 1, costUsd: 2, seconds: 200 });
    await appendFile(join(ws.root, 'runs', 'agent-usage.jsonl'), '{"task":"explore:cl'); // a write cut short
    await appendFile(join(ws.root, 'runs', 'agent-usage.jsonl'), '\n');
    await w.saveUsage('explore:client-explorer', { model: 'sonnet', input: 10, output: 1, costUsd: 1, seconds: 250 });
    const { usage } = await get('/api/project');
    assert.deepEqual(Object.keys(usage), ['explore:client-explorer']);
    assert.partialDeepStrictEqual(usage['explore:client-explorer'], { model: 'sonnet', costUsd: 1, seconds: 250 });
    assert.ok(usage['explore:client-explorer'].at);
  });

  test('GET /api/entities lists every entity with a test plan', async () => {
    const list = await get('/api/entities');
    const order = list.find((e: any) => e.id === 'order');
    assert.ok(order.totals.scenarios > 0);
    assert.ok(order.counts.states > 0);
    assert.equal(list.find((e: any) => e.id === 'line-item').parent, 'order');
  });

  test('saving an entity with a stale revision is refused', async () => {
    const { entity, revision } = await get('/api/entities/listing');
    const ok = await app.request('/api/entities/listing', json('PUT', { entity: { ...entity, title: 'Listing (renamed)' }, revision }));
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).entity.title, 'Listing (renamed)');
    const stale = await app.request('/api/entities/listing', json('PUT', { entity, revision }));
    assert.equal(stale.status, 409);
  });

  test('creating an entity validates the id and refuses duplicates', async () => {
    assert.equal((await app.request('/api/entities', json('POST', { id: 'Bad Id', title: 'x' }))).status, 400);
    const created = await app.request('/api/entities', json('POST', { id: 'review', title: 'Review', partOf: 'order' }));
    assert.equal(created.status, 200);
    assert.equal((await app.request('/api/entities', json('POST', { id: 'review', title: 'Review' }))).status, 409);
    assert.equal((await app.request('/api/entities', json('POST', { id: 'ghost', title: 'Ghost', partOf: 'nope' }))).status, 400);
    assert.equal((await app.request('/api/entities/review', { method: 'DELETE' })).status, 200);
    assert.ok(!(await get('/api/project')).entities.includes('review'));
  });
});

describe('knowledge sources, backlog, export', () => {
  test('every save lands in the history with who made it', async () => {
    const { entries } = await get('/api/history?ref=entity:listing');
    const renamed = entries.find((e: any) => e.ref === 'entity:listing' && e.op === 'change');
    assert.deepEqual(renamed.changes.title, ['Listing', 'Listing (renamed)']);
    assert.equal(renamed.by.kind, 'human');
    const review = (await get('/api/history?ref=entity:review')).entries.map((e: any) => e.op);
    assert.deepEqual(review, ['add', 'remove']);
  });

  test('removing a subject takes it off actions, and stops where it is the only actor', async () => {
    const blocked = await app.request('/api/roles/seller', { method: 'DELETE' });
    assert.equal(blocked.status, 409);
    assert.match((await blocked.json()).error, /agent/);
    const { entity, revision } = await get('/api/entities/listing');
    entity.actions[0].by = ['seller', 'guest'];
    assert.equal((await app.request('/api/entities/listing', json('PUT', { entity, revision }))).status, 200);
    const res = await app.request('/api/roles/guest', { method: 'DELETE' });
    assert.equal(res.status, 200, await res.clone().text());
    assert.ok(!(await get('/api/project')).project.roles.some((r: any) => r.id === 'guest'));
    assert.deepEqual((await get('/api/entities/listing')).entity.actions[0].by, ['seller']);
    assert.equal((await get('/api/history?ref=role:guest')).entries.at(-1).op, 'remove');
    assert.equal((await app.request('/api/roles/nope', { method: 'DELETE' })).status, 404);
  });

  test('a source can be added, read and removed', async () => {
    const added = await app.request('/api/sources', json('POST', { name: 'refunds.md', content: '# Refunds\nA refund is issued within 14 days.' }));
    assert.equal(added.status, 200);
    const { id } = await added.json();
    assert.match((await get(`/api/sources/${id}`)).text, /14 days/);
    assert.ok((await get('/api/sources')).sources.some((s: any) => s.id === id && s.lines === 2));
    assert.equal((await app.request(`/api/sources/${id}`, { method: 'DELETE' })).status, 200);
    assert.equal((await app.request(`/api/sources/${id}`)).status, 404);
  });

  test('the backlog comes with its coverage over the model', async () => {
    const b = await get('/api/backlog');
    assert.ok(b.revision !== undefined);
    assert.ok(Array.isArray(b.issues));
    assert.ok(b.coverage);
  });

  test('Markdown export writes one file per entity into export/', async () => {
    const { files } = await (await app.request('/api/export/markdown', { method: 'POST' })).json();
    assert.ok(files.length > 0);
    for (const f of files) assert.ok(existsSync(join(ws.root, f.path)), f.path);
    assert.ok(files.some((f: any) => /order/.test(f.path) && f.content.includes('#')));
  });
});

describe('input checks', () => {
  test('evidence files cannot escape evidence/', async () => {
    const res = await app.request('/api/files/evidence/..%2F..%2Fcartographer.yaml');
    assert.equal(res.status, 400);
  });

  test('filling in data an agent lacked puts the field on the role; a secret goes to .env.local', async () => {
    const w = new Workspace(ws.root);
    await w.saveProposal({
      id: 'need', agent: 'client-explorer', createdAt: new Date().toISOString(), baseRevision: '', rationale: '', evidence: [], ops: [], status: 'decided', decisions: [], resolutions: [],
      findings: [{ kind: 'gap', note: 'Checkout needs a test card', refs: [], evidence: [], need: { owner: 'roles', id: 'client', field: 'card', secret: true } }],
    });
    assert.equal((await app.request('/api/proposals/need/findings/0/data', json('POST', { value: '4242 4242' }))).status, 200);
    const client = (await w.project()).roles.find((r) => r.id === 'client')!;
    assert.deepEqual(client.fields.find((f) => f.id === 'card'), { id: 'card', value: '{{env.TC_ROLE_CLIENT_CARD}}', secret: true });
    assert.equal(w.env().TC_ROLE_CLIENT_CARD, '4242 4242');
    assert.equal((await w.proposal('need')).resolutions[0].verdict, 'answered');
    assert.equal((await app.request('/api/proposals/syn-none/findings/0/data', json('POST', { value: 'x' }))).status >= 400, true);
  });

  test('answering yes to a synonym question files it in the glossary', async () => {
    const w = new Workspace(ws.root);
    await w.saveProposal({
      id: 'syn', agent: 'onboarding', createdAt: new Date().toISOString(), baseRevision: '', rationale: '', evidence: [], ops: [], status: 'decided', decisions: [], resolutions: [],
      findings: [{ kind: 'question', note: 'Is a purchase the same as a basket?', refs: [], evidence: [], synonym: { term: 'Order', synonym: 'basket' } },
        { kind: 'question', note: "Should 'cart' go in the glossary as a synonym of Order?", refs: [], evidence: [] }],
    });
    assert.equal((await app.request('/api/proposals/syn/findings/0', json('POST', { verdict: 'yes' }))).status, 200);
    // A question asked before agents gave the pair is read from its wording.
    assert.equal((await app.request('/api/proposals/syn/findings/1', json('POST', { verdict: 'yes' }))).status, 200);
    const order = (await get('/api/project')).project.glossary.find((t: any) => t.term === 'Order');
    assert.deepEqual(order.synonyms, ['purchase', 'basket', 'cart']);
    assert.equal((await w.proposal('syn')).resolutions[0].verdict, 'yes');
  });

  test('a change to an entity not in the model yet can bring the entity with it', async () => {
    const w = new Workspace(ws.root);
    const base = { agent: 'onboarding', createdAt: new Date().toISOString(), baseRevision: 'new', rationale: '', evidence: [], findings: [], status: 'pending' as const, decisions: [], resolutions: [] };
    await w.saveProposal({ ...base, id: 'auth-project', ops: [{ op: 'add', kind: 'entity', value: { id: 'auth', title: 'Account' }, evidence: [] }] });
    const action = (id: string) => ({ op: 'add' as const, kind: 'action' as const, value: { id, title: id }, evidence: [] });
    await w.saveProposal({ ...base, id: 'auth-ops', entity: 'auth', ops: [action('signup'), action('login')] });

    // Striking out needs no entity; accepting asks for it.
    assert.equal((await app.request('/api/proposals/auth-ops/decide', json('POST', { decisions: [{ op: 1, verdict: 'reject' }] }))).status, 200);
    assert.ok(!(await w.entityIds()).includes('auth'));
    assert.equal((await app.request('/api/proposals/auth-ops/decide', json('POST', { decisions: [{ op: 0, verdict: 'accept' }] }))).status, 409);

    const res = await app.request('/api/proposals/auth-ops/decide', json('POST', { decisions: [{ op: 0, verdict: 'accept' }], createEntity: true }));
    assert.equal(res.status, 200);
    const { entity } = await w.entity('auth');
    assert.equal(entity.title, 'Account', "the agent's own entity op is used");
    assert.deepEqual(entity.actions.map((a) => a.id), ['signup']);
    assert.equal((await w.proposal('auth-project')).status, 'decided');
    assert.equal((await w.proposal('auth-ops')).status, 'decided');
  });

  test('a malformed body is a 400 with a readable message', async () => {
    const res = await app.request('/api/project', json('PUT', { project: { name: 42 } }));
    assert.equal(res.status, 400);
    assert.ok((await res.json()).error);
  });

  test('an unknown agent is a 404', async () => {
    assert.equal((await app.request('/api/agents/nobody/run', json('POST', { provider: 'scripted' }))).status, 404);
  });
});

// Last: creating a project switches the engine to it.
describe('project form', () => {
  test('GET /api/folders tells a project, an empty folder and a folder still to be made apart', async () => {
    const here = await get(`/api/folders?path=${encodeURIComponent(ws.root)}`);
    assert.equal(here.project, 'Demo Shop');
    const empty = await mkdtemp(join(tmpdir(), 'tc-new-'));
    const blank = await get(`/api/folders?path=${encodeURIComponent(empty)}`);
    assert.deepEqual([blank.dir, blank.empty, blank.project], [true, true, undefined]);
    const later = await get(`/api/folders?path=${encodeURIComponent(join(empty, 'shop-tests'))}`);
    assert.deepEqual([later.exists, later.parentExists], [false, true]);
  });

  test('POST /api/projects/create takes the app URL, a code folder and an agent', async () => {
    const root = join(await mkdtemp(join(tmpdir(), 'tc-new-')), 'shop-tests');
    const res = await app.request('/api/projects/create', json('POST', { root, name: 'Shop', baseUrl: 'http://localhost:4400', code: ws.root, provider: 'codex' }));
    assert.equal(res.status, 200);
    const p = await new Workspace(root).project();
    assert.equal(p.interfaces[0].baseUrl, 'http://localhost:4400');
    assert.equal(p.runtime?.provider, 'codex');
    const sources = await new Workspace(root).sources();
    assert.deepEqual(sources.map((s) => [s.kind, s.kind === 'code' && s.path]), [['code', ws.root]]);
    // The starting subjects say where they came from.
    const history = await new Workspace(root).history();
    assert.deepEqual(history.map((e) => [e.ref, e.by.kind]), [['role:guest', 'template'], ['role:user', 'template']]);
  });
});
