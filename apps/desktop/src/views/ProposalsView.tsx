import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { Backlog, Decision, Entity, Evidence, Op } from '@tc/model';
import { api, fileUrl, type EntityState, type EntitySummary, type ProjectDecideResult, type ProjectState, type ProposalState, type SourceInfo } from '../api.ts';

type Props = {
  project: ProjectState;
  proposals: ProposalState[];
  entities: EntitySummary[];
  dirty: boolean;
  running: boolean;
  onDecided(s: EntityState | ProjectDecideResult): void;
  onError(m: string): void;
  // The proposal to show; the Inbox owns the list.
  selected: string;
  embedded?: boolean;
};

type Verdict = Decision['verdict'];

const emptyEntity = { variants: [], states: [], actions: [], transitions: [], permits: [], scenarios: [], rules: [], invariants: [] } as unknown as Entity;

// Project-level ops (see schema.ts ProjectOpKind) patch the project or the
// backlog instead of one entity's own collections.
const projectKinds = new Set(['role', 'interface', 'entity', 'epic', 'feature', 'story']);
// role/interface/entity have no epistemic status: accept applies the change,
// reject skips it, "observe" is a validation error for them.
const noStatusKinds = new Set(['role', 'interface', 'entity']);

const kindText: Record<string, string> = {
  variant: 'variant', attribute: 'parameter', state: 'state', action: 'action', transition: 'transition', permit: 'permit', scenario: 'scenario', rule: 'business rule', invariant: 'invariant',
  role: 'role', interface: 'interface', entity: 'entity', epic: 'epic', feature: 'feature', story: 'story',
};
const findingText = { gap: 'Gap', contradiction: 'Contradiction', question: 'Question', confirmation: 'Confirmed by a source' };
const verdictText: Record<Verdict, string> = { accept: 'Accepted as a requirement', observe: 'Recorded as an observation', reject: 'Rejected', plan: 'Planned: required, not built yet' };

