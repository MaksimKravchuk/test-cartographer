import { useMemo, useState } from 'react';
import type { Condition, Entity, Journey, Rule, Scenario, Status, Step } from '@tc/model';
import type { EntityState, ProjectState } from '../api.ts';
import { nextId } from '../graph.ts';
import { Tip } from '../ui.tsx';

type Props = {
  entity: Entity; // the draft being edited
  state: EntityState; // the saved model, its plan and results
  project: ProjectState;
  running: boolean;
  onChange(e: Entity): void;
  onRun(filter: { ids?: string[]; entity?: string }): void;
};

const NEW = '@new';
type RunStatus = 'passed' | 'failed' | 'skipped' | 'blocked' | 'not-run';
const statusText: Record<RunStatus, string> = { passed: 'passed', failed: 'failed', skipped: 'skipped', blocked: 'blocked', 'not-run': 'not run' };
const phaseText = { arrange: 'Arrange', act: 'Act', assert: 'Assert' } as const;

function runStatus(state: EntityState, sc: Scenario): RunStatus {
  if (sc.blocked) return 'blocked';
  return (state.results[sc.id]?.status as RunStatus | undefined) ?? 'not-run';
}

function worst(list: RunStatus[]): RunStatus {
  for (const s of ['failed', 'blocked', 'not-run', 'skipped'] as const) if (list.includes(s)) return s;
  return list.length ? 'passed' : 'not-run';
}

