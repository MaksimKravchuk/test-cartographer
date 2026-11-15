import { NEW, type Entity, type Permit, type Project, type Relation, type State, type Transition, type ToolCall } from './schema.ts';

// A scenario step. A scenario is a flat sequence of steps executed by the engine's
// runtime; the same structure goes into the Playwright test and into Markdown.
export type Step =
  | { do: 'prepare'; state: string; tool: string; args: Record<string, unknown>; key: string }
  | { do: 'transition'; transition: string; title: string; action: string; role: string; run?: string; invoke?: ToolCall; from: string; to: string }
  // A permit: the state must stay the same after it.
  | { do: 'perform'; permit: string; title: string; action: string; role: string; run?: string; invoke?: ToolCall; state: string }
  | { do: 'expectState'; state: string; match: Record<string, unknown> }
  // An invariant of the entity, checked right after the instance is read in a state it covers.
  | { do: 'expectInvariant'; invariant: string; title: string; state: string; match: Record<string, unknown> }
  | { do: 'expectField'; field: string; equals: unknown; description: string }
  // A human role's action must not be available in the UI. Only checked for
  // roles/actions that have a `run` entry — see accessMatrix().
  | { do: 'expectUnavailable'; action: string; run: string; role: string; state: string }
  | { do: 'manual'; description: string }
  // Prepare a related instance first (its own arrangement, run against its own
  // reader); its key becomes {{rel.<relation>}} / ctx.related.<relation>.
  | { do: 'related'; relation: string; entity: string; variant: string; state: string; steps: Step[] }
  // A field of the related instance: an exact value, or a change since right before the act.
  | { do: 'expectRelated'; relation: string; field: string; equals?: unknown; delta?: number; description: string };

// Other entities of the project, needed to prepare related instances.
export type Catalog = Record<string, Entity>;
export type ArrangeContext = {
  catalog?: Catalog;
  // Needed to tell human roles (act via `run`) from system roles (act via
  // `invoke`) — see performer(). Without it every role is treated as human,
  // matching Role.kind's default.
  project?: Project;
  // Put a related instance into this state instead of the required one (negative rule checks).
  overrides?: Record<string, string>;
  depth?: number;
};

// Which variant of the related entity goes with this variant: the explicit
// mapping, the same id if the related entity has it, or its first variant.
export function relatedVariant(entity: Entity, r: Relation, variant: string, target: Entity): string | null {
  const active = target.variants.filter((v) => v.status === 'confirmed').map((v) => v.id);
  const mapped = r.variants?.[variant] ?? (active.includes(variant) ? variant : active[0]);
  return mapped && active.includes(mapped) ? mapped : null;
}

// Steps that prepare every required related instance. null — one of them can't be prepared.
function dependencies(entity: Entity, variant: string, ctx: ArrangeContext): Step[] | null {
  const steps: Step[] = [];
  for (const r of entity.relations) {
    const state = ctx.overrides?.[r.id] ?? r.requires;
    if (!state) continue;
    const target = ctx.catalog?.[r.entity];
    if (!target || (ctx.depth ?? 0) > 4) return null;
    const rv = relatedVariant(entity, r, variant, target);
    if (!rv) return null;
    const a = arrange(target, rv, state, new Set(), { catalog: ctx.catalog, project: ctx.project, depth: (ctx.depth ?? 0) + 1 });
    if (!a) return null;
    steps.push({ do: 'related', relation: r.id, entity: r.entity, variant: rv, state, steps: a.steps });
  }
  return steps;
}

// none — nothing to prepare: the scenario starts before the instance exists.
export type Arrangement = { steps: Step[]; method: 'tool' | 'path' | 'auto' | 'none' };

export function appliesTo(el: { variants?: string[] }, variant: string): boolean {
  return !el.variants || el.variants.includes(variant);
}

export function isActive(el: { status: string }): boolean {
  return el.status === 'confirmed';
}

export function activeStates(entity: Entity, variant: string): State[] {
  return entity.states.filter((s) => isActive(s) && appliesTo(s, variant));
}

export function activeTransitions(entity: Entity, variant: string): Transition[] {
  const states = new Set(activeStates(entity, variant).map((s) => s.id));
  return entity.transitions.filter(
    (t) => isActive(t) && appliesTo(t, variant) && (states.has(t.from) || t.from === NEW) && states.has(t.to),
  );
}

// A role's kind, from the project — human unless a system role is named explicitly.
// Defaults to human when the project isn't known, matching Role.kind's own default.
export function roleKind(project: Project | undefined, role: string): 'human' | 'system' {
  return project?.roles.find((r) => r.id === role)?.kind ?? 'human';
}

export type Performer = { role: string; run?: string; invoke?: ToolCall };

