// Runtime for generated tests. A generated spec file contains only
// scenario data; all execution happens here, in one place.
import { test as base, expect, type Browser, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import { NEW, Workspace, type Project, type Scenario, type Step, type ToolCall } from '@tc/model';
import { McpPool, mismatches, template, getPath } from '../mcp.ts';
import type { ActionContext, Actions } from './actions.ts';

export { defineActions, type ActionContext, type ActionDef, type Actions } from './actions.ts';

export type Suite = {
  title: string;
  source: string;
  revision: string;
  entity: { id: string; key: string; reader: ToolCall };
  // How to read every entity of the project (related instances use their own reader),
  // and where this entity keeps the key of each related instance.
  readers: Record<string, ToolCall>;
  relations: Record<string, { entity: string; field: string }>;
  scenarios: Scenario[];
};

type Worker = { root: string; project: Project; mcp: McpPool };

export const test = base.extend<object, { tcWorkspace: string; tc: Worker }>({
  tcWorkspace: [process.env.TC_WORKSPACE ?? '.', { option: true, scope: 'worker' }],
  tc: [
    async ({ tcWorkspace }, use) => {
      const ws = new Workspace(tcWorkspace);
      const project = await ws.project();
      const mcp = new McpPool(project, ws.root);
      await use({ root: ws.root, project, mcp });
      await mcp.close();
    },
    { scope: 'worker' },
  ],
});

const phaseTitle = { arrange: 'Arrange', act: 'Act', assert: 'Assert' } as const;

function stepTitle(s: Step): string {
  switch (s.do) {
    case 'prepare': return `${s.tool} → ${s.state}`;
    case 'transition': return `${s.role}: ${s.title} (${s.from} → ${s.to})`;
    case 'expectState': return `state ${s.state}`;
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
type Instance = {
  entity: string;
  variant: string;
  reader: ToolCall;
  relations: Record<string, { entity: string; field: string }>;
  key?: string;
  snapshot: Record<string, unknown>;
  related: Record<string, string>;
  // Related values read right before the last act, for “changes by” checks.
  baseline: Record<string, Record<string, unknown>>;
};

export async function runScenario(suite: Suite, sc: Scenario, actions: Actions, tc: Worker, browser: Browser, info: TestInfo) {
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
  const contextFor = async (roleId: string, inst: Instance): Promise<ActionContext> => {
    const role = tc.project.roles.find((r) => r.id === roleId);
    if (!role) throw new Error(`Unknown role “${roleId}”`);
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
      page, role, iface, variant: inst.variant, key: inst.key ?? '', entity: inst.snapshot, related: { ...inst.related }, args: {},
      open: async (path = '') => {
        await page.goto(iface.baseUrl.replace(/\/$/, '') + path);
      },
    };
    // A role with a login signs in once per browser context, before it acts.
    if (fresh && role.login) {
      const args = template(role.login.args, { env: process.env, variant: inst.variant, runTag });
      await test.step(`Sign in: ${role.title}`, () => action(role.login!.action).run({ ...ctx, args }).then(() => undefined));
    }
    return ctx;
  };

  const runSteps = async (steps: (Step & { phase?: keyof typeof phaseTitle })[], inst: Instance, prefix = ''): Promise<void> => {
    for (const step of steps) {
      const title = `${prefix}${step.phase ? `${phaseTitle[step.phase]}: ` : ''}${stepTitle(step)}`;
      await test.step(title, async () => {
        switch (step.do) {
          case 'related': {
            const child: Instance = {
              entity: step.entity, variant: step.variant, reader: suite.readers[step.entity], relations: {},
              snapshot: {}, related: {}, baseline: {},
            };
            await runSteps(step.steps, child, `${step.entity} › `);
            if (!child.key) throw new Error(`Preparing the related ${step.entity} produced no key`);
            inst.related[step.relation] = child.key;
            info.annotations.push({ type: `tc-related:${step.relation}`, description: child.key });
            break;
          }
          case 'prepare': {
            const args = template(step.args, { variant: inst.variant, runTag, rel: inst.related });
            const result = await tc.mcp.call(step.tool, args, 'prepare');
            const value = getPath(result, step.key);
            if (typeof value !== 'string' && typeof value !== 'number')
              throw new Error(`${step.tool} did not return a key in field “${step.key}”`);
            inst.key = String(value);
            if (inst === main) info.annotations.push({ type: 'tc-key', description: inst.key });
            break;
          }
          case 'expectState':
          case 'expectField': {
            const match = step.do === 'expectState' ? step.match : { [step.field]: step.equals };
            await expect
              .poll(async () => mismatches(await read(inst), match), { message: stepTitle(step), timeout: 5_000 })
              .toEqual([]);
            await info.attach(`state:${inst.entity}:${step.do === 'expectState' ? step.state : step.field}`, {
              body: JSON.stringify(inst.snapshot, null, 2),
              contentType: 'application/json',
            });
            break;
          }
          case 'transition': {
            // Remember related values before the act, so effects can be checked as changes.
            for (const [relation, rel] of Object.entries(inst.relations)) {
              const key = inst.related[relation] ?? (inst.key ? (getPath(inst.snapshot, rel.field) as string | undefined) : undefined);
              if (key) inst.baseline[relation] = await readEntity(rel.entity, String(key), inst.variant);
            }
            const created = await action(step.action).run(await contextFor(step.role, inst));
            if (step.from === NEW) {
              if (typeof created !== 'string' || !created)
                throw new Error(`Action “${step.action}” creates the instance but didn't return its key`);
              inst.key = created;
              if (inst === main) info.annotations.push({ type: 'tc-key', description: inst.key });
            }
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
            await info.attach(`state:${rel.entity}:${step.field}`, { body: JSON.stringify(snapshot, null, 2), contentType: 'application/json' });
            break;
          }
          case 'expectUnavailable': {
            const a = action(step.action);
            if (!a.available) throw new Error(`Action “${step.action}” has no available(): the forbidden action can't be checked`);
            const ctx = await contextFor(step.role, inst);
            expect(await a.available(ctx), `${step.role} sees action ${step.action}`).toBe(false);
            break;
          }
          case 'manual':
            info.annotations.push({ type: 'manual-check', description: step.description });
            break;
        }
      });
    }
  };

  const main: Instance = {
    entity: suite.entity.id, variant: sc.variant, reader: suite.entity.reader, relations: suite.relations,
    snapshot: {}, related: {}, baseline: {},
  };
  try {
    await runSteps(sc.steps, main);
  } finally {
    await Promise.all([...pages.values()].map((p) => p.context.close()));
  }
}

export function defineSuite(suite: Suite, actions: Actions) {
  test.describe(suite.title, () => {
    for (const sc of suite.scenarios) {
      const details = {
        tag: [`@${sc.kind}`, `@variant:${sc.variant}`, `@role:${sc.role || 'none'}`, `@id:${sc.id}`],
        annotation: [
          { type: 'tc-scenario', description: sc.id },
          { type: 'tc-source', description: `${suite.source}@${suite.revision}` },
        ],
      };
      test(`${sc.title} [${sc.variant}]`, details, async ({ tc, browser }, info) => {
        test.fixme(!!sc.blocked, sc.blocked ?? '');
        await runScenario(suite, sc, actions, tc, browser, info);
      });
    }
  });
}
