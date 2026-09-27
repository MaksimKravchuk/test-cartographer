// The backlog is a view over the model, not a second model: epics and features
// slice it by action, stories cite the exact elements they specify. This module
// traces scenarios back to backlog items and rolls up coverage for the GUI.
import { accessMatrix, type Plan, type Scenario } from './plan.ts';
import { isActive, type Catalog } from './reach.ts';
import type { CellStatus } from './coverage.ts';
import type { Issue } from './validate.ts';
import { type ActionKind, type Backlog, type Entity, type Epic, type Feature, type Project, type ScenarioResult, type Status, type Story } from './schema.ts';

export type Totals = Record<CellStatus, number> & { scenarios: number };

export type ActionInfo = {
  ref: string;
  entity: string;
  action: string;
  title: string;
  kind: ActionKind | null;
  resolved: boolean; // the action exists in the model
  // Who may do it — from confirmed transitions and permits.
  allowed: { element: string; kind: 'transition' | 'permit'; by: string[]; from?: string; to?: string; states?: string[] | null }[];
  undecided: number; // access-matrix cells still undecided for this action, all variants
  totals: Totals;
};

export type StoryInfo = {
  id: string;
  key?: string;
  title: string;
  text?: string;
  trackerStatus?: string;
  status: Status;
  acceptance: string[];
  covers: { ref: string; resolved: boolean }[];
  scenarios: string[];
  totals: Totals;
};

export type FeatureInfo = {
  id: string;
  key?: string;
  title: string;
  description?: string;
  epic?: string;
  status: Status;
  actions: ActionInfo[];
  stories: StoryInfo[];
  scenarios: string[];
  totals: Totals;
};

export type EpicInfo = {
  id: string;
  key?: string;
  title: string;
  description?: string;
  status: Status;
  features: FeatureInfo[];
  stories: StoryInfo[]; // stories directly under the epic
  scenarios: string[];
  totals: Totals;
};

export type BacklogCoverage = {
  epics: EpicInfo[];
  orphanFeatures: FeatureInfo[]; // no epic
  orphanStories: StoryInfo[]; // neither feature nor epic
  unmappedStories: string[]; // ids of stories with no resolved `covers` — requirements not in the model yet
  totals: Totals;
};

function duplicates(ids: string[]): string[] {
  const seen = new Set<string>();
  return ids.filter((id) => (seen.has(id) ? true : (seen.add(id), false)));
}

// "<entity>.<action>" the scenario exercises: what a feature slices the model by.
export function scenarioActions(entity: Entity, s: Scenario): string[] {
  const ref = (action: string) => `${entity.id}.${action}`;
  if (s.kind === 'transition') {
    const t = entity.transitions.find((x) => x.id === s.target);
    return t ? [ref(t.action)] : [];
  }
  if (s.kind === 'permit') {
    const p = entity.permits.find((x) => x.id === s.target);
    return p ? [ref(p.action)] : [];
  }
  if (s.kind === 'deny') {
    const [action] = s.target.split('@');
    return action ? [ref(action)] : [];
  }
  if (s.kind === 'rule') {
    const r = entity.rules.find((x) => x.id === s.target);
    const t = r && entity.transitions.find((x) => x.id === r.transition);
    return t ? [ref(t.action)] : [];
  }
  // journey — every transition on its path
  const j = entity.scenarios.find((x) => x.id === s.target);
  if (!j) return [];
  const actions = j.path.map((id) => entity.transitions.find((x) => x.id === id)).filter((t): t is NonNullable<typeof t> => !!t).map((t) => ref(t.action));
  return [...new Set(actions)];
}

// element ref: "<action|transition|permit|rule|journey>:<entity>.<id>"
const refPattern = /^(action|transition|permit|rule|journey):([a-z][a-z0-9_-]*)\.([a-z][a-z0-9_-]*)$/;

function parseRef(ref: string): { kind: string; entity: string; id: string } | null {
  const m = ref.match(refPattern);
  return m ? { kind: m[1], entity: m[2], id: m[3] } : null;
}

// Whether a story's `covers` ref resolves to a real element of the model —
// regardless of its status: onboarding may cite something only proposed.
function refResolved(catalog: Catalog, ref: string): boolean {
  const parsed = parseRef(ref);
  const entity = parsed && catalog[parsed.entity];
  if (!parsed || !entity) return false;
  switch (parsed.kind) {
    case 'action':
      return entity.actions.some((a) => a.id === parsed.id);
    case 'transition':
      return entity.transitions.some((t) => t.id === parsed.id);
    case 'permit':
      return entity.permits.some((p) => p.id === parsed.id);
    case 'rule':
      return entity.rules.some((r) => r.id === parsed.id);
    default: // journey
      return entity.scenarios.some((j) => j.id === parsed.id);
  }
}

function actionRefResolved(catalog: Catalog, ref: string): boolean {
  const [entityId, actionId] = ref.split('.');
  return !!catalog[entityId]?.actions.some((a) => a.id === actionId);
}

