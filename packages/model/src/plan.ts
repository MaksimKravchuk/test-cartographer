import { NEW, type Condition, type Effect, type Entity, type Journey, type Permit, type Project, type Provenance, type Rule, type Transition } from './schema.ts';
import {
  activeStates, activeTransitions, appliesTo, arrange, isActive, performer, relatedVariant, roleKind, transitionSteps,
  type ArrangeContext, type Catalog, type Step,
} from './reach.ts';

export type Phase = 'arrange' | 'act' | 'assert';

export type Scenario = {
  // Stable identifier: links the plan, the generated test,
  // run results and external systems (Allure TestOps).
  id: string;
  kind: 'transition' | 'permit' | 'deny' | 'journey' | 'rule';
  entity: string;
  variant: string;
  title: string;
  target: string; // id of the transition, permit, journey or rule; for deny: `<action>@<state>`
  role: string; // the acting role; for a journey, every role joined with “+”
  rules: string[]; // ids of business rules this scenario checks (traceability); [] by default
  preparation: 'tool' | 'path' | 'auto' | 'none' | null;
  provenance: Provenance | null;
  steps: (Step & { phase: Phase })[];
  blocked: string | null;
};

export type Plan = { entity: string; scenarios: Scenario[] };

const tag = (phase: Phase) => (s: Step) => ({ ...s, phase });

const roleTitle = (project: Project | undefined, id: string) => project?.roles.find((r) => r.id === id)?.title ?? id;

// Without a reader, no state can be verified after setup or an act — every
// scenario of the entity is blocked, not just the ones that would use it directly.
export const NO_READER = 'No reader: add entity.reader so states can be verified';

// Why a state can't be reached: its own setup, or a related instance that can't be prepared.
function unreachable(entity: Entity, state: string, variant: string): string {
  const missing = entity.relations.filter((r) => r.requires).map((r) => r.entity);
  const also = missing.length ? ` (it also needs a related ${missing.join(', ')})` : '';
  return `No way to reach state “${state}” for variant “${variant}”${also}`;
}

const effectSteps = (effects: Effect[], variant: string): Step[] =>
  effects
    .filter((e) => appliesTo(e, variant))
    .map((e): Step =>
      e.field === undefined
        ? { do: 'manual', description: e.description }
        : e.relation
          ? { do: 'expectRelated', relation: e.relation, field: e.field, equals: e.equals, delta: e.delta, description: e.description }
          : { do: 'expectField', field: e.field, equals: e.equals, description: e.description },
    );

// A human role has no run entry, or a system role has no invoke tool — the
// action can't actually be exercised by this role in a test.
function bindingReason(action: { title: string; run?: string; invoke?: unknown } | undefined, kind: 'human' | 'system'): string | null {
  if (!action) return null; // caller already reports "unknown action"
  if (kind === 'human' && !action.run) return `Action “${action.title}” has no run entry for a person`;
  if (kind === 'system' && !action.invoke) return `Nothing makes the system perform “${action.title}” in a test: give the action an invoke tool`;
  return null;
}

function transitionScenario(entity: Entity, variant: string, t: Transition, role: string, project: Project | undefined, ctx: ArrangeContext): Scenario {
  const base = {
    id: t.by.length > 1 ? `${entity.id}/${t.id}.${role}/${variant}` : `${entity.id}/${t.id}/${variant}`,
    kind: 'transition' as const,
    entity: entity.id,
    variant,
    title: `${t.title}: ${t.from} → ${t.to}${t.by.length > 1 ? ` — ${roleTitle(project, role)}` : ''}`,
    target: t.id,
    role,
    rules: [] as string[],
    provenance: t.provenance ?? null,
  };
  if (!entity.reader) return { ...base, preparation: null, steps: [], blocked: NO_READER };
  const action = entity.actions.find((a) => a.id === t.action);
  if (!action) return { ...base, preparation: null, steps: [], blocked: `Unknown action “${t.action}”` };
  const reason = bindingReason(action, roleKind(project, role));
  if (reason) return { ...base, preparation: null, steps: [], blocked: reason };
  const a = arrange(entity, variant, t.from, new Set(), ctx);
  if (!a) return { ...base, preparation: null, steps: [], blocked: unreachable(entity, t.from, variant) };
  const [act, reach] = transitionSteps(entity, t, role, project);
  const effects = effectSteps(t.effects, variant);
  return {
    ...base,
    preparation: a.method,
    steps: [...a.steps.map(tag('arrange')), tag('act')(act), ...[reach, ...effects].map(tag('assert'))],
    blocked: null,
  };
}