export function ScenariosView({ entity, state, project, running, onChange, onRun }: Props) {
  const [open, setOpen] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ kind: 'journey' | 'rule'; id: string } | null>(null);
  const plan = state.plan.scenarios;
  const unsaved = JSON.stringify(entity) !== JSON.stringify(state.entity);

  const stateTitle = (id: string) => (id === NEW ? 'New' : (entity.states.find((s) => s.id === id)?.title ?? id));
  // Deny scenario titles use “before it exists” instead of “New” for @new.
  const denyStateTitle = (id: string) => (id === NEW ? 'before it exists' : stateTitle(id));
  const roleTitle = (id: string) => project.project.roles.find((r) => r.id === id)?.title ?? id;
  const variantTitle = (id: string) => entity.variants.find((v) => v.id === id)?.title ?? id;
  const actionTitle = (id: string) => entity.actions.find((a) => a.id === id)?.title ?? id;

  const stepText = (s: Step): string => {
    switch (s.do) {
      case 'prepare': return `Prepare with ${s.tool} in “${stateTitle(s.state)}”`;
      case 'transition':
        return s.invoke
          ? `${roleTitle(s.role)} (system): ${s.title} via ${s.invoke.tool} (${stateTitle(s.from)} → ${stateTitle(s.to)})`
          : `${roleTitle(s.role)}: ${s.title} (${stateTitle(s.from)} → ${stateTitle(s.to)})`;
      case 'perform':
        return s.invoke
          ? `${roleTitle(s.role)} (system): ${s.title} via ${s.invoke.tool}, stays in “${stateTitle(s.state)}”`
          : `${roleTitle(s.role)}: ${s.title}, stays in “${stateTitle(s.state)}”`;
      case 'expectState': return `State “${stateTitle(s.state)}” confirmed by reading`;
      case 'expectInvariant': return `Invariant holds: ${s.title}`;
      case 'expectField': return `${s.description}: ${s.field} = ${JSON.stringify(s.equals)}`;
      case 'expectUnavailable': return `${roleTitle(s.role)} can't ${actionTitle(s.action)} in “${stateTitle(s.state)}”`;
      case 'manual': return `Manual check: ${s.description}`;
      case 'related': return `Prepare the related ${state.catalog[s.entity]?.title ?? s.entity} (${s.variant}) in “${state.catalog[s.entity]?.states.find((x) => x.id === s.state)?.title ?? s.state}”`;
      case 'expectRelated':
        return `${s.description}: related ${s.relation}.${s.field} ${s.delta !== undefined ? `changes by ${s.delta}` : `= ${JSON.stringify(s.equals)}`}`;
    }
  };

  const setList = <K extends 'scenarios' | 'rules'>(key: K, list: Entity[K]) => onChange({ ...entity, [key]: list });

  // Deny scenarios don't have a unique `target` per role (target is
  // `<action>@<state>`, independent of role), so a chip/detail key includes
  // the role when scoping to one — otherwise two roles denied the same
  // action in the same state would bleed into each other's row.
  const chipKey = (role: string | undefined, target: string, variant: string) => `${role ?? ''}|${target}|${variant}`;

  // A scenario belongs to `target` either directly, or — for a business rule
  // whose only conditions are roles/authenticated — as a deny scenario that
  // carries the rule's id in `rules` (see plan.ts's ruleTagsFor()).
  const forTarget = (target: string) => (x: Scenario) => x.target === target || x.rules.includes(target);

  // Variant chips for a group of scenarios with the same target (optionally scoped to one role).
  const Chips = ({ target, role }: { target: string; role?: string }) => {
    const byVariant = new Map<string, Scenario[]>();
    for (const sc of plan.filter((x) => forTarget(target)(x) && (!role || x.role === role))) byVariant.set(sc.variant, [...(byVariant.get(sc.variant) ?? []), sc]);
    if (!byVariant.size) return <span className="muted">not in the plan</span>;
    return (
      <span className="chips">
        {[...byVariant].map(([v, list]) => {
          const st = worst(list.map((sc) => runStatus(state, sc)));
          const key = chipKey(role, target, v);
          return (
            <button type="button" key={v} className={`chip ${st}`} aria-expanded={open === key} onClick={() => setOpen(open === key ? null : key)}>
              <span className={`dot ${st}`} />
              {variantTitle(v)}
              <span className="sr-only">, {statusText[st]}</span>
            </button>
          );
        })}
      </span>
    );
  };

  // Steps of the scenarios behind an opened chip.
  const Details = ({ target, role }: { target: string; role?: string }) => {
    if (!open) return null;
    const [keyRole, keyTarget, keyVariant] = open.split('|');
    if (keyTarget !== target || (role ? keyRole !== role : keyRole !== '')) return null;
    const list = plan.filter((x) => forTarget(target)(x) && x.variant === keyVariant && (!role || x.role === role));
    return (
      <div className="scenario-details">
        {list.map((sc) => {
          const r = state.results[sc.id];
          const st = runStatus(state, sc);
          return (
            <div key={sc.id} className="scenario-detail">
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <div>
                  <b>{sc.title}</b> <span className="id">{sc.id}</span>
                </div>
                <div className="row">
                  <span className={`cell ${st}`}>{statusText[st]}</span>
                  {!sc.blocked && (
                    <button className="btn small" disabled={running || unsaved} onClick={() => onRun({ ids: [sc.id] })}>Run</button>
                  )}
                </div>
              </div>
              {sc.blocked ? (
                <p className="blocked-note">{sc.blocked}</p>
              ) : (
                <ol className="steps">
                  {sc.steps.map((s, i) => (
                    <li key={i}><span className={`phase ${s.phase}`}>{phaseText[s.phase]}</span>{stepText(s)}</li>
                  ))}
                </ol>
              )}
              {r?.error && <div className="error-box">{r.error}</div>}
            </div>
          );
        })}
      </div>
    );
  };

  const generated = useMemo(() => {
    const seen = new Set<string>();
    return plan.filter((sc) => (sc.kind === 'transition' || sc.kind === 'permit') && !seen.has(sc.target) && seen.add(sc.target));
  }, [plan]);

  // Deny scenarios: closed-world negatives, one per (role, action, state) ×
  // variant — they can number in the hundreds, so group by role and collapse.
  const deniesByRole = useMemo(() => {
    const map = new Map<string, Scenario[]>();
    for (const sc of plan) if (sc.kind === 'deny') map.set(sc.role, [...(map.get(sc.role) ?? []), sc]);
    return map;
  }, [plan]);

  const addJourney = () => {
    const id = nextId('journey', entity.scenarios.map((j) => j.id));
    const initial = entity.transitions.some((t) => t.from === NEW) ? NEW : (entity.states.find((s) => s.initial)?.id ?? entity.states[0]?.id ?? NEW);
    const first = entity.transitions.find((t) => t.from === initial);
    setList('scenarios', [...entity.scenarios, { id, title: 'New journey', start: initial, path: first ? [first.id] : [], tags: [], status: 'confirmed', provenance: { source: 'human', evidence: [], sources: [] } } as Journey]);
    setEditing({ kind: 'journey', id });
  };

  const addRule = () => {
    const id = nextId('rule', entity.rules.map((r) => r.id));
    const t = entity.transitions[0];
    if (!t) return;
    setList('rules', [...entity.rules, { id, title: 'New rule', text: '', transition: t.id, requires: [{ kind: 'authenticated' }], status: 'confirmed', provenance: { source: 'human', evidence: [], sources: [] } }]);
    setEditing({ kind: 'rule', id });
  };

  return (
    <div className="page scenarios">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'start' }}>
        <div>
          <h1>Scenarios</h1>
          <p className="lede">
            Journeys and business rules are written by people. Everything else is generated from the model: one scenario per transition and permit for each
            role and variant, plus one denied scenario per (role, action, state) the closed world doesn't allow.
          </p>
        </div>
        <button className="btn primary" disabled={running || unsaved} onClick={() => onRun({ entity: entity.id })}>Run all {plan.length}</button>
      </div>
      {unsaved && <div className="notice">You have unsaved changes. Save the model to update the plan and run scenarios.</div>}

      <section className="scenario-section">
        <header>
          <h2>Journeys</h2>
          <button className="btn small" onClick={addJourney}>New journey</button>
        </header>
        {entity.scenarios.length === 0 && <p className="muted">A journey chains transitions end to end, for example an order from placement to delivery.</p>}
        {entity.scenarios.map((j) =>
          editing?.kind === 'journey' && editing.id === j.id ? (
            <JourneyEditor
              key={j.id}
              journey={j}
              entity={entity}
              roleTitle={roleTitle}
              stateTitle={stateTitle}
              onChange={(next) => setList('scenarios', entity.scenarios.map((x) => (x.id === j.id ? next : x)))}
              onRemove={() => {
                setList('scenarios', entity.scenarios.filter((x) => x.id !== j.id));
                setEditing(null);
              }}
              onDone={() => setEditing(null)}
            />
          ) : (
            <div key={j.id} className={`scenario-row ${j.status}`}>
              <div className="scenario-main">
                <div className="scenario-title">{j.title}</div>
                <div className="path">
                  <span className="path-state">{stateTitle(j.start)}</span>
                  {j.path.map((id, i) => {
                    const t = entity.transitions.find((x) => x.id === id);
                    return (
                      <span key={i} className="path-step">
                        <span className="path-arrow">{t ? `${t.title} · ${t.by.map(roleTitle).join(', ')}` : `unknown “${id}”`}</span>
                        <span className="path-state">{t ? stateTitle(t.to) : '?'}</span>
                      </span>
                    );
                  })}
                </div>
                {j.description && <p className="muted" style={{ margin: '4px 0 0' }}>{j.description}</p>}
              </div>
              <div className="scenario-side">
                <Chips target={j.id} />
                <button className="btn small" onClick={() => setEditing({ kind: 'journey', id: j.id })}>Edit</button>
              </div>
              <Details target={j.id} />
            </div>
          ),
        )}
      </section>

      <section className="scenario-section">
        <header>
          <h2>Business rules</h2>
          <button className="btn small" onClick={addRule} disabled={!entity.transitions.length}>New rule</button>
        </header>
        {entity.rules.length === 0 && <p className="muted">A rule states a condition in the product's own words, for example “a user must be signed in to create an order”. Each condition becomes a negative scenario.</p>}
        {entity.rules.map((r) =>
          editing?.kind === 'rule' && editing.id === r.id ? (
            <RuleEditor
              key={r.id}
              rule={r}
              entity={entity}
              project={project}
              state={state}
              onChange={(next) => setList('rules', entity.rules.map((x) => (x.id === r.id ? next : x)))}
              onRemove={() => {
                setList('rules', entity.rules.filter((x) => x.id !== r.id));
                setEditing(null);
              }}
              onDone={() => setEditing(null)}
            />
          ) : (
            <div key={r.id} className={`scenario-row ${r.status}`}>
              <div className="scenario-main">
                <div className="scenario-title">{r.title}</div>
                <p className="rule-text">{r.text || <span className="muted">No wording yet</span>}</p>
                <div className="muted">
                  Applies to “{entity.transitions.find((t) => t.id === r.transition)?.title ?? r.transition}”; requires{' '}
                  {r.requires.map((c) => describeCondition(c, roleTitle, entity, state)).join('; ')}
                </div>
              </div>
              <div className="scenario-side">
                <Chips target={r.id} />
                <button className="btn small" onClick={() => setEditing({ kind: 'rule', id: r.id })}>Edit</button>
              </div>
              <Details target={r.id} />
            </div>
          ),
        )}
      </section>

      <section className="scenario-section">
        <header>
          <h2>Generated from the model</h2>
        </header>
        {generated.length === 0 && <p className="muted">Add confirmed transitions or permits on the map to generate scenarios.</p>}
        {generated.map((sc) => {
          const t = sc.kind === 'transition' ? entity.transitions.find((x) => x.id === sc.target) : undefined;
          const p = sc.kind === 'permit' ? entity.permits.find((x) => x.id === sc.target) : undefined;
          const by = t?.by ?? p?.by ?? [];
          return (
            <div key={sc.target} className="scenario-row">
              <div className="scenario-main">
                <div className="scenario-title">{t ? t.title : p ? p.title : sc.target}</div>
                <div className="muted">
                  {t
                    ? `${stateTitle(t.from)} → ${stateTitle(t.to)} · ${by.map(roleTitle).join(', ')}`
                    : p
                      ? `“${actionTitle(p.action)}”, stays in state · ${by.map(roleTitle).join(', ')}`
                      : ''}
                </div>
                <RuleChips ids={sc.rules} entity={entity} />
              </div>
              <div className="scenario-side">
                <Chips target={sc.target} />
              </div>
              <Details target={sc.target} />
            </div>
          );
        })}
      </section>

      <section className="scenario-section">
        <header>
          <h2>Denied (closed world)</h2>
          <span className="muted">
            {[...deniesByRole.values()].reduce((n, l) => n + l.length, 0)} scenarios across {deniesByRole.size} {deniesByRole.size === 1 ? 'role' : 'roles'}
          </span>
        </header>
        {deniesByRole.size === 0 && <p className="muted">Nothing is denied yet — add a project on Settings and confirm some transitions or permits.</p>}
        {[...deniesByRole].map(([role, all]) => {
          const seen = new Set<string>();
          const reps = all.filter((sc) => !seen.has(sc.target) && seen.add(sc.target));
          const worstOfRole = worst(all.map((sc) => runStatus(state, sc)));
          return (
            <details key={role} className="deny-group">
              <summary>
                <span className={`dot ${worstOfRole}`} />
                <b>{roleTitle(role)}</b>
                <span className="muted">{reps.length} denied {reps.length === 1 ? 'action/state' : 'actions/states'}, {all.length} scenarios across variants</span>
              </summary>
              <div className="deny-list">
                {reps.map((rep) => {
                  const [action, s] = rep.target.split('@');
                  return (
                    <div key={rep.target} className="scenario-row deny-row">
                      <div className="scenario-main">
                        <div className="scenario-title">Can't “{actionTitle(action)}” in {denyStateTitle(s)}</div>
                        <RuleChips ids={rep.rules} entity={entity} />
                      </div>
                      <div className="scenario-side">
                        <Chips target={rep.target} role={role} />
                      </div>
                      <Details target={rep.target} role={role} />
                    </div>
                  );
                })}
              </div>
            </details>
          );
        })}
      </section>
    </div>
  );
}

