import type { AgentProvider, Backlog, BacklogCoverage, Coverage, Decision, Entity, Field, Issue, Plan, Project, Proposal, ScenarioResult, FileSourceKind, Source, Status, Disagreement, Lint, Resolution, ReviewRow } from '@tc/model';

export type EntityState = {
  entity: Entity;
  revision: string;
  layout: Record<string, { x: number; y: number }>;
  issues: Issue[];
  plan: Plan;
  coverage: Coverage;
  results: Record<string, ScenarioResult>;
  catalog: Record<string, { title: string; states: { id: string; title: string }[]; variants: { id: string; title: string }[] }>;
};

export type ProjectState = {
  root: string;
  project: Project;
  issues: Issue[];
  entities: string[];
  actions: { name: string; description: string; checksAvailability: boolean }[];
  jobs: { id: string; kind: string; state: string }[];
};

export type EntitySummary = {
  id: string;
  title: string;
  description: string;
  counts: { variants: number; states: number; actions: number; transitions: number; permits: number; rules: number; journeys: number; observations: number };
  totals: Coverage['totals'];
  // `title` and `requires` are the related entity's and state's titles.
  relations: { id: string; entity: string; title: string; requires: string | null; kind: 'reference' | 'part-of' }[];
  // The entity this one is part of: its part-of relation, when the target exists
  // and following parents never leads back here. Null for top-level objects.
  parent: string | null;
  // Lifecycle states, rejected ones left out, in model order.
  states: { id: string; title: string; initial: boolean; terminal: boolean; status: Status }[];
  // Subjects: ids of roles named in `by` of the entity's transitions and permits
  // (rejected ones left out), in the project's role order.
  roles: string[];
  // Data people attached to the object for agents and tests (secrets included — the GUI masks them).
  fields: Field[];
  pendingProposals: number;
  errors: number;
};

export type RecentProject = { root: string; name: string; openedAt: string; pinned?: boolean; missing?: boolean };
export type Projects = { current: string; recent: RecentProject[] };

export type ProposalState = Proposal & { stale: boolean; conflicts: { op: number; message: string }[] };

// lines/size only for uploaded files; code and MCP sources have no text of their own.
export type SourceInfo = Source & { lines?: number; size?: number };
export type SourceCheck = { id: string; ok: boolean; detail: string };

export type BacklogState = { backlog: Backlog; revision: string; coverage: BacklogCoverage; issues: Issue[] };

export const runtimeTitle: Record<AgentProvider, string> = { claude: 'Claude Code', codex: 'Codex', copilot: 'GitHub Copilot', cursor: 'Cursor' };

// A coding agent the engine can run agents in, as installed and signed in on this machine.
export type RuntimeStatus = {
  provider: AgentProvider;
  ready: boolean;
  version?: string;
  account?: string;
  plan?: string;
  models: { id: string; title: string }[];
  detail?: string;
};

// A project-level proposal (no `entity`) decides against the project and the
// backlog instead of one entity's model — `created` names any entity ids the
// decision created. An entity-level proposal's decide instead returns the
// updated EntityState (see api.decide below).
export type ProjectDecideResult = { project: Project; backlog: Backlog; created: string[] };

export type Job = { id: string; kind: string; state: 'running' | 'done' | 'failed'; error?: string };

export type EngineEvent =
  | { type: 'log'; job: string; line: string }
  | { type: 'job'; job: string; kind: string; state: 'running' | 'done' | 'failed'; result?: unknown; error?: string }
  | { type: 'changed'; path: string }
  | { type: 'project'; root: string };

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

