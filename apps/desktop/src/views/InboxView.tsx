import { useEffect, useState } from 'react';
import type { Disagreement, Lint, Resolution, Source } from '@tc/model';
import { api, type EntityState, type EntitySummary, type ProjectDecideResult, type ProjectState, type ProposalState } from '../api.ts';
import { ProposalsView } from './ProposalsView.tsx';
import { Tip } from '../ui.tsx';

// Everything that waits for a person, in one queue: contradictions between
// sources, agents' questions, gaps, problems reading a source, and proposed
// model changes. Pick an item on the left, decide on the right; a decision
// applies at once and the next item opens. J / K move through the list, and
// each kind of finding has its own answers and keys. When an item can't be
// answered as written, M asks an agent for more context: it digs into the
// sources and replaces the item with answerable, single-topic ones.

type Props = {
  project: ProjectState;
  proposals: ProposalState[];
  entities: EntitySummary[];
  dirty: boolean;
  running: boolean;
  // An agent is digging into a finding right now.
  clarifying: boolean;
  onClarify(target: { proposal: string; index: number }): void;
  reloadToken: number;
  onDecided(s: EntityState | ProjectDecideResult): void;
  onChanged(): void;
  onError(m: string): void;
};

type Report = { disagreements: Disagreement[]; lint: Lint[]; sources: Source[]; usePriority: boolean };
type FindingKind = 'contradiction' | 'question' | 'gap' | 'source';
// sources: what the item quotes; the app itself (an explorer's evidence) counts as no source.
type Item = { key: string; kind: FindingKind | 'proposal'; title: string; where: string; sources: string[]; d?: Disagreement; p?: ProposalState };
type Filter = 'all' | Item['kind'];

type Answer = { v: Resolution['verdict']; title: string; key: string; note?: string };
const triad: Answer[] = [
  { v: 'bug', title: 'Bug in the product', key: 'b' },
  { v: 'outdated', title: 'Requirements are outdated', key: 'u' },
  { v: 'fine', title: 'Not a problem', key: 'n' },
];
// The answers that fit each kind: a question is answered, a source problem is fixed or meant.
const answersFor = (d: Disagreement): Answer[] => {
  const kind = findingKind(d);
  // An agent's own options come first: it knows what answers fit its question.
  if (kind === 'question' && d.finding.options?.length)
    return d.finding.options.map((o, i) => ({ v: 'answered' as const, title: o, key: String(i + 1), note: o }));
  if (kind === 'question')
    return d.finding.synonym
      ? [{ v: 'yes', title: 'Yes, the same thing', key: 'y' }, { v: 'no', title: 'No, different things', key: 'n' }]
      : [{ v: 'yes', title: 'Yes', key: 'y' }, { v: 'no', title: 'No', key: 'n' }];
  if (kind === 'source') return [{ v: 'fixed', title: 'Fixed, read it again next run', key: 'f' }, { v: 'excluded', title: 'Left out on purpose', key: 'x' }];
  return triad;
};
const verdictTitle: Record<Resolution['verdict'], string> = {
  bug: 'Bug in the product', outdated: 'Requirements are outdated', fine: 'Not a problem',
  yes: 'Yes', no: 'No', answered: 'Answered', fixed: 'Fixed', excluded: 'Left out on purpose', clarified: 'Replaced with more context',
};
const findingKind = (d: Disagreement): FindingKind =>
  d.finding.kind === 'contradiction' || d.finding.kind === 'gap' || d.finding.kind === 'source' ? d.finding.kind : 'question';
const groups: { kind: Item['kind']; title: string }[] = [
  { kind: 'source', title: 'Source problems' },
  { kind: 'contradiction', title: 'Contradictions' },
  { kind: 'question', title: 'Questions' },
  { kind: 'gap', title: 'Gaps' },
  { kind: 'proposal', title: 'Proposed changes' },
];
const kindTag = { contradiction: 'contradicts', question: 'observed', gap: 'planned', source: 'planned', proposal: 'proposed' } as const;
const kindWord = { contradiction: 'contradiction', question: 'question', gap: 'gap', source: 'source problem', proposal: 'proposed change' } as const;

