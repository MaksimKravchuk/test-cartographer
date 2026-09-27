import dagre from '@dagrejs/dagre';
import type { Entity } from '@tc/model';

export const NODE_W = 188;
export const NODE_H = 64;

// Top-down auto layout: the lifecycle reads like a route. Saved positions take priority:
// when a person moves nodes, the map remembers it.
export function autoLayout(
  states: { id: string }[],
  edges: { id: string; from: string; to: string; title: string }[],
  saved: Record<string, { x: number; y: number }>,
): Record<string, { x: number; y: number }> {
  // Edge labels take part in the layout so they don't overlap.
  const g = new dagre.graphlib.Graph({ multigraph: true });
  g.setGraph({ rankdir: 'TB', nodesep: 40, ranksep: 36, edgesep: 20, marginx: 40, marginy: 40 });
  for (const s of states) g.setNode(s.id, { width: NODE_W, height: NODE_H });
  for (const e of edges)
    if (g.hasNode(e.from) && g.hasNode(e.to) && e.from !== e.to)
      g.setEdge(e.from, e.to, { width: 60 + e.title.length * 7, height: 26, labelpos: 'c' }, e.id);
  dagre.layout(g);
  const auto = (id: string) => {
    const n = g.node(id);
    return { x: n.x - NODE_W / 2, y: n.y - NODE_H / 2 };
  };

  const out: Record<string, { x: number; y: number }> = {};
  for (const s of states) if (saved[s.id]) out[s.id] = saved[s.id];
  if (Object.keys(out).length === 0) {
    for (const s of states) out[s.id] = auto(s.id);
    return out;
  }

  // Nodes without a saved position (new states, agent proposals) are placed
  // relative to a neighbor that already has one, keeping dagre's offset,
  // then nudged sideways until they don't overlap anything.
  const overlaps = (p: { x: number; y: number }) =>
    Object.values(out).some((q) => Math.abs(q.x - p.x) < NODE_W + 24 && Math.abs(q.y - p.y) < NODE_H + 24);
  const pending = states.filter((s) => !out[s.id]).map((s) => s.id);
  for (let guard = 0; pending.length && guard < 1000; guard++) {
    const id = pending.shift()!;
    const neighbor = edges.map((e) => (e.to === id ? e.from : e.from === id ? e.to : null)).find((n) => n && out[n]);
    if (!neighbor && pending.some((p) => edges.some((e) => (e.from === p && e.to === id) || (e.to === p && e.from === id)))) {
      pending.push(id);
      continue;
    }
    let p: { x: number; y: number };
    if (neighbor) {
      const a = auto(id);
      const b = auto(neighbor);
      p = { x: out[neighbor].x + a.x - b.x, y: out[neighbor].y + a.y - b.y };
    } else {
      const maxX = Math.max(...Object.values(out).map((q) => q.x));
      p = { x: maxX + NODE_W + 60, y: 0 };
    }
    while (overlaps(p)) p = { x: p.x + NODE_W + 40, y: p.y };
    out[id] = p;
  }
  return out;
}

export function applies(el: { variants?: string[] }, variant: string | null) {
  return !variant || !el.variants || el.variants.includes(variant);
}

export function nextId(base: string, taken: string[]): string {
  const clean = base.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'item';
  const id = /^[a-z]/.test(clean) ? clean : `x-${clean}`;
  if (!taken.includes(id)) return id;
  let i = 2;
  while (taken.includes(`${id}-${i}`)) i++;
  return `${id}-${i}`;
}

export type Selection =
  | { kind: 'state'; id: string }
  | { kind: 'transition'; id: string }
  | { kind: 'forbidden'; id: string }
  | { kind: 'variant'; id: string }
  | { kind: 'ghost'; proposal: string; op: number }
  | null;

export function stateTitle(entity: Entity, id: string) {
  if (id === '@new') return 'New';
  return entity.states.find((s) => s.id === id)?.title ?? id;
}
