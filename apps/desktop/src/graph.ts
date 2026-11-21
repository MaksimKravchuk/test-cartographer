import type { Entity } from '@tc/model';

export function nextId(base: string, taken: string[]): string {
  const clean = base.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'item';
  const id = /^[a-z]/.test(clean) ? clean : `x-${clean}`;
  if (!taken.includes(id)) return id;
  let i = 2;
  while (taken.includes(`${id}-${i}`)) i++;
  return `${id}-${i}`;
}

// What the object's technical details show: everything, or one element of it.
export type Selection =
  | { kind: 'state'; id: string }
  | { kind: 'action'; id: string }
  | { kind: 'transition'; id: string }
  | { kind: 'permit'; id: string }
  | { kind: 'variant'; id: string }
  | null;

export function stateTitle(entity: Entity, id: string) {
  if (id === '@new') return 'New';
  return entity.states.find((s) => s.id === id)?.title ?? id;
}
