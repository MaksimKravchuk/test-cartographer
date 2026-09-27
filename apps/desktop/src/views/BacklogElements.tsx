import type { ActionInfo, FeatureInfo, StoryInfo, Totals } from '@tc/model';
import type { EntitySummary, ProjectState } from '../api.ts';

export type ScenarioInfo = { title: string; status: 'passed' | 'failed' | 'blocked' | 'skipped' | 'not-run' };
export type ScenarioIndex = Record<string, ScenarioInfo>;

// A compact multi-segment bar: share of passed/failed/blocked/not-run/skipped
// scenarios at a glance, without a status column per row.
export function SegBar({ totals }: { totals: Totals }) {
  const total = totals.scenarios || 1;
  const seg = (n: number, cls: string) => (n > 0 ? <i key={cls} className={cls} style={{ width: `${(100 * n) / total}%` }} /> : null);
  return (
    <div
      className="seg-bar"
      title={`${totals.passed} passed, ${totals.failed} failed, ${totals.blocked} blocked, ${totals['not-run']} not run`}
    >
      {seg(totals.passed, 'passed')}
      {seg(totals.failed, 'failed')}
      {seg(totals.blocked, 'blocked')}
      {seg(totals.skipped, 'skipped')}
      {seg(totals['not-run'], 'notrun')}
    </div>
  );
}

export function Totalcount({ totals }: { totals: Totals }) {
  return <span className="muted">{totals.passed}/{totals.scenarios}</span>;
}

// Scenarios don't come with a title/status from the backlog endpoint (it only
// carries ids and rolled-up totals) — the index is built client-side from each
// entity's own plan + results, the same data the Coverage tab uses.
export function ScenarioList({ ids, index }: { ids: string[]; index: ScenarioIndex }) {
  if (!ids.length) return <p className="muted" style={{ margin: 0 }}>No scenarios.</p>;
  return (
    <ul className="backlog-scenarios">
      {ids.map((id) => {
        const info = index[id];
        return (
          <li key={id}>
            <span className={`dot ${info?.status ?? 'not-run'}`} />
            {info?.title ?? id}
          </li>
        );
      })}
    </ul>
  );
}

export function ScenariosDisclosure({ ids, index }: { ids: string[]; index: ScenarioIndex }) {
  if (!ids.length) return null;
  return (
    <details className="deny-group">
      <summary><span className="muted">{ids.length} {ids.length === 1 ? 'scenario' : 'scenarios'}</span></summary>
      <div className="deny-list">
        <ScenarioList ids={ids} index={index} />
      </div>
    </details>
  );
}

// The element a `covers` or action ref points into: "<kind>:<entity>.<id>" or "<entity>.<action>".
export function refEntity(ref: string): string {
  const withoutKind = ref.includes(':') ? ref.slice(ref.indexOf(':') + 1) : ref;
  return withoutKind.split('.')[0] ?? ref;
}

export function ActionsTable({ actions, project, entities, onOpenEntity }: { actions: ActionInfo[]; project: ProjectState; entities: EntitySummary[]; onOpenEntity(id: string): void }) {
  if (!actions.length) return null;
  const roleTitle = (id: string) => project.project.roles.find((r) => r.id === id)?.title ?? id;
  const entityTitle = (id: string) => entities.find((e) => e.id === id)?.title ?? id;
  return (
    <table className="matrix backlog-actions">
      <thead>
        <tr><th>Action</th><th>Who may do it</th><th>Undecided</th><th>Scenarios</th></tr>
      </thead>
      <tbody>
        {actions.map((a) => (
          <tr key={a.ref}>
            <td className="name">
              <button className="link" onClick={() => onOpenEntity(a.entity)}>{entityTitle(a.entity)}</button>
              <span className="muted"> · </span>{a.title}
              {!a.resolved && <span className="flag warn" style={{ marginLeft: 6 }}>not in the model yet</span>}
            </td>
            <td className="muted">
              {!a.resolved
                ? '—'
                : a.allowed.length === 0
                  ? <span className="flag warn">nobody yet</span>
                  : a.allowed.map((x) => x.by.map(roleTitle).join('+')).join(', ')}
            </td>
            <td>{a.undecided > 0 ? <span className="flag warn">{a.undecided} undecided</span> : <span className="muted">—</span>}</td>
            <td><Totalcount totals={a.totals} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function StoryCard({ story, onOpenEntity, index }: { story: StoryInfo; onOpenEntity(id: string): void; index: ScenarioIndex }) {
  return (
    <div className={`scenario-row backlog-story ${story.status}`}>
      <div className="scenario-main">
        <div className="scenario-title">
          {story.key && <span className="id">{story.key}</span>} {story.title}
          {story.trackerStatus && <span className="muted" style={{ marginLeft: 8 }}>{story.trackerStatus}</span>}
        </div>
        {story.text && <p className="muted" style={{ margin: '4px 0' }}>{story.text}</p>}
        {story.acceptance.length > 0 && (
          <ul className="proposal-list">{story.acceptance.map((a, i) => <li key={i}>{a}</li>)}</ul>
        )}
        <div className="chips" style={{ justifyContent: 'start', marginTop: 6 }}>
          {story.covers.map((c) => (
            <span
              key={c.ref}
              className={`chip ref ${c.resolved ? '' : 'warn'}`}
              style={{ cursor: c.resolved ? 'pointer' : 'default' }}
              title={c.resolved ? undefined : 'Not in the model yet'}
              onClick={() => c.resolved && onOpenEntity(refEntity(c.ref))}
            >
              {c.ref}
            </span>
          ))}
          {story.covers.length === 0 && <span className="muted">Covers nothing yet</span>}
        </div>
        <ScenariosDisclosure ids={story.scenarios} index={index} />
      </div>
      <div className="scenario-side" style={{ flexDirection: 'column', alignItems: 'end', gap: 4 }}>
        <SegBar totals={story.totals} />
        <Totalcount totals={story.totals} />
      </div>
    </div>
  );
}

export function FeatureCard({ feature, project, entities, onOpenEntity, index }: { feature: FeatureInfo; project: ProjectState; entities: EntitySummary[]; onOpenEntity(id: string): void; index: ScenarioIndex }) {
  return (
    <article className="backlog-feature">
      <header className="row" style={{ justifyContent: 'space-between', alignItems: 'start' }}>
        <div>
          <div className="scenario-title">
            {feature.key && <span className="id">{feature.key}</span>} {feature.title}
            {feature.status !== 'confirmed' && <span className={`status-pill ${feature.status}`} style={{ marginLeft: 8 }}><i /></span>}
          </div>
          {feature.description && <p className="muted" style={{ margin: '2px 0 0' }}>{feature.description}</p>}
        </div>
        <div className="row" style={{ flexDirection: 'column', alignItems: 'end', gap: 4 }}>
          <SegBar totals={feature.totals} />
          <Totalcount totals={feature.totals} />
        </div>
      </header>

      <ActionsTable actions={feature.actions} project={project} entities={entities} onOpenEntity={onOpenEntity} />
      <ScenariosDisclosure ids={feature.scenarios} index={index} />

      {feature.stories.length > 0 && (
        <div className="backlog-stories">
          {feature.stories.map((s) => <StoryCard key={s.id} story={s} onOpenEntity={onOpenEntity} index={index} />)}
        </div>
      )}
    </article>
  );
}
