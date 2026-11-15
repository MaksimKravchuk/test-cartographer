// Evaluation: how close a workspace's model (confirmed elements plus every
// proposal an agent made, as if all were accepted) comes to a reference
// description of the same product. Reports recall, precision and extras per
// category: subjects, objects, params, states, transitions, actions, rules.
//
// Matching is by name first — ids, titles, glossary and reference synonyms,
// split into words and compared by overlap — and optionally by a judge agent
// for what names can't settle (rules, differently-worded actions). A miss is
// not automatically the agent's fault: the reference can be wrong or stale, so
// extras and contradictions are listed for a person to review.
import { readFile, stat } from 'node:fs/promises';
import YAML from 'yaml';
import { z } from 'zod';
import { Workspace, type AgentProvider, type Effort } from '@tc/model';
import { runAgent } from './agents/runtime.ts';

export const CATEGORIES = ['subject', 'object', 'param', 'state', 'transition', 'action', 'rule'] as const;
export type Category = (typeof CATEGORIES)[number];
type Conf = 'high' | 'medium' | 'low';

// ── Reference format (YAML) ──────────────────────────────────────────────────
const Names = z.array(z.string()).default([]);
const Conf = z.enum(['high', 'medium', 'low']).default('high');
const RefItem = z.object({ id: z.string(), names: Names, conf: Conf, area: z.string().optional(), where: z.string().optional() });
const RefRule = z.object({ text: z.string(), conf: Conf, kind: z.string().optional(), area: z.string().optional(), where: z.string().optional() });
const RefTransition = z.object({
  // State ids of this object, "@new" for creation, or "*" for any state.
  from: z.array(z.string()),
  to: z.array(z.string()),
  action: z.string().optional(),
  conf: Conf,
  where: z.string().optional(),
});
const RefObject = RefItem.extend({
  params: z.array(RefItem.extend({ values: z.array(z.string()).optional() })).default([]),
  states: z.array(RefItem).default([]),
  actions: z.array(RefItem.extend({ by: z.array(z.string()).default([]) })).default([]),
  transitions: z.array(RefTransition).default([]),
  rules: z.array(RefRule).default([]),
});
export const Reference = z.object({
  name: z.string().optional(),
  subjects: z.array(RefItem).default([]),
  objects: z.array(RefObject).default([]),
  // Rules no single object owns.
  rules: z.array(RefRule).default([]),
});
export type Reference = z.infer<typeof Reference>;

// ── One flat list of items, for the reference and the model alike ────────────
export type Item = {
  cat: Category;
  key: string; // unique within its side: "<object>/<id>" or "<id>"
  object?: string; // the owning object's id
  names: string[];
  conf: Conf;
  area?: string;
  where?: string;
  from?: string[];
  to?: string[];
  action?: string; // a transition's action id
};

export function flattenReference(ref: Reference): Item[] {
  const out: Item[] = [];
  for (const s of ref.subjects) out.push({ cat: 'subject', key: s.id, names: [s.id, ...s.names], conf: s.conf, area: s.area, where: s.where });
  ref.rules.forEach((r, i) => out.push({ cat: 'rule', key: `rule/${i}`, names: [r.text], conf: r.conf, area: r.area, where: r.where }));
  for (const o of ref.objects) {
    out.push({ cat: 'object', key: o.id, names: [o.id, ...o.names], conf: o.conf, area: o.area, where: o.where });
    const add = (cat: Category, x: { id: string; names: string[]; conf: Conf; where?: string }) =>
      out.push({ cat, key: `${o.id}/${cat}:${x.id}`, object: o.id, names: [x.id, ...x.names], conf: x.conf, area: o.area, where: x.where });
    o.params.forEach((x) => add('param', x));
    o.states.forEach((x) => add('state', x));
    o.actions.forEach((x) => add('action', x));
    o.transitions.forEach((t, i) =>
      out.push({ cat: 'transition', key: `${o.id}/transition:${i}`, object: o.id, names: [`${t.from.join('|')} → ${t.to.join('|')}${t.action ? ` (${t.action})` : ''}`], conf: t.conf, area: o.area, where: t.where, from: t.from, to: t.to, action: t.action }),
    );
    o.rules.forEach((r, i) => out.push({ cat: 'rule', key: `${o.id}/rule:${i}`, object: o.id, names: [r.text], conf: r.conf, area: r.area ?? o.area, where: r.where }));
  }
  return out;
}