// One scenario per role in `by`, in the first applicable state — the other
// states this permit allows stay covered by the access matrix, without a
// positive scenario of their own (the matrix already proves the permission holds there).
function permitScenario(entity: Entity, variant: string, p: Permit, role: string, project: Project | undefined, ctx: ArrangeContext): Scenario {
  const stateId = p.states?.[0] ?? activeStates(entity, variant)[0]?.id;
  const state = stateId ? entity.states.find((s) => s.id === stateId) : undefined;
  const base = {
    id: p.by.length > 1 ? `${entity.id}/permit-${p.id}.${role}/${variant}` : `${entity.id}/permit-${p.id}/${variant}`,
    kind: 'permit' as const,
    entity: entity.id,
    variant,
    title: `${p.title}${state ? ` in “${state.title}”` : ''}${p.by.length > 1 ? ` — ${roleTitle(project, role)}` : ''}`,
    target: p.id,
    role,
    rules: [] as string[],
    provenance: p.provenance ?? null,
  };
  if (!entity.reader) return { ...base, preparation: null, steps: [], blocked: NO_READER };
  const action = entity.actions.find((a) => a.id === p.action);
  if (!action) return { ...base, preparation: null, steps: [], blocked: `Unknown action “${p.action}”` };
  const reason = bindingReason(action, roleKind(project, role));
  if (reason) return { ...base, preparation: null, steps: [], blocked: reason };
  if (!stateId) return { ...base, preparation: null, steps: [], blocked: `No state of variant “${variant}” to check this permit in` };
  const a = arrange(entity, variant, stateId, new Set(), ctx);
  if (!a) return { ...base, preparation: null, steps: [], blocked: unreachable(entity, stateId, variant) };
  const perf = performer(entity, p, role, project)!;
  const performStep: Step = { do: 'perform', permit: p.id, title: p.title, action: p.action, role, run: perf.run, invoke: perf.invoke, state: stateId };
  const expectStep: Step = { do: 'expectState', state: stateId, match: state?.match ?? {} };
  const effects = effectSteps(p.effects, variant);
  return {
    ...base,
    preparation: a.method,
    steps: [...a.steps.map(tag('arrange')), tag('act')(performStep), ...[expectStep, ...effects].map(tag('assert'))],
    blocked: null,
  };
}

// ── Closed-world access matrix ───────────────────────────────────────────
// Named `AccessDecision`, not `Decision` — schema.ts already has a `Decision`
// type (a person's verdict on a proposal), and index.ts re-exports both
// modules with `export *`; two exports named `Decision` would collide.
export type AccessDecision = 'allowed' | 'undecided' | 'denied';
export type AccessCell = { role: string; action: string; state: string; decision: AccessDecision; by: string | null };

// Not decided yet, or required but not built: neither is allowed nor denied in a test.
const pendingStatus = new Set(['observed', 'proposed', 'planned']);

function decideCell(entity: Entity, variant: string, role: string, action: string, state: string): AccessCell {
  const matchesT = (t: Transition) => t.action === action && t.from === state && t.by.includes(role) && appliesTo(t, variant);
  const matchesP = (p: Permit) => p.action === action && p.by.includes(role) && appliesTo(p, variant) && (p.states ? p.states.includes(state) : true);
  const decided = entity.transitions.find((t) => isActive(t) && matchesT(t)) ?? entity.permits.find((p) => isActive(p) && matchesP(p));
  if (decided) return { role, action, state, decision: 'allowed', by: decided.id };
  const pending =
    entity.transitions.some((t) => pendingStatus.has(t.status) && matchesT(t)) ||
    entity.permits.some((p) => pendingStatus.has(p.status) && matchesP(p));
  return { role, action, state, decision: pending ? 'undecided' : 'denied', by: null };
}