// A business rule's ids a scenario checks — traceability from the scenario
// back to the product wording that motivated it.
function RuleChips({ ids, entity }: { ids: string[]; entity: Entity }) {
  if (!ids.length) return null;
  return (
    <span className="rule-chips">
      {ids.map((id) => {
        const r = entity.rules.find((x) => x.id === id);
        if (!r?.text || r.text === r.title) return <span key={id} className="chip rule">{r?.title ?? id}</span>;
        return <Tip key={id} toggle tip={r.text}><button type="button" className="chip rule">{r.title}</button></Tip>;
      })}
    </span>
  );
}

function describeCondition(c: Condition, roleTitle: (id: string) => string, entity: Entity, state: EntityState): string {
  switch (c.kind) {
    case 'authenticated': return 'a signed-in user';
    case 'roles': return `role ${c.roles.map(roleTitle).join(' or ')}`;
    case 'entity-state': {
      const rel = entity.relations.find((r) => r.id === c.relation);
      const target = rel ? state.catalog[rel.entity] : undefined;
      const names = c.states.map((id) => target?.states.find((x) => x.id === id)?.title ?? id);
      return `the related ${target?.title ?? c.relation} to be ${names.map((n) => `“${n}”`).join(' or ')}`;
    }
  }
}

function StatusSelect({ value, onChange }: { value: Status; onChange(s: Status): void }) {
  return (
    <label className="field">
      <span>Status</span>
      <select className="text" value={value} onChange={(e) => onChange(e.target.value as Status)}>
        <option value="confirmed">Requirement — included in the test plan</option>
        <option value="observed">Observation — not a requirement</option>
        <option value="proposed">Proposed — awaiting a decision</option>
        <option value="rejected">Rejected</option>
      </select>
    </label>
  );
}