export const api = {
  project: () => call<ProjectState>('/api/project'),
  saveProject: (project: Project) => call('/api/project', { method: 'PUT', body: JSON.stringify({ project }) }),
  projects: () => call<Projects>('/api/projects'),
  openProject: (root: string) => call<{ root: string }>('/api/projects/open', { method: 'POST', body: JSON.stringify({ root }) }),
  createProject: (root: string, name: string) =>
    call<{ root: string }>('/api/projects/create', { method: 'POST', body: JSON.stringify({ root, name }) }),
  pinProject: (root: string, pinned: boolean) => call('/api/projects/pin', { method: 'POST', body: JSON.stringify({ root, pinned }) }),
  forgetProject: (root: string) => call('/api/projects/forget', { method: 'POST', body: JSON.stringify({ root }) }),
  trashProject: (root: string) => call<{ trashedTo: string }>('/api/projects/trash', { method: 'POST', body: JSON.stringify({ root }) }),
  entities: () => call<EntitySummary[]>('/api/entities'),
  // partOf — id of an existing entity; the new one gets a part-of relation to it.
  createEntity: (input: { id: string; title: string; description?: string; partOf?: string }) =>
    call<EntityState>('/api/entities', { method: 'POST', body: JSON.stringify(input) }),
  deleteEntity: (id: string) => call(`/api/entities/${id}`, { method: 'DELETE' }),
  entity: (id: string) => call<EntityState>(`/api/entities/${id}`),
  saveEntity: (entity: Entity, revision: string) =>
    call<EntityState>(`/api/entities/${entity.id}`, { method: 'PUT', body: JSON.stringify({ entity, revision }) }),
  saveLayout: (id: string, layout: Record<string, { x: number; y: number }>) =>
    call(`/api/entities/${id}/layout`, { method: 'PUT', body: JSON.stringify(layout) }),
  proposals: () => call<ProposalState[]>('/api/proposals'),
  decide: (id: string, decisions: Decision[]) =>
    call<EntityState | ProjectDecideResult>(`/api/proposals/${id}/decide`, { method: 'POST', body: JSON.stringify({ decisions }) }),
  run: (filter: { ids?: string[]; entity?: string } = {}) =>
    call<{ job: string }>('/api/runs', { method: 'POST', body: JSON.stringify(filter) }),
  explore: (agent: string, provider: 'live' | 'scripted') =>
    call<{ job: string }>(`/api/agents/${agent}/explore`, { method: 'POST', body: JSON.stringify({ provider }) }),
  cancel: (job: string) => call(`/api/jobs/${job}/cancel`, { method: 'POST' }),
  exportMarkdown: () => call<{ files: { path: string; content: string }[] }>('/api/export/markdown', { method: 'POST' }),
  sources: () => call<{ sources: SourceInfo[]; usePriority: boolean }>('/api/sources'),
  addSource: (
    input:
      | { name: string; content: string; kind?: FileSourceKind; title?: string }
      | { kind: 'code'; path: string; title?: string }
      | { kind: 'mcp'; read: { tool: string; args: Record<string, unknown> }; title?: string },
  ) => call<Source>('/api/sources', { method: 'POST', body: JSON.stringify(input) }),
  updateSource: (id: string, patch: { title?: string; priority?: number; enabled?: boolean }) =>
    call<Source>(`/api/sources/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  setUsePriority: (usePriority: boolean) => call('/api/sources/settings', { method: 'PUT', body: JSON.stringify({ usePriority }) }),
  checkSources: (id?: string) => call<{ checks: SourceCheck[] }>(`/api/sources/check${id ? `?id=${encodeURIComponent(id)}` : ''}`, { method: 'POST' }),
  sourceText: (id: string) => call<{ source: Source; text: string }>(`/api/sources/${id}`),
  removeSource: (id: string) => call<{ ok: true }>(`/api/sources/${id}`, { method: 'DELETE' }),
  report: () => call<{ disagreements: Disagreement[]; lint: Lint[]; matrix: ReviewRow[]; sources: Source[]; usePriority: boolean }>('/api/report'),
  resolve: (proposal: string, index: number, verdict: Resolution['verdict'] | null, note?: string) =>
    call(`/api/proposals/${proposal}/findings/${index}`, { method: 'POST', body: JSON.stringify({ verdict, note }) }),
  spec: () => call<{ markdown: string }>('/api/spec'),
  exportSpec: () => call<{ file: string }>('/api/spec/export', { method: 'POST' }),
  backlog: () => call<BacklogState>('/api/backlog'),
  saveBacklog: (backlog: Backlog, revision: string) =>
    call<{ revision: string }>('/api/backlog', { method: 'PUT', body: JSON.stringify({ backlog, revision }) }),
  runOnboarding: (provider: 'live' | 'scripted', mode: 'onboard' | 'review' = 'onboard') =>
    call<{ job: string }>('/api/onboarding/run', { method: 'POST', body: JSON.stringify({ provider, mode }) }),
  runtimes: () => call<RuntimeStatus[]>('/api/runtimes'),
  // A short end-to-end run; the job's result is { ok: boolean; seconds: number }.
  testRuntime: (provider: AgentProvider, model?: string) =>
    call<{ job: string }>(`/api/runtimes/${provider}/test`, { method: 'POST', body: JSON.stringify({ model }) }),
  // Opens Cursor's login page in the browser; the job is done once the user has signed in.
  cursorLogin: () => call<{ job: string }>('/api/runtimes/cursor/login', { method: 'POST' }),
};

export const fileUrl = (path: string) => `/api/files/${path.split('/').map(encodeURIComponent).join('/')}`;

// `onOpen` runs each time the stream (re)connects. The engine registers the
// stream before answering, so from then on no event is missed: the moment to
// read state that the events then keep up to date.
export function subscribe(onEvent: (e: EngineEvent) => void, onOpen?: () => void): () => void {
  const source = new EventSource('/api/events');
  source.onmessage = (m) => {
    if (m.data) onEvent(JSON.parse(m.data));
  };
  if (onOpen) source.onopen = onOpen;
  return () => source.close();
}
