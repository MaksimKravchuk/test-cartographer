import { useEffect, useState } from 'react';
import type { Action, Entity, HistoryEntry, Lint, Op, ReviewCell, ReviewMarks, Role, Rule } from '@tc/model';
import { api, type EntityState, type ProjectState, type ProposalState } from '../api.ts';
import { DeleteButton, Editable, HistoryList, originText } from './ModelHistory.tsx';
import { Tip } from '../ui.tsx';
import { AttributesTable, GoneRow, rowKeys, useStableRows, type ProposedAttribute } from './ObjectParts.tsx';
import { TechDetails } from './TechDetails.tsx';
import { SubjectConnection } from './SubjectConnection.tsx';
import { GlossaryView } from './GlossaryView.tsx';
import { nextId } from '../graph.ts';

// The model as a person thinks about it: who acts (subjects), on what
// (objects), with which actions, under which rules. What an agent proposed shows
// in place, dashed, and is decided in the Inbox. How the tests reach the app
// stays folded at the bottom of each page.

type Props = {
  project: ProjectState;
  proposals: ProposalState[];
  reloadToken: number;
  // An object's scenarios and test results, under Tests.
  onOpenTests(id: string): void;
  onOpenInbox(): void;
  onChanged(): void;
  onError(m: string): void;
};

// The Glossary page in the outline, beside subjects and objects.
const GLOSSARY = '@glossary';

type Pending = { proposal: ProposalState; index: number; op: Extract<Op, { op: 'add' }> };

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

// R / C / A: what the requirements, the code and the running app say about an element.
// The letters and their look carry it on screen; the words are there for screen readers.
const markClass = (c?: ReviewCell) => (c === 'confirms' ? 'y' : c === 'contradicts' ? 'x' : c ? 'q' : 'n');
const markWord = (c?: ReviewCell) => (c === 'confirms' ? 'confirm' : c === 'contradicts' ? 'contradict' : c === 'gap' ? 'say nothing (gap)' : c === 'question' ? 'leave a question' : 'not checked');
export function Marks({ marks }: { marks?: ReviewMarks }) {
  return (
    <span className="marks">
      <span className={`mk ${markClass(marks?.requirements)}`}><span aria-hidden>R</span><span className="sr-only">Requirements {markWord(marks?.requirements)}.</span></span>
      <span className={`mk ${markClass(marks?.code)}`}><span aria-hidden>C</span><span className="sr-only">Code: {markWord(marks?.code)}.</span></span>
      <span className={`mk ${marks?.app ? 'y' : 'n'}`}><span aria-hidden>A</span><span className="sr-only">{marks?.app ? 'App: seen working.' : 'App: not seen yet.'}</span></span>
    </span>
  );
}

