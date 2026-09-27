import { useEffect, useState } from 'react';
import type { Action, Entity, Permit, Relation, State, Transition } from '@tc/model';
import type { EntityState, ProjectState, ProposalState } from '../api.ts';
import { nextId, stateTitle, type Selection } from '../graph.ts';
import {
  EffectsEditor, Issues, KeyValues, Lines, Panel, ProvenanceNote, Scenarios, Select, StatusField, Text, VariantsField,
  RoleMultiSelect, ActionPanel, PermitPanel,
} from './InspectorElements.tsx';

type Props = {
  entity: Entity;
  state: EntityState;
  project: ProjectState;
  proposals: ProposalState[];
  selection: Selection;
  onSelect(s: Selection): void;
  onChange(e: Entity): void;
  onOpenProposal(): void;
};

export function Inspector(props: Props) {
  const { entity, state, project, selection, onChange } = props;
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setError(null), [selection]);

  const roles = project.project.roles.map((r): [string, string] => [r.id, r.title]);
  const states = entity.states.map((s): [string, string] => [s.id, s.title]);
  const prepareTools = Object.entries(project.project.mcp).flatMap(([srv, cfg]) => cfg.allow.prepare.map((t) => `${srv}.${t}`));

  const update = <K extends 'states' | 'transitions' | 'permits' | 'actions' | 'variants'>(key: K, id: string, patch: Partial<Entity[K][number]>) =>
    onChange({ ...entity, [key]: (entity[key] as { id: string }[]).map((x) => (x.id === id ? { ...x, ...patch } : x)) });

  const remove = (key: 'states' | 'transitions' | 'permits' | 'actions' | 'variants', id: string, refs: string[]) => {
    if (refs.length) return setError(`Remove references first: ${refs.join(', ')}`);
    onChange({ ...entity, [key]: (entity[key] as { id: string }[]).filter((x) => x.id !== id) });
    props.onSelect(null);
  };

  if (!selection) {
    return (
      <div className="inspector">
        <h2>{entity.title}</h2>
        <div className="sub"><span className="id">{entity.id}</span></div>
        <p className="muted">Select a state or transition on the map. To add a transition, drag from the bottom edge of one state to the top edge of another.</p>
        <section>
          <h3>Variants</h3>
          {entity.variants.map((v) => (
            <div key={v.id} className="scen" style={{ cursor: 'pointer' }} onClick={() => props.onSelect({ kind: 'variant', id: v.id })}>
              <span className={`status-pill ${v.status}`}><i /></span>
              <span>{v.title}</span>
              <span className="id">{v.id}</span>
            </div>
          ))}
          <button
            className="btn small"
            onClick={() => {
              const id = nextId('variant', entity.variants.map((v) => v.id));
              onChange({ ...entity, variants: [...entity.variants, { id, title: 'New variant', status: 'confirmed' }] });
              props.onSelect({ kind: 'variant', id });
            }}
          >
            Add variant
          </button>
        </section>
        <Relations entity={entity} state={state} onChange={onChange} />
        <section>
          <h3>How the actual state is read</h3>
          <Issues state={state} path="reader" />
          {entity.reader ? (
            <>
              <Select
                label="Read tool"
                value={entity.reader.tool}
                options={Object.entries(project.project.mcp).flatMap(([srv, cfg]) => cfg.allow.read.map((t): [string, string] => [`${srv}.${t}`, `${srv}.${t}`]))}
                onChange={(tool) => onChange({ ...entity, reader: { ...entity.reader!, tool } })}
              />
              <KeyValues label="Arguments ({{key}} is the instance key)" value={entity.reader.args} onChange={(args) => onChange({ ...entity, reader: { ...entity.reader!, args } })} />
              <button className="btn small" style={{ marginBottom: 12 }} onClick={() => onChange({ ...entity, reader: undefined })}>Remove reader</button>
            </>
          ) : (
            <>
              <p className="muted" style={{ marginTop: 0 }}>
                No reader yet — an onboarding agent may propose an entity before anyone knows how to read it back. Without one, every scenario plans as blocked.
              </p>
              <button className="btn small" style={{ marginBottom: 12 }} onClick={() => onChange({ ...entity, reader: { tool: '', args: {} } })}>Add reader</button>
            </>
          )}
          <Text label="Correlation key: the field that identifies an instance in every interface" value={entity.key} onChange={(key) => onChange({ ...entity, key })} />
        </section>
        <section>
          <h3>Actions</h3>
          <p className="muted" style={{ marginTop: 0 }}>A verb subjects apply to the entity — it knows nothing about states or permissions; transitions and permits say who may use it.</p>
          {entity.actions.length === 0 && <p className="muted" style={{ margin: 0 }}>No actions yet.</p>}
          {entity.actions.map((a) => (
            <div key={a.id} className="scen" style={{ cursor: 'pointer' }} onClick={() => props.onSelect({ kind: 'action', id: a.id })}>
              <span className={`status-pill ${a.status}`}><i /></span>
              <span>{a.title}</span>
              <span className="id">{a.id}</span>
              {!a.run && !a.invoke && <span className="flag warn">no run/invoke</span>}
            </div>
          ))}
          <button
            className="btn small"
            onClick={() => {
              const id = nextId('action', entity.actions.map((a) => a.id));
              const a: Action = { id, title: 'New action', kind: 'command', status: 'confirmed', provenance: { source: 'human', evidence: [], sources: [] } };
              onChange({ ...entity, actions: [...entity.actions, a] });
              props.onSelect({ kind: 'action', id });
            }}
          >
            Add action
          </button>
        </section>
        <section>
          <h3>Permits</h3>
          <p className="muted" style={{ marginTop: 0 }}>Permission for an action that leaves the state as it is: read, update, some commands.</p>
          {entity.permits.length === 0 && <p className="muted" style={{ margin: 0 }}>No permits yet.</p>}
          {entity.permits.map((p) => (
            <div key={p.id} className="scen" style={{ cursor: 'pointer' }} onClick={() => props.onSelect({ kind: 'permit', id: p.id })}>
              <span className={`status-pill ${p.status}`}><i /></span>
              <span>{p.title}</span>
              <span className="muted">{entity.actions.find((a) => a.id === p.action)?.title ?? p.action}</span>
            </div>
          ))}
          <button
            className="btn small"
            disabled={!entity.actions.length}
            title={!entity.actions.length ? 'Add an action first' : undefined}
            onClick={() => {
              const id = nextId('permit', entity.permits.map((p) => p.id));
              const p: Permit = {
                id, title: 'New permit', action: entity.actions[0].id, by: [project.project.roles[0].id],
                effects: [], status: 'confirmed', provenance: { source: 'human', evidence: [], sources: [] },
              };
              onChange({ ...entity, permits: [...entity.permits, p] });
              props.onSelect({ kind: 'permit', id });
            }}
          >
            Add permit
          </button>
        </section>
      </div>
    );
  }

  if (selection.kind === 'ghost') {
    const p = props.proposals.find((x) => x.id === selection.proposal);
    const op = p?.ops[selection.op];
    if (!p || !op) return null;
    return (
      <div className="inspector">
        <h2>Agent proposal</h2>
        <div className="sub"><span className="id">{p.agent}</span></div>
        <p>{p.rationale}</p>
        <pre className="md" style={{ fontSize: 12 }}>{JSON.stringify(op, null, 2)}</pre>
        <button className="btn primary" onClick={props.onOpenProposal}>Review proposal</button>
      </div>
    );
  }

  if (selection.kind === 'variant') {
    const v = entity.variants.find((x) => x.id === selection.id);
    if (!v) return null;
    const refs = [...entity.states, ...entity.transitions, ...entity.permits].filter((x) => x.variants?.includes(v.id)).map((x) => x.id);
    return (
      <Panel title={v.title} id={v.id} status={v.status} onDelete={() => remove('variants', v.id, refs)}>
        {error && <div className="error-box" style={{ marginBottom: 12 }}>{error}</div>}
        <Text label="Title" value={v.title} onChange={(title) => update('variants', v.id, { title })} />
        <Text label="Description" value={v.description ?? ''} onChange={(d) => update('variants', v.id, { description: d || undefined })} />
        <StatusField value={v.status} onChange={(status) => update('variants', v.id, { status })} />
        <section>
          <h3>Provenance</h3>
          <ProvenanceNote p={v.provenance} />
        </section>
      </Panel>
    );
  }

  if (selection.kind === 'action') {
    const a = entity.actions.find((x) => x.id === selection.id);
    if (!a) return null;
    const refs = [
      ...entity.transitions.filter((t) => t.action === a.id).map((t) => t.id),
      ...entity.permits.filter((p) => p.action === a.id).map((p) => p.id),
    ];
    return (
      <ActionPanel
        action={a}
        entity={entity}
        state={state}
        project={project}
        error={error}
        onChange={(patch) => update('actions', a.id, patch)}
        onDelete={() => remove('actions', a.id, refs)}
        onSelect={(s) => props.onSelect(s)}
      />
    );
  }

  if (selection.kind === 'permit') {
    const p = entity.permits.find((x) => x.id === selection.id);
    if (!p) return null;
    return (
      <PermitPanel
        permit={p}
        entity={entity}
        state={state}
        project={project}
        error={error}
        onChange={(patch) => update('permits', p.id, patch)}
        onDelete={() => remove('permits', p.id, [])}
      />
    );
  }

  if (selection.kind === 'state') {
    const s = entity.states.find((x) => x.id === selection.id);
    if (!s) return null;
    const set = (patch: Partial<State>) => update('states', s.id, patch);
    const refs = entity.transitions.filter((t) => t.from === s.id || t.to === s.id).map((t) => t.id);
    const toolSetup = s.setup.find((x) => x.kind === 'tool');
    return (
      <Panel title={s.title} id={s.id} status={s.status} onDelete={() => remove('states', s.id, refs)}>
        {error && <div className="error-box" style={{ marginBottom: 12 }}>{error}</div>}
        <Issues state={state} path={`states.${s.id}`} />
        <Text label="Title" value={s.title} onChange={(title) => set({ title })} />
        <StatusField value={s.status} onChange={(status) => set({ status })} />
        <VariantsField entity={entity} value={s.variants} onChange={(variants) => set({ variants })} />
        <div className="checks" style={{ marginBottom: 12 }}>
          <label><input type="checkbox" checked={!!s.initial} onChange={(e) => set({ initial: e.target.checked || undefined })} /> initial</label>
          <label><input type="checkbox" checked={!!s.terminal} onChange={(e) => set({ terminal: e.target.checked || undefined })} /> terminal</label>
        </div>
        <section>
          <h3>State probe</h3>
          <KeyValues
            label="Fields the reader must return"
            value={s.match}
            onChange={(match) => set({ match })}
            hint={entity.reader ? `Read via ${entity.reader.tool}` : 'No reader yet — add one above so this can be verified'}
          />
        </section>
        <section>
          <h3>How to reach</h3>
          {toolSetup && toolSetup.kind === 'tool' ? (
            <>
              <Select
                label="Setup tool"
                value={toolSetup.tool}
                options={prepareTools.map((t) => [t, t])}
                onChange={(tool) => set({ setup: s.setup.map((x) => (x === toolSetup ? { ...toolSetup, tool } : x)) })}
              />
              <KeyValues
                label="Arguments ({{variant}}, {{runTag}} are substituted)"
                value={toolSetup.args}
                onChange={(args) => set({ setup: s.setup.map((x) => (x === toolSetup ? { ...toolSetup, args } : x)) })}
              />
              <button className="btn small" onClick={() => set({ setup: s.setup.filter((x) => x !== toolSetup) })}>Remove recipe</button>
            </>
          ) : (
            <>
              <p className="muted" style={{ marginTop: 0 }}>Without a recipe, the engine takes the shortest path of confirmed transitions from a state a tool can set up.</p>
              {prepareTools.length > 0 && (
                <button
                  className="btn small"
                  onClick={() => set({ setup: [...s.setup, { kind: 'tool', tool: prepareTools[0], args: { variant: '{{variant}}', status: s.id, tag: '{{runTag}}' }, key: 'id' }] })}
                >
                  Set up with a tool
                </button>
              )}
            </>
          )}
          {s.setup.filter((x) => x.kind === 'path').map((x, i) => x.kind === 'path' && (
            <p key={i} className="muted">Explicit path: from {stateTitle(entity, x.from)} via {x.via.join(' → ')}</p>
          ))}
        </section>
        <section>
          <h3>Provenance</h3>
          <ProvenanceNote p={s.provenance} />
        </section>
      </Panel>
    );
  }

  const t = entity.transitions.find((x) => x.id === selection.id);
  if (!t) return null;
  const set = (patch: Partial<Transition>) => update('transitions', t.id, patch);
  const refs = entity.states.filter((s) => s.setup.some((x) => x.kind === 'path' && x.via.includes(t.id))).map((s) => s.id);
  const actionOptions: [string, string][] = entity.actions.map((a) => [a.id, a.title]);
  return (
    <Panel title={t.title} id={t.id} status={t.status} onDelete={() => remove('transitions', t.id, refs)}>
      {error && <div className="error-box" style={{ marginBottom: 12 }}>{error}</div>}
      <Issues state={state} path={`transitions.${t.id}`} />
      <Text label="Title" value={t.title} onChange={(title) => set({ title })} />
      <StatusField value={t.status} onChange={(status) => set({ status })} />
      <div className="row">
        <div style={{ flex: 1 }}><Select label="From" value={t.from} options={[['@new', 'New — creates the instance'], ...states]} onChange={(from) => set({ from })} /></div>
        <div style={{ flex: 1 }}><Select label="To" value={t.to} options={states} onChange={(to) => set({ to })} /></div>
      </div>
      <Select label="Action" value={t.action} options={actionOptions.length ? actionOptions : [['', '— add an action first —']]} onChange={(action) => set({ action })} />
      <RoleMultiSelect label="Performed by" roles={roles} value={t.by} onChange={(by) => set({ by })} />
      <VariantsField entity={entity} value={t.variants} onChange={(variants) => set({ variants })} />
      <Lines label="Guards (one per line)" value={t.guards} onChange={(guards) => set({ guards })} />
      <EffectsEditor entity={entity} state={state} effects={t.effects} onChange={(effects) => set({ effects })} />
      <section>
        <h3>Business rules</h3>
        {entity.rules.filter((r) => r.transition === t.id).map((r) => (
          <p key={r.id} style={{ margin: '0 0 6px' }}><b>{r.title}.</b> {r.text}</p>
        ))}
        {!entity.rules.some((r) => r.transition === t.id) && <p className="muted" style={{ margin: 0 }}>No rules on this transition. Add them on the Scenarios tab.</p>}
      </section>
      <section>
        <h3>Scenarios</h3>
        <Scenarios state={state} target={t.id} />
      </section>
      <section>
        <h3>Provenance</h3>
        <ProvenanceNote p={t.provenance} />
      </section>
    </Panel>
  );
}