// The full negative matrix: every (human role, confirmed action with a run
// entry, state) triple and whether some confirmed transition or permit allows it.
export function accessMatrix(entity: Entity, project: Project, variant: string): AccessCell[] {
  const roles = project.roles.filter((r) => r.kind === 'human').map((r) => r.id);
  const actions = entity.actions.filter((a) => isActive(a) && a.run);
  const active = activeStates(entity, variant).map((s) => s.id);
  const cells: AccessCell[] = [];
  for (const role of roles)
    for (const action of actions)
      for (const state of action.kind === 'create' ? [NEW] : active) cells.push(decideCell(entity, variant, role, action.id, state));
  return cells;
}

function denyScenario(entity: Entity, variant: string, cell: AccessCell, project: Project, ctx: ArrangeContext, rules: string[]): Scenario {
  const action = entity.actions.find((a) => a.id === cell.action)!;
  const state = cell.state === NEW ? undefined : entity.states.find((s) => s.id === cell.state);
  const stateTitle = cell.state === NEW ? 'before it exists' : (state?.title ?? cell.state);
  const idState = cell.state === NEW ? 'new' : cell.state;
  const base = {
    id: `${entity.id}/deny-${cell.action}-${cell.role}-${idState}/${variant}`,
    kind: 'deny' as const,
    entity: entity.id,
    variant,
    title: `Denied: ${roleTitle(project, cell.role)} can't “${action.title}” in ${stateTitle}`,
    target: `${cell.action}@${cell.state}`,
    role: cell.role,
    rules,
    provenance: null,
  };
  if (!entity.reader) return { ...base, preparation: null, steps: [], blocked: NO_READER };
  const a = arrange(entity, variant, cell.state, new Set(), ctx);
  if (!a) return { ...base, preparation: null, steps: [], blocked: unreachable(entity, cell.state, variant) };
  const steps: Scenario['steps'] = [
    ...a.steps.map(tag('arrange')),
    tag('assert')({ do: 'expectUnavailable', action: action.id, run: action.run!, role: cell.role, state: cell.state }),
  ];
  if (state) steps.push(tag('assert')({ do: 'expectState', state: state.id, match: state.match }));
  return { ...base, preparation: a.method, steps, blocked: null };
}

// `roles`/`authenticated` conditions produce no scenarios of their own — the
// access matrix already denies the excluded roles; this only links the deny
// scenario back to the rule, keyed by (action, from-state, role).
function ruleTagsFor(entity: Entity, project: Project, variant: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const r of entity.rules) {
    if (!isActive(r) || !appliesTo(r, variant)) continue;
    const t = entity.transitions.find((x) => x.id === r.transition);
    if (!t || !isActive(t)) continue;
    for (const c of r.requires) {
      const excluded =
        c.kind === 'roles'
          ? project.roles.filter((x) => x.kind === 'human' && !c.roles.includes(x.id)).map((x) => x.id)
          : c.kind === 'authenticated'
            ? project.roles.filter((x) => x.kind === 'human' && !x.login).map((x) => x.id)
            : [];
      for (const role of excluded) {
        const key = `${t.action}@${t.from}|${role}`;
        map.set(key, [...(map.get(key) ?? []), r.id]);
      }
    }
  }
  return map;
}

