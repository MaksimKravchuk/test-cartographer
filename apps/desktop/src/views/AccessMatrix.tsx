import type { ReactNode } from 'react';
import type { AccessDecision, Cell, Coverage, Entity } from '@tc/model';
import type { ProjectState } from '../api.ts';

// Not imported from '@tc/model': any *value* import from that package pulls
// in its whole index (including the Node-only workspace.ts) and breaks the
// browser build. NEW is just the pseudo-state id "@new".
const NEW = '@new';

// The closed-world matrix from coverage.access: for one variant, rows are
// role × action (grouped by role), columns are the states that variant has
// (plus “before it exists” for a create action). Kept compact so it stays
// readable at roughly 3 roles × 10 actions × 8 states.
export function AccessMatrix({ coverage, entity, project, variant }: { coverage: Coverage; entity: Entity; project: ProjectState; variant: string }) {
  const roleTitle = (id: string) => project.project.roles.find((r) => r.id === id)?.title ?? id;
  const actionTitle = (id: string) => entity.actions.find((a) => a.id === id)?.title ?? id;
  const columnTitle = (id: string) => (id === NEW ? 'before it exists' : (entity.states.find((s) => s.id === id)?.title ?? id));

  const present = coverage.access.filter((r) => r.cells[variant]);
  if (!present.length) return <p className="muted">No access rows for this variant.</p>;

  const seenStates = new Set(present.map((r) => r.state));
  const columns = [...(seenStates.has(NEW) ? [NEW] : []), ...entity.states.filter((s) => seenStates.has(s.id)).map((s) => s.id)];

  type Cellv = { decision: AccessDecision; result: Cell | null };
  const byRole = new Map<string, Map<string, Map<string, Cellv>>>();
  for (const r of present) {
    const cell = r.cells[variant]!;
    const byAction = byRole.get(r.role) ?? new Map<string, Map<string, Cellv>>();
    byRole.set(r.role, byAction);
    const byState = byAction.get(r.action) ?? new Map<string, Cellv>();
    byAction.set(r.action, byState);
    byState.set(r.state, cell);
  }
  const roleOrder = project.project.roles.filter((r) => byRole.has(r.id)).map((r) => r.id);

  return (
    <div className="access-matrix">
      <table className="matrix access">
        <thead>
          <tr>
            <th>Role / Action</th>
            {columns.map((c) => <th key={c}>{columnTitle(c)}</th>)}
          </tr>
        </thead>
        <tbody>
          {roleOrder.map((role) => {
            const actions = [...byRole.get(role)!.keys()];
            return (
              <RoleGroup key={role} title={roleTitle(role)} colSpan={columns.length + 1}>
                {actions.map((action) => (
                  <tr key={`${role}-${action}`}>
                    <td className="name">{actionTitle(action)}</td>
                    {columns.map((c) => {
                      const cell = byRole.get(role)!.get(action)!.get(c);
                      return <td key={c}>{cell ? <AccessCellView cell={cell} /> : <span className="cell na">—</span>}</td>;
                    })}
                  </tr>
                ))}
              </RoleGroup>
            );
          })}
        </tbody>
      </table>
      <div className="legend access-legend" aria-label="Legend">
        <span className="access-cell allowed">✓</span><span>allowed</span>
        <span className="access-cell undecided">?</span><span>undecided — an observed or proposed element, not yet a requirement</span>
        <span className="access-cell denied">×</span><span>denied — nothing allows it (closed world)</span>
        <span className="dot passed" /><span>last run: passed</span>
        <span className="dot failed" /><span>last run: failed</span>
      </div>
    </div>
  );
}

// A role's action rows, using a full-width header row instead of a nested
// table so the grid stays a single <table> (simpler column alignment).
function RoleGroup({ title, colSpan, children }: { title: string; colSpan: number; children: ReactNode }) {
  return (
    <>
      <tr className="access-role-row">
        <td colSpan={colSpan}>{title}</td>
      </tr>
      {children}
    </>
  );
}

function AccessCellView({ cell }: { cell: { decision: AccessDecision; result: Cell | null } }) {
  const symbol = { allowed: '✓', undecided: '?', denied: '×' }[cell.decision];
  const title = cell.result ? `${cell.decision} — ${cell.result.status}${cell.result.error ? `: ${cell.result.error}` : ''}` : cell.decision;
  return (
    <span className={`access-cell ${cell.decision}`} title={title}>
      {symbol}
      {cell.result && <i className={`dot ${cell.result.status}`} />}
    </span>
  );
}

// A small variant picker, used above the matrix — kept local since only the
// access section (unlike the rest of Coverage) shows one variant at a time.
export function VariantTabs({ variants, titleOf, value, onChange }: { variants: string[]; titleOf(id: string): string; value: string; onChange(v: string): void }) {
  return (
    <div className="seg" role="group" aria-label="Variant">
      {variants.map((v) => (
        <button key={v} aria-pressed={value === v} onClick={() => onChange(v)}>{titleOf(v)}</button>
      ))}
    </div>
  );
}