// The role that performs a transition or permit in a scenario: with `role` given,
// that role if it is in `by` and can perform the action (human roles act through
// `run`, system roles through `invoke`); without, the first role in `by` that can.
// null when nobody can — the action is missing, or no role in `by` has a binding.
//
// A role's kind lives on Project.roles, which entity/transition alone don't
// carry, so `project` is optional. Without it every role is treated as
// human, matching Role.kind's default — see roleKind() above.
export function performer(entity: Entity, t: Transition | Permit, role?: string, project?: Project): Performer | null {
  const action = entity.actions.find((a) => a.id === t.action);
  // A planned action isn't built yet: nothing can perform it, in a test or in setup.
  if (!action || action.status === 'planned') return null;
  const candidates = role ? (t.by.includes(role) ? [role] : []) : t.by;
  for (const r of candidates) {
    const kind = roleKind(project, r);
    if (kind === 'human' && action.run) return { role: r, run: action.run };
    if (kind === 'system' && action.invoke) return { role: r, invoke: action.invoke };
  }
  return null;
}

export function transitionSteps(entity: Entity, t: Transition, role?: string, project?: Project): Step[] {
  const to = entity.states.find((s) => s.id === t.to)!;
  const perf = performer(entity, t, role, project);
  return [
    { do: 'transition', transition: t.id, title: t.title, action: t.action, role: perf?.role ?? role ?? t.by[0], run: perf?.run, invoke: perf?.invoke, from: t.from, to: t.to },
    { do: 'expectState', state: to.id, match: to.match },
  ];
}

function viaTool(state: State, variant: string): Step[] | null {
  const setup = state.setup.find((s) => s.kind === 'tool');
  if (!setup || setup.kind !== 'tool') return null;
  return [
    { do: 'prepare', state: state.id, tool: setup.tool, args: template(setup.args, { variant }), key: setup.key },
    { do: 'expectState', state: state.id, match: state.match },
  ];
}

// How to obtain an entity instance of variant `variant` in state `target`.
// Order: explicit tool recipe → explicit path recipe → shortest path through
// confirmed transitions from any state that has a tool recipe, or from NEW
// through a creating transition. Only transitions that have a performer (see
// performer() above) are used — one nobody can run can't set anything up.
export function arrange(entity: Entity, variant: string, target: string, seen = new Set<string>(), ctx: ArrangeContext = {}): Arrangement | null {
  const deps = dependencies(entity, variant, ctx);
  if (!deps) return null;
  if (target === NEW) return { steps: deps, method: 'none' };
  const states = activeStates(entity, variant);
  const state = states.find((s) => s.id === target);
  if (!state || seen.has(target)) return null;
  const inner = new Set(seen).add(target);

  const direct = viaTool(state, variant);
  if (direct) return { steps: [...deps, ...direct], method: 'tool' };

  const transitions = activeTransitions(entity, variant).filter((t) => performer(entity, t, undefined, ctx.project));

  for (const setup of state.setup) {
    if (setup.kind !== 'path') continue;
    const base = arrange(entity, variant, setup.from, inner, ctx);
    if (!base) continue;
    const steps = [...base.steps];
    let cur = setup.from;
    let ok = true;
    for (const id of setup.via) {
      const t = transitions.find((x) => x.id === id && x.from === cur);
      if (!t) {
        ok = false;
        break;
      }
      steps.push(...transitionSteps(entity, t, undefined, ctx.project));
      cur = t.to;
    }
    if (ok && cur === target) return { steps, method: 'path' };
  }

  // Multi-source BFS: sources are states with a tool recipe (initial ones
  // first), then NEW if some confirmed transition creates the instance.
  const sources = states
    .filter((s) => s.id !== target && !inner.has(s.id) && viaTool(s, variant))
    .sort((a, b) => Number(!!b.initial) - Number(!!a.initial))
    .map((s) => s.id);
  if (transitions.some((t) => t.from === NEW)) sources.push(NEW);
  const prev = new Map<string, Transition | null>();
  const queue: string[] = [];
  for (const id of sources) {
    prev.set(id, null);
    queue.push(id);
  }
  while (queue.length && !prev.has(target)) {
    const cur = queue.shift()!;
    for (const t of transitions) {
      if (t.from !== cur || prev.has(t.to) || (inner.has(t.to) && t.to !== target)) continue;
      prev.set(t.to, t);
      queue.push(t.to);
    }
  }
  if (!prev.has(target)) return null;

  const path: Transition[] = [];
  let cur = target;
  while (prev.get(cur)) {
    const t = prev.get(cur)!;
    path.unshift(t);
    cur = t.from;
  }
  const steps = cur === NEW ? [...deps] : [...deps, ...viaTool(states.find((s) => s.id === cur)!, variant)!];
  for (const t of path) steps.push(...transitionSteps(entity, t, undefined, ctx.project));
  return { steps, method: 'auto' };
}

// Substitutes {{name}} and {{a.b}} in tool arguments (ids may hold "-", as in
// {{entities.line-item.sku}}). A string consisting entirely of a single
// placeholder is replaced with the value as is (not only as a string).
export function template<T>(value: T, vars: Record<string, unknown>): T {
  const lookup = (path: string) =>
    path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), vars);
  if (typeof value === 'string') {
    const whole = value.match(/^\{\{([\w.-]+)\}\}$/);
    if (whole) return (lookup(whole[1]) ?? value) as T;
    return value.replace(/\{\{([\w.-]+)\}\}/g, (m, k) => {
      const v = lookup(k);
      return v === undefined ? m : String(v);
    }) as T;
  }
  if (Array.isArray(value)) return value.map((v) => template(v, vars)) as T;
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, template(v, vars)])) as T;
  return value;
}