// The model as if every proposal were accepted: what the agents claim, on top
// of what a person already confirmed. Rejected elements don't count.
// A workspace used as the reference counts its own model only (`proposals: false`).
export async function flattenWorkspace(ws: Workspace, opts: { proposals?: boolean } = {}): Promise<Item[]> {
  const project = await ws.project();
  const catalog = await ws.catalog();
  const proposals = opts.proposals === false ? [] : await ws.proposals();
  const synonyms = (word: string) => project.glossary.filter((t) => [t.term, ...t.synonyms].some((w) => norm(w) === norm(word))).flatMap((t) => [t.term, ...t.synonyms]);
  type Bag = { id: string; title?: string; text?: string; from?: string; to?: string; guards?: string[]; effects?: { description: string }[]; note?: string; status?: string };
  const entities = new Map<string, { title: string; description?: string; lists: Record<string, Bag[]> }>();
  const lists = () => ({ attributes: [], states: [], actions: [], transitions: [], permits: [], rules: [], invariants: [] }) as Record<string, Bag[]>;
  for (const e of Object.values(catalog)) entities.set(e.id, { title: e.title, description: e.description, lists: { attributes: e.attributes, states: e.states, actions: e.actions, transitions: e.transitions, permits: e.permits, rules: e.rules, invariants: e.invariants } as unknown as Record<string, Bag[]> });
  const roles: Bag[] = [...project.roles];
  const collection: Record<string, string> = { attribute: 'attributes', state: 'states', action: 'actions', transition: 'transitions', permit: 'permits', rule: 'rules', invariant: 'invariants' };
  for (const p of proposals) {
    for (const op of p.ops) {
      if (op.op !== 'add') continue;
      const v = op.value as Bag;
      if (typeof v.id !== 'string') continue;
      if (!p.entity) {
        if (op.kind === 'role') roles.push(v);
        if (op.kind === 'entity' && !entities.has(v.id)) entities.set(v.id, { title: v.title ?? v.id, lists: lists() });
        continue;
      }
      if (!entities.has(p.entity)) entities.set(p.entity, { title: p.entity, lists: lists() });
      const list = entities.get(p.entity)!.lists[collection[op.kind] ?? ''];
      if (list && !list.some((x) => x.id === v.id)) list.push(v);
    }
  }
  const out: Item[] = [];
  const live = (x: Bag) => x.status !== 'rejected';
  for (const r of roles.filter(live)) out.push({ cat: 'subject', key: r.id, names: [r.id, r.title ?? '', ...synonyms(r.title ?? r.id)], conf: 'high' });
  for (const [id, e] of entities) {
    out.push({ cat: 'object', key: id, names: [id, e.title, ...synonyms(e.title), ...synonyms(id)], conf: 'high' });
    const L = e.lists;
    const add = (cat: Category, x: Bag, extra: Partial<Item> = {}) => out.push({ cat, key: `${id}/${cat}:${x.id}`, object: id, names: [x.id, x.title ?? ''], conf: 'high', ...extra });
    L.attributes.filter(live).forEach((x) => add('param', x));
    L.states.filter(live).forEach((x) => add('state', x));
    L.actions.filter(live).forEach((x) => add('action', x));
    L.transitions.filter(live).forEach((x) => add('transition', x, { from: [x.from ?? ''], to: [x.to ?? ''], action: (x as { action?: string }).action, names: [x.id, x.title ?? '', `${x.from} → ${x.to}`] }));
    // Every claim in words is a rule-like item: rules, invariants, guards, effects, rights notes.
    const rule = (k: string, text: string) => out.push({ cat: 'rule', key: `${id}/${k}`, object: id, names: [text], conf: 'high' });
    L.rules.filter(live).forEach((x) => rule(`rule:${x.id}`, `${x.title ?? ''}: ${x.text ?? ''}`));
    L.invariants.filter(live).forEach((x) => rule(`invariant:${x.id}`, `${x.title ?? ''}: ${x.text ?? ''}`));
    for (const t of [...L.transitions, ...L.permits].filter(live)) {
      (t.guards ?? []).forEach((g, i) => rule(`guard:${t.id}.${i}`, g));
      (t.effects ?? []).forEach((f, i) => rule(`effect:${t.id}.${i}`, f.description));
    }
    L.attributes.filter((a) => live(a) && a.note).forEach((a) => rule(`note:${a.id}`, `${a.title ?? a.id}: ${a.note}`));
  }
  return out;
}

