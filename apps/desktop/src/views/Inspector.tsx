import { useEffect, useState, type ReactNode } from 'react';
import type { Effect, Entity, Forbidden, Provenance, Relation, State, Status, Transition, Variant } from '@tc/model';
import type { EntityState, ProjectState, ProposalState } from '../api.ts';
import { nextId, stateTitle, type Selection } from '../graph.ts';

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

const statusText: Record<Status, string> = {
  confirmed: 'Requirement',
  observed: 'Observation',
  proposed: 'Proposed',
  rejected: 'Rejected',
};

function StatusField({ value, onChange }: { value: Status; onChange(s: Status): void }) {
  return (
    <label className="field">
      <span>Status</span>
      <select className="text" value={value} onChange={(e) => onChange(e.target.value as Status)}>
        <option value="confirmed">Requirement — included in the test plan</option>
        <option value="observed">Observation — the app behaves this way, but it is not a requirement</option>
        <option value="proposed">Proposed — awaiting a decision</option>
        <option value="rejected">Rejected</option>
      </select>
    </label>
  );
}

function ProvenanceNote({ p }: { p?: Provenance }) {
  if (!p) return <div className="provenance">Modeled by a person</div>;
  return (
    <div className="provenance">
      {p.source === 'agent' ? (
        <>
          Proposed by agent <span className="id">{p.agent}</span>
          {p.proposal && <> in <span className="id">{p.proposal}</span></>}
          {p.evidence.length > 0 && <>, evidence {p.evidence.join(', ')}</>}
        </>
      ) : (
        'Modeled by a person'
      )}
      {p.note && <div style={{ marginTop: 4 }}>{p.note}</div>}
    </div>
  );
}