// The `entity-state` condition still gets its own negative scenarios: the
// related instance is put in every other reachable state and the transition
// (performed by whichever role in `by` normally runs it) must stay unavailable.
function entityStateScenarios(
  entity: Entity,
  variant: string,
  r: Rule,
  t: Transition,
  c: Extract<Condition, { kind: 'entity-state' }>,
  project: Project | undefined,
  ctx: ArrangeContext,
): Scenario[] {
  const blocked = (suffix: string, reason: string): Scenario => ({
    id: `${entity.id}/rule-${r.id}-${suffix}/${variant}`,
    kind: 'rule',
    entity: entity.id,
    variant,
    title: `${r.title}: ${suffix}`,
    target: r.id,
    role: '',
    rules: [],
    provenance: r.provenance ?? null,
    preparation: null,
    steps: [],
    blocked: reason,
  });
  if (!entity.reader) return [blocked('reader', NO_READER)];
  const rel = entity.relations.find((x) => x.id === c.relation);
  const target = rel && ctx.catalog?.[rel.entity];
  if (!rel || !target) return [blocked(c.relation, `Needs the model of the related “${c.relation}”`)];
  const rv = relatedVariant(entity, rel, variant, target);
  if (!rv) return [blocked(c.relation, `No variant of ${target.title} goes with “${variant}”`)];
  const perf = performer(entity, t, undefined, project);
  if (!perf?.run) return [blocked(c.relation, `Needs a role that performs “${t.title}” through the UI to check this rule`)];
  return activeStates(target, rv)
    .filter((s) => !c.states.includes(s.id))
    .map((s): Scenario => {
      const base = {
        id: `${entity.id}/rule-${r.id}-${rel.id}-${s.id}/${variant}`,
        kind: 'rule' as const,
        entity: entity.id,
        variant,
        title: `${r.title}: ${target.title} is “${s.title}”, ${roleTitle(project, perf.role)} can't “${t.title}”`,
        target: r.id,
        role: perf.role,
        rules: [] as string[],
        provenance: r.provenance ?? null,
      };
      const a = arrange(entity, variant, t.from, new Set(), { ...ctx, overrides: { [rel.id]: s.id } });
      if (!a) return { ...base, preparation: null, steps: [], blocked: unreachable(entity, t.from, variant) };
      // With a related instance in the “wrong” state, the instance itself must be
      // prepared directly: a path through transitions would be blocked by the rule too.
      if (a.steps.some((step) => step.do === 'transition'))
        return { ...base, preparation: null, steps: [], blocked: `“${t.from}” is reached through transitions; add a setup tool for it to check this rule` };
      const steps: Scenario['steps'] = [
        ...a.steps.map(tag('arrange')),
        tag('assert')({ do: 'expectUnavailable', action: t.action, run: perf.run!, role: perf.role, state: t.from }),
      ];
      const stateObj = entity.states.find((x) => x.id === t.from);
      if (stateObj) steps.push(tag('assert')({ do: 'expectState', state: stateObj.id, match: stateObj.match }));
      return { ...base, preparation: a.method, steps, blocked: null };
    });
}

function ruleScenarios(entity: Entity, variant: string, r: Rule, project: Project | undefined, ctx: ArrangeContext): Scenario[] {
  const t = entity.transitions.find((x) => x.id === r.transition);
  if (!t) return [];
  return r.requires.filter((c) => c.kind === 'entity-state').flatMap((c) => entityStateScenarios(entity, variant, r, t, c, project, ctx));
}

// Which variants a journey runs for: the ones it names, or every variant
// whose states and transitions along the path all apply.
export function journeyVariants(entity: Entity, j: Journey): string[] {
  const variants = entity.variants.filter(isActive).map((v) => v.id);
  if (j.variants) return variants.filter((v) => j.variants!.includes(v));
  return variants.filter((v) => {
    const start = entity.states.find((s) => s.id === j.start);
    if (start && !appliesTo(start, v)) return false;
    return j.path.every((id) => {
      const t = entity.transitions.find((x) => x.id === id);
      if (!t) return true;
      const ends = [t.from, t.to].map((sid) => entity.states.find((s) => s.id === sid));
      return appliesTo(t, v) && ends.every((s) => !s || appliesTo(s, v));
    });
  });
}

