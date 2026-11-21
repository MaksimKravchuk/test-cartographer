// Parts of an object's page on the Model screen: its parameters (attributes)
// with who may change each. Each tick and each missing tick is a test: a
// subject that may change something, or one that must be refused.
import { useRef, useState } from 'react';
import type { Attribute, AttributeType, Entity, Role } from '@tc/model';
import { Tip } from '../ui.tsx';

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

// Row keys for proposals: the id an item will have once accepted, unless the model or an earlier
// proposal already holds that id — then the proposal's own key, so every proposal keeps its row.
export function rowKeys<T>(items: T[], id: (x: T) => string, own: (x: T) => string, taken: string[]): Map<T, string> {
  const used = new Set(taken);
  return new Map(items.map((x) => {
    const k = id(x) && !used.has(id(x)) ? id(x) : own(x);
    used.add(k);
    return [x, k];
  }));
}

// A row that was here when the object opened and has since been decided away.
export const GoneRow = ({ title, cols }: { title: string; cols: number }) => (
  <tr className="gone">
    <th scope="row"><s>{title}</s> <span className="muted nobody">struck out or deleted</span></th>
    <td colSpan={cols} />
  </tr>
);

export type ProposedAttribute = { key: string; value: Record<string, unknown>; agent: string; rationale: string };

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
  // Agents' proposals are decided in the Inbox.
  onReview(): void;
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
  const keys = rowKeys(props.proposed, (x) => str(x.value.id), (x) => x.key, live.map((a) => a.id));
  const keyOf = (x: ProposedAttribute) => keys.get(x)!;
  const rows = useStableRows(entity.id, [...live.map((a) => ({ key: a.id, title: a.title })), ...props.proposed.map((x) => ({ key: keyOf(x), title: str(x.value.title) || str(x.value.id) }))]);

  return (
    <div className="act-table-wrap">
      <p className="muted hint-line">A tick: that subject may change the parameter. No tick: the app must refuse it.</p>
      <table className="act-table attr-table">
        <thead>
          <tr>
            <th scope="col">Parameter</th>
            <th scope="col">Type</th>
            <th scope="col">Values</th>
            {roles.map((r) => (
              <th key={r.id} scope="col" className="who">{r.title}</th>
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
                    checked={(a.by ?? []).includes(r.id)}
                    disabled={busy}
                    onChange={() => toggle(a, r.id)}
                  />
                </td>
              ))}
              <td className="row-x">
                <Tip tip="Delete the parameter"><button type="button" className="mini" disabled={busy} aria-label={`Delete parameter ${a.title}`} onClick={() => props.onEdit((e) => { e.attributes = e.attributes.filter((x) => x.id !== a.id); })}><span aria-hidden>✕</span></button></Tip>
              </td>
            </tr>
            );
            if (x) return (
            <tr key={row.key} className="proposed">
              <th scope="row">
                <span className="chip proposed">{str(x.value.title) || str(x.value.id)}</span> <span className="id">{str(x.value.id)}</span>
                <span className="muted nobody"> proposed by {x.agent} </span>
                {x.rationale && <Tip toggle tip={x.rationale}><button type="button" className="btn link small">Why?</button></Tip>}
                {str(x.value.note) && <div className="muted attr-note">{str(x.value.note)}</div>}
              </th>
              <td>{str(x.value.type) || 'text'}</td>
              <td className="attr-values">{valuesText(x.value)}</td>
              {roles.map((r) => (
                <td key={r.id} className="who">{list(x.value.by).includes(r.id) ? <><span aria-hidden>✓</span><span className="sr-only">The agent says {r.title} may change it</span></> : null}</td>
              ))}
              <td className="row-x">
                <button type="button" className="btn small" onClick={props.onReview}>Review in Inbox</button>
              </td>
            </tr>
            );
            return <GoneRow key={row.key} title={row.title} cols={roles.length + 3} />;
          })}
        </tbody>
      </table>
      {!live.length && !props.proposed.length && <p className="muted attr-empty">No parameters yet. Add the ones people change (status, price, title) or ask an agent to read them from the code.</p>}
      <form className="tree-add act-add" onSubmit={(e) => { e.preventDefault(); add(); }}>
        <input className="text" aria-label="New parameter" value={title} placeholder="New parameter, e.g. Price" onChange={(e) => setTitle(e.target.value)} />
        <select className="text" aria-label="Type" value={type} onChange={(e) => setType(e.target.value as AttributeType)}>
          {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        {type === 'enum' && <input className="text" aria-label="Values" value={values} placeholder="Values, comma-separated" onChange={(e) => setValues(e.target.value)} />}
        <button className="btn small" disabled={busy || !title.trim()}>Add parameter</button>
      </form>
    </div>
  );
}
