import { type EntitySummary, type ProjectState } from '../api.ts';

type Props = {
  project: ProjectState;
  entities: EntitySummary[];
  onOpen(id: string): void;
  onOpenOnboarding(): void;
  onOpenObjects(): void;
};

// The project's entity catalog: what the model covers and how its tests stand.
export function OverviewView({ project, entities, onOpen, onOpenOnboarding, onOpenObjects }: Props) {
  const all = entities.reduce(
    (a, e) => ({ scenarios: a.scenarios + e.totals.scenarios, passed: a.passed + e.totals.passed, failed: a.failed + e.totals.failed }),
    { scenarios: 0, passed: 0, failed: 0 },
  );

  return (
    <div className="page">
      <h1>{project.project.name}</h1>
      <p className="lede">
        {entities.length} {entities.length === 1 ? 'entity' : 'entities'}, {all.scenarios} scenarios: {all.passed} passed
        {all.failed > 0 && <>, <span style={{ color: 'var(--bad)' }}>{all.failed} failed</span></>}.{' '}
        <button className="btn link" onClick={onOpenObjects}>Open the objects map</button>
      </p>

      {entities.length === 0 && (
        <div className="finding" style={{ maxWidth: '72ch' }}>
          <b>Nothing here yet.</b> Upload what you know about the system — docs, a tracker export, contracts — and let an
          agent propose the first map.{' '}
          <button className="btn small primary" onClick={onOpenOnboarding}>Go to Onboarding</button>
        </div>
      )}

      <div className="catalog">
        {entities.map((e) => {
          const t = e.totals;
          const pct = t.scenarios ? (100 * t.passed) / t.scenarios : 0;
          return (
            <article key={e.id} className="entity-card">
              <button className="entity-open" onClick={() => onOpen(e.id)}>
                <h2>{e.title}</h2>
                <span className="id">{e.id}</span>
                {e.description && <p>{e.description}</p>}
                <dl>
                  <div><dt>Variants</dt><dd>{e.counts.variants}</dd></div>
                  <div><dt>States</dt><dd>{e.counts.states}</dd></div>
                  <div><dt>Actions</dt><dd>{e.counts.actions}</dd></div>
                  <div><dt>Transitions</dt><dd>{e.counts.transitions}</dd></div>
                  <div><dt>Permits</dt><dd>{e.counts.permits}</dd></div>
                  <div><dt>Rules</dt><dd>{e.counts.rules}</dd></div>
                  <div><dt>Journeys</dt><dd>{e.counts.journeys}</dd></div>
                </dl>
                {(e.relations.length > 0 || entities.some((x) => x.relations.some((r) => r.entity === e.id))) && (
                  <div className="entity-relations">
                    {e.relations.map((r) => (
                      <span key={r.id}>{r.kind === 'part-of' ? 'Part of' : 'Needs'} <b>{r.title}</b>{r.requires && <> in {r.requires}</>}</span>
                    ))}
                    {entities.filter((x) => x.relations.some((r) => r.entity === e.id)).map((x) => {
                      const rel = x.relations.find((r) => r.entity === e.id)!;
                      return <span key={x.id} className="muted">{rel.kind === 'part-of' ? 'Has part' : 'Used by'} {x.title}</span>;
                    })}
                  </div>
                )}
                <div className="entity-status">
                  <div className="bar"><i style={{ width: `${pct}%` }} /></div>
                  <span>
                    {t.passed}/{t.scenarios} passed
                    {t.failed > 0 && <b style={{ color: 'var(--bad)' }}>, {t.failed} failed</b>}
                    {t.blocked > 0 && <>, {t.blocked} blocked</>}
                  </span>
                </div>
                {(e.pendingProposals > 0 || e.errors > 0 || e.counts.observations > 0) && (
                  <div className="entity-flags">
                    {e.pendingProposals > 0 && <span className="flag proposed">{e.pendingProposals} proposals to review</span>}
                    {e.counts.observations > 0 && <span className="flag observed">{e.counts.observations} observations</span>}
                    {e.errors > 0 && <span className="flag error">{e.errors} model errors</span>}
                  </div>
                )}
              </button>
            </article>
          );
        })}
      </div>
    </div>
  );
}
