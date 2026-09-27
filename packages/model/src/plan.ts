import { NEW, type Condition, type Entity, type Forbidden, type Journey, type Project, type Provenance, type Rule, type Transition } from './schema.ts';
import { activeStates, activeTransitions, appliesTo, arrange, isActive, relatedVariant, transitionSteps, type ArrangeContext, type Catalog, type Step } from './reach.ts';

export type Phase = 'arrange' | 'act' | 'assert';

export type Scenario = {
  // Stable identifier: links the plan, the generated test,
  // run results and external systems (Allure TestOps).
  id: string;
  kind: 'transition' | 'forbidden' | 'journey' | 'rule';
  entity: string;
  variant: string;
  title: string;
  target: string; // id of the transition, forbidden action, journey or rule
  role: string; // the acting role; for a journey, every role joined with “+”
  preparation: 'tool' | 'path' | 'auto' | 'none' | null;
  provenance: Provenance | null;
  steps: (Step & { phase: Phase })[];
  blocked: string | null;
};

export type Plan = { entity: string; scenarios: Scenario[] };

const tag = (phase: Phase) => (s: Step) => ({ ...s, phase });

function transitionScenario(entity: Entity, variant: string, t: Transition, ctx: ArrangeContext): Scenario {
  const base = {
    id: `${entity.id}/${t.id}/${variant}`,
    kind: 'transition' as const,
    entity: entity.id,
    variant,
    title: `${t.title}: ${t.from} → ${t.to}`,
    target: t.id,
    role: t.role,
    provenance: t.provenance ?? null,
  };
  const a = arrange(entity, variant, t.from, new Set(), ctx);
  if (!a) {
    return { ...base, preparation: null, steps: [], blocked: unreachable(entity, t.from, variant) };
  }
  const [act, reach] = transitionSteps(entity, t);
  const effects = effectSteps(t, variant);
  return {
    ...base,
    preparation: a.method,
    steps: [...a.steps.map(tag('arrange')), tag('act')(act), ...[reach, ...effects].map(tag('assert'))],
    blocked: null,
  };
}

function forbiddenScenario(entity: Entity, variant: string, f: Forbidden, ctx: ArrangeContext): Scenario {
  const t = entity.transitions.find((x) => x.id === f.transition);
  const base = {
    id: `${entity.id}/forbid-${f.id}/${variant}`,
    kind: 'forbidden' as const,
    entity: entity.id,
    variant,
    title: `Forbidden: ${f.role} cannot “${t?.title ?? f.transition}” in ${f.state}`,
    target: f.id,
    role: f.role,
    provenance: f.provenance ?? null,
  };
  const a = arrange(entity, variant, f.state, new Set(), ctx);
  if (!a || !t) {
    return { ...base, preparation: null, steps: [], blocked: unreachable(entity, f.state, variant) };
  }
  return { ...base, preparation: a.method, steps: [...a.steps.map(tag('arrange')), ...unavailableSteps(entity, t, f.role)], blocked: null };
}

// The role doesn't see the action, and the instance stays where it was.
function unavailableSteps(entity: Entity, t: Transition, role: string): Scenario['steps'] {
  const steps: Scenario['steps'] = [{ do: 'expectUnavailable', transition: t.id, action: t.action, role, state: t.from, phase: 'assert' }];
  const state = entity.states.find((s) => s.id === t.from);
  if (state) steps.push({ do: 'expectState', state: state.id, match: state.match, phase: 'assert' });
  return steps;
}

// Why a state can't be reached: its own setup, or a related instance that can't be prepared.
function unreachable(entity: Entity, state: string, variant: string): string {
  const missing = entity.relations.filter((r) => r.requires).map((r) => r.entity);
  const also = missing.length ? ` (it also needs a related ${missing.join(', ')})` : '';
  return `No way to reach state “${state}” for variant “${variant}”${also}`;
}

type Violation = { suffix: string; role: string | null; override?: Record<string, string>; title?: string; reason?: string };