// Links to other entities: which field holds the related key, what state the
// related instance must be in when this one is created, and how variants match.
function Relations({ entity, state, onChange }: { entity: Entity; state: EntityState; onChange(e: Entity): void }) {
  const others = Object.entries(state.catalog).filter(([id]) => id !== entity.id);
  const set = (i: number, patch: Partial<Relation>) =>
    onChange({ ...entity, relations: entity.relations.map((r, n) => (n === i ? { ...r, ...patch } : r)) });
  const used = (id: string) =>
    entity.rules.some((r) => r.requires.some((c) => c.kind === 'entity-state' && c.relation === id)) ||
    entity.transitions.some((t) => t.effects.some((e) => e.relation === id)) ||
    entity.permits.some((p) => p.effects.some((e) => e.relation === id));
  return (
    <section>
      <h3>Relations</h3>
      {entity.relations.length === 0 && (
        <p className="muted" style={{ margin: '0 0 8px' }}>
          Link to another entity when this one can't exist without it, for example an order and the listing it's bought from.
        </p>
      )}
      {entity.relations.map((r, i) => {
        const target = state.catalog[r.entity];
        return (
          <div key={i} className="relation-card">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <b>{target?.title ?? r.entity}</b>
              <button
                className="btn small"
                disabled={used(r.id)}
                title={used(r.id) ? 'Used by a rule or an effect' : undefined}
                onClick={() => onChange({ ...entity, relations: entity.relations.filter((_, n) => n !== i) })}
              >
                Remove
              </button>
            </div>
            <Select label="Entity" value={r.entity} options={others.map(([id, e]): [string, string] => [id, e.title])} onChange={(v) => set(i, { entity: v, requires: undefined, variants: undefined })} />
            <Text label="Field with its key (in this entity's read result)" value={r.field} onChange={(field) => set(i, { field })} />
            <Select
              label="Must be in state when this one is created"
              value={r.requires ?? ''}
              options={[['', 'No requirement — not prepared automatically'], ...(target?.states ?? []).map((x): [string, string] => [x.id, x.title])]}
              onChange={(v) => set(i, { requires: v || undefined })}
            />
            {target && entity.variants.length > 0 && (
              <div className="field" style={{ display: 'grid', gap: 4, marginBottom: 12 }}>
                <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>Variant pairs</span>
                {entity.variants.map((v) => (
                  <div key={v.id} className="row">
                    <span style={{ width: 90 }}>{v.title}</span>
                    <span className="muted">→</span>
                    <select
                      className="text"
                      value={r.variants?.[v.id] ?? ''}
                      onChange={(e) => {
                        const next = { ...(r.variants ?? {}) };
                        if (e.target.value) next[v.id] = e.target.value;
                        else delete next[v.id];
                        set(i, { variants: Object.keys(next).length ? next : undefined });
                      }}
                    >
                      <option value="">same id or first</option>
                      {target.variants.map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}
                    </select>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
      <button
        className="btn small"
        disabled={!others.length}
        onClick={() => {
          const [id] = others[0];
          onChange({ ...entity, relations: [...entity.relations, { id: nextId(id, entity.relations.map((r) => r.id)), entity: id, field: `${id.replace(/-(\w)/g, (_, c: string) => c.toUpperCase())}Id` }] });
        }}
      >
        Add relation
      </button>
    </section>
  );
}
