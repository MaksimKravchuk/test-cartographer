import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Entity } from '@tc/model';
import { resolveRuntime } from '@tc/model/schema';
import { api, ApiError, subscribe, type EntityState, type EntitySummary, type Job, type ProjectDecideResult, type ProjectState, type ProposalState } from './api.ts';
import { InboxView } from './views/InboxView.tsx';
import { CoverageView } from './views/CoverageView.tsx';
import { ExportView } from './views/ExportView.tsx';
import { OverviewView } from './views/OverviewView.tsx';
import { OnboardingView } from './views/OnboardingView.tsx';
import { ModelView } from './views/ModelView.tsx';
import { SpecView } from './views/SpecView.tsx';
import { ScenariosView } from './views/ScenariosView.tsx';
import { AgentsView } from './views/AgentsView.tsx';
import { RunView } from './views/RunView.tsx';
import { SettingsView } from './views/SettingsView.tsx';
import { ProjectSwitcher } from './views/ProjectSwitcher.tsx';
import { ProjectsView } from './views/ProjectsView.tsx';
import { AgentStatus, AskAgent } from './views/Shell.tsx';
import { arrowKeys, Modal, nativeFocusgroup, Toasts, Tip, type ToastMsg } from './ui.tsx';

// Electron draws the macOS traffic lights over the top-left corner of the window.
const isElectron = typeof navigator !== 'undefined' && navigator.userAgent.includes('Electron');

type EntityTab = 'scenarios' | 'coverage';
type Route =
  | { page: 'overview' }
  | { page: 'model' }
  | { page: 'spec' }
  | { page: 'entity'; id: string; tab: EntityTab }
  | { page: 'onboarding' }
  | { page: 'proposals' }
  | { page: 'agents' }
  | { page: 'settings' };

const tabTitles: Record<EntityTab, string> = { scenarios: 'Scenarios', coverage: 'Coverage' };

// Five places along the loop (sources → model ⇄ inbox → spec → tests), plus
// settings. The agent is started from the top bar, wherever you are.
type Place = 'sources' | 'model' | 'inbox' | 'spec' | 'tests' | 'settings';
type Page = Route['page'];
const placeOf: Record<Page, Place> = {
  onboarding: 'sources',
  model: 'model',
  proposals: 'inbox',
  spec: 'spec',
  overview: 'tests', entity: 'tests',
  settings: 'settings', agents: 'settings',
};
const views: Record<Place, { page: Exclude<Page, 'entity'>; title: string }[]> = {
  sources: [{ page: 'onboarding', title: 'Sources' }],
  model: [{ page: 'model', title: 'Model' }],
  inbox: [{ page: 'proposals', title: 'Queue' }],
  spec: [{ page: 'spec', title: 'Specification' }],
  tests: [{ page: 'overview', title: 'All objects' }],
  settings: [{ page: 'settings', title: 'Project' }, { page: 'agents', title: 'Agents' }],
};
const placeTitles: Record<Exclude<Place, 'settings'>, string> = { sources: 'Sources', model: 'Model', inbox: 'Inbox', spec: 'Spec', tests: 'Tests' };

