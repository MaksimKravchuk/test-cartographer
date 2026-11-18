import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BaseEdge, EdgeLabelRenderer, Handle, MarkerType, Position, ReactFlow, ReactFlowProvider, Controls,
  applyNodeChanges, getBezierPath, useReactFlow,
  type Connection, type Edge, type EdgeProps, type Node, type NodeChange, type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { Entity, State, Transition } from '@tc/model';
import { api, type EntityState, type ProjectState, type ProposalState } from '../api.ts';
import { LifecycleView } from './LifecycleView.tsx';
import { applies, autoLayout, groupTransitions, nextId, NODE_H, type Selection } from '../graph.ts';
import { Tip } from '../ui.tsx';

type Props = {
  entity: Entity;
  state: EntityState;
  project: ProjectState;
  proposals: ProposalState[];
  variant: string | null;
  onVariant(v: string | null): void;
  selection: Selection;
  onSelect(s: Selection): void;
  onChange(e: Entity): void;
  onOpenProposal(): void;
  onDecide(ops: { proposal: string; op: number }[], verdict: 'accept' | 'reject'): void;
};

type Ghost = { proposal: string; op: number };

// One action leading into (or out of) this state from several others, drawn
// on the state instead of as a fan of edges.
type FanView = { dir: 'in' | 'out'; action: string; others: string[]; cls: string; selected: boolean; dim: boolean; result: string | null; onPick(): void };

type StateData = {
  state: State;
  fans: FanView[];
  ghost?: { proposal: string; op: number };
  dim: boolean;
  selected: boolean;
  unreachable: boolean;
};

type EdgeData = {
  transitions: Transition[];
  ghost: boolean;
  status: string;
  dim: boolean;
  selected: boolean;
  result: string | null;
  actionTitle: string;
  roleTitle: string;
  tooltip: string;
  systemOnly: boolean;
  offset: number;
  onPick(): void;
};

const NEW = '@new';

