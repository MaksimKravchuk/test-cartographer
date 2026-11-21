import type { Page } from '@playwright/test';
import { z } from 'zod';
import { template, type DataValues, type Interface, type Role } from '@tc/model';
import { getPath } from '../mcp.ts';

export type ActionContext = {
  page: Page;
  role: Role;
  iface: Interface;
  variant: string;
  // Value of the entity's correlation key (for example, the order id).
  // Empty while the instance doesn't exist yet (a creating transition).
  key: string;
  // Keys of related instances by relation id (for example, the listing an order is placed for).
  related: Record<string, string>;
  // Arguments for the action: login credentials for a login action.
  args: Record<string, string>;
  // Fields people attached to roles and entities, real values ({{env.NAME}}
  // resolved): data.roles.seller.password, data.entities.order.promo.
  data: DataValues;
  // The last actual entity state that was read.
  entity: Record<string, unknown>;
  // Open a path relative to the baseUrl of the role's interface.
  open(path?: string): Promise<void>;
};

export type ActionDef = {
  description?: string;
  // A creating action (a transition from @new) must return the new instance's key.
  run(ctx: ActionContext): Promise<void | string>;
  // Whether the interface offers this action right now. Needed to check forbidden actions.
  available?(ctx: ActionContext): Promise<boolean>;
};

export type Actions = Record<string, ActionDef>;

export function defineActions<T extends Actions>(actions: T): T {
  return actions;
}

// An action written as steps instead of code: what an agent leaves behind
// (actions/generated/<name>.yaml). The engine runs it; nothing the agent wrote
// is executed as code. Values may use {{key}}, {{variant}}, {{rel.<relation>}},
// {{roles.<id>.<field>}} and {{entities.<id>.<field>}}.
const Target = z
  .object({ testid: z.string(), role: z.string(), name: z.string(), label: z.string(), placeholder: z.string(), text: z.string() })
  .partial()
  .refine((t) => t.testid ?? t.role ?? t.label ?? t.placeholder ?? t.text, 'a target needs testid, role (with name), label, placeholder or text');
type Target = z.infer<typeof Target>;
const ActionStep = z.union([
  z.object({ open: z.string() }).strict(),
  z.object({ click: Target }).strict(),
  z.object({ fill: Target, value: z.string() }).strict(),
  z.object({ select: Target, value: z.string() }).strict(),
  z.object({ press: z.string(), on: Target.optional() }).strict(),
  z.object({ wait: Target }).strict(),
  // An API call with the role's own sign-in; `key` takes the new instance's key from the JSON answer.
  z.object({ request: z.object({ method: z.string().default('POST'), path: z.string(), body: z.unknown().optional() }), key: z.string().optional() }).strict(),
  // The new instance's key from the page URL: the first group of the pattern.
  z.object({ keyFromUrl: z.string() }).strict(),
]);
export const StepsAction = z.object({
  description: z.string().optional(),
  steps: z.array(ActionStep).min(1),
  // Shown only when offered: checked after the leading `open` steps (deny scenarios use it).
  available: Target.optional(),
});
export type StepsAction = z.infer<typeof StepsAction>;

function locate(page: Page, t: Target) {
  if (t.testid) return page.getByTestId(t.testid);
  if (t.role) return page.getByRole(t.role as Parameters<Page['getByRole']>[0], t.name ? { name: t.name, exact: true } : {});
  if (t.label) return page.getByLabel(t.label, { exact: true });
  if (t.placeholder) return page.getByPlaceholder(t.placeholder, { exact: true });
  return page.getByText(t.text!, { exact: true });
}

export function stepsAction(input: unknown): ActionDef {
  const def = StepsAction.parse(input);
  const vars = (ctx: ActionContext) => ({ ...ctx.data, key: ctx.key, variant: ctx.variant, rel: ctx.related });
  const opens = def.steps.filter((s, i) => 'open' in s && def.steps.slice(0, i).every((p) => 'open' in p)) as { open: string }[];
  return {
    description: def.description,
    async run(ctx) {
      const v = vars(ctx);
      let key: string | undefined;
      for (const s of template(def.steps, v)) {
        if ('open' in s) await ctx.open(s.open);
        else if ('click' in s) await locate(ctx.page, s.click).click();
        else if ('fill' in s) await locate(ctx.page, s.fill).fill(s.value);
        else if ('select' in s) await locate(ctx.page, s.select).selectOption(s.value);
        else if ('press' in s) await (s.on ? locate(ctx.page, s.on).press(s.press) : ctx.page.keyboard.press(s.press));
        else if ('wait' in s) await locate(ctx.page, s.wait).first().waitFor();
        else if ('request' in s) {
          const url = new URL(s.request.path, ctx.iface.baseUrl);
          // Steps come from an agent: they may call only the app under test.
          if (url.origin !== new URL(ctx.iface.baseUrl).origin) throw new Error(`request ${s.request.path}: only paths of ${ctx.iface.baseUrl} are allowed`);
          const res = await ctx.page.request.fetch(url.href, { method: s.request.method, data: s.request.body });
          if (!res.ok()) throw new Error(`${s.request.method} ${s.request.path}: ${res.status()} ${(await res.text()).slice(0, 300)}`);
          if (s.key) key = String(getPath(await res.json(), s.key) ?? '');
        } else {
          const m = ctx.page.url().match(new RegExp(s.keyFromUrl));
          if (!m?.[1]) throw new Error(`The page URL ${ctx.page.url()} doesn't match ${s.keyFromUrl}`);
          key = m[1];
        }
      }
      return key;
    },
    ...(def.available && {
      async available(ctx) {
        for (const s of template(opens, vars(ctx))) await ctx.open(s.open);
        await ctx.page.waitForLoadState('domcontentloaded');
        return (await locate(ctx.page, template(def.available!, vars(ctx))).count()) > 0;
      },
    }),
  };
}
