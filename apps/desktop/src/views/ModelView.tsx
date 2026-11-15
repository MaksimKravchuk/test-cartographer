import { useEffect, useState, type ReactNode } from 'react';
import type { Action, Decision, Disagreement, Entity, Lint, Op, Role, Rule } from '@tc/model';
import { api, type EntityState, type ProjectState, type ProposalState } from '../api.ts';

// The model as a person thinks about it: who acts (subjects), on what
// (objects), with which actions, under which rules. What an agent found but
// nobody has decided yet sits in place with ✓ / ≈ / ✕, so reviewing is part of
// reading the model rather than a separate inbox.

type Props = {
  project: ProjectState;
  proposals: ProposalState[];
  reloadToken: number;
  running: boolean;
  onResearch(mode: 'onboard' | 'review'): void;
  onOpenEntity(id: string): void;
  onChanged(): void;
  onError(m: string): void;
};

type Pending = { proposal: ProposalState; index: number; op: Extract<Op, { op: 'add' }> };
type Verdict = Decision['verdict'];

const slug = (title: string, prefix: string, taken: string[]) => {
  const base = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  let id = /^[a-z]/.test(base) ? base : prefix;
  for (let n = 2; taken.includes(id) || (id === prefix && !base); n++) id = `${prefix}-${n}`;
  return id;
};

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const roleIds = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

// Who performs an action: declared on the action, plus every transition and permit using it.
export function actorsOf(entity: Entity, action: Action): string[] {
  const by = new Set(action.by ?? []);
  for (const t of entity.transitions) if (t.action === action.id && t.status !== 'rejected') t.by.forEach((r) => by.add(r));
  for (const p of entity.permits) if (p.action === action.id && p.status !== 'rejected') p.by.forEach((r) => by.add(r));
  return [...by];
}

// Rules of an action: tied to it directly or through one of its transitions.
export function rulesOf(entity: Entity, action: string): Rule[] {
  const transitions = new Set(entity.transitions.filter((t) => t.action === action).map((t) => t.id));
  return entity.rules.filter((r) => r.action === action || (r.transition && transitions.has(r.transition)));
}

function Decide({ busy, noObserve, onDecide }: { busy: boolean; noObserve?: boolean; onDecide(v: Verdict): void }) {
  return (
    <span className="row" style={{ gap: 4, marginLeft: 'auto' }}>
      <button className="btn small" title="True: make it part of the model" disabled={busy} onClick={() => onDecide('accept')}>✓</button>
      {!noObserve && <button className="btn small" title="That's how it works, but it isn't a requirement" disabled={busy} onClick={() => onDecide('observe')}>≈</button>}
      <button className="btn small" title="Strike out: agents won't propose it again" disabled={busy} onClick={() => onDecide('reject')}>✕</button>
    </span>
  );
}

type Queue = { gaps: Lint[]; questions: Disagreement[]; contradictions: Disagreement[] };

// What to do next: gaps the model checks find on their own, questions agents left
// open, and contradictions between sources. A person settles each one or asks an agent.
function NextQueue({ queue, busy, onOpen, onSettle }: { queue: Queue; busy: boolean; onOpen(ref: string): void; onSettle(d: Disagreement): void }) {
  const total = queue.gaps.length + queue.questions.length + queue.contradictions.length;
  if (!total) return null;
  const link = (ref: string, text: string) => (
    <a href="#" onClick={(e) => { e.preventDefault(); onOpen(ref); }}>{text}</a>
  );
  const group = (title: string, items: ReactNode[]) =>
    items.length > 0 && (
      <details open={items.length <= 5}>
        <summary><b>{items.length}</b> {title}</summary>
        <ul style={{ margin: '4px 0 8px' }}>{items}</ul>
      </details>
    );
  const finding = (d: Disagreement, settle: boolean) => (
    <li key={`${d.proposal}-${d.index}`}>
      {d.finding.refs[0] ? link(d.finding.refs[0], d.finding.note) : d.finding.note}
      {settle && <> <button className="btn small" disabled={busy} title="Answered: take it off the list" onClick={() => onSettle(d)}>Done</button></>}
    </li>
  );
  return (
    <section aria-label="What to do next">
      <h2>What to do next</h2>
      {group('gaps in the model', queue.gaps.map((l, i) => <li key={i}>{link(l.ref, l.message)}</li>))}
      {group('open questions', queue.questions.map((d) => finding(d, true)))}
      {group('contradictions between sources (settle them on the Disagreements page)', queue.contradictions.map((d) => finding(d, false)))}
      <p className="muted" style={{ margin: 0 }}>Answer a question here, or press “Review the model” to have an agent look into all of them.</p>
    </section>
  );
}

