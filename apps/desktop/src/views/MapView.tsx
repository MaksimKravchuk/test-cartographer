import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BaseEdge, EdgeLabelRenderer, Handle, MarkerType, Position, ReactFlow, ReactFlowProvider, Controls,
  applyNodeChanges, getBezierPath, useReactFlow,
  type Connection, type Edge, type EdgeProps, type Node, type NodeChange, type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { Entity, State, Transition } from '@tc/model';
import { api, type EntityState, type ProjectState, type ProposalState } from '../api.ts';
import { applies, autoLayout, nextId, type Selection } from '../graph.ts';

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
};

type StateData = {
  state: State;
  ghost?: { proposal: string; op: number };
  dim: boolean;
  selected: boolean;
  unreachable: boolean;
};

type EdgeData = {
  transition: Transition;
  ghost?: { proposal: string; op: number };
  dim: boolean;
  selected: boolean;
  result: string | null;
  actionTitle: string;
  roleTitle: string;
  systemOnly: boolean;
  offset: number;
  onPick(): void;
};

const NEW = '@new';

function StateNode({ data }: NodeProps<Node<StateData>>) {
  const s = data.state;
  // The pseudo-state before an instance exists: creating transitions start here.
  if (s.id === NEW)
    return (
      <div className="start-node" title="Before the instance exists">
        New
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
        {data.ghost && <span className="flag" style={{ color: 'var(--proposed)' }}>proposed</span>}
        {s.variants && <span className="flag">{s.variants.length === 1 ? s.variants[0] : `${s.variants.length} variants`}</span>}
        {data.unreachable && <span className="flag warn">no setup</span>}
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

// Non-confirmed statuses keep their own look; a confirmed transition that only
// a system role can perform gets a distinct dashed style so a person can tell
// at a glance what the system does on its own.
const stroke = (status: string, ghost: boolean, systemOnly: boolean) =>
  ghost || status === 'proposed'
    ? { stroke: 'var(--proposed)', strokeDasharray: '5 4' }
    : status === 'observed'
      ? { stroke: 'var(--observed)', strokeDasharray: '7 5' }
      : status === 'rejected'
        ? { stroke: 'var(--ink-3)', strokeDasharray: '1.5 4' }
        : systemOnly
          ? { stroke: 'var(--ink-2)', strokeDasharray: '2 3' }
          : { stroke: 'var(--ink)' };

function TransitionEdge(props: EdgeProps<Edge<EdgeData>>) {
  const d = props.data!;
  const [path, lx, ly] = getBezierPath({ ...props, curvature: 0.3 + d.offset * 0.25 });
  const style = { ...stroke(d.transition.status, !!d.ghost, d.systemOnly), strokeWidth: d.selected ? 2.5 : 1.5, opacity: d.dim ? 0.25 : 1 };
  return (
    <>
      <BaseEdge path={path} markerEnd={props.markerEnd} style={style} />
      <EdgeLabelRenderer>
        <div
          className={`edge-label nodrag nopan ${d.ghost ? 'ghost' : ''} ${d.selected ? 'selected' : ''} ${d.systemOnly ? 'system' : ''}`}
          style={{ transform: `translate(-50%, -50%) translate(${lx}px, ${ly + d.offset * 26}px)`, opacity: d.dim ? 0.35 : 1 }}
          onClick={d.onPick}
          title={d.transition.guards.join('\n') || undefined}
        >
          {!d.ghost && <span className={`dot ${d.result ?? ''}`} aria-label={d.result ?? 'not run'} />}
          {d.systemOnly && <span className="system-marker" title="Performed by the system, not a person">⚙</span>}
          <span>{d.actionTitle}</span>
          <span className="role">{d.roleTitle}</span>
        </div>
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

function Contours() {
  // Decorative contour lines: a terrain map still to be surveyed.
  const rings = [
    [0.18, 0.28, 9], [0.78, 0.7, 11], [0.55, 0.12, 6],
  ] as const;
  return (
    <svg className="contours" width="100%" height="100%" aria-hidden="true">
      {rings.flatMap(([cx, cy, n], k) =>
        Array.from({ length: n }, (_, i) => {
          const r = 60 + i * 46;
          const w = 1 + (k % 2) * 0.35;
          return (
            <ellipse
              key={`${k}-${i}`}
              cx={`${cx * 100}%`}
              cy={`${cy * 100}%`}
              rx={r * 1.5 * w}
              ry={r}
              fill="none"
              stroke="currentColor"
              strokeWidth={i % 4 === 3 ? 1.1 : 0.6}
              transform={`rotate(${-12 + k * 17})`}
              style={{ transformOrigin: `${cx * 100}% ${cy * 100}%` }}
            />
          );
        }),
      )}
    </svg>
  );
}

function Map(props: Props) {
  const { entity, state, project, proposals, variant, selection } = props;
  const [showProposals, setShowProposals] = useState(true);
  const { fitView } = useReactFlow();

  const ghosts = useMemo(() => {
    const states: { state: State; ghost: { proposal: string; op: number } }[] = [];
    const transitions: { transition: Transition; ghost: { proposal: string; op: number } }[] = [];
    if (!showProposals) return { states, transitions };
    for (const p of proposals)
      p.ops.forEach((op, i) => {
        if (op.op !== 'add') return;
        const ghost = { proposal: p.id, op: i };
        if (op.kind === 'state') states.push({ state: { match: {}, setup: [], status: 'proposed', title: '', ...op.value } as unknown as State, ghost });
        if (op.kind === 'transition')
          transitions.push({ transition: { by: [], guards: [], effects: [], status: 'proposed', title: '', ...op.value } as unknown as Transition, ghost });
      });
    return { states, transitions };
  }, [proposals, showProposals]);

  const allStates = useMemo(() => {
    const creates = [...entity.transitions, ...ghosts.transitions.map((g) => g.transition)].some((t) => t.from === NEW);
    const start = creates ? [{ state: { id: NEW, title: 'New', match: {}, setup: [], status: 'confirmed' } as State, ghost: undefined }] : [];
    return [...start, ...entity.states.map((s) => ({ state: s, ghost: undefined })), ...ghosts.states];
  }, [entity.states, entity.transitions, ghosts.states, ghosts.transitions]);
  const allTransitions = useMemo(
    () => [...entity.transitions.map((t) => ({ transition: t, ghost: undefined })), ...ghosts.transitions],
    [entity.transitions, ghosts.transitions],
  );

  // After “Auto-layout” the saved positions are ignored until the next reload.
  const [savedLayout, setSavedLayout] = useState(state.layout);
  const positions = useMemo(
    () => autoLayout(allStates.map((s) => s.state), allTransitions.map((t) => t.transition), savedLayout),
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
            ghost,
            dim: !applies(s, variant),
            selected: selection?.kind === 'state' && selection.id === s.id,
            unreachable: !ghost && s.status === 'confirmed' && unreachable.has(s.id),
          },
        };
      }),
    [allStates, positions, variant, selection, unreachable],
  );

  const [nodes, setNodes] = useState<Node<StateData>[]>(() => buildNodes([]));
  useEffect(() => setNodes((prev) => buildNodes(prev)), [buildNodes]);
  useEffect(() => {
    const t = setTimeout(() => fitView({ padding: 0.2, duration: 0 }), 50);
    return () => clearTimeout(t);
  }, [entity.id, fitView]);

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

  const roleTitle = (id: string) => project.project.roles.find((r) => r.id === id)?.title ?? id;
  const actionTitle = (id: string) => entity.actions.find((a) => a.id === id)?.title ?? id;

  const edges: Edge<EdgeData>[] = useMemo(() => {
    const pairs: Record<string, number> = {};
    return allTransitions.map(({ transition: t, ghost }) => {
      const pair = [t.from, t.to].sort().join('|');
      const offset = pairs[pair] ?? 0;
      pairs[pair] = offset + 1;
      const pick = () => props.onSelect(ghost ? { kind: 'ghost', ...ghost } : { kind: 'transition', id: t.id });
      // Inlined rather than importing reach.ts's roleKind(): any *value* import
      // from '@tc/model' pulls in its whole index (including the Node-only
      // workspace.ts) and breaks the browser build — see AccessMatrix.tsx too.
      const systemOnly = t.by.length > 0 && t.by.every((r) => (project.project.roles.find((x) => x.id === r)?.kind ?? 'human') === 'system');
      return {
        id: ghost ? `ghost:${ghost.proposal}:${ghost.op}` : t.id,
        source: t.from,
        target: t.to,
        type: 'transition',
        markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: ghost || t.status === 'proposed' ? 'var(--proposed)' : t.status === 'observed' ? 'var(--observed)' : systemOnly ? 'var(--ink-2)' : 'var(--ink)' },
        data: {
          transition: t,
          ghost,
          dim: !applies(t, variant),
          selected: selection?.kind === 'transition' && selection.id === t.id,
          result: ghost ? null : resultOf(state, t.id, variant),
          actionTitle: actionTitle(t.action) || t.action,
          roleTitle: t.by.map(roleTitle).join(', '),
          systemOnly,
          offset,
          onPick: pick,
        },
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allTransitions, variant, selection, state]);

  const onConnect = (c: Connection) => {
    if (!c.source || !c.target) return;
    if (!entity.states.some((s) => s.id === c.target)) return;
    if (c.source !== NEW && !entity.states.some((s) => s.id === c.source)) return;
    const id = nextId(`${c.source}-to-${c.target}`, entity.transitions.map((t) => t.id));
    const t: Transition = {
      id, title: 'New transition', from: c.source, to: c.target, by: [project.project.roles[0].id],
      action: entity.actions[0]?.id ?? '', guards: [], effects: [], status: 'confirmed', provenance: { source: 'human', evidence: [] },
    };
    props.onChange({ ...entity, transitions: [...entity.transitions, t] });
    props.onSelect({ kind: 'transition', id });
  };

  const addState = () => {
    const id = nextId('state', entity.states.map((s) => s.id));
    props.onChange({
      ...entity,
      states: [...entity.states, { id, title: 'New state', match: { status: id }, setup: [], status: 'confirmed', provenance: { source: 'human', evidence: [] } }],
    });
    props.onSelect({ kind: 'state', id });
  };

  const resetLayout = () => {
    setSavedLayout({});
    setNodes([]);
    void api.saveLayout(entity.id, {});
    setTimeout(() => fitView({ padding: 0.2, duration: 200 }), 250);
  };

  const ghostCount = ghosts.states.length + ghosts.transitions.length;

  return (
    <div className="map">
      <Contours />
      <div className="map-toolbar">
        <div className="seg" role="group" aria-label="Variant">
          <button aria-pressed={variant === null} onClick={() => props.onVariant(null)}>All variants</button>
          {entity.variants.map((v) => (
            <button key={v.id} aria-pressed={variant === v.id} onClick={() => props.onVariant(v.id)}>{v.title}</button>
          ))}
        </div>
        <button className="btn" onClick={addState}>Add state</button>
        <button className="btn" onClick={resetLayout}>Auto-layout</button>
        {proposals.length > 0 && (
          <button className={`btn ${showProposals ? 'on' : ''}`} onClick={() => setShowProposals(!showProposals)} aria-pressed={showProposals}>
            Agent proposals on map{ghostCount ? `: ${ghostCount}` : ''}
          </button>
        )}
      </div>
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
      >
        <Controls showInteractive={false} position="bottom-right" />
      </ReactFlow>
      <div className="legend" aria-label="Legend">
        <svg width="34" height="6"><line x1="0" y1="3" x2="34" y2="3" stroke="var(--ink)" strokeWidth="2" /></svg>
        <span>Requirement — confirmed by a person</span>
        <svg width="34" height="6"><line x1="0" y1="3" x2="34" y2="3" stroke="var(--observed)" strokeWidth="2" strokeDasharray="7 5" /></svg>
        <span>Observation — not a requirement</span>
        <svg width="34" height="6"><line x1="0" y1="3" x2="34" y2="3" stroke="var(--proposed)" strokeWidth="2" strokeDasharray="5 4" /></svg>
        <span>Proposed by an agent</span>
        <svg width="34" height="6"><line x1="0" y1="3" x2="34" y2="3" stroke="var(--ink-2)" strokeWidth="2" strokeDasharray="2 3" /></svg>
        <span>⚙ System acts on its own — no person involved</span>
      </div>
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