function Text({ label, value, onChange, placeholder }: { label: string; value: string; onChange(v: string): void; placeholder?: string }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input className="text" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

function Select({ label, value, options, onChange }: { label: string; value: string; options: [string, string][]; onChange(v: string): void }) {
  return (
    <label className="field">
      <span>{label}</span>
      <select className="text" value={value} onChange={(e) => onChange(e.target.value)}>
        {!options.some(([v]) => v === value) && <option value={value}>{value || '— not selected —'}</option>}
        {options.map(([v, t]) => (
          <option key={v} value={v}>{t}</option>
        ))}
      </select>
    </label>
  );
}

function VariantsField({ entity, value, onChange }: { entity: Entity; value?: string[]; onChange(v?: string[]): void }) {
  const all = !value;
  return (
    <div className="field" style={{ display: 'grid', gap: 4, marginBottom: 12 }}>
      <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>Variants</span>
      <div className="checks">
        <label>
          <input type="checkbox" checked={all} onChange={() => onChange(all ? entity.variants.map((v) => v.id) : undefined)} />
          all
        </label>
        {!all &&
          entity.variants.map((v) => (
            <label key={v.id}>
              <input
                type="checkbox"
                checked={value!.includes(v.id)}
                onChange={(e) => onChange(e.target.checked ? [...value!, v.id] : value!.filter((x) => x !== v.id))}
              />
              {v.title}
            </label>
          ))}
      </div>
    </div>
  );
}

// One "key: value" per line; values are parsed as JSON, otherwise kept as strings.
function KeyValues({ label, value, onChange, hint }: { label: string; value: Record<string, unknown>; onChange(v: Record<string, unknown>): void; hint?: string }) {
  const toText = (v: Record<string, unknown>) => Object.entries(v).map(([k, x]) => `${k}: ${typeof x === 'string' ? x : JSON.stringify(x)}`).join('\n');
  const [text, setText] = useState(toText(value));
  useEffect(() => setText(toText(value)), [JSON.stringify(value)]);
  const parse = (t: string) =>
    Object.fromEntries(
      t.split('\n').filter((l) => l.includes(':')).map((l) => {
        const i = l.indexOf(':');
        const raw = l.slice(i + 1).trim();
        let v: unknown = raw;
        try {
          v = JSON.parse(raw);
        } catch {
          /* string */
        }
        return [l.slice(0, i).trim(), v];
      }),
    );
  return (
    <label className="field">
      <span>{label}</span>
      <textarea className="text" value={text} onChange={(e) => setText(e.target.value)} onBlur={() => onChange(parse(text))} />
      {hint && <span>{hint}</span>}
    </label>
  );
}

function Lines({ label, value, onChange }: { label: string; value: string[]; onChange(v: string[]): void }) {
  const [text, setText] = useState(value.join('\n'));
  useEffect(() => setText(value.join('\n')), [value.join('\n')]);
  return (
    <label className="field">
      <span>{label}</span>
      <textarea className="text" style={{ fontFamily: 'var(--font)', fontSize: 13 }} value={text} onChange={(e) => setText(e.target.value)} onBlur={() => onChange(text.split('\n').map((l) => l.trim()).filter(Boolean))} />
    </label>
  );
}

function Scenarios({ state, target }: { state: EntityState; target: string }) {
  const list = state.plan.scenarios.filter((s) => s.target === target);
  if (!list.length) return <p className="muted" style={{ margin: 0 }}>Not in the plan: the element is not confirmed or applies to no variant.</p>;
  const cellOf = (id: string) =>
    [...state.coverage.transitions, ...state.coverage.forbidden].flatMap((r) => Object.values(r.cells)).find((c) => c?.scenario === id);
  const text = { passed: 'passed', failed: 'failed', blocked: 'blocked', skipped: 'skipped', 'not-run': 'not run' };
  return (
    <>
      {list.map((s) => {
        const c = cellOf(s.id);
        const status = s.blocked ? 'blocked' : (c?.status ?? 'not-run');
        return (
          <div className="scen" key={s.id} title={c?.error ?? s.blocked ?? undefined}>
            <span className={`dot ${status}`} />
            <span>{s.variant}</span>
            <span className="muted">
              {text[status]}
              {s.preparation && `, setup: ${s.preparation === 'tool' ? 'tool' : s.preparation === 'path' ? 'explicit path' : 'graph path'}`}
            </span>
          </div>
        );
      })}
    </>
  );
}

function Issues({ state, path }: { state: EntityState; path: string }) {
  const list = state.issues.filter((i) => i.path === path || i.path.startsWith(`${path}.`));
  if (!list.length) return null;
  return (
    <ul className="issues">
      {list.map((i, n) => (
        <li key={n} className={i.level}>{i.message}</li>
      ))}
    </ul>
  );
}

function Panel({ title, id, status, children, onDelete }: { title: string; id: string; status?: Status; children: ReactNode; onDelete?(): void }) {
  return (
    <div className="inspector">
      <h2>{title}</h2>
      <div className="sub row">
        <span className="id">{id}</span>
        {status && (
          <span className={`status-pill ${status}`}>
            <i />
            {statusText[status]}
          </span>
        )}
      </div>
      {children}
      {onDelete && (
        <section>
          <button className="btn danger" onClick={onDelete}>Remove from model</button>
        </section>
      )}
    </div>
  );
}

export function Inspector(props: Props) {
  const { entity, state, project, selection, onChange } = props;
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setError(null), [selection]);

  const roles = project.project.roles.map((r): [string, string] => [r.id, r.title]);
  const states = entity.states.map((s): [string, string] => [s.id, s.title]);
  const prepareTools = Object.entries(project.project.mcp).flatMap(([srv, cfg]) => cfg.allow.prepare.map((t) => `${srv}.${t}`));

  const update = <K extends 'states' | 'transitions' | 'forbidden' | 'variants'>(key: K, id: string, patch: Partial<Entity[K][number]>) =>
    onChange({ ...entity, [key]: (entity[key] as { id: string }[]).map((x) => (x.id === id ? { ...x, ...patch } : x)) });

  const remove = (key: 'states' | 'transitions' | 'forbidden' | 'variants', id: string, refs: string[]) => {
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
          <Select
            label="Read tool"
            value={entity.reader.tool}
            options={Object.entries(project.project.mcp).flatMap(([srv, cfg]) => cfg.allow.read.map((t): [string, string] => [`${srv}.${t}`, `${srv}.${t}`]))}
            onChange={(tool) => onChange({ ...entity, reader: { ...entity.reader, tool } })}
          />
          <KeyValues label="Arguments ({{key}} is the instance key)" value={entity.reader.args} onChange={(args) => onChange({ ...entity, reader: { ...entity.reader, args } })} />
          <Text label="Correlation key: the field that identifies an instance in every interface" value={entity.key} onChange={(key) => onChange({ ...entity, key })} />
        </section>
        <section>
          <h3>Forbidden actions</h3>
          {entity.forbidden.length === 0 && <p className="muted" style={{ margin: 0 }}>No forbidden actions yet. Add them from a state's inspector.</p>}
          {entity.forbidden.map((f) => (
            <div key={f.id} className="scen" style={{ cursor: 'pointer' }} onClick={() => props.onSelect({ kind: 'forbidden', id: f.id })}>
              <span style={{ color: 'var(--fail)' }}>⊘</span>
              <span>{project.project.roles.find((r) => r.id === f.role)?.title}: {entity.transitions.find((t) => t.id === f.transition)?.title} in {stateTitle(entity, f.state)}</span>
            </div>
          ))}
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
    const refs = [...entity.states, ...entity.transitions, ...entity.forbidden].filter((x) => x.variants?.includes(v.id)).map((x) => x.id);
    return (
      <Panel title={v.title} id={v.id} status={v.status} onDelete={() => remove('variants', v.id, refs)}>
        {error && <div className="error-box" style={{ marginBottom: 12 }}>{error}</div>}
        <Text label="Title" value={v.title} onChange={(title) => update('variants', v.id, { title } as Partial<Variant>)} />
        <Text label="Description" value={v.description ?? ''} onChange={(d) => update('variants', v.id, { description: d || undefined } as Partial<Variant>)} />
        <StatusField value={v.status} onChange={(status) => update('variants', v.id, { status } as Partial<Variant>)} />
        <section>
          <h3>Provenance</h3>
          <ProvenanceNote p={v.provenance} />
        </section>
      </Panel>
    );
  }

  if (selection.kind === 'state') {
    const s = entity.states.find((x) => x.id === selection.id);
    if (!s) return null;
    const set = (patch: Partial<State>) => update('states', s.id, patch);
    const refs = [
      ...entity.transitions.filter((t) => t.from === s.id || t.to === s.id).map((t) => t.id),
      ...entity.forbidden.filter((f) => f.state === s.id).map((f) => f.id),
    ];
    const toolSetup = s.setup.find((x) => x.kind === 'tool');
    const outgoing = entity.transitions.filter((t) => t.from !== s.id);
    const addForbidden = () => {
      const t = outgoing[0];
      if (!t) return setError('No transitions to forbid in this state');
      const other = project.project.roles.find((r) => r.id !== t.role) ?? project.project.roles[0];
      const id = nextId(`${other.id}-cannot-${t.id}`, entity.forbidden.map((f) => f.id));
      const f: Forbidden = { id, role: other.id, state: s.id, transition: t.id, status: 'confirmed', provenance: { source: 'human', evidence: [] } };
      onChange({ ...entity, forbidden: [...entity.forbidden, f] });
      props.onSelect({ kind: 'forbidden', id });
    };
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
            hint={`Read via ${entity.reader.tool}`}
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
          <h3>Forbidden actions in this state</h3>
          {entity.forbidden.filter((f) => f.state === s.id).map((f) => (
            <div key={f.id} className="scen" style={{ cursor: 'pointer' }} onClick={() => props.onSelect({ kind: 'forbidden', id: f.id })}>
              <span style={{ color: 'var(--fail)' }}>⊘</span>
              {project.project.roles.find((r) => r.id === f.role)?.title}: {entity.transitions.find((t) => t.id === f.transition)?.title}
            </div>
          ))}
          <button className="btn small" onClick={addForbidden}>Add forbidden action</button>
        </section>
        <section>
          <h3>Provenance</h3>
          <ProvenanceNote p={s.provenance} />
        </section>
      </Panel>
    );
  }

  if (selection.kind === 'transition') {
    const t = entity.transitions.find((x) => x.id === selection.id);
    if (!t) return null;
    const set = (patch: Partial<Transition>) => update('transitions', t.id, patch);
    const refs = [
      ...entity.forbidden.filter((f) => f.transition === t.id).map((f) => f.id),
      ...entity.states.filter((s) => s.setup.some((x) => x.kind === 'path' && x.via.includes(t.id))).map((s) => s.id),
    ];
    const actions = project.actions.map((a): [string, string] => [a.name, a.name]);
    const setEffect = (i: number, patch: Partial<Effect>) => set({ effects: t.effects.map((e, n) => (n === i ? { ...e, ...patch } : e)) });
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
        <Select label="Role" value={t.role} options={roles} onChange={(role) => set({ role })} />
        <Select label="Action from the actions/ library" value={t.action} options={actions} onChange={(action) => set({ action })} />
        <VariantsField entity={entity} value={t.variants} onChange={(variants) => set({ variants })} />
        <Lines label="Guards (one per line)" value={t.guards} onChange={(guards) => set({ guards })} />
        <section>
          <h3>Expected effects</h3>
          {t.effects.map((e, i) => (
            <div key={i} style={{ borderLeft: '2px solid var(--rule)', paddingLeft: 10, marginBottom: 10 }}>
              <Text label="Description" value={e.description} onChange={(description) => setEffect(i, { description })} />
              {entity.relations.length > 0 && (
                <Select
                  label="Checked on"
                  value={e.relation ?? ''}
                  options={[['', `this ${entity.title.toLowerCase()}`], ...entity.relations.map((r): [string, string] => [r.id, `related ${state.catalog[r.entity]?.title ?? r.entity}`])]}
                  onChange={(relation) => setEffect(i, { relation: relation || undefined, delta: relation ? e.delta : undefined })}
                />
              )}
              <div className="row">
                <div style={{ flex: 1 }}><Text label="Field" value={e.field ?? ''} placeholder="manual" onChange={(f) => setEffect(i, { field: f || undefined })} /></div>
                {e.relation && (
                  <div style={{ flex: 1 }}>
                    <Select
                      label="Check"
                      value={e.delta !== undefined ? 'delta' : 'equals'}
                      options={[['equals', 'equals'], ['delta', 'changes by']]}
                      onChange={(mode) => setEffect(i, mode === 'delta' ? { delta: -1, equals: undefined } : { delta: undefined })}
                    />
                  </div>
                )}
                <div style={{ flex: 1 }}>
                  {e.delta !== undefined ? (
                    <Text label="Change" value={String(e.delta)} onChange={(v) => setEffect(i, { delta: Number(v) || 0 })} />
                  ) : (
                    <Text
                      label="Value"
                      value={e.equals === undefined ? '' : typeof e.equals === 'string' ? e.equals : JSON.stringify(e.equals)}
                      onChange={(v) => {
                        let equals: unknown = v;
                        try { equals = JSON.parse(v); } catch { /* string */ }
                        setEffect(i, { equals: v === '' ? undefined : equals });
                      }}
                    />
                  )}
                </div>
              </div>
              {e.variants && <p className="muted" style={{ margin: '0 0 6px' }}>Only for {e.variants.join(', ')}</p>}
              <button className="btn small" onClick={() => set({ effects: t.effects.filter((_, n) => n !== i) })}>Remove</button>
            </div>
          ))}
          <button className="btn small" onClick={() => set({ effects: [...t.effects, { description: 'New effect' }] })}>Add effect</button>
        </section>
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

  const f = entity.forbidden.find((x) => x.id === selection.id);
  if (!f) return null;
  const set = (patch: Partial<Forbidden>) => update('forbidden', f.id, patch);
  return (
    <Panel title="Forbidden action" id={f.id} status={f.status} onDelete={() => remove('forbidden', f.id, [])}>
      <Issues state={state} path={`forbidden.${f.id}`} />
      <p className="muted" style={{ marginTop: 0 }}>The role must not be able to perform the transition in this state. Checked via the action's available().</p>
      <Select label="Role" value={f.role} options={roles} onChange={(role) => set({ role })} />
      <Select label="State" value={f.state} options={states} onChange={(s) => set({ state: s })} />
      <Select label="Transition" value={f.transition} options={entity.transitions.map((t) => [t.id, t.title])} onChange={(transition) => set({ transition })} />
      <VariantsField entity={entity} value={f.variants} onChange={(variants) => set({ variants })} />
      <Text label="Note" value={f.note ?? ''} onChange={(note) => set({ note: note || undefined })} />
      <StatusField value={f.status} onChange={(status) => set({ status })} />
      <section>
        <h3>Scenarios</h3>
        <Scenarios state={state} target={f.id} />
      </section>
      <section>
        <h3>Provenance</h3>
        <ProvenanceNote p={f.provenance} />
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
    entity.transitions.some((t) => t.effects.some((e) => e.relation === id));
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
