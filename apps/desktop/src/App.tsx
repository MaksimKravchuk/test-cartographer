import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Entity } from '@tc/model';
import { api, ApiError, subscribe, type EntityState, type EntitySummary, type Job, type ProjectDecideResult, type ProjectState, type ProposalState } from './api.ts';
import type { Selection } from './graph.ts';
import { MapView } from './views/MapView.tsx';
import { Inspector } from './views/Inspector.tsx';
import { ProposalsView } from './views/ProposalsView.tsx';
import { CoverageView } from './views/CoverageView.tsx';
import { ExportView } from './views/ExportView.tsx';
import { OverviewView } from './views/OverviewView.tsx';
import { ObjectsView } from './views/ObjectsView.tsx';
import { OnboardingView } from './views/OnboardingView.tsx';
import { BacklogView } from './views/BacklogView.tsx';
import { ScenariosView } from './views/ScenariosView.tsx';
import { AgentsView } from './views/AgentsView.tsx';
import { SettingsView } from './views/SettingsView.tsx';
import { ProjectSwitcher } from './views/ProjectSwitcher.tsx';
import { ProjectsView } from './views/ProjectsView.tsx';

type EntityTab = 'map' | 'scenarios' | 'coverage';
type Route =
  | { page: 'overview' }
  | { page: 'objects' }
  | { page: 'entity'; id: string; tab: EntityTab }
  | { page: 'onboarding' }
  | { page: 'backlog' }
  | { page: 'proposals' }
  | { page: 'export' }
  | { page: 'agents' }
  | { page: 'settings' }
  | { page: 'projects' };

const tabTitles: Record<EntityTab, string> = { map: 'Map', scenarios: 'Scenarios', coverage: 'Coverage' };

