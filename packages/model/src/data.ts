// Fields people attach to subjects (roles) and objects (entities): the real
// values the engine works with, and what an agent is shown of them. A secret's
// value never reaches a model — the agent sees its {{…}} reference and hands it
// back, and the engine substitutes the value where it's used.
import { template } from './reach.ts';
import type { Entity, Field, Role } from './schema.ts';

export type FieldOwner = 'roles' | 'entities';
type Env = Record<string, string | undefined>;
type Owned = { id: string; title: string; fields: Field[] };

// {{roles.seller.password}} — the same placeholder the templates resolve.
export const fieldRef = (owner: FieldOwner, id: string, field: string) => `{{${owner}.${id}.${field}}}`;

// Template vars with every field's real value, {{env.NAME}} resolved:
// {{roles.<id>.<field>}} and {{entities.<id>.<field>}}.
export type DataValues = { roles: Record<string, Record<string, string>>; entities: Record<string, Record<string, string>> };

const resolved = (f: Field, env: Env) => String(template(f.value, { env }));

export function dataValues(roles: Role[], entities: Entity[], env: Env = {}): DataValues {
  const values = (list: Owned[]) =>
    Object.fromEntries(list.filter((o) => o.fields.length).map((o) => [o.id, Object.fromEntries(o.fields.map((f) => [f.id, resolved(f, env)]))]));
  return { roles: values(roles), entities: values(entities) };
}

// The value an agent is shown: a plain one as is, a secret as its reference.
export const agentValue = (owner: FieldOwner, id: string, f: Field, env: Env = {}) => (f.secret ? fieldRef(owner, id, f.id) : resolved(f, env));

// Roles or entities with every secret replaced by its reference — for tools
// that hand the model raw model data (model(), the catalog).
export function redactFields<T extends Owned>(owner: FieldOwner, list: T[], env: Env = {}): T[] {
  return list.map((o) => (o.fields.length ? { ...o, fields: o.fields.map((f) => ({ ...f, value: agentValue(owner, o.id, f, env) })) } : o));
}

// A system-prompt block listing every subject's and object's fields; empty
// when nobody has attached any. `you` marks the role the agent acts as.
export function dataContext(roles: Role[], entities: Entity[], env: Env = {}, you?: string): string {
  const block = (owner: FieldOwner, kind: string, o: Owned) =>
    [
      `- ${o.title} (${kind} ${o.id}${o.id === you && owner === 'roles' ? ', the role you act as' : ''}):`,
      ...o.fields.map(
        (f) => `  - ${f.id}: ${agentValue(owner, o.id, f, env)}${f.secret ? ' — secret' : ''}${f.note ? ` — ${f.note}` : ''}`,
      ),
    ].join('\n');
  return [
    ...roles.filter((r) => r.fields.length).map((r) => block('roles', 'role', r)),
    ...entities.filter((e) => e.fields.length).map((e) => block('entities', 'entity', e)),
  ].join('\n');
}

// Each secret's real value with the reference that stands for it.
export function secretValues(roles: Role[], entities: Entity[], env: Env = {}): { value: string; ref: string }[] {
  const of = (owner: FieldOwner, list: Owned[]) =>
    list.flatMap((o) => o.fields.filter((f) => f.secret).map((f) => ({ value: resolved(f, env), ref: fieldRef(owner, o.id, f.id) })));
  return [...of('roles', roles), ...of('entities', entities)];
}

// Replaces every secret's value in a tool result with its reference, so a page
// or an API that echoes a password back doesn't hand it to the model. Values
// under 4 characters are left alone — they'd match too much ordinary text.
export function scrubSecrets(text: string, secrets: { value: string; ref: string }[]): string {
  return secrets
    .filter((s) => s.value.length >= 4)
    .sort((a, b) => b.value.length - a.value.length)
    .reduce((t, s) => t.split(s.value).join(s.ref), text);
}
