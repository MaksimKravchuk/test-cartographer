import type { Entity, Project, ScenarioResult } from './schema.ts';
import { accessMatrix, type AccessDecision, type Plan, type Scenario } from './plan.ts';
import { appliesTo, arrange, isActive } from './reach.ts';

export type CellStatus = 'passed' | 'failed' | 'skipped' | 'blocked' | 'not-run';
export type Cell = { scenario: string; status: CellStatus; error?: string; at?: string };
export type StateCell = 'verified' | 'reachable' | 'unreachable' | 'n/a';

export type Coverage = {
  entity: string;
  variants: string[];
  // Several roles → one combined cell: the worst status of their scenarios wins.
  transitions: { id: string; title: string; by: string[]; from: string; to: string; cells: Record<string, Cell | null> }[];
  permits: { id: string; title: string; by: string[]; action: string; cells: Record<string, Cell | null> }[];
  // Closed-world access matrix: one row per (role, action, state).
  access: { role: string; action: string; state: string; cells: Record<string, { decision: AccessDecision; result: Cell | null } | null> }[]; // null — state n/a for the variant
  journeys: { id: string; title: string; role: string; steps: number; cells: Record<string, Cell | null> }[];
  // A rule's cell combines its own (entity-state) scenarios, the deny scenarios
  // it's tagged onto (roles/authenticated conditions), and the transition's own positive scenarios.
  rules: { id: string; title: string; text: string; transition?: string; cells: Record<string, Cell | null> }[];
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

function worst(cells: Cell[]): Cell {
  for (const status of ['failed', 'blocked', 'not-run', 'skipped'] as const) {
    const c = cells.find((x) => x.status === status);
    if (c) return c;
  }
  return cells[0];
}

// Coverage needs `project` to compute the access matrix; without it, `access` is empty.
export function coverage(entity: Entity, plan: Plan, results: Record<string, ScenarioResult>, project?: Project): Coverage {
  const variants = entity.variants.filter(isActive).map((v) => v.id);
  const byKey = new Map<string, Scenario[]>();
  for (const s of plan.scenarios) {
    const key = `${s.kind}:${s.target}:${s.variant}`;
    const list = byKey.get(key);
    if (list) list.push(s);
    else byKey.set(key, [s]);
  }

  const combinedRow = (kind: Scenario['kind'], id: string, el: { variants?: string[] }) =>
    Object.fromEntries(
      variants.map((v) => {
        if (!appliesTo(el, v)) return [v, null];
        const list = byKey.get(`${kind}:${id}:${v}`) ?? [];
        return [v, list.length ? worst(list.map((s) => cellOf(s, results))) : null];
      }),
    );

  // A state is “verified” if its probe passed in at least one successful scenario.
  const verified = new Set<string>();
  for (const s of plan.scenarios)
    if (results[s.id]?.status === 'passed')
      for (const step of s.steps) if (step.do === 'expectState') verified.add(`${step.state}:${s.variant}`);

  const transitions = entity.transitions.filter(isActive).map((t) => ({
    id: t.id, title: t.title, by: t.by, from: t.from, to: t.to, cells: combinedRow('transition', t.id, t),
  }));
  const permits = entity.permits.filter(isActive).map((p) => ({
    id: p.id, title: p.title, by: p.by, action: p.action, cells: combinedRow('permit', p.id, p),
  }));
  const journeys = entity.scenarios.filter(isActive).map((j) => ({
    id: j.id,
    title: j.title,
    role: plan.scenarios.find((s) => s.kind === 'journey' && s.target === j.id)?.role ?? '',
    steps: j.path.length,
    cells: Object.fromEntries(
      variants.map((v) => {
        const s = byKey.get(`journey:${j.id}:${v}`)?.[0];
        return [v, s ? cellOf(s, results) : null];
      }),
    ),
  }));
  const rules = entity.rules.filter(isActive).map((r) => ({
    id: r.id,
    title: r.title,
    text: r.text,
    transition: r.transition,
    cells: Object.fromEntries(
      variants.map((v) => {
        const own = plan.scenarios.filter((s) => s.kind === 'rule' && s.target === r.id && s.variant === v);
        const denies = plan.scenarios.filter((s) => s.kind === 'deny' && s.variant === v && s.rules.includes(r.id));
        const positive = byKey.get(`transition:${r.transition}:${v}`) ?? [];
        const all = [...own, ...denies, ...positive];
        return [v, all.length ? worst(all.map((s) => cellOf(s, results))) : null];
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

  // Access rows: one per (role, action, state) across every variant it applies
  // to (some variants don't have that state at all — a null cell, “n/a”).
  const access: Coverage['access'] = [];
  if (project) {
    const byVariant = new Map(variants.map((v) => [v, accessMatrix(entity, project, v)]));
    const keys = new Set<string>();
    for (const v of variants) for (const c of byVariant.get(v)!) keys.add(`${c.role}|${c.action}|${c.state}`);
    for (const key of keys) {
      const [role, action, state] = key.split('|');
      const cells = Object.fromEntries(
        variants.map((v) => {
          const cell = byVariant.get(v)!.find((c) => c.role === role && c.action === action && c.state === state);
          if (!cell) return [v, null];
          const result =
            cell.decision === 'denied'
              ? (byKey.get(`deny:${action}@${state}:${v}`) ?? []).find((s) => s.role === role)
              : cell.decision === 'allowed'
                ? (byKey.get(`transition:${cell.by}:${v}`) ?? byKey.get(`permit:${cell.by}:${v}`) ?? []).find((s) => s.role === role)
                : undefined;
          return [v, { decision: cell.decision, result: result ? cellOf(result, results) : null }];
        }),
      );
      access.push({ role, action, state, cells });
    }
  }

  const roleMap = new Map<string, { total: number; passed: number }>();
  const totals = { scenarios: 0, passed: 0, failed: 0, skipped: 0, blocked: 0, 'not-run': 0 };
  for (const s of plan.scenarios) {
    const c = cellOf(s, results);
    totals.scenarios++;
    totals[c.status]++;
    if (s.kind === 'journey' || !s.role) continue; // a journey spans roles; roles count single-role scenarios
    const r = roleMap.get(s.role) ?? { total: 0, passed: 0 };
    r.total++;
    if (c.status === 'passed') r.passed++;
    roleMap.set(s.role, r);
  }

  return {
    entity: entity.id,
    variants,
    transitions,
    permits,
    access,
    journeys,
    rules,
    states,
    roles: [...roleMap].map(([role, v]) => ({ role, ...v })),
    totals,
  };
}