const sugg = { border: '1px dashed var(--proposed)', background: 'var(--proposed-wash)' };

export function ModelView({ project, proposals, reloadToken, running, onResearch, onOpenEntity, onChanged, onError }: Props) {
  const [states, setStates] = useState<Record<string, EntityState>>({});
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<{ entity: string; action: string } | null>(null);
  const [newRole, setNewRole] = useState({ title: '', kind: 'human' as Role['kind'] });
  const [newEntity, setNewEntity] = useState('');
  const [adding, setAdding] = useState<{ role: string; entity: string; title: string } | null>(null);
  const [ruleText, setRuleText] = useState('');
  const [queue, setQueue] = useState<Queue>({ gaps: [], questions: [], contradictions: [] });

  const roles = project.project.roles;
  const ids = project.entities;
  useEffect(() => {
    Promise.all(ids.map((id) => api.entity(id)))
      .then((list) => setStates(Object.fromEntries(list.map((s) => [s.entity.id, s]))))
      .catch((e) => onError((e as Error).message));
  }, [ids.join(), reloadToken]);
  useEffect(() => {
    api.report()
      .then((r) => {
        const open = r.disagreements.filter((d) => !d.resolution);
        setQueue({ gaps: r.lint, questions: open.filter((d) => d.finding.kind !== 'contradiction'), contradictions: open.filter((d) => d.finding.kind === 'contradiction') });
      })
      .catch((e) => onError((e as Error).message));
  }, [reloadToken, proposals]);

  // "action:order.cancel" → select that action; a rule or transition → its action; anything else → the object's page.
  const openRef = (ref: string) => {
    const m = /^(\w+):([\w-]+)\.([\w-]+)$/.exec(ref);
    const e = m && states[m[2]]?.entity;
    if (!m || !e) return;
    const [, kind, entity, id] = m;
    const action =
      kind === 'action' ? id
      : kind === 'rule' ? (e.rules.find((r) => r.id === id)?.action ?? e.transitions.find((t) => t.id === e.rules.find((r) => r.id === id)?.transition)?.action)
      : kind === 'transition' ? e.transitions.find((t) => t.id === id)?.action
      : kind === 'permit' ? e.permits.find((t) => t.id === id)?.action
      : undefined;
    if (action) setSelected({ entity, action });
    else onOpenEntity(entity);
  };

  const pending = proposals.filter((p) => p.status === 'pending');
  const open = (p: ProposalState, i: number) => !p.decisions.some((d) => d.op === i);
  const adds = (filter: (p: ProposalState, op: Pending['op']) => boolean): Pending[] =>
    pending.flatMap((proposal) =>
      proposal.ops.flatMap((op, index) => (op.op === 'add' && open(proposal, index) && filter(proposal, op) ? [{ proposal, index, op }] : [])),
    );
  const pendingRoles = adds((p, op) => !p.entity && op.kind === 'role');
  const pendingEntities = adds((p, op) => !p.entity && op.kind === 'entity');
  const otherOpen = pending.reduce((n, p) => n + p.ops.filter((op, i) => open(p, i) && !(op.op === 'add' && ['role', 'entity', 'action', 'rule'].includes(op.kind))).length, 0);

  const act = async (f: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await f();
      onChanged();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const decide = (x: Pending, verdict: Verdict) => act(() => api.decide(x.proposal.id, [{ op: x.index, verdict }]));
  const saveEntity = (entity: Entity) => act(() => api.saveEntity(entity, states[entity.id].revision));

  const addRole = () =>
    act(async () => {
      const p = structuredClone(project.project);
      const id = slug(newRole.title, 'role', p.roles.map((r) => r.id));
      p.roles.push({ id, title: newRole.title.trim(), kind: newRole.kind, interface: newRole.kind === 'human' ? p.interfaces[0]?.id : undefined, fields: [] });
      await api.saveProject(p);
      setNewRole({ title: '', kind: 'human' });
    });
  const addEntity = () =>
    act(async () => {
      await api.createEntity({ id: slug(newEntity, 'object', ids), title: newEntity.trim() });
      setNewEntity('');
    });
  const addAction = () =>
    act(async () => {
      if (!adding) return;
      const entity = structuredClone(states[adding.entity].entity);
      const title = adding.title.trim();
      const existing = entity.actions.find((a) => a.title.toLowerCase() === title.toLowerCase());
      if (existing) existing.by = [...new Set([...(existing.by ?? []), adding.role])];
      else
        entity.actions.push({
          id: slug(title, 'action', entity.actions.map((a) => a.id)),
          title,
          kind: 'command',
          by: [adding.role],
          status: 'confirmed',
          provenance: { source: 'human', evidence: [], sources: [] },
        });
      await api.saveEntity(entity, states[adding.entity].revision);
      setAdding(null);
    });

  // Pending actions per entity, with the roles the proposal gives them.
  const pendingActions = (entity: string) => {
    const props = pending.filter((p) => p.entity === entity);
    return props.flatMap((proposal) =>
      proposal.ops.flatMap((op, index) => {
        if (op.op !== 'add' || op.kind !== 'action' || !open(proposal, index)) return [];
        const id = str(op.value.id);
        const by = new Set(roleIds(op.value.by));
        for (const o of proposal.ops) if (o.op === 'add' && (o.kind === 'transition' || o.kind === 'permit') && o.value.action === id) roleIds(o.value.by).forEach((r) => by.add(r));
        return [{ proposal, index, op, by: [...by], blocked: !ids.includes(entity) }];
      }),
    );
  };

  const cell = (role: string, entityId: string) => {
    const s = states[entityId];
    if (!s) return null;
    const mine = s.entity.actions.filter((a) => actorsOf(s.entity, a).includes(role));
    const sugg_ = pendingActions(entityId).filter((x) => x.by.includes(role));
    const isAdding = adding?.role === role && adding.entity === entityId;
    return (
      <td key={entityId} style={{ verticalAlign: 'top', minWidth: 150 }}>
        <div className="chips">
          {mine.map((a) => {
            const conflicts = pending.some((p) => p.entity === entityId && p.findings.some((f) => f.kind === 'contradiction' && f.refs.some((r) => r.endsWith(`.${a.id}`))));
            const on = selected?.entity === entityId && selected.action === a.id;
            return (
              <button
                key={a.id}
                className={`chip ${on ? 'on' : ''}`}
                style={{ textDecoration: a.status === 'rejected' ? 'line-through' : undefined, outline: on ? '2px solid var(--focus)' : undefined, fontStyle: a.status === 'observed' ? 'italic' : undefined }}
                title={a.status}
                onClick={() => setSelected({ entity: entityId, action: a.id })}
              >
                {a.title}
                {rulesOf(s.entity, a.id).length > 0 && <span className="muted"> · {rulesOf(s.entity, a.id).length}</span>}
                {conflicts && <span style={{ color: 'var(--fail)' }}> !</span>}
              </button>
            );
          })}
          {sugg_.map((x) => (
            <span key={`${x.proposal.id}-${x.index}`} className="chip" style={{ ...sugg, display: 'inline-flex', gap: 4, alignItems: 'center' }} title={x.proposal.rationale}>
              {str(x.op.value.title) || str(x.op.value.id)}
              <button className="btn small" disabled={busy} onClick={() => decide(x, 'accept')}>✓</button>
              <button className="btn small" disabled={busy} onClick={() => decide(x, 'reject')}>✕</button>
            </span>
          ))}
        </div>
        {isAdding ? (
          <div className="row" style={{ gap: 4, marginTop: 4 }}>
            <input className="text" autoFocus value={adding.title} placeholder="cancel" onChange={(e) => setAdding({ ...adding, title: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && adding.title.trim() && addAction()} />
            <button className="btn small" disabled={busy || !adding.title.trim()} onClick={addAction}>Add</button>
          </div>
        ) : (
          <button className="btn small" style={{ marginTop: 4, borderStyle: 'dashed' }} onClick={() => setAdding({ role, entity: entityId, title: '' })}>+ action</button>
        )}
      </td>
    );
  };

  // Actions nobody performs yet (no `by`, no transition or permit): a row of their own.
  const unassigned = (entityId: string) => {
    const s = states[entityId];
    if (!s) return [];
    return s.entity.actions.filter((a) => actorsOf(s.entity, a).length === 0);
  };
  const anyUnassigned = ids.some((id) => unassigned(id).length || pendingActions(id).some((x) => x.by.length === 0));

  const sel = selected && states[selected.entity];
  const selAction = sel?.entity.actions.find((a) => a.id === selected!.action);
  const pendingRules = selected
    ? pending
        .filter((p) => p.entity === selected.entity)
        .flatMap((proposal) =>
          proposal.ops.flatMap((op, index) => {
            if (op.op !== 'add' || op.kind !== 'rule' || !open(proposal, index)) return [];
            const t = sel?.entity.transitions.find((x) => x.id === op.value.transition);
            const belongs = op.value.action === selected.action || t?.action === selected.action;
            return belongs ? [{ proposal, index, op }] : [];
          }),
        )
    : [];
  const quotes = (p: ProposalState, evidence: string[]) =>
    evidence.map((id) => p.evidence.find((e) => e.id === id)).filter((e) => !!e && e.kind === 'source');
  const contradictions = selected
    ? pending.filter((p) => p.entity === selected.entity).flatMap((p) => p.findings.filter((f) => f.refs.some((r) => r.endsWith(`.${selected.action}`))).map((f) => ({ p, f })))
    : [];

  const addRule = () =>
    act(async () => {
      if (!sel || !selAction) return;
      const entity = structuredClone(sel.entity);
      const text = ruleText.trim();
      entity.rules.push({
        id: slug(text, 'rule', entity.rules.map((r) => r.id)),
        title: text.length > 60 ? `${text.slice(0, 57)}…` : text,
        text,
        action: selAction.id,
        requires: [],
        status: 'confirmed',
        provenance: { source: 'human', evidence: [], sources: [] },
      });
      await api.saveEntity(entity, sel.revision);
      setRuleText('');
    });
  const setRuleStatus = (rule: Rule, status: Rule['status']) => {
    if (!sel) return;
    const entity = structuredClone(sel.entity);
    entity.rules = entity.rules.map((r) => (r.id === rule.id ? { ...r, status } : r));
    void saveEntity(entity);
  };

  return (
    <div className="page">
      <div className="row">
        <h1 style={{ margin: 0 }}>Model</h1>
        <span className="spacer" />
        <button className="btn" disabled={running} onClick={() => onResearch('onboard')} title="Agents read every enabled source and propose subjects, objects, actions and rules">
          Run first research
        </button>
        <button className="btn primary" disabled={running} onClick={() => onResearch('review')} title="Agents check the model you have against the sources: confirmations, contradictions, and what's missing">
          Review the model
        </button>
      </div>
      <p className="lede">
        Who acts, on what, and under which rules. Write what you know; agents check it against the sources and add what they find.
        Their findings appear here with a dashed border: ✓ true, ≈ that's how it works but not a requirement, ✕ strike out.
        {otherOpen > 0 && <> {otherOpen} more findings (states, transitions, backlog) are on the Proposals page.</>}
      </p>

      <NextQueue queue={queue} busy={busy} onOpen={openRef} onSettle={(d) => act(() => api.resolve(d.proposal, d.index, 'fine'))} />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16 }}>
        <section>
          <h2>Subjects</h2>
          {roles.map((r) => (
            <div key={r.id} className="row" style={{ padding: '4px 0' }}>
              {r.title} <span className="muted">{r.kind === 'system' ? 'background jobs' : 'person'}</span>
            </div>
          ))}
          {pendingRoles.map((x) => (
            <div key={`${x.proposal.id}-${x.index}`} className="row" style={{ ...sugg, padding: '4px 8px', borderRadius: 6, marginTop: 4 }}>
              {str(x.op.value.title) || str(x.op.value.id)} <span className="muted">agent</span>
              <Decide busy={busy} noObserve onDecide={(v) => decide(x, v)} />
            </div>
          ))}
          <div className="row" style={{ gap: 4, marginTop: 8 }}>
            <input className="text" value={newRole.title} placeholder="Seller" onChange={(e) => setNewRole({ ...newRole, title: e.target.value })} />
            <select className="text" value={newRole.kind} onChange={(e) => setNewRole({ ...newRole, kind: e.target.value as Role['kind'] })}>
              <option value="human">person</option>
              <option value="system">background jobs</option>
            </select>
            <button className="btn small" disabled={busy || !newRole.title.trim()} onClick={addRole}>Add</button>
          </div>
        </section>
        <section>
          <h2>Objects</h2>
          {ids.map((id) => (
            <div key={id} className="row" style={{ padding: '4px 0' }}>
              <a href="#" onClick={(e) => { e.preventDefault(); onOpenEntity(id); }}>{states[id]?.entity.title ?? id}</a>
              {states[id] && !states[id].entity.reader && <span className="muted">no reader yet</span>}
            </div>
          ))}
          {pendingEntities.map((x) => (
            <div key={`${x.proposal.id}-${x.index}`} className="row" style={{ ...sugg, padding: '4px 8px', borderRadius: 6, marginTop: 4 }}>
              {str(x.op.value.title) || str(x.op.value.id)} <span className="muted">agent</span>
              <Decide busy={busy} noObserve onDecide={(v) => decide(x, v)} />
            </div>
          ))}
          <div className="row" style={{ gap: 4, marginTop: 8 }}>
            <input className="text" value={newEntity} placeholder="Order" onChange={(e) => setNewEntity(e.target.value)} />
            <button className="btn small" disabled={busy || !newEntity.trim()} onClick={addEntity}>Add</button>
          </div>
        </section>
      </div>

      <section>
        <h2>Actions</h2>
        <div style={{ overflowX: 'auto' }}>
          <table className="grid">
            <thead>
              <tr><th />{ids.map((id) => <th key={id}>{states[id]?.entity.title ?? id}</th>)}</tr>
            </thead>
            <tbody>
              {roles.map((r) => (
                <tr key={r.id}><th style={{ textAlign: 'left' }}>{r.title}</th>{ids.map((id) => cell(r.id, id))}</tr>
              ))}
              {anyUnassigned && (
                <tr>
                  <th style={{ textAlign: 'left' }} className="muted">Nobody yet</th>
                  {ids.map((id) => (
                    <td key={id}>
                      <div className="chips">
                        {unassigned(id).map((a) => (
                          <button key={a.id} className="chip" onClick={() => setSelected({ entity: id, action: a.id })}>{a.title}</button>
                        ))}
                        {pendingActions(id).filter((x) => x.by.length === 0).map((x) => (
                          <span key={`${x.proposal.id}-${x.index}`} className="chip" style={{ ...sugg, display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                            {str(x.op.value.title) || str(x.op.value.id)}
                            <button className="btn small" disabled={busy} onClick={() => decide(x, 'accept')}>✓</button>
                            <button className="btn small" disabled={busy} onClick={() => decide(x, 'reject')}>✕</button>
                          </span>
                        ))}
                      </div>
                    </td>
                  ))}
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {sel && selAction && (
        <section>
          <div className="row">
            <h2 style={{ margin: 0 }}>
              {actorsOf(sel.entity, selAction).map((id) => roles.find((r) => r.id === id)?.title ?? id).join(', ') || 'Nobody'} → {selAction.title} → {sel.entity.title}
            </h2>
            <span className="spacer" />
            <button className="btn small" onClick={() => onOpenEntity(sel.entity.id)}>States and scenarios</button>
            <button className="btn small" onClick={() => setSelected(null)}>Close</button>
          </div>
          {contradictions.map(({ p, f }, i) => (
            <div key={i} className="finding" style={{ borderLeft: `3px solid ${f.kind === 'contradiction' ? 'var(--fail)' : f.kind === 'confirmation' ? 'var(--pass)' : 'var(--observed)'}`, marginTop: 8 }}>
              <b>{f.kind === 'contradiction' ? 'Sources disagree' : f.kind === 'gap' ? 'Gap' : f.kind === 'confirmation' ? 'Confirmed' : 'Question'}:</b> {f.note}
              {quotes(p, f.evidence).map((e) => (
                <blockquote key={e!.id} className="source-quote" style={{ margin: "6px 0", overflowWrap: "anywhere" }}>“{e!.summary}” <span className="id">{e!.path ?? e!.source}</span></blockquote>
              ))}
            </div>
          ))}
          {rulesOf(sel.entity, selAction.id).map((r) => (
            <div key={r.id} className="row" style={{ padding: '6px 0', borderBottom: '1px solid var(--rule)' }}>
              <span style={{ textDecoration: r.status === 'rejected' ? 'line-through' : undefined }}>{r.text}</span>
              <span className="muted">{r.status}{r.provenance?.sources.length ? ` · ${r.provenance.sources.join(', ')}` : ''}{r.requires.length ? '' : ' · text only'}</span>
              <span className="spacer" />
              {r.status !== 'rejected' && <button className="btn small" disabled={busy} title="Strike out" onClick={() => setRuleStatus(r, 'rejected')}>✕</button>}
            </div>
          ))}
          {pendingRules.map((x) => (
            <div key={`${x.proposal.id}-${x.index}`} style={{ ...sugg, padding: '6px 8px', borderRadius: 6, marginTop: 6 }}>
              <div className="row">
                <span>{str(x.op.value.text) || str(x.op.value.title)}</span>
                <span className="muted">agent</span>
                <Decide busy={busy || !ids.includes(x.proposal.entity!)} onDecide={(v) => decide(x, v)} />
              </div>
              {quotes(x.proposal, x.op.evidence).map((e) => (
                <blockquote key={e!.id} className="source-quote" style={{ margin: '6px 0 0' }}>“{e!.summary}” <span className="id">{e!.path ?? e!.source}</span></blockquote>
              ))}
            </div>
          ))}
          <div className="row" style={{ gap: 4, marginTop: 10 }}>
            <input className="text" style={{ flex: 1 }} value={ruleText} placeholder="A buyer can cancel an order only until it has been paid." onChange={(e) => setRuleText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && ruleText.trim() && addRule()} />
            <button className="btn" disabled={busy || !ruleText.trim()} onClick={addRule}>Add rule</button>
          </div>
        </section>
      )}
    </div>
  );
}
