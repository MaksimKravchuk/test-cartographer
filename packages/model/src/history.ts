import { z } from 'zod';
import type { Entity, Project } from './schema.ts';

// The model's change log: one line per element added, changed or removed,
// with who did it — a person, an agent (through the proposal a person
// accepted), or the new-project template. The workspace appends it to
// history.jsonl on every save, so the log lives next to the model and goes
// into git with it.
//
// ref names the element the way the rest of the model does:
//   role:<id> · entity:<id> · <kind>:<entity>.<id> (action, rule, transition, permit, state, variant, relation, scenario, invariant, field)

export const Author = z.object({
  kind: z.enum(['human', 'agent', 'template']),
  agent: z.string().optional(),
  proposal: z.string().optional(),
});
export type Author = z.infer<typeof Author>;

export const HistoryEntry = z.object({
  at: z.string(),
  by: Author,
  op: z.enum(['add', 'change', 'remove']),
  ref: z.string(),
  title: z.string(),
  // field → [before, after] for a change.
  changes: z.record(z.string(), z.tuple([z.unknown(), z.unknown()])).optional(),
});
export type HistoryEntry = z.infer<typeof HistoryEntry>;

type Item = { id: string; title?: string };
type Change = Omit<HistoryEntry, 'at' | 'by'>;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function fieldChanges(before: Record<string, unknown>, after: Record<string, unknown>, skip: string[] = []) {
  const changes: Record<string, [unknown, unknown]> = {};
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)]))
    if (!skip.includes(k) && !same(before[k], after[k])) changes[k] = [before[k] ?? null, after[k] ?? null];
  return Object.keys(changes).length ? changes : undefined;
}

function diffList(ref: (id: string) => string, before: Item[], after: Item[]): Change[] {
  const old = new Map(before.map((x) => [x.id, x]));
  const out: Change[] = [];
  for (const x of after) {
    const was = old.get(x.id);
    if (!was) out.push({ op: 'add', ref: ref(x.id), title: x.title ?? x.id });
    else {
      const changes = fieldChanges(was as Record<string, unknown>, x as Record<string, unknown>);
      if (changes) out.push({ op: 'change', ref: ref(x.id), title: x.title ?? x.id, changes });
    }
    old.delete(x.id);
  }
  for (const x of old.values()) out.push({ op: 'remove', ref: ref(x.id), title: x.title ?? x.id });
  return out;
}

// Subjects only: the rest of cartographer.yaml (interfaces, MCP, agents) is settings, not the model.
export const diffProject = (before: Project | null, after: Project): Change[] => diffList((id) => `role:${id}`, before?.roles ?? [], after.roles);

const LISTS = { attributes: 'attribute', actions: 'action', rules: 'rule', transitions: 'transition', permits: 'permit', states: 'state', variants: 'variant', relations: 'relation', scenarios: 'scenario', invariants: 'invariant', fields: 'field' } as const;

export function diffEntity(before: Entity | null, after: Entity | null): Change[] {
  const e = (after ?? before)!;
  if (!before) return [{ op: 'add', ref: `entity:${e.id}`, title: e.title }];
  if (!after) return [{ op: 'remove', ref: `entity:${e.id}`, title: e.title }];
  const out: Change[] = [];
  const changes = fieldChanges(before as Record<string, unknown>, after as Record<string, unknown>, Object.keys(LISTS));
  if (changes) out.push({ op: 'change', ref: `entity:${e.id}`, title: after.title, changes });
  for (const [key, kind] of Object.entries(LISTS))
    out.push(...diffList((id) => `${kind}:${e.id}.${id}`, before[key as keyof typeof LISTS] as Item[], after[key as keyof typeof LISTS] as Item[]));
  return out;
}

export const stamp = (changes: Change[], by: Author, at = new Date().toISOString()): HistoryEntry[] => changes.map((c) => ({ at, by, ...c }));
