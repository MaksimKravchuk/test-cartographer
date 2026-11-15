import { useEffect, useState } from 'react';
import type { Disagreement, Lint, Resolution, Source } from '@tc/model';
import { api, type ProposalState } from '../api.ts';

type Props = { proposals: ProposalState[]; reloadToken: number; onChanged(): void; onError(m: string): void };

const kindTitle = { contradiction: 'Sources disagree', gap: 'Gap', question: 'Question' } as const;
const verdictTitle: Record<Resolution['verdict'], string> = { bug: 'Bug in the product', outdated: 'Requirements are outdated', fine: 'Not a problem' };

// What agents found when they checked the model against the sources: where
// requirements, code and the model disagree, with the quotes from each side
// and which side wins by priority. A person settles each one here.
export function ReportView({ proposals, reloadToken, onChanged, onError }: Props) {
  const [data, setData] = useState<{ disagreements: Disagreement[]; lint: Lint[]; sources: Source[]; usePriority: boolean } | null>(null);
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
      {list.length === 0 && <p className="muted">Nothing open. Run “Review the model” on the Model page to check it against the sources.</p>}
      {list.map((d) => (
        <section key={`${d.proposal}-${d.index}`} className="finding" style={{ borderLeft: `3px solid ${d.finding.kind === 'contradiction' ? 'var(--fail)' : 'var(--observed)'}`, marginTop: 12 }}>
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
                style={{ padding: 8, borderRadius: 6, border: '1px solid var(--rule)', background: q.source && q.source.id === d.winner ? 'var(--pass-wash)' : 'var(--sheet)' }}
              >
                <div className="row" style={{ gap: 6, fontSize: 12 }}>
                  <b>{title(q.evidence.source)}</b>
                  {q.source && data.usePriority && <span className="muted">priority {q.source.priority}</span>}
                  {q.source && q.source.id === d.winner && <span style={{ color: 'var(--pass)' }}>stands</span>}
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
