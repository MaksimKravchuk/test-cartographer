// The object's lifecycle as a state transition table: rows are where an
// instance is, columns where it goes. A cell names the action and who does it;
// an empty cell is a transition that must not be possible (a negative test).
// Works the same for a linear flow (order) and a mesh (task lists, kanban).
// Picking a cell opens its tree below: who, rules, conditions, effects.
import { useState } from 'react';
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

const uniq = <T,>(xs: T[]) => [...new Set(xs)];

export function LifecycleView(props: Props) {
  const { entity, project, variant, selection } = props;
  const [cell, setCell] = useState<{ from: string; to: string } | null>(null);
  const order = lifecycleOrder(
    props.states.map((s) => s.state),
    props.items.map((x) => x.transition),
  );
  const byId = new Map(props.states.map((s) => [s.state.id, s]));
  const roleTitle = (id: string) => project.project.roles.find((r) => r.id === id)?.title ?? id;
  const actionTitle = (id: string) => entity.actions.find((a) => a.id === id)?.title || id;
  const stateTitle = (id: string) => (id === NEW ? 'New' : byId.get(id)?.state.title || id);
  const at = (from: string, to: string) => props.items.filter((x) => x.transition.from === from && x.transition.to === to);
  const rowsIds = order.filter((id) => id !== NEW || props.items.some((x) => x.transition.from === NEW));
  const colIds = order.filter((id) => id !== NEW);
  const kind = (x: LifecycleItem) => (x.ghost ? 'proposed' : x.transition.status);
  const isSelected = (x: LifecycleItem) =>
    x.ghost
      ? selection?.kind === 'ghost' && selection.proposal === x.ghost.proposal && selection.op === x.ghost.op
      : selection?.kind === 'transition' && selection.id === x.transition.id;
  const select = (x: LifecycleItem) => props.onSelect(x.ghost ? { kind: 'ghost', ...x.ghost } : { kind: 'transition', id: x.transition.id });
  const roles = (ids: string[]) => {
    const u = uniq(ids);
    return u.length === 1 ? roleTitle(u[0]) : `${u.length} roles`;
  };
  const header = (id: string) => {
    const s = byId.get(id);
    const cls = ['lc-head', s?.ghost ? 'proposed' : s?.state.status, selection?.kind === 'state' && selection.id === id && 'selected'];
    return (
      <button
        className={cls.filter(Boolean).join(' ')}
        disabled={id === NEW}
        onClick={() => s && props.onSelect(s.ghost ? { kind: 'ghost', ...s.ghost } : { kind: 'state', id })}
      >
        {stateTitle(id)}
        {s?.ghost && <span className="tag">proposed</span>}
        {s?.state.terminal && <span className="tag">final</span>}
      </button>
    );
  };
  const open = cell ? at(cell.from, cell.to) : [];

  return (
    <div className="lifecycle">
      <table className="lc-table">
        <thead>
          <tr>
            <th className="lc-corner">
              <span>from ↓</span> <span>to →</span>
            </th>
            {colIds.map((id) => (
              <th key={id}>{header(id)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rowsIds.map((from) => (
            <tr key={from}>
              <th>{header(from)}</th>
              {colIds.map((to) => {
                const xs = at(from, to);
                const picked = cell?.from === from && cell.to === to;
                if (!xs.length)
                  return (
                    <td key={to} className={`lc-cell empty ${from === to ? 'diag' : ''}`}>
                      {from === to ? '' : <><span aria-hidden>—</span><span className="sr-only">not possible</span></>}
                    </td>
                  );
                return (
                  <td
                    key={to}
                    className={`lc-cell ${picked ? 'picked' : ''} ${xs.every((x) => !applies(x.transition, variant)) ? 'dim' : ''}`}
                    onClick={() => {
                      setCell(picked ? null : { from, to });
                      select(xs.find(isSelected) ?? xs[0]);
                    }}
                  >
                    {xs.map((x, i) => {
                      const r = x.ghost ? null : props.resultOf(x.transition.id);
                      return (
                        <div key={i} className={`lc-chip ${kind(x)} ${isSelected(x) ? 'selected' : ''}`}>
                          {r && <span className={`dot ${r}`}><span className="sr-only">{r}: </span></span>}
                          <span className="a">{actionTitle(x.transition.action)}</span>
                          <span className="role">{roles(x.transition.by)}</span>
                        </div>
                      );
                    })}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>

      {cell && open.length > 0 && (
        <section className="lc-tree" aria-label="Transition details">
          <h3>
            {stateTitle(cell.from)} → {stateTitle(cell.to)}
          </h3>
          {open.map((x, i) => {
            const t = x.transition;
            const rules = entity.rules.filter((rule) => rule.transition === t.id || (!rule.transition && rule.action === t.action));
            return (
              <div key={i} className={`lc-node ${kind(x)}`}>
                <button className="lc-node-title" onClick={() => select(x)}>
                  {actionTitle(t.action)}
                  {x.ghost && <span className="tag">proposed by an agent</span>}
                  {!x.ghost && t.status !== 'confirmed' && <span className="tag">{t.status}</span>}
                </button>
                <div className="lc-branch"><span className="k">Who</span><span>{t.by.map(roleTitle).join(', ')}</span></div>
                {rules.map((rule) => (
                  <div key={rule.id} className="lc-branch">
                    <span className="k">Rule</span>
                    <span>
                      {rule.title}
                      {rule.text !== rule.title && <span className="muted"> — {rule.text}</span>}
                    </span>
                  </div>
                ))}
                {t.guards.map((g) => (
                  <div key={g} className="lc-branch"><span className="k">If</span><span>{g}</span></div>
                ))}
                {t.effects.map((e, j) => (
                  <div key={j} className="lc-branch"><span className="k">Then</span><span>{e.description}</span></div>
                ))}
                {!rules.length && !t.guards.length && !t.effects.length && (
                  <div className="lc-branch"><span className="k" /><span className="muted">No rules, conditions or effects yet.</span></div>
                )}
                {x.ghost && props.onDecide && (
                  <div className="lc-branch">
                    <span className="k" />
                    <span>
                      <button className="btn small" onClick={() => props.onDecide!([x.ghost!], 'accept')}>✓ Accept</button>{' '}
                      <button className="btn small" onClick={() => props.onDecide!([x.ghost!], 'reject')}>✕ Strike out</button>
                    </span>
                  </div>
                )}
              </div>
            );
          })}
        </section>
      )}
      {!props.items.length && <p className="muted">No transitions yet. Switch to Graph and drag from one state to another to add one.</p>}
    </div>
  );
}
