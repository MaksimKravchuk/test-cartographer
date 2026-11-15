// Parts of an object's page on the Model screen: its parameters (attributes)
// with who may change each, and the lifecycle of every status-like parameter
// as a from × to table. Each tick and each empty cell is a test: a subject
// that may change something, or one that must be refused.
import { useRef, useState } from 'react';
import type { Attribute, AttributeType, Entity, Role, Transition } from '@tc/model';
import { lifecycleOrder } from './LifecycleView.tsx';

const NEW = '@new';
const TYPES: AttributeType[] = ['text', 'number', 'money', 'date', 'bool', 'enum', 'link', 'file', 'other'];

// Rows keep the place they had when the object opened, so deciding one never moves the rest under the cursor:
// an accepted proposal becomes a normal row in place, and a row that leaves (struck out, deleted) stays as a
// dimmed line until another object is opened. Returns every key seen, in first-seen order, with its last title.
export function useStableRows(scope: string, rows: { key: string; title: string }[]): { key: string; title: string; gone: boolean }[] {
  const ref = useRef({ scope, order: [] as string[], titles: new Map<string, string>() });
  if (ref.current.scope !== scope) ref.current = { scope, order: [], titles: new Map() };
  const { order, titles } = ref.current;
  for (const r of rows) {
    if (!titles.has(r.key)) order.push(r.key);
    titles.set(r.key, r.title);
  }
  const live = new Set(rows.map((r) => r.key));
  return order.map((key) => ({ key, title: titles.get(key)!, gone: !live.has(key) }));
}

// The "N new incoming · Accept all · Strike out all" line beside a section heading.
export function Incoming({ count, busy, blocked, onAll }: { count: number; busy: boolean; blocked: boolean; onAll(v: 'accept' | 'reject'): void }) {
  if (!count) return null;
  return (
    <span className="incoming">
      <span className="tag proposed">{count} new incoming</span>
      <button className="btn small" disabled={busy || blocked} onClick={() => onAll('accept')}>Accept all</button>
      <button className="btn small ghost" disabled={busy || blocked} title="Strike out: agents won't propose them again" onClick={() => onAll('reject')}>Strike out all</button>
    </span>
  );
}

// A row that was here when the object opened and has since been decided away.
export const GoneRow = ({ title, cols }: { title: string; cols: number }) => (
  <tr className="gone">
    <th scope="row"><s>{title}</s> <span className="muted nobody">struck out or deleted</span></th>
    <td colSpan={cols} />
  </tr>
);

export type ProposedAttribute = { key: string; value: Record<string, unknown>; agent: string; rationale: string; blocked: boolean; onDecide(v: 'accept' | 'reject'): void };

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

const slug = (title: string, taken: string[]) => {
  const base = title.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  let id = /^[a-z]/.test(base) ? base : `field_${base || 'x'}`;
  for (let n = 2; taken.includes(id); n++) id = `${base}_${n}`;
  return id;
};

const valuesText = (a: { type?: unknown; values?: unknown; entity?: unknown }) =>
  a.type === 'enum' ? list(a.values).join(', ') : a.type === 'link' ? (str(a.entity) ? `→ ${str(a.entity)}` : '') : '';

