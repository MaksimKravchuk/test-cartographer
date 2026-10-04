import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { AgentProvider, AgentSpec, Effort, Project, RuntimeOverride } from '@tc/model';
// schema.ts only: the package index pulls in Node-only workspace.ts (see AccessMatrix.tsx).
import { resolveRuntime } from '@tc/model/schema';
import { api, runtimeTitle, subscribe, type ProjectState, type RuntimeStatus } from '../api.ts';
import { nextId } from '../graph.ts';

type Props = { project: ProjectState; onSaved(): void; onError(m: string): void };

const providers: AgentProvider[] = ['claude', 'codex', 'copilot', 'cursor'];
const providerNote: Record<AgentProvider, string> = {
  claude: "Runs draw from your Claude plan's Agent SDK allowance.",
  codex: "Runs use your ChatGPT plan's Codex limits.",
  copilot: "Runs count against your Copilot plan's requests.",
  cursor: "Runs draw from your Cursor plan's usage, as in the editor. Effort doesn't apply.",
};
const efforts: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

// A test run started from a card: the job id it's tracked by, its streaming
// log, and the outcome once the job leaves the 'running' state.
type TestRun = { jobId: string; log: string[]; done?: { ok: boolean; seconds: number }; error?: string };
// A sign-in in progress (Cursor only): its log carries the login page URL.
type SignIn = { jobId: string; log: string[]; error?: string };

// The cards of one kind (`test` or `login`) lined up with the engine's job list:
// a job still running gets picked up — say one started before this page was
// opened; its earlier log lines are gone — and a card whose job ended while
// the event stream was down lets go of it, since no event will say so now.
// (A SignIn is a TestRun that never has `done`.)
function lineUp(
  cards: Partial<Record<AgentProvider, TestRun>>,
  kind: 'test' | 'login',
  jobs: ProjectState['jobs'],
  ended: Set<string>,
): Partial<Record<AgentProvider, TestRun>> {
  const next = { ...cards };
  for (const p of providers) {
    const card = next[p];
    const live = !!card && !card.done && !card.error;
    const gone = live && jobs.some((j) => j.id === card.jobId && j.state !== 'running');
    if (gone) next[p] = undefined;
    const running = jobs.find((j) => j.kind === `${kind}:${p}` && j.state === 'running' && !ended.has(j.id));
    if (running && (!live || gone)) next[p] = { jobId: running.id, log: [] };
  }
  return next;
}

// Drops empty keys so a runtime override that's been cleared back to nothing
// goes back to `undefined` rather than lingering as `{}`.
function cleanOverride(o: RuntimeOverride | undefined): RuntimeOverride | undefined {
  if (!o) return undefined;
  const kept = Object.entries(o).filter(([, v]) => v !== undefined);
  return kept.length ? (Object.fromEntries(kept) as RuntimeOverride) : undefined;
}

function describeRuntime(r: ReturnType<typeof resolveRuntime>): string {
  if (!r) return 'Scripted only — choose a runtime';
  const parts = [runtimeTitle[r.provider]];
  if (r.model) parts.push(r.model);
  if (r.effort && r.provider !== 'cursor') parts.push(`effort ${r.effort}`);
  parts.push(`${r.maxSteps} steps`);
  return `Runs on ${parts.join(' · ')}`;
}

