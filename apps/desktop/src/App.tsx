import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Entity } from '@tc/model';
import { resolveRuntime } from '@tc/model/schema';
import { api, ApiError, subscribe, type EntityState, type EntitySummary, type Job, type ProjectDecideResult, type ProjectState, type ProposalState } from './api.ts';
import type { Selection } from './graph.ts';
import { MapView } from './views/MapView.tsx';
import { Inspector } from './views/Inspector.tsx';
import { InboxView } from './views/InboxView.tsx';
import { CoverageView } from './views/CoverageView.tsx';
import { ExportView } from './views/ExportView.tsx';
import { OverviewView } from './views/OverviewView.tsx';
import { ObjectsView } from './views/ObjectsView.tsx';
import { OnboardingView } from './views/OnboardingView.tsx';
import { ModelView } from './views/ModelView.tsx';
import { ReportView } from './views/ReportView.tsx';
import { SpecView } from './views/SpecView.tsx';
import { BacklogView } from './views/BacklogView.tsx';
import { ScenariosView } from './views/ScenariosView.tsx';
import { AgentsView } from './views/AgentsView.tsx';
import { RunView } from './views/RunView.tsx';
import { SettingsView } from './views/SettingsView.tsx';
import { ProjectSwitcher } from './views/ProjectSwitcher.tsx';
import { ProjectsView } from './views/ProjectsView.tsx';
import { AgentStatus, AskAgent } from './views/Shell.tsx';

// Electron draws the macOS traffic lights over the top-left corner of the window.
const isElectron = typeof navigator !== 'undefined' && navigator.userAgent.includes('Electron');

type EntityTab = 'map' | 'scenarios' | 'coverage';
type Route =
  | { page: 'overview' }
  | { page: 'model' }
  | { page: 'report' }
  | { page: 'spec' }
  | { page: 'objects' }
  | { page: 'entity'; id: string; tab: EntityTab }
  | { page: 'onboarding' }
  | { page: 'backlog' }
  | { page: 'proposals' }
  | { page: 'export' }
  | { page: 'agents' }
  | { page: 'run' }
  | { page: 'settings' }
  | { page: 'projects' };

const tabTitles: Record<EntityTab, string> = { map: 'Map', scenarios: 'Scenarios', coverage: 'Coverage' };

// Five places along the loop (sources → model ⇄ inbox → spec → tests), the
// agent that works the loop with you, plus settings. Each place may hold a few views, switched in its own sub-bar.
type Place = 'sources' | 'model' | 'inbox' | 'spec' | 'tests' | 'agent' | 'settings';
type Page = Route['page'];
const placeOf: Record<Page, Place> = {
  onboarding: 'sources',
  model: 'model', objects: 'model', entity: 'model',
  proposals: 'inbox', report: 'inbox',
  spec: 'spec',
  overview: 'tests', backlog: 'tests', export: 'tests',
  run: 'agent',
  settings: 'settings', agents: 'settings', projects: 'settings',
};
const views: Record<Place, { page: Exclude<Page, 'entity'>; title: string }[]> = {
  sources: [{ page: 'onboarding', title: 'Sources' }],
  model: [{ page: 'model', title: 'Model' }, { page: 'objects', title: 'Map' }],
  inbox: [{ page: 'proposals', title: 'Queue' }, { page: 'report', title: 'By source' }],
  spec: [{ page: 'spec', title: 'Specification' }],
  tests: [{ page: 'overview', title: 'Overview' }, { page: 'backlog', title: 'Backlog' }, { page: 'export', title: 'Export' }],
  agent: [{ page: 'run', title: 'Run' }],
  settings: [{ page: 'settings', title: 'Project' }, { page: 'agents', title: 'Agents' }, { page: 'projects', title: 'Projects' }],
};
const placeTitles: Record<Exclude<Place, 'settings'>, string> = { sources: 'Sources', model: 'Model', inbox: 'Inbox', spec: 'Spec', tests: 'Tests', agent: 'Agent' };