export function App() {
  const [project, setProject] = useState<ProjectState | null>(null);
  const [entities, setEntities] = useState<EntitySummary[]>([]);
  const [route, setRoute] = useState<Route>({ page: 'model' });
  const [state, setState] = useState<EntityState | null>(null);
  const [draft, setDraft] = useState<Entity | null>(null);
  const [proposals, setProposals] = useState<ProposalState[]>([]);
  // Dialogs opened from the top bar: this run's agent settings, the project list, the Markdown export.
  const [dialog, setDialog] = useState<'run' | 'projects' | 'export' | null>(null);
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
  // own data (Onboarding, Spec) know to refetch without polling.
  const [reloadToken, setReloadToken] = useState(0);
  const [toasts, setToasts] = useState<ToastMsg[]>([]);
  const [fatal, setFatal] = useState<string | null>(null);

  const entityId = route.page === 'entity' ? route.id : null;
  const dirty = !!(draft && state && state.entity.id === entityId && JSON.stringify(draft) !== JSON.stringify(state.entity));
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const entityRef = useRef(entityId);
  entityRef.current = entityId;

  // A message replaces an identical one rather than stacking up.
  const notify = useCallback((text: string, error = false) => {
    setToasts((list) => [...list.filter((t) => t.text !== text).slice(-3), { id: Date.now() + Math.random(), text, error }]);
  }, []);
  const dismiss = useCallback((id: number) => setToasts((list) => list.filter((t) => t.id !== id)), []);

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

  // Opening another entity loads it.
  useEffect(() => {
    if (!entityId) return;
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

  const research = async (mode: 'onboard' | 'review' | 'clarify', target?: { proposal: string; index: number }) => {
    if (!project) return;
    try {
      const live = !!resolveRuntime(project.project, project.project.agents.find((a) => a.kind === 'onboard'));
      await api.runOnboarding(live ? 'live' : 'scripted', mode, undefined, target);
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
  const summary = (id: string) => entities.find((e) => e.id === id);
  const place = placeOf[route.page];
  const inbox = pending.length + openFindings;

  return (
    <div className={`app no-side ${isElectron ? 'electron' : ''}`}>
      <header className="top">
        <ProjectSwitcher
          name={project.project.name}
          root={project.root}
          disabled={dirty || running}
          onManage={() => setDialog('projects')}
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
        {!dirty && <AskAgent project={project} running={running} onResearch={research} onSettings={() => setDialog('run')} onError={(m) => notify(m, true)} />}
        <button type="button" className="btn ghost icon" aria-label="Settings" aria-current={place === 'settings' ? 'page' : undefined} onClick={() => go({ page: 'settings' })}><span aria-hidden>⚙</span></button>
      </header>

      {(views[place].length > 1 || place === 'tests') && (
        <nav className="views" aria-label="Views">
          {views[place].map((v) => (
            <button key={v.page} aria-current={route.page === v.page ? 'page' : undefined} onClick={() => go({ page: v.page })}>
              {v.title}
            </button>
          ))}
          {route.page === 'entity' && (
            <span className="crumbs">
              <span className="muted">/</span>
              <strong>{summary(route.id)?.title ?? route.id}</strong>
            </span>
          )}
          <span className="spacer" />
          {place === 'tests' && (
            <>
              <button className="btn small ghost" onClick={() => setDialog('export')}>Export to Markdown</button>
              <button className="btn small" onClick={() => run(route.page === 'entity' ? { entity: route.id } : {})} disabled={running}>
                {running && job?.kind === 'run' ? 'Running…' : route.page === 'entity' ? `Run ${summary(route.id)?.title ?? route.id} tests` : 'Run all tests'}
              </button>
            </>
          )}
        </nav>
      )}
      <main className="main">
        {route.page === 'overview' && (
          <OverviewView
            project={project}
            entities={entities}
            onOpen={(id) => go({ page: 'entity', id, tab: 'scenarios' })}
            onOpenOnboarding={() => go({ page: 'onboarding' })}
            onOpenObjects={() => go({ page: 'model' })}
          />
        )}

        {route.page === 'model' && (
          <ModelView
            project={project}
            proposals={proposals}
            reloadToken={reloadToken}
            onOpenTests={(id) => go({ page: 'entity', id, tab: 'scenarios' })}
            onOpenInbox={() => go({ page: 'proposals' })}
            onChanged={() => void reloadAll()}
            onError={(m) => notify(m, true)}
          />
        )}
        {route.page === 'spec' && <SpecView reloadToken={reloadToken} onError={(m) => notify(m, true)} />}

        {route.page === 'onboarding' && (
          <OnboardingView project={project} reloadToken={reloadToken} onError={(m) => notify(m, true)} />
        )}

        {route.page === 'entity' && !entityReady && <div className="page muted">Loading entity…</div>}
        {route.page === 'entity' && entityReady && (
          <div className="entity-page">
            <div className="tabs">
              {/* Selection follows focus; the arrow keys come from focusgroup, or from arrowKeys where it's missing. */}
              <div
                className="tablist"
                focusgroup="tablist nomemory"
                role="tablist"
                aria-label={`${summary(route.id)?.title ?? route.id} views`}
                onKeyDown={(e) => arrowKeys(e, 'inline')}
              >
                {(Object.keys(tabTitles) as EntityTab[]).map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    id={`tab-${tab}`}
                    role="tab"
                    aria-selected={route.tab === tab}
                    tabIndex={nativeFocusgroup() || route.tab === tab ? undefined : -1}
                    focusgroupstart={route.tab === tab ? '' : undefined}
                    onClick={() => setRoute({ ...route, tab })}
                    onFocus={() => route.tab !== tab && setRoute({ ...route, tab })}
                  >
                    {tabTitles[tab]}
                    {tab === 'scenarios' && <span className="muted"> {state!.plan.scenarios.length}</span>}
                    {tab === 'coverage' && <span className="muted"> {state!.coverage.totals.passed}/{state!.coverage.totals.scenarios}</span>}
                  </button>
                ))}
              </div>
              {state!.issues.length > 0 && (
                <Tip toggle tip={state!.issues.map((i) => `${i.path}: ${i.message}`).join('\n')}>
                  <button type="button" className="tab-note">
                    {state!.issues.length} model {state!.issues.length === 1 ? 'issue' : 'issues'}
                  </button>
                </Tip>
              )}
            </div>
            <div className="tab-body" role="tabpanel" aria-labelledby={`tab-${route.tab}`}>
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
            clarifying={running && job?.kind === 'onboard:clarify'}
            onClarify={(target) => void research('clarify', target)}
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
                // Onboarding view fetches it itself). Stay on this page even
                // when entities were created — nothing should navigate unexpectedly.
                await reloadAll();
                setReloadToken((n) => n + 1);
              }
              notify('Decisions applied to the model');
            }}
            onError={(m) => notify(m, true)}
          />
        )}
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

      {dialog === 'run' && (
        <Modal title="Ask agent" wide onClose={() => setDialog(null)}>
          {(close) => (
            <RunView
              project={project}
              proposals={proposals.filter((p) => !before.has(p.id))}
              job={job}
              startedAt={startedAt}
              log={log}
              onOpenInbox={() => { close(); go({ page: 'proposals' }); }}
              onOpenSettings={() => { close(); go({ page: 'agents' }); }}
              onError={(m) => notify(m, true)}
            />
          )}
        </Modal>
      )}
      {dialog === 'projects' && (
        <Modal title="Projects" wide onClose={() => setDialog(null)}>
          <ProjectsView disabled={dirty || running} onNotify={(m) => notify(m)} onError={(m) => notify(m, true)} />
        </Modal>
      )}
      {dialog === 'export' && (
        <Modal title="Export to Markdown" wide onClose={() => setDialog(null)}>
          <ExportView onError={(m) => notify(m, true)} />
        </Modal>
      )}

      <Toasts list={toasts} onClose={dismiss} />
    </div>
  );
}