// ── Name matching ─────────────────────────────────────────────────────────────
const STOP = new Set(['the', 'a', 'an', 'of', 'to', 'for', 'on', 'in', 'by', 'and', 'or', 'its', 'is', 'be', 'it', 'as', 'at', 'with']);
// The same verb in different words, so "Add tag" meets "create".
const VERBS: Record<string, string> = Object.fromEntries(
  Object.entries({ create: ['add', 'new', 'make', 'mint', 'register', 'signup'], update: ['edit', 'change', 'modify', 'rename', 'set', 'patch'], delete: ['remove', 'destroy', 'erase', 'purge', 'drop'], read: ['get', 'view', 'show', 'list', 'see', 'browse', 'fetch', 'open'], complete: ['finish', 'done', 'close'], restore: ['undelete', 'recover', 'unarchive'] }).flatMap(([v, ws]) => [[v, v], ...ws.map((w) => [w, v])]),
);
const stem = (w: string) => (w.length > 4 && w.endsWith('ies') ? `${w.slice(0, -3)}y` : w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
export const words = (s: string) =>
  s
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w && !STOP.has(w))
    .map(stem);
const norm = (s: string) => words(s).join('');

function lev(a: string, b: string) {
  const d = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0];
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const t = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = t;
    }
  }
  return d[b.length];
}

// 0..1: exact (after normalization) is 1; otherwise word overlap (Jaccard), or
// spelling closeness for one-word names ("colour" / "color").
export function nameScore(a: string, b: string, drop: Set<string> = new Set(), verbs = false): number {
  const w = (s: string) => words(s).filter((x) => !drop.has(x)).map((x) => (verbs ? (VERBS[x] ?? x) : x));
  const [x, y] = [w(a), w(b)];
  if (!x.length || !y.length) return 0;
  if (x.join('') === y.join('')) return 1;
  const sx = new Set(x);
  const sy = new Set(y);
  const inter = [...sx].filter((t) => sy.has(t)).length;
  const jac = inter / new Set([...sx, ...sy]).size;
  if (x.length === 1 && y.length === 1) {
    const [p, q] = [x[0], y[0]];
    // "trash" / "trashed", "archive" / "archived": one word starts the other.
    const prefix = Math.min(p.length, q.length) >= 4 && (p.startsWith(q) || q.startsWith(p)) && Math.abs(p.length - q.length) <= 3;
    return Math.max(jac, prefix || (p.length >= 5 && 1 - lev(p, q) / Math.max(p.length, q.length) >= 0.8) ? 0.8 : 0);
  }
  return jac;
}

const best = (a: string[], b: string[], drop?: Set<string>, verbs?: boolean) => Math.max(0, ...a.flatMap((x) => b.map((y) => nameScore(x, y, drop, verbs))));

export type Match = { ref: string; cand: string; score: number; by: 'name' | 'judge' };
export type Contradiction = { cand: string; ref?: string; why: string };

// Each model item is matched to its closest reference item above `threshold`
// (many model items may land on one reference item: an agent may split one
// object in two). A reference item counts as found when any model item lands on it.
function matchNames(refs: Item[], cands: Item[], threshold: number, score: (r: Item, c: Item) => number): Match[] {
  const out: Match[] = [];
  const found = new Set<string>();
  for (const c of cands) {
    let top: { r: Item; s: number } | undefined;
    for (const r of refs) {
      const s = score(r, c);
      // On a tie, a reference item nothing found yet wins: two equal rules each get their own match.
      if (s >= threshold && (!top || s > top.s || (s === top.s && found.has(top.r.key) && !found.has(r.key)))) top = { r, s };
    }
    if (top) found.add(top.r.key);
    if (top) out.push({ ref: top.r.key, cand: c.key, score: Math.round(top.s * 100) / 100, by: 'name' });
  }
  return out;
}