function journeyScenario(entity: Entity, variant: string, j: Journey, ctx: ArrangeContext, project: Project | undefined): Scenario {
  const path = j.path.map((id) => entity.transitions.find((t) => t.id === id));
  const perfs = path.map((t) => (t ? performer(entity, t, undefined, project) : null));
  const roles = [...new Set(perfs.flatMap((p) => (p ? [p.role] : [])))];
  const base = {
    id: `${entity.id}/scenario-${j.id}/${variant}`,
    kind: 'journey' as const,
    entity: entity.id,
    variant,
    title: j.title,
    target: j.id,
    role: roles.join('+'),
    rules: [] as string[],
    provenance: j.provenance ?? null,
  };
  const blocked = (reason: string): Scenario => ({ ...base, preparation: null, steps: [], blocked: reason });
  if (!entity.reader) return blocked(NO_READER);

  const active = activeTransitions(entity, variant);
  let cur = j.start;
  for (const [i, t] of path.entries()) {
    if (!t) return blocked(`Step ${i + 1}: unknown transition “${j.path[i]}”`);
    if (t.from !== cur) return blocked(`Step ${i + 1}: “${t.title}” starts in “${t.from}”, but the path is in “${cur}”`);
    if (!active.includes(t)) return blocked(`Step ${i + 1}: “${t.title}” is not a requirement for variant “${variant}”`);
    if (!perfs[i]) return blocked(`Step ${i + 1}: nobody can perform “${t.title}” in a test`);
    cur = t.to;
  }
  const a = arrange(entity, variant, j.start, new Set(), ctx);
  if (!a) return blocked(unreachable(entity, j.start, variant));

  const steps: Scenario['steps'] = a.steps.map(tag('arrange'));
  for (const t of path as Transition[]) {
    const [act, reach] = transitionSteps(entity, t, undefined, project);
    steps.push(tag('act')(act), ...[reach, ...effectSteps(t.effects, variant)].map(tag('assert')));
  }
  return { ...base, preparation: a.method, steps, blocked: null };
}

// Coverage plan: one scenario per role for every confirmed transition and
// permit, plus journeys, entity-state rule scenarios, and (with a project) one
// deny scenario per denied cell of the access matrix. Observed and proposed
// elements are not included in the plan. The catalog (all entities of the
// project) lets setup prepare related instances.
export function buildPlan(entity: Entity, project?: Project, catalog?: Catalog): Plan {
  const ctx: ArrangeContext = { catalog, project };
  const scenarios: Scenario[] = [];
  for (const v of entity.variants.filter(isActive)) {
    const transitions = activeTransitions(entity, v.id);
    for (const t of entity.transitions) {
      if (!isActive(t) || !appliesTo(t, v.id)) continue;
      // A transition implicitly doesn't apply to a variant if one of its states doesn't apply to it —
      // then it's not planned at all, unlike a state that applies but isn't a requirement yet (below).
      const ends = [t.from, t.to].map((id) => entity.states.find((s) => s.id === id));
      if (ends.some((s) => s && !appliesTo(s, v.id))) continue;
      for (const role of t.by) {
        if (transitions.includes(t)) {
          scenarios.push(transitionScenario(entity, v.id, t, role, project, ctx));
          continue;
        }
        scenarios.push({
          id: t.by.length > 1 ? `${entity.id}/${t.id}.${role}/${v.id}` : `${entity.id}/${t.id}/${v.id}`,
          kind: 'transition',
          entity: entity.id,
          variant: v.id,
          title: `${t.title}: ${t.from} → ${t.to}`,
          target: t.id,
          role,
          rules: [],
          preparation: null,
          provenance: t.provenance ?? null,
          steps: [],
          blocked: 'The source or target state is not a requirement for this variant',
        });
      }
    }
    for (const p of entity.permits) {
      if (!isActive(p) || !appliesTo(p, v.id)) continue;
      for (const role of p.by) scenarios.push(permitScenario(entity, v.id, p, role, project, ctx));
    }
    for (const r of entity.rules) {
      const t = entity.transitions.find((x) => x.id === r.transition);
      const ends = t ? [t.from, t.to].map((id) => entity.states.find((s) => s.id === id)) : [];
      if (isActive(r) && t && isActive(t) && appliesTo(r, v.id) && appliesTo(t, v.id) && ends.every((s) => !s || appliesTo(s, v.id)))
        scenarios.push(...ruleScenarios(entity, v.id, r, project, ctx));
    }
    for (const j of entity.scenarios)
      if (isActive(j) && journeyVariants(entity, j).includes(v.id)) scenarios.push(journeyScenario(entity, v.id, j, ctx, project));
    if (project) {
      const tags = ruleTagsFor(entity, project, v.id);
      for (const cell of accessMatrix(entity, project, v.id))
        if (cell.decision === 'denied') scenarios.push(denyScenario(entity, v.id, cell, project, ctx, tags.get(`${cell.action}@${cell.state}|${cell.role}`) ?? []));
    }
  }
  return { entity: entity.id, scenarios };
}