function Fans({ fans }: { fans: FanView[] }) {
  if (!fans.length) return null;
  return (
    <div className="fans">
      {fans.map((f, i) => (
        <Tip key={i} tip={`${f.dir === 'in' ? 'From' : 'To'}: ${f.others.join(', ')}`}>
          <button
            type="button"
            className={`fan nodrag ${f.cls} ${f.selected ? 'selected' : ''} ${f.dim ? 'dim' : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              f.onPick();
            }}
          >
            {f.result && <span className={`dot ${f.result}`}><span className="sr-only">{f.result}: </span></span>}
            <span aria-hidden="true">{f.dir === 'in' ? '←' : '→'}</span>
            <span className="fan-action">{f.action}</span>
            <span className="role">{f.dir === 'in' ? 'from' : 'to'} {f.others.length}</span>
          </button>
        </Tip>
      ))}
    </div>
  );
}

function StateNode({ data }: NodeProps<Node<StateData>>) {
  const s = data.state;
  // The pseudo-state before an instance exists: creating transitions start here.
  if (s.id === NEW)
    return (
      <div className="start-node">
        New<span className="sr-only">: before the instance exists</span>
        <Fans fans={data.fans} />
        <Handle type="source" position={Position.Bottom} />
      </div>
    );
  const cls = ['state-node', data.ghost ? 'ghost' : s.status, data.dim && 'dim', data.selected && 'selected', s.initial && 'initial', s.terminal && 'terminal']
    .filter(Boolean)
    .join(' ');
  return (
    <div className={cls} style={{ position: 'relative' }}>
      <Handle type="target" position={Position.Top} />
      <div className="title">{s.title}</div>
      <div className="meta">
        <span className="id">{s.id}</span>
        {data.ghost && <span className="flag" style={{ color: 'var(--accent)' }}>proposed</span>}
        {s.variants && <span className="flag">{s.variants.length === 1 ? s.variants[0] : `${s.variants.length} variants`}</span>}
        {data.unreachable && <span className="flag warn">no setup</span>}
      </div>
      <Fans fans={data.fans} />
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

// Non-confirmed statuses keep their own look; a confirmed transition that only
// a system role can perform gets a distinct dashed style so a person can tell
// at a glance what the system does on its own.
const stroke = (status: string, ghost: boolean, systemOnly: boolean) =>
  ghost || status === 'proposed'
    ? { stroke: 'var(--accent)', strokeDasharray: '5 4' }
    : status === 'observed'
      ? { stroke: 'var(--warn)', strokeDasharray: '7 5' }
      : status === 'rejected'
        ? { stroke: 'var(--fg-3)', strokeDasharray: '1.5 4' }
        : systemOnly
          ? { stroke: 'var(--fg-2)', strokeDasharray: '2 3' }
          : { stroke: 'var(--fg)' };

function TransitionEdge(props: EdgeProps<Edge<EdgeData>>) {
  const d = props.data!;
  const [path, lx, ly] = getBezierPath({ ...props, curvature: 0.3 + d.offset * 0.25 });
  const style = { ...stroke(d.status, d.ghost, d.systemOnly), strokeWidth: d.selected ? 2.5 : 1.5, opacity: d.dim ? 0.25 : 1 };
  return (
    <>
      <BaseEdge path={path} markerStart={props.markerStart} markerEnd={props.markerEnd} style={style} />
      <EdgeLabelRenderer>
        <Tip tip={d.tooltip}>
          <button
            type="button"
            className={`edge-label nodrag nopan ${d.ghost ? 'ghost' : ''} ${d.selected ? 'selected' : ''} ${d.systemOnly ? 'system' : ''} ${d.dim ? 'dim' : ''}`}
            // Computed per edge: where React Flow puts the label.
            style={{ transform: `translate(-50%, -50%) translate(${lx}px, ${ly + d.offset * 26}px)` }}
            onClick={d.onPick}
          >
            {!d.ghost && <span className={`dot ${d.result ?? ''}`}><span className="sr-only">{d.result ?? 'not run'}: </span></span>}
            {d.systemOnly && <span className="system-marker"><span aria-hidden>⚙</span><span className="sr-only">system: </span></span>}
            <span>{d.actionTitle}</span>
            <span className="role">{d.roleTitle}</span>
          </button>
        </Tip>
      </EdgeLabelRenderer>
    </>
  );
}

const nodeTypes = { state: StateNode };
const edgeTypes = { transition: TransitionEdge };

// Aggregate transition result: for the selected variant, or the worst across all.
function resultOf(state: EntityState, id: string, variant: string | null): string | null {
  const row = state.coverage.transitions.find((t) => t.id === id);
  if (!row) return null;
  const cells = Object.entries(row.cells).filter(([v, c]) => c && (!variant || v === variant)).map(([, c]) => c!.status);
  if (!cells.length) return null;
  if (cells.includes('failed')) return 'failed';
  if (cells.every((c) => c === 'passed')) return 'passed';
  if (cells.includes('blocked')) return 'blocked';
  return 'not-run';
}

// The result a group of transitions shows: its worst member's.
const worst = (rs: (string | null)[]) =>
  rs.find((r) => r === 'failed') ?? rs.find((r) => r === 'blocked') ?? rs.find((r) => r === 'not-run') ?? rs.find((r) => r) ?? null;

function Map(props: Props) {
  const { entity, state, project, proposals, variant, selection } = props;
  // Proposals are reviewed in the Inbox; on the map they hide the model
  // unless there is no model yet to hide.
  const [showProposals, setShowProposals] = useState(entity.states.length === 0);
  // The transition table reads the same for any lifecycle shape and shows what
  // is not allowed; the graph is for drawing new transitions by dragging.
  const [mode, setMode] = useState<'lifecycle' | 'graph'>('lifecycle');
  const { fitView } = useReactFlow();

  const ghosts = useMemo(() => {
    const states: { state: State; ghost: Ghost }[] = [];
    const transitions: { transition: Transition; ghost: Ghost }[] = [];
    for (const p of proposals)
      p.ops.forEach((op, i) => {
        if (op.op !== 'add' || p.decisions.some((d) => d.op === i)) return;
        const ghost = { proposal: p.id, op: i };
        if (op.kind === 'state') states.push({ state: { match: {}, setup: [], status: 'proposed', title: '', ...op.value } as unknown as State, ghost });
        if (op.kind === 'transition')
          transitions.push({ transition: { by: [], guards: [], effects: [], status: 'proposed', title: '', ...op.value } as unknown as Transition, ghost });
      });
    return { states, transitions };
  }, [proposals]);
  const ghostCount = ghosts.states.length + ghosts.transitions.length;
  const shown = useMemo(() => (showProposals ? ghosts : { states: [], transitions: [] }), [ghosts, showProposals]);

  const allStates = useMemo(() => {
    const creates = [...entity.transitions, ...shown.transitions.map((g) => g.transition)].some((t) => t.from === NEW);
    const start = creates ? [{ state: { id: NEW, title: 'New', match: {}, setup: [], status: 'confirmed' } as State, ghost: undefined }] : [];
    return [...start, ...entity.states.map((s) => ({ state: s, ghost: undefined })), ...shown.states];
  }, [entity.states, entity.transitions, shown]);
  const allTransitions = useMemo(
    () => [...entity.transitions.map((t) => ({ transition: t, ghost: undefined as Ghost | undefined })), ...shown.transitions],
    [entity.transitions, shown],
  );

  const roleTitle = (id: string) => project.project.roles.find((r) => r.id === id)?.title ?? id;
  const actionTitle = (id: string) => entity.actions.find((a) => a.id === id)?.title || id;
  const stateTitle = (id: string) => allStates.find((s) => s.state.id === id)?.state.title || id;
  // Inlined rather than importing reach.ts's roleKind(): any *value* import
  // from '@tc/model' pulls in its whole index (including the Node-only
  // workspace.ts) and breaks the browser build — see AccessMatrix.tsx too.
  // A list of five roles on every label is what made labels unreadable: name one, count several.
  const roles = (ids: string[]) => {
    const u = [...new Set(ids)];
    return u.length === 1 ? roleTitle(u[0]) : u.length ? `${u.length} roles` : '';
  };
  const systemOnly = (t: Transition) => t.by.length > 0 && t.by.every((r) => (project.project.roles.find((x) => x.id === r)?.kind ?? 'human') === 'system');
  const grouped = useMemo(
    () =>
      groupTransitions(
        allTransitions.map((x) => ({
          ...x,
          from: x.transition.from,
          to: x.transition.to,
          action: x.transition.action,
          kind: x.ghost ? 'ghost' : `${x.transition.status}${systemOnly(x.transition) ? ':system' : ''}`,
        })),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allTransitions, project],
  );
  type Item = (typeof grouped.edges)[number]['items'][number];
  const isSelected = (x: Item) =>
    x.ghost
      ? selection?.kind === 'ghost' && selection.proposal === x.ghost.proposal && selection.op === x.ghost.op
      : selection?.kind === 'transition' && selection.id === x.transition.id;
  // Clicking a group selects its next member, so every transition stays reachable.
  const pickNext = (items: Item[]) => () => {
    const x = items[(items.findIndex(isSelected) + 1) % items.length];
    props.onSelect(x.ghost ? { kind: 'ghost', ...x.ghost } : { kind: 'transition', id: x.transition.id });
  };

  // After “Auto-layout” the saved positions are ignored until the next reload.
  const [savedLayout, setSavedLayout] = useState(state.layout);
  const positions = useMemo(
    () =>
      autoLayout(
        allStates.map((s) => s.state),
        grouped.edges.map((e) => ({ id: `${e.from}>${e.to}`, from: e.from, to: e.to, title: e.items.map((x) => x.action).join(' · ') })),
        savedLayout,
        Object.fromEntries(allStates.map((s) => [s.state.id, NODE_H + 30 * grouped.fans.filter((f) => f.state === s.state.id).length])),
      ),
    // Layout is recomputed when the set of nodes changes, not on every drag.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allStates.map((s) => s.state.id).join(), allTransitions.map((t) => `${t.transition.from}>${t.transition.to}`).join(), savedLayout],
  );

  const unreachable = useMemo(() => {
    const set = new Set<string>();
    for (const row of state.coverage.states)
      for (const [v, c] of Object.entries(row.cells)) if (c === 'unreachable' && (!variant || v === variant)) set.add(row.id);
    return set;
  }, [state.coverage, variant]);

  const buildNodes = useCallback(
    (prev: Node<StateData>[]): Node<StateData>[] =>
      allStates.map(({ state: s, ghost }) => {
        const old = prev.find((n) => n.id === s.id);
        return {
          id: s.id,
          type: 'state',
          position: old?.position ?? positions[s.id] ?? { x: 0, y: 0 },
          data: {
            state: s,
            fans: grouped.fans
              .filter((f) => f.state === s.id)
              .map((f) => ({
                dir: f.dir,
                action: actionTitle(f.items[0].action),
                others: f.others.map(stateTitle),
                cls: f.items[0].ghost ? 'ghost' : f.items[0].kind.endsWith(':system') ? 'system' : f.items[0].transition.status,
                selected: f.items.some(isSelected),
                dim: f.items.every((x) => !applies(x.transition, variant)),
                result: worst(f.items.map((x) => (x.ghost ? null : resultOf(state, x.transition.id, variant)))),
                onPick: pickNext(f.items),
              })),
            ghost,
            dim: !applies(s, variant),
            selected: selection?.kind === 'state' && selection.id === s.id,
            unreachable: !ghost && s.status === 'confirmed' && unreachable.has(s.id),
          },
        };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allStates, positions, variant, selection, unreachable, grouped, state],
  );

  const [nodes, setNodes] = useState<Node<StateData>[]>(() => buildNodes([]));
  useEffect(() => setNodes((prev) => buildNodes(prev)), [buildNodes]);
  useEffect(() => {
    const t = setTimeout(() => fitView({ padding: 0.15, duration: 0, maxZoom: 1 }), 200);
    return () => clearTimeout(t);
  }, [entity.id, showProposals, mode, fitView]);

  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const onNodesChange = (changes: NodeChange<Node<StateData>>[]) => {
    setNodes((ns) => {
      const next = applyNodeChanges(changes, ns);
      if (changes.some((c) => c.type === 'position' && !c.dragging)) {
        clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => {
          const layout = Object.fromEntries(next.filter((n) => !n.data.ghost).map((n) => [n.id, { x: Math.round(n.position.x), y: Math.round(n.position.y) }]));
          void api.saveLayout(entity.id, layout);
        }, 300);
      }
      return next;
    });
  };

  const edges: Edge<EdgeData>[] = useMemo(() => {
    const pairs: Record<string, number> = {};
    const color = (x: Item) =>
      x.ghost || x.transition.status === 'proposed' ? 'var(--accent)' : x.transition.status === 'observed' ? 'var(--warn)' : systemOnly(x.transition) ? 'var(--fg-2)' : 'var(--fg)';
    return grouped.edges.map(({ from, to, items }) => {
      const pair = [from, to].sort().join('|');
      const offset = pairs[pair] ?? 0;
      pairs[pair] = offset + 1;
      const first = items[0];
      const marker = { type: MarkerType.ArrowClosed, width: 16, height: 16, color: color(first) };
      const result = worst(items.map((x) => (x.ghost ? null : resultOf(state, x.transition.id, variant))));
      const uniq = (xs: string[]) => [...new Set(xs)].join(', ');
      return {
        id: items.map((x) => (x.ghost ? `ghost:${x.ghost.proposal}:${x.ghost.op}` : x.transition.id)).join('+'),
        source: from,
        target: to,
        type: 'transition',
        markerEnd: marker,
        markerStart: items.some((x) => x.from === to && x.to === from) ? marker : undefined,
        data: {
          transitions: items.map((x) => x.transition),
          ghost: !!first.ghost,
          status: first.transition.status,
          dim: items.every((x) => !applies(x.transition, variant)),
          selected: items.some(isSelected),
          result,
          actionTitle: uniq(items.map((x) => actionTitle(x.action))),
          roleTitle: roles(items.flatMap((x) => x.transition.by)),
          tooltip: items
            .map((x) => `${stateTitle(x.from)} → ${stateTitle(x.to)}: ${actionTitle(x.action)}\n  by ${x.transition.by.map(roleTitle).join(', ')}${x.transition.guards.length ? `\n  ${x.transition.guards.join('\n  ')}` : ''}`)
            .join('\n'),
          systemOnly: first.kind.endsWith(':system'),
          offset,
          onPick: pickNext(items),
        },
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grouped, variant, selection, state]);

  const onConnect = (c: Connection) => {
    if (!c.source || !c.target) return;
    if (!entity.states.some((s) => s.id === c.target)) return;
    if (c.source !== NEW && !entity.states.some((s) => s.id === c.source)) return;
    const id = nextId(`${c.source}-to-${c.target}`, entity.transitions.map((t) => t.id));
    const t: Transition = {
      id, title: 'New transition', from: c.source, to: c.target, by: [project.project.roles[0].id],
      action: entity.actions[0]?.id ?? '', guards: [], effects: [], status: 'confirmed', provenance: { source: 'human', evidence: [], sources: [] },
    };
    props.onChange({ ...entity, transitions: [...entity.transitions, t] });
    props.onSelect({ kind: 'transition', id });
  };

  const addState = () => {
    const id = nextId('state', entity.states.map((s) => s.id));
    props.onChange({
      ...entity,
      states: [...entity.states, { id, title: 'New state', match: { status: id }, setup: [], status: 'confirmed', provenance: { source: 'human', evidence: [], sources: [] } }],
    });
    props.onSelect({ kind: 'state', id });
  };

  const resetLayout = () => {
    setSavedLayout({});
    setNodes([]);
    void api.saveLayout(entity.id, {});
    setTimeout(() => fitView({ padding: 0.2, duration: 200, maxZoom: 1 }), 250);
  };

  return (
    <div className="map">
      <div className="map-toolbar">
        <div className="seg" role="group" aria-label="View">
          <button aria-pressed={mode === 'lifecycle'} onClick={() => setMode('lifecycle')}>Table</button>
          <button aria-pressed={mode === 'graph'} onClick={() => setMode('graph')}>Graph</button>
        </div>
        <div className="seg" role="group" aria-label="Variant">
          <button aria-pressed={variant === null} onClick={() => props.onVariant(null)}>All variants</button>
          {entity.variants.map((v) => (
            <button key={v.id} aria-pressed={variant === v.id} onClick={() => props.onVariant(v.id)}>{v.title}</button>
          ))}
        </div>
        <button className="btn" onClick={addState}>Add state</button>
        {mode === 'graph' && <button className="btn" onClick={resetLayout}>Auto-layout</button>}
        {ghostCount > 0 && (
          <div className="map-next">
            <span>
              {ghostCount} agent {ghostCount === 1 ? 'proposal waits' : 'proposals wait'} for your decision
            </span>
            <button className="btn primary" onClick={props.onOpenProposal}>Review in Inbox</button>
            <button className={`btn ${showProposals ? 'on' : ''}`} onClick={() => setShowProposals(!showProposals)} aria-pressed={showProposals}>
              {mode === 'graph' ? 'Preview on map' : 'Show in table'}
            </button>
          </div>
        )}
      </div>
      {mode === 'lifecycle' && (
        <div className="lifecycle-scroll">
          <LifecycleView
            entity={entity}
            state={state}
            project={project}
            states={allStates}
            items={allTransitions}
            variant={variant}
            selection={selection}
            onSelect={props.onSelect}
            onDecide={props.onDecide}
            resultOf={(id) => resultOf(state, id, variant)}
          />
        </div>
      )}
      {mode === 'graph' && (
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onConnect={onConnect}
        onNodeClick={(_, n) => n.id !== NEW && props.onSelect(n.data.ghost ? { kind: 'ghost', ...n.data.ghost } : { kind: 'state', id: n.id })}
        onPaneClick={() => props.onSelect(null)}
        proOptions={{ hideAttribution: true }}
        minZoom={0.3}
        fitView
        fitViewOptions={{ maxZoom: 1 }}
      >
        <Controls showInteractive={false} position="bottom-right" />
      </ReactFlow>
      )}
      {mode === 'graph' && (
      <div className="legend" role="group" aria-label="Legend">
        <svg width="34" height="6"><line x1="0" y1="3" x2="34" y2="3" stroke="var(--fg)" strokeWidth="2" /></svg>
        <span>Requirement — confirmed by a person</span>
        <svg width="34" height="6"><line x1="0" y1="3" x2="34" y2="3" stroke="var(--warn)" strokeWidth="2" strokeDasharray="7 5" /></svg>
        <span>Observation — not a requirement</span>
        <svg width="34" height="6"><line x1="0" y1="3" x2="34" y2="3" stroke="var(--accent)" strokeWidth="2" strokeDasharray="5 4" /></svg>
        <span>Proposed by an agent</span>
        <svg width="34" height="6"><line x1="0" y1="3" x2="34" y2="3" stroke="var(--fg-2)" strokeWidth="2" strokeDasharray="2 3" /></svg>
        <span>⚙ System acts on its own — no person involved</span>
        <span className="legend-fan">← a</span>
        <span>One action from many states, shown on the state</span>
      </div>
      )}
    </div>
  );
}

export function MapView(props: Props) {
  return (
    <ReactFlowProvider>
      <Map {...props} />
    </ReactFlowProvider>
  );
}
