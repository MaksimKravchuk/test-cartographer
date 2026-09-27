import { useState } from 'react';
import type { Cell } from '@tc/model';
import type { EntityState, ProjectState } from '../api.ts';
import { AccessMatrix, VariantTabs } from './AccessMatrix.tsx';

const cellText = { passed: 'passed', failed: 'failed', blocked: 'blocked', skipped: 'skipped', 'not-run': 'not run' };
const stateText = { verified: 'verified', reachable: 'reachable', unreachable: 'unreachable', 'n/a': 'n/a' };

export function CoverageView({ state, project, running, onRun }: { state: EntityState; project: ProjectState; running: boolean; onRun(): void }) {
  const c = state.coverage;
  const [detail, setDetail] = useState<Cell | null>(null);
  const [accessVariant, setAccessVariant] = useState(c.variants[0] ?? '');
  // Falls back to the first variant if the entity changed under us (a
  // stale variant id from a previously opened entity, or a saved one that's gone).
  const effectiveVariant = c.variants.includes(accessVariant) ? accessVariant : (c.variants[0] ?? '');
  const variantTitle = (id: string) => state.entity.variants.find((v) => v.id === id)?.title ?? id;
  const roleTitle = (id: string) => project.project.roles.find((r) => r.id === id)?.title ?? id;
  const byTitles = (ids: string[]) => ids.map(roleTitle).join(', ');
  const actionTitle = (id: string) => state.entity.actions.find((a) => a.id === id)?.title ?? id;

  const cell = (x: Cell | null, key: string) =>
    x ? (
      <button
        key={key}
        className={`cell ${x.status}`}
        style={{ font: 'inherit', fontSize: 12 }}
        onClick={() => setDetail(x.error ? x : null)}
        title={x.error ?? x.scenario}
      >
        {cellText[x.status]}
      </button>
    ) : (
      <span className="cell na">—</span>
    );

  return (
    <div className="page">
      <h1>Coverage: {state.entity.title}</h1>
      <p className="lede">
        The plan is built only from confirmed model elements: each transition and permit is tested for every variant it applies to; the Access
        section below shows the closed-world matrix — everything not explicitly allowed is denied.
      </p>
      <div className="totals">
        <div><b>{c.totals.scenarios}</b><span>scenarios in plan</span></div>
        <div><b style={{ color: 'var(--pass)' }}>{c.totals.passed}</b><span>passed</span></div>
        <div><b style={{ color: c.totals.failed ? 'var(--fail)' : undefined }}>{c.totals.failed}</b><span>failed</span></div>
        <div><b style={{ color: c.totals.blocked ? 'var(--blocked)' : undefined }}>{c.totals.blocked}</b><span>blocked</span></div>
        <div><b>{c.totals['not-run']}</b><span>not run</span></div>
        <div style={{ alignSelf: 'center' }}>
          <button className="btn primary" disabled={running} onClick={onRun}>{running ? 'Job running…' : 'Run tests'}</button>
        </div>
      </div>

      {detail && (
        <div style={{ marginBottom: 24 }}>
          <div className="row" style={{ marginBottom: 6 }}>
            <span className="id">{detail.scenario}</span>
            <button className="btn small" onClick={() => setDetail(null)}>Hide</button>
          </div>
          <div className="error-box">{detail.error}</div>
        </div>
      )}

      <h3>Transitions</h3>
      <table className="matrix">
        <thead>
          <tr>
            <th>Transition</th>
            <th>Performed by</th>
            {c.variants.map((v) => <th key={v}>{variantTitle(v)}</th>)}
          </tr>
        </thead>
        <tbody>
          {c.transitions.map((t) => (
            <tr key={t.id}>
              <td className="name">{t.title} <span className="id">{t.from} → {t.to}</span></td>
              <td className="name muted">{byTitles(t.by)}</td>
              {c.variants.map((v) => <td key={v}>{cell(t.cells[v], v)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>

      {c.permits.length > 0 && (
        <>
          <h3>Permits</h3>
          <p className="muted" style={{ marginTop: -4 }}>Permission for an action that leaves the state as it is: read, update, some commands.</p>
          <table className="matrix">
            <thead>
              <tr>
                <th>Permit</th>
                <th>Action</th>
                <th>Performed by</th>
                {c.variants.map((v) => <th key={v}>{variantTitle(v)}</th>)}
              </tr>
            </thead>
            <tbody>
              {c.permits.map((p) => (
                <tr key={p.id}>
                  <td className="name">{p.title}</td>
                  <td className="name muted">{actionTitle(p.action)}</td>
                  <td className="name muted">{byTitles(p.by)}</td>
                  {c.variants.map((v) => <td key={v}>{cell(p.cells[v], v)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <h3>Access (closed world)</h3>
      <p className="muted" style={{ marginTop: -4 }}>
        Every (role, action, state) triple not decided by a confirmed transition or permit is denied. One variant at a time — the grid is dense.
      </p>
      {c.variants.length > 0 && (
        <>
          <div style={{ marginBottom: 10 }}>
            <VariantTabs variants={c.variants} titleOf={variantTitle} value={effectiveVariant} onChange={setAccessVariant} />
          </div>
          <AccessMatrix coverage={c} entity={state.entity} project={project} variant={effectiveVariant} />
        </>
      )}

      {c.rules.length > 0 && (
        <>
          <h3>Business rules</h3>
          <p className="muted" style={{ marginTop: -4 }}>A rule passes when the transition works for those allowed and is unavailable to everyone else.</p>
          <table className="matrix">
            <thead>
              <tr>
                <th>Rule</th>
                {c.variants.map((v) => <th key={v}>{variantTitle(v)}</th>)}
              </tr>
            </thead>
            <tbody>
              {c.rules.map((r) => (
                <tr key={r.id}>
                  <td className="name" title={r.text}>{r.title}</td>
                  {c.variants.map((v) => <td key={v}>{cell(r.cells[v], v)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {c.journeys.length > 0 && (
        <>
          <h3>Journeys</h3>
          <table className="matrix">
            <thead>
              <tr>
                <th>Journey</th>
                <th>Steps</th>
                {c.variants.map((v) => <th key={v}>{variantTitle(v)}</th>)}
              </tr>
            </thead>
            <tbody>
              {c.journeys.map((j) => (
                <tr key={j.id}>
                  <td className="name">{j.title}</td>
                  <td className="name muted">{j.steps}</td>
                  {c.variants.map((v) => <td key={v}>{cell(j.cells[v], v)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <h3>States</h3>
      <table className="matrix">
        <thead>
          <tr>
            <th>State</th>
            {c.variants.map((v) => <th key={v}>{variantTitle(v)}</th>)}
          </tr>
        </thead>
        <tbody>
          {c.states.map((s) => (
            <tr key={s.id}>
              <td className="name">{s.title} <span className="id">{s.id}</span></td>
              {c.variants.map((v) => (
                <td key={v}><span className={`cell ${s.cells[v] === 'n/a' ? 'na' : s.cells[v]}`}>{stateText[s.cells[v]]}</span></td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>

      <h3>Roles</h3>
      <table className="matrix">
        <tbody>
          {c.roles.map((r) => (
            <tr key={r.role}>
              <td className="name">{roleTitle(r.role)}</td>
              <td className="name"><div className="bar"><i style={{ width: `${r.total ? (100 * r.passed) / r.total : 0}%` }} /></div></td>
              <td className="muted">{r.passed} of {r.total}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
