import { useEffect, useState } from 'react';
import type { AgentProvider, Effort, RuntimeOverride } from '@tc/model';
// schema.ts only: the package index pulls in Node-only workspace.ts (see AccessMatrix.tsx).
import { resolveRuntime, SUBAGENTS } from '@tc/model/schema';
import { api, runtimeTitle, type Job, type ProjectState, type ProposalState, type RuntimeStatus } from '../api.ts';
import { jobTitle } from './Shell.tsx';

// The Agent place: pick a task, tune this run (provider, model, effort,
// subagents, steps), start it, and watch what it hands in as it goes.
// Defaults and agent definitions stay in Settings › Agents.

type Props = {
  project: ProjectState;
  // What the latest job has handed in so far.
  proposals: ProposalState[];
  job: Job | null;
  startedAt: number | null;
  log: string[];
  onOpenInbox(): void;
  onOpenSettings(): void;
  onError(m: string): void;
};

type Task = { id: string; title: string; note: string; agent?: string; start(runtime: RuntimeOverride | undefined): Promise<unknown> };

const providers: AgentProvider[] = ['claude', 'codex', 'copilot', 'cursor'];
const efforts: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export function RunView({ project, proposals, job, startedAt, log, onOpenInbox, onOpenSettings, onError }: Props) {
  const p = project.project;
  const onboarder = p.agents.find((a) => a.kind === 'onboard');
  const tasks: Task[] = [
    {
      id: 'review',
      title: 'Review the model',
      note: 'Check every element against the sources, list contradictions and gaps',
      agent: onboarder?.id,
      start: (r) => api.runOnboarding(r?.provider ? 'live' : 'scripted', 'review', r),
    },
    {
      id: 'onboard',
      title: 'Research from scratch',
      note: 'Read the sources and propose subjects, objects, actions and rules',
      agent: onboarder?.id,
      start: (r) => api.runOnboarding(r?.provider ? 'live' : 'scripted', 'onboard', r),
    },
    ...p.agents
      .filter((a) => a.kind === 'explore')
      .map((a) => ({ id: `explore:${a.id}`, title: a.title, note: 'Click through the app and propose what it saw', agent: a.id, start: (r: RuntimeOverride | undefined) => api.explore(a.id, r?.provider ? 'live' : 'scripted', r) })),
  ];
  const [taskId, setTaskId] = useState('review');
  const task = tasks.find((t) => t.id === taskId) ?? tasks[0];

  // This run's settings start from what the task's agent would run with.
  const defaults = () => resolveRuntime(p, p.agents.find((a) => a.id === task.agent));
  const [settings, setSettings] = useState<RuntimeOverride>(() => ({ ...defaults() }));
  // Keyed by value: the project object is replaced on every reload (say, each batch an agent hands in).
  const base = JSON.stringify(defaults() ?? {});
  useEffect(() => setSettings(JSON.parse(base)), [base]);

  const [runtimes, setRuntimes] = useState<RuntimeStatus[] | null>(null);
  useEffect(() => {
    api.runtimes().then(setRuntimes).catch((e) => onError((e as Error).message));
  }, []);
  const status = runtimes?.find((r) => r.provider === settings.provider);
  const models = status?.models ?? [];
  const modelList = settings.model && !models.some((m) => m.id === settings.model) ? [...models, { id: settings.model, title: settings.model }] : models;

  const running = job?.state === 'running';
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);

  const start = () => task.start(settings.provider ? settings : undefined).catch((e) => onError((e as Error).message));
  const canDelegate = !!settings.provider && SUBAGENTS.includes(settings.provider);

  const found = job ? proposals : [];
  const said = log.filter((l) => l.startsWith('💬')).map((l) => l.replace(/^💬\s*/, ''));
  const tools = log.filter((l) => l.startsWith('🔧')).length;
  const elapsed = running && startedAt ? Math.max(0, Math.floor((now - startedAt) / 1000)) : 0;

  return (
    <div className="page settings run-page">
      <h1>Agent</h1>
      <p className="lede">
        Pick a task and how this run should go. Defaults and the agents themselves live in{' '}
        <button className="btn link" onClick={onOpenSettings}>Settings › Agents</button>.
      </p>

      <h2>Task</h2>
      <div className="run-tasks" role="radiogroup" aria-label="Task">
        {tasks.map((t) => (
          <label key={t.id} className="run-task">
            <input type="radio" name="task" checked={t.id === task.id} disabled={running} onChange={() => setTaskId(t.id)} />
            <span>
              <b>{t.title}</b>
              <small className="muted">{t.note}</small>
            </span>
          </label>
        ))}
      </div>

      <h2>This run</h2>
      <div className="agent-fields">
        <label className="field">
          <span>Provider</span>
          <select
            className="text"
            disabled={running}
            value={settings.provider ?? ''}
            onChange={(e) => {
              const provider = (e.target.value || undefined) as AgentProvider | undefined;
              setSettings({ ...settings, provider, model: undefined, subagents: provider && SUBAGENTS.includes(provider) ? settings.subagents : undefined });
            }}
          >
            <option value="">None — scripted run</option>
            {providers.map((x) => {
              const s = runtimes?.find((r) => r.provider === x);
              return <option key={x} value={x}>{runtimeTitle[x]}{s && !s.ready ? ' (not ready)' : ''}</option>;
            })}
          </select>
        </label>
        <label className="field">
          <span>Model</span>
          <select className="text" disabled={running || !settings.provider} value={settings.model ?? ''} onChange={(e) => setSettings({ ...settings, model: e.target.value || undefined })}>
            <option value="">Default</option>
            {modelList.map((m) => <option key={m.id} value={m.id}>{m.title}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Effort</span>
          <select
            className="text"
            disabled={running || !settings.provider || settings.provider === 'cursor'}
            value={settings.effort ?? ''}
            onChange={(e) => setSettings({ ...settings, effort: (e.target.value || undefined) as Effort | undefined })}
          >
            <option value="">Default</option>
            {efforts.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Max steps <span className="muted">(tool calls)</span></span>
          <input
            type="number"
            className="text"
            min={1}
            disabled={running || !settings.provider}
            value={settings.maxSteps ?? 60}
            onChange={(e) => setSettings({ ...settings, maxSteps: Math.max(1, Number(e.target.value) || 1) })}
          />
        </label>
      </div>
      <label className="run-check">
        <input type="checkbox" disabled={running || !canDelegate} checked={canDelegate && !!settings.subagents} onChange={(e) => setSettings({ ...settings, subagents: e.target.checked || undefined })} />
        <span>
          Let the agent hand parts of the work to subagents
          <small className="muted">
            {canDelegate ? ' They share this run’s tools and step budget.' : ' Claude Code and Codex only: Copilot’s and Cursor’s subagents bring tools of their own.'}
          </small>
        </span>
      </label>
      {status && !status.ready && <p className="field-hint bad">{runtimeTitle[status.provider]} isn’t ready: {status.detail}</p>}

      <div className="row" style={{ marginTop: 'var(--s4)' }}>
        <button className="btn primary" disabled={running} onClick={start}>Start {task.title.toLowerCase()}</button>
        {running && <button className="btn" onClick={() => api.cancel(job!.id).catch((e) => onError((e as Error).message))}>Stop</button>}
      </div>

      {job && (
        <>
          <h2>
            {running ? 'Running' : job.state === 'done' ? 'Last run — done' : 'Last run — failed'}: {jobTitle(job.kind)}
          </h2>
          <p className="muted">
            {running && `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')} · `}
            {tools} tool {tools === 1 ? 'call' : 'calls'} · {found.length} {found.length === 1 ? 'proposal' : 'proposals'} handed in
          </p>
          {job.error && <div className="error-box">{job.error}</div>}
          {said.length > 0 && <blockquote className="activity-said">{said[said.length - 1]}</blockquote>}
          {found.length > 0 && (
            <table className="grid run-found">
              <thead>
                <tr><th>Handed in</th><th>For</th><th>Changes</th><th>Findings</th><th /></tr>
              </thead>
              <tbody>
                {found.map((x) => (
                  <tr key={x.id}>
                    <td className="id">{new Date(x.createdAt).toLocaleTimeString()}</td>
                    <td>{x.entity ?? 'Project'}</td>
                    <td>{x.ops.length}</td>
                    <td>{x.findings.length}</td>
                    <td><button className="btn small" onClick={onOpenInbox}>Review in Inbox</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {running && found.length === 0 && <p className="muted">Nothing handed in yet. What the agent records shows up here and in the Inbox right away.</p>}
          <details>
            <summary>Raw log</summary>
            <pre className="runtime-log">{log.join('\n') || 'No output yet.'}</pre>
          </details>
        </>
      )}
    </div>
  );
}
