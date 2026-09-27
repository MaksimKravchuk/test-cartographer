import type { Entity, ScenarioResult } from './schema.ts';
import type { Plan, Scenario } from './plan.ts';
import { appliesTo, arrange, isActive } from './reach.ts';

export type CellStatus = 'passed' | 'failed' | 'skipped' | 'blocked' | 'not-run';
export type Cell = { scenario: string; status: CellStatus; error?: string; at?: string };
export type StateCell = 'verified' | 'reachable' | 'unreachable' | 'n/a';

export type Coverage = {
  entity: string;
  variants: string[];
  transitions: { id: string; title: string; role: string; from: string; to: string; cells: Record<string, Cell | null> }[];
  forbidden: { id: string; title: string; role: string; cells: Record<string, Cell | null> }[];
  journeys: { id: string; title: string; role: string; steps: number; cells: Record<string, Cell | null> }[];
  // A rule's cell combines its negative scenarios with the transition's own (positive) scenario.
  rules: { id: string; title: string; text: string; transition: string; cells: Record<string, Cell | null> }[];
  states: { id: string; title: string; cells: Record<string, StateCell> }[];
  roles: { role: string; total: number; passed: number }[];
  totals: Record<CellStatus, number> & { scenarios: number };
};

function cellOf(s: Scenario, results: Record<string, ScenarioResult>): Cell {
  if (s.blocked) return { scenario: s.id, status: 'blocked', error: s.blocked };
  const r = results[s.id];
  if (!r) return { scenario: s.id, status: 'not-run' };
  return { scenario: s.id, status: r.status, error: r.error, at: r.at };
}

export function coverage(entity: Entity, plan: Plan, results: Record<string, ScenarioResult>): Coverage {
  const variants = entity.variants.filter(isActive).map((v) => v.id);
  const byTarget = new Map<string, Scenario>();
  for (const s of plan.scenarios) byTarget.set(`${s.kind}:${s.target}:${s.variant}`, s);

  const row = (kind: Scenario['kind'], id: string, el: { variants?: string[] }) =>
    Object.fromEntries(
      variants.map((v) => {
        const s = byTarget.get(`${kind}:${id}:${v}`);
        return [v, s && appliesTo(el, v) ? cellOf(s, results) : null];
      }),
    );

  // A state is “verified” if its probe passed in at least one successful scenario.
  const verified = new Set<string>();
  for (const s of plan.scenarios)
    if (results[s.id]?.status === 'passed')
      for (const step of s.steps) if (step.do === 'expectState') verified.add(`${step.state}:${s.variant}`);

  const transitions = entity.transitions.filter(isActive).map((t) => ({
    id: t.id, title: t.title, role: t.role, from: t.from, to: t.to, cells: row('transition', t.id, t),
  }));
  const forbidden = entity.forbidden.filter(isActive).map((f) => ({
    id: f.id, title: `${f.role} ⊘ ${f.transition} @ ${f.state}`, role: f.role, cells: row('forbidden', f.id, f),
  }));
  const journeys = entity.scenarios.filter(isActive).map((j) => ({
    id: j.id,
    title: j.title,
    role: plan.scenarios.find((s) => s.kind === 'journey' && s.target === j.id)?.role ?? '',
    steps: j.path.length,
    cells: Object.fromEntries(
      variants.map((v) => {
        const s = byTarget.get(`journey:${j.id}:${v}`);
        return [v, s ? cellOf(s, results) : null];
      }),
    ),
  }));
  const worst = (cells: Cell[]): Cell => {
    for (const status of ['failed', 'blocked', 'not-run', 'skipped'] as const) {
      const c = cells.find((x) => x.status === status);
      if (c) return c;
    }
    return cells[0];
  };
  const rules = entity.rules.filter(isActive).map((r) => ({
    id: r.id,
    title: r.title,
    text: r.text,
    transition: r.transition,
    cells: Object.fromEntries(
      variants.map((v) => {
        const own = plan.scenarios.filter((s) => s.kind === 'rule' && s.target === r.id && s.variant === v);
        const positive = byTarget.get(`transition:${r.transition}:${v}`);
        const cells = [...own, ...(positive ? [positive] : [])].map((s) => cellOf(s, results));
        return [v, own.length ? worst(cells) : null];
      }),
    ),
  }));
  const states = entity.states.filter(isActive).map((s) => ({
    id: s.id,
    title: s.title,
    cells: Object.fromEntries(
      variants.map((v): [string, StateCell] => [
        v,
        !appliesTo(s, v) ? 'n/a' : verified.has(`${s.id}:${v}`) ? 'verified' : arrange(entity, v, s.id) ? 'reachable' : 'unreachable',
      ]),
    ),
  }));

  const roleMap = new Map<string, { total: number; passed: number }>();
  const totals = { scenarios: 0, passed: 0, failed: 0, skipped: 0, blocked: 0, 'not-run': 0 };
  for (const s of plan.scenarios) {
    const c = cellOf(s, results);
    totals.scenarios++;
    totals[c.status]++;
    if (s.kind === 'journey' || !s.role) continue; // a journey spans roles; roles count single transitions
    const r = roleMap.get(s.role) ?? { total: 0, passed: 0 };
    r.total++;
    if (c.status === 'passed') r.passed++;
    roleMap.set(s.role, r);
  }

  return {
    entity: entity.id,
    variants,
    transitions,
    forbidden,
    journeys,
    rules,
    states,
    roles: [...roleMap].map(([role, v]) => ({ role, ...v })),
    totals,
  };
}
