// The whole loop on an open-license agent: the real Codex CLI (Apache-2.0)
// talks to a model endpoint instead of a ChatGPT sign-in. The endpoint here
// replays each agent's script, so the run is repeatable; in use it would be
// an open model in Ollama, LM Studio or vLLM.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspace } from '@tc/model';
import { copyWorkspace, startShop } from '../../../../tests/fixtures.ts';
import { createApp } from '../../src/server.ts';
import { startReplayModel } from './replay-model.ts';

process.env.TC_HOME = await mkdtemp(join(tmpdir(), 'tc-home-'));
process.env.CODEX_HOME = await mkdtemp(join(tmpdir(), 'codex-home-'));

let ws: Awaited<ReturnType<typeof copyWorkspace>>;
let shop: Awaited<ReturnType<typeof startShop>>;
let model: Awaited<ReturnType<typeof startReplayModel>>;
let app: ReturnType<typeof createApp>;
const post = (path: string, body: unknown) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const get = async (path: string) => (await app.request(path)).json();

async function run(path: string, body: unknown, script: string) {
  await model.replay(join(ws.root, script));
  const { job } = await (await post(path, body)).json();
  for (const t0 = Date.now(); Date.now() - t0 < 110_000; await new Promise((r) => setTimeout(r, 250))) {
    const j = (await get('/api/project')).jobs.find((x: any) => x.id === job);
    if (j && j.state !== 'running') return assert.equal(j.state, 'done', j.error);
  }
  throw new Error(`job ${job} still running`);
}
const accept = (p: any) => post(`/api/proposals/${p.id}/decide`, { decisions: p.ops.map((_: unknown, op: number) => ({ op, verdict: 'accept' })) });

before(async () => {
  [ws, shop, model] = await Promise.all([copyWorkspace(), startShop(), startReplayModel()]);
  const yaml = join(ws.root, 'cartographer.yaml');
  const text = await readFile(yaml, 'utf8');
  await writeFile(yaml, text.replace(/runtime:\r?\n(  .*\r?\n)+/, `runtime:\n  provider: codex\n  model: replay\n  baseUrl: ${model.url}\n  maxSteps: 60\n  subagents: true\n`));
  app = createApp(new Workspace(ws.root));
});
after(async () => {
  shop.stop();
  await model.stop();
  await ws.remove();
});

test('Codex on a model endpoint: ready without a sign-in', async () => {
  const codex = (await get('/api/runtimes')).find((s: any) => s.provider === 'codex');
  assert.equal(codex.ready, true, codex.detail);
  assert.deepEqual(codex.models.map((m: any) => m.id), ['replay']);
});

test('onboarding → accept → review → explore → spec, all through Codex', { timeout: 300_000 }, async () => {
  await run('/api/onboarding/run', {}, 'agents/onboarding.yaml');
  const pending = () => get('/api/proposals').then((ps: any[]) => ps.filter((p) => p.status === 'pending'));
  const onboarding = (await pending()).filter((p) => p.agent === 'onboarding');
  const project = onboarding.find((p) => !p.entity);
  assert.ok(project, 'onboarding proposed the project level');
  assert.equal((await accept(project)).status, 200);
  const entity = onboarding.find((p) => p.entity === 'review');
  const accepted = await (await accept(entity)).json();
  assert.ok(accepted.plan.scenarios.length > 0, 'the accepted model became a test plan');

  await run('/api/onboarding/run', { mode: 'review' }, 'agents/review.yaml');
  const review = (await pending()).find((p) => p.agent === 'review' || /review/.test(p.id));
  assert.ok(review?.findings.some((f: any) => f.kind === 'confirmation'), 'the review confirmed an element from a source');

  await run('/api/agents/seller-explorer/run', {}, 'agents/seller-explorer.yaml');
  const explored = (await pending()).filter((p) => p.agent === 'seller-explorer');
  assert.ok(explored.at(-1)?.ops.length > 0, 'the explorer proposed what it saw in the browser');

  assert.match((await get('/api/spec')).markdown, /## Review/);
  assert.ok(model.seen.length > 60, 'every scripted step went through the model endpoint');
  // Codex offered only our tools (in its MCP namespace) — no shell, no files, no web.
  for (const names of model.seen) assert.ok(!names.some((n) => /exec|shell|apply_patch|web_search|view_image/.test(n)), names.join(','));
});