// Negative scenarios for one condition of a rule: who must NOT be able to
// perform the transition, or in which situation it must be unavailable.
function violations(entity: Entity, variant: string, t: Transition, c: Condition, project: Project | undefined, ctx: ArrangeContext): Violation[] {
  if (!project) return [{ suffix: 'roles', role: null, reason: 'Needs the project roles to plan this rule' }];
  switch (c.kind) {
    case 'authenticated': {
      const guests = project.roles.filter((r) => !r.login);
      return guests.length
        ? guests.map((r) => ({ suffix: r.id, role: r.id }))
        : [{ suffix: 'guest', role: null, reason: 'Add a role without login (a guest) to check this rule' }];
    }
    case 'roles':
      return project.roles.filter((r) => !c.roles.includes(r.id)).map((r) => ({ suffix: r.id, role: r.id }));
    case 'entity-state': {
      // The allowed role tries while the related instance is in each other state.
      const rel = entity.relations.find((r) => r.id === c.relation);
      const target = rel && ctx.catalog?.[rel.entity];
      if (!rel || !target) return [{ suffix: c.relation, role: null, reason: `Needs the model of the related “${c.relation}”` }];
      const rv = relatedVariant(entity, rel, variant, target);
      if (!rv) return [{ suffix: c.relation, role: null, reason: `No variant of ${target.title} goes with “${variant}”` }];
      return activeStates(target, rv)
        .filter((s) => !c.states.includes(s.id))
        .map((s) => ({
          suffix: `${rel.id}-${s.id}`,
          role: t.role,
          override: { [rel.id]: s.id },
          title: `${target.title} is “${s.title}”`,
        }));
    }
  }
}

function ruleScenarios(entity: Entity, variant: string, r: Rule, project: Project | undefined, ctx: ArrangeContext): Scenario[] {
  const t = entity.transitions.find((x) => x.id === r.transition);
  if (!t) return [];
  const roleTitle = (id: string) => project?.roles.find((x) => x.id === id)?.title ?? id;
  return r.requires.flatMap((c) =>
    violations(entity, variant, t, c, project, ctx).map((v): Scenario => {
      const base = {
        id: `${entity.id}/rule-${r.id}-${v.suffix}/${variant}`,
        kind: 'rule' as const,
        entity: entity.id,
        variant,
        title: v.title
          ? `${r.title}: ${v.title}, ${roleTitle(t.role)} can't “${t.title}”`
          : v.role
            ? `${r.title}: ${roleTitle(v.role)} can't “${t.title}”`
            : `${r.title}: ${v.suffix}`,
        target: r.id,
        role: v.role ?? '',
        provenance: r.provenance ?? null,
      };
      if (v.reason || !v.role) return { ...base, preparation: null, steps: [], blocked: v.reason ?? 'No role to check' };
      const a = arrange(entity, variant, t.from, new Set(), { ...ctx, overrides: v.override });
      if (!a) return { ...base, preparation: null, steps: [], blocked: unreachable(entity, t.from, variant) };
      // With a related instance in the “wrong” state, the instance itself must be
      // prepared directly: a path through transitions would be blocked by the rule too.
      if (v.override && a.steps.some((s) => s.do === 'transition'))
        return { ...base, preparation: null, steps: [], blocked: `“${t.from}” is reached through transitions; add a setup tool for it to check this rule` };
      return { ...base, preparation: a.method, steps: [...a.steps.map(tag('arrange')), ...unavailableSteps(entity, t, v.role)], blocked: null };
    }),
  );
}

const effectSteps = (t: Transition, variant: string): Step[] =>
  t.effects
    .filter((e) => appliesTo(e, variant))
    .map((e): Step =>
      e.field === undefined
        ? { do: 'manual', description: e.description }
        : e.relation
          ? { do: 'expectRelated', relation: e.relation, field: e.field, equals: e.equals, delta: e.delta, description: e.description }
          : { do: 'expectField', field: e.field, equals: e.equals, description: e.description },
    );

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

