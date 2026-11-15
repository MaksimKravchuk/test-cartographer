import type { Entity, Project } from './schema.ts';

// For every entity, the entity it is part of: its first part-of relation's target, when the
// target exists and walking parents never returns to the start. Otherwise null.
export function objectParents(entities: Pick<Entity, 'id' | 'relations'>[]): Record<string, string | null> {
  const ids = new Set(entities.map((e) => e.id));
  const target = new Map<string, string | null>();
  for (const e of entities) {
    const rel = e.relations.find((r) => r.kind === 'part-of');
    target.set(e.id, rel && ids.has(rel.entity) ? rel.entity : null);
  }
  const parents: Record<string, string | null> = {};
  for (const e of entities) {
    let cur = target.get(e.id) ?? null;
    const seen = new Set([e.id]);
    let cycle = false;
    while (cur !== null) {
      if (seen.has(cur)) {
        cycle = true;
        break;
      }
      seen.add(cur);
      cur = target.get(cur) ?? null;
    }
    parents[e.id] = cycle ? null : target.get(e.id)!;
  }
  return parents;
}

// Takes a subject off every entity: off the actions that list it, off
// transitions, permits and role conditions that keep another subject. What it
// is the only subject of is a blocker, named so a person can change it first.
export function removeRole(id: string, project: Pick<Project, 'agents' | 'roles'>, entities: Entity[]): { blockers: string[]; entities: Entity[] } {
  const blockers = project.agents.filter((a) => a.role === id).map((a) => `agent “${a.title}”`);
  // Another subject's sign-in reading this one's fields ({{roles.<id>.password}}) would get the placeholder as a value.
  for (const r of project.roles) if (r.id !== id && JSON.stringify(r.login ?? {}).includes(`{{roles.${id}.`)) blockers.push(`sign-in of “${r.title}”`);
  const changed: Entity[] = [];
  for (const e of entities) {
    const without = (by: string[]) => by.filter((r) => r !== id);
    for (const t of [...e.transitions, ...e.permits]) if (t.by.length === 1 && t.by[0] === id) blockers.push(`${e.title} › ${t.title}`);
    for (const r of e.rules) if (r.requires.some((c) => c.kind === 'roles' && c.roles.length === 1 && c.roles[0] === id)) blockers.push(`${e.title} › rule “${r.title}”`);
    const next: Entity = {
      ...e,
      actions: e.actions.map((a) => (a.by ? { ...a, by: without(a.by) } : a)),
      transitions: e.transitions.map((t) => ({ ...t, by: without(t.by) })),
      permits: e.permits.map((p) => ({ ...p, by: without(p.by) })),
      rules: e.rules.map((r) => ({ ...r, requires: r.requires.map((c) => (c.kind === 'roles' ? { ...c, roles: without(c.roles) } : c)) })),
    };
    if (JSON.stringify(next) !== JSON.stringify(e)) changed.push(next);
  }
  return { blockers, entities: changed };
}