export function App() {
  const [project, setProject] = useState<ProjectState | null>(null);
  const [entities, setEntities] = useState<EntitySummary[]>([]);
  const [route, setRoute] = useState<Route>({ page: 'overview' });
  const [state, setState] = useState<EntityState | null>(null);
  const [draft, setDraft] = useState<Entity | null>(null);
  const [proposals, setProposals] = useState<ProposalState[]>([]);
  const [selection, setSelection] = useState<Selection>(null);
  const [variant, setVariant] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [job, setJob] = useState<Job | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  // Bumped on every disk change and job completion so views that fetch their
  // own data (Onboarding, Backlog) know to refetch without polling.
  const [reloadToken, setReloadToken] = useState(0);
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);

  const entityId = route.page === 'entity' ? route.id : null;
  const dirty = !!(draft && state && state.entity.id === entityId && JSON.stringify(draft) !== JSON.stringify(state.entity));
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const entityRef = useRef(entityId);
  entityRef.current = entityId;

  const notify = useCallback((text: string, error = false) => {
    setToast({ text, error });
    setTimeout(() => setToast(null), error ? 6000 : 3000);
  }, []);

  const loadEntity = useCallback(async (id: string, keepDraft = false) => {
    const s = await api.entity(id);
    setState(s);
    if (!keepDraft) setDraft(s.entity);
  }, []);

  const reloadAll = useCallback(async () => {
    try {
      const [p, list, props] = await Promise.all([api.project(), api.entities(), api.proposals()]);
      setProject(p);
      setEntities(list);
      setProposals(props);
      const id = entityRef.current;
      if (id && list.some((e) => e.id === id)) await loadEntity(id, dirtyRef.current);
      else if (id) setRoute({ page: 'overview' });
      setFatal(null);
    } catch (e) {
      setFatal((e as Error).message);
    }
  }, [loadEntity]);

  useEffect(() => {
    void reloadAll();
  }, [reloadAll]);

  // Opening another entity loads it and resets the map selection.
  useEffect(() => {
    if (!entityId) return;
    setSelection(null);
    setVariant(null);
    loadEntity(entityId).catch((e) => notify((e as Error).message, true));
  }, [entityId, loadEntity, notify]);

  // Engine events: job log, finished runs and explorations, file edits, project switches.
  useEffect(
    () =>
      subscribe((e) => {
        // Runtime test runs and sign-ins report on their own card on the Agents
        // page, which also stops them — and picks them up again when reopened.
        if ((e.type === 'log' || e.type === 'job') && /^(test|login):/.test(e.job)) return;
        if (e.type === 'log') setLog((l) => [...l.slice(-800), e.line]);
        if (e.type === 'job') {
          setJob({ id: e.job, kind: e.kind, state: e.state, error: e.error });
          if (e.state === 'running') {
            setLog([]);
            setLogOpen(true);
          }
          if (e.state === 'done') {
            notify(
              e.kind === 'run'
                ? 'Run finished'
                : e.kind.startsWith('onboard')
                  ? 'Onboarding finished: proposals ready to review'
                  : 'Exploration finished: new proposal in your inbox',
            );
            void reloadAll();
            setReloadToken((n) => n + 1);
          }
          if (e.state === 'failed') notify(e.error ?? 'Job failed', true);
        }
        if (e.type === 'changed') {
          if (dirtyRef.current) notify(`${e.path} changed on disk. Save or discard your edits.`);
          else void reloadAll();
          setReloadToken((n) => n + 1);
        }
        if (e.type === 'project') {
          setState(null);
          setDraft(null);
          setRoute({ page: 'overview' });
          void reloadAll();
        }
      }),
    [notify, reloadAll],
  );

  const save = async () => {
    if (!draft || !state) return;
    try {
      const s = await api.saveEntity(draft, state.revision);
      setState(s);
      setDraft(s.entity);
      setEntities(await api.entities());
      notify('Model saved');
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) notify('The model changed on disk. Discard your edits to load the new version.', true);
      else notify((e as Error).message, true);
    }
  };

  const run = async (filter: { ids?: string[]; entity?: string } = {}) => {
    try {
      if (dirty) await save();
      await api.run(filter);
    } catch (e) {
      notify((e as Error).message, true);
    }
  };

  const go = (next: Route) => {
    if (dirty && !(next.page === 'entity' && next.id === entityId)) {
      notify('Save or discard your edits to this entity first.', true);
      return;
    }
    setRoute(next);
  };

  const pending = useMemo(() => proposals.filter((p) => p.status === 'pending'), [proposals]);

  if (fatal)
    return (
      <div className="page">
        <h1>Can't reach the engine</h1>
        <p className="lede">Start it with <code>pnpm tc serve</code> and reload the window.</p>
        <div className="error-box">{fatal}</div>
      </div>
    );
  if (!project) return <div className="page muted">Loading project…</div>;

  const running = job?.state === 'running';
  const entityReady = route.page === 'entity' && state && draft && state.entity.id === route.id;
  const showSide = route.page === 'entity' && route.tab === 'map' && !!entityReady;
  const summary = (id: string) => entities.find((e) => e.id === id);

  return (
    <div className={`app ${showSide ? '' : 'no-side'}`}>
      <header className="top">
        <div className="brand">Test Cartographer</div>
        {route.page === 'entity' && (
          <div className="crumbs">
            <button className="btn link" onClick={() => go({ page: 'objects' })}>Objects</button>
            <span className="muted">/</span>
            <strong>{summary(route.id)?.title ?? route.id}</strong>
          </div>
        )}
        <div className="spacer" />
        {dirty && (
          <>
            <span className="muted">Unsaved changes</span>
            <button className="btn" onClick={() => setDraft(state!.entity)}>Discard</button>
            <button className="btn primary" onClick={save}>Save model</button>
          </>
        )}
        <button className="btn" onClick={() => run(route.page === 'entity' ? { entity: route.id } : {})} disabled={running}>
          {running && job?.kind === 'run' ? 'Running…' : route.page === 'entity' ? 'Run entity tests' : 'Run all tests'}
        </button>
      </header>

      <nav className="nav" aria-label="Sections">
        <ProjectSwitcher
          name={project.project.name}
          root={project.root}
          disabled={dirty || running}
          onManage={() => go({ page: 'projects' })}
          onError={(m) => notify(m, true)}
        />
        <div className="nav-scroll">
        <button aria-current={route.page === 'overview' ? 'page' : undefined} onClick={() => go({ page: 'overview' })}>Overview</button>
        <button aria-current={route.page === 'objects' || route.page === 'entity' ? 'page' : undefined} onClick={() => go({ page: 'objects' })}>
          Objects <span className="muted">{entities.length}</span>
        </button>

        <h4>Project</h4>
        <button aria-current={route.page === 'onboarding' ? 'page' : undefined} onClick={() => go({ page: 'onboarding' })}>Onboarding</button>
        <button aria-current={route.page === 'proposals' ? 'page' : undefined} onClick={() => go({ page: 'proposals' })}>
          Proposals {pending.length > 0 && <span className="count">{pending.length}</span>}
        </button>
        <button aria-current={route.page === 'backlog' ? 'page' : undefined} onClick={() => go({ page: 'backlog' })}>Backlog</button>
        <button aria-current={route.page === 'export' ? 'page' : undefined} onClick={() => go({ page: 'export' })}>Export</button>
        <button aria-current={route.page === 'agents' ? 'page' : undefined} onClick={() => go({ page: 'agents' })}>Agents</button>
        <button aria-current={route.page === 'settings' ? 'page' : undefined} onClick={() => go({ page: 'settings' })}>Settings</button>
        </div>
      </nav>

      <main className="main">
        {route.page === 'overview' && (
          <OverviewView
            project={project}
            entities={entities}
            onOpen={(id) => go({ page: 'entity', id, tab: 'map' })}
            onOpenOnboarding={() => go({ page: 'onboarding' })}
            onOpenObjects={() => go({ page: 'objects' })}
          />
        )}

        {route.page === 'objects' && (
          <ObjectsView
            project={project}
            entities={entities}
            onOpen={(id, tab) => go({ page: 'entity', id, tab: tab ?? 'map' })}
            onOpenOnboarding={() => go({ page: 'onboarding' })}
            onCreated={async (id) => {
              setEntities(await api.entities());
              go({ page: 'entity', id, tab: 'map' });
            }}
            onDeleted={async () => setEntities(await api.entities())}
            onChanged={reloadAll}
            onError={(m) => notify(m, true)}
          />
        )}

        {route.page === 'onboarding' && (
          <OnboardingView
            project={project}
            job={job}
            running={running}
            reloadToken={reloadToken}
            onOpenProposals={() => go({ page: 'proposals' })}
            onError={(m) => notify(m, true)}
          />
        )}

        {route.page === 'backlog' && (
          <BacklogView
            project={project}
            entities={entities}
            reloadToken={reloadToken}
            onOpenEntity={(id) => go({ page: 'entity', id, tab: 'map' })}
            onError={(m) => notify(m, true)}
          />
        )}

        {route.page === 'entity' && !entityReady && <div className="page muted">Loading entity…</div>}
        {route.page === 'entity' && entityReady && (
          <div className="entity-page">
            <div className="tabs" role="tablist">
              {(Object.keys(tabTitles) as EntityTab[]).map((tab) => (
                <button key={tab} role="tab" aria-selected={route.tab === tab} onClick={() => setRoute({ ...route, tab })}>
                  {tabTitles[tab]}
                  {tab === 'scenarios' && <span className="muted"> {state!.plan.scenarios.length}</span>}
                  {tab === 'coverage' && <span className="muted"> {state!.coverage.totals.passed}/{state!.coverage.totals.scenarios}</span>}
                </button>
              ))}
              {state!.issues.length > 0 && (
                <span className="tab-note" title={state!.issues.map((i) => `${i.path}: ${i.message}`).join('\n')}>
                  {state!.issues.length} model {state!.issues.length === 1 ? 'issue' : 'issues'}
                </span>
              )}
            </div>
            <div className="tab-body">
              {route.tab === 'map' && (
                <MapView
                  entity={draft!}
                  state={state!}
                  project={project}
                  proposals={pending.filter((p) => p.entity === route.id)}
                  variant={variant}
                  onVariant={setVariant}
                  selection={selection}
                  onSelect={setSelection}
                  onChange={setDraft}
                  onOpenProposal={() => go({ page: 'proposals' })}
                />
              )}
              {route.tab === 'scenarios' && (
                <ScenariosView entity={draft!} state={state!} project={project} running={running} onChange={setDraft} onRun={run} />
              )}
              {route.tab === 'coverage' && <CoverageView state={state!} project={project} running={running} onRun={() => run({ entity: route.id })} />}
            </div>
          </div>
        )}

        {route.page === 'proposals' && (
          <ProposalsView
            project={project}
            proposals={proposals}
            entities={entities}
            dirty={dirty}
            running={running}
            onDecided={async (s: EntityState | ProjectDecideResult) => {
              if ('entity' in s) {
                // Entity-level proposal: the engine returns the updated entity state directly.
                if (state?.entity.id === s.entity.id) {
                  setState(s);
                  setDraft(s.entity);
                }
                setProposals(await api.proposals());
                setEntities(await api.entities());
              } else {
                // Project-level proposal: { project, backlog, created } — refresh the
                // project, the entities list and the backlog (via reloadToken; the
                // Backlog/Onboarding views fetch it themselves). Stay on this page even
                // when entities were created — nothing should navigate unexpectedly.
                await reloadAll();
                setReloadToken((n) => n + 1);
              }
              notify('Decisions applied to the model');
            }}
            onError={(m) => notify(m, true)}
          />
        )}
        {route.page === 'projects' && <ProjectsView disabled={dirty || running} onNotify={(m) => notify(m)} onError={(m) => notify(m, true)} />}
        {route.page === 'export' && <ExportView onError={(m) => notify(m, true)} />}
        {route.page === 'agents' && (
          <AgentsView
            project={project}
            onSaved={async () => {
              await reloadAll();
              notify('Project settings saved');
            }}
            onError={(m) => notify(m, true)}
          />
        )}
        {route.page === 'settings' && (
          <SettingsView
            project={project}
            onSaved={async () => {
              await reloadAll();
              notify('Project settings saved');
            }}
            onError={(m) => notify(m, true)}
          />
        )}
      </main>

      {showSide && (
        <aside className="side" aria-label="Inspector">
          <Inspector
            entity={draft!}
            state={state!}
            project={project}
            proposals={pending.filter((p) => p.entity === entityId)}
            selection={selection}
            onSelect={setSelection}
            onChange={setDraft}
            onOpenProposal={() => go({ page: 'proposals' })}
          />
        </aside>
      )}

      <section className="log">
        <header onClick={() => setLogOpen(!logOpen)}>
          <strong>Log</strong>
          {job && (
            <span className="state">
              {job.kind === 'run' ? 'test run' : job.kind.startsWith('onboard') ? 'onboarding' : job.kind.replace('explore:', 'exploration: ')} —{' '}
              {job.state === 'running' ? 'running' : job.state === 'done' ? 'done' : 'failed'}
            </span>
          )}
          <span className="spacer" />
          {running && (
            <button className="btn small" onClick={(e) => { e.stopPropagation(); void api.cancel(job!.id); }}>
              Stop
            </button>
          )}
          <span className="muted">{logOpen ? 'Collapse' : 'Expand'}</span>
        </header>
        {logOpen && <LogLines lines={log} />}
      </section>

      {toast && <div className={`toast ${toast.error ? 'error' : ''}`} role="status">{toast.text}</div>}
    </div>
  );
}

function LogLines({ lines }: { lines: string[] }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    ref.current?.scrollTo(0, ref.current.scrollHeight);
  }, [lines]);
  return <pre ref={ref}>{lines.length ? lines.join('\n') : 'Output from test runs and agents appears here.'}</pre>;
}
