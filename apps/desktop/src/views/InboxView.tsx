import { useEffect, useState } from 'react';
import type { Disagreement, Lint, Resolution, Source } from '@tc/model';
import { api, type EntityState, type EntitySummary, type ProjectDecideResult, type ProjectState, type ProposalState } from '../api.ts';
import { ProposalsView } from './ProposalsView.tsx';

// Everything that waits for a person, in one queue: contradictions between
// sources, agents' questions, gaps, and proposed model changes. Pick an item
// on the left, decide on the right; a decision applies at once and the next
// item opens. J / K move through the list, B / U / N settle a finding.

type Props = {
  project: ProjectState;
  proposals: ProposalState[];
  entities: EntitySummary[];
  dirty: boolean;
  running: boolean;
  reloadToken: number;
  onDecided(s: EntityState | ProjectDecideResult): void;
  onChanged(): void;
  onError(m: string): void;
};

type Report = { disagreements: Disagreement[]; lint: Lint[]; sources: Source[]; usePriority: boolean };
type Item = { key: string; kind: 'contradiction' | 'question' | 'gap' | 'proposal'; title: string; where: string; d?: Disagreement; p?: ProposalState };
type Filter = 'all' | Item['kind'];

const verdicts: { v: Resolution['verdict']; title: string; key: string }[] = [
  { v: 'bug', title: 'Bug in the product', key: 'b' },
  { v: 'outdated', title: 'Requirements are outdated', key: 'u' },
  { v: 'fine', title: 'Not a problem', key: 'n' },
];
const verdictTitle = Object.fromEntries(verdicts.map((x) => [x.v, x.title])) as Record<Resolution['verdict'], string>;
const groups: { kind: Item['kind']; title: string }[] = [
  { kind: 'contradiction', title: 'Contradictions' },
  { kind: 'question', title: 'Questions' },
  { kind: 'gap', title: 'Gaps' },
  { kind: 'proposal', title: 'Proposed changes' },
];
const kindTag = { contradiction: 'contradicts', question: 'observed', gap: 'planned', proposal: 'proposed' } as const;
const kindWord = { contradiction: 'contradiction', question: 'question', gap: 'gap', proposal: 'proposed change' } as const;