function JourneyEditor(props: {
  journey: Journey;
  entity: Entity;
  roleTitle(id: string): string;
  stateTitle(id: string): string;
  onChange(j: Journey): void;
  onRemove(): void;
  onDone(): void;
}) {
  const { journey: j, entity, roleTitle, stateTitle } = props;
  const set = (patch: Partial<Journey>) => props.onChange({ ...j, ...patch });
  // Where the path currently ends, and which transitions can continue it.
  let cur = j.start;
  for (const id of j.path) cur = entity.transitions.find((t) => t.id === id)?.to ?? cur;
  const next = entity.transitions.filter((t) => t.from === cur && t.status !== 'rejected');
  const starts = [...(entity.transitions.some((t) => t.from === NEW) ? [NEW] : []), ...entity.states.map((s) => s.id)];

  return (
    <div className="editor-card">
      <div className="row" style={{ gap: 12 }}>
        <label className="field" style={{ flex: 2 }}>
          <span>Title</span>
          <input className="text" value={j.title} onChange={(e) => set({ title: e.target.value })} />
        </label>
        <label className="field" style={{ flex: 1 }}>
          <span>Starts in</span>
          <select className="text" value={j.start} onChange={(e) => set({ start: e.target.value, path: [] })}>
            {starts.map((id) => <option key={id} value={id}>{id === NEW ? 'New — the journey creates it' : stateTitle(id)}</option>)}
          </select>
        </label>
      </div>
      <label className="field">
        <span>What it checks</span>
        <input className="text" value={j.description ?? ''} onChange={(e) => set({ description: e.target.value || undefined })} />
      </label>
      <div className="field" style={{ display: 'grid', gap: 6, marginBottom: 12 }}>
        <span style={{ fontSize: '0.75rem', color: 'var(--fg-3)' }}>Path</span>
        <ol className="steps editable">
          {j.path.map((id, i) => {
            const t = entity.transitions.find((x) => x.id === id);
            return (
              <li key={i}>
                {t ? `${t.title} · ${t.by.map(roleTitle).join(', ')} → ${stateTitle(t.to)}` : `unknown “${id}”`}
                {i === j.path.length - 1 && (
                  <button className="btn small" style={{ marginLeft: 8 }} onClick={() => set({ path: j.path.slice(0, -1) })}>Remove</button>
                )}
              </li>
            );
          })}
        </ol>
        {next.length ? (
          <select
            className="text"
            value=""
            onChange={(e) => e.target.value && set({ path: [...j.path, e.target.value] })}
            aria-label="Add a step"
          >
            <option value="">Add a step from “{stateTitle(cur)}”…</option>
            {next.map((t) => <option key={t.id} value={t.id}>{t.title} · {t.by.map(roleTitle).join(', ')} → {stateTitle(t.to)}</option>)}
          </select>
        ) : (
          <span className="muted">The path ends in “{stateTitle(cur)}”: no transitions go further.</span>
        )}
      </div>
      <div className="checks" style={{ marginBottom: 12 }}>
        <span className="muted">Variants:</span>
        <label>
          <input type="checkbox" checked={!j.variants} onChange={() => set({ variants: j.variants ? undefined : entity.variants.map((v) => v.id) })} />
          every variant the path applies to
        </label>
        {j.variants && entity.variants.map((v) => (
          <label key={v.id}>
            <input type="checkbox" checked={j.variants!.includes(v.id)} onChange={(e) => set({ variants: e.target.checked ? [...j.variants!, v.id] : j.variants!.filter((x) => x !== v.id) })} />
            {v.title}
          </label>
        ))}
      </div>
      <StatusSelect value={j.status} onChange={(status) => set({ status })} />
      <div className="row">
        <button className="btn primary" onClick={props.onDone} disabled={!j.path.length}>Done</button>
        <button className="btn danger" onClick={props.onRemove}>Remove journey</button>
      </div>
    </div>
  );
}

