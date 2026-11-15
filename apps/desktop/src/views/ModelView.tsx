import { useEffect, useState, type ReactNode } from 'react';
import type { Action, Decision, Disagreement, Entity, HistoryEntry, Lint, Op, ReviewCell, ReviewMarks, Role, Rule } from '@tc/model';
import { api, type EntityState, type ProjectState, type ProposalState } from '../api.ts';
import { DeleteButton, Editable, HistoryList, originText } from './ModelHistory.tsx';
import { AttributesTable, LifecycleTables, type ProposedAttribute } from './ObjectParts.tsx';

// The model as a person thinks about it: who acts (subjects), on what
// (objects), with which actions, under which rules. What an agent found but
// nobody has decided yet sits in place with ✓ / ≈ / ✕, so reviewing is part of
// reading the model rather than a separate inbox.

type Props = {
  project: ProjectState;
  proposals: ProposalState[];
  reloadToken: number;
  running: boolean;
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
  return [...new Set([...(action.by ?? []), ...impliedActors(entity, action.id).keys()])];
}

// Subjects a transition or permit of the action names, with the first one's title:
// they act through it, so unticking them on the action alone wouldn't stop them.
function impliedActors(entity: Entity, action: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const t of [...entity.transitions, ...entity.permits]) if (t.action === action && t.status !== 'rejected') t.by.forEach((r) => out.has(r) || out.set(r, t.title));
  return out;
}

// Rules of an action: tied to it directly or through one of its transitions.
export function rulesOf(entity: Entity, action: string): Rule[] {
  const transitions = new Set(entity.transitions.filter((t) => t.action === action).map((t) => t.id));
  return entity.rules.filter((r) => r.action === action || (r.transition && transitions.has(r.transition)));
}

export function Decide({ busy, noObserve, onDecide }: { busy: boolean; noObserve?: boolean; onDecide(v: Verdict): void }) {
  return (
    <span className="decide">
      <button className="btn small" title="True: make it part of the model" disabled={busy} onClick={() => onDecide('accept')}>Requirement</button>
      {!noObserve && <button className="btn small" title="That's how it works, but it isn't a requirement" disabled={busy} onClick={() => onDecide('observe')}>Observed</button>}
      {!noObserve && <button className="btn small" title="Required, but not built yet: no tests until it is" disabled={busy} onClick={() => onDecide('plan')}>Planned</button>}
      <button className="btn small ghost" title="Strike out: agents won't propose it again" disabled={busy} onClick={() => onDecide('reject')}>Strike out</button>
    </span>
  );
}

