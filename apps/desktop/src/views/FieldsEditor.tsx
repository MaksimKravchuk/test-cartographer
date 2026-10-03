import { useEffect, useState } from 'react';
import type { Field } from '@tc/model';
import { nextId } from '../graph.ts';

type Props = {
  owner: 'roles' | 'entities';
  ownerId: string;
  fields: Field[];
  // Where the values end up, for the plain-text warning.
  file: string;
  // Rejects when saving failed; the caller reports the error, the editor stays open.
  onSave(fields: Field[]): Promise<void>;
};

const KEY = /^[a-z][a-z0-9_-]*$/;
// Typing keeps a key close to a valid id: lowercase, spaces become "-".
const toKey = (s: string) => s.toLowerCase().replace(/\s+/g, '-');

// Data a person attaches to a subject or an object: shown read-only with
// secrets masked, edited as a draft list that is saved as a whole.
export function FieldsEditor({ owner, ownerId, fields, file, onSave }: Props) {
  const [draft, setDraft] = useState<Field[] | null>(null);
  const [shown, setShown] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setDraft(null);
    setShown(new Set());
  }, [owner, ownerId]);

  const ref = (id: string) => `{{${owner}.${ownerId}.${id}}}`;

  if (!draft)
    return (
      <>
        {fields.length === 0 && (
          <p className="muted" style={{ margin: '0 0 8px' }}>No data yet: a login, a test card, a promo code — whatever an agent or a test needs here.</p>
        )}
        {fields.map((f) => (
          <div key={f.id} className="data-row">
            <span className="id" title={`Agents and tests refer to it as ${ref(f.id)}`}>{f.id}</span>
            <span className="data-value">
              {f.secret && !shown.has(f.id) ? '••••••' : f.value || <span className="muted">empty</span>}
            </span>
            {f.secret ? (
              <button
                className="btn link"
                onClick={() => setShown((s) => (s.has(f.id) ? new Set([...s].filter((x) => x !== f.id)) : new Set([...s, f.id])))}
              >
                {shown.has(f.id) ? 'hide' : 'show'}
              </button>
            ) : <span />}
            {f.note && <span className="data-note muted">{f.note}</span>}
          </div>
        ))}
        <button className="btn small" style={{ marginTop: 6 }} onClick={() => setDraft(fields)}>{fields.length ? 'Edit data' : 'Add data'}</button>
      </>
    );

  const keys = draft.map((f) => f.id);
  const invalid = draft.some((f, i) => !KEY.test(f.id) || keys.indexOf(f.id) !== i);
  const set = (i: number, patch: Partial<Field>) => setDraft(draft.map((f, n) => (n === i ? { ...f, ...patch } : f)));

  const save = async () => {
    setBusy(true);
    try {
      await onSave(draft.map((f) => ({ ...f, note: f.note?.trim() || undefined })));
      setDraft(null);
    } catch {
      // Reported by the caller; keep the draft so nothing typed is lost.
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {draft.map((f, i) => (
        <div key={i} className="data-edit">
          <div className="row">
            <input className="text id" aria-label="Key" placeholder="login" value={f.id} onChange={(e) => set(i, { id: toKey(e.target.value) })} />
            <button className="btn small" onClick={() => setDraft(draft.filter((_, n) => n !== i))}>Remove</button>
          </div>
          <input
            className="text"
            aria-label="Value"
            type={f.secret ? 'password' : 'text'}
            autoComplete={f.secret ? 'new-password' : 'off'}
            placeholder="value, or {{env.NAME}}"
            value={f.value}
            onChange={(e) => set(i, { value: e.target.value })}
          />
          <label className="check">
            <input type="checkbox" checked={f.secret} onChange={(e) => set(i, { secret: e.target.checked })} />
            Secret — agents see only <span className="id">{ref(f.id || 'key')}</span>
          </label>
          <input className="text" aria-label="Note" placeholder="Note for the agent (optional)" value={f.note ?? ''} onChange={(e) => set(i, { note: e.target.value })} />
        </div>
      ))}
      <button className="btn small" style={{ marginTop: 8 }} onClick={() => setDraft([...draft, { id: nextId('field', keys), value: '', secret: false }])}>
        Add field
      </button>
      {invalid && (
        <p style={{ color: 'var(--fail)', fontSize: 12.5, margin: '8px 0 0' }}>
          A key is lowercase Latin letters, digits, “-” and “_”, starts with a letter, and is used once.
        </p>
      )}
      <p className="muted" style={{ fontSize: 12, margin: '8px 0' }}>
        Saved as plain text in <span className="id">{file}</span>. For a real account put <span className="id">{'{{env.NAME}}'}</span> as the value
        and set the variable where the engine runs.
      </p>
      <div className="row">
        <button className="btn small primary" disabled={busy || invalid} onClick={save}>Save data</button>
        <button className="btn small" onClick={() => setDraft(null)}>Cancel</button>
      </div>
    </>
  );
}