function RuleEditor(props: { rule: Rule; entity: Entity; project: ProjectState; state: EntityState; onChange(r: Rule): void; onRemove(): void; onDone(): void }) {
  const { rule: r, entity, project } = props;
  const set = (patch: Partial<Rule>) => props.onChange({ ...r, ...patch });
  const has = (kind: Condition['kind']) => r.requires.find((c) => c.kind === kind);
  const toggle = (kind: 'authenticated' | 'roles', on: boolean) =>
    set({
      requires: on
        ? [...r.requires, kind === 'authenticated' ? { kind } : { kind, roles: [project.project.roles[0].id] }]
        : r.requires.filter((c) => c.kind !== kind),
    });
  const roles = has('roles') as Extract<Condition, { kind: 'roles' }> | undefined;
  const entityConds = r.requires.filter((c): c is Extract<Condition, { kind: 'entity-state' }> => c.kind === 'entity-state');
  const guests = project.project.roles.filter((x) => !x.login);

  return (
    <div className="editor-card">
      <div className="row" style={{ gap: 12 }}>
        <label className="field" style={{ flex: 1 }}>
          <span>Title</span>
          <input className="text" value={r.title} onChange={(e) => set({ title: e.target.value })} />
        </label>
        <label className="field" style={{ flex: 1 }}>
          <span>Applies to transition</span>
          <select className="text" value={r.transition} onChange={(e) => set({ transition: e.target.value })}>
            {entity.transitions.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
          </select>
        </label>
      </div>
      <label className="field">
        <span>The rule in the product's words</span>
        <textarea className="text prose" value={r.text} onChange={(e) => set({ text: e.target.value })} placeholder="A user must be signed in to create an order." />
      </label>
      <div className="field" style={{ display: 'grid', gap: 8, marginBottom: 12 }}>
        <span style={{ fontSize: '0.75rem', color: 'var(--fg-3)' }}>Conditions — each one becomes negative scenarios</span>
        <label className="row">
          <input type="checkbox" checked={!!has('authenticated')} onChange={(e) => toggle('authenticated', e.target.checked)} />
          Only signed-in users
          <span className="muted">
            {guests.length ? `— checked as ${guests.map((g) => g.title).join(', ')}` : '— add a role without login in Settings to check it'}
          </span>
        </label>
        <label className="row">
          <input type="checkbox" checked={!!roles} onChange={(e) => toggle('roles', e.target.checked)} />
          Only these roles
        </label>
        {roles && (
          <div className="checks" style={{ paddingLeft: 24 }}>
            {project.project.roles.map((x) => (
              <label key={x.id}>
                <input
                  type="checkbox"
                  checked={roles.roles.includes(x.id)}
                  onChange={(e) =>
                    set({
                      requires: r.requires.map((c) =>
                        c === roles ? { ...roles, roles: e.target.checked ? [...roles.roles, x.id] : roles.roles.filter((y) => y !== x.id) } : c,
                      ),
                    })
                  }
                />
                {x.title}
              </label>
            ))}
          </div>
        )}
        {entityConds.map((c, i) => {
          const rel = entity.relations.find((x) => x.id === c.relation);
          const target = rel ? props.state.catalog[rel.entity] : undefined;
          return (
            <div key={i} className="relation-card">
              <div className="row" style={{ gap: 6 }}>
                <span>The related</span>
                <select className="text" style={{ width: 'auto' }} value={c.relation} onChange={(e) => set({ requires: r.requires.map((x) => (x === c ? { ...c, relation: e.target.value, states: [] } : x)) })}>
                  {entity.relations.map((x) => <option key={x.id} value={x.id}>{props.state.catalog[x.entity]?.title ?? x.entity}</option>)}
                </select>
                <span>must be in</span>
                <button className="btn small" style={{ marginLeft: 'auto' }} onClick={() => set({ requires: r.requires.filter((x) => x !== c) })}>Remove</button>
              </div>
              <div className="checks" style={{ marginTop: 6 }}>
                {target?.states.map((st) => (
                  <label key={st.id}>
                    <input
                      type="checkbox"
                      checked={c.states.includes(st.id)}
                      onChange={(e) => set({ requires: r.requires.map((x) => (x === c ? { ...c, states: e.target.checked ? [...c.states, st.id] : c.states.filter((y) => y !== st.id) } : x)) })}
                    />
                    {st.title}
                  </label>
                ))}
              </div>
              <p className="muted" style={{ margin: '4px 0 0' }}>Every other state becomes a negative scenario: the transition must be unavailable.</p>
            </div>
          );
        })}
        <div>
          <button
            className="btn small"
            disabled={!entity.relations.length}
            onClick={() => set({ requires: [...r.requires, { kind: 'entity-state', relation: entity.relations[0].id, states: [] }] })}
          >
            Add a condition on a related entity
          </button>
          {!entity.relations.length && <span className="muted"> Add a relation on the Map tab first.</span>}
        </div>
      </div>
      <StatusSelect value={r.status} onChange={(status) => set({ status })} />
      <div className="row">
        <button className="btn primary" onClick={props.onDone} disabled={!r.requires.length || !r.text.trim()}>Done</button>
        <button className="btn danger" onClick={props.onRemove}>Remove rule</button>
      </div>
    </div>
  );
}