// R / C / A: what the requirements, the code and the running app say about an element.
const markClass = (c?: ReviewCell) => (c === 'confirms' ? 'y' : c === 'contradicts' ? 'x' : c ? 'q' : 'n');
const markWord = (c?: ReviewCell) => (c === 'confirms' ? 'confirm' : c === 'contradicts' ? 'contradict' : c === 'gap' ? 'say nothing (gap)' : c === 'question' ? 'leave a question' : 'not checked');
export function Marks({ marks }: { marks?: ReviewMarks }) {
  return (
    <span className="marks">
      <span className={`mk ${markClass(marks?.requirements)}`} title={`Requirements: ${markWord(marks?.requirements)}`}>R</span>
      <span className={`mk ${markClass(marks?.code)}`} title={`Code: ${markWord(marks?.code)}`}>C</span>
      <span className={`mk ${marks?.app ? 'y' : 'n'}`} title={marks?.app ? 'App: seen working' : 'App: not seen yet'}>A</span>
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
  const group = (title: string, kind: 'gap' | 'question' | 'contradiction', items: ReactNode[]) =>
    items.length > 0 && (
      <details open={items.length <= 5} className={kind}>
        <summary><b>{items.length}</b> {title}</summary>
        <ul>{items}</ul>
      </details>
    );
  const finding = (d: Disagreement, settle: boolean) => (
    <li key={`${d.proposal}-${d.index}`}>
      {d.finding.refs[0] ? link(d.finding.refs[0], d.finding.note) : d.finding.note}
      {settle && <> <button className="btn small" disabled={busy} title="Answered: take it off the list" onClick={() => onSettle(d)}>Done</button></>}
    </li>
  );
  return (
    <section aria-label="What to do next" className="queue">
      <h2>What to do next</h2>
      {group('gaps in the model', 'gap', queue.gaps.map((l, i) => <li key={i}>{link(l.ref, l.message)}</li>))}
      {group('open questions', 'question', queue.questions.map((d) => finding(d, true)))}
      {group('contradictions between sources (settle them in Inbox)', 'contradiction', queue.contradictions.map((d) => finding(d, false)))}
      <p className="muted" style={{ margin: 0 }}>Answer a question here, or use Ask agent › Review the model to have an agent look into all of them.</p>
    </section>
  );
}

export function ModelView({ project, proposals, reloadToken, running, onOpenEntity, onChanged, onError }: Props) {
  const [states, setStates] = useState<Record<string, EntityState>>({});
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<{ entity: string; action: string } | null>(null);
  const [newRole, setNewRole] = useState({ title: '', kind: 'human' as Role['kind'] });
  const [newEntity, setNewEntity] = useState('');
  const [newAction, setNewAction] = useState('');
  const [subject, setSubject] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [ruleText, setRuleText] = useState('');
  const [queue, setQueue] = useState<Queue>({ gaps: [], questions: [], contradictions: [] });
  const [marks, setMarks] = useState<Record<string, ReviewMarks>>({});
  const [focus, setFocus] = useState<string | null>(null);

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
        setMarks(Object.fromEntries(r.matrix.map((m) => [m.ref, m.marks])));
      })
      .catch((e) => onError((e as Error).message));
  }, [reloadToken, proposals]);
  // shortcut: the whole log on every reload; fetch per element (api.history(ref)) once logs grow to thousands of lines.
  useEffect(() => {
    api.history().then((h) => setHistory(h.entries), (e) => onError((e as Error).message));
  }, [reloadToken, proposals, project]);

  // "action:order.cancel" → select that action; a rule or transition → its action; anything else → the object's page.
  // A link can be clicked before its object has loaded: keep it and open it once it has.
  const [wantRef, setWantRef] = useState<string | null>(null);
  const openRef = (ref: string) => {
    if (!showRef(ref)) setWantRef(ref);
  };
  useEffect(() => {
    if (wantRef && showRef(wantRef)) setWantRef(null);
  }, [states, wantRef]);
  const showRef = (ref: string) => {
    const m = /^(\w+):([\w-]+)\.([\w-]+)$/.exec(ref);
    const e = m && states[m[2]]?.entity;
    if (!m || !e) return false;
    const [, kind, entity, id] = m;
    const action =
      kind === 'action' ? id
      : kind === 'rule' ? (e.rules.find((r) => r.id === id)?.action ?? e.transitions.find((t) => t.id === e.rules.find((r) => r.id === id)?.transition)?.action)
      : kind === 'transition' ? e.transitions.find((t) => t.id === id)?.action
      : kind === 'permit' ? e.permits.find((t) => t.id === id)?.action
      : undefined;
    setFocus(entity);
    setSubject(null);
    setSelected(action ? { entity, action } : null);
    return true;
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
  // One request per proposal, so a proposal's ops are decided together.
  const decideAll = (xs: Pending[], verdict: Verdict) =>
    act(async () => {
      const byProposal = new Map<string, number[]>();
      for (const x of xs) byProposal.set(x.proposal.id, [...(byProposal.get(x.proposal.id) ?? []), x.index]);
      for (const [id, ops] of byProposal) await api.decide(id, ops.map((op) => ({ op, verdict })));
    });
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
  const renameRole = (id: string, title: string) =>
    act(() => api.saveProject({ ...project.project, roles: roles.map((r) => (r.id === id ? { ...r, title } : r)) }));
  const removeRole = (id: string) =>
    act(async () => {
      await api.removeRole(id);
      setSubject(null);
    });
  const addEntity = () =>
    act(async () => {
      await api.createEntity({ id: slug(newEntity, 'object', ids), title: newEntity.trim() });
      setNewEntity('');
    });
  const removeEntity = (id: string) =>
    act(async () => {
      await api.deleteEntity(id);
      setFocus(null);
      setSelected(null);
    });
  // Edits one object from its latest loaded copy.
  const edit = (id: string, change: (e: Entity) => void) => {
    const entity = structuredClone(states[id].entity);
    change(entity);
    return saveEntity(entity);
  };
  const addAction = (entityId: string) =>
    act(async () => {
      const entity = structuredClone(states[entityId].entity);
      const title = newAction.trim();
      if (entity.actions.some((a) => a.title.toLowerCase() === title.toLowerCase())) throw new Error(`“${title}” is already an action of ${entity.title}`);
      // A new action starts with nobody: tick who performs it in its row.
      entity.actions.push({
        id: slug(title, 'action', entity.actions.map((a) => a.id)),
        title,
        kind: 'command',
        by: [],
        status: 'confirmed',
        provenance: { source: 'human', evidence: [], sources: [] },
      });
      await api.saveEntity(entity, states[entityId].revision);
      setNewAction('');
    });
  const toggleActor = (entityId: string, action: string, role: string) =>
    edit(entityId, (e) => {
      const a = e.actions.find((x) => x.id === action)!;
      const by = a.by ?? [];
      a.by = by.includes(role) ? by.filter((r) => r !== role) : roles.map((r) => r.id).filter((r) => r === role || by.includes(r));
    });
  // An action goes with the rules written for it; one a transition or permit uses stays until those change.
  const removeAction = (entityId: string, action: string) => {
    const e = states[entityId].entity;
    const users = [...e.transitions, ...e.permits].filter((t) => t.action === action);
    if (users.length) return onError(`Still used by ${users.map((t) => t.title).join(', ')}: change those in States and scenarios first.`);
    if (selected?.action === action) setSelected(null);
    return edit(entityId, (x) => {
      x.actions = x.actions.filter((a) => a.id !== action);
      x.rules = x.rules.filter((r) => r.action !== action);
    });
  };

  // Pending actions per entity, with the roles the proposal gives them.
  const pendingAttributes = (entity: string): ProposedAttribute[] =>
    pending
      .filter((p) => p.entity === entity)
      .flatMap((proposal) =>
        proposal.ops.flatMap((op, index) =>
          op.op === 'add' && op.kind === 'attribute' && open(proposal, index)
            ? [{ key: `${proposal.id}-${index}`, value: op.value, agent: proposal.agent, rationale: proposal.rationale, blocked: !ids.includes(entity), onDecide: (v: Verdict) => decide({ proposal, index, op }, v) }]
            : [],
        ),
      );
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

  // Open on the object with agent proposals waiting, else the one with the most actions.
  const loaded = ids.filter((id) => states[id]);
  const current =
    focus && states[focus] ? focus
    : (selected?.entity ?? loaded.find((id) => pendingActions(id).length > 0) ?? [...loaded].sort((a, b) => states[b].entity.actions.length - states[a].entity.actions.length)[0] ?? null);
  const cur = current ? states[current] : undefined;
  const pick = (entity: string, action: string) => {
    setFocus(entity);
    setSubject(null);
    setSelected({ entity, action });
  };
  const roleTitle = (id: string) => roles.find((r) => r.id === id)?.title ?? id;
  const ruleMarks = (r: Rule) => marks[`rule:${sel?.entity.id}.${r.id}`];

  // The focused object's actions against every subject: tick who performs each one.
  // A tick a transition or permit sets is shown, but changes in States and scenarios.
  const actionTable = () => {
    if (!cur || !current) return null;
    const proposed = pendingActions(current);
    return (
      <div className="act-table-wrap">
        <table className="act-table">
          <thead>
            <tr>
              <th scope="col">Action</th>
              {roles.map((r) => (
                <th key={r.id} scope="col" className="who">
                  <button className="link-btn" title={`${r.title}: everything this subject does`} onClick={() => setSubject(r.id)}>{r.title}</button>
                </th>
              ))}
              <th aria-label="Row actions" />
            </tr>
          </thead>
          <tbody>
            {cur.entity.actions.map((a) => {
              const conflicts = pending.some((p) => p.entity === current && p.findings.some((f) => f.kind === 'contradiction' && f.refs.some((r) => r.endsWith(`.${a.id}`))));
              const on = selected?.entity === current && selected.action === a.id;
              const n = rulesOf(cur.entity, a.id).length;
              const implied = impliedActors(cur.entity, a.id);
              const nobody = actorsOf(cur.entity, a).length === 0;
              return (
                <tr key={a.id} className={`${a.status} ${on ? 'on' : ''}`}>
                  <th scope="row">
                    <button className={`chip ${on ? 'on' : ''} ${a.status}`} aria-pressed={on} title={`${a.status}: open its rules`} onClick={() => pick(current, a.id)}>
                      {a.title}
                      {n > 0 && <span className="muted">{n}</span>}
                      {conflicts && <span className="sev bad" title="Sources disagree" />}
                    </button>
                    {nobody && <span className="muted nobody"> nobody yet</span>}
                  </th>
                  {roles.map((r) => {
                    const via = implied.get(r.id);
                    const declared = (a.by ?? []).includes(r.id);
                    return (
                      <td key={r.id} className="who">
                        <input
                          type="checkbox"
                          aria-label={`${r.title} can ${a.title}`}
                          title={via ? `Through “${via}”: change it in States and scenarios` : declared ? `${r.title} performs it: untick to take it away` : `Tick: ${r.title} performs it too`}
                          checked={declared || !!via}
                          disabled={busy || (!!via && !declared)}
                          onChange={() => toggleActor(current, a.id, r.id)}
                        />
                      </td>
                    );
                  })}
                  <td className="row-x">
                    <button className="mini" disabled={busy} aria-label={`Delete action ${a.title}`} title="Delete the action and its rules" onClick={() => removeAction(current, a.id)}>✕</button>
                  </td>
                </tr>
              );
            })}
            {proposed.length > 0 && (
              <tr className="proposed-h">
                <td colSpan={roles.length + 2}><div className="proposed-bar">
                  <span className="tag proposed">proposed</span> {proposed.length} {proposed.length === 1 ? 'action an agent found' : 'actions agents found'}, not in the model until you accept {proposed.length === 1 ? 'it' : 'them'}
                  <span className="spacer" />
                  <button className="btn small" disabled={busy || proposed.some((x) => x.blocked)} onClick={() => decideAll(proposed, 'accept')}>Accept all</button>
                  <button className="btn small ghost" disabled={busy || proposed.some((x) => x.blocked)} onClick={() => decideAll(proposed, 'reject')}>Strike out all</button>
                </div></td>
              </tr>
            )}
            {proposed.map((x) => (
              <tr key={`${x.proposal.id}-${x.index}`} className="proposed" title={x.proposal.rationale}>
                <th scope="row">
                  <span className="chip proposed">{str(x.op.value.title) || str(x.op.value.id)}</span>
                  <span className="muted nobody"> proposed by {x.proposal.agent}</span>
                </th>
                {roles.map((r) => (
                  <td key={r.id} className="who">{x.by.includes(r.id) ? <span title={`The agent says ${r.title} performs it`}>✓</span> : null}</td>
                ))}
                <td className="row-x">
                  <span className="decide">
                    <button className="btn small" disabled={busy || x.blocked} title="Add it to the model as a requirement" onClick={() => decide(x, 'accept')}>Accept</button>
                    <button className="btn small ghost" disabled={busy || x.blocked} title="Strike out: agents won't propose it again" onClick={() => decide(x, 'reject')}>Strike out</button>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="tree-add act-add">
          <input className="text" aria-label="New action" value={newAction} placeholder="New action, e.g. Archive" onChange={(e) => setNewAction(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && newAction.trim() && addAction(current)} />
          <button className="btn small" disabled={busy || !newAction.trim()} onClick={() => addAction(current)}>Add action</button>
        </div>
      </div>
    );
  };

  // A subject's page: where it came from, what it does on every object, its history.
  const subjectPage = (id: string) => {
    const r = roles.find((x) => x.id === id);
    if (!r) return null;
    const does = loaded
      .map((e) => ({ e: states[e].entity, acts: states[e].entity.actions.filter((a) => actorsOf(states[e].entity, a).includes(id)), changes: states[e].entity.attributes.filter((a) => a.status !== 'rejected' && a.by?.includes(id)) }))
      .filter((x) => x.acts.length || x.changes.length);
    return (
      <>
        <div className="ehead">
          <Editable as="h1" title={r.title} label={r.title} busy={busy} onSave={(t) => renameRole(id, t)} />
          <span className="id">{r.id}</span>
          {r.kind === 'system' && <span className="sys">SYS</span>}
          <span className="spacer" />
          <DeleteButton label={r.title} busy={busy} onDelete={() => removeRole(id)} />
        </div>
        <p className="origin">{originText(`role:${id}`, history, undefined, r.title)}</p>
        <section className="acts subject-acts" aria-label="What this subject does">
          {!does.length && <p className="muted">Does nothing yet: tick it on an object's actions.</p>}
          {does.map(({ e, acts, changes }) => (
            <div key={e.id} className="act-row">
              <button className="who link-btn" onClick={() => { setSubject(null); setFocus(e.id); setSelected(null); }}>{e.title}</button>
              <div className="chips">
                {acts.map((a) => (
                  <button key={a.id} className={`chip ${a.status}`} onClick={() => { setSubject(null); pick(e.id, a.id); }}>{a.title}</button>
                ))}
                {changes.length > 0 && <span className="muted">changes {changes.map((a) => a.title).join(', ')}</span>}
              </div>
            </div>
          ))}
        </section>
        <HistoryList entries={history.filter((h) => h.ref === `role:${id}`)} names={roleTitle} />
      </>
    );
  };

  return (
    <div className="model-ws">
      <aside className="model-tree" aria-label="Model outline">
        <div className="tree-h">Subjects</div>
        {roles.map((r) => (
          <button key={r.id} className="tree-item" aria-current={subject === r.id ? 'true' : undefined} title={originText(`role:${r.id}`, history, undefined, r.title)} onClick={() => setSubject(r.id)}>
            <span>{r.title}</span> {r.kind === 'system' && <span className="sys" title="Background jobs and integrations">SYS</span>}
          </button>
        ))}
        {pendingRoles.map((x) => (
          <div key={`${x.proposal.id}-${x.index}`} className="tree-proposed">
            <span>{str(x.op.value.title) || str(x.op.value.id)} <span className="tag proposed">proposed</span></span>
            <Decide busy={busy} noObserve onDecide={(v) => decide(x, v)} />
          </div>
        ))}
        <div className="tree-add">
          <input className="text" aria-label="New subject" value={newRole.title} placeholder="New subject" onChange={(e) => setNewRole({ ...newRole, title: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && newRole.title.trim() && addRole()} />
          <select className="text" aria-label="Subject kind" value={newRole.kind} onChange={(e) => setNewRole({ ...newRole, kind: e.target.value as Role['kind'] })}>
            <option value="human">person</option>
            <option value="system">system</option>
          </select>
          <button className="btn small" disabled={busy || !newRole.title.trim()} onClick={addRole}>Add</button>
        </div>

        <div className="tree-h">Objects</div>
        {ids.map((id) => {
          const n = pendingActions(id).length + pending.filter((p) => p.entity === id).reduce((k, p) => k + p.ops.filter((op, i) => open(p, i) && op.op === 'add' && op.kind === 'rule').length, 0);
          return (
            <button key={id} className="tree-item" aria-current={!subject && current === id ? 'true' : undefined} onClick={() => { setSubject(null); setFocus(id); setSelected(null); }}>
              <span>{states[id]?.entity.title ?? id}</span>
              {n > 0 && <span className="pdot" title={`${n} proposed by agents`} />}
              <span className="n">{states[id]?.entity.actions.length ?? ''}</span>
            </button>
          );
        })}
        {pendingEntities.map((x) => (
          <div key={`${x.proposal.id}-${x.index}`} className="tree-proposed">
            <span>{str(x.op.value.title) || str(x.op.value.id)} <span className="tag proposed">proposed</span></span>
            <Decide busy={busy} noObserve onDecide={(v) => decide(x, v)} />
          </div>
        ))}
        <div className="tree-add">
          <input className="text" aria-label="New object" value={newEntity} placeholder="New object" onChange={(e) => setNewEntity(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && newEntity.trim() && addEntity()} />
          <button className="btn small" disabled={busy || !newEntity.trim()} onClick={addEntity}>Add</button>
        </div>
      </aside>

      <div className="model-main">
        {subject && subjectPage(subject)}
        {!subject && !cur && <p className="muted">Add an object on the left, or ask an agent to research the sources.</p>}
        {!subject && cur && (
          <>
            <div className="ehead">
              <Editable as="h1" title={cur.entity.title} label={cur.entity.title} busy={busy} onSave={(t) => edit(cur.entity.id, (e) => { e.title = t; })} />
              <span className="id">{cur.entity.id}</span>
              <span className="spacer" />
              <button className="btn small ghost" aria-pressed={showHistory} onClick={() => setShowHistory(!showHistory)}>History</button>
              <DeleteButton label={cur.entity.title} busy={busy} onDelete={() => removeEntity(cur.entity.id)} />
              <button className="btn small" onClick={() => onOpenEntity(cur.entity.id)}>States and scenarios</button>
            </div>
            <p className="origin">{originText(`entity:${cur.entity.id}`, history)}</p>
            {cur.entity.description && <p className="lede">{cur.entity.description}</p>}
            {showHistory && <HistoryList entries={history.filter((h) => h.ref === `entity:${cur.entity.id}` || h.ref.includes(`:${cur.entity.id}.`))} names={roleTitle} label={`History of ${cur.entity.title}`} />}

            <section className="acts" aria-label="Parameters">
              <h2 className="sec-h">Parameters</h2>
              <AttributesTable entity={cur.entity} roles={roles} proposed={pendingAttributes(cur.entity.id)} busy={busy} onEdit={(change) => edit(cur.entity.id, change)} />
            </section>
            <section className="acts" aria-label="Lifecycle">
              <LifecycleTables entity={cur.entity} roles={roles} onPick={(a) => pick(cur.entity.id, a)} />
            </section>

            <section className="acts" aria-label="Actions">
              <h2 className="sec-h">Actions</h2>
              {actionTable()}
            </section>

            {sel && selAction && sel.entity.id === cur.entity.id ? (
              <section className="rules" aria-label="Rules">
                <div className="rules-h">
                  <h2>{actorsOf(sel.entity, selAction).map(roleTitle).join(', ') || 'Nobody'} → {selAction.title}</h2>
                  <Editable bare title={selAction.title} label={`action ${selAction.title}`} busy={busy} onSave={(t) => edit(sel.entity.id, (e) => { e.actions.find((a) => a.id === selAction.id)!.title = t; })} />
                  <span className="muted">{rulesOf(sel.entity, selAction.id).length} rules</span>
                  <span className="spacer" />
                  <span className="muted legend-rca">R requirements · C code · A app</span>
                  <button className="btn small ghost" onClick={() => setSelected(null)}>Close</button>
                </div>
                <p className="origin rule-origin">{originText(`action:${sel.entity.id}.${selAction.id}`, history, selAction.provenance)}</p>
                {contradictions.map(({ p, f }, i) => (
                  <div key={i} className={`rule finding-row ${f.kind}`}>
                    <div className="t">
                      <span className={`tag ${f.kind === 'contradiction' ? 'contradicts' : f.kind === 'confirmation' ? 'confirmed' : 'observed'}`}>
                        {f.kind === 'contradiction' ? 'sources disagree' : f.kind === 'gap' ? 'gap' : f.kind === 'confirmation' ? 'confirmed' : 'question'}
                      </span>{' '}
                      {f.note}
                    </div>
                    {quotes(p, f.evidence).length > 0 && (
                      <div className="quotes">
                        {quotes(p, f.evidence).map((e) => (
                          <blockquote key={e!.id} className="q">“{e!.summary}”<span className="id">{e!.path ?? e!.source}</span></blockquote>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
                {rulesOf(sel.entity, selAction.id).map((r) => (
                  <div key={r.id} className={`rule ${r.status}`}>
                    <div className="t">{r.text}</div>
                    <Marks marks={ruleMarks(r)} />
                    <div className="meta">
                      <span className={`tag ${r.status}`}>{r.status}</span>
                      {r.provenance?.sources.length ? <span>{r.provenance.sources.join(', ')}</span> : null}
                      {r.requires.length === 0 && <span>text only</span>}
                      <span>{originText(`rule:${sel.entity.id}.${r.id}`, history, r.provenance)}</span>
                      <span className="spacer" />
                      {r.status !== 'rejected' && <button className="btn small ghost" disabled={busy} title="Strike out" onClick={() => setRuleStatus(r, 'rejected')}>Strike out</button>}
                    </div>
                  </div>
                ))}
                {pendingRules.map((x) => (
                  <div key={`${x.proposal.id}-${x.index}`} className="rule proposed">
                    <div className="t"><b>{str(x.op.value.text) || str(x.op.value.title)}</b></div>
                    <span className="tag proposed">proposed</span>
                    {quotes(x.proposal, x.op.evidence).length > 0 && (
                      <div className="quotes">
                        {quotes(x.proposal, x.op.evidence).map((e) => (
                          <blockquote key={e!.id} className="q">“{e!.summary}”<span className="id">{e!.path ?? e!.source}</span></blockquote>
                        ))}
                      </div>
                    )}
                    <div className="meta"><Decide busy={busy || !ids.includes(x.proposal.entity!)} onDecide={(v) => decide(x, v)} /></div>
                  </div>
                ))}
                <details className="rule-history">
                  <summary>History of this action and its rules</summary>
                  <HistoryList
                    entries={history.filter((h) => h.ref === `action:${sel.entity.id}.${selAction.id}` || rulesOf(sel.entity, selAction.id).some((r) => h.ref === `rule:${sel.entity.id}.${r.id}`))}
                    names={roleTitle}
                  />
                </details>
                <div className="rule-add">
                  <input className="text" aria-label="New rule" value={ruleText} placeholder="A buyer can cancel an order only until it has been paid." onChange={(e) => setRuleText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && ruleText.trim() && addRule()} />
                  <button className="btn" disabled={busy || !ruleText.trim()} onClick={addRule}>Add rule</button>
                </div>
              </section>
            ) : (
              <p className="muted pick-hint">Pick an action to see and write its rules.</p>
            )}
          </>
        )}
      </div>

      <aside className="model-next" aria-label="Next">
        <NextQueue queue={queue} busy={busy} onOpen={openRef} onSettle={(d) => act(() => api.resolve(d.proposal, d.index, 'fine'))} />
        {otherOpen > 0 && <p className="muted next-more">{otherOpen} more findings (states, transitions, backlog) wait in the Inbox.</p>}
      </aside>
    </div>
  );
}
