import { useEffect, useRef, useState } from 'react';
import { resolveRuntime } from '@tc/model/schema';
import { api, runtimeTitle, type Job, type ProjectState } from '../api.ts';

// The top bar's agent side: one "Ask agent" menu for every way to start an
// agent, a status chip that says what it's doing, and the activity panel the
// chip opens (progress first, the raw log behind a disclosure).

export const jobTitle = (kind: string) =>
  kind === 'run' ? 'test run'
  : kind === 'onboard:review' ? 'review'
  : kind.startsWith('onboard') ? 'onboarding'
  : kind.replace('explore:', 'exploration: ');

function useClickOutside(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);
  return ref;
}

type AskProps = {
  project: ProjectState;
  running: boolean;
  onResearch(mode: 'onboard' | 'review'): void;
  // Opens the Agent place, where a run can be tuned before it starts.
  onSettings(): void;
  onError(m: string): void;
};

export function AskAgent({ project, running, onResearch, onSettings, onError }: AskProps) {
  const [open, setOpen] = useState(false);
  const ref = useClickOutside(open, () => setOpen(false));
  const explorers = (project.project.agents ?? []).filter((a) => (a.kind ?? 'explore') === 'explore');
  const pick = (fn: () => unknown) => () => {
    setOpen(false);
    Promise.resolve(fn()).catch((e) => onError((e as Error).message));
  };
  return (
    <div className="menu-anchor" ref={ref}>
      <button className="btn primary" aria-haspopup="menu" aria-expanded={open} disabled={running} onClick={() => setOpen(!open)}>
        Ask agent <span aria-hidden className="caret">▾</span>
      </button>
      {open && (
        <div className="menu" role="menu" aria-label="Ask agent">
          <button role="menuitem" onClick={pick(() => onResearch('review'))}>
            <b>Review the model</b>
            <small>Check every element against the sources, list contradictions and gaps</small>
          </button>
          <button role="menuitem" onClick={pick(() => onResearch('onboard'))}>
            <b>Research from scratch</b>
            <small>Read the sources and propose subjects, objects, actions and rules</small>
          </button>
          {explorers.length > 0 && <div className="menu-section">Explore the app</div>}
          {explorers.map((a) => (
            <button key={a.id} role="menuitem" onClick={pick(() => api.explore(a.id, resolveRuntime(project.project, a) ? 'live' : 'scripted'))}>
              <b>{a.title}</b>
              <small>Click through the app and propose what it saw</small>
            </button>
          ))}
          <div className="menu-section">Model, effort, subagents</div>
          <button role="menuitem" onClick={pick(onSettings)}>
            <b>Choose how it runs…</b>
            <small>Pick the task and this run’s settings in the Agent tab</small>
          </button>
        </div>
      )}
    </div>
  );
}

function clock(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

type StatusProps = {
  project: ProjectState;
  job: Job | null;
  startedAt: number | null;
  log: string[];
  onStop(): void;
};

// Status chip + activity panel. The chip always says who would run (or what is
// running); the panel opens on click and shows the latest message, how many
// tool calls the agent made, and the raw log.
export function AgentStatus({ project, job, startedAt, log, onStop }: StatusProps) {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(Date.now());
  const ref = useClickOutside(open, () => setOpen(false));
  const running = job?.state === 'running';
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);

  const runtime = resolveRuntime(project.project);
  const who = runtime ? runtimeTitle[runtime.provider] : 'Scripted agents';
  const elapsed = running && startedAt ? clock(now - startedAt) : '';
  const label = !job ? `${who} · ready` : running ? `${jobTitle(job.kind)} · ${elapsed}` : `${jobTitle(job.kind)} — ${job.state === 'done' ? 'done' : 'failed'}`;
  const dot = running ? 'run' : job?.state === 'failed' ? 'bad' : 'ok';

  const said = log.filter((l) => l.startsWith('💬')).map((l) => l.replace(/^💬\s*/, ''));
  const tools = log.filter((l) => l.startsWith('🔧')).length;

  return (
    <div className="menu-anchor" ref={ref}>
      <button className="agent-chip" aria-expanded={open} aria-label={`Agent: ${label}`} onClick={() => setOpen(!open)}>
        <span className={`dot ${dot}`} aria-hidden />
        {label}
      </button>
      {open && (
        <section className="activity" aria-label="Activity">
          <header>
            <span className={`dot ${dot}`} aria-hidden />
            <b>{job ? jobTitle(job.kind) : 'No agent has run yet'}</b>
            <span className="spacer" />
            {running && <button className="btn small" onClick={onStop}>Stop</button>}
          </header>
          {job && (
            <div className="activity-body">
              <p className="muted">
                {who}
                {running ? ` · ${elapsed}` : job.state === 'done' ? ' · finished' : ' · failed'}
                {tools > 0 && ` · ${tools} tool ${tools === 1 ? 'call' : 'calls'}`}
              </p>
              {job.error && <div className="error-box">{job.error}</div>}
              {said.length > 0 && <blockquote className="activity-said">{said[said.length - 1]}</blockquote>}
              <details>
                <summary>Raw log</summary>
                <LogLines lines={log} />
              </details>
            </div>
          )}
        </section>
      )}
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