function refMatchesScenario(entity: Entity, s: Scenario, ref: string): boolean {
  const parsed = parseRef(ref);
  if (!parsed || parsed.entity !== entity.id) return false;
  const { kind, id } = parsed;
  if (kind === 'action') return scenarioActions(entity, s).includes(`${entity.id}.${id}`);
  if (kind === 'permit') return s.kind === 'permit' && s.target === id;
  if (kind === 'journey') return s.kind === 'journey' && s.target === id;
  if (kind === 'rule') return (s.kind === 'rule' && s.target === id) || s.rules.includes(id);
  // transition: the transition's own scenario, a rule scenario of a rule tied to
  // it, or a journey whose path walks through it.
  if (s.kind === 'transition' && s.target === id) return true;
  if (s.kind === 'rule') {
    const r = entity.rules.find((x) => x.id === s.target);
    if (r?.transition === id) return true;
  }
  if (s.kind === 'journey') {
    const j = entity.scenarios.find((x) => x.id === s.target);
    if (j?.path.includes(id)) return true;
  }
  return false;
}

// Which backlog items this scenario belongs to: a feature when its actions
// intersect the scenario's, a story when one of its `covers` matches; both
// pull in their epic (a story's epic, or its feature's).
export function traceScenario(backlog: Backlog, entity: Entity, s: Scenario): { epics: string[]; features: string[]; stories: string[] } {
  const liveFeatures = new Map(backlog.features.filter((f) => f.status !== 'rejected').map((f) => [f.id, f] as const));
  const liveEpicIds = new Set(backlog.epics.filter((e) => e.status !== 'rejected').map((e) => e.id));
  const actions = new Set(scenarioActions(entity, s));

  const matchedFeatures = [...liveFeatures.values()].filter((f) => f.actions.some((a) => actions.has(a)));
  const stories = backlog.stories.filter((story) => story.status !== 'rejected' && story.covers.some((ref) => refMatchesScenario(entity, s, ref)));

  const featureIds = new Set(matchedFeatures.map((f) => f.id));
  for (const story of stories) if (story.feature && liveFeatures.has(story.feature)) featureIds.add(story.feature);

  const epicIds = new Set<string>();
  for (const id of featureIds) {
    const epic = liveFeatures.get(id)?.epic;
    if (epic && liveEpicIds.has(epic)) epicIds.add(epic);
  }
  for (const story of stories) if (story.epic && liveEpicIds.has(story.epic)) epicIds.add(story.epic);

  return { epics: [...epicIds], features: [...featureIds], stories: stories.map((story) => story.id) };
}

