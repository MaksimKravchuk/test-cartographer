import { useEffect, useState, type ReactNode } from 'react';
import type { Action, ActionKind, Effect, Entity, Permit, Provenance, Status } from '@tc/model';
import type { EntityState, ProjectState } from '../api.ts';

// Small, generic form fields shared by every element editor in the Inspector.
// Kept together so Inspector.tsx (and the Action/Permit panels below) don't
// each redefine the same input wrappers.

export const statusText: Record<Status, string> = {
  confirmed: 'Requirement',
  observed: 'Observation',
  proposed: 'Proposed',
  rejected: 'Rejected',
};

export function StatusField({ value, onChange }: { value: Status; onChange(s: Status): void }) {
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

export function ProvenanceNote({ p }: { p?: Provenance }) {
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

export function Text({ label, value, onChange, placeholder }: { label: string; value: string; onChange(v: string): void; placeholder?: string }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input className="text" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

export function Select({ label, value, options, onChange }: { label: string; value: string; options: [string, string][]; onChange(v: string): void }) {
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

// A checkbox group with an "all" shortcut for an optional array field
// (undefined means "every option" — used for Entity.variants/Permit.states).
export function OptionalMultiField({ label, options, value, onChange }: { label: string; options: [string, string][]; value?: string[]; onChange(v?: string[]): void }) {
  const all = !value;
  return (
    <div className="field" style={{ display: 'grid', gap: 4, marginBottom: 12 }}>
      <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>{label}</span>
      <div className="checks">
        <label>
          <input type="checkbox" checked={all} onChange={() => onChange(all ? options.map(([v]) => v) : undefined)} />
          all
        </label>
        {!all &&
          options.map(([v, t]) => (
            <label key={v}>
              <input
                type="checkbox"
                checked={value!.includes(v)}
                onChange={(e) => onChange(e.target.checked ? [...value!, v] : value!.filter((x) => x !== v))}
              />
              {t}
            </label>
          ))}
      </div>
    </div>
  );
}

export function VariantsField({ entity, value, onChange }: { entity: Entity; value?: string[]; onChange(v?: string[]): void }) {
  return <OptionalMultiField label="Variants" options={entity.variants.map((v): [string, string] => [v.id, v.title])} value={value} onChange={onChange} />;
}

// A required (min 1) role checkbox group, for Transition.by / Permit.by. The
// last checked role can't be unchecked — the schema requires at least one.
export function RoleMultiSelect({ label, roles, value, onChange }: { label: string; roles: [string, string][]; value: string[]; onChange(v: string[]): void }) {
  return (
    <div className="field" style={{ display: 'grid', gap: 4, marginBottom: 12 }}>
      <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>{label}</span>
      <div className="checks">
        {roles.map(([id, title]) => (
          <label key={id}>
            <input
              type="checkbox"
              checked={value.includes(id)}
              disabled={value.length === 1 && value.includes(id)}
              onChange={(e) => onChange(e.target.checked ? [...value, id] : value.filter((x) => x !== id))}
            />
            {title}
          </label>
        ))}
      </div>
    </div>
  );
}

// One "key: value" per line; values are parsed as JSON, otherwise kept as strings.
export function KeyValues({ label, value, onChange, hint }: { label: string; value: Record<string, unknown>; onChange(v: Record<string, unknown>): void; hint?: string }) {
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

export function Lines({ label, value, onChange }: { label: string; value: string[]; onChange(v: string[]): void }) {
  const [text, setText] = useState(value.join('\n'));
  useEffect(() => setText(value.join('\n')), [value.join('\n')]);
  return (
    <label className="field">
      <span>{label}</span>
      <textarea className="text" style={{ fontFamily: 'var(--font)', fontSize: 13 }} value={text} onChange={(e) => setText(e.target.value)} onBlur={() => onChange(text.split('\n').map((l) => l.trim()).filter(Boolean))} />
    </label>
  );
}

// Pass/fail per scenario for an element, straight from the run results — no
// need to go through Coverage's per-variant combined cells here.
export function Scenarios({ state, target }: { state: EntityState; target: string }) {
  const list = state.plan.scenarios.filter((s) => s.target === target);
  if (!list.length) return <p className="muted" style={{ margin: 0 }}>Not in the plan: the element is not confirmed or applies to no variant.</p>;
  const text = { passed: 'passed', failed: 'failed', blocked: 'blocked', skipped: 'skipped', 'not-run': 'not run' };
  return (
    <>
      {list.map((s) => {
        const r = state.results[s.id];
        const status = s.blocked ? 'blocked' : (r?.status ?? 'not-run');
        return (
          <div className="scen" key={s.id} title={r?.error ?? s.blocked ?? undefined}>
            <span className={`dot ${status}`} />
            <span>{s.variant}</span>
            {s.role && <span className="muted">{s.role}</span>}
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

export function Issues({ state, path }: { state: EntityState; path: string }) {
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

export function Panel({ title, id, status, children, onDelete }: { title: string; id: string; status?: Status; children: ReactNode; onDelete?(): void }) {
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

// The expected-effects editor, shared by transitions and permits.
export function EffectsEditor({ entity, state, effects, onChange }: { entity: Entity; state: EntityState; effects: Effect[]; onChange(e: Effect[]): void }) {
  const setEffect = (i: number, patch: Partial<Effect>) => onChange(effects.map((e, n) => (n === i ? { ...e, ...patch } : e)));
  return (
    <section>
      <h3>Expected effects</h3>
      {effects.map((e, i) => (
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
          <button className="btn small" onClick={() => onChange(effects.filter((_, n) => n !== i))}>Remove</button>
        </div>
      ))}
      <button className="btn small" onClick={() => onChange([...effects, { description: 'New effect' }])}>Add effect</button>
    </section>
  );
}

// ── Action editor ──────────────────────────────────────────────────────
export function ActionPanel({
  action: a, entity, state, project, error, onChange, onDelete, onSelect,
}: {
  action: Action;
  entity: Entity;
  state: EntityState;
  project: ProjectState;
  error: string | null;
  onChange(patch: Partial<Action>): void;
  onDelete(): void;
  onSelect(s: { kind: 'transition' | 'permit'; id: string }): void;
}) {
  const runOptions: [string, string][] = project.actions.map((x) => [x.name, x.name]);
  const triggerTools = Object.entries(project.project.mcp).flatMap(([srv, cfg]) => cfg.allow.trigger.map((t) => `${srv}.${t}`));
  const usedBy = [
    ...entity.transitions.filter((t) => t.action === a.id).map((t) => ({ kind: 'transition' as const, id: t.id, title: t.title })),
    ...entity.permits.filter((p) => p.action === a.id).map((p) => ({ kind: 'permit' as const, id: p.id, title: p.title })),
  ];
  return (
    <Panel title={a.title} id={a.id} status={a.status} onDelete={onDelete}>
      {error && <div className="error-box" style={{ marginBottom: 12 }}>{error}</div>}
      <Issues state={state} path={`actions.${a.id}`} />
      <Text label="Title" value={a.title} onChange={(title) => onChange({ title })} />
      <Text label="Description" value={a.description ?? ''} onChange={(d) => onChange({ description: d || undefined })} />
      <Select
        label="Kind"
        value={a.kind}
        options={[['create', 'create'], ['read', 'read'], ['update', 'update'], ['command', 'command'], ['delete', 'delete']]}
        onChange={(kind) => onChange({ kind: kind as ActionKind })}
      />
      <StatusField value={a.status} onChange={(status) => onChange({ status })} />
      <section>
        <h3>How a person performs it</h3>
        <Select label="Action library entry (run)" value={a.run ?? ''} options={[['', '— none —'], ...runOptions]} onChange={(run) => onChange({ run: run || undefined })} />
      </section>
      <section>
        <h3>How a test makes the system perform it</h3>
        {a.invoke ? (
          <>
            <Select label="Trigger tool" value={a.invoke.tool} options={triggerTools.map((t): [string, string] => [t, t])} onChange={(tool) => onChange({ invoke: { ...a.invoke!, tool } })} />
            <KeyValues
              label="Arguments ({{key}}, {{variant}}, {{runTag}}, {{rel.<id>}})"
              value={a.invoke.args}
              onChange={(args) => onChange({ invoke: { ...a.invoke!, args } })}
            />
            <button className="btn small" onClick={() => onChange({ invoke: undefined })}>Remove invoke</button>
          </>
        ) : triggerTools.length > 0 ? (
          <button className="btn small" onClick={() => onChange({ invoke: { tool: triggerTools[0], args: {} } })}>Add invoke tool</button>
        ) : (
          <p className="muted" style={{ marginTop: 0 }}>No trigger tools allowed yet — add one to a server's mcp.*.allow.trigger in Settings.</p>
        )}
      </section>
      <Text label="What makes the system do it in the product (documentation only)" value={a.trigger ?? ''} onChange={(t) => onChange({ trigger: t || undefined })} />
      <section>
        <h3>Used by</h3>
        {usedBy.length === 0 && <p className="muted" style={{ margin: 0 }}>Not used by any transition or permit yet.</p>}
        {usedBy.map((x) => (
          <div key={`${x.kind}-${x.id}`} className="scen" style={{ cursor: 'pointer' }} onClick={() => onSelect({ kind: x.kind, id: x.id })}>
            <span>{x.title}</span>
            <span className="muted">{x.kind}</span>
          </div>
        ))}
      </section>
      <section>
        <h3>Provenance</h3>
        <ProvenanceNote p={a.provenance} />
      </section>
    </Panel>
  );
}

// ── Permit editor ───────────────────────────────────────────────────────
export function PermitPanel({
  permit: p, entity, state, project, error, onChange, onDelete,
}: {
  permit: Permit;
  entity: Entity;
  state: EntityState;
  project: ProjectState;
  error: string | null;
  onChange(patch: Partial<Permit>): void;
  onDelete(): void;
}) {
  const actionOptions: [string, string][] = entity.actions.map((a) => [a.id, a.title]);
  const roleOptions: [string, string][] = project.project.roles.map((r) => [r.id, r.title]);
  const stateOptions: [string, string][] = entity.states.map((s) => [s.id, s.title]);
  return (
    <Panel title={p.title} id={p.id} status={p.status} onDelete={onDelete}>
      {error && <div className="error-box" style={{ marginBottom: 12 }}>{error}</div>}
      <Issues state={state} path={`permits.${p.id}`} />
      <p className="muted" style={{ marginTop: 0 }}>A permit is for an action that leaves the state as it is: read, update, some commands.</p>
      <Text label="Title" value={p.title} onChange={(title) => onChange({ title })} />
      <StatusField value={p.status} onChange={(status) => onChange({ status })} />
      <Select label="Action" value={p.action} options={actionOptions.length ? actionOptions : [['', '— add an action first —']]} onChange={(action) => onChange({ action })} />
      <RoleMultiSelect label="Performed by" roles={roleOptions} value={p.by} onChange={(by) => onChange({ by })} />
      <OptionalMultiField label="States (all — every state of the variant)" options={stateOptions} value={p.states} onChange={(states) => onChange({ states })} />
      <VariantsField entity={entity} value={p.variants} onChange={(variants) => onChange({ variants })} />
      <EffectsEditor entity={entity} state={state} effects={p.effects} onChange={(effects) => onChange({ effects })} />
      <section>
        <h3>Scenarios</h3>
        <Scenarios state={state} target={p.id} />
      </section>
      <section>
        <h3>Provenance</h3>
        <ProvenanceNote p={p.provenance} />
      </section>
    </Panel>
  );
}
