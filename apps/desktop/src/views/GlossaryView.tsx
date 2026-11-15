import { useEffect, useState } from 'react';
import type { Term } from '@tc/model';
import { api, type ProjectState } from '../api.ts';

type Props = { project: ProjectState; onSaved(): void; onError(m: string): void };

// The project's words: each term, its other names and what it means. Agents
// name things with it, and the spec lists it. Answering yes to an agent's
// "is X the same as Y?" in the Inbox adds the synonym here.
export function GlossaryView({ project, onSaved, onError }: Props) {
  const saved = project.project.glossary;
  const [draft, setDraft] = useState<Term[]>(saved);
  const [busy, setBusy] = useState(false);
  useEffect(() => setDraft(saved), [saved]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const set = (i: number, patch: Partial<Term>) => setDraft(draft.map((t, n) => (n === i ? { ...t, ...patch } : t)));
  // One word, one meaning, as validateProject checks on save.
  const words = draft.flatMap((t) => [t.term, ...t.synonyms]).map((w) => w.trim().toLowerCase()).filter(Boolean);
  const twice = [...new Set(words.filter((w, i) => words.indexOf(w) !== i))];
  const blank = draft.some((t) => !t.term.trim());

  const save = async () => {
    setBusy(true);
    try {
      await api.saveProject({ ...project.project, glossary: draft.map((t) => ({ ...t, term: t.term.trim(), synonyms: t.synonyms.map((s) => s.trim()).filter(Boolean) })) });
      onSaved();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page settings">
      <h1>Glossary</h1>
      <p className="lede">The project's words. A synonym is the same thing as its term: agents use the term and don't make a second object for the other name.</p>
      {draft.length > 0 ? (
        <table className="grid">
          <thead><tr><th>Term</th><th>Also called</th><th>Meaning</th><th /></tr></thead>
          <tbody>
            {draft.map((t, i) => (
              <tr key={i}>
                <td><input className="text" aria-label="Term" value={t.term} onChange={(e) => set(i, { term: e.target.value })} /></td>
                <td><input className="text" aria-label="Also called" placeholder="comma-separated" value={t.synonyms.join(', ')} onChange={(e) => set(i, { synonyms: e.target.value.split(',').map((s) => s.trimStart()) })} /></td>
                <td><input className="text" aria-label="Meaning" value={t.definition} onChange={(e) => set(i, { definition: e.target.value })} /></td>
                <td><button className="btn small" onClick={() => setDraft(draft.filter((_, n) => n !== i))}>Remove</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted">No terms yet. Add one, or answer an agent's “is X the same as Y?” in the Inbox.</p>
      )}
      <button className="btn small" onClick={() => setDraft([...draft, { term: '', definition: '', synonyms: [] }])}>Add term</button>
      {twice.length > 0 && <p className="muted" role="alert">“{twice.join('”, “')}” is in the glossary more than once.</p>}
      <div className="row" style={{ marginTop: 'var(--s4)' }}>
        <button className="btn primary" disabled={!dirty || busy || blank || twice.length > 0} onClick={save}>Save</button>
        {dirty && <button className="btn" disabled={busy} onClick={() => setDraft(saved)}>Discard</button>}
      </div>
    </div>
  );
}