export function matchModel(ref: Item[], cand: Item[], threshold = 0.5): Match[] {
  const of = (side: Item[], cat: Category, object?: string) => side.filter((x) => x.cat === cat && (object === undefined || x.object === object));
  const matches: Match[] = [];
  matches.push(...matchNames(of(ref, 'subject'), of(cand, 'subject'), threshold, (r, c) => best(r.names, c.names)));
  const objects = matchNames(of(ref, 'object'), of(cand, 'object'), threshold, (r, c) => best(r.names, c.names));
  matches.push(...objects);
  const refItem = new Map(ref.map((x) => [x.key, x]));
  for (const om of objects) {
    const [ro, co] = [refItem.get(om.ref)!, cand.find((x) => x.key === om.cand)!];
    // "Create task" in Task is "create": the object's own words say nothing.
    const drop = new Set([...ro.names, ...co.names].flatMap(words));
    for (const cat of ['param', 'state'] as const) matches.push(...matchNames(of(ref, cat, ro.key), of(cand, cat, co.key), threshold, (r, c) => best(r.names, c.names)));
    matches.push(...matchNames(of(ref, 'action', ro.key), of(cand, 'action', co.key), threshold, (r, c) => best(r.names, c.names, drop, true)));
    // A transition is found when a model transition joins states that match the reference's from and to.
    const stateOf = new Map(matches.filter((m) => m.cand.startsWith(`${co.key}/state:`)).map((m) => [m.cand.slice(`${co.key}/state:`.length), m.ref]));
    const fits = (refSide: string[], s: string) =>
      s === '@new' ? refSide.includes('@new') : refSide.includes('*') || refSide.some((x) => `${ro.key}/state:${x}` === stateOf.get(s));
    const actionOf = new Map(matches.filter((m) => m.cand.startsWith(`${co.key}/action:`)).map((m) => [m.cand, m.ref]));
    const taken = new Set<string>();
    for (const c of of(cand, 'transition', co.key)) {
      const fitting = of(ref, 'transition', ro.key).filter((t) => fits(t.from!, c.from![0]) && fits(t.to!, c.to![0]));
      // Two transitions between the same states (reject and cancel): the one with the matching action, then one not taken yet.
      const sameAction = (t: Item) => !!t.action && actionOf.get(`${co.key}/action:${c.action}`) === `${ro.key}/action:${t.action}`;
      const r = fitting.find((t) => sameAction(t) && !taken.has(t.key)) ?? fitting.find((t) => !taken.has(t.key)) ?? fitting[0];
      if (r) taken.add(r.key);
      if (r) matches.push({ ref: r.key, cand: c.key, score: 1, by: 'name' });
    }
    // Rules are prose: overlap of the words that carry meaning, a weak signal the judge replaces.
    matches.push(...matchNames(of(ref, 'rule', ro.key), of(cand, 'rule', co.key), 0.34, (r, c) => best(r.names, c.names, drop)));
  }
  return matches;
}

// ── Judge: an agent pairs what names couldn't ─────────────────────────────────
export type JudgeOptions = { provider: AgentProvider; model?: string; effort?: Effort; onLog?: (l: string) => void };

const JudgeInput = z.object({
  matches: z.array(z.object({ ref: z.string(), cand: z.string() })).default([]),
  contradicted: z.array(z.object({ cand: z.string(), ref: z.string().optional(), why: z.string() })).default([]),
});

const JUDGE_SYSTEM = `You compare two descriptions of the same software product, item by item.
REFERENCE items come from a careful description of the product; MODEL items come from a tool that rebuilt the model from
the product's docs and code. Pair each MODEL item with the REFERENCE item that states the same thing: the same
subject, object, field, state, action or rule, even if worded differently, more narrowly or more broadly. A MODEL item
that covers several REFERENCE items may be paired with each of them. Never pair items that are only on the same topic.
Also list MODEL items that a REFERENCE item contradicts (a different limit, a different allowed role, a transition the
reference forbids), with the REFERENCE key and one line on why. Items you can't settle stay unpaired.
Answer with one call of the verdict tool; keys must be copied exactly.`;

