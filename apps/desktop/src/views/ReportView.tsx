import { useEffect, useState } from 'react';
import type { Disagreement, Lint, ReviewCell, ReviewRow, Source } from '@tc/model';
import { api, type ProposalState } from '../api.ts';

type Props = { proposals: ProposalState[]; reloadToken: number; onError(m: string): void };

const cellMark: Record<ReviewCell, { mark: string; title: string; tone: string }> = {
  confirms: { mark: '✓', title: 'confirms', tone: 't-ok' },
  contradicts: { mark: '✕', title: 'contradicts', tone: 't-bad' },
  gap: { mark: '…', title: 'gap', tone: 't-warn' },
  question: { mark: '?', title: 'question', tone: 't-warn' },
};

// A mark is a glyph on screen and a word for screen readers; the column header says whose.
function Mark({ c, strong }: { c?: ReviewCell; strong?: boolean }) {
  if (!c) return <td />;
  return (
    <td className={`mark ${strong ? 'strong' : ''} ${cellMark[c].tone}`}>
      <span aria-hidden>{cellMark[c].mark}</span>
      <span className="sr-only">{cellMark[c].title}</span>
    </td>
  );
}

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
        <details className="lint">
          <summary><b>Model checks</b> <span className="muted">— {data.lint.length} places the model is hard to test, found without an agent</span></summary>
          <ul>
            {data.lint.map((l, i) => <li key={i}>{l.message} <span className="id">{l.ref}</span></li>)}
          </ul>
        </details>
      )}
      {spoken.length > 0 && (
        <section className="review">
          {silent > 0 && <p className="muted">{silent} more elements no source mentions yet.</p>}
          <div className="table-scroll" role="region" aria-label="Review by source, scrolls sideways" tabIndex={0}>
            <table className="matrix access" aria-label="Review by source">
              <thead><tr><th scope="col">Element</th><th scope="col">Requirements</th><th scope="col">Code</th><th scope="col">App</th>{cols.map((s) => <th key={s.id} scope="col">{s.title}</th>)}</tr></thead>
              <tbody>
                {spoken.map((r) => (
                  <tr key={r.ref}>
                    <th scope="row" className="name">{r.title}</th>
                    {(['requirements', 'code'] as const).map((k) => <Mark key={k} c={r.marks[k]} strong />)}
                    <td className="mark strong t-ok">{r.marks.app && <><span aria-hidden>✓</span><span className="sr-only">seen in the running app</span></>}</td>
                    {cols.map((s) => <Mark key={s.id} c={r.cells[s.id]} />)}
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