export function InboxView(props: Props) {
  const { proposals, project, entities } = props;
  const [report, setReport] = useState<Report | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  // Only what one source says, instead of a separate by-source page.
  const [source, setSource] = useState('');
  const [showSettled, setShowSettled] = useState(false);
  const [current, setCurrent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState('');
  // The finding an agent was last asked to clarify, to say so on it while it works.
  const [asked, setAsked] = useState<string | null>(null);

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
        kind: findingKind(d),
        title: d.finding.note,
        where: where(d.finding.refs, d.entity),
        sources: d.quotes.flatMap((q) => (q.evidence.source ? [q.evidence.source] : [])),
        d,
      })),
    ...proposals
      .filter((p) => showSettled || p.status === 'pending')
      .map((p): Item => ({ key: `p:${p.id}`, kind: 'proposal', title: agentTitle(p.agent), where: `${entityTitle(p.entity)} · ${p.ops.length} changes`, sources: p.evidence.flatMap((e) => (e.source ? [e.source] : [])), p })),
  ];
  const ordered = groups.flatMap((g) => items.filter((i) => i.kind === g.kind));
  const quoted = (report?.sources ?? []).filter((x) => items.some((i) => i.sources.includes(x.id)));
  // A source whose last item was settled stops filtering, so the select can't hide a filter still in force.
  const from = quoted.some((x) => x.id === source) ? source : '';
  const visible = ordered.filter((i) => (filter === 'all' || i.kind === filter) && (!from || i.sources.includes(from)));
  const item = visible.find((i) => i.key === current) ?? visible[0];
  const count = (k: Item['kind']) => items.filter((i) => i.kind === k).length;
  useEffect(() => setAnswer(''), [item?.key]);

  const move = (step: number) => {
    if (!visible.length) return;
    const at = Math.max(0, visible.findIndex((i) => i.key === item?.key));
    setCurrent(visible[Math.min(visible.length - 1, Math.max(0, at + step))].key);
  };

  const clarify = (it: Item) => {
    if (!it.d || props.running) return;
    setAsked(it.key);
    props.onClarify({ proposal: it.d.proposal, index: it.d.index });
  };

  const resolve = async (d: Disagreement, verdict: Resolution['verdict'] | null, note?: string) => {
    setBusy(true);
    try {
      // The next item opens once this one leaves the list.
      const at = visible.findIndex((i) => i.key === item?.key);
      setCurrent(visible[at + 1]?.key ?? visible[at - 1]?.key ?? null);
      await api.resolve(d.proposal, d.index, verdict, note);
      setAnswer('');
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
      else if (k === 'm' && item?.d && !item.d.resolution) clarify(item);
      else if (item?.d && !item.d.resolution && !busy) {
        const v = answersFor(item.d).find((x) => x.key === k);
        if (v) void resolve(item.d, v.v, v.note);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const sourceTitle = (id?: string) => report?.sources.find((s) => s.id === id)?.title ?? id ?? 'Evidence';
  const sourceKind = (id?: string) => report?.sources.find((s) => s.id === id)?.kind;

  return (
    <div className="inbox">
      <section className="inbox-list" aria-label="Queue">
        <div className="filters" role="group" aria-label="Show">
          <button aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>All {items.length}</button>
          {groups.map((g) => count(g.kind) > 0 && (
            <button key={g.kind} aria-pressed={filter === g.kind} onClick={() => setFilter(g.kind)}>{g.title} {count(g.kind)}</button>
          ))}
          {quoted.length > 0 && (
            <select className="text source-filter" aria-label="Source" value={from} onChange={(e) => setSource(e.target.value)}>
              <option value="">Any source</option>
              {quoted.map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}
            </select>
          )}
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
      </section>

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
            {item.d.finding.synonym && !item.d.resolution && (
              <p className="muted">Yes adds “{item.d.finding.synonym.synonym}” to the glossary as another name for “{item.d.finding.synonym.term}”.</p>
            )}
            {props.clarifying && asked === item.key && !item.d.resolution && (
              <p className="muted" role="status">An agent is looking into this. Its questions show up in the queue, and this one closes when they do.</p>
            )}
            {item.kind === 'source' && !item.d.resolution && (
              <p className="muted">This is about what the agent could read, not about the product. Check the source on the Sources page, then mark it fixed so the next run reads it again.</p>
            )}
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
                  <span>Settled: <b>{verdictTitle[item.d.resolution.verdict]}</b>{item.d.resolution.note ? ` · ${item.d.resolution.note}` : ''}</span>
                  <button className="btn small" disabled={busy} onClick={() => resolve(item.d!, null)}>Reopen</button>
                </>
              ) : (
                <>
                  {answersFor(item.d).map((x) => (
                    <button key={x.key} className={`btn ${x.v === 'bug' && item.d!.winner ? 'primary' : ''}`} disabled={busy} onClick={() => resolve(item.d!, x.v, x.note)}>
                      {x.title} <span className="kbd">{x.key.toUpperCase()}</span>
                    </button>
                  ))}
                  {item.kind === 'question' && (
                    <form className="answer" onSubmit={(e) => { e.preventDefault(); if (answer.trim()) void resolve(item.d!, 'answered', answer.trim()); }}>
                      <input className="text" aria-label="Your answer" placeholder="Or answer in your own words" value={answer} onChange={(e) => setAnswer(e.target.value)} />
                      <button className="btn" disabled={busy || !answer.trim()}>Answer</button>
                    </form>
                  )}
                </>
              )}
              {!item.d.resolution && (
                <Tip tip="An agent digs into the sources and rewrites this so you can answer it">
                  <button type="button" className="btn" disabled={busy || props.running} onClick={() => clarify(item)}>
                    Need more context <span className="kbd">M</span>
                  </button>
                </Tip>
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
