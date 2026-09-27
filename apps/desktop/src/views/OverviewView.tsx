import { useState } from 'react';
import { api, type EntitySummary, type ProjectState } from '../api.ts';
import { nextId } from '../graph.ts';

type Props = {
  project: ProjectState;
  entities: EntitySummary[];
  onOpen(id: string): void;
  onCreated(id: string): void;
  onDeleted(): void;
  onError(m: string): void;
};

// The project's entity catalog: what the model covers and how its tests stand.
export function OverviewView({ project, entities, onOpen, onCreated, onDeleted, onError }: Props) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const all = entities.reduce(
    (a, e) => ({ scenarios: a.scenarios + e.totals.scenarios, passed: a.passed + e.totals.passed, failed: a.failed + e.totals.failed }),
    { scenarios: 0, passed: 0, failed: 0 },
  );

  const create = async () => {
    const id = nextId(title, entities.map((e) => e.id));
    setBusy(true);
    try {
      await api.createEntity({ id, title: title.trim(), description: description.trim() || undefined });
      setTitle('');
      setDescription('');
      onCreated(id);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    try {
      await api.deleteEntity(id);
      setConfirmDelete(null);
      onDeleted();
    } catch (e) {
      onError((e as Error).message);
    }
  };

  return (
    <div className="page">
      <h1>{project.project.name}</h1>
      <p className="lede">
        {entities.length} {entities.length === 1 ? 'entity' : 'entities'}, {all.scenarios} scenarios: {all.passed} passed
        {all.failed > 0 && <>, <span style={{ color: 'var(--fail)' }}>{all.failed} failed</span></>}.
      </p>

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
                      <span key={r.id}>Needs <b>{r.title}</b>{r.requires && <> in {r.requires}</>}</span>
                    ))}
                    {entities.filter((x) => x.relations.some((r) => r.entity === e.id)).map((x) => (
                      <span key={x.id} className="muted">Used by {x.title}</span>
                    ))}
                  </div>
                )}
                <div className="entity-status">
                  <div className="bar"><i style={{ width: `${pct}%` }} /></div>
                  <span>
                    {t.passed}/{t.scenarios} passed
                    {t.failed > 0 && <b style={{ color: 'var(--fail)' }}>, {t.failed} failed</b>}
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
              <div className="entity-actions">
                {confirmDelete === e.id ? (
                  <>
                    <span className="muted">Move to entities/.trash?</span>
                    <button className="btn small danger" onClick={() => remove(e.id)}>Remove</button>
                    <button className="btn small" onClick={() => setConfirmDelete(null)}>Keep</button>
                  </>
                ) : (
                  <button className="btn small" onClick={() => setConfirmDelete(e.id)}>Remove…</button>
                )}
              </div>
            </article>
          );
        })}

        <form
          className="entity-card new-entity"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <h2>New entity</h2>
          <p className="muted">Something with a lifecycle: an order, a quota, a user account.</p>
          <label className="field">
            <span>Name</span>
            <input className="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Quota" />
          </label>
          <label className="field">
            <span>Description</span>
            <input className="text" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Monthly order limit of a buyer" />
          </label>
          {title.trim() && <p className="muted" style={{ marginTop: 0 }}>File: <span className="id">entities/{nextId(title, entities.map((x) => x.id))}.yaml</span></p>}
          <button className="btn primary" disabled={busy || !title.trim()}>Create entity</button>
        </form>
      </div>
    </div>
  );
}