export function ModelView({ project, proposals, reloadToken, onOpenTests, onOpenInbox, onChanged, onError }: Props) {
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
  const [lint, setLint] = useState<Lint[]>([]);
  const [stateText, setStateText] = useState('');
  // The "add change" form's choice, until another action is picked.
  const [changeFrom, setChangeFrom] = useState<string | null>(null);
  const [changeTo, setChangeTo] = useState<string | null>(null);
  useEffect(() => { setChangeFrom(null); setChangeTo(null); }, [selected?.entity, selected?.action]);
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
        setLint(r.lint);
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
  const edit = (id: string, change: (e: Entity) => void) =>
    act(async () => {
      const entity = structuredClone(states[id].entity);
      change(entity);
      await api.saveEntity(entity, states[id].revision);
    });
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
  // Who performs an action is one list: ticking a subject adds it to the action and to every
  // transition and permit of it; unticking takes it off all of them.
  const toggleActor = (entityId: string, action: string, role: string) =>
    edit(entityId, (e) => {
      const a = e.actions.find((x) => x.id === action)!;
      const users = [...e.transitions, ...e.permits].filter((t) => t.action === action);
      const order = (by: string[]) => roles.map((r) => r.id).filter((r) => by.includes(r));
      if (actorsOf(e, a).includes(role)) {
        const last = users.find((t) => t.by.length === 1 && t.by[0] === role);
        if (last) throw new Error(`Nobody else performs “${last.title}”: tick another subject first, or remove that change.`);
        a.by = (a.by ?? []).filter((r) => r !== role);
        for (const t of users) t.by = t.by.filter((r) => r !== role);
      } else {
        a.by = order([...actorsOf(e, a), role]);
        for (const t of users) t.by = order([...t.by, role]);
      }
    });
  // What an action changes: a transition from one state to another, or a permit that leaves the state as it is.
  const meta = () => ({ status: 'confirmed' as const, provenance: { source: 'human' as const, evidence: [], sources: [] } });
  const addTransition = (entityId: string, action: string, from: string, to: string) =>
    edit(entityId, (e) => {
      const a = e.actions.find((x) => x.id === action)!;
      if (e.transitions.some((t) => t.action === action && t.from === from && t.to === to)) throw new Error('This change is already there.');
      const by = actorsOf(e, a);
      if (!by.length) throw new Error(`Tick who performs “${a.title}” first.`);
      e.transitions.push({ id: nextId(`${action}-${to}`, e.transitions.map((t) => t.id)), title: `${a.title}: ${stateName(e, from)} → ${stateName(e, to)}`, from, to, action, by, guards: [], effects: [], ...meta() });
    });
  const addPermit = (entityId: string, action: string) =>
    edit(entityId, (e) => {
      const a = e.actions.find((x) => x.id === action)!;
      const by = actorsOf(e, a);
      if (!by.length) throw new Error(`Tick who performs “${a.title}” first.`);
      e.permits.push({ id: nextId(action, e.permits.map((p) => p.id)), title: a.title, action, by, effects: [], ...meta() });
    });
  const removeChange = (entityId: string, kind: 'transitions' | 'permits', id: string) =>
    edit(entityId, (e) => {
      const used = e.states.filter((s) => s.setup.some((x) => x.kind === 'path' && x.via.includes(id)));
      if (used.length) throw new Error(`${used.map((x) => x.title).join(', ')} is set up through this change: edit it under “How tests connect to the app” first.`);
      if (kind === 'transitions') {
        // Its rules stay with the action.
        const action = e.transitions.find((t) => t.id === id)?.action;
        e.transitions = e.transitions.filter((t) => t.id !== id);
        e.rules = e.rules.map((r) => (r.transition === id ? { ...r, transition: undefined, action: r.action ?? action } : r));
      } else e.permits = e.permits.filter((p) => p.id !== id);
    });
  const addState = (entityId: string, title: string) =>
    edit(entityId, (e) => {
      const id = nextId(title, e.states.map((x) => x.id));
      e.states.push({ id, title, match: { status: id }, setup: [], ...meta() });
    });
  const removeState = (entityId: string, id: string) =>
    edit(entityId, (e) => {
      const used = [...e.transitions.filter((t) => t.from === id || t.to === id), ...e.permits.filter((p) => p.states?.includes(id))];
      if (used.length) throw new Error(`Used by ${used.map((t) => t.title).join(', ')}: remove those changes first.`);
      e.states = e.states.filter((x) => x.id !== id);
    });
  // An action goes with the rules written for it; one a transition or permit uses stays until those change.
  const removeAction = (entityId: string, action: string) => {
    const e = states[entityId].entity;
    const users = [...e.transitions, ...e.permits].filter((t) => t.action === action);
    if (users.length) return onError(`It still changes the object (${users.map((t) => t.title).join(', ')}): remove those changes on the action first.`);
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
            ? [{ key: `${proposal.id}-${index}`, value: op.value, agent: proposal.agent, rationale: proposal.rationale }]
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
  const proposed = current ? pendingActions(current) : [];
  // A proposal's row takes the id it will have once accepted, so accepting it keeps its place.
  // Only the first proposal of an id takes it; a second one for the same id keeps a row of its own.
  const keys = rowKeys(proposed, (x) => str(x.op.value.id), (x) => `${x.proposal.id}-${x.index}`, cur?.entity.actions.map((a) => a.id) ?? []);
  const keyOf = (x: (typeof proposed)[number]) => keys.get(x)!;
  const actionRows = useStableRows(current ?? '', [...(cur?.entity.actions ?? []).map((a) => ({ key: a.id, title: a.title })), ...proposed.map((x) => ({ key: keyOf(x), title: str(x.op.value.title) || str(x.op.value.id) }))]);
  const pick = (entity: string, action: string) => {
    setFocus(entity);
    setSubject(null);
    setSelected({ entity, action });
  };
  const roleTitle = (id: string) => roles.find((r) => r.id === id)?.title ?? id;
  const ruleMarks = (r: Rule) => marks[`rule:${sel?.entity.id}.${r.id}`];

  const stateName = (e: Entity, id: string) => (id === '@new' ? 'New' : e.states.find((x) => x.id === id)?.title ?? id);
  // "only Standard" when a transition or permit holds for some variants of the object, not all.
  const onlyFor = (e: Entity, variants?: string[]) =>
    variants && e.variants.length > 1 && variants.length < e.variants.length ? ` (only ${variants.map((v) => e.variants.find((x) => x.id === v)?.title ?? v).join(', ')})` : '';
  // What an action does to the object, in words: "Created → Paid", or "no state change".
  const changeText = (e: Entity, a: Action) => {
    const ts = e.transitions.filter((t) => t.action === a.id && t.status !== 'rejected');
    if (ts.length) return ts.map((t) => `${stateName(e, t.from)} → ${stateName(e, t.to)}${onlyFor(e, t.variants)}`).join(' · ');
    const ps = e.permits.filter((t) => t.action === a.id && t.status !== 'rejected');
    if (ps.length) return ps.map((p) => `no state change${p.states ? `, in ${p.states.map((s) => stateName(e, s)).join(', ')}` : ''}${onlyFor(e, p.variants)}`).join(' · ');
    return '';
  };

  // The focused object's actions as a list: who does it and what it changes. Who and
  // the transitions are edited on the action itself; what an agent proposed is decided in the Inbox.
  const actionList = () => {
    if (!cur || !current) return null;
    return (
      <div className="act-table-wrap">
        <table className="act-table act-list">
          <thead>
            <tr>
              <th scope="col">Action</th>
              <th scope="col">Who</th>
              <th scope="col">What it changes</th>
              <th aria-label="Row actions" />
            </tr>
          </thead>
          <tbody>
            {actionRows.map((row) => {
              const a = cur.entity.actions.find((y) => y.id === row.key);
              const x = proposed.find((y) => keyOf(y) === row.key);
              if (x) return (
              <tr key={row.key} className="proposed">
                <th scope="row">
                  <span className="chip proposed">{str(x.op.value.title) || str(x.op.value.id)}</span>
                  <span className="muted nobody"> proposed by {x.proposal.agent}</span>
                </th>
                <td className="muted">{x.by.map(roleTitle).join(', ')}</td>
                <td />
                <td className="row-x"><button type="button" className="btn small" onClick={onOpenInbox}>Review in Inbox</button></td>
              </tr>
              );
              if (!a) return <GoneRow key={row.key} title={row.title} cols={3} />;
              const conflicts = pending.some((p) => p.entity === current && p.findings.some((f) => f.kind === 'contradiction' && f.refs.some((r) => r.endsWith(`.${a.id}`))));
              const on = selected?.entity === current && selected.action === a.id;
              const n = rulesOf(cur.entity, a.id).length;
              const who = actorsOf(cur.entity, a);
              const change = changeText(cur.entity, a);
              return (
                <tr key={a.id} className={`${a.status} ${on ? 'on' : ''}`}>
                  <th scope="row">
                    <button type="button" className={`chip ${on ? 'on' : ''} ${a.status}`} aria-pressed={on} onClick={() => pick(current, a.id)}>
                      {a.title}
                      {n > 0 && <span className="muted"><span className="sr-only">, rules: </span>{n}</span>}
                      {conflicts && <span className="sev bad"><span className="sr-only">, sources disagree</span></span>}
                    </button>
                  </th>
                  <td className={who.length ? '' : 'muted'}>{who.length ? who.map(roleTitle).join(', ') : 'nobody yet'}</td>
                  <td className={change ? '' : 'muted'}>{change || '—'}</td>
                  <td className="row-x">
                    <Tip tip="Delete the action and its rules"><button type="button" className="mini" disabled={busy} aria-label={`Delete action ${a.title}`} onClick={() => removeAction(current, a.id)}><span aria-hidden>✕</span></button></Tip>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {cur.entity.transitions.length > 0 && <p className="muted hint-line">Everything not listed is forbidden: the tests check that the app refuses it.</p>}
        <form className="tree-add act-add" onSubmit={(e) => { e.preventDefault(); if (newAction.trim()) void addAction(current); }}>
          <input className="text" aria-label="New action" value={newAction} placeholder="New action, e.g. Archive" onChange={(e) => setNewAction(e.target.value)} />
          <button className="btn small" disabled={busy || !newAction.trim()}>Add action</button>
        </form>
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
        <SubjectConnection role={r} project={project} busy={busy} onSave={(next) => act(() => api.saveProject({ ...project.project, roles: roles.map((x) => (x.id === id ? next : x)) }))} />
        <HistoryList entries={history.filter((h) => h.ref === `role:${id}`)} names={roleTitle} />
      </>
    );
  };

  // One action: who performs it, what it changes, and the rules it must follow.
  const actionPanel = (e: Entity, a: Action) => {
    const who = actorsOf(e, a);
    const ts = e.transitions.filter((t) => t.action === a.id && t.status !== 'rejected');
    const ps = e.permits.filter((t) => t.action === a.id && t.status !== 'rejected');
    const from = changeFrom ?? (e.transitions.some((t) => t.from === '@new') ? (e.states[0]?.id ?? '@new') : '@new');
    const to = changeTo ?? e.states[0]?.id ?? '';
    return (
      <section className="rules" aria-label="Rules">
        <div className="rules-h">
          <h2>{who.map(roleTitle).join(', ') || 'Nobody'} → {a.title}</h2>
          <Editable bare title={a.title} label={`action ${a.title}`} busy={busy} onSave={(t) => edit(e.id, (x) => { x.actions.find((y) => y.id === a.id)!.title = t; })} />
          <span className="spacer" />
          <span className="muted legend-rca">R requirements · C code · A app</span>
          <button className="btn small ghost" onClick={() => setSelected(null)}>Close</button>
        </div>
        <p className="origin rule-origin">{originText(`action:${e.id}.${a.id}`, history, a.provenance)}</p>

        <fieldset className="who-line">
          <legend>Who</legend>
          {roles.map((r) => (
            <label key={r.id}>
              <input type="checkbox" checked={who.includes(r.id)} disabled={busy} onChange={() => toggleActor(e.id, a.id, r.id)} /> {r.title}
            </label>
          ))}
        </fieldset>

        <div className="changes" role="group" aria-label="What it changes">
          <div className="changes-h">What it changes</div>
          {ts.map((t) => (
            <div key={t.id} className="change-row">
              <span>{stateName(e, t.from)} → {stateName(e, t.to)}{onlyFor(e, t.variants)}</span>
              {t.by.length < who.length && <span className="muted">only {t.by.map(roleTitle).join(', ')}</span>}
              <Tip tip="Remove this change"><button type="button" className="mini" disabled={busy} aria-label={`Remove ${t.title}`} onClick={() => removeChange(e.id, 'transitions', t.id)}><span aria-hidden>✕</span></button></Tip>
            </div>
          ))}
          {ps.map((p) => (
            <div key={p.id} className="change-row">
              <span>No state change{p.states ? `, in ${p.states.map((x) => stateName(e, x)).join(', ')}` : ', in any state'}{onlyFor(e, p.variants)}</span>
              <Tip tip="Remove this change"><button type="button" className="mini" disabled={busy} aria-label={`Remove ${p.title}`} onClick={() => removeChange(e.id, 'permits', p.id)}><span aria-hidden>✕</span></button></Tip>
            </div>
          ))}
          {!ts.length && !ps.length && <p className="muted">Nothing yet: say which state it moves the object to, or that it leaves the state as it is.</p>}
          {e.states.length > 0 && (
            <form className="change-add" onSubmit={(ev) => { ev.preventDefault(); void addTransition(e.id, a.id, from, to); }}>
              <select className="text" aria-label="From state" value={from} onChange={(ev) => setChangeFrom(ev.target.value)}>
                <option value="@new">New (creates it)</option>
                {e.states.map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}
              </select>
              <span aria-hidden>→</span>
              <select className="text" aria-label="To state" value={to} onChange={(ev) => setChangeTo(ev.target.value)}>
                {e.states.map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}
              </select>
              <button className="btn small" disabled={busy || !to}>Add change</button>
            </form>
          )}
          {!ps.length && <button type="button" className="btn small ghost" disabled={busy} onClick={() => addPermit(e.id, a.id)}>Allowed without changing the state</button>}
        </div>

        {contradictions.map(({ p, f }, i) => (
          <div key={i} className={`rule finding-row ${f.kind}`}>
            <div className="t">
              <span className={`tag ${f.kind === 'contradiction' ? 'contradicts' : f.kind === 'confirmation' ? 'confirmed' : 'observed'}`}>
                {f.kind === 'contradiction' ? 'sources disagree' : f.kind === 'gap' ? 'gap' : f.kind === 'source' ? 'source problem' : f.kind === 'confirmation' ? 'confirmed' : 'question'}
              </span>{' '}
              {f.note}
            </div>
            {quotes(p, f.evidence).length > 0 && (
              <div className="quotes">
                {quotes(p, f.evidence).map((q) => (
                  <blockquote key={q!.id} className="q">“{q!.summary}”<span className="id">{q!.path ?? q!.source}</span></blockquote>
                ))}
              </div>
            )}
            <div className="meta"><button type="button" className="btn small" onClick={onOpenInbox}>Settle in Inbox</button></div>
          </div>
        ))}
        <div className="changes-h">Rules</div>
        {rulesOf(e, a.id).map((r) => (
          <div key={r.id} className={`rule ${r.status}`}>
            <div className="t">{r.text}</div>
            <Marks marks={ruleMarks(r)} />
            <div className="meta">
              <span className={`tag ${r.status}`}>{r.status}</span>
              {r.provenance?.sources.length ? <span>{r.provenance.sources.join(', ')}</span> : null}
              {r.requires.length === 0 && <span>text only</span>}
              <span>{originText(`rule:${e.id}.${r.id}`, history, r.provenance)}</span>
              <span className="spacer" />
              {r.status !== 'rejected' && <button type="button" className="btn small ghost" disabled={busy} onClick={() => setRuleStatus(r, 'rejected')}>Strike out</button>}
            </div>
          </div>
        ))}
        {pendingRules.map((x) => (
          <div key={`${x.proposal.id}-${x.index}`} className="rule proposed">
            <div className="t"><b>{str(x.op.value.text) || str(x.op.value.title)}</b></div>
            <span className="tag proposed">proposed</span>
            {quotes(x.proposal, x.op.evidence).length > 0 && (
              <div className="quotes">
                {quotes(x.proposal, x.op.evidence).map((q) => (
                  <blockquote key={q!.id} className="q">“{q!.summary}”<span className="id">{q!.path ?? q!.source}</span></blockquote>
                ))}
              </div>
            )}
            <div className="meta"><button type="button" className="btn small" onClick={onOpenInbox}>Review in Inbox</button></div>
          </div>
        ))}
        <details className="rule-history">
          <summary>History of this action and its rules</summary>
          <HistoryList
            entries={history.filter((h) => h.ref === `action:${e.id}.${a.id}` || rulesOf(e, a.id).some((r) => h.ref === `rule:${e.id}.${r.id}`))}
            names={roleTitle}
          />
        </details>
        <form className="rule-add" onSubmit={(ev) => { ev.preventDefault(); if (ruleText.trim()) void addRule(); }}>
          <input className="text" aria-label="New rule" value={ruleText} placeholder="A buyer can cancel an order only until it has been paid." onChange={(ev) => setRuleText(ev.target.value)} />
          <button className="btn" disabled={busy || !ruleText.trim()}>Add rule</button>
        </form>
      </section>
    );
  };

  const tree = (
    <aside className="model-tree" aria-label="Model outline">
      <div className="tree-h">Subjects</div>
      {roles.map((r) => (
        <button key={r.id} type="button" className="tree-item" aria-current={subject === r.id ? 'true' : undefined} onClick={() => setSubject(r.id)}>
          <span>{r.title}</span> {r.kind === 'system' && <span className="sys"><span aria-hidden>SYS</span><span className="sr-only">system: background jobs and integrations</span></span>}
        </button>
      ))}
      {pendingRoles.map((x) => (
        <button key={`${x.proposal.id}-${x.index}`} type="button" className="tree-item tree-proposed" onClick={onOpenInbox}>
          <span>{str(x.op.value.title) || str(x.op.value.id)}</span> <span className="tag proposed">proposed</span>
        </button>
      ))}
      <form className="tree-add" onSubmit={(e) => { e.preventDefault(); if (newRole.title.trim()) void addRole(); }}>
        <input className="text" aria-label="New subject" value={newRole.title} placeholder="New subject" onChange={(e) => setNewRole({ ...newRole, title: e.target.value })} />
        <select className="text" aria-label="Subject kind" value={newRole.kind} onChange={(e) => setNewRole({ ...newRole, kind: e.target.value as Role['kind'] })}>
          <option value="human">person</option>
          <option value="system">system</option>
        </select>
        <button className="btn small" disabled={busy || !newRole.title.trim()}>Add</button>
      </form>

      <div className="tree-h">Objects</div>
      {ids.map((id) => {
        const n = pendingActions(id).length + pending.filter((p) => p.entity === id).reduce((k, p) => k + p.ops.filter((op, i) => open(p, i) && op.op === 'add' && op.kind === 'rule').length, 0);
        return (
          <button key={id} type="button" className="tree-item" aria-current={!subject && current === id ? 'true' : undefined} onClick={() => { setSubject(null); setFocus(id); setSelected(null); }}>
            <span>{states[id]?.entity.title ?? id}</span>
            {n > 0 && <span className="pdot"><span className="sr-only">, {n} proposed by agents</span></span>}
            <span className="n">{states[id]?.entity.actions.length ?? ''}</span>
          </button>
        );
      })}
      {pendingEntities.map((x) => (
        <button key={`${x.proposal.id}-${x.index}`} type="button" className="tree-item tree-proposed" onClick={onOpenInbox}>
          <span>{str(x.op.value.title) || str(x.op.value.id)}</span> <span className="tag proposed">proposed</span>
        </button>
      ))}
      <form className="tree-add" onSubmit={(e) => { e.preventDefault(); if (newEntity.trim()) void addEntity(); }}>
        <input className="text" aria-label="New object" value={newEntity} placeholder="New object" onChange={(e) => setNewEntity(e.target.value)} />
        <button className="btn small" disabled={busy || !newEntity.trim()}>Add</button>
      </form>

      <div className="tree-h">Words</div>
      <button type="button" className="tree-item" aria-current={subject === GLOSSARY ? 'true' : undefined} onClick={() => setSubject(GLOSSARY)}>
        <span>Glossary</span>
        <span className="n">{project.project.glossary.length || ''}</span>
      </button>
    </aside>
  );

  const objLint = cur ? lint.filter((l) => l.ref.includes(`:${cur.entity.id}.`) || l.ref === `entity:${cur.entity.id}`) : [];
  const liveStates = cur ? cur.entity.states.filter((x) => x.status !== 'rejected') : [];

  return (
    <div className="model-ws">
      {tree}
      <div className="model-main">
        {subject === GLOSSARY && <GlossaryView project={project} onSaved={onChanged} onError={onError} />}
        {subject && subject !== GLOSSARY && subjectPage(subject)}
        {!subject && !cur && <p className="muted">Add an object on the left, or ask an agent to research the sources.</p>}
        {!subject && cur && (
          <>
            <div className="ehead">
              <Editable as="h1" title={cur.entity.title} label={cur.entity.title} busy={busy} onSave={(t) => edit(cur.entity.id, (e) => { e.title = t; })} />
              <span className="id">{cur.entity.id}</span>
              <span className="spacer" />
              <button className="btn small ghost" aria-pressed={showHistory} onClick={() => setShowHistory(!showHistory)}>History</button>
              <DeleteButton label={cur.entity.title} busy={busy} onDelete={() => removeEntity(cur.entity.id)} />
              <button className="btn small" onClick={() => onOpenTests(cur.entity.id)}>
                Tests <span className="muted">{cur.coverage.totals.passed}/{cur.coverage.totals.scenarios}</span>
              </button>
            </div>
            <p className="origin">{originText(`entity:${cur.entity.id}`, history)}</p>
            {cur.entity.description && <p className="lede">{cur.entity.description}</p>}
            {showHistory && <HistoryList entries={history.filter((h) => h.ref === `entity:${cur.entity.id}` || h.ref.includes(`:${cur.entity.id}.`))} names={roleTitle} label={`History of ${cur.entity.title}`} />}
            {objLint.length > 0 && (
              <ul className="obj-lint" aria-label="Hard to test">
                {objLint.map((l, i) => (
                  <li key={i}><button type="button" className="link-btn" onClick={() => openRef(l.ref)}>{l.message}</button></li>
                ))}
              </ul>
            )}

            <section className="acts" aria-label="States">
              <div className="sec-head"><h2 className="sec-h">States</h2></div>
              <div className="chips state-line">
                {liveStates.map((x) => (
                  <span key={x.id} className={`chip state ${x.status}`}>
                    {x.title}
                    <button type="button" className="mini" disabled={busy} aria-label={`Delete state ${x.title}`} onClick={() => removeState(cur.entity.id, x.id)}><span aria-hidden>✕</span></button>
                  </span>
                ))}
                {!liveStates.length && <span className="muted">No states yet: add them if the object has a status that actions change.</span>}
              </div>
              <form className="tree-add act-add" onSubmit={(e) => { e.preventDefault(); if (stateText.trim()) { void addState(cur.entity.id, stateText.trim()); setStateText(''); } }}>
                <input className="text" aria-label="New state" value={stateText} placeholder="New state, e.g. Archived" onChange={(e) => setStateText(e.target.value)} />
                <button className="btn small" disabled={busy || !stateText.trim()}>Add state</button>
              </form>
            </section>

            <section className="acts" aria-label="Actions">
              <div className="sec-head">
                <h2 className="sec-h">Actions</h2>
                <ReviewLink count={pendingActions(cur.entity.id).length} onOpen={onOpenInbox} />
              </div>
              {actionList()}
            </section>

            {sel && selAction && sel.entity.id === cur.entity.id ? actionPanel(sel.entity, selAction) : (
              <p className="muted pick-hint">Pick an action to see who does it, what it changes and its rules.</p>
            )}

            <section className="acts" aria-label="Parameters">
              <div className="sec-head">
                <h2 className="sec-h">Parameters</h2>
                <ReviewLink count={pendingAttributes(cur.entity.id).length} onOpen={onOpenInbox} />
              </div>
              <AttributesTable entity={cur.entity} roles={roles} proposed={pendingAttributes(cur.entity.id)} busy={busy} onReview={onOpenInbox} onEdit={(change) => edit(cur.entity.id, change)} />
            </section>

            <TechDetails key={cur.entity.id} state={cur} project={project} onSave={(e) => act(() => api.saveEntity(e, cur.revision))} />
          </>
        )}
      </div>
    </div>
  );
}

// "N proposed · Review in Inbox" beside a section heading: agents' proposals are decided in one place.
function ReviewLink({ count, onOpen }: { count: number; onOpen(): void }) {
  if (!count) return null;
  return (
    <span className="incoming">
      <span className="tag proposed">{count} proposed</span>
      <button type="button" className="btn small" onClick={onOpen}>Review in Inbox</button>
    </span>
  );
}
