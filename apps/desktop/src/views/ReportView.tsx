import { useEffect, useState } from 'react';
import type { Disagreement, Lint, ReviewCell, ReviewRow, Source } from '@tc/model';
import { api, type ProposalState } from '../api.ts';

type Props = { proposals: ProposalState[]; reloadToken: number; onError(m: string): void };

const cellMark: Record<ReviewCell, { mark: string; title: string; color: string }> = {
  confirms: { mark: '✓', title: 'confirms', color: 'var(--ok)' },
  contradicts: { mark: '✕', title: 'contradicts', color: 'var(--bad)' },
  gap: { mark: '…', title: 'gap', color: 'var(--warn)' },
  question: { mark: '?', title: 'question', color: 'var(--warn)' },
};

// The review matrix: what each source says about each element of the model,
// plus the model checks found without an agent. Findings are settled in the Inbox queue.
export function ReportView({ proposals, reloadToken, onError }: Props) {
  const [data, setData] = useState<{ disagreements: Disagreement[]; lint: Lint[]; matrix: ReviewRow[]; sources: Source[]; usePriority: boolean } | null>(null);
  const load = () => api.report().then(setData).catch((e) => onError((e as Error).message));
  useEffect(() => { void load(); }, [reloadToken, proposals]);

  if (!data) return <div className="page"><p className="muted">Loading…</p></div>;
  const cols = data.sources.filter((s) => s.enabled);
  const spoken = data.matrix.filter((r) => Object.keys(r.cells).length > 0 || r.marks.app);
  const silent = data.matrix.length - spoken.length;

  return (
    <div className="page">
      <h1>By source</h1>
      <p className="lede">
        What the requirements, the code and the app say about each element of the model, then each source on its own:
        ✓ confirms, ✕ contradicts, … gap, ? question, blank says nothing. App ✓ means an agent saw the effect in the running app.
        Settle disagreements in the queue.
      </p>
      {data.lint.length > 0 && (
        <details style={{ marginTop: 12 }}>
          <summary><b>Model checks</b> <span className="muted">— {data.lint.length} places the model is hard to test, found without an agent</span></summary>
          <ul>
            {data.lint.map((l, i) => <li key={i}>{l.message} <span className="id">{l.ref}</span></li>)}
          </ul>
        </details>
      )}
      {spoken.length > 0 && (
        <section style={{ marginTop: 16 }}>
          {silent > 0 && <p className="muted">{silent} more elements no source mentions yet.</p>}
          <div style={{ overflowX: 'auto' }}>
            <table className="matrix access" aria-label="Review by source">
              <thead><tr><th>Element</th><th>Requirements</th><th>Code</th><th>App</th>{cols.map((s) => <th key={s.id}>{s.title}</th>)}</tr></thead>
              <tbody>
                {spoken.map((r) => (
                  <tr key={r.ref}>
                    <td className="name" title={r.ref}>{r.title.length > 70 ? `${r.title.slice(0, 69)}…` : r.title}</td>
                    {(['requirements', 'code'] as const).map((k) => {
                      const c = r.marks[k];
                      return <td key={k} title={c ? `${k} ${cellMark[c].title}` : `${k}: nothing`} style={{ color: c ? cellMark[c].color : undefined, fontWeight: 600 }}>{c ? cellMark[c].mark : ''}</td>;
                    })}
                    <td title={r.marks.app ? 'seen in the running app' : 'not checked in the app'} style={{ color: 'var(--ok)', fontWeight: 600 }}>{r.marks.app ? '✓' : ''}</td>
                    {cols.map((s) => {
                      const c = r.cells[s.id];
                      return <td key={s.id} title={c ? `${s.title} ${cellMark[c].title}` : `${s.title} says nothing`} style={{ color: c ? cellMark[c].color : undefined }}>{c ? cellMark[c].mark : ''}</td>;
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {spoken.length === 0 && <p className="muted">No source has said anything about the model yet. Use Ask agent › Review the model.</p>}
    </div>
  );
}
