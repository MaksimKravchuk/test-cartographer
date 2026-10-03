// Explorer agent: studies one role's interface, collects evidence
// and packages its findings as a proposal (a patch to the model). It does not
// change the model — a person makes the decision.
import { chromium, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import {
  dataContext, dataValues, Finding, Op, Proposal, redactFields, scrubSecrets, secretValues, toYaml, type Evidence, type Workspace,
} from '@tc/model';
import { McpPool, getPath, template } from '../mcp.ts';
import { createSession, type ToolResult, type ToolSpec } from './providers.ts';
import { loadActions } from '../actions-loader.ts';

export type ExploreOptions = {
  onLog?: (line: string) => void;
  provider?: 'scripted' | 'live';
  headed?: boolean;
  signal?: AbortSignal;
};

const MAX_TEXT = 12_000;
const clip = (s: string) => (s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + '\n…(truncated)' : s);

const system = (p: {
  role: string; iface: string; baseUrl: string; entity: string; goal: string; prepare: string[]; contracts: string[]; data: string;
}) => `You are exploring a web application as the role “${p.role}” through the interface “${p.iface}” (${p.baseUrl}).
Goal: ${p.goal}

Your task is to reconstruct the behavior of the entity “${p.entity}” — its variants, states, actions and transitions — and propose changes to the model.

The model is a closed world: for a human role, anything not allowed by a confirmed transition or permit is already
denied — you do NOT need to propose what a role can't do. Instead, if you see the role given an action the model
doesn't allow (or an action denied by the model that the role can in fact perform), report it as a finding
(kind=contradiction), with evidence, so a person can look at the gap.

Rules:
- Observed behavior is not a requirement. You report what you saw and attach evidence; a person decides.
- If a behavior looks like a bug or contradicts the model, still propose the operation, but add a finding with kind=contradiction or question.
- Every operation references its evidence (ids from snapshot/read) in the evidence field.
- Call model() first to see the current model. Don't propose what already exists; use new ids (Latin letters, kebab-case).
- Prepare data only via prepare(); available setup tools: ${p.prepare.join(', ') || 'none'}. Verify every instance with read().
- You may open only pages of your own interface (open takes a path relative to baseUrl).
${p.contracts.length ? `- Available contracts: ${p.contracts.join(', ')}.` : ''}
- You are already signed in as your role, if it has a sign-in. To type into a form, use fill().
- When the exploration is done, call propose() exactly once.
${p.data ? `
Data a person attached to subjects (roles) and objects (entities) — logins, test values, notes. Use it where an
action needs it. A secret shows only as its {{…}} reference: pass that reference to fill() as is and the engine
types the real value; you never see it and don't need to.
${p.data}
` : ''}
Element shapes for ops (op=add, value):
- variant: { id, title }
- state: { id, title, variants?: [id], match: { <field from read()>: <value> } }
- action: { id, title, kind?: "create"|"read"|"update"|"command"|"delete", run?: "<action-library name>" }
  A verb the role can apply to the entity, named after what it does — not tied to a state or a permission yet.
  A UI verb you haven't seen before is proposed as an action op (its \`run\` is the name you'd give it in the
  actions/ library), together with the transition or permit op(s) that use it.
- transition: { id, title, from, to, action: "<action id>", by: ["${p.role}"], variants?: [id], guards?: [text], effects?: [{ description, field?, equals? }] }
  \`action\` refers to an action op's id (new or existing), \`by\` lists every role that may perform it.
- permit: { id, title, action: "<action id>", by: ["${p.role}"], states?: [id], variants?: [id], effects?: [...] }
  Use a permit instead of a transition for an action that leaves the state as it is (read, update, a command with no state change).
For op=update: { kind, id, set: { fields } }. For op=remove: { kind, id }.`;

export async function explore(ws: Workspace, agentId: string, opts: ExploreOptions = {}): Promise<Proposal> {
  const log = opts.onLog ?? (() => {});
  const project = await ws.project();
  const agent = project.agents.find((a) => a.id === agentId);
  if (!agent) throw new Error(`Agent “${agentId}” is not defined in cartographer.yaml`);
  if (!agent.role || !agent.entity) throw new Error(`Explore agent “${agentId}” needs both a role and an entity (add them in cartographer.yaml)`);
  const role = project.roles.find((r) => r.id === agent.role)!;
  const iface = project.interfaces.find((i) => i.id === role.interface)!;
  const { entity, revision } = await ws.entity(agent.entity);
  const catalog = await ws.catalog();
  // Fields of every role and entity: real values for the engine (sign-in,
  // fill), references in place of secrets for anything the model reads.
  const data = dataValues(project.roles, Object.values(catalog), process.env);
  const secrets = secretValues(project.roles, Object.values(catalog), process.env);
  const related = new Set([
    ...entity.relations.map((r) => r.entity),
    ...Object.values(catalog).filter((e) => e.relations.some((r) => r.entity === entity.id)).map((e) => e.id),
  ]);
  related.delete(entity.id);
  if (!entity.reader) throw new Error(`Entity “${entity.id}” has no reader yet — add one to its model before exploring it`);
  const reader = entity.reader;

  const scripted = opts.provider === 'scripted' || !project.inference || project.inference.provider === 'scripted';
  const inference = scripted ? { provider: 'scripted' as const, model: 'script', maxSteps: 200, fallbacks: false } : project.inference!;

  const proposalId = `${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}-${agent.id}`;
  const runTag = `explore-${proposalId}`;
  const evidenceDir = `evidence/${proposalId}`;
  await mkdir(ws.path(evidenceDir), { recursive: true });

  const mcp = new McpPool(project, ws.root);
  const browser = await chromium.launch({ headless: !opts.headed });
  const page: Page = await (await browser.newContext()).newPage();
  const origin = new URL(iface.baseUrl).origin;
  const base = iface.baseUrl.replace(/\/$/, '');

  // The agent explores as a signed-in user when its role has a login.
  if (role.login) {
    const login = (await loadActions(ws))[role.login.action];
    if (!login) throw new Error(`Login action “${role.login.action}” is not in the actions/ library`);
    log(`🔑 signing in as ${role.title}`);
    await login.run({
      page, role, iface, variant: '', key: '', entity: {}, related: {}, data,
      args: template(role.login.args, { env: process.env, ...data }),
      open: async (path = '') => {
        await page.goto(base + path);
      },
    });
  }

  const evidence: Evidence[] = [];
  const addEvidence = (e: Omit<Evidence, 'id'>) => {
    const id = `e${evidence.length + 1}`;
    evidence.push({ id, ...e });
    return id;
  };
  let key: string | undefined;
  let proposal: Proposal | undefined;

  const prepareTools = Object.entries(project.mcp).flatMap(([s, cfg]) => cfg.allow.prepare.map((t) => `${s}.${t}`));

  const tools: (ToolSpec & { run(input: any): Promise<string> })[] = [
    {
      name: 'model',
      description: 'The current entity model (YAML), the project roles, and the entities it is related to (in brief).',
      input: z.object({}),
      run: async () =>
        toYaml({
          roles: redactFields('roles', project.roles, process.env),
          entity: redactFields('entities', [entity], process.env)[0],
          related: redactFields('entities', [...related].flatMap((id) => (catalog[id] ? [catalog[id]] : [])), process.env).map((e) => ({
            id: e.id, title: e.title, description: e.description, key: e.key, relations: e.relations, fields: e.fields,
            states: e.states.map((s) => ({ id: s.id, title: s.title, match: s.match })),
            actions: e.actions.map((a) => ({ id: a.id, title: a.title })),
          })),
        }),
    },
    {
      name: 'prepare',
      description: 'Create a test instance via an allowed setup tool. Returns the result (JSON); the instance key is remembered for read().',
      input: z.object({ tool: z.string().describe(`One of: ${prepareTools.join(', ')}`), args: z.record(z.string(), z.unknown()) }),
      run: async ({ tool, args }) => {
        const result = await mcp.call(tool, { ...args, tag: runTag }, 'prepare');
        const k = getPath(result, entity.key);
        if (k !== undefined) key = String(k);
        return JSON.stringify(result, null, 2);
      },
    },
    {
      name: 'read',
      description: 'Read the actual state of an instance via the model\'s read tool. Saved as evidence.',
      input: z.object({ key: z.string().optional().describe('Key; defaults to the most recently prepared one') }),
      run: async ({ key: k }) => {
        const target = k ?? key;
        if (!target) throw new Error('No key: call prepare() first');
        const result = await mcp.call(reader.tool, template(reader.args, { key: target }), 'read');
        const file = `${evidenceDir}/e${evidence.length + 1}.json`;
        await writeFile(ws.path(file), JSON.stringify(result, null, 2));
        const id = addEvidence({ kind: 'probe', summary: `read ${target}: ${JSON.stringify(Object.fromEntries(['status', 'payment', 'variant'].map((f) => [f, getPath(result, f)])))}`, path: file });
        return `evidence ${id}\n${JSON.stringify(result, null, 2)}`;
      },
    },
    {
      name: 'open',
      description: 'Open an interface page by a path relative to baseUrl, e.g. "/" or "/orders/<id>".',
      input: z.object({ path: z.string() }),
      run: async ({ path }) => {
        if (/^[a-z]+:/i.test(path)) throw new Error('Only relative paths within the interface');
        await page.goto(base + (path.startsWith('/') ? path : `/${path}`));
        return `opened ${page.url()}`;
      },
    },
    {
      name: 'snapshot',
      description: 'Snapshot of the current page: URL, accessibility tree and button test ids. Saved as evidence (screenshot + snapshot).',
      input: z.object({ note: z.string().optional().describe('What is visible on the page') }),
      run: async ({ note }) => {
        const n = evidence.length + 1;
        const aria = await page.locator('body').ariaSnapshot();
        const testIds = await page.$$eval('[data-testid]', (els) => els.map((e) => `${e.getAttribute('data-testid')}: ${(e.textContent ?? '').trim().slice(0, 60)}`));
        await page.screenshot({ path: ws.path(`${evidenceDir}/e${n}.png`), fullPage: true });
        await writeFile(ws.path(`${evidenceDir}/e${n}.aria.yaml`), aria);
        const id = addEvidence({ kind: 'screenshot', summary: note ?? `snapshot ${page.url()}`, path: `${evidenceDir}/e${n}.png`, url: page.url() });
        return clip(`evidence ${id}\nurl: ${page.url()}\ntest ids:\n${testIds.map((t) => `  ${t}`).join('\n')}\n\n${aria}`);
      },
    },
    {
      name: 'click',
      description: 'Click an element by data-testid (preferred) or by role and name.',
      input: z.object({ testId: z.string().optional(), role: z.enum(['button', 'link']).optional(), name: z.string().optional() }),
      run: async ({ testId, role: r, name }) => {
        const loc = testId ? page.getByTestId(testId) : r && name ? page.getByRole(r, { name }) : null;
        if (!loc) throw new Error('Provide testId or role+name');
        await loc.first().click({ timeout: 5_000 });
        await page.waitForLoadState();
        if (new URL(page.url()).origin !== origin) {
          await page.goBack();
          throw new Error('Navigation outside the interface was cancelled');
        }
        return `ok, url: ${page.url()}`;
      },
    },
    {
      name: 'fill',
      description:
        'Type into an input by data-testid (preferred) or by its label. `value` may hold {{roles.<id>.<field>}} / {{entities.<id>.<field>}} references to data from your instructions — the engine types the real value.',
      input: z.object({ testId: z.string().optional(), label: z.string().optional(), value: z.string() }),
      run: async ({ testId, label, value }) => {
        const loc = testId ? page.getByTestId(testId) : label ? page.getByLabel(label) : null;
        if (!loc) throw new Error('Provide testId or label');
        await loc.first().fill(template(value, data), { timeout: 5_000 });
        return `filled ${testId ?? label}`;
      },
    },
    {
      name: 'contract',
      description: 'Read a system contract (OpenAPI, etc.) by id.',
      input: z.object({ id: z.string() }),
      run: async ({ id }) => {
        const c = project.contracts.find((x) => x.id === id);
        if (!c) throw new Error(`No contract “${id}”`);
        const text = await (await fetch(c.url)).text();
        addEvidence({ kind: 'contract', summary: c.title, url: c.url });
        return clip(text);
      },
    },
    {
      name: 'propose',
      description: 'Finish the exploration: submit a proposal of model changes.',
      input: z.object({
        rationale: z.string(),
        ops: z.array(z.record(z.string(), z.unknown())),
        findings: z.array(z.record(z.string(), z.unknown())).default([]),
      }),
      run: async ({ rationale, ops, findings }) => {
        const parsedOps = z.array(Op).safeParse(ops);
        if (!parsedOps.success) throw new Error(`ops do not match the schema: ${z.prettifyError(parsedOps.error)}`);
        const parsedFindings = z.array(Finding).safeParse(findings);
        if (!parsedFindings.success) throw new Error(`findings do not match the schema: ${z.prettifyError(parsedFindings.error)}`);
        const known = new Set(evidence.map((x) => x.id));
        const unknown = [...parsedOps.data, ...parsedFindings.data].flatMap((x) => x.evidence).filter((id) => !known.has(id));
        if (unknown.length) throw new Error(`Unknown evidence: ${[...new Set(unknown)].join(', ')}. Available: ${[...known].join(', ')}`);
        proposal = Proposal.parse({
          id: proposalId,
          entity: entity.id,
          agent: agent.id,
          role: role.id,
          createdAt: new Date().toISOString(),
          baseRevision: revision,
          rationale,
          evidence,
          ops: parsedOps.data,
          findings: parsedFindings.data,
        });
        await ws.saveProposal(proposal);
        return `proposal ${proposalId} saved`;
      },
    },
  ];

  // Whatever a tool hands back — a page, a read result, an error — goes to the
  // model with every secret's value replaced by its reference.
  for (const tool of tools) {
    const run = tool.run;
    tool.run = async (input) => {
      try {
        return scrubSecrets(await run(input), secrets);
      } catch (e) {
        throw new Error(scrubSecrets((e as Error).message, secrets));
      }
    };
  }

  const session = await createSession(
    inference,
    {
      system: system({
        role: role.title, iface: iface.title, baseUrl: iface.baseUrl, entity: entity.title, goal: agent.goal,
        prepare: prepareTools, contracts: project.contracts.map((c) => `${c.id} (${c.title})`),
        data: dataContext(project.roles, Object.values(catalog), process.env, role.id),
      }),
      prompt: `Start exploring. Goal: ${agent.goal}`,
      tools,
      vars: () => ({ key }),
    },
    agent.script ? ws.path(agent.script) : undefined,
  );

  try {
    let results: ToolResult[] = [];
    for (let step = 0; step < inference.maxSteps && !proposal; step++) {
      if (opts.signal?.aborted) throw new Error('Exploration stopped');
      const turn = await session.next(results);
      if (turn.text) log(`💬 ${turn.text}`);
      if (turn.done) break;
      results = [];
      for (const call of turn.calls) {
        const tool = tools.find((t) => t.name === call.name);
        const parsed = tool?.input.safeParse(call.input);
        if (!tool || !parsed?.success) {
          results.push({ id: call.id, content: tool ? `Invalid arguments: ${z.prettifyError(parsed!.error!)}` : `No tool ${call.name}`, isError: true });
          continue;
        }
        log(`🔧 ${call.name} ${JSON.stringify(call.input).slice(0, 160)}`);
        try {
          results.push({ id: call.id, content: await tool.run(parsed.data) });
        } catch (e) {
          log(`   ⚠ ${(e as Error).message}`);
          results.push({ id: call.id, content: (e as Error).message, isError: true });
        }
      }
    }
  } finally {
    await browser.close();
    await mcp.close();
  }
  if (!proposal) throw new Error('The agent finished without a proposal (propose was not called)');
  return proposal;
}