export function AttributesTable(props: {
  entity: Entity;
  roles: Role[];
  proposed: ProposedAttribute[];
  busy: boolean;
  onEdit(change: (e: Entity) => void): void;
}) {
  const { entity, roles, busy } = props;
  const [title, setTitle] = useState('');
  const [type, setType] = useState<AttributeType>('text');
  const [values, setValues] = useState('');
  const toggle = (a: Attribute, role: string) =>
    props.onEdit((e) => {
      const x = e.attributes.find((y) => y.id === a.id)!;
      const by = new Set(x.by ?? []);
      if (by.has(role)) by.delete(role);
      else by.add(role);
      x.by = [...by];
    });
  const add = () => {
    const t = title.trim();
    if (!t) return;
    props.onEdit((e) => {
      const a: Attribute = { id: slug(t, e.attributes.map((x) => x.id)), title: t, type, status: 'confirmed', provenance: { source: 'human', evidence: [], sources: [] } };
      if (type === 'enum') a.values = values.split(',').map((v) => v.trim()).filter(Boolean);
      e.attributes.push(a);
    });
    setTitle('');
    setValues('');
  };
  const live = entity.attributes.filter((a) => a.status !== 'rejected');
  // A proposal's row takes the id it will have once accepted, so accepting it keeps its place.
  const keyOf = (x: ProposedAttribute) => (str(x.value.id) && !live.some((a) => a.id === x.value.id) ? str(x.value.id) : x.key);
  const rows = useStableRows(entity.id, [...live.map((a) => ({ key: a.id, title: a.title })), ...props.proposed.map((x) => ({ key: keyOf(x), title: str(x.value.title) || str(x.value.id) }))]);

  return (
    <div className="act-table-wrap">
      <table className="act-table attr-table">
        <thead>
          <tr>
            <th scope="col">Parameter</th>
            <th scope="col">Type</th>
            <th scope="col">Values</th>
            {roles.map((r) => (
              <th key={r.id} scope="col" className="who" title={`Ticked: ${r.title} may change it. Unticked: must be refused.`}>{r.title}</th>
            ))}
            <th aria-label="Row actions" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const a = live.find((x) => x.id === row.key);
            const x = props.proposed.find((y) => keyOf(y) === row.key);
            if (a) return (
            <tr key={a.id} className={a.status}>
              <th scope="row">
                {a.title} <span className="id">{a.id}</span>
                {a.note && <div className="muted attr-note">{a.note}</div>}
                {a.by === undefined && <div className="muted attr-note">who may change it: not decided yet</div>}
              </th>
              <td>{a.type}</td>
              <td className="attr-values">{valuesText(a)}</td>
              {roles.map((r) => (
                <td key={r.id} className="who">
                  <input
                    type="checkbox"
                    aria-label={`${r.title} can change ${a.title}`}
                    title={(a.by ?? []).includes(r.id) ? `${r.title} may change it: untick and it must be refused` : `Tick: ${r.title} may change it`}
                    checked={(a.by ?? []).includes(r.id)}
                    disabled={busy}
                    onChange={() => toggle(a, r.id)}
                  />
                </td>
              ))}
              <td className="row-x">
                <button className="mini" disabled={busy} aria-label={`Delete parameter ${a.title}`} title="Delete the parameter" onClick={() => props.onEdit((e) => { e.attributes = e.attributes.filter((x) => x.id !== a.id); })}>✕</button>
              </td>
            </tr>
            );
            if (x) return (
            <tr key={row.key} className="proposed" title={x.rationale}>
              <th scope="row">
                <span className="chip proposed">{str(x.value.title) || str(x.value.id)}</span> <span className="id">{str(x.value.id)}</span>
                <span className="muted nobody"> proposed by {x.agent}</span>
                {str(x.value.note) && <div className="muted attr-note">{str(x.value.note)}</div>}
              </th>
              <td>{str(x.value.type) || 'text'}</td>
              <td className="attr-values">{valuesText(x.value)}</td>
              {roles.map((r) => (
                <td key={r.id} className="who">{list(x.value.by).includes(r.id) ? <span title={`The agent says ${r.title} may change it`}>✓</span> : null}</td>
              ))}
              <td className="row-x">
                <span className="decide">
                  <button className="btn small" disabled={busy || x.blocked} onClick={() => x.onDecide('accept')}>Accept</button>
                  <button className="btn small ghost" disabled={busy || x.blocked} title="Strike out: agents won't propose it again" onClick={() => x.onDecide('reject')}>Strike out</button>
                </span>
              </td>
            </tr>
            );
            return <GoneRow key={row.key} title={row.title} cols={roles.length + 3} />;
          })}
        </tbody>
      </table>
      {!live.length && !props.proposed.length && <p className="muted attr-empty">No parameters yet. Add the ones people change (status, price, title) or ask an agent to read them from the code.</p>}
      <div className="tree-add act-add">
        <input className="text" aria-label="New parameter" value={title} placeholder="New parameter, e.g. Price" onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
        <select className="text" aria-label="Type" value={type} onChange={(e) => setType(e.target.value as AttributeType)}>
          {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        {type === 'enum' && <input className="text" aria-label="Values" value={values} placeholder="Values, comma-separated" onChange={(e) => setValues(e.target.value)} />}
        <button className="btn small" disabled={busy || !title.trim()} onClick={add}>Add parameter</button>
      </div>
    </div>
  );
}

