import { useEffect, useState } from 'react';
import type { Decision, Entity, Evidence, Op } from '@tc/model';
import { api, fileUrl, type EntityState, type EntitySummary, type ProjectState, type ProposalState } from '../api.ts';

type Props = {
  project: ProjectState;
  proposals: ProposalState[];
  entities: EntitySummary[];
  dirty: boolean;
  running: boolean;
  onDecided(s: EntityState): void;
  onError(m: string): void;
};

type Verdict = Decision['verdict'];

const emptyEntity = { variants: [], states: [], actions: [], transitions: [], permits: [], scenarios: [], rules: [] } as unknown as Entity;

const kindText = { variant: 'variant', state: 'state', action: 'action', transition: 'transition', permit: 'permit', scenario: 'scenario', rule: 'business rule' };
const findingText = { gap: 'Gap', contradiction: 'Contradiction', question: 'Question' };
const verdictText: Record<Verdict, string> = { accept: 'Accepted as a requirement', observe: 'Recorded as an observation', reject: 'Rejected' };

const fieldText: Record<string, string> = {
  from: 'from', to: 'to', by: 'performed by', action: 'action', kind: 'kind', run: 'run', invoke: 'invoke tool', trigger: 'trigger',
  variants: 'variants', guards: 'guards', effects: 'effects', match: 'probe', state: 'state', states: 'states',
  transition: 'transition', note: 'note', description: 'description',
};

function value(k: string, v: unknown): string {
  if (k === 'effects' && Array.isArray(v))
    return (v as { description: string; field?: string; equals?: unknown }[])
      .map((e) => (e.field ? `${e.description} (${e.field} = ${JSON.stringify(e.equals)})` : e.description))
      .join('; ');
  if (Array.isArray(v)) return v.join(', ');
  if (v && typeof v === 'object') return Object.entries(v).map(([a, b]) => `${a} = ${JSON.stringify(b)}`).join(', ');
  return String(v);
}

function describe(op: Op, entity: Entity): { verb: string; what: string; detail: string } {
  if (op.op === 'add') {
    const v = op.value as Record<string, unknown>;
    const route = op.kind === 'transition' ? ` (${v.from} → ${v.to})` : '';
    const detail = Object.entries(v)
      .filter(([k]) => !['id', 'title', 'from', 'to'].includes(k))
      .map(([k, x]) => `${fieldText[k] ?? k}: ${value(k, x)}`)
      .join('\n');
    return { verb: `Add ${kindText[op.kind]}`, what: `${v.title ?? v.id}${route}`, detail: `id: ${v.id}\n${detail}` };
  }
  const list = entity[({ variant: 'variants', state: 'states', action: 'actions', transition: 'transitions', permit: 'permits', scenario: 'scenarios', rule: 'rules' } as const)[op.kind]] as { id: string; title?: string }[];
  const title = list.find((x) => x.id === op.id)?.title ?? op.id;
  if (op.op === 'update') {
    const current = list.find((x) => x.id === op.id) as Record<string, unknown> | undefined;
    const diff = Object.entries(op.set)
      .map(([k, v]) => `${fieldText[k] ?? k}: ${current?.[k] === undefined ? 'all' : value(k, current[k])} → ${value(k, v)}`)
      .join('\n');
    return { verb: `Change ${kindText[op.kind]}`, what: title, detail: diff };
  }
  return { verb: `Remove ${kindText[op.kind]}`, what: title, detail: '' };
}

function EvidenceThumb({ e, onOpen }: { e: Evidence; onOpen(): void }) {
  return (
    <button className="evidence" onClick={onOpen} title={e.summary}>
      {e.path?.endsWith('.png') ? <img src={fileUrl(e.path)} alt="" loading="lazy" /> : <div style={{ height: 86, padding: 8, fontSize: 11 }} className="id">{e.kind}</div>}
      <span>
        <b>{e.id}</b> {e.summary}
      </span>
    </button>
  );
}