export function App() {
  const [project, setProject] = useState<ProjectState | null>(null);
  const [entities, setEntities] = useState<EntitySummary[]>([]);
  const [route, setRoute] = useState<Route>({ page: 'model' });
  const [state, setState] = useState<EntityState | null>(null);
  const [draft, setDraft] = useState<Entity | null>(null);
  const [proposals, setProposals] = useState<ProposalState[]>([]);
  const [selection, setSelection] = useState<Selection>(null);
  const [variant, setVariant] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [job, setJob] = useState<Job | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  // Proposals that were there when the latest job started: the rest is what it handed in.
  const [before, setBefore] = useState<Set<string>>(new Set());
  const proposalsRef = useRef(proposals);
  proposalsRef.current = proposals;
  // Open questions and contradictions agents left: counted into the Inbox badge.
  const [openFindings, setOpenFindings] = useState(0);
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

  // Accept or strike out agent proposals right on the lifecycle, grouped by proposal.
  const decideOnMap = async (ops: { proposal: string; op: number }[], verdict: 'accept' | 'reject') => {
    if (dirty) return notify('Save or discard your model edits first.', true);
    try {
      let s: EntityState | ProjectDecideResult | null = null;
      for (const id of [...new Set(ops.map((o) => o.proposal))])
        s = await api.decide(id, ops.filter((o) => o.proposal === id).map((o) => ({ op: o.op, verdict })));
      if (s && 'entity' in s && entityRef.current === s.entity.id) {
        setState(s);
        setDraft(s.entity);
      }
      setProposals(await api.proposals());
      notify(verdict === 'accept' ? 'Accepted into the model' : 'Struck out');
    } catch (e) {
      notify((e as Error).message, true);
    }
  };

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
      return;
    }
    api.report().then((r) => setOpenFindings(r.disagreements.filter((d) => !d.resolution).length)).catch(() => {});
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
            setStartedAt(Date.now());
            setBefore(new Set(proposalsRef.current.map((p) => p.id)));
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
          // A proposal an agent records mid-run doesn't touch the draft: reloading keeps it.
          if (dirtyRef.current && !/^proposals[\\/]/.test(e.path)) notify(`${e.path} changed on disk. Save or discard your edits.`);
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

  const research = async (mode: 'onboard' | 'review') => {
    if (!project) return;
    try {
      const live = !!resolveRuntime(project.project, project.project.agents.find((a) => a.kind === 'onboard'));
      await api.runOnboarding(live ? 'live' : 'scripted', mode);
    } catch (e) {
      notify((e as Error).message, true);
    }
  };

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
  const place = placeOf[route.page];
  const inbox = pending.length + openFindings;

  return (
    <div className={`app ${showSide ? '' : 'no-side'} ${isElectron ? 'electron' : ''}`}>
      <header className="top">
        <ProjectSwitcher
          name={project.project.name}
          root={project.root}
          disabled={dirty || running}
          onManage={() => go({ page: 'projects' })}
          onError={(m) => notify(m, true)}
        />
        <nav className="places" aria-label="Sections">
          {(Object.keys(placeTitles) as (keyof typeof placeTitles)[]).map((p) => (
            <button key={p} aria-current={place === p ? 'page' : undefined} onClick={() => go({ page: views[p][0].page })}>
              {placeTitles[p]}
              {p === 'inbox' && inbox > 0 && <span className="count">{inbox}</span>}
            </button>
          ))}
        </nav>
        <div className="spacer" />
        {dirty && (
          <>
            <span className="muted">Unsaved changes</span>
            <button className="btn" onClick={() => setDraft(state!.entity)}>Discard</button>
            <button className="btn primary" onClick={save}>Save model</button>
          </>
        )}
        <AgentStatus project={project} job={job} startedAt={startedAt} log={log} onStop={() => job && void api.cancel(job.id)} />
        {!dirty && <AskAgent project={project} running={running} onResearch={research} onSettings={() => go({ page: 'run' })} onError={(m) => notify(m, true)} />}
        <button className="btn ghost icon" aria-label="Settings" aria-current={place === 'settings' ? 'page' : undefined} title="Settings" onClick={() => go({ page: 'settings' })}>⚙</button>
      </header>

      {views[place].length > 1 && (
        <nav className="views" aria-label="Views">
          {views[place].map((v) => (
            <button key={v.page} aria-current={route.page === v.page || (v.page === 'objects' && route.page === 'entity') ? 'page' : undefined} onClick={() => go({ page: v.page })}>
              {v.title}
              {v.page === 'proposals' && inbox > 0 && <span className="count">{inbox}</span>}
              {v.page === 'objects' && <span className="muted"> {entities.length}</span>}
            </button>
          ))}
          {route.page === 'entity' && (
            <span className="crumbs">
              <span className="muted">/</span>
              <strong>{summary(route.id)?.title ?? route.id}</strong>
            </span>
          )}
          <span className="spacer" />
          {(place === 'tests' || route.page === 'entity') && (
            <button className="btn small" onClick={() => run(route.page === 'entity' ? { entity: route.id } : {})} disabled={running}>
              {running && job?.kind === 'run' ? 'Running…' : route.page === 'entity' ? 'Run entity tests' : 'Run all tests'}
            </button>
          )}
        </nav>
      )}
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

        {route.page === 'model' && (
          <ModelView
            project={project}
            proposals={proposals}
            reloadToken={reloadToken}
            running={running}
            onOpenEntity={(id) => go({ page: 'entity', id, tab: 'map' })}
            onChanged={() => void reloadAll()}
            onError={(m) => notify(m, true)}
          />
        )}
        {route.page === 'run' && (
          <RunView
            project={project}
            proposals={proposals.filter((p) => !before.has(p.id))}
            job={job}
            startedAt={startedAt}
            log={log}
            onOpenInbox={() => go({ page: 'proposals' })}
            onOpenSettings={() => go({ page: 'agents' })}
            onError={(m) => notify(m, true)}
          />
        )}
        {route.page === 'report' && <ReportView proposals={proposals} reloadToken={reloadToken} onError={(m) => notify(m, true)} />}
        {route.page === 'spec' && <SpecView reloadToken={reloadToken} onError={(m) => notify(m, true)} />}

        {route.page === 'onboarding' && (
          <OnboardingView project={project} reloadToken={reloadToken} onError={(m) => notify(m, true)} />
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
                  onDecide={(ops, verdict) => void decideOnMap(ops, verdict)}
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
          <InboxView
            project={project}
            reloadToken={reloadToken}
            onChanged={() => void reloadAll()}
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

      {toast && <div className={`toast ${toast.error ? 'error' : ''}`} role="status">{toast.text}</div>}
    </div>
  );
}
