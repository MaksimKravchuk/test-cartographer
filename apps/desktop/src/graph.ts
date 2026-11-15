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
  heights: Record<string, number> = {},
): Record<string, { x: number; y: number }> {
  // Edge labels take part in the layout so they don't overlap.
  const g = new dagre.graphlib.Graph({ multigraph: true });
  g.setGraph({ rankdir: 'TB', nodesep: 40, ranksep: 36, edgesep: 20, marginx: 40, marginy: 40 });
  const h = (id: string) => heights[id] ?? NODE_H;
  for (const s of states) g.setNode(s.id, { width: NODE_W, height: h(s.id) });
  for (const e of edges)
    if (g.hasNode(e.from) && g.hasNode(e.to) && e.from !== e.to)
      g.setEdge(e.from, e.to, { width: 60 + e.title.length * 7, height: 26, labelpos: 'c' }, e.id);
  dagre.layout(g);
  const auto = (id: string) => {
    const n = g.node(id);
    return { x: n.x - NODE_W / 2, y: n.y - h(id) / 2 };
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

// ── Objects map ───────────────────────────────────────────────────────────
export const OBJECT_W = 260;
const FRAME_PAD = 16;
const FRAME_GAP = 12;
const FRAME_CAPTION_H = 26;
const ROW_WRAP = 3;

export type ObjectBox = { width: number; height: number };

// Rough own-card height from its content: head + id, a chip row for lifecycle
// states (wraps past three), a chip row for subject roles, and a footer with
// the coverage bar. Used only until the card's real height is measured in the
// DOM (see ObjectsView) — a first-pass guess so the first layout isn't empty.
export function objectCardHeight(stateCount: number, roleCount: number, hasFlags: boolean): number {
  const base = 96;
  const stateRows = stateCount === 0 ? 20 : Math.ceil(Math.min(stateCount, 7) / 3) * 24;
  const roleRows = roleCount === 0 ? 0 : Math.ceil(roleCount / 3) * 24;
  return base + stateRows + roleRows + (hasFlags ? 22 : 0);
}

// Lays out the objects map. Parts nest inside their parent's frame, arranged
// bottom-up in rows that wrap after three; the top-level frames and loose
// cards are then placed left to right by dagre, reading like a dependency
// chart. Reference edges between two objects that share a top-level ancestor
// are lifted to that ancestor so ranking sees them; a pair that already
// shares an ancestor is skipped (dagre never sees a self-loop).
export function objectsLayout(
  ownSize: Record<string, ObjectBox>,
  parentOf: Record<string, string | null>,
  refs: { from: string; to: string; label: string }[],
): { position: Record<string, { x: number; y: number }>; size: Record<string, ObjectBox> } {
  const ids = Object.keys(ownSize);
  const childrenOf: Record<string, string[]> = {};
  for (const id of ids) {
    const p = parentOf[id];
    if (p && ownSize[p]) (childrenOf[p] ??= []).push(id);
  }
  const topLevel = ids.filter((id) => !parentOf[id] || !ownSize[parentOf[id]!]);

  const position: Record<string, { x: number; y: number }> = {};
  const size: Record<string, ObjectBox> = {};
  const visiting = new Set<string>();

  const layoutBox = (id: string): ObjectBox => {
    if (visiting.has(id)) return (size[id] = ownSize[id]); // guards a malformed parent cycle
    visiting.add(id);
    const kids = childrenOf[id];
    if (!kids?.length) {
      visiting.delete(id);
      return (size[id] = ownSize[id]);
    }
    const boxes = kids.map((k) => ({ id: k, box: layoutBox(k) }));
    let rowY = 0;
    let contentW = 0;
    for (let i = 0; i < boxes.length; i += ROW_WRAP) {
      const row = boxes.slice(i, i + ROW_WRAP);
      let x = 0;
      for (const r of row) {
        position[r.id] = { x: FRAME_PAD + x, y: FRAME_PAD + ownSize[id].height + FRAME_CAPTION_H + rowY };
        x += r.box.width + FRAME_GAP;
      }
      contentW = Math.max(contentW, x - FRAME_GAP);
      rowY += Math.max(...row.map((r) => r.box.height)) + FRAME_GAP;
    }
    visiting.delete(id);
    return (size[id] = {
      width: Math.max(ownSize[id].width, contentW) + FRAME_PAD * 2,
      height: ownSize[id].height + FRAME_CAPTION_H + rowY - FRAME_GAP + FRAME_PAD * 2,
    });
  };
  for (const id of topLevel) layoutBox(id);
  // A parent cycle would otherwise leave both ends without a size; fall back
  // to treating them as loose top-level cards rather than dropping them.
  const orphans = ids.filter((id) => !size[id]);
  for (const id of orphans) size[id] = ownSize[id];
  const dagreRoots = [...topLevel, ...orphans];

  const rootOf = (id: string): string => {
    const seen = new Set<string>();
    let cur = id;
    while (parentOf[cur] && ownSize[parentOf[cur]!] && !seen.has(cur)) {
      seen.add(cur);
      cur = parentOf[cur]!;
    }
    return cur;
  };

  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 56, ranksep: 90, marginx: 40, marginy: 40 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const id of dagreRoots) g.setNode(id, size[id]);
  // Edge labels take part in ranking too (as in autoLayout), sized from the
  // longest label lifted onto that pair, so the rank gap has room for it.
  const pairs = new Map<string, { a: string; b: string; width: number }>();
  for (const r of refs) {
    const a = rootOf(r.from);
    const b = rootOf(r.to);
    if (a === b || !g.hasNode(a) || !g.hasNode(b)) continue;
    const key = [a, b].sort().join('|');
    const width = 60 + r.label.length * 7;
    const prev = pairs.get(key);
    if (!prev || width > prev.width) pairs.set(key, { a, b, width });
  }
  for (const { a, b, width } of pairs.values()) g.setEdge(a, b, { width, height: 26, labelpos: 'c' });
  dagre.layout(g);
  for (const id of dagreRoots) {
    const n = g.node(id);
    position[id] = { x: n.x - size[id].width / 2, y: n.y - size[id].height / 2 };
  }
  return { position, size };
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
  | { kind: 'action'; id: string }
  | { kind: 'transition'; id: string }
  | { kind: 'permit'; id: string }
  | { kind: 'variant'; id: string }
  | { kind: 'ghost'; proposal: string; op: number }
  | null;

export function stateTitle(entity: Entity, id: string) {
  if (id === '@new') return 'New';
  return entity.states.find((s) => s.id === id)?.title ?? id;
}

// ── State map edges ───────────────────────────────────────────────────────
// A lifecycle where one action leads into a state from many others ("cancel"
// from every open state) draws as a hairball: N edges, N piled-up labels.
// Such a fan is shown once, on the state itself, as "← cancel · from 4 states".
// What is left is drawn one edge per pair of states, both directions merged.
export type MapItem = { from: string; to: string; action: string; kind: string };
export type Fan<T> = { dir: 'in' | 'out'; state: string; others: string[]; items: T[] };
export type PairEdge<T> = { from: string; to: string; items: T[] };

const FAN_MIN = 3;

export function groupTransitions<T extends MapItem>(items: T[]): { fans: Fan<T>[]; edges: PairEdge<T>[] } {
  const fans: Fan<T>[] = [];
  let rest = items;
  for (const dir of ['in', 'out'] as const) {
    const here = (t: T) => (dir === 'in' ? t.to : t.from);
    const there = (t: T) => (dir === 'in' ? t.from : t.to);
    const groups = new Map<string, T[]>();
    for (const t of rest) {
      if (t.from === t.to) continue;
      const k = `${here(t)}|${t.action}|${t.kind}`;
      groups.set(k, [...(groups.get(k) ?? []), t]);
    }
    const taken = new Set<T>();
    for (const g of groups.values()) {
      const state = here(g[0]);
      const others = [...new Set(g.map(there))];
      // An action that also leaves this state the other way ("move" between
      // peers) is a real network, not a fan into a sink; keep it as edges.
      const peer = items.some((t) => t.action === g[0].action && there(t) === state);
      if (others.length < FAN_MIN || peer) continue;
      fans.push({ dir, state, others, items: g });
      g.forEach((t) => taken.add(t));
    }
    rest = rest.filter((t) => !taken.has(t));
  }
  const pairs = new Map<string, T[]>();
  for (const t of rest) {
    const k = `${[t.from, t.to].sort().join('|')}|${t.kind}`;
    pairs.set(k, [...(pairs.get(k) ?? []), t]);
  }
  const edges = [...pairs.values()].map((g) => ({ from: g[0].from, to: g[0].to, items: g }));
  return { fans, edges };
}