export async function judge(ref: Item[], cand: Item[], matches: Match[], opts: JudgeOptions): Promise<{ matches: Match[]; contradicted: Contradiction[] }> {
  const found = new Set(matches.map((m) => m.ref));
  const used = new Set(matches.map((m) => m.cand));
  const objectMatches = matches.filter((m) => !m.ref.includes('/') && ref.find((x) => x.key === m.ref)?.cat === 'object');
  // One batch per reference object, with every model item of the objects matched to it; plus one for subjects and unowned rules.
  const groups: { title: string; refs: Item[]; cands: Item[] }[] = [];
  const show = (x: Item) => ({ key: x.key, cat: x.cat, text: x.names.filter(Boolean).join(' / ').slice(0, 400) });
  groups.push({ title: 'subjects and project-wide rules', refs: ref.filter((x) => x.cat === 'subject' || (x.cat === 'rule' && !x.object)), cands: cand.filter((x) => x.cat === 'subject') });
  for (const r of ref.filter((x) => x.cat === 'object')) {
    const objs = objectMatches.filter((m) => m.ref === r.key).map((m) => m.cand);
    if (!objs.length) continue;
    groups.push({ title: `object ${r.key}`, refs: ref.filter((x) => x.object === r.key && ['param', 'action', 'rule'].includes(x.cat)), cands: cand.filter((x) => objs.includes(x.object!) && ['param', 'action', 'rule'].includes(x.cat)) });
  }
  // Unmatched model objects might still be a reference object under another name.
  groups.push({ title: 'objects', refs: ref.filter((x) => x.cat === 'object' && !found.has(x.key)), cands: cand.filter((x) => x.cat === 'object' && !used.has(x.key)) });

  const out: Match[] = [];
  const contradicted: Contradiction[] = [];
  for (const g of groups) {
    if (!g.refs.length || !g.cands.length) continue;
    const refKeys = new Set(g.refs.map((x) => x.key));
    const candKeys = new Set(g.cands.map((x) => x.key));
    let verdict: z.infer<typeof JudgeInput> | undefined;
    const prompt = `Group: ${g.title}.\n\nREFERENCE:\n${JSON.stringify(g.refs.map(show))}\n\nMODEL:\n${JSON.stringify(g.cands.map(show))}\n\nAlready paired by name (keep or extend): ${JSON.stringify(matches.filter((m) => refKeys.has(m.ref) && candKeys.has(m.cand)).map(({ ref, cand }) => ({ ref, cand })))}`;
    opts.onLog?.(`⚖ judging ${g.title}: ${g.refs.length} reference × ${g.cands.length} model items`);
    await runAgent({
      runtime: { provider: opts.provider, model: opts.model, effort: opts.effort ?? 'low', maxSteps: 4 },
      system: JUDGE_SYSTEM,
      prompt,
      tools: [
        {
          name: 'verdict',
          description: 'Hand in the pairs and the contradictions.',
          input: JudgeInput,
          run: async (v: z.infer<typeof JudgeInput>) => {
            const bad = [...v.matches.flatMap((m) => [refKeys.has(m.ref) ? [] : [m.ref], candKeys.has(m.cand) ? [] : [m.cand]].flat()), ...v.contradicted.filter((c) => !candKeys.has(c.cand)).map((c) => c.cand)];
            if (bad.length) throw new Error(`Unknown keys: ${bad.join(', ')} — copy keys exactly`);
            verdict = v;
            return 'Recorded — stop now.';
          },
        },
      ],
      deliver: 'verdict',
      isDone: () => verdict !== undefined,
      onLog: () => {},
    }).catch((e) => opts.onLog?.(`   ⚠ judge failed on ${g.title}: ${(e as Error).message}`));
    for (const m of verdict?.matches ?? []) out.push({ ...m, score: 1, by: 'judge' });
    contradicted.push(...(verdict?.contradicted ?? []));
  }
  return { matches: out, contradicted };
}

// ── Scores and report ─────────────────────────────────────────────────────────
export type CategoryScore = { cat: Category; ref: number; found: number; refHigh: number; foundHigh: number; model: number; matched: number; recall: number; recallHigh: number; precision: number };
export type Evaluation = {
  scores: CategoryScore[];
  areas: { area: string; ref: number; found: number; recall: number }[];
  missing: Item[]; // reference items nothing matched
  extras: Item[]; // model items that match nothing in the reference: invented, or the reference lacks them
  contradicted: (Contradiction & { text: string; refText?: string })[];
  matches: Match[];
};

const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : 0);