const fieldText: Record<string, string> = {
  from: 'from', to: 'to', by: 'performed by', action: 'action', kind: 'kind', run: 'run', invoke: 'invoke tool', trigger: 'trigger',
  variants: 'variants', guards: 'guards', effects: 'effects', match: 'probe', state: 'state', states: 'states',
  transition: 'transition', note: 'note', description: 'description', baseUrl: 'base URL', interface: 'interface',
  epic: 'epic', feature: 'feature', key: 'key', url: 'url', trackerStatus: 'tracker status', acceptance: 'acceptance criteria',
  actions: 'actions', covers: 'covers', text: 'text', reader: 'reader', login: 'login',
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

type Described = { verb: string; what: string; detail: string; extra?: ReactNode };

function describe(op: Op, entity: Entity): Described {
  if (op.op === 'add') {
    const v = op.value as Record<string, unknown>;
    const route = op.kind === 'transition' ? ` (${v.from} → ${v.to})` : '';
    const detail = Object.entries(v)
      .filter(([k]) => !['id', 'title', 'from', 'to'].includes(k))
      .map(([k, x]) => `${fieldText[k] ?? k}: ${value(k, x)}`)
      .join('\n');
    return { verb: `Add ${kindText[op.kind]}`, what: `${v.title ?? v.id}${route}`, detail: `id: ${v.id}\n${detail}` };
  }
  const list = entity[({ variant: 'variants', attribute: 'attributes', state: 'states', action: 'actions', transition: 'transitions', permit: 'permits', scenario: 'scenarios', rule: 'rules', invariant: 'invariants' } as const)[op.kind as 'variant' | 'attribute' | 'state' | 'action' | 'transition' | 'permit' | 'scenario' | 'rule' | 'invariant']] as { id: string; title?: string }[];
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

// Project-scope context: what a role/interface/epic/feature/story op refers
// to, so an update can show an old → new diff and a story/feature can name
// the epic or feature it sits under even before that item is decided.
type ProjectCtx = { project: ProjectState; entities: EntitySummary[]; backlog: Backlog | null; opsSoFar: Op[] };

function refTitle(kind: 'epic' | 'feature', id: string | undefined, ctx: ProjectCtx): string | undefined {
  if (!id) return undefined;
  const added = ctx.opsSoFar.find((o) => o.op === 'add' && o.kind === kind && (o.value as { id?: string }).id === id) as
    | Extract<Op, { op: 'add' }>
    | undefined;
  if (added) return String((added.value as { title?: string }).title ?? id);
  const list = kind === 'epic' ? ctx.backlog?.epics : ctx.backlog?.features;
  return list?.find((x) => x.id === id)?.title ?? id;
}

function projectCurrent(kind: string, id: string, ctx: ProjectCtx): Record<string, unknown> | undefined {
  switch (kind) {
    case 'role': return ctx.project.project.roles.find((r) => r.id === id) as Record<string, unknown> | undefined;
    case 'interface': return ctx.project.project.interfaces.find((i) => i.id === id) as Record<string, unknown> | undefined;
    case 'epic': return ctx.backlog?.epics.find((e) => e.id === id) as Record<string, unknown> | undefined;
    case 'feature': return ctx.backlog?.features.find((f) => f.id === id) as Record<string, unknown> | undefined;
    case 'story': return ctx.backlog?.stories.find((s) => s.id === id) as Record<string, unknown> | undefined;
    default: return ctx.entities.find((e) => e.id === id) as unknown as Record<string, unknown> | undefined; // entity — title/description only
  }
}

function describeProject(op: Op, ctx: ProjectCtx): Described {
  const kindLabel = kindText[op.kind] ?? op.kind;

  if (op.op === 'add') {
    const v = op.value as Record<string, unknown>;
    const heading = `${v.key ? `${v.key} ` : ''}${v.title ?? v.id}`;

    if (op.kind === 'story') {
      const feature = v.feature as string | undefined;
      const epic = v.epic as string | undefined;
      const covers = Array.isArray(v.covers) ? (v.covers as string[]) : [];
      const acceptance = Array.isArray(v.acceptance) ? (v.acceptance as string[]) : [];
      const extra = (
        <div className="proposal-story-body">
          <div className="muted">{feature ? `Feature: ${refTitle('feature', feature, ctx)}` : epic ? `Epic: ${refTitle('epic', epic, ctx)}` : 'No feature or epic yet'}</div>
          {(v.text as string) && <p style={{ margin: '6px 0' }}>{v.text as string}</p>}
          {acceptance.length > 0 && <ul className="proposal-list">{acceptance.map((a, i) => <li key={i}>{a}</li>)}</ul>}
          {covers.length > 0 && (
            <div className="chips" style={{ justifyContent: 'start' }}>{covers.map((c) => <span key={c} className="chip ref">{c}</span>)}</div>
          )}
        </div>
      );
      return { verb: `Add ${kindLabel}`, what: heading, detail: '', extra };
    }

    if (op.kind === 'feature') {
      const epic = v.epic as string | undefined;
      const actions = Array.isArray(v.actions) ? (v.actions as string[]) : [];
      const extra = (
        <div className="proposal-story-body">
          {epic && <div className="muted">Epic: {refTitle('epic', epic, ctx)}</div>}
          {(v.description as string) && <p style={{ margin: '6px 0' }}>{v.description as string}</p>}
          {actions.length > 0 && (
            <div className="chips" style={{ justifyContent: 'start' }}>{actions.map((a) => <span key={a} className="chip ref">{a}</span>)}</div>
          )}
        </div>
      );
      return { verb: `Add ${kindLabel}`, what: heading, detail: '', extra };
    }

    // epic / entity / role / interface: a generic, still-readable field list.
    const detail = Object.entries(v)
      .filter(([k]) => !['id', 'title'].includes(k))
      .map(([k, x]) => `${fieldText[k] ?? k}: ${value(k, x)}`)
      .join('\n');
    return { verb: `Add ${kindLabel}`, what: `${v.title ?? v.id}`, detail: `id: ${v.id}\n${detail}` };
  }

  const current = projectCurrent(op.kind, op.id, ctx);
  const title = (current?.title as string | undefined) ?? op.id;

  if (op.op === 'update') {
    const diff = Object.entries(op.set)
      .map(([k, v]) => `${fieldText[k] ?? k}: ${current?.[k] === undefined ? 'all' : value(k, current[k])} → ${value(k, v)}`)
      .join('\n');
    return { verb: `Change ${kindLabel}`, what: title, detail: diff };
  }
  return { verb: `Remove ${kindLabel}`, what: title, detail: '' };
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

// Source evidence quotes the exact text an op is grounded in — shown as a
// blockquote (not a thumbnail) with the source title and, if known, the lines.
function SourceQuote({ e, sourceTitle }: { e: Evidence; sourceTitle: string }) {
  const range = e.path?.match(/#L(\d+)-L(\d+)$/);
  return (
    <figure className="source-quote">
      <blockquote>“{e.summary}”</blockquote>
      <figcaption>
        {sourceTitle}
        {range && <> · lines {range[1]}–{range[2]}</>}
      </figcaption>
    </figure>
  );
}

// One agent proposal: its findings and model changes, each decided on its own.
// A verdict applies at once (no "apply all" step), so a half-decided proposal
// keeps what was decided and the rest stays in the Inbox.
export function ProposalsView(props: Props) {
  const { proposals, project } = props;
  const current = props.selected;
  const [lightbox, setLightbox] = useState<Evidence | null>(null);
  const [busy, setBusy] = useState(false);
  const [sources, setSources] = useState<SourceInfo[]>([]);

  useEffect(() => {
    api.sources().then((r) => setSources(r.sources)).catch(() => setSources([]));
  }, []);

  const p = proposals.find((x) => x.id === current);
  // Update operations are described against the proposal's own entity model
  // (entity-scope) or the current backlog (project-scope).
  const [entity, setEntity] = useState<Entity | null>(null);
  useEffect(() => {
    setEntity(null);
    if (p?.entity) api.entity(p.entity).then((s) => setEntity(s.entity)).catch(() => setEntity(null));
  }, [p?.entity, p?.status]);
  const [backlog, setBacklog] = useState<Backlog | null>(null);
  useEffect(() => {
    setBacklog(null);
    if (p && !p.entity) api.backlog().then((b) => setBacklog(b.backlog)).catch(() => setBacklog(null));
  }, [p?.id, p?.entity]);

  const agents = project.project.agents;
  const sourceTitle = (id?: string) => (id ? (sources.find((s) => s.id === id)?.title ?? id) : '');

  const priorVerdict = (i: number) => p?.decisions.find((x) => x.op === i)?.verdict;
  const apply = async (decisions: Decision[]) => {
    if (!p || !decisions.length) return;
    setBusy(true);
    try {
      props.onDecided(await api.decide(p.id, decisions));
    } catch (e) {
      props.onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const conflictOf = (i: number) => p?.conflicts.find((c) => c.op === i)?.message;
  const evidenceById = (id: string) => p?.evidence.find((e) => e.id === id);
  const missingEntity = p?.entity && !props.entities.some((e) => e.id === p.entity);

  return (
    <div className="proposals embedded">
      <div className="detail">
        {!p && <div className="empty">This proposal is gone.</div>}
        {p && (
          <>
            <h1 style={{ fontSize: 20, margin: 0 }}>{agents.find((a) => a.id === p.agent)?.title ?? p.agent}</h1>
            <div className="muted">
              <span className="id">{p.id}</span>
              {p.entity ? <>, entity: {props.entities.find((e) => e.id === p.entity)?.title ?? p.entity}</> : <>, project-level proposal</>}
              {p.role && <>, role: {project.project.roles.find((r) => r.id === p.role)?.title ?? p.role}</>}
              , {p.entity ? 'model' : 'backlog'} at proposal time: <span className="id">{p.baseRevision}</span>
              {p.stale && p.status === 'pending' && <span style={{ color: 'var(--warn)' }}> — the {p.entity ? 'model' : 'backlog'} has changed since</span>}
            </div>
            <p className="rationale">{p.rationale}</p>

            {missingEntity && (
              <div className="finding">
                <b>Entity “{p.entity}” doesn't exist yet.</b> Accept the project proposal that creates it first, then come back
                to decide this one — every change below can only be rejected until then.
              </div>
            )}

            {p.findings.map((f, i) => (
              <div key={i} className={`finding ${f.kind}`}>
                <b>{findingText[f.kind]}.</b>
                {f.note}
                {f.evidence.length > 0 && <span className="muted"> Evidence: {f.evidence.join(', ')}.</span>}
              </div>
            ))}

            <h3 style={{ margin: '24px 0 10px', fontSize: 14 }}>Model changes</h3>
            {p.ops.map((op, i) => {
              const isProject = projectKinds.has(op.kind);
              const d = isProject ? describeProject(op, { project, entities: props.entities, backlog, opsSoFar: p.ops }) : describe(op, entity ?? emptyEntity);
              const noObserve = noStatusKinds.has(op.kind);
              const decided = priorVerdict(i);
              const open = p.status === 'pending' && !priorVerdict(i);
              const conflict = open ? conflictOf(i) : undefined;
              const sourceEvidence = op.evidence.map((id) => evidenceById(id)).filter((e): e is Evidence => !!e && e.kind === 'source');
              const otherEvidence = op.evidence.map((id) => evidenceById(id)).filter((e): e is Evidence => !!e && e.kind !== 'source');
              return (
                <div key={i} className={`op ${decided ?? ''}`}>
                  <div>
                    <div className="verb">{d.verb}</div>
                    <div className="what">{d.what}</div>
                  </div>
                  <div className="decide">
                    {open ? (
                      <>
                        <button className="btn small" disabled={busy || !!conflict} onClick={() => apply([{ op: i, verdict: 'accept' }])}>
                          {noObserve ? 'Apply' : 'Requirement'}
                        </button>
                        {!noObserve && (
                          <button className="btn small" disabled={busy || !!conflict} onClick={() => apply([{ op: i, verdict: 'observe' }])}>
                            Observed
                          </button>
                        )}
                        {!noObserve && (
                          <button className="btn small" title="Required, but not built yet: no tests until it is" disabled={busy || !!conflict} onClick={() => apply([{ op: i, verdict: 'plan' }])}>
                            Planned
                          </button>
                        )}
                        <button className="btn small ghost" disabled={busy} onClick={() => apply([{ op: i, verdict: 'reject' }])}>
                          Strike out
                        </button>
                      </>
                    ) : (
                      <span className="muted">{decided ? (noObserve && decided === 'accept' ? 'Applied' : verdictText[decided]) : 'No decision'}</span>
                    )}
                  </div>
                  {d.extra}
                  {d.detail && <pre>{d.detail}</pre>}
                  {conflict && <div className="conflict">Conflicts with the current model: {conflict}. This change can only be rejected.</div>}
                  {sourceEvidence.length > 0 && (
                    <div className="source-quotes">
                      {sourceEvidence.map((e) => <SourceQuote key={e.id} e={e} sourceTitle={sourceTitle(e.source)} />)}
                    </div>
                  )}
                  {otherEvidence.length > 0 && (
                    <div className="evidence-row">
                      {otherEvidence.map((e) => <EvidenceThumb key={e.id} e={e} onOpen={() => setLightbox(e)} />)}
                    </div>
                  )}
                </div>
              );
            })}

            {p.status === 'pending' && p.ops.some((_, i) => !priorVerdict(i)) && (
              <div className="decide-bar">
                <button
                  className="btn"
                  disabled={busy || props.dirty}
                  onClick={() => apply(p.ops.flatMap((_, i) => (priorVerdict(i) ? [] : [{ op: i, verdict: conflictOf(i) ? 'reject' : 'accept' } as Decision])))}
                >
                  Accept the rest
                </button>
                <span className="muted">{props.dirty ? 'Save or discard your model edits first.' : 'Each change applies as soon as you decide it. Conflicting changes are struck out.'}</span>
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
              <iframe title={lightbox.id} src={fileUrl(lightbox.path)} style={{ width: 640, height: 420, border: 0, background: 'var(--surface)' }} />
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
