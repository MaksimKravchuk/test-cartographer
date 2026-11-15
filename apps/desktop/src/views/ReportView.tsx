import { useEffect, useState } from 'react';
import type { Disagreement, Lint, Resolution, ReviewCell, ReviewRow, Source } from '@tc/model';
import { api, type ProposalState } from '../api.ts';

type Props = { proposals: ProposalState[]; reloadToken: number; onChanged(): void; onError(m: string): void };

const kindTitle = { contradiction: 'Sources disagree', gap: 'Gap', question: 'Question', confirmation: 'Confirmed' } as const;
const cellMark: Record<ReviewCell, { mark: string; title: string; color: string }> = {
  confirms: { mark: '✓', title: 'confirms', color: 'var(--ok)' },
  contradicts: { mark: '✕', title: 'contradicts', color: 'var(--bad)' },
  gap: { mark: '…', title: 'gap', color: 'var(--warn)' },
  question: { mark: '?', title: 'question', color: 'var(--warn)' },
};
const verdictTitle: Record<Resolution['verdict'], string> = { bug: 'Bug in the product', outdated: 'Requirements are outdated', fine: 'Not a problem' };

// What agents found when they checked the model against the sources: where
// requirements, code and the model disagree, with the quotes from each side
// and which side wins by priority. A person settles each one here.
export function ReportView({ proposals, reloadToken, onChanged, onError }: Props) {
  const [data, setData] = useState<{ disagreements: Disagreement[]; lint: Lint[]; matrix: ReviewRow[]; sources: Source[]; usePriority: boolean } | null>(null);
  const [showSettled, setShowSettled] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = () => api.report().then(setData).catch((e) => onError((e as Error).message));
  useEffect(() => { void load(); }, [reloadToken, proposals]);

  const resolve = async (d: Disagreement, verdict: Resolution['verdict'] | null) => {
    setBusy(true);
    try {
      await api.resolve(d.proposal, d.index, verdict);
      await load();
      onChanged();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!data) return <div className="page"><p className="muted">Loading…</p></div>;
  const list = data.disagreements.filter((d) => showSettled || !d.resolution);
  const count = (k: Disagreement['finding']['kind']) => data.disagreements.filter((d) => !d.resolution && d.finding.kind === k).length;
  const cols = data.sources.filter((s) => s.enabled);
  const spoken = data.matrix.filter((r) => Object.keys(r.cells).length > 0 || r.marks.app);
  const silent = data.matrix.length - spoken.length;
  const title = (id?: string) => data.sources.find((s) => s.id === id)?.title ?? id ?? 'evidence';

  return (
    <div className="page">
      <h1>Disagreements</h1>
      <p className="lede">
        Where your model, the requirements and the code don't say the same thing. Each card quotes every side;
        {data.usePriority ? ' the side with the strongest priority is marked as the one that stands.' : ' priorities are off, so every card is yours to decide.'}
      </p>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <span className="chip">{count('contradiction')} disagreements</span>
        <span className="chip">{count('gap')} gaps</span>
        <span className="chip">{count('question')} questions</span>
        <span className="spacer" />
        <label className="row" style={{ gap: 6 }}>
          <input type="checkbox" checked={showSettled} onChange={(e) => setShowSettled(e.target.checked)} /> Show settled
        </label>
      </div>
      {data.lint.length > 0 && (
        <details style={{ marginTop: 12 }}>
          <summary><b>Model checks</b> <span className="muted">— {data.lint.length} places the model is hard to test, found without an agent</span></summary>
          <ul>
            {data.lint.map((l, i) => <li key={i}>{l.message} <span className="id">{l.ref}</span></li>)}
          </ul>
        </details>
      )}
      {spoken.length > 0 && (
        <details style={{ marginTop: 12 }}>
          <summary><b>By source</b> <span className="muted">— what the requirements, the code and the app say about each element, then each source: ✓ confirms, ✕ contradicts, … gap, ? question, blank = says nothing. App ✓ means an agent saw the effect in the running app.{silent > 0 && ` ${silent} more elements no source mentions yet.`}</span></summary>
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
        </details>
      )}
      {list.length === 0 && <p className="muted">Nothing open. Use Ask agent › Review the model to check the model against the sources.</p>}
      {list.map((d) => (
        <section key={`${d.proposal}-${d.index}`} className="finding" style={{ borderLeft: `3px solid ${d.finding.kind === 'contradiction' ? 'var(--bad)' : 'var(--warn)'}`, marginTop: 12 }}>
          <div className="row">
            <b>{kindTitle[d.finding.kind]}</b>
            {d.finding.refs.map((r) => <span key={r} className="id">{r}</span>)}
            <span className="spacer" />
            <span className="muted">{new Date(d.createdAt).toLocaleString()}</span>
          </div>
          <p style={{ margin: '6px 0' }}>{d.finding.note}</p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 8 }}>
            {d.quotes.map((q) => (
              <div
                key={q.evidence.id}
                style={{ padding: 8, borderRadius: 6, border: '1px solid var(--line)', background: q.source && q.source.id === d.winner ? 'var(--ok-weak)' : 'var(--surface)' }}
              >
                <div className="row" style={{ gap: 6, fontSize: 12 }}>
                  <b>{title(q.evidence.source)}</b>
                  {q.source && data.usePriority && <span className="muted">priority {q.source.priority}</span>}
                  {q.source && q.source.id === d.winner && <span style={{ color: 'var(--ok)' }}>stands</span>}
                </div>
                <blockquote className="source-quote" style={{ margin: "6px 0 0", overflowWrap: "anywhere" }}>“{q.evidence.summary}”</blockquote>
                {q.evidence.path && <div className="id">{q.evidence.path}</div>}
              </div>
            ))}
          </div>
          <div className="row" style={{ gap: 6, marginTop: 8 }}>
            {d.resolution ? (
              <>
                <span>Settled: <b>{verdictTitle[d.resolution.verdict]}</b></span>
                <button className="btn small" disabled={busy} onClick={() => resolve(d, null)}>Reopen</button>
              </>
            ) : (
              (Object.keys(verdictTitle) as Resolution['verdict'][]).map((v) => (
                <button key={v} className={`btn small ${v === 'bug' && d.winner ? 'primary' : ''}`} disabled={busy} onClick={() => resolve(d, v)}>{verdictTitle[v]}</button>
              ))
            )}
          </div>
        </section>
      ))}
    </div>
  );
}
