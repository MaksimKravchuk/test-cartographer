import { useState } from 'react';
import type { Cell } from '@tc/model';
import type { EntityState, ProjectState } from '../api.ts';

const cellText = { passed: 'passed', failed: 'failed', blocked: 'blocked', skipped: 'skipped', 'not-run': 'not run' };
const stateText = { verified: 'verified', reachable: 'reachable', unreachable: 'unreachable', 'n/a': 'n/a' };

export function CoverageView({ state, project, running, onRun }: { state: EntityState; project: ProjectState; running: boolean; onRun(): void }) {
  const c = state.coverage;
  const [detail, setDetail] = useState<Cell | null>(null);
  const variantTitle = (id: string) => state.entity.variants.find((v) => v.id === id)?.title ?? id;
  const roleTitle = (id: string) => project.project.roles.find((r) => r.id === id)?.title ?? id;

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
        The plan is built only from confirmed model elements: each transition and forbidden action is tested for every variant it applies to.
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

      <h3>Transitions and forbidden actions</h3>
      <table className="matrix">
        <thead>
          <tr>
            <th>Transition</th>
            <th>Role</th>
            {c.variants.map((v) => <th key={v}>{variantTitle(v)}</th>)}
          </tr>
        </thead>
        <tbody>
          {c.transitions.map((t) => (
            <tr key={t.id}>
              <td className="name">{t.title} <span className="id">{t.from} → {t.to}</span></td>
              <td className="name muted">{roleTitle(t.role)}</td>
              {c.variants.map((v) => <td key={v}>{cell(t.cells[v], v)}</td>)}
            </tr>
          ))}
          {c.forbidden.map((f) => (
            <tr key={f.id}>
              <td className="name"><span style={{ color: 'var(--fail)' }}>⊘</span> <span className="id">{f.id}</span></td>
              <td className="name muted">{roleTitle(f.role)}</td>
              {c.variants.map((v) => <td key={v}>{cell(f.cells[v], v)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>

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
