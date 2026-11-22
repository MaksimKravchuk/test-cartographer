import { useEffect, useRef, useState } from 'react';
import { MenuItem, MenuSection, Popup } from '../ui.tsx';
import { resolveRuntime } from '@tc/model/schema';
import type { PastUsage } from '@tc/model';
import { api, runtimeTitle, type Job, type ProjectState } from '../api.ts';

// The top bar's agent side: one "Ask agent" menu for every way to start an
// agent, a status chip that says what it's doing, and the activity panel the
// chip opens (progress first, the raw log behind a disclosure).

export const jobTitle = (kind: string) =>
  kind === 'run' ? 'test run'
  : kind === 'onboard:review' ? 'review'
  : kind.startsWith('onboard') ? 'onboarding'
  : kind.replace('explore:', 'exploration: ');

export const usd = (n: number) => `$${n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`;
// What a finished run took, shown as what to expect of the task's next one.
export const took = (u: PastUsage) =>
  `${clock((u.seconds ?? 0) * 1000)}${u.costUsd !== undefined ? ` and ≈ ${usd(u.costUsd)} at API prices` : ''}${u.model ? ` on ${u.model}` : ''}`;

type AskProps = {
  project: ProjectState;
  running: boolean;
  onResearch(mode: 'onboard' | 'review'): void;
  // Opens the dialog where a run can be tuned before it starts.
  onSettings(): void;
  onError(m: string): void;
};

export function AskAgent({ project, running, onResearch, onSettings, onError }: AskProps) {
  const explorers = (project.project.agents ?? []).filter((a) => (a.kind ?? 'explore') === 'explore');
  const detail = (text: string, kind: string) => (project.usage[kind] ? `${text}. Last run: ${took(project.usage[kind])}` : text);
  const pick = (fn: () => unknown) => () => Promise.resolve(fn()).catch((e) => onError((e as Error).message));
  return (
    <Popup menu name="Ask agent" className="menu" triggerClass="btn primary" disabled={running} label={<>Ask agent <span aria-hidden className="caret">▾</span></>}>
      <MenuItem title="Review the model" detail={detail('Check every element against the sources, list contradictions and gaps', 'onboard:review')} onSelect={pick(() => onResearch('review'))} />
      <MenuItem title="Research from scratch" detail={detail('Read the sources and propose subjects, objects, actions and rules', 'onboard')} onSelect={pick(() => onResearch('onboard'))} />
      {explorers.length > 0 && <MenuSection>Explore the app</MenuSection>}
      {explorers.map((a) => (
        <MenuItem key={a.id} title={a.title} detail={detail('Click through the app and propose what it saw', `explore:${a.id}`)} onSelect={pick(() => api.explore(a.id, resolveRuntime(project.project, a) ? 'live' : 'scripted'))} />
      ))}
      <MenuSection>Model, effort, subagents</MenuSection>
      <MenuItem title="Choose how it runs…" detail="Pick the task and this run’s model, effort and steps" onSelect={pick(onSettings)} />
    </Popup>
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
  const [now, setNow] = useState(Date.now());
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
    <Popup
      name="Activity"
      className="activity"
      triggerClass="agent-chip"
      triggerLabel={`Agent: ${label}`}
      label={<><span className={`dot ${dot}`} aria-hidden />{label}</>}
    >
      <header>
        <span className={`dot ${dot}`} aria-hidden />
        <b>{job ? jobTitle(job.kind) : 'No agent has run yet'}</b>
        <span className="spacer" />
        {running && <button type="button" className="btn small" onClick={onStop}>Stop</button>}
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
    </Popup>
  );
}

function LogLines({ lines }: { lines: string[] }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    ref.current?.scrollTo(0, ref.current.scrollHeight);
  }, [lines]);
  // Scrolls on its own: focusable and named, so the keyboard can reach and read it.
  return <pre ref={ref} tabIndex={0} role="region" aria-label="Raw log">{lines.length ? lines.join('\n') : 'Output from test runs and agents appears here.'}</pre>;
}
