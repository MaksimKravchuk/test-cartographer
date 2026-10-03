import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  BaseEdge, EdgeLabelRenderer, Handle, MarkerType, Position, ReactFlow, ReactFlowProvider, Controls,
  applyNodeChanges, getBezierPath, useReactFlow,
  type Edge, type EdgeProps, type Node, type NodeChange, type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { Field } from '@tc/model';
import { api, type EntitySummary, type ProjectState } from '../api.ts';
import { nextId, objectCardHeight, objectsLayout, OBJECT_W, type ObjectBox } from '../graph.ts';
import { FieldsEditor } from './FieldsEditor.tsx';

type EntityTab = 'map' | 'scenarios' | 'coverage';

type Props = {
  project: ProjectState;
  entities: EntitySummary[];
  onOpen(id: string, tab?: EntityTab): void;
  onCreated(id: string): void;
  onDeleted(): void;
  // Something on the page was saved (an object's or a subject's data): reload the project and the catalog.
  onChanged(): Promise<void>;
  onOpenOnboarding(): void;
  onError(m: string): void;
};

type CardData = {
  entity: EntitySummary;
  hasChildren: boolean;
  selected: boolean;
  roles: { id: string; title: string; system: boolean }[];
  onMeasure(id: string, height: number): void;
};

type RefEdgeData = { label: string; offset: number };