// The lifecycles of an object: one per enum parameter that states match on;
// an object whose states name no parameter gets one table of all its states.
export function lifecycles(entity: Entity): { title: string; states: string[] }[] {
  const live = entity.states.filter((s) => s.status !== 'rejected');
  const out = entity.attributes
    .filter((a) => a.type === 'enum' && a.status !== 'rejected')
    .map((a) => ({ title: a.title, states: live.filter((s) => a.id in s.match).map((s) => s.id) }))
    .filter((l) => l.states.length > 0);
  if (!out.length && live.length) out.push({ title: 'States', states: live.map((s) => s.id) });
  return out;
}

export function LifecycleTables(props: { entity: Entity; roles: Role[]; onPick(action: string): void }) {
  const { entity } = props;
  const all = lifecycles(entity);
  if (!all.length) return null;
  const roleTitle = (id: string) => props.roles.find((r) => r.id === id)?.title ?? id;
  const actionTitle = (id: string) => entity.actions.find((a) => a.id === id)?.title || id;
  const stateTitle = (id: string) => (id === NEW ? 'New' : entity.states.find((s) => s.id === id)?.title || id);
  const live = entity.transitions.filter((t) => t.status !== 'rejected');
  return (
    <>
      {all.map((l) => {
        const inside = new Set(l.states);
        const ts = live.filter((t) => inside.has(t.to) && (inside.has(t.from) || t.from === NEW));
        const order = lifecycleOrder(
          [...(ts.some((t) => t.from === NEW) ? [{ id: NEW }] : []), ...entity.states.filter((s) => inside.has(s.id))],
          ts,
        );
        const cols = order.filter((id) => id !== NEW);
        const at = (from: string, to: string) => ts.filter((t) => t.from === from && t.to === to);
        const who = (t: Transition) => (t.by.length === 1 ? roleTitle(t.by[0]) : t.by.length ? `${t.by.length} subjects` : 'nobody');
        return (
          <div key={l.title} className="lc-block">
            <h3>{l.title}: where it can go</h3>
            <div className="act-table-wrap">
              <table className="act-table lc-mini" aria-label={`${l.title} transitions`}>
                <thead>
                  <tr>
                    <th scope="col" className="muted">from ↓ to →</th>
                    {cols.map((id) => <th key={id} scope="col">{stateTitle(id)}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {order.map((from) => (
                    <tr key={from}>
                      <th scope="row">{stateTitle(from)}</th>
                      {cols.map((to) => {
                        const xs = at(from, to);
                        if (!xs.length)
                          return (
                            <td key={to} className={from === to ? 'lc-diag' : 'lc-none'} title={from === to ? undefined : `${stateTitle(from)} → ${stateTitle(to)} must be impossible`}>
                              {from === to ? '' : '—'}
                            </td>
                          );
                        return (
                          <td key={to}>
                            {xs.map((t) => (
                              <button key={t.id} className={`lc-pill ${t.status}`} title={`${t.title}\nby ${t.by.map(roleTitle).join(', ')}`} onClick={() => props.onPick(t.action)}>
                                {actionTitle(t.action)} <span className="muted">{who(t)}</span>
                              </button>
                            ))}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
    </>
  );
}