// Renders `` `text` `` spans (as used in a runtime's `detail`) as <code>.
function withCode(text: string): ReactNode {
  return text.split(/(`[^`]+`)/g).map((part, i) =>
    part.startsWith('`') && part.endsWith('`') ? <code key={i}>{part.slice(1, -1)}</code> : <span key={i}>{part}</span>,
  );
}

// Runtimes agents run inside — Claude Code, Codex, Copilot, Cursor — plus the project
// default and per-agent overrides. No tokens: agents run inside a coding
// agent you're signed in to, so nothing here is billed by Test Cartographer.
export function AgentsView({ project, onSaved, onError }: Props) {
  const [draft, setDraft] = useState<Project>(project.project);
  const [busy, setBusy] = useState(false);
  useEffect(() => setDraft(project.project), [project.project]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(project.project);

  const [runtimes, setRuntimes] = useState<RuntimeStatus[] | null>(null);
  const [checking, setChecking] = useState(false);
  const loadRuntimes = () => {
    setChecking(true);
    api
      .runtimes()
      .then(setRuntimes)
      .catch((e) => onError((e as Error).message))
      .finally(() => setChecking(false));
  };
  useEffect(loadRuntimes, []);

  // Test runs, keyed by provider. Tracked here (rather than the app-wide job)
  // so two cards can each show their own streaming log and outcome. Matched by
  // the engine's job id (`test:<provider>-…`) rather than the id the POST
  // returns: the first log lines can arrive before that response does.
  const [tests, setTests] = useState<Partial<Record<AgentProvider, TestRun>>>({});
  const [signIns, setSignIns] = useState<Partial<Record<AgentProvider, SignIn>>>({});
  // Jobs this page has seen end. A job list fetched around the same moment can
  // still call one of them running; it mustn't bring its card back.
  const ended = useRef(new Set<string>());
  // Each time the event stream (re)opens — every later change then arrives as
  // an event — line the cards up with the engine's jobs.
  const syncJobs = () =>
    api
      .project()
      .then(({ jobs }) => {
        setTests((t) => lineUp(t, 'test', jobs, ended.current));
        setSignIns((s) => lineUp(s, 'login', jobs, ended.current));
      })
      .catch((e) => onError((e as Error).message));
  useEffect(
    () =>
      subscribe((e) => {
        if (e.type !== 'log' && e.type !== 'job') return;
        if (e.type === 'job' && e.state !== 'running') ended.current.add(e.job);
        const login = providers.find((p) => e.job.startsWith(`login:${p}-`));
        if (login) {
          if (e.type === 'job' && e.state === 'done') loadRuntimes();
          setSignIns((prev) => {
            if (e.type === 'job' && e.state === 'running') return { ...prev, [login]: { jobId: e.job, log: [] } };
            const s = prev[login];
            if (!s || s.jobId !== e.job) return prev;
            if (e.type === 'log') return { ...prev, [login]: { ...s, log: [...s.log, e.line] } };
            if (e.state === 'done') return { ...prev, [login]: undefined };
            if (e.state === 'failed') return { ...prev, [login]: { ...s, error: e.error ?? 'Sign-in failed' } };
            return prev;
          });
          return;
        }
        const provider = providers.find((p) => e.job.startsWith(`test:${p}-`));
        if (!provider) return;
        setTests((prev) => {
          if (e.type === 'job' && e.state === 'running') return { ...prev, [provider]: { jobId: e.job, log: [] } };
          const run = prev[provider];
          if (!run || run.jobId !== e.job) return prev;
          if (e.type === 'log') return { ...prev, [provider]: { ...run, log: [...run.log, e.line] } };
          if (e.state === 'running') return prev;
          return {
            ...prev,
            [provider]: e.state === 'done' ? { ...run, done: e.result as { ok: boolean; seconds: number } } : { ...run, error: e.error ?? 'Job failed' },
          };
        });
      }, syncJobs),
    [],
  );

  const stop = (jobId: string) => api.cancel(jobId).catch((e) => onError((e as Error).message));

  const modelsFor = (provider: AgentProvider, current: string | undefined) => {
    const models = runtimes?.find((r) => r.provider === provider)?.models ?? [];
    return current && !models.some((m) => m.id === current) ? [...models, { id: current, title: current }] : models;
  };

  const testRuntime = async (provider: AgentProvider) => {
    const model = draft.runtime?.provider === provider ? draft.runtime.model : undefined;
    try {
      const { job } = await api.testRuntime(provider, model);
      setTests((t) => (t[provider]?.jobId === job ? t : { ...t, [provider]: { jobId: job, log: [] } }));
    } catch (e) {
      onError((e as Error).message);
    }
  };

  const setProvider = (provider: AgentProvider | '') =>
    setDraft({ ...draft, runtime: provider ? { provider, model: undefined, effort: draft.runtime?.effort, maxSteps: draft.runtime?.maxSteps ?? 60 } : undefined });

  const setAgent = (i: number, patch: Partial<AgentSpec>) => setDraft({ ...draft, agents: draft.agents.map((a, n) => (n === i ? { ...a, ...patch } : a)) });

  const setOverrideProvider = (i: number, provider: AgentProvider | '') => {
    const runtime = provider ? { ...draft.agents[i].runtime, provider, model: undefined } : { ...draft.agents[i].runtime, provider: undefined, model: undefined };
    setAgent(i, { runtime: cleanOverride(runtime) });
  };

  const addAgent = (kind: AgentSpec['kind']) => {
    const id = nextId(kind === 'explore' ? 'explorer' : 'onboarding-agent', draft.agents.map((a) => a.id));
    const base: AgentSpec =
      kind === 'explore'
        ? { id, title: 'New explorer', kind, role: draft.roles[0]?.id, entity: project.entities[0], goal: '' }
        : { id, title: 'New onboarding agent', kind, goal: '' };
    setDraft({ ...draft, agents: [...draft.agents, base] });
  };

  const save = async () => {
    setBusy(true);
    try {
      await api.saveProject(draft);
      onSaved();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page settings">
      <h1>Agents</h1>
      <p className="lede">
        Agents run inside a coding agent you're signed in to — Claude Code, Codex, GitHub Copilot or Cursor — instead of calling model APIs with tokens.
        Nothing here is billed per token by Test Cartographer.
      </p>

      <h2>Runtimes</h2>
      <div className="runtime-cards">
        {providers.map((provider) => (
          <RuntimeCard
            key={provider}
            provider={provider}
            status={runtimes?.find((r) => r.provider === provider)}
            checking={checking}
            test={tests[provider]}
            onRecheck={loadRuntimes}
            onTest={() => testRuntime(provider)}
            signIn={signIns[provider]}
            onSignIn={provider === 'cursor' ? () => api.cursorLogin().catch((e) => onError((e as Error).message)) : undefined}
            onStop={stop}
          />
        ))}
      </div>

      <h2>Project default</h2>
      <p className="muted">Used by any agent without its own override. Without one (and no per-agent override) an agent can only run scripted.</p>
      <div className="row" style={{ gap: 16, flexWrap: 'wrap' }}>
        <label className="field" style={{ width: 220 }}>
          <span>Provider</span>
          <select className="text" value={draft.runtime?.provider ?? ''} onChange={(e) => setProvider(e.target.value as AgentProvider | '')}>
            <option value="">None — scripted runs only</option>
            {providers.map((p) => (
              <option key={p} value={p}>{runtimeTitle[p]}</option>
            ))}
          </select>
        </label>
        <label className="field" style={{ width: 220 }}>
          <span>Model</span>
          <select
            className="text"
            disabled={!draft.runtime}
            value={draft.runtime?.model ?? ''}
            onChange={(e) => setDraft({ ...draft, runtime: { ...draft.runtime!, model: e.target.value || undefined } })}
          >
            <option value="">Default</option>
            {draft.runtime && modelsFor(draft.runtime.provider, draft.runtime.model).map((m) => <option key={m.id} value={m.id}>{m.title}</option>)}
          </select>
        </label>
        <label className="field" style={{ width: 160 }}>
          <span>Effort</span>
          <select
            className="text"
            disabled={!draft.runtime}
            value={draft.runtime?.effort ?? ''}
            onChange={(e) => setDraft({ ...draft, runtime: { ...draft.runtime!, effort: (e.target.value || undefined) as Effort | undefined } })}
          >
            <option value="">Default</option>
            {efforts.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </label>
        <label className="field" style={{ width: 140 }}>
          <span>Max steps <span className="muted">(tool calls per run)</span></span>
          <input
            type="number"
            className="text"
            min={1}
            disabled={!draft.runtime}
            value={draft.runtime?.maxSteps ?? 60}
            onChange={(e) => setDraft({ ...draft, runtime: { ...draft.runtime!, maxSteps: Math.max(1, Number(e.target.value) || 1) } })}
          />
        </label>
      </div>

      <h2>Agents</h2>
      {draft.agents.map((a, i) => {
        const effProvider = a.runtime?.provider ?? draft.runtime?.provider;
        return (
          <div key={i} className="agent-card">
            <div className="agent-fields">
              <label className="field">
                <span>ID</span>
                <input className="text id" value={a.id} onChange={(e) => setAgent(i, { id: e.target.value })} />
              </label>
              <label className="field">
                <span>Title</span>
                <input className="text" value={a.title} onChange={(e) => setAgent(i, { title: e.target.value })} />
              </label>
              <label className="field">
                <span>Kind</span>
                <select
                  className="text"
                  value={a.kind}
                  onChange={(e) => {
                    const kind = e.target.value as AgentSpec['kind'];
                    setAgent(i, kind === 'onboard' ? { kind, role: undefined, entity: undefined } : { kind, role: a.role ?? draft.roles[0]?.id, entity: a.entity ?? project.entities[0] });
                  }}
                >
                  <option value="explore">Explore</option>
                  <option value="onboard">Onboard</option>
                </select>
              </label>
              {a.kind === 'explore' && (
                <>
                  <label className="field">
                    <span>Role</span>
                    <select className="text" value={a.role ?? ''} onChange={(e) => setAgent(i, { role: e.target.value || undefined })}>
                      <option value="">— none —</option>
                      {draft.roles.map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}
                    </select>
                  </label>
                  <label className="field">
                    <span>Entity</span>
                    <select className="text" value={a.entity ?? ''} onChange={(e) => setAgent(i, { entity: e.target.value || undefined })}>
                      <option value="">— none —</option>
                      {project.entities.map((id) => <option key={id} value={id}>{id}</option>)}
                    </select>
                  </label>
                </>
              )}
            </div>

            <label className="field">
              <span>Goal</span>
              <textarea className="text" value={a.goal} onChange={(e) => setAgent(i, { goal: e.target.value })} />
            </label>
            <label className="field">
              <span>Script <span className="muted">(for scripted runs)</span></span>
              <input className="text" value={a.script ?? ''} placeholder={`agents/${a.id}.yaml`} onChange={(e) => setAgent(i, { script: e.target.value || undefined })} />
            </label>

            <div className="agent-fields">
              <label className="field">
                <span>Runtime override</span>
                <select className="text" value={a.runtime?.provider ?? ''} onChange={(e) => setOverrideProvider(i, e.target.value as AgentProvider | '')}>
                  <option value="">Project default</option>
                  {providers.map((p) => (
                    <option key={p} value={p}>{runtimeTitle[p]}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Model</span>
                <select
                  className="text"
                  disabled={!effProvider}
                  value={a.runtime?.model ?? ''}
                  onChange={(e) => setAgent(i, { runtime: cleanOverride({ ...a.runtime, model: e.target.value || undefined }) })}
                >
                  <option value="">Default</option>
                  {effProvider && modelsFor(effProvider, a.runtime?.model).map((m) => <option key={m.id} value={m.id}>{m.title}</option>)}
                </select>
              </label>
              <label className="field">
                <span>Effort</span>
                <select
                  className="text"
                  disabled={!effProvider}
                  value={a.runtime?.effort ?? ''}
                  onChange={(e) => setAgent(i, { runtime: cleanOverride({ ...a.runtime, effort: (e.target.value || undefined) as Effort | undefined }) })}
                >
                  <option value="">Default</option>
                  {efforts.map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
              </label>
            </div>

            <p className="muted effective">{describeRuntime(resolveRuntime(draft, a))}</p>

            <div className="row">
              <button className="btn small" onClick={() => setDraft({ ...draft, agents: draft.agents.filter((_, n) => n !== i) })}>Remove</button>
            </div>
          </div>
        );
      })}
      {draft.agents.length === 0 && <p className="muted">No agents yet.</p>}
      <div className="row">
        <button className="btn small" onClick={() => addAgent('explore')}>Add explorer</button>
        <button className="btn small" onClick={() => addAgent('onboard')}>Add onboarding agent</button>
      </div>

      <div className="row" style={{ marginTop: 24 }}>
        <button className="btn primary" disabled={!dirty || busy} onClick={save}>Save settings</button>
        {dirty && <button className="btn" onClick={() => setDraft(project.project)}>Discard</button>}
      </div>
    </div>
  );
}

function RuntimeCard({
  provider,
  status,
  checking,
  test,
  onRecheck,
  onTest,
  signIn,
  onSignIn,
  onStop,
}: {
  provider: AgentProvider;
  status: RuntimeStatus | undefined;
  checking: boolean;
  test: TestRun | undefined;
  onRecheck(): void;
  onTest(): void;
  signIn: SignIn | undefined;
  // Runtimes that sign in from here rather than in their own CLI.
  onSignIn?(): void;
  // Test runs and sign-ins stay off the app-wide job bar, so their card stops them.
  onStop(jobId: string): void;
}) {
  const running = !!test && !test.done && !test.error;
  const signingIn = !!signIn && !signIn.error;
  return (
    <div className="runtime-card">
      <h3>
        {runtimeTitle[provider]}
        {status ? <span className={`flag ${status.ready ? 'ready' : 'notready'}`}>{status.ready ? 'Ready' : 'Not ready'}</span> : <span className="muted">Checking…</span>}
      </h3>
      {status?.account && (
        <p className="account">
          {status.account}{status.plan && ` · ${status.plan}`}{status.version && ` · v${status.version}`}
        </p>
      )}
      {status?.detail && <p className="muted">{withCode(status.detail)}</p>}
      <div className="actions">
        <button className="btn small" disabled={checking} onClick={onRecheck}>Recheck</button>
        {onSignIn && status && !status.ready && (
          <button className="btn small primary" disabled={signingIn} onClick={onSignIn}>
            {signingIn ? 'Waiting for the browser…' : 'Sign in'}
          </button>
        )}
        <button className="btn small" disabled={!status?.ready || checking || running} onClick={onTest}>
          {running ? 'Testing…' : 'Test run'}
        </button>
        {signingIn && <button className="btn small" onClick={() => onStop(signIn.jobId)}>Stop</button>}
        {running && <button className="btn small" onClick={() => onStop(test.jobId)}>Stop</button>}
      </div>
      {signIn && signIn.log.length > 0 && <pre className="runtime-log">{signIn.log.join('\n')}</pre>}
      {signIn?.error && <p className="runtime-result fail">✗ {signIn.error}</p>}
      {test && test.log.length > 0 && <pre className="runtime-log">{test.log.join('\n')}</pre>}
      {test?.done && (
        <p className={`runtime-result ${test.done.ok ? 'ok' : 'fail'}`}>
          {test.done.ok ? '✓' : '✗'} finished in {test.done.seconds.toFixed(1)}s
        </p>
      )}
      {test?.error && <p className="runtime-result fail">✗ {test.error}</p>}
      <p className="note">{providerNote[provider]}</p>
    </div>
  );
}
