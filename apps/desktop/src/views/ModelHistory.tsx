import { useState } from 'react';
import type { Author, HistoryEntry, Provenance } from '@tc/model';

// Where a model element came from and what happened to it since, from the
// workspace's history.jsonl (see packages/model/src/history.ts).

export function authorText(by: Author): string {
  if (by.kind === 'template') return 'the new-project template';
  if (by.kind === 'agent') return `agent ${by.agent ?? ''}, accepted by a person`.replace('  ', ' ');
  return 'a person';
}

const when = (at: string) => new Date(at).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

// Subjects every project used to start with: their origin predates the history.
const TEMPLATE_ROLES: Record<string, string> = { guest: 'Guest', user: 'Signed-in user' };

// One line: who added it and when. Falls back to the element's provenance, then to the template.
export function originText(ref: string, history: HistoryEntry[], provenance?: Provenance, title?: string): string {
  const added = history.find((e) => e.ref === ref && e.op === 'add');
  if (added) return `Added by ${authorText(added.by)} · ${when(added.at)}`;
  if (provenance?.source === 'agent') return `Proposed by agent ${provenance.agent ?? ''}`.trim();
  const role = /^role:(.+)$/.exec(ref)?.[1];
  if (role && TEMPLATE_ROLES[role] === title) return 'Added by the new-project template, before history was kept';
  if (provenance?.source === 'human') return 'Added by a person, before history was kept';
  return 'Added before history was kept';
}

const short = (v: unknown, names: (id: string) => string): string => {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'string') return v.length > 60 ? `${v.slice(0, 57)}…` : v;
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v.length ? v.map(names).join(', ') : 'nobody';
  return '…';
};

const OP = { add: 'added', change: 'changed', remove: 'removed' };

// The log of one element (or an object with everything in it), newest first.
// names — turns subject ids in `by` lists into their titles.
export function HistoryList({ entries, names, label = 'History' }: { entries: HistoryEntry[]; names(id: string): string; label?: string }) {
  const [all, setAll] = useState(false);
  const list = [...entries].reverse();
  const shown = all ? list : list.slice(0, 8);
  return (
    <section className="history" aria-label={label}>
      <h3>{label}</h3>
      {!list.length && <p className="muted">Nothing recorded yet: the history starts with the next change.</p>}
      <ol>
        {shown.map((e, i) => (
          <li key={i}>
            <span className="when">{when(e.at)}</span>
            <span>
              <b>{e.title}</b> {OP[e.op]} by {authorText(e.by)}
              {e.changes && (
                <span className="changes">
                  {Object.entries(e.changes).map(([field, [from, to]]) => (
                    <span key={field}>
                      {field}: {short(from, names)} → {short(to, names)}
                    </span>
                  ))}
                </span>
              )}
            </span>
          </li>
        ))}
      </ol>
      {list.length > shown.length && <button className="btn small ghost" onClick={() => setAll(true)}>Show all {list.length}</button>}
    </section>
  );
}

// A title with Rename: Enter saves, Escape cancels.
// bare — only the button, when the title is already on screen.
export function Editable({ title, label, busy, onSave, as: Tag = 'span', bare }: { title: string; label: string; busy: boolean; onSave(t: string): void; as?: 'span' | 'h1'; bare?: boolean }) {
  const [draft, setDraft] = useState<string | null>(null);
  if (draft === null)
    return (
      <>
        {!bare && <Tag>{title}</Tag>}
        <button className="btn small ghost" disabled={busy} aria-label={`Rename ${label}`} title="Rename" onClick={() => setDraft(title)}>Rename</button>
      </>
    );
  const save = () => {
    if (draft.trim() && draft.trim() !== title) onSave(draft.trim());
    setDraft(null);
  };
  return (
    <input
      className="text rename"
      autoFocus
      aria-label={`New name for ${label}`}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === 'Enter') save();
        if (e.key === 'Escape') setDraft(null);
      }}
    />
  );
}

// Delete, then "Delete X? Yes / No" in place: no browser dialog.
export function DeleteButton({ label, busy, onDelete }: { label: string; busy: boolean; onDelete(): void }) {
  const [asking, setAsking] = useState(false);
  if (!asking) return <button className="btn small ghost" disabled={busy} aria-label={`Delete ${label}`} onClick={() => setAsking(true)}>Delete</button>;
  return (
    <span className="decide" role="group" aria-label={`Delete ${label}?`}>
      <span className="muted">Delete {label}?</span>
      <button className="btn small danger" disabled={busy} onClick={() => { setAsking(false); onDelete(); }}>Delete</button>
      <button className="btn small ghost" onClick={() => setAsking(false)}>Keep</button>
    </span>
  );
}
