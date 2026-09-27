import type { Entity } from './schema.ts';

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