export function score(ref: Item[], cand: Item[], matches: Match[], contradicted: Contradiction[] = []): Evaluation {
  // Pairs only count inside their own category (a judge can't pair a param with a rule).
  const cat = new Map([...ref, ...cand].map((x) => [x.key, x.cat]));
  const valid = matches.filter((m) => ref.some((r) => r.key === m.ref) && cand.some((c) => c.key === m.cand) && cat.get(m.ref) === cat.get(m.cand));
  const found = new Set(valid.map((m) => m.ref));
  const used = new Set(valid.map((m) => m.cand));
  const scores = CATEGORIES.map((c) => {
    const r = ref.filter((x) => x.cat === c);
    const m = cand.filter((x) => x.cat === c);
    const f = r.filter((x) => found.has(x.key)).length;
    const high = r.filter((x) => x.conf === 'high');
    const fh = high.filter((x) => found.has(x.key)).length;
    const matched = m.filter((x) => used.has(x.key)).length;
    return { cat: c, ref: r.length, found: f, refHigh: high.length, foundHigh: fh, model: m.length, matched, recall: pct(f, r.length), recallHigh: pct(fh, high.length), precision: pct(matched, m.length) };
  });
  const areaNames = [...new Set(ref.map((x) => x.area ?? '—'))];
  const areas = areaNames.map((a) => {
    const r = ref.filter((x) => (x.area ?? '—') === a);
    const f = r.filter((x) => found.has(x.key)).length;
    return { area: a, ref: r.length, found: f, recall: pct(f, r.length) };
  });
  const text = (k?: string) => [...ref, ...cand].find((x) => x.key === k)?.names.filter(Boolean).join(' / ');
  return {
    scores,
    areas,
    missing: ref.filter((x) => !found.has(x.key)),
    extras: cand.filter((x) => !used.has(x.key)),
    contradicted: contradicted.map((c) => ({ ...c, text: text(c.cand) ?? c.cand, refText: text(c.ref) })),
    matches: valid,
  };
}

export async function loadReference(path: string): Promise<Item[]> {
  if ((await stat(path)).isDirectory()) return flattenWorkspace(new Workspace(path), { proposals: false });
  return flattenReference(Reference.parse(YAML.parse(await readFile(path, 'utf8'))));
}

export async function evaluate(ws: Workspace, referencePath: string, opts: { judge?: JudgeOptions; threshold?: number } = {}): Promise<Evaluation> {
  const ref = await loadReference(referencePath);
  const cand = await flattenWorkspace(ws);
  const matches = matchModel(ref, cand, opts.threshold);
  if (!opts.judge) return score(ref, cand, matches);
  const j = await judge(ref, cand, matches, opts.judge);
  return score(ref, cand, [...matches, ...j.matches], j.contradicted);
}

export function evaluationMarkdown(e: Evaluation, title: string, limit = 40): string {
  const short = (x: Item) => `${x.key}: ${x.names.filter(Boolean).slice(1, 3).join(' / ') || x.names[0]}`.slice(0, 200);
  const lines = [
    `# ${title}`,
    '',
    '| Category | Reference | Found | Recall | Recall (high conf.) | Model | Matched | Precision |',
    '|---|---:|---:|---:|---:|---:|---:|---:|',
    ...e.scores.map((s) => `| ${s.cat} | ${s.ref} | ${s.found} | ${s.recall}% | ${s.recallHigh}% (${s.foundHigh}/${s.refHigh}) | ${s.model} | ${s.matched} | ${s.precision}% |`),
    '',
    '## Recall by area',
    '',
    '| Area | Reference | Found | Recall |',
    '|---|---:|---:|---:|',
    ...e.areas.sort((a, b) => b.ref - a.ref).map((a) => `| ${a.area} | ${a.ref} | ${a.found} | ${a.recall}% |`),
    '',
    `## Contradicted by the reference (${e.contradicted.length}) — review: the reference may be the one that is wrong`,
    '',
    ...e.contradicted.slice(0, limit).map((c) => `- **${c.text}** vs ${c.refText ?? c.ref ?? '?'} — ${c.why}`),
    '',
    `## Missing, high confidence (${e.missing.filter((x) => x.conf === 'high').length})`,
    '',
    ...CATEGORIES.flatMap((c) => {
      const m = e.missing.filter((x) => x.cat === c && x.conf === 'high');
      return m.length ? [`- **${c}** (${m.length}): ${m.slice(0, limit).map((x) => (c === 'rule' || c === 'transition' ? x.names[0].slice(0, 120) : x.key)).join('; ')}`] : [];
    }),
    '',
    `## Not in the reference (${e.extras.length}) — invented, or the reference lacks them`,
    '',
    ...CATEGORIES.flatMap((c) => {
      const m = e.extras.filter((x) => x.cat === c);
      return m.length ? [`- **${c}** (${m.length}): ${m.slice(0, limit).map(short).join('; ')}`] : [];
    }),
  ];
  return `${lines.join('\n')}\n`;
}
