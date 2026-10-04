// Explorer agent: studies one role's interface, collects evidence
// and packages its findings as a proposal (a patch to the model). It does not
// change the model — a person makes the decision.
import { chromium, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import {
  checkRoles, dataContext, dataValues, Finding, Op, Proposal, redactFields, resolveRuntime, scrubSecrets, secretValues, toYaml, type Evidence, type Workspace,
} from '@tc/model';
import { McpPool, getPath, template } from '../mcp.ts';
import { listOf, runAgent, type Tool } from './runtime.ts';
import { loadActions } from '../actions-loader.ts';

export type ExploreOptions = {
  onLog?: (line: string) => void;
  provider?: 'scripted' | 'live';
  headed?: boolean;
  signal?: AbortSignal;
};

// A real back-office page with refs runs to 10–15k characters.
const MAX_TEXT = 20_000;
const clip = (s: string) => (s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + '\n…(truncated)' : s);

// roleTitle is how the prose names the role; roleId is what the model's `by` references.
const system = (p: {
  roleTitle: string; roleId: string; iface: string; baseUrl: string; entity: string; goal: string; prepare: string[]; contracts: string[]; data: string;
}) => `You are exploring a web application as the role “${p.roleTitle}” (id \`${p.roleId}\`) through the interface “${p.iface}” (${p.baseUrl}).
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
- You are already signed in as your role, if it has a sign-in. If the app signs you out, call login().
- snapshot() marks elements with [ref=…]. Pass a ref to click(), fill() or select() to reach what has no test id
  or accessible name — an icon-only menu button, an input whose label isn't tied to it. Refs go stale when the
  page changes: snapshot() again before using new ones.
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
- transition: { id, title, from, to, action: "<action id>", by: ["${p.roleId}"], variants?: [id], guards?: [text], effects?: [{ description, field?, equals? }] }
  \`action\` refers to an action op's id (new or existing), \`by\` lists every role that may perform it — by role id
  (the ids model() lists under roles), never by title. An action that creates the entity is a transition
  from "@new" to the state the new instance starts in.
- permit: { id, title, action: "<action id>", by: ["${p.roleId}"], states?: [id], variants?: [id], effects?: [...] }
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
  // Evidence files land in the workspace and may be committed: they get the same
  // redaction as what the model reads. (A screenshot can't be scrubbed.)
  const scrub = (text: string) => scrubSecrets(text, secrets);
  const related = new Set([
    ...entity.relations.map((r) => r.entity),
    ...Object.values(catalog).filter((e) => e.relations.some((r) => r.entity === entity.id)).map((e) => e.id),
  ]);
  related.delete(entity.id);
  if (!entity.reader) throw new Error(`Entity “${entity.id}” has no reader yet — add one to its model before exploring it`);
  const reader = entity.reader;

  const runtime = opts.provider === 'scripted' ? 'scripted' : resolveRuntime(project, agent) ?? 'scripted';

  const proposalId = `${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}-${agent.id}`;
  const runTag = `explore-${proposalId}`;
  const evidenceDir = `evidence/${proposalId}`;
  await mkdir(ws.path(evidenceDir), { recursive: true });

  const mcp = new McpPool(project, ws.root);
  const browser = await chromium.launch({ headless: !opts.headed });
  const page: Page = await (await browser.newContext()).newPage();
  const origin = new URL(iface.baseUrl).origin;
  const base = iface.baseUrl.replace(/\/$/, '');

  // The agent explores as a signed-in user when its role has a login. An app
  // may sign the user out mid-run (a forbidden call, an expired session), so the
  // agent can ask for it again with login().
  const login = role.login ? (await loadActions(ws))[role.login.action] : undefined;
  if (role.login && !login) throw new Error(`Login action “${role.login.action}” is not in the actions/ library`);
  const signIn = async () => {
    if (!role.login || !login) return;
    log(`🔑 signing in as ${role.title}`);
    await login.run({
      page, role, iface, variant: '', key: '', entity: {}, related: {}, data,
      args: template(role.login.args, { env: process.env, ...data }),
      open: async (path = '') => {
        await page.goto(base + path);
      },
    });
  };
  await signIn();

  // A ref from the latest snapshot() ([ref=…]) reaches elements a test id or a
  // role and name can't: an icon-only menu button, an input whose label isn't
  // tied to it. Refs go stale once the page changes; snapshot() again for new ones.
  const target = (t: { ref?: string; testId?: string; role?: string; name?: string; label?: string; placeholder?: string }) => {
    if (t.ref) return page.locator(`aria-ref=${t.ref}`);
    if (t.testId) return page.getByTestId(t.testId);
    if (t.role) return page.getByRole(t.role as Parameters<Page['getByRole']>[0], t.name ? { name: t.name } : {});
    if (t.label) return page.getByLabel(t.label);
    if (t.placeholder) return page.getByPlaceholder(t.placeholder);
    return null;
  };
  // Single-page apps render after `load`: let the network go quiet first, but
  // don't wait on apps that poll forever.
  const settle = () => page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => {});

  const evidence: Evidence[] = [];
  const addEvidence = (e: Omit<Evidence, 'id'>) => {
    const id = `e${evidence.length + 1}`;
    evidence.push({ id, ...e });
    return id;
  };
  let key: string | undefined;
  let proposal: Proposal | undefined;

  const prepareTools = Object.entries(project.mcp).flatMap(([s, cfg]) => cfg.allow.prepare.map((t) => `${s}.${t}`));

  const tools: Tool[] = [
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
        const text = scrub(JSON.stringify(result, null, 2));
        const file = `${evidenceDir}/e${evidence.length + 1}.json`;
        await writeFile(ws.path(file), text);
        const id = addEvidence({ kind: 'probe', summary: scrub(`read ${target}: ${JSON.stringify(Object.fromEntries(['status', 'payment', 'variant'].map((f) => [f, getPath(result, f)])))}`), path: file });
        return `evidence ${id}\n${text}`;
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
      description:
        'Snapshot of the current page: URL, accessibility tree with element refs ([ref=…]) and button test ids. Saved as evidence (screenshot + snapshot).',
      input: z.object({ note: z.string().optional().describe('What is visible on the page') }),
      run: async ({ note }) => {
        const n = evidence.length + 1;
        await settle();
        const aria = scrub((await page.ariaSnapshot({ mode: 'ai' })).replaceAll(' [cursor=pointer]', ''));
        const testIds = await page.$$eval('[data-testid]', (els) => els.map((e) => `${e.getAttribute('data-testid')}: ${(e.textContent ?? '').trim().slice(0, 60)}`));
        await page.screenshot({ path: ws.path(`${evidenceDir}/e${n}.png`), fullPage: true });
        await writeFile(ws.path(`${evidenceDir}/e${n}.aria.yaml`), aria);
        const id = addEvidence({ kind: 'screenshot', summary: note ?? `snapshot ${page.url()}`, path: `${evidenceDir}/e${n}.png`, url: page.url() });
        return clip(`evidence ${id}\nurl: ${page.url()}\ntest ids:\n${testIds.map((t) => `  ${t}`).join('\n')}\n\n${aria}`);
      },
    },
    {
      name: 'click',
      description: 'Click an element by its ref from the latest snapshot, by data-testid, or by ARIA role and name.',
      input: z.object({
        ref: z.string().optional().describe('Element ref from the latest snapshot, e.g. "f1e42"'),
        testId: z.string().optional(),
        role: z.string().optional().describe('ARIA role: button, link, menuitem, tab, checkbox, radio, option…'),
        name: z.string().optional(),
      }),
      run: async ({ ref, testId, role: r, name }) => {
        const loc = target({ ref, testId, role: r, name });
        if (!loc) throw new Error('Provide ref, testId or role (+ name)');
        await loc.first().click({ timeout: 5_000 });
        await page.waitForLoadState();
        await settle();
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
        'Type into an input by its ref from the latest snapshot, data-testid, label or placeholder. `value` may hold {{roles.<id>.<field>}} / {{entities.<id>.<field>}} references to data from your instructions — the engine types the real value.',
      input: z.object({
        ref: z.string().optional(),
        testId: z.string().optional(),
        label: z.string().optional(),
        placeholder: z.string().optional(),
        value: z.string(),
      }),
      run: async ({ ref, testId, label, placeholder, value }) => {
        const loc = target({ ref, testId, label, placeholder });
        if (!loc) throw new Error('Provide ref, testId, label or placeholder');
        await loc.first().fill(template(value, data), { timeout: 5_000 });
        return `filled ${ref ?? testId ?? label ?? placeholder}`;
      },
    },
    {
      name: 'select',
      description:
        'Pick an option of a native <select> by its ref, data-testid or label. For a custom dropdown, click() it open and click() the option instead.',
      input: z.object({ ref: z.string().optional(), testId: z.string().optional(), label: z.string().optional(), option: z.string().describe('Option label or value') }),
      run: async ({ ref, testId, label, option }) => {
        const loc = target({ ref, testId, label });
        if (!loc) throw new Error('Provide ref, testId or label');
        const picked = await loc.first().selectOption(option, { timeout: 5_000 });
        await settle();
        return `selected ${picked.join(', ')}`;
      },
    },
    {
      name: 'press',
      description: 'Press a key on the focused element, e.g. "Enter" to submit or "Escape" to close a menu or dialog.',
      input: z.object({ key: z.string() }),
      run: async ({ key: k }) => {
        await page.keyboard.press(k);
        await settle();
        return `pressed ${k}, url: ${page.url()}`;
      },
    },
    {
      name: 'login',
      description: 'Sign in again as your role — when the app has signed you out (a forbidden action, an expired session).',
      input: z.object({}),
      run: async () => {
        if (!role.login) throw new Error(`${role.title} has no sign-in: it acts as a guest`);
        await signIn();
        return `signed in as ${role.title}, url: ${page.url()}`;
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
        ops: listOf(Op),
        findings: listOf(Finding).default([]),
      }),
      run: async ({ rationale, ops, findings }) => {
        const parsedOps = z.array(Op).safeParse(ops);
        if (!parsedOps.success) throw new Error(`ops do not match the schema: ${z.prettifyError(parsedOps.error)}`);
        const parsedFindings = z.array(Finding).safeParse(findings);
        if (!parsedFindings.success) throw new Error(`findings do not match the schema: ${z.prettifyError(parsedFindings.error)}`);
        const known = new Set(evidence.map((x) => x.id));
        const unknown = [...parsedOps.data, ...parsedFindings.data].flatMap((x) => x.evidence).filter((id) => !known.has(id));
        if (unknown.length) throw new Error(`Unknown evidence: ${[...new Set(unknown)].join(', ')}. Available: ${[...known].join(', ')}`);
        const badRoles = parsedOps.data.flatMap((op, i) => {
          const problem = checkRoles(op, project.roles);
          return problem ? [`op #${i}: ${problem}`] : [];
        });
        if (badRoles.length) throw new Error(badRoles.join('\n'));
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
        return scrub(await run(input));
      } catch (e) {
        throw new Error(scrub((e as Error).message));
      }
    };
  }

  try {
    await runAgent({
      runtime,
      system: system({
        roleTitle: role.title, roleId: role.id, iface: iface.title, baseUrl: iface.baseUrl, entity: entity.title, goal: agent.goal,
        prepare: prepareTools, contracts: project.contracts.map((c) => `${c.id} (${c.title})`),
        data: dataContext(project.roles, Object.values(catalog), process.env, role.id),
      }),
      prompt: `Start exploring. Goal: ${agent.goal}`,
      tools,
      deliver: 'propose',
      script: agent.script ? ws.path(agent.script) : undefined,
      vars: () => ({ key }),
      isDone: () => !!proposal,
      onLog: log,
      signal: opts.signal,
    });
  } finally {
    await browser.close();
    await mcp.close();
  }
  if (!proposal) throw new Error('The agent finished without an accepted proposal (propose was never called or was rejected)');
  return proposal;
}
