import type { AgentProvider, Backlog, BacklogCoverage, Coverage, Decision, Entity, Issue, Plan, Project, Proposal, ScenarioResult, Source, SourceKind } from '@tc/model';

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
  relations: { id: string; entity: string; title: string; requires: string | null }[];
  pendingProposals: number;
  errors: number;
};

export type Projects = { current: string; recent: { root: string; name: string; openedAt: string }[] };

export type ProposalState = Proposal & { stale: boolean; conflicts: { op: number; message: string }[] };

export type SourceInfo = Source & { lines: number; size: number };

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
  entities: () => call<EntitySummary[]>('/api/entities'),
  createEntity: (input: { id: string; title: string; description?: string }) =>
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
  sources: () => call<{ sources: SourceInfo[] }>('/api/sources'),
  addSource: (input: { name: string; content: string; kind?: SourceKind; title?: string }) =>
    call<Source>('/api/sources', { method: 'POST', body: JSON.stringify(input) }),
  sourceText: (id: string) => call<{ source: Source; text: string }>(`/api/sources/${id}`),
  removeSource: (id: string) => call<{ ok: true }>(`/api/sources/${id}`, { method: 'DELETE' }),
  backlog: () => call<BacklogState>('/api/backlog'),
  saveBacklog: (backlog: Backlog, revision: string) =>
    call<{ revision: string }>('/api/backlog', { method: 'PUT', body: JSON.stringify({ backlog, revision }) }),
  runOnboarding: (provider: 'live' | 'scripted') =>
    call<{ job: string }>('/api/onboarding/run', { method: 'POST', body: JSON.stringify({ provider }) }),
  runtimes: () => call<RuntimeStatus[]>('/api/runtimes'),
  // A short end-to-end run; the job's result is { ok: boolean; seconds: number }.
  testRuntime: (provider: AgentProvider, model?: string) =>
    call<{ job: string }>(`/api/runtimes/${provider}/test`, { method: 'POST', body: JSON.stringify({ model }) }),
  // Opens Cursor's login page in the browser; the job is done once the user has signed in.
  cursorLogin: () => call<{ job: string }>('/api/runtimes/cursor/login', { method: 'POST' }),
};

export const fileUrl = (path: string) => `/api/files/${path.split('/').map(encodeURIComponent).join('/')}`;

export function subscribe(onEvent: (e: EngineEvent) => void): () => void {
  const source = new EventSource('/api/events');
  source.onmessage = (m) => {
    if (m.data) onEvent(JSON.parse(m.data));
  };
  return () => source.close();
}
