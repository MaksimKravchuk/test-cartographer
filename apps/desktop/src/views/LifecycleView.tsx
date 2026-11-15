// The object's lifecycle as a table: states are columns left to right in the
// order an instance goes through them; each transition is a row with an arrow
// from its column to the target's, and under the arrow who may do it and the
// rules, conditions and effects that apply. Reads top to bottom like a spec.
import type { Entity, State, Transition } from '@tc/model';
import type { EntityState, ProjectState } from '../api.ts';
import { applies, type Selection } from '../graph.ts';

type Ghost = { proposal: string; op: number };
export type LifecycleItem = { transition: Transition; ghost?: Ghost };
export type LifecycleState = { state: State; ghost?: Ghost };

type Props = {
  entity: Entity;
  state: EntityState;
  project: ProjectState;
  states: LifecycleState[];
  items: LifecycleItem[];
  variant: string | null;
  selection: Selection;
  onSelect(s: Selection): void;
  onDecide?(ops: Ghost[], verdict: 'accept' | 'reject'): void;
  resultOf(id: string): string | null;
};

const NEW = '@new';

// Column order: breadth-first from where instances start, terminal states last.
export function lifecycleOrder(states: { id: string; initial?: boolean; terminal?: boolean }[], edges: { from: string; to: string }[]): string[] {
  const ids = states.map((s) => s.id);
  const starts = ids.includes(NEW) ? [NEW] : states.filter((s) => s.initial).map((s) => s.id);
  const seen = new Set<string>();
  const order: string[] = [];
  let frontier = starts.length ? starts : ids.slice(0, 1);
  while (frontier.length) {
    const next: string[] = [];
    for (const id of frontier) {
      if (seen.has(id)) continue;
      seen.add(id);
      order.push(id);
      for (const e of edges) if (e.from === id && !seen.has(e.to) && ids.includes(e.to)) next.push(e.to);
    }
    frontier = next;
    if (!frontier.length) frontier = ids.filter((id) => !seen.has(id)).slice(0, 1);
  }
  const terminal = new Set(states.filter((s) => s.terminal).map((s) => s.id));
  return [...order.filter((id) => !terminal.has(id)), ...order.filter((id) => terminal.has(id))];
}

type Row = { items: LifecycleItem[]; from: string[]; to: string[] };

// One action from several states into one (cancel from anywhere), or from one
// state into several (reopen), is one row; everything else is a row per transition.
export function lifecycleRows(items: LifecycleItem[]): Row[] {
  const kind = (x: LifecycleItem) => (x.ghost ? 'ghost' : x.transition.status);
  const rows: Row[] = [];
  const left = new Set(items);
  for (const key of ['to', 'from'] as const) {
    const groups = new Map<string, LifecycleItem[]>();
    for (const x of left) {
      const k = `${x.transition[key]}|${x.transition.action}|${kind(x)}`;
      groups.set(k, [...(groups.get(k) ?? []), x]);
    }
    for (const g of groups.values()) {
      if (g.length < 2) continue;
      rows.push({ items: g, from: [...new Set(g.map((x) => x.transition.from))], to: [...new Set(g.map((x) => x.transition.to))] });
      g.forEach((x) => left.delete(x));
    }
  }
  for (const x of left) rows.push({ items: [x], from: [x.transition.from], to: [x.transition.to] });
  return rows;
}

const uniq = <T,>(xs: T[]) => [...new Set(xs)];

