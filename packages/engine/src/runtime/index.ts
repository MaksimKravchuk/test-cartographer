// Runtime for generated tests. A generated spec file contains only
// scenario data; all execution happens here, in one place.
import { test as base, expect, type Browser, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import { NEW, Workspace, dataValues, type DataValues, type Project, type Scenario, type Step, type ToolCall } from '@tc/model';
import { McpPool, mismatches, template, getPath } from '../mcp.ts';
import type { ActionContext, Actions } from './actions.ts';

export { defineActions, type ActionContext, type ActionDef, type Actions } from './actions.ts';

export type Suite = {
  title: string;
  source: string;
  revision: string;
  // reader is optional: an onboarding agent may propose an entity before anyone
  // knows how to read it back — its scenarios plan as blocked (see plan.ts).
  entity: { id: string; key: string; reader?: ToolCall };
  // How to read every entity of the project (related instances use their own reader),
  // and where this entity keeps the key of each related instance.
  readers: Record<string, ToolCall | undefined>;
  relations: Record<string, { entity: string; field: string }>;
  // Story id → tracker key (or the id itself, if it has none) — for @story: tags.
  storyKeys: Record<string, string>;
  scenarios: (Scenario & { trace: { epics: string[]; features: string[]; stories: string[] } })[];
};

export type Worker = { root: string; project: Project; mcp: McpPool; data: DataValues };

export const test = base.extend<object, { tcWorkspace: string; tc: Worker }>({
  tcWorkspace: [process.env.TC_WORKSPACE ?? '.', { option: true, scope: 'worker' }],
  tc: [
    async ({ tcWorkspace }, use) => {
      const ws = new Workspace(tcWorkspace);
      const project = await ws.project();
      const mcp = new McpPool(project, ws.root);
      const data = dataValues(project.roles, Object.values(await ws.catalog()), process.env);
      await use({ root: ws.root, project, mcp, data });
      await mcp.close();
    },
    { scope: 'worker' },
  ],
});

const phaseTitle = { arrange: 'Arrange', act: 'Act', assert: 'Assert' } as const;

// A step's actor label: the role's own id, or “system” for one that acts
// through invoke (no browser, no role identity worth naming in the title).
const actor = (s: { role: string; invoke?: unknown }) => (s.invoke ? 'system' : s.role);

function stepTitle(s: Step): string {
  switch (s.do) {
    case 'prepare': return `${s.tool} → ${s.state}`;
    case 'transition': return `${actor(s)}: ${s.title} (${s.from} → ${s.to})`;
    case 'perform': return `${actor(s)}: ${s.title} (${s.state})`;
    case 'expectState': return `state ${s.state}`;
    case 'expectInvariant': return `invariant ${s.title}`;
    case 'expectField': return `${s.field} = ${JSON.stringify(s.equals)}`;
    case 'expectUnavailable': return `${s.role} cannot ${s.action} in ${s.state}`;
    case 'manual': return `manual: ${s.description}`;
    case 'related': return `related ${s.entity} (${s.variant}) in ${s.state}`;
    case 'expectRelated':
      return `${s.relation}.${s.field} ${s.delta !== undefined ? `changes by ${s.delta}` : `= ${JSON.stringify(s.equals)}`}`;
  }
}

// One entity instance a scenario works with: the main one, or a related one
// prepared for it. Each has its own key, reader and related instances.
export type Instance = {
  entity: string;
  variant: string;
  reader?: ToolCall;
  relations: Record<string, { entity: string; field: string }>;
  key?: string;
  snapshot: Record<string, unknown>;
  related: Record<string, string>;
  // Related values read right before the last act, for “changes by” checks.
  baseline: Record<string, Record<string, unknown>>;
};

// How a run reports its steps: to Playwright Test (runScenario) or, for an
// agent that has the engine set up state for it, to the run's log.
export type Hooks = {
  step(title: string, fn: () => Promise<void>): Promise<void>;
  annotate(type: string, description: string): void;
  attach(name: string, json: unknown): Promise<void>;
};

export async function runScenario(suite: Suite, sc: Scenario, actions: Actions, tc: Worker, browser: Browser, info: TestInfo) {
  await execute(suite, sc.steps, sc.variant, actions, tc, browser, {
    step: (title, fn) => test.step(title, fn),
    annotate: (type, description) => void info.annotations.push({ type, description }),
    attach: (name, json) => info.attach(name, { body: JSON.stringify(json, null, 2), contentType: 'application/json' }),
  });
}

// Runs planned steps with no model involved: prepare tools, library actions in
// each role's own browser context, state checks. Returns the main instance.
export async function execute(
  suite: Pick<Suite, 'entity' | 'readers' | 'relations'>, steps: Step[], variant: string, actions: Actions, tc: Worker, browser: Browser, hooks: Hooks,
): Promise<Instance> {
  const runTag = process.env.TC_RUN_ID ?? 'local';
  const pages = new Map<string, { context: BrowserContext; page: Page }>();

  const readEntity = async (entity: string, key: string, variant: string) => {
    const reader = suite.readers[entity];
    if (!reader) throw new Error(`No reader for entity “${entity}”`);
    return (await tc.mcp.call(reader.tool, template(reader.args, { key, variant, runTag }), 'read')) as Record<string, unknown>;
  };

  const read = async (inst: Instance) => {
    if (!inst.key) throw new Error(`The ${inst.entity} instance has not been prepared yet`);
    inst.snapshot = await readEntity(inst.entity, inst.key, inst.variant);
    return inst.snapshot;
  };

  // The key of a related instance: prepared for this scenario, or read from the reference field.
  const relatedKey = async (inst: Instance, relation: string) => {
    if (inst.related[relation]) return inst.related[relation];
    const rel = inst.relations[relation];
    if (!rel) throw new Error(`Unknown relation “${relation}”`);
    const value = getPath(await read(inst), rel.field);
    if (typeof value !== 'string' && typeof value !== 'number') throw new Error(`${inst.entity} has no related ${relation} in field “${rel.field}”`);
    return (inst.related[relation] = String(value));
  };

  const action = (name: string) => {
    const a = actions[name];
    if (!a) throw new Error(`Action “${name}” was not found in the actions/ library`);
    return a;
  };

  // Each role has its own browser context: sessions and cookies don't overlap.
  // Only a human role has an interface — a system role acts through invoke,
  // never through the browser, so a step that asks for its context is a bug.
  const contextFor = async (roleId: string, inst: Instance): Promise<ActionContext> => {
    const role = tc.project.roles.find((r) => r.id === roleId);
    if (!role) throw new Error(`Unknown role “${roleId}”`);
    if (role.kind !== 'human' || !role.interface) throw new Error(`Role “${roleId}” has no interface: it can't act through the browser`);
    const iface = tc.project.interfaces.find((i) => i.id === role.interface)!;
    let entry = pages.get(roleId);
    const fresh = !entry;
    if (!entry) {
      const context = await browser.newContext();
      entry = { context, page: await context.newPage() };
      pages.set(roleId, entry);
    }
    const page = entry.page;
    const ctx: ActionContext = {
      page, role, iface, variant: inst.variant, key: inst.key ?? '', entity: inst.snapshot, related: { ...inst.related }, args: {}, data: tc.data,
      open: async (path = '') => {
        await page.goto(iface.baseUrl.replace(/\/$/, '') + path);
      },
    };
    // A role with a login signs in once per browser context, before it acts.
    if (fresh && role.login) {
      const args = template(role.login.args, { env: process.env, variant: inst.variant, runTag, ...tc.data });
      await hooks.step(`Sign in: ${role.title}`, () => action(role.login!.action).run({ ...ctx, args }).then(() => undefined));
    }
    return ctx;
  };

  // Related values right before the act, so `expectRelated` can check a change
  // relative to them. Shared by transitions and permits — both are “acts”.
  const rememberBaseline = async (inst: Instance) => {
    for (const [relation, rel] of Object.entries(inst.relations)) {
      const key = inst.related[relation] ?? (inst.key ? (getPath(inst.snapshot, rel.field) as string | undefined) : undefined);
      if (key) inst.baseline[relation] = await readEntity(rel.entity, String(key), inst.variant);
    }
  };

  // Performs a transition's or permit's act: `invoke` calls the MCP trigger
  // tool (a system role); otherwise `run` calls the action library in the
  // role's browser context (a human role). Returns whatever came back — only
  // a creating transition's `run` result is used, by the 'transition' case.
  const performAct = async (step: { role: string; run?: string; invoke?: ToolCall }, inst: Instance): Promise<void | string | unknown> => {
    if (step.invoke) return tc.mcp.call(step.invoke.tool, template(step.invoke.args, { ...tc.data, key: inst.key, variant: inst.variant, runTag, rel: inst.related }), 'trigger');
    if (!step.run) throw new Error(`Role “${step.role}” has no run or invoke binding for this act`);
    return action(step.run).run(await contextFor(step.role, inst));
  };

  const runSteps = async (steps: (Step & { phase?: keyof typeof phaseTitle })[], inst: Instance, prefix = ''): Promise<void> => {
    for (const step of steps) {
      const title = `${prefix}${step.phase ? `${phaseTitle[step.phase]}: ` : ''}${stepTitle(step)}`;
      await hooks.step(title, async () => {
        switch (step.do) {
          case 'related': {
            const child: Instance = {
              entity: step.entity, variant: step.variant, reader: suite.readers[step.entity], relations: {},
              snapshot: {}, related: {}, baseline: {},
            };
            await runSteps(step.steps, child, `${step.entity} › `);
            if (!child.key) throw new Error(`Preparing the related ${step.entity} produced no key`);
            inst.related[step.relation] = child.key;
            hooks.annotate(`tc-related:${step.relation}`, child.key);
            break;
          }
          case 'prepare': {
            const args = template(step.args, { ...tc.data, variant: inst.variant, runTag, rel: inst.related });
            const result = await tc.mcp.call(step.tool, args, 'prepare');
            const value = getPath(result, step.key);
            if (typeof value !== 'string' && typeof value !== 'number')
              throw new Error(`${step.tool} did not return a key in field “${step.key}”`);
            inst.key = String(value);
            if (inst === main) hooks.annotate('tc-key', inst.key);
            break;
          }
          case 'expectState':
          case 'expectInvariant':
          case 'expectField': {
            const match = step.do === 'expectField' ? { [step.field]: step.equals } : step.match;
            await expect
              .poll(async () => mismatches(await read(inst), match), { message: stepTitle(step), timeout: 5_000 })
              .toEqual([]);
            await hooks.attach(`state:${inst.entity}:${step.do === 'expectField' ? step.field : step.do === 'expectInvariant' ? step.invariant : step.state}`, inst.snapshot);
            break;
          }
          case 'transition': {
            await rememberBaseline(inst);
            const created = await performAct(step, inst);
            if (step.from === NEW) {
              if (typeof created !== 'string' || !created)
                throw new Error(`Action “${step.action}” creates the instance but didn't return its key`);
              inst.key = created;
              if (inst === main) hooks.annotate('tc-key', inst.key);
            }
            break;
          }
          case 'perform': {
            // A permit never changes the instance's state or key — only its effects (if any) are checked after it.
            await rememberBaseline(inst);
            await performAct(step, inst);
            break;
          }
          case 'expectRelated': {
            const rel = inst.relations[step.relation];
            if (!rel) throw new Error(`Unknown relation “${step.relation}”`);
            const key = await relatedKey(inst, step.relation);
            const before = getPath(inst.baseline[step.relation], step.field);
            const expected = step.delta !== undefined ? Number(before) + step.delta : step.equals;
            if (step.delta !== undefined && typeof before !== 'number')
              throw new Error(`Can't check a change of ${step.relation}.${step.field}: its value before the act was ${JSON.stringify(before)}`);
            let snapshot: Record<string, unknown> = {};
            await expect
              .poll(async () => {
                snapshot = await readEntity(rel.entity, key, inst.variant);
                return getPath(snapshot, step.field);
              }, { message: `${step.description} (${step.relation}.${step.field})`, timeout: 5_000 })
              .toEqual(expected);
            await hooks.attach(`state:${rel.entity}:${step.field}`, snapshot);
            break;
          }
          case 'expectUnavailable': {
            const a = action(step.run);
            if (!a.available) throw new Error(`Action “${step.run}” has no available(): the denied action can't be checked`);
            const ctx = await contextFor(step.role, inst);
            expect(await a.available(ctx), `${step.role} sees action ${step.action}`).toBe(false);
            break;
          }
          case 'manual':
            hooks.annotate('manual-check', step.description);
            break;
        }
      });
    }
  };

  const main: Instance = {
    entity: suite.entity.id, variant, reader: suite.entity.reader, relations: suite.relations,
    snapshot: {}, related: {}, baseline: {},
  };
  try {
    await runSteps(steps, main);
    return main;
  } finally {
    await Promise.all([...pages.values()].map((p) => p.context.close()));
  }
}

export function defineSuite(suite: Suite, actions: Actions) {
  test.describe(suite.title, () => {
    for (const sc of suite.scenarios) {
      const details = {
        tag: [
          `@${sc.kind}`, `@variant:${sc.variant}`, `@role:${sc.role || 'none'}`, `@id:${sc.id}`,
          ...sc.rules.map((r) => `@rule:${r}`),
          ...sc.trace.epics.map((id) => `@epic:${id}`),
          ...sc.trace.features.map((id) => `@feature:${id}`),
          ...sc.trace.stories.map((id) => `@story:${suite.storyKeys[id] ?? id}`),
        ],
        annotation: [
          { type: 'tc-scenario', description: sc.id },
          { type: 'tc-source', description: `${suite.source}@${suite.revision}` },
          ...sc.trace.epics.map((id) => ({ type: 'epic', description: id })),
          ...sc.trace.features.map((id) => ({ type: 'feature', description: id })),
          ...sc.trace.stories.map((id) => ({ type: 'story', description: suite.storyKeys[id] ?? id })),
        ],
      };
      test(`${sc.title} [${sc.variant}]`, details, async ({ tc, browser }, info) => {
        test.fixme(!!sc.blocked, sc.blocked ?? '');
        await runScenario(suite, sc, actions, tc, browser, info);
      });
    }
  });
}