// Coverage rolled up from every entity's plan to the backlog above it: what
// exists, what a story covers, what's still undecided or unmapped.
export function backlogCoverage(backlog: Backlog, project: Project, catalog: Catalog, plans: Record<string, Plan>, results: Record<string, ScenarioResult>): BacklogCoverage {
  const liveEpics = backlog.epics.filter((e) => e.status !== 'rejected');
  const liveFeatures = backlog.features.filter((f) => f.status !== 'rejected');
  const liveStories = backlog.stories.filter((s) => s.status !== 'rejected');
  const liveEpicIds = new Set(liveEpics.map((e) => e.id));
  const liveFeatureIds = new Set(liveFeatures.map((f) => f.id));
  const liteBacklog: Backlog = { epics: liveEpics, features: liveFeatures, stories: liveStories };

  const allScenarios: { entity: Entity; scenario: Scenario }[] = [];
  for (const plan of Object.values(plans)) {
    const entity = catalog[plan.entity];
    if (entity) for (const scenario of plan.scenarios) allScenarios.push({ entity, scenario });
  }

  const byAction = new Map<string, Set<string>>();
  const byFeature = new Map<string, Set<string>>();
  const byStory = new Map<string, Set<string>>();
  const scenarioById = new Map<string, Scenario>();
  const addTo = (map: Map<string, Set<string>>, key: string, id: string) => map.set(key, (map.get(key) ?? new Set()).add(id));

  for (const { entity, scenario } of allScenarios) {
    scenarioById.set(scenario.id, scenario);
    for (const ref of scenarioActions(entity, scenario)) addTo(byAction, ref, scenario.id);
    const trace = traceScenario(liteBacklog, entity, scenario);
    for (const id of trace.features) addTo(byFeature, id, scenario.id);
    for (const id of trace.stories) addTo(byStory, id, scenario.id);
  }

  const statusOf = (id: string): CellStatus => {
    const s = scenarioById.get(id);
    if (!s) return 'not-run';
    return s.blocked ? 'blocked' : (results[id]?.status ?? 'not-run');
  };
  const totalsOf = (ids: Iterable<string>): Totals => {
    const totals: Totals = { scenarios: 0, passed: 0, failed: 0, skipped: 0, blocked: 0, 'not-run': 0 };
    for (const id of new Set(ids)) {
      totals.scenarios++;
      totals[statusOf(id)]++;
    }
    return totals;
  };

  const actionInfo = (ref: string): ActionInfo => {
    const [entityId, actionId] = ref.split('.');
    const entity = catalog[entityId];
    const action = entity?.actions.find((a) => a.id === actionId) ?? null;
    const allowed: ActionInfo['allowed'] = [];
    if (entity) {
      for (const t of entity.transitions) if (isActive(t) && t.action === actionId) allowed.push({ element: t.id, kind: 'transition', by: t.by, from: t.from, to: t.to });
      for (const p of entity.permits) if (isActive(p) && p.action === actionId) allowed.push({ element: p.id, kind: 'permit', by: p.by, states: p.states ?? null });
    }
    let undecided = 0;
    if (entity) for (const v of entity.variants.filter(isActive)) for (const cell of accessMatrix(entity, project, v.id)) if (cell.action === actionId && cell.decision === 'undecided') undecided++;
    return { ref, entity: entityId, action: actionId, title: action?.title ?? actionId, kind: action?.kind ?? null, resolved: !!action, allowed, undecided, totals: totalsOf(byAction.get(ref) ?? []) };
  };

  const storyInfo = (story: Story): StoryInfo => ({
    id: story.id,
    key: story.key,
    title: story.title,
    text: story.text,
    trackerStatus: story.trackerStatus,
    status: story.status,
    acceptance: story.acceptance,
    covers: story.covers.map((ref) => ({ ref, resolved: refResolved(catalog, ref) })),
    scenarios: [...(byStory.get(story.id) ?? [])],
    totals: totalsOf(byStory.get(story.id) ?? []),
  });

  const featureInfo = (feature: Feature): FeatureInfo => {
    const stories = liveStories.filter((s) => s.feature === feature.id).map(storyInfo);
    const scenarioIds = new Set(byFeature.get(feature.id) ?? []);
    for (const story of stories) for (const id of story.scenarios) scenarioIds.add(id);
    return {
      id: feature.id,
      key: feature.key,
      title: feature.title,
      description: feature.description,
      epic: feature.epic,
      status: feature.status,
      actions: feature.actions.map(actionInfo),
      stories,
      scenarios: [...scenarioIds],
      totals: totalsOf(scenarioIds),
    };
  };

  const epicInfo = (epic: Epic): EpicInfo => {
    const features = liveFeatures.filter((f) => f.epic === epic.id).map(featureInfo);
    const stories = liveStories.filter((s) => !s.feature && s.epic === epic.id).map(storyInfo);
    const scenarioIds = new Set<string>();
    for (const f of features) for (const id of f.scenarios) scenarioIds.add(id);
    for (const s of stories) for (const id of s.scenarios) scenarioIds.add(id);
    return { id: epic.id, key: epic.key, title: epic.title, description: epic.description, status: epic.status, features, stories, scenarios: [...scenarioIds], totals: totalsOf(scenarioIds) };
  };

  // “Captured” — reachable through a live epic (directly, or through a live feature); anything else is an orphan.
  const featureCaptured = (f: Feature) => !!f.epic && liveEpicIds.has(f.epic);
  const storyCaptured = (s: Story) => (s.feature ? liveFeatureIds.has(s.feature) : !!s.epic && liveEpicIds.has(s.epic));

  return {
    epics: liveEpics.map(epicInfo),
    orphanFeatures: liveFeatures.filter((f) => !featureCaptured(f)).map(featureInfo),
    orphanStories: liveStories.filter((s) => !storyCaptured(s)).map(storyInfo),
    unmappedStories: liveStories.filter((s) => !s.covers.some((ref) => refResolved(catalog, ref))).map((s) => s.id),
    totals: totalsOf(allScenarios.map(({ scenario }) => scenario.id)),
  };
}

// duplicate ids per list; unknown epic/feature references; feature.actions /
// story.covers that don't resolve — a warning, since onboarding surfaces
// exactly the requirements the model doesn't have yet.
export function validateBacklog(backlog: Backlog, catalog: Catalog): Issue[] {
  const issues: Issue[] = [];
  const warn = (path: string, message: string) => issues.push({ level: 'warning', path, message });

  for (const [kind, list] of [
    ['epics', backlog.epics],
    ['features', backlog.features],
    ['stories', backlog.stories],
  ] as const)
    for (const d of duplicates(list.map((x) => x.id))) warn(`${kind}.${d}`, 'Duplicate id');

  const epicIds = new Set(backlog.epics.map((e) => e.id));
  const featureIds = new Set(backlog.features.map((f) => f.id));

  for (const f of backlog.features) {
    if (f.epic && !epicIds.has(f.epic)) warn(`features.${f.id}`, `Unknown epic “${f.epic}”`);
    for (const ref of f.actions) if (!actionRefResolved(catalog, ref)) warn(`features.${f.id}`, `Action “${ref}” is not in the model yet`);
  }
  for (const s of backlog.stories) {
    if (s.feature && !featureIds.has(s.feature)) warn(`stories.${s.id}`, `Unknown feature “${s.feature}”`);
    if (s.epic && !epicIds.has(s.epic)) warn(`stories.${s.id}`, `Unknown epic “${s.epic}”`);
    for (const ref of s.covers) if (!refResolved(catalog, ref)) warn(`stories.${s.id}`, `“${ref}” is not in the model yet`);
  }
  return issues;
}