function journeyScenario(entity: Entity, variant: string, j: Journey, ctx: ArrangeContext): Scenario {
  const path = j.path.map((id) => entity.transitions.find((t) => t.id === id));
  const roles = [...new Set(path.flatMap((t) => (t ? [t.role] : [])))];
  const base = {
    id: `${entity.id}/scenario-${j.id}/${variant}`,
    kind: 'journey' as const,
    entity: entity.id,
    variant,
    title: j.title,
    target: j.id,
    role: roles.join('+'),
    provenance: j.provenance ?? null,
  };
  const blocked = (reason: string): Scenario => ({ ...base, preparation: null, steps: [], blocked: reason });

  const active = activeTransitions(entity, variant);
  let cur = j.start;
  for (const [i, t] of path.entries()) {
    if (!t) return blocked(`Step ${i + 1}: unknown transition “${j.path[i]}”`);
    if (t.from !== cur) return blocked(`Step ${i + 1}: “${t.title}” starts in “${t.from}”, but the path is in “${cur}”`);
    if (!active.includes(t)) return blocked(`Step ${i + 1}: “${t.title}” is not a requirement for variant “${variant}”`);
    cur = t.to;
  }
  const a = arrange(entity, variant, j.start, new Set(), ctx);
  if (!a) return blocked(unreachable(entity, j.start, variant));

  const steps: Scenario['steps'] = a.steps.map(tag('arrange'));
  for (const t of path as Transition[]) {
    const [act, reach] = transitionSteps(entity, t);
    steps.push(tag('act')(act), ...[reach, ...effectSteps(t, variant)].map(tag('assert')));
  }
  return { ...base, preparation: a.method, steps, blocked: null };
}

// Coverage plan: every confirmed transition, forbidden action and journey — for
// each variant it applies to. Observed and proposed elements are not included in the plan.
// Rules need the project roles (who is a guest, who may act); without the
// project their scenarios are planned as blocked.
// The catalog (all entities of the project) lets setup prepare related instances.
export function buildPlan(entity: Entity, project?: Project, catalog?: Catalog): Plan {
  const ctx: ArrangeContext = { catalog };
  const scenarios: Scenario[] = [];
  for (const v of entity.variants.filter(isActive)) {
    const transitions = activeTransitions(entity, v.id);
    for (const t of entity.transitions) {
      if (!isActive(t) || !appliesTo(t, v.id)) continue;
      // A transition implicitly doesn't apply to a variant if one of its states doesn't apply to it.
      const ends = [t.from, t.to].map((id) => entity.states.find((s) => s.id === id));
      if (ends.some((s) => s && !appliesTo(s, v.id))) continue;
      if (!transitions.includes(t)) {
        scenarios.push({
          id: `${entity.id}/${t.id}/${v.id}`,
          kind: 'transition',
          entity: entity.id,
          variant: v.id,
          title: `${t.title}: ${t.from} → ${t.to}`,
          target: t.id,
          role: t.role,
          preparation: null,
          provenance: t.provenance ?? null,
          steps: [],
          blocked: 'The source or target state is not a requirement for this variant',
        });
        continue;
      }
      scenarios.push(transitionScenario(entity, v.id, t, ctx));
    }
    for (const f of entity.forbidden) {
      const state = entity.states.find((s) => s.id === f.state);
      if (isActive(f) && appliesTo(f, v.id) && (!state || appliesTo(state, v.id)))
        scenarios.push(forbiddenScenario(entity, v.id, f, ctx));
    }
    for (const r of entity.rules) {
      const t = entity.transitions.find((x) => x.id === r.transition);
      const ends = t ? [t.from, t.to].map((id) => entity.states.find((s) => s.id === id)) : [];
      if (isActive(r) && t && isActive(t) && appliesTo(r, v.id) && appliesTo(t, v.id) && ends.every((s) => !s || appliesTo(s, v.id)))
        scenarios.push(...ruleScenarios(entity, v.id, r, project, ctx));
    }
    for (const j of entity.scenarios)
      if (isActive(j) && journeyVariants(entity, j).includes(v.id)) scenarios.push(journeyScenario(entity, v.id, j, ctx));
  }
  return { entity: entity.id, scenarios };
}