export function LifecycleView(props: Props) {
  const { entity, project, variant, selection } = props;
  const order = lifecycleOrder(
    props.states.map((s) => s.state),
    props.items.map((x) => x.transition),
  );
  const col = (id: string) => order.indexOf(id);
  const byId = new Map(props.states.map((s) => [s.state.id, s]));
  const roleTitle = (id: string) => project.project.roles.find((r) => r.id === id)?.title ?? id;
  const actionTitle = (id: string) => entity.actions.find((a) => a.id === id)?.title || id;
  const stateTitle = (id: string) => byId.get(id)?.state.title || id;
  const rows = lifecycleRows(props.items)
    .filter((r) => r.from.every((id) => col(id) >= 0) && r.to.every((id) => col(id) >= 0))
    .sort((a, b) => Math.min(...a.from.map(col)) - Math.min(...b.from.map(col)) || Math.min(...a.to.map(col)) - Math.min(...b.to.map(col)));
  const isSelected = (x: LifecycleItem) =>
    x.ghost
      ? selection?.kind === 'ghost' && selection.proposal === x.ghost.proposal && selection.op === x.ghost.op
      : selection?.kind === 'transition' && selection.id === x.transition.id;
  const select = (x: LifecycleItem) => props.onSelect(x.ghost ? { kind: 'ghost', ...x.ghost } : { kind: 'transition', id: x.transition.id });

  return (
    <div className="lifecycle" style={{ gridTemplateColumns: `repeat(${order.length}, minmax(150px, 1fr))` }}>
      {order.map((id, i) => {
        const s = byId.get(id)!;
        const cls = ['lc-state', s.ghost ? 'ghost' : s.state.status, id === NEW && 'start', selection?.kind === 'state' && selection.id === id && 'selected'];
        return (
          <button
            key={id}
            className={cls.filter(Boolean).join(' ')}
            style={{ gridColumn: i + 1 }}
            disabled={id === NEW}
            onClick={() => props.onSelect(s.ghost ? { kind: 'ghost', ...s.ghost } : { kind: 'state', id })}
          >
            <span className="title">{s.state.title || id}</span>
            {id !== NEW && <span className="id">{id}</span>}
            {s.ghost && <span className="tag">proposed</span>}
            {s.state.terminal && <span className="tag">final</span>}
          </button>
        );
      })}
      {order.map((id, i) => (
        <div key={`rail-${id}`} className="lc-rail" style={{ gridColumn: i + 1, gridRow: `2 / span ${rows.length * 2 + 1}` }} />
      ))}
      {rows.map((r, k) => {
        const cols = [...r.from, ...r.to].map(col);
        const lo = Math.min(...cols);
        const hi = Math.max(...cols);
        const ts = r.items.map((x) => x.transition);
        const ghost = !!r.items[0].ghost;
        const status = ghost ? 'proposed' : ts[0].status;
        const rules = entity.rules.filter((rule) => ts.some((t) => rule.transition === t.id) || (!rule.transition && rule.action === ts[0].action));
        const guards = uniq(ts.flatMap((t) => t.guards));
        const effects = uniq(ts.flatMap((t) => t.effects.map((e) => e.description)));
        const roles = uniq(ts.flatMap((t) => t.by));
        const results = ghost ? [] : ts.map((t) => props.resultOf(t.id));
        const result = results.find((x) => x === 'failed') ?? results.find((x) => x === 'blocked') ?? results.find((x) => x) ?? null;
        const dim = ts.every((t) => !applies(t, variant));
        const selected = r.items.some(isSelected);
        const fromCols = r.from.map(col);
        // ▶ when everything comes from the left, ◀ from the right, ▼ from both sides, ↻ stays put.
        const head = (c: number) =>
          r.from.includes(order[c]) ? '↻' : fromCols.every((f) => f < c) ? '▶' : fromCols.every((f) => f > c) ? '◀' : '▼';
        const sources = r.from.length > 1 ? `from ${r.from.map(stateTitle).join(', ')}` : r.to.length > 1 ? `to ${r.to.map(stateTitle).join(', ')}` : null;
        const row = 2 + k * 2;
        return (
          <div key={k} className="lc-row-wrap" style={{ display: 'contents' }}>
            <div
              className={`lc-arrow ${status} ${selected ? 'selected' : ''} ${dim ? 'dim' : ''}`}
              style={{ gridColumn: `${lo + 1} / ${hi + 2}`, gridRow: row }}
              onClick={() => select(r.items[(r.items.findIndex(isSelected) + 1) % r.items.length])}
              title={ts.map((t) => `${stateTitle(t.from)} → ${stateTitle(t.to)}`).join('\n')}
            >
              {/* From the centre of the leftmost column it touches to the centre of the rightmost. */}
              <span className="lc-line" style={{ left: `${50 / (hi - lo + 1)}%`, right: `${50 / (hi - lo + 1)}%` }} />
              {order.slice(lo, hi + 1).map((id, j) => {
                const end = r.to.includes(id) ? 'to' : r.from.includes(id) ? 'from' : null;
                return end ? (
                  <span key={id} className={`lc-end ${end}`} style={{ left: `${((j + 0.5) / (hi - lo + 1)) * 100}%` }}>
                    {end === 'to' ? head(lo + j) : '●'}
                  </span>
                ) : null;
              })}
              <span className="lc-label">
                {result && <span className={`dot ${result}`} aria-label={result} />}
                {actionTitle(ts[0].action)}
              </span>
            </div>
            <div className={`lc-detail ${dim ? 'dim' : ''}`} style={{ gridColumn: `${lo + 1} / ${Math.max(hi + 2, lo + 3)}`, gridRow: row + 1 }}>
              {sources && <div className="lc-branch"><span className="k">States</span><span>{sources}</span></div>}
              <div className="lc-branch">
                <span className="k">Who</span>
                <span>{roles.map(roleTitle).join(', ') || '—'}</span>
              </div>
              {rules.map((rule) => (
                <div key={rule.id} className="lc-branch" title={rule.text}>
                  <span className="k">Rule</span>
                  <span>{rule.title}</span>
                </div>
              ))}
              {guards.map((g) => (
                <div key={g} className="lc-branch"><span className="k">If</span><span>{g}</span></div>
              ))}
              {effects.map((e) => (
                <div key={e} className="lc-branch"><span className="k">Then</span><span>{e}</span></div>
              ))}
              {ghost && props.onDecide && (
                <div className="lc-branch lc-decide">
                  <span className="k">Agent</span>
                  <span>
                    <button className="btn small" onClick={() => props.onDecide!(r.items.map((x) => x.ghost!), 'accept')}>✓ Accept{r.items.length > 1 ? ` ${r.items.length}` : ''}</button>{' '}
                    <button className="btn small" onClick={() => props.onDecide!(r.items.map((x) => x.ghost!), 'reject')}>✕ Strike out</button>
                  </span>
                </div>
              )}
            </div>
          </div>
        );
      })}
      {!rows.length && (
        <p className="muted lc-empty" style={{ gridColumn: `1 / ${order.length + 1}` }}>
          No transitions yet. Switch to Graph and drag from one state to another to add one.
        </p>
      )}
    </div>
  );
}
