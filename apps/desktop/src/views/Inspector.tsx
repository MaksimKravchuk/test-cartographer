import { useEffect, useState } from 'react';
import type { Entity, Relation, State, Transition } from '@tc/model';
import type { EntityState, ProjectState } from '../api.ts';
import { nextId, stateTitle, type Selection } from '../graph.ts';
import {
  EffectsEditor, Issues, KeyValues, Lines, Panel, ProvenanceNote, Scenarios, Select, StatusField, Text, VariantsField,
  RoleMultiSelect, ActionPanel, PermitPanel,
} from './InspectorElements.tsx';

type Props = {
  entity: Entity;
  state: EntityState;
  project: ProjectState;
  selection: Selection;
  onSelect(s: Selection): void;
  onChange(e: Entity): void;
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
        <section>
          <h3>States: how each is read and set up</h3>
          {entity.states.map((s) => (
            <button key={s.id} type="button" className="scen" onClick={() => props.onSelect({ kind: 'state', id: s.id })}>
              <span className={`status-pill ${s.status}`}><i /></span>
              <span>{s.title}</span>
              <span className="id">{Object.entries(s.match).map(([k, v]) => `${k}: ${String(v)}`).join(', ')}</span>
            </button>
          ))}
        </section>
        <section>
          <h3>Changes: guards and effects</h3>
          {entity.transitions.map((t) => (
            <button key={t.id} type="button" className="scen" onClick={() => props.onSelect({ kind: 'transition', id: t.id })}>
              <span className={`status-pill ${t.status}`}><i /></span>
              <span>{t.title}</span>
              <span className="id">{stateTitle(entity, t.from)} → {stateTitle(entity, t.to)}</span>
            </button>
          ))}
        </section>
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
          <h3>Actions: how tests perform them</h3>
          {entity.actions.length === 0 && <p className="muted" style={{ margin: 0 }}>No actions yet.</p>}
          {entity.actions.map((a) => (
            <div key={a.id} className="scen" style={{ cursor: 'pointer' }} onClick={() => props.onSelect({ kind: 'action', id: a.id })}>
              <span className={`status-pill ${a.status}`}><i /></span>
              <span>{a.title}</span>
              <span className="id">{a.id}</span>
              {!a.run && !a.invoke && <span className="flag warn">no run/invoke</span>}
            </div>
          ))}
        </section>
        <section>
          <h3>Permits</h3>        </section>
        <section>
          <h3>Actions that leave the state as it is: effects</h3>
          {entity.permits.length === 0 && <p className="muted" style={{ margin: 0 }}>No permits yet.</p>}
          {entity.permits.map((p) => (
            <div key={p.id} className="scen" style={{ cursor: 'pointer' }} onClick={() => props.onSelect({ kind: 'permit', id: p.id })}>
              <span className={`status-pill ${p.status}`}><i /></span>
              <span>{p.title}</span>
              <span className="muted">{entity.actions.find((a) => a.id === p.action)?.title ?? p.action}</span>
            </div>
          ))}
        </section>
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
              <span><b>{target?.title ?? r.entity}</b>{used(r.id) && <span className="muted"> · used by a rule or an effect</span>}</span>
              <button
                type="button"
                className="btn small"
                disabled={used(r.id)}
                onClick={() => onChange({ ...entity, relations: entity.relations.filter((_, n) => n !== i) })}
              >
                Remove
              </button>
            </div>
            <Select
              label="Kind"
              value={r.kind}
              options={[['reference', 'Refers to'], ['part-of', 'Part of']]}
              onChange={(kind) => set(i, { kind: kind as Relation['kind'] })}
            />
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
                <span style={{ fontSize: '0.75rem', color: 'var(--fg-3)' }}>Variant pairs</span>
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
          onChange({
            ...entity,
            relations: [...entity.relations, { id: nextId(id, entity.relations.map((r) => r.id)), entity: id, field: `${id.replace(/-(\w)/g, (_, c: string) => c.toUpperCase())}Id`, kind: 'reference' }],
          });
        }}
      >
        Add relation
      </button>
    </section>
  );
}