function statusOf(t: EntitySummary['totals']) {
  return t.failed ? 'failed' : t.scenarios && t.passed === t.scenarios ? 'passed' : t.blocked ? 'blocked' : '';
}

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function ObjectCard({ data }: NodeProps<Node<CardData>>) {
  const e = data.entity;
  const t = e.totals;
  const pct = t.scenarios ? (100 * t.passed) / t.scenarios : 0;
  const shown = [...e.states].sort((a, b) => Number(b.initial) - Number(a.initial)).slice(0, 6);
  const extra = e.states.length - shown.length;

  // The frame's height comes from the real size of this block (everything
  // above the "Parts" caption), not the id/entity — so a card that wraps to
  // more chip rows than the first-pass estimate expected still gets a frame
  // tall enough to hold it.
  const ownRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ownRef.current;
    if (!el) return;
    const report = () => data.onMeasure(e.id, el.offsetHeight);
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [e.id, data.onMeasure]);

  return (
    <div className={`object-card ${data.hasChildren ? 'object-frame' : ''} ${data.selected ? 'selected' : ''}`}>
      <Handle type="target" position={Position.Left} />
      <div className="object-own" ref={ownRef}>
        <div className="object-card-head">
          <span className={`dot ${statusOf(t)}`} />
          <span className="title">{e.title}</span>
        </div>
        <span className="id">{e.id}</span>
        <div className="object-chips">
          {e.states.length === 0 && <span className="muted">No lifecycle yet</span>}
          {shown.map((s) => (
            <span key={s.id} className={`chip state-chip ${s.status !== 'confirmed' ? s.status : ''} ${s.initial ? 'initial' : ''} ${s.terminal ? 'terminal' : ''}`}>
              {s.title}
            </span>
          ))}
          {extra > 0 && <span className="chip muted">+{extra}</span>}
        </div>
        {data.roles.length > 0 && (
          <div className="object-chips">
            {data.roles.map((r) => (
              <span key={r.id} className={`chip role-chip ${r.system ? 'system' : ''}`}>{r.system && '⚙ '}{r.title}</span>
            ))}
          </div>
        )}
        <div className="object-footer">
          <div className="bar"><i style={{ width: `${pct}%` }} /></div>
          <span>{t.passed}/{t.scenarios}{t.failed > 0 && <b style={{ color: 'var(--fail)' }}>, {t.failed} failed</b>}</span>
        </div>
        {(e.pendingProposals > 0 || e.errors > 0) && (
          <div className="object-flags">
            {e.pendingProposals > 0 && <span className="flag proposed">{plural(e.pendingProposals, 'proposal')}</span>}
            {e.errors > 0 && <span className="flag error">{plural(e.errors, 'model error')}</span>}
          </div>
        )}
      </div>
      {data.hasChildren && <div className="parts-caption">Parts</div>}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function ReferenceEdge(props: EdgeProps<Edge<RefEdgeData>>) {
  const d = props.data!;
  const [path, lx, ly] = getBezierPath({ ...props, curvature: 0.3 + d.offset * 0.25 });
  return (
    <>
      <BaseEdge path={path} markerEnd={props.markerEnd} style={{ stroke: 'var(--ink-2)', strokeWidth: 1.5 }} />
      <EdgeLabelRenderer>
        <div className="edge-label nodrag nopan" style={{ transform: `translate(-50%, -50%) translate(${lx}px, ${ly + d.offset * 26}px)` }}>
          {d.label}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

const nodeTypes = { object: ObjectCard };
const edgeTypes = { reference: ReferenceEdge };

// Sits in the header, not the canvas, so it can never end up on top of a card.
function Legend() {
  return (
    <div className="objects-legend" aria-label="Legend">
      <span className="legend-item">
        <svg width="26" height="16" viewBox="0 0 26 16">
          <rect x="1" y="1" width="24" height="14" rx="3" fill="none" stroke="var(--ink-3)" />
          <rect x="6" y="5" width="12" height="7" rx="2" fill="var(--sheet)" stroke="var(--ink)" />
        </svg>
        Card inside a card — part of it
      </span>
      <span className="legend-item">
        <svg width="26" height="10" viewBox="0 0 26 10">
          <defs>
            <marker id="obj-arrow" viewBox="0 0 8 8" refX="6" refY="4" markerWidth="6" markerHeight="6" orient="auto">
              <path d="M0,0 L8,4 L0,8 z" fill="var(--ink-2)" />
            </marker>
          </defs>
          <line x1="1" y1="5" x2="20" y2="5" stroke="var(--ink-2)" strokeWidth="1.5" markerEnd="url(#obj-arrow)" />
        </svg>
        Arrow — refers to
      </span>
      <span className="legend-item"><span style={{ fontSize: 14 }}>⚙</span> System subject</span>
    </div>
  );
}

function refLabel(r: EntitySummary['relations'][number]) {
  return r.title + (r.requires ? ` · needs ${r.requires}` : '');
}

function roleInfo(project: ProjectState, id: string) {
  const r = project.project.roles.find((x) => x.id === id);
  return { id, title: r?.title ?? id, system: (r?.kind ?? 'human') === 'system' };
}

function Objects({ project, entities, onOpen, onCreated, onDeleted, onChanged, onOpenOnboarding, onError }: Props) {
  const { fitView } = useReactFlow();
  const [selectedId, setSelected] = useState<string | null>(null);
  // A subject (role) card replaces the object panel while one is open.
  const [subjectId, setSubject] = useState<string | null>(null);
  const setSelectedId = (id: string | null) => {
    setSelected(id);
    if (id) setSubject(null);
  };
  const openSubject = (id: string) => {
    setSelected(null);
    setSubject(id);
  };
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [partOf, setPartOf] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => setConfirmDelete(false), [selectedId]);
  // Real, DOM-measured height of each card's own content block (everything
  // above "Parts"); objectCardHeight is only the guess used before a card has
  // rendered once. Settling ignores sub-pixel jitter so this can't loop.
  const [measured, setMeasured] = useState<Record<string, number>>({});
  const onMeasure = useCallback((id: string, height: number) => {
    setMeasured((prev) => (Math.abs((prev[id] ?? 0) - height) > 1 ? { ...prev, [id]: height } : prev));
  }, []);
  // Ids the person actually dragged, so a later layout pass (measured heights
  // settling, a frame growing, dagre moving a top-level card) still reaches
  // every other node instead of freezing it at its first-render position.
  const draggedRef = useRef<Set<string>>(new Set());
  const idsKey = useMemo(() => entities.map((e) => e.id).slice().sort().join(','), [entities]);
  useEffect(() => {
    draggedRef.current.clear();
  }, [idsKey]);

  const byId = useMemo(() => new Map(entities.map((e) => [e.id, e])), [entities]);
  const childrenOf = useMemo(() => {
    const m: Record<string, string[]> = {};
    for (const e of entities) if (e.parent && byId.has(e.parent)) (m[e.parent] ??= []).push(e.id);
    return m;
  }, [entities, byId]);
  const topLevel = useMemo(() => entities.filter((e) => !e.parent || !byId.has(e.parent)).map((e) => e.id), [entities, byId]);
  // Parents before children, as React Flow's sub-flows require.
  const order = useMemo(() => {
    const out: string[] = [];
    const visit = (id: string) => {
      out.push(id);
      (childrenOf[id] ?? []).forEach(visit);
    };
    topLevel.forEach(visit);
    return out;
  }, [topLevel, childrenOf]);

  const layout = useMemo(() => {
    const ownSize: Record<string, ObjectBox> = {};
    const parentOf: Record<string, string | null> = {};
    for (const e of entities) {
      const guess = objectCardHeight(e.states.length, e.roles.length, e.pendingProposals > 0 || e.errors > 0);
      ownSize[e.id] = { width: OBJECT_W, height: measured[e.id] ?? guess };
      parentOf[e.id] = e.parent;
    }
    const refs = entities.flatMap((e) =>
      e.relations.filter((r) => r.kind === 'reference' && byId.has(r.entity)).map((r) => ({ from: e.id, to: r.entity, label: refLabel(r) })),
    );
    return objectsLayout(ownSize, parentOf, refs);
  }, [entities, byId, measured]);

  // Positions and frame sizes come from the layout; only a node the person
  // actually dragged (tracked in draggedRef) keeps its own spot, so every
  // other node keeps following the layout as it changes.
  const buildNodes = useCallback(
    (prev: Node<CardData>[]): Node<CardData>[] =>
      order.map((id) => {
        const e = byId.get(id)!;
        const kids = childrenOf[id] ?? [];
        const old = prev.find((n) => n.id === id);
        const box = layout.size[id];
        return {
          id,
          type: 'object',
          parentId: e.parent && byId.has(e.parent) ? e.parent : undefined,
          extent: e.parent && byId.has(e.parent) ? 'parent' : undefined,
          position: draggedRef.current.has(id) ? (old?.position ?? layout.position[id]) : layout.position[id],
          style: kids.length ? { width: box.width, height: box.height } : { width: OBJECT_W },
          data: { entity: e, hasChildren: kids.length > 0, selected: selectedId === id, roles: e.roles.map((r) => roleInfo(project, r)), onMeasure },
        } satisfies Node<CardData>;
      }),
    [order, byId, childrenOf, layout, selectedId, project, onMeasure],
  );
  const [nodes, setNodes] = useState<Node<CardData>[]>(() => buildNodes([]));
  useEffect(() => setNodes((prev) => buildNodes(prev)), [buildNodes]);

  const onNodesChange = (changes: NodeChange<Node<CardData>>[]) => {
    for (const c of changes) if (c.type === 'position' && c.dragging === false) draggedRef.current.add(c.id);
    setNodes((ns) => applyNodeChanges(changes, ns));
  };

  const edges: Edge<RefEdgeData>[] = useMemo(() => {
    const pairs: Record<string, number> = {};
    return entities.flatMap((e) =>
      e.relations
        .filter((r) => r.kind === 'reference' && byId.has(r.entity))
        .map((r) => {
          const pair = [e.id, r.entity].sort().join('|');
          const offset = pairs[pair] ?? 0;
          pairs[pair] = offset + 1;
          return {
            id: `${e.id}:${r.id}`,
            source: e.id,
            target: r.entity,
            type: 'reference',
            markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: 'var(--ink-2)' },
            data: { label: refLabel(r), offset },
          } satisfies Edge<RefEdgeData>;
        }),
    );
  }, [entities, byId]);

  const refCount = entities.reduce((n, e) => n + e.relations.filter((r) => r.kind === 'reference').length, 0);
  const partCount = entities.filter((e) => e.parent).length;

  const create = async () => {
    const id = nextId(title, entities.map((e) => e.id));
    setBusy(true);
    try {
      await api.createEntity({ id, title: title.trim(), description: description.trim() || undefined, partOf: partOf || undefined });
      setTitle('');
      setDescription('');
      setPartOf('');
      setCreating(false);
      onCreated(id);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Both reject after reporting, so the editor keeps the draft open.
  const saveObjectData = async (id: string, fields: Field[]) => {
    try {
      const s = await api.entity(id);
      await api.saveEntity({ ...s.entity, fields }, s.revision);
      await onChanged();
    } catch (e) {
      onError((e as Error).message);
      throw e;
    }
  };
  const saveSubjectData = async (id: string, fields: Field[]) => {
    try {
      await api.saveProject({ ...project.project, roles: project.project.roles.map((r) => (r.id === id ? { ...r, fields } : r)) });
      await onChanged();
    } catch (e) {
      onError((e as Error).message);
      throw e;
    }
  };

  const remove = async (id: string) => {
    try {
      await api.deleteEntity(id);
      setConfirmDelete(false);
      setSelectedId(null);
      onDeleted();
    } catch (e) {
      onError((e as Error).message);
    }
  };

  // Subjects don't depend on objects: a project with none yet still shows the
  // strip and the card, since that's where a new project's sign-in data lives.
  const subjectsStrip = (
    <div className="subjects-strip">
      <span>Subjects</span>
      {project.project.roles.map((r) => (
        <button
          key={r.id}
          className={`chip role-chip ${r.kind === 'system' ? 'system' : ''}`}
          aria-pressed={subjectId === r.id}
          onClick={() => (subjectId === r.id ? setSubject(null) : openSubject(r.id))}
        >
          {r.kind === 'system' && '⚙ '}{r.title}{r.fields.length > 0 && <span className="muted"> · {r.fields.length}</span>}
        </button>
      ))}
    </div>
  );
  const subject = subjectId ? project.project.roles.find((r) => r.id === subjectId) : undefined;
  const subjectPanel = subject && (
    <SubjectPanel
      role={subject}
      project={project}
      entities={entities}
      onSelect={setSelectedId}
      onSaveData={(fields) => saveSubjectData(subject.id, fields)}
    />
  );

  if (entities.length === 0)
    return (
      <div className="objects-page">
        <div className="objects-body">
          <div className="page" style={{ flex: 1, minWidth: 0 }}>
            <h1>Objects</h1>
            <div className="finding" style={{ maxWidth: '72ch' }}>
              <b>Nothing here yet.</b> Upload what you know about the system — docs, a tracker export, contracts — and let an
              agent propose the first map.{' '}
              <button className="btn small primary" onClick={onOpenOnboarding}>Go to Onboarding</button>
            </div>
            {subjectsStrip}
          </div>
          {subjectPanel}
        </div>
      </div>
    );

  const selected = selectedId ? byId.get(selectedId) : undefined;

  return (
    <div className="objects-page">
      <div className="objects-header">
        <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <h1>Objects</h1>
            <p className="lede">{plural(entities.length, 'object')} · {plural(refCount, 'reference')} · {plural(partCount, 'part')}</p>
          </div>
          <div className="row">
            <button className="btn" onClick={() => fitView({ padding: 0.2, duration: 200, maxZoom: 1 })}>Fit</button>
            <button className="btn primary" onClick={() => setCreating((c) => !c)}>New object</button>
          </div>
        </div>
        <Legend />
        {subjectsStrip}
        {creating && (
          <form
            className="editor-card"
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            <label className="field">
              <span>Name</span>
              <input className="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Quota" autoFocus />
            </label>
            <label className="field">
              <span>Description</span>
              <input className="text" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Monthly order limit of a buyer" />
            </label>
            <label className="field">
              <span>Part of</span>
              <select className="text" value={partOf} onChange={(e) => setPartOf(e.target.value)}>
                <option value="">— top level —</option>
                {entities.map((e) => <option key={e.id} value={e.id}>{e.title}</option>)}
              </select>
            </label>
            <div className="row">
              <button className="btn primary" disabled={busy || !title.trim()}>Create object</button>
              <button type="button" className="btn" onClick={() => setCreating(false)}>Cancel</button>
            </div>
          </form>
        )}
      </div>
      <div className="objects-body">
        <div className="objects-canvas">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={onNodesChange}
            onNodeClick={(_, n) => setSelectedId(n.id)}
            onNodeDoubleClick={(_, n) => onOpen(n.id, 'map')}
            onPaneClick={() => {
              setSelected(null);
              setSubject(null);
            }}
            proOptions={{ hideAttribution: true }}
            minZoom={0.2}
            fitView
            fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
            deleteKeyCode={null}
            edgesFocusable={false}
          >
            <Controls showInteractive={false} position="bottom-right" />
          </ReactFlow>
        </div>
        {selected && (
          <DetailPanel
            entity={selected}
            entities={entities}
            project={project}
            confirmDelete={confirmDelete}
            onSelect={setSelectedId}
            onSelectSubject={openSubject}
            onOpen={onOpen}
            onRemove={() => remove(selected.id)}
            onConfirmDelete={setConfirmDelete}
            onSaveData={(fields) => saveObjectData(selected.id, fields)}
          />
        )}
        {subjectPanel}
      </div>
    </div>
  );
}

function DetailPanel({
  entity, entities, project, confirmDelete, onSelect, onSelectSubject, onOpen, onRemove, onConfirmDelete, onSaveData,
}: {
  entity: EntitySummary;
  entities: EntitySummary[];
  project: ProjectState;
  confirmDelete: boolean;
  onSelect(id: string): void;
  onSelectSubject(id: string): void;
  onOpen(id: string, tab?: EntityTab): void;
  onRemove(): void;
  onConfirmDelete(v: boolean): void;
  onSaveData(fields: Field[]): Promise<void>;
}) {
  const parent = entity.parent ? entities.find((x) => x.id === entity.parent) : undefined;
  const parts = entities.filter((x) => x.parent === entity.id);
  const refersTo = entity.relations.filter((r) => r.kind === 'reference');
  const referencedBy = entities.filter((x) => x.id !== entity.id && x.relations.some((r) => r.kind === 'reference' && r.entity === entity.id));
  const roles = entity.roles.map((id) => roleInfo(project, id));
  const t = entity.totals;
  const nothingLinked = !parent && !parts.length && !refersTo.length && !referencedBy.length;

  return (
    <div className="objects-detail inspector">
      <h2>{entity.title}</h2>
      <div className="sub"><span className="id">{entity.id}</span></div>
      {entity.description && <p>{entity.description}</p>}

      <section>
        <h3>Lifecycle</h3>
        {entity.states.length === 0 && <p className="muted" style={{ margin: 0 }}>No lifecycle yet.</p>}
        {entity.states.map((s) => (
          <div key={s.id} className="scen">
            <span className={`status-pill ${s.status}`}><i /></span>
            <span>{s.title}</span>
            {s.initial && <span className="muted">initial</span>}
            {s.terminal && <span className="muted">terminal</span>}
          </div>
        ))}
      </section>

      <section>
        <h3>Subjects</h3>
        {roles.length === 0 && <p className="muted" style={{ margin: 0 }}>No subjects yet.</p>}
        {roles.length > 0 && (
          <div className="object-chips">
            {roles.map((r) => (
              <button key={r.id} className={`chip role-chip ${r.system ? 'system' : ''}`} onClick={() => onSelectSubject(r.id)}>
                {r.system && '⚙ '}{r.title}
              </button>
            ))}
          </div>
        )}
      </section>

      <section>
        <h3>Data</h3>
        <FieldsEditor owner="entities" ownerId={entity.id} fields={entity.fields} file={`entities/${entity.id}.yaml`} onSave={onSaveData} />
      </section>

      <section>
        <h3>Structure</h3>
        {parent && <p style={{ margin: '0 0 6px' }}>Part of <button className="btn link" onClick={() => onSelect(parent.id)}>{parent.title}</button></p>}
        {parts.length > 0 && (
          <p style={{ margin: '0 0 6px' }}>
            Parts: {parts.map((p, i) => (
              <span key={p.id}>{i > 0 && ', '}<button className="btn link" onClick={() => onSelect(p.id)}>{p.title}</button></span>
            ))}
          </p>
        )}
        {refersTo.map((r) => {
          const target = entities.find((x) => x.id === r.entity);
          return (
            <p key={r.id} style={{ margin: '0 0 6px' }}>
              Refers to <button className="btn link" disabled={!target} onClick={() => target && onSelect(target.id)}>{target?.title ?? r.entity}</button>
              {r.requires && <> (needs {r.requires})</>}
            </p>
          );
        })}
        {referencedBy.length > 0 && (
          <p style={{ margin: '0 0 6px' }}>
            Referenced by {referencedBy.map((x, i) => (
              <span key={x.id}>{i > 0 && ', '}<button className="btn link" onClick={() => onSelect(x.id)}>{x.title}</button></span>
            ))}
          </p>
        )}
        {nothingLinked && <p className="muted" style={{ margin: 0 }}>Not linked to any other object.</p>}
      </section>

      <section>
        <h3>Tests</h3>
        <p className="muted" style={{ margin: 0 }}>
          {t.passed}/{t.scenarios} passed
          {t.failed > 0 && <>, {t.failed} failed</>}
          {t.blocked > 0 && <>, {t.blocked} blocked</>}
        </p>
        {entity.errors > 0 && <p style={{ margin: '4px 0 0', color: 'var(--fail)' }}>{plural(entity.errors, 'model error')}</p>}
      </section>

      <div className="row" style={{ marginTop: 16, flexWrap: 'wrap', gap: 8 }}>
        <button className="btn" onClick={() => onOpen(entity.id, 'map')}>Open map</button>
        <button className="btn" onClick={() => onOpen(entity.id, 'scenarios')}>Scenarios</button>
        <button className="btn" onClick={() => onOpen(entity.id, 'coverage')}>Coverage</button>
        {confirmDelete ? (
          <>
            <span className="muted">Move to entities/.trash?</span>
            <button className="btn small danger" onClick={onRemove}>Remove</button>
            <button className="btn small" onClick={() => onConfirmDelete(false)}>Keep</button>
          </>
        ) : (
          <button className="btn" onClick={() => onConfirmDelete(true)}>Remove…</button>
        )}
      </div>
    </div>
  );
}

// A subject's card: who it is, where it acts, and the data attached to it —
// the account an agent and the tests sign in with, for one.
function SubjectPanel({
  role, project, entities, onSelect, onSaveData,
}: {
  role: ProjectState['project']['roles'][number];
  project: ProjectState;
  entities: EntitySummary[];
  onSelect(id: string): void;
  onSaveData(fields: Field[]): Promise<void>;
}) {
  const iface = project.project.interfaces.find((i) => i.id === role.interface);
  const objects = entities.filter((e) => e.roles.includes(role.id));
  const args = Object.entries(role.login?.args ?? {});
  const usesFields = args.some(([, v]) => v.includes(`{{roles.${role.id}.`));

  return (
    <div className="objects-detail inspector">
      <h2>{role.kind === 'system' && '⚙ '}{role.title}</h2>
      <div className="sub"><span className="id">{role.id}</span> · {role.kind === 'system' ? 'system subject' : 'person'}</div>

      <section>
        <h3>Acts through</h3>
        {role.kind === 'system' ? (
          <p className="muted" style={{ margin: 0 }}>No interface: acts only through actions with an invoke tool.</p>
        ) : (
          <>
            <p style={{ margin: '0 0 6px' }}>{iface?.title ?? role.interface} <span className="id">{iface?.baseUrl}</span></p>
            {role.login ? (
              <p style={{ margin: 0 }}>
                Signs in with <span className="id">{role.login.action}</span>
                {args.length > 0 && <>: {args.map(([k, v], i) => <span key={k}>{i > 0 && ', '}{k} = <span className="id">{v}</span></span>)}</>}
              </p>
            ) : (
              <p className="muted" style={{ margin: 0 }}>No sign-in: acts as a guest.</p>
            )}
          </>
        )}
      </section>

      <section>
        <h3>Data</h3>
        <FieldsEditor owner="roles" ownerId={role.id} fields={role.fields} file="cartographer.yaml" onSave={onSaveData} />
        {role.login && role.fields.length > 0 && !usesFields && (
          <p className="muted" style={{ fontSize: 12, margin: '10px 0 0' }}>
            To sign in with this data, use <span className="id">{`{{roles.${role.id}.<key>}}`}</span> in the credentials in Settings.
          </p>
        )}
      </section>

      <section>
        <h3>Objects</h3>
        {objects.length === 0 && <p className="muted" style={{ margin: 0 }}>Not named in any transition or permit yet.</p>}
        {objects.length > 0 && (
          <p style={{ margin: 0 }}>
            {objects.map((o, i) => (
              <span key={o.id}>{i > 0 && ', '}<button className="btn link" onClick={() => onSelect(o.id)}>{o.title}</button></span>
            ))}
          </p>
        )}
      </section>
    </div>
  );
}

export function ObjectsView(props: Props) {
  return (
    <ReactFlowProvider>
      <Objects {...props} />
    </ReactFlowProvider>
  );
}