export function InboxView(props: Props) {
  const { proposals, project, entities } = props;
  const [report, setReport] = useState<Report | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [showSettled, setShowSettled] = useState(false);
  const [current, setCurrent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => api.report().then(setReport).catch((e) => props.onError((e as Error).message));
  useEffect(() => { void load(); }, [props.reloadToken, proposals]);

  const agentTitle = (id: string) => project.project.agents.find((a) => a.id === id)?.title ?? id;
  const entityTitle = (id?: string) => (id ? (entities.find((e) => e.id === id)?.title ?? id) : 'Project');
  const where = (refs: string[], entity?: string) => {
    const m = /^(\w+):([\w-]+)\.([\w-]+)$/.exec(refs[0] ?? '');
    return m ? `${entityTitle(m[2])} · ${m[3]}` : entityTitle(entity);
  };

  const items: Item[] = [
    ...(report?.disagreements ?? [])
      .filter((d) => showSettled || !d.resolution)
      .map((d): Item => ({
        key: `f:${d.proposal}:${d.index}`,
        kind: d.finding.kind === 'contradiction' ? 'contradiction' : d.finding.kind === 'gap' ? 'gap' : 'question',
        title: d.finding.note,
        where: where(d.finding.refs, d.entity),
        d,
      })),
    ...proposals
      .filter((p) => showSettled || p.status === 'pending')
      .map((p): Item => ({ key: `p:${p.id}`, kind: 'proposal', title: agentTitle(p.agent), where: `${entityTitle(p.entity)} · ${p.ops.length} changes`, p })),
  ];
  const ordered = groups.flatMap((g) => items.filter((i) => i.kind === g.kind));
  const visible = ordered.filter((i) => filter === 'all' || i.kind === filter);
  const item = visible.find((i) => i.key === current) ?? visible[0];
  const count = (k: Item['kind']) => items.filter((i) => i.kind === k).length;

  const move = (step: number) => {
    if (!visible.length) return;
    const at = Math.max(0, visible.findIndex((i) => i.key === item?.key));
    setCurrent(visible[Math.min(visible.length - 1, Math.max(0, at + step))].key);
  };

  const resolve = async (d: Disagreement, verdict: Resolution['verdict'] | null) => {
    setBusy(true);
    try {
      // The next item opens once this one leaves the list.
      const at = visible.findIndex((i) => i.key === item?.key);
      setCurrent(visible[at + 1]?.key ?? visible[at - 1]?.key ?? null);
      await api.resolve(d.proposal, d.index, verdict);
      await load();
      props.onChanged();
    } catch (e) {
      props.onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.metaKey || e.ctrlKey || e.altKey || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) return;
      const k = e.key.toLowerCase();
      if (k === 'j') move(1);
      else if (k === 'k') move(-1);
      else if (item?.d && !item.d.resolution && !busy) {
        const v = verdicts.find((x) => x.key === k);
        if (v) void resolve(item.d, v.v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const sourceTitle = (id?: string) => report?.sources.find((s) => s.id === id)?.title ?? id ?? 'Evidence';
  const sourceKind = (id?: string) => report?.sources.find((s) => s.id === id)?.kind;

  return (
    <div className="inbox">
      <div className="inbox-list" aria-label="Queue">
        <div className="filters" role="group" aria-label="Show">
          <button aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>All {items.length}</button>
          {groups.map((g) => count(g.kind) > 0 && (
            <button key={g.kind} aria-pressed={filter === g.kind} onClick={() => setFilter(g.kind)}>{g.title} {count(g.kind)}</button>
          ))}
        </div>
        {groups.map((g) => {
          const list = visible.filter((i) => i.kind === g.kind);
          if (!list.length) return null;
          return (
            <div key={g.kind}>
              <div className={`grp ${g.kind}`}>{g.title}</div>
              {list.map((i) => (
                <button key={i.key} className="item" aria-current={item?.key === i.key ? 'true' : undefined} onClick={() => setCurrent(i.key)}>
                  <span className={i.d?.resolution || (i.p && i.p.status !== 'pending') ? 'settled' : ''}>{i.title}</span>
                  <span className="id">{i.where}</span>
                </button>
              ))}
            </div>
          );
        })}
        {report && items.length === 0 && <p className="muted empty-note">Nothing waits for you. Ask an agent to review the model, or explore the app.</p>}
        <label className="settled-toggle">
          <input type="checkbox" checked={showSettled} onChange={(e) => setShowSettled(e.target.checked)} /> Show settled
        </label>
      </div>

      <div className="inbox-detail">
        {!item && <p className="muted">{report ? 'Pick an item on the left.' : 'Loading…'}</p>}
        {item?.p && (
          <ProposalsView
            embedded
            selected={item.p.id}
            project={project}
            proposals={proposals}
            entities={entities}
            dirty={props.dirty}
            running={props.running}
            onDecided={props.onDecided}
            onError={props.onError}
          />
        )}
        {item?.d && (
          <article className="finding-detail" aria-label="Finding">
            <div className="row">
              <span className={`tag ${kindTag[item.kind]}`}>{kindWord[item.kind]}</span>
              <span className="muted">{item.where} · {agentTitle(proposals.find((p) => p.id === item.d!.proposal)?.agent ?? '')} · {new Date(item.d.createdAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}</span>
              <span className="spacer" />
              <span className="id">{visible.indexOf(item) + 1} / {visible.length}</span>
            </div>
            <p className="claim">{item.d.finding.note}</p>
            {item.d.quotes.length > 0 && (
              <div className="evidence-cols">
                {item.d.quotes.map((q) => {
                  const src = q.source;
                  const wins = !!src && src.id === item.d!.winner;
                  return (
                    <div key={q.evidence.id} className={`ev ${wins ? 'wins' : ''}`}>
                      <h3>
                        <span className={`mk ${sourceKind(q.evidence.source) === 'code' ? 'c' : ''}`}>{q.evidence.source ? (sourceKind(q.evidence.source) === 'code' ? 'C' : 'R') : 'A'}</span>
                        {sourceTitle(q.evidence.source)}
                        <span className="spacer" />
                        {src && report?.usePriority && <span className="id">{wins ? 'STANDS · ' : ''}PRIORITY {src.priority}</span>}
                      </h3>
                      <blockquote>“{q.evidence.summary}”</blockquote>
                      {q.evidence.path && <div className="id">{q.evidence.path}</div>}
                    </div>
                  );
                })}
              </div>
            )}
            <div className="decide-row">
              {item.d.resolution ? (
                <>
                  <span>Settled: <b>{verdictTitle[item.d.resolution.verdict]}</b></span>
                  <button className="btn small" disabled={busy} onClick={() => resolve(item.d!, null)}>Reopen</button>
                </>
              ) : (
                verdicts.map((x) => (
                  <button key={x.v} className={`btn ${x.v === 'bug' && item.d!.winner ? 'primary' : ''}`} disabled={busy} onClick={() => resolve(item.d!, x.v)}>
                    {x.title} <span className="kbd">{x.key.toUpperCase()}</span>
                  </button>
                ))
              )}
              <span className="spacer" />
              <span className="muted hint">
                {item.d.winner && report?.usePriority ? `${sourceTitle(item.d.winner)} stands by priority · ` : ''}
                <span className="kbd">J</span> <span className="kbd">K</span> to move
              </span>
            </div>
          </article>
        )}
      </div>
    </div>
  );
}
