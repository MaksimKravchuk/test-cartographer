// Explorer agent: studies one role's interface, collects evidence
// and packages its findings as a proposal (a patch to the model). It does not
// change the model — a person makes the decision.
// How it works is in skills/ (see skills.ts); the prompt here is only the task.
import { chromium, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import {
  arrange, checkRoles, dataContext, dataValues, Finding, Op, Proposal, redactFields, resolveRuntime, scrubSecrets, secretValues, toYaml, type Evidence, type RuntimeOverride, type Workspace,
} from '@tc/model';
import { McpPool, getPath, mismatches, template } from '../mcp.ts';
import { listOf, runAgent, type Tool } from './runtime.ts';
import { loadActions } from '../actions-loader.ts';
import { execute } from '../runtime/index.ts';
import { StepsAction, stepsAction, type ActionDef } from '../runtime/actions.ts';
import { skillsPrompt, skillTool } from './skills.ts';
import { browserTools } from './browser.ts';

export type ExploreOptions = {
  onLog?: (line: string) => void;
  provider?: 'scripted' | 'live';
  // This run only, on top of the agent's own runtime (Ask agent's run settings).
  runtime?: RuntimeOverride;
  headed?: boolean;
  signal?: AbortSignal;
};

// A real back-office page with refs runs to 10–15k characters.
const Result = z.object({ rationale: z.string(), ops: listOf(Op).default([]), findings: listOf(Finding).default([]) });
const MAX_TEXT = 20_000;
const clip = (s: string) => (s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + '\n…(truncated)' : s);

const SKILLS = [
  'planning-investigation',
  'exploring-app',
  'asking-questions',
  'writing-actions',
  'proposing-model-changes',
  'proposing-model-changes/references/entity-elements.md',
];

// roleTitle is how the prose names the role; roleId is what the model's `by` references.
const system = (p: {
  roleTitle: string; roleId: string; iface: string; baseUrl: string; entity: string; goal: string; prepare: string[]; contracts: string[]; data: string; skills: string;
}) => `You are an exploration agent of Test Cartographer, where people and agents rebuild a product's specification
and derive tests from it. You are exploring a web application as the role “${p.roleTitle}” (id \`${p.roleId}\`)
through the interface “${p.iface}” (${p.baseUrl}).
Goal: ${p.goal}

Your task is to reconstruct the behavior of the entity “${p.entity}” — its variants, states, actions and
transitions — and propose changes to its model. Nothing you propose changes the model directly: a person
reviews every operation and finding and decides. In \`by\`, your role is \`${p.roleId}\`.

Setup tools for prepare(): ${p.prepare.join(', ') || 'none'}.
${p.contracts.length ? `Available contracts: ${p.contracts.join(', ')}.` : ''}
${p.data ? `
Data a person attached to subjects (roles) and objects (entities) — logins, test values, notes. Use it where an
action needs it.
${p.data}
` : ''}
${p.skills}`;

export async function explore(ws: Workspace, agentId: string, opts: ExploreOptions = {}): Promise<Proposal> {
  const log = opts.onLog ?? (() => {});
  const project = await ws.project();
  const agent = project.agents.find((a) => a.id === agentId);
  if (!agent) throw new Error(`Agent “${agentId}” is not defined in cartographer.yaml`);
  if (!agent.role || !agent.entity) throw new Error(`Explore agent “${agentId}” needs both a role and an entity (add them in cartographer.yaml)`);
  const role = project.roles.find((r) => r.id === agent.role)!;
  const iface = project.interfaces.find((i) => i.id === role.interface)!;
  const { entity } = await ws.entity(agent.entity);
  const catalog = await ws.catalog();
  // Fields of every role and entity: real values for the engine (sign-in,
  // fill), references in place of secrets for anything the model reads.
  const env = ws.env();
  const data = dataValues(project.roles, Object.values(catalog), env);
  const secrets = secretValues(project.roles, Object.values(catalog), env);
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

  const runtime = opts.provider === 'scripted' ? 'scripted' : resolveRuntime({ runtime: resolveRuntime(project, agent) }, { runtime: opts.runtime }) ?? 'scripted';

  const proposalId = `${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}-${agent.id}`;
  const runTag = `explore-${proposalId}`;
  const evidenceDir = `evidence/${proposalId}`;
  await mkdir(ws.path(evidenceDir), { recursive: true });

  const mcp = new McpPool(project, ws.root);
  const chrome = await chromium.launch({ headless: !opts.headed });
  const page: Page = await (await chrome.newContext()).newPage();
  const base = iface.baseUrl.replace(/\/$/, '');

  // The agent explores as a signed-in user when its role has a login. An app
  // may sign the user out mid-run (a forbidden call, an expired session), so the
  // agent can ask for it again with login().
  const actions = await loadActions(ws);
  const login = role.login ? actions[role.login.action] : undefined;
  if (role.login && !login) throw new Error(`Login action “${role.login.action}” is not in the actions/ library`);
  const signIn = async () => {
    if (!role.login || !login) return;
    log(`🔑 signing in as ${role.title}`);
    await login.run({
      page, role, iface, variant: '', key: '', entity: {}, related: {}, data,
      args: template(role.login.args, { env: env, ...data }),
      open: async (path = '') => {
        await page.goto(base + path);
      },
    });
  };
  await signIn();

  const evidence: Evidence[] = [];
  const addEvidence = (e: Omit<Evidence, 'id'>) => {
    const id = `e${evidence.length + 1}`;
    evidence.push({ id, ...e });
    return id;
  };
  let key: string | undefined;
  let relatedKeys: Record<string, string> = {};
  let proposal: Proposal | undefined;
  let last: Proposal | undefined;
  let batches = 0;
  // Validates and writes a proposal straight away, so the Inbox shows it
  // while the agent works on. `batch` numbers a record() call.
  const save = async ({ rationale, ops, findings }: { rationale: string; ops: unknown[]; findings: unknown[] }, batch?: number) => {
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
    const p = Proposal.parse({
      id: batch ? `${proposalId}-${batch}` : proposalId,
      entity: entity.id,
      agent: agent.id,
      role: role.id,
      createdAt: new Date().toISOString(),
      // Read now: a batch recorded earlier may have been accepted since.
      baseRevision: (await ws.entity(entity.id)).revision,
      rationale,
      evidence,
      ops: parsedOps.data,
      findings: parsedFindings.data,
    });
    await ws.saveProposal(p);
    return (last = p);
  };

  const browser = await browserTools(page, {
    base: iface.baseUrl,
    fill: (text) => template(text, data),
    onSnapshot: async (text, note) => {
      const n = evidence.length + 1;
      const testIds = await page.$$eval('[data-testid]', (els) => els.map((e) => `${e.getAttribute('data-testid')}: ${(e.textContent ?? '').trim().slice(0, 60)}`));
      await page.screenshot({ path: ws.path(`${evidenceDir}/e${n}.png`), fullPage: true });
      await writeFile(ws.path(`${evidenceDir}/e${n}.aria.yaml`), scrub(text));
      const id = addEvidence({ kind: 'screenshot', summary: note ?? `snapshot ${page.url()}`, path: `${evidenceDir}/e${n}.png`, url: page.url() });
      return clip(`evidence ${id}\ntest ids:\n${testIds.map((t) => `  ${t}`).join('\n')}\n\n${text}`);
    },
    onNetwork: async (text) => {
      const file = `${evidenceDir}/e${evidence.length + 1}.network.md`;
      await writeFile(ws.path(file), scrub(text));
      const id = addEvidence({ kind: 'network', summary: `requests on ${page.url()}`, path: file, url: page.url() });
      return clip(`evidence ${id}\n${text}`);
    },
  });

  // Runs the model's own setup for a state, with no model call: see reach().
  const reachState = async (state: string, variant: string) => {
        const plan = arrange(entity, variant, state, new Set(), { catalog, project });
        if (!plan) throw new Error(`The model has no way to reach “${state}” (${variant}): no setup tool for it and no confirmed path from one. Get there through the UI, or note it as a gap.`);
        const done: string[] = [];
        const readers = Object.fromEntries(Object.values(catalog).map((e) => [e.id, e.reader]));
        const relations = Object.fromEntries(entity.relations.map((r) => [r.id, { entity: r.entity, field: r.field }]));
        const inst = await execute({ entity: { id: entity.id, key: entity.key, reader }, readers, relations }, plan.steps, variant, actions, { root: ws.root, project, mcp, data, env }, chrome, {
          step: async (title, fn) => {
            log(`⚙️ ${title}`);
            done.push(title);
            await fn();
          },
          annotate: () => {},
          attach: async () => {},
        });
        if (inst.key) key = inst.key;
        relatedKeys = inst.related;
    return { inst, done };
  };
  // An action as code the agent wrote, run live as the agent's role.
  const runAction = (a: ActionDef, variant: string, k: string) =>
    a.run({
      page, role, iface, variant, key: k, entity: {}, related: relatedKeys, data, args: {},
      open: async (path = '') => {
        await page.goto(base + path);
      },
    });

  const variants = entity.variants.filter((v) => v.status === 'confirmed').map((v) => v.id);
  const prepareTools = Object.entries(project.mcp).flatMap(([s, cfg]) => cfg.allow.prepare.map((t) => `${s}.${t}`));
  const triggerTools = Object.entries(project.mcp).flatMap(([s, cfg]) => cfg.allow.trigger.map((t) => `${s}.${t}`));

  const tools: Tool[] = [
    {
      name: 'model',
      description: 'The current entity model (YAML), the project roles, and the entities it is related to (in brief).',
      input: z.object({}),
      run: async () =>
        toYaml({
          roles: redactFields('roles', project.roles, env),
          glossary: project.glossary,
          entity: redactFields('entities', [entity], env)[0],
          related: redactFields('entities', [...related].flatMap((id) => (catalog[id] ? [catalog[id]] : [])), env).map((e) => ({
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
        const result = await mcp.call(tool, { ...template(args, data), tag: runTag }, 'prepare');
        const k = getPath(result, entity.key);
        if (k !== undefined) key = String(k);
        relatedKeys = {};
        return scrub(JSON.stringify(result, null, 2));
      },
    },
    ...(triggerTools.length
      ? [{
          name: 'trigger',
          description: 'Make the system act now through an allowed tool: run a background job, advance a test clock. Returns the result (JSON).',
          input: z.object({ tool: z.string().describe(`One of: ${triggerTools.join(', ')}`), args: z.record(z.string(), z.unknown()).default({}) }),
          run: async ({ tool, args }: { tool: string; args: Record<string, unknown> }) =>
            scrub(JSON.stringify(await mcp.call(tool, template(args, data), 'trigger'), null, 2)),
        }]
      : []),
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
      name: 'reach',
      description:
        `Put a new ${entity.title} instance into a state the model already knows how to reach — the engine runs the setup ` +
        'tools and library actions itself (each role in its own browser), with no clicking on your part. Returns the key, ' +
        'remembered for read(). Prefer it to clicking through a path that is already in the model.',
      input: z.object({
        state: z.string().describe(`One of: ${entity.states.filter((x) => x.status === 'confirmed').map((x) => x.id).join(', ')}`),
        variant: z.string().optional().describe(`One of: ${variants.join(', ')}; defaults to ${variants[0] ?? 'none'}`),
      }),
      run: async ({ state, variant = variants[0] ?? '' }) => {
        const { inst, done } = await reachState(state, variant);
        return JSON.stringify({ key: inst.key, related: inst.related, state, variant, steps: done }, null, 2);
      },
    },
    {
      name: 'act',
      description:
        `Run an action from the project's action library as your role, in your browser: code that already knows the clicks. ` +
        'Returns what it returned (a new key for a creating action) and the page URL. Snapshot afterwards to see the result.',
      input: z.object({
        action: z.string().describe(`One of: ${Object.entries(actions).map(([n, a]) => (a.description ? `${n} (${a.description})` : n)).join('; ') || 'none yet'}`),
        key: z.string().optional().describe('Instance key; defaults to the most recently prepared one'),
        variant: z.string().optional(),
      }),
      run: async ({ action, key: k, variant = variants[0] ?? '' }) => {
        const a = actions[action];
        if (!a) throw new Error(`No action “${action}” in the library`);
        const result = await runAction(a, variant, k ?? key ?? '');
        if (typeof result === 'string' && result) key = result;
        return JSON.stringify({ result: result ?? null, url: page.url() });
      },
    },
    {
      name: 'write_action',
      description:
        'Turn a verb you have done through the UI into steps for the action library, so tests and later runs repeat it with no model. ' +
        'The engine checks it live: it reaches `from` (or starts from nothing for @new), runs the steps as your role, reads the ' +
        'instance and compares it with `expect`. Returns an `action` evidence id to cite on the action op that sets `run: <name>`.',
      input: z.object({
        name: z.string().regex(/^[a-z0-9][\w.-]*$/).describe('Library name, like order.pay'),
        from: z.string().describe('State the action starts in, or @new for one that creates the instance'),
        variant: z.string().optional(),
        expect: z.record(z.string(), z.unknown()).describe('Fields the read must show after the action, like { status: paid }'),
        action: StepsAction,
      }),
      run: async ({ name, from, variant = variants[0] ?? '', expect, action }) => {
        if (!Object.keys(expect).length) throw new Error('`expect` needs at least one field to check');
        if (actions[name]) throw new Error(`The library already has “${name}”: use act() for it, or pick another name`);
        const a = stepsAction(action);
        const file = `${evidenceDir}/${name}.action.yaml`;
        await writeFile(ws.path(file), toYaml(action));
        let k = '';
        if (from !== '@new') k = (await reachState(from, variant)).inst.key ?? '';
        const result = await runAction(a, variant, k);
        if (from === '@new') {
          if (typeof result !== 'string' || !result) throw new Error('A creating action must return the new instance key');
          k = result;
        }
        key = k;
        const after = (await mcp.call(reader.tool, template(reader.args, { key: k }), 'read')) as Record<string, unknown>;
        const wrong = mismatches(after, expect);
        if (wrong.length) throw new Error(`Ran, but the instance doesn't match: ${JSON.stringify(wrong)}. Read: ${JSON.stringify(after)}`);
        const id = addEvidence({ kind: 'action', summary: `action ${name}: checked live, ${from} → ${JSON.stringify(expect)}`, path: file });
        return `evidence ${id}: ${name} works. Cite it on the action op with run: ${name}.`;
      },
    },
    ...browser.tools,
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
      name: 'record',
      description:
        'Save part of the result now, in the same shape as propose(): a person starts reviewing it while you go on. ' +
        'Call it after each part of the behavior you have worked out; never repeat what you already recorded.',
      input: Result,
      run: async (input) => `proposal ${(await save(input, ++batches)).id} saved — go on, and call propose() at the end`,
    },
    {
      name: 'propose',
      description: 'Finish the exploration: submit the rest of the proposed model changes (what record() has not saved yet).',
      input: Result,
      run: async (input) => {
        // The closing rationale says what the run covered; with everything recorded already it is saved nowhere else.
        log(`💬 ${input.rationale}`);
        // Everything may already be recorded; then propose only closes the run.
        if (batches && !input.ops.length && !input.findings.length) proposal = last;
        else proposal = await save(input);
        return `proposal ${proposal!.id} saved`;
      },
    },
  ];

  tools.push(skillTool(SKILLS.filter((s) => !s.includes('/'))));

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
        data: dataContext(project.roles, Object.values(catalog), env, role.id),
        skills: skillsPrompt(SKILLS, tools.map((t) => t.name)),
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
    await chrome.close();
    await mcp.close();
  }
  if (!proposal) throw new Error('The agent finished without an accepted proposal (propose was never called or was rejected)');
  return proposal;
}