export function ProposalsView(props: Props) {
  const { proposals, project } = props;
  const [current, setCurrent] = useState<string | null>(proposals.find((p) => p.status === 'pending')?.id ?? proposals[0]?.id ?? null);
  const [verdicts, setVerdicts] = useState<Record<number, Verdict>>({});
  const [notes, setNotes] = useState<Record<number, string>>({});
  const [lightbox, setLightbox] = useState<Evidence | null>(null);
  const [agentMode, setAgentMode] = useState<'scripted' | 'live'>(project.project.inference ? 'live' : 'scripted');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setVerdicts({});
    setNotes({});
  }, [current]);
  useEffect(() => {
    if (!proposals.some((p) => p.id === current)) setCurrent(proposals[0]?.id ?? null);
  }, [proposals, current]);

  const p = proposals.find((x) => x.id === current);
  // Update operations are described against the proposal's own entity model.
  const [entity, setEntity] = useState<Entity | null>(null);
  useEffect(() => {
    setEntity(null);
    if (p) api.entity(p.entity).then((s) => setEntity(s.entity)).catch(() => setEntity(null));
  }, [p?.entity, p?.status]);
  const agents = project.project.agents;
  const inference = project.project.inference;

  const startAgent = async (id: string) => {
    try {
      await api.explore(id, agentMode);
    } catch (e) {
      props.onError((e as Error).message);
    }
  };

  const header = (
    <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--rule)' }}>
      <div style={{ fontWeight: 600, marginBottom: 8 }}>Explore an interface</div>
      <label className="field" style={{ marginBottom: 10 }}>
        <span>Who explores</span>
        <select className="text" value={agentMode} onChange={(e) => setAgentMode(e.target.value as 'live' | 'scripted')}>
          {inference && <option value="live">Model {inference.model}</option>}
          <option value="scripted">Recorded script, no model</option>
        </select>
      </label>
      {agents.map((a) => (
        <div key={a.id} className="row" style={{ justifyContent: 'space-between', alignItems: 'start', marginBottom: 8 }}>
          <span title={a.goal} style={{ lineHeight: 1.3, flex: 1 }}>{a.title}</span>
          <button className="btn small" disabled={props.running || (agentMode === 'scripted' && !a.script)} onClick={() => startAgent(a.id)}>
            Run
          </button>
        </div>
      ))}
      {agents.length === 0 && <p className="muted" style={{ margin: 0 }}>Define agents in cartographer.yaml (agents).</p>}
    </div>
  );

  const decide = async () => {
    if (!p) return;
    setBusy(true);
    try {
      const decisions: Decision[] = p.ops.map((_, i) => ({ op: i, verdict: verdicts[i], ...(notes[i] ? { note: notes[i] } : {}) }));
      props.onDecided(await api.decide(p.id, decisions));
    } catch (e) {
      props.onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const decidedCount = p ? p.ops.filter((_, i) => verdicts[i]).length : 0;
  const conflictOf = (i: number) => p?.conflicts.find((c) => c.op === i)?.message;
  const evidenceById = (id: string) => p?.evidence.find((e) => e.id === id);

  return (
    <div className="proposals">
      <div className="list">
        {header}
        {proposals.length === 0 && <p className="muted" style={{ padding: 16 }}>No proposals yet. Run an agent to explore the interface for its role.</p>}
        {proposals.map((x) => (
          <button key={x.id} aria-current={x.id === current} onClick={() => setCurrent(x.id)}>
            <div className="who">{agents.find((a) => a.id === x.agent)?.title ?? x.agent}</div>
            <div className="muted" style={{ fontSize: 12.5 }}>{props.entities.find((e) => e.id === x.entity)?.title ?? x.entity}</div>
            <div className="muted" style={{ fontSize: 12.5 }}>
              {new Date(x.createdAt).toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' })}, changes: {x.ops.length}
              {x.findings.length > 0 && `, findings: ${x.findings.length}`}
            </div>
            <div style={{ fontSize: 12.5, marginTop: 2, color: x.status === 'pending' ? 'var(--proposed)' : 'var(--ink-3)' }}>
              {x.status === 'pending' ? 'Awaiting decision' : 'Decided'}
            </div>
          </button>
        ))}
      </div>

      <div className="detail">
        {!p && <div className="empty">Select a proposal on the left.</div>}
        {p && (
          <>
            <h1 style={{ fontSize: 20, margin: 0 }}>{agents.find((a) => a.id === p.agent)?.title ?? p.agent}</h1>
            <div className="muted">
              <span className="id">{p.id}</span>, role: {project.project.roles.find((r) => r.id === p.role)?.title ?? p.role}, model at exploration time: <span className="id">{p.baseRevision}</span>
              {p.stale && p.status === 'pending' && <span style={{ color: 'var(--observed)' }}> — the model has changed since</span>}
            </div>
            <p className="rationale">{p.rationale}</p>

            {p.findings.map((f, i) => (
              <div key={i} className={`finding ${f.kind}`}>
                <b>{findingText[f.kind]}.</b>
                {f.note}
                {f.evidence.length > 0 && <span className="muted"> Evidence: {f.evidence.join(', ')}.</span>}
              </div>
            ))}

            <h3 style={{ margin: '24px 0 10px', fontSize: 14 }}>Model changes</h3>
            {p.ops.map((op, i) => {
              const d = describe(op, entity ?? emptyEntity);
              const decided = p.status === 'decided' ? p.decisions.find((x) => x.op === i)?.verdict : verdicts[i];
              const conflict = p.status === 'pending' ? conflictOf(i) : undefined;
              return (
                <div key={i} className={`op ${decided ?? ''}`}>
                  <div>
                    <div className="verb">{d.verb}</div>
                    <div className="what">{d.what}</div>
                  </div>
                  <div className="decide">
                    {p.status === 'pending' ? (
                      <>
                        <button className={`btn small accept ${verdicts[i] === 'accept' ? 'on' : ''}`} aria-pressed={verdicts[i] === 'accept'} disabled={!!conflict} onClick={() => setVerdicts({ ...verdicts, [i]: 'accept' })}>
                          Requirement
                        </button>
                        <button className={`btn small observe ${verdicts[i] === 'observe' ? 'on' : ''}`} aria-pressed={verdicts[i] === 'observe'} disabled={!!conflict} onClick={() => setVerdicts({ ...verdicts, [i]: 'observe' })}>
                          Observation
                        </button>
                        <button className={`btn small reject ${verdicts[i] === 'reject' ? 'on' : ''}`} aria-pressed={verdicts[i] === 'reject'} onClick={() => setVerdicts({ ...verdicts, [i]: 'reject' })}>
                          Reject
                        </button>
                      </>
                    ) : (
                      <span className="muted">{decided ? verdictText[decided] : 'No decision'}</span>
                    )}
                  </div>
                  {d.detail && <pre>{d.detail}</pre>}
                  {conflict && <div className="conflict">Conflicts with the current model: {conflict}. This change can only be rejected.</div>}
                  {op.evidence.length > 0 && (
                    <div className="evidence-row">
                      {op.evidence.map((id) => {
                        const e = evidenceById(id);
                        return e ? <EvidenceThumb key={id} e={e} onOpen={() => setLightbox(e)} /> : <span key={id} className="id">{id}?</span>;
                      })}
                    </div>
                  )}
                  {p.status === 'pending' && verdicts[i] && verdicts[i] !== 'accept' && (
                    <input
                      className="text"
                      style={{ gridColumn: '1 / -1' }}
                      placeholder="Why? The note is saved to the element's provenance"
                      value={notes[i] ?? ''}
                      onChange={(e) => setNotes({ ...notes, [i]: e.target.value })}
                    />
                  )}
                </div>
              );
            })}

            {p.status === 'pending' && (
              <div className="decide-bar">
                <button className="btn primary" disabled={busy || decidedCount < p.ops.length || props.dirty} onClick={decide}>
                  Apply decisions to model
                </button>
                <span className="muted">
                  {props.dirty
                    ? 'Save or discard your model edits first.'
                    : decidedCount < p.ops.length
                      ? `${decidedCount} of ${p.ops.length} decided. Decide on every change.`
                      : 'Requirements go into the test plan; observations only into the model.'}
                </span>
                <span className="spacer" />
                <button
                  className="btn small"
                  onClick={() => setVerdicts(Object.fromEntries(p.ops.map((_, i) => [i, conflictOf(i) ? 'reject' : 'accept'])))}
                >
                  Accept all as requirements
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {lightbox && (
        <div className="lightbox" onClick={() => setLightbox(null)} role="dialog" aria-label={lightbox.summary}>
          <figure onClick={(e) => e.stopPropagation()}>
            {lightbox.path?.endsWith('.png') ? (
              <img src={fileUrl(lightbox.path)} alt={lightbox.summary} />
            ) : lightbox.path ? (
              <iframe title={lightbox.id} src={fileUrl(lightbox.path)} style={{ width: 640, height: 420, border: 0, background: 'var(--sheet)' }} />
            ) : (
              <div style={{ padding: 16 }}>{lightbox.url}</div>
            )}
            <figcaption>
              <b>{lightbox.id}</b> {lightbox.summary}
              {lightbox.url && <div className="id">{lightbox.url}</div>}
            </figcaption>
          </figure>
        </div>
      )}
    </div>
  );
}
