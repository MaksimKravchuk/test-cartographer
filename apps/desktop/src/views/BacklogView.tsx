import { useEffect, useState } from 'react';
import type { EpicInfo, Story } from '@tc/model';
import { api, type BacklogState, type EntitySummary, type ProjectState } from '../api.ts';
import { FeatureCard, StoryCard, type ScenarioIndex, SegBar, Totalcount } from './BacklogElements.tsx';

type Props = {
  project: ProjectState;
  entities: EntitySummary[];
  reloadToken: number;
  onOpenEntity(id: string): void;
  onError(m: string): void;
};

// Epics → features → stories, entirely derived from the model (see packages/model/src/backlog.ts):
// a feature is a slice by action, a story cites the exact elements it specifies.
export function BacklogView({ project, entities, reloadToken, onOpenEntity, onError }: Props) {
  const [data, setData] = useState<BacklogState | null>(null);
  const [index, setIndex] = useState<ScenarioIndex>({});
  const [open, setOpen] = useState<Record<string, boolean>>({});

  useEffect(() => {
    api.backlog().then(setData).catch((e) => onError((e as Error).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadToken]);

  // The backlog endpoint only carries scenario ids and rolled-up totals — a
  // scenario's title and per-run status live on the entity that owns it, so
  // build a lookup from the same data the Coverage/Scenarios tabs use.
  useEffect(() => {
    let cancelled = false;
    Promise.all(entities.map((e) => api.entity(e.id).catch(() => null))).then((states) => {
      if (cancelled) return;
      const idx: ScenarioIndex = {};
      for (const s of states) {
        if (!s) continue;
        for (const sc of s.plan.scenarios) idx[sc.id] = { title: sc.title, status: sc.blocked ? 'blocked' : (s.results[sc.id]?.status ?? 'not-run') };
      }
      setIndex(idx);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entities, reloadToken]);

  if (!data) return <div className="page muted">Loading backlog…</div>;

  const { backlog, coverage, issues } = data;
  const byId = new Map<string, Story>(backlog.stories.map((s) => [s.id, s]));
  const toggle = (id: string) => setOpen((o) => ({ ...o, [id]: !(o[id] ?? true) }));
  const isOpen = (id: string) => open[id] ?? true;

  const empty = coverage.epics.length === 0 && coverage.orphanFeatures.length === 0 && coverage.orphanStories.length === 0;

  return (
    <div className="page backlog">
      <h1>Backlog</h1>
      <p className="lede">
        Epics → features → stories, as a view over the model — what functionality exists, which scenarios check it, and what
        isn't mapped yet.
      </p>

      <div className="totals">
        <div><b>{coverage.totals.scenarios}</b><span>scenarios</span></div>
        <div><b style={{ color: 'var(--pass)' }}>{coverage.totals.passed}</b><span>passed</span></div>
        <div><b style={{ color: coverage.totals.failed ? 'var(--fail)' : undefined }}>{coverage.totals.failed}</b><span>failed</span></div>
        <div><b style={{ color: coverage.totals.blocked ? 'var(--blocked)' : undefined }}>{coverage.totals.blocked}</b><span>blocked</span></div>
        <div><b>{coverage.totals['not-run']}</b><span>not run</span></div>
      </div>

      {issues.length > 0 && (
        <section style={{ marginBottom: 24 }}>
          <h3>Model issues</h3>
          <ul className="issues">
            {issues.map((i, n) => <li key={n} className={i.level}>{i.path}: {i.message}</li>)}
          </ul>
        </section>
      )}

      {coverage.unmappedStories.length > 0 && (
        <section className="backlog-unmapped">
          <h2>Unmapped stories</h2>
          <p className="muted" style={{ marginTop: -2 }}>
            Requirements the model doesn't cover yet — exactly what onboarding is meant to surface.
          </p>
          <ul className="proposal-list">
            {coverage.unmappedStories.map((id) => {
              const s = byId.get(id);
              return <li key={id}>{s?.key && <span className="id">{s.key}</span>} {s?.title ?? id}</li>;
            })}
          </ul>
        </section>
      )}

      {empty && <p className="empty">No epics yet. Run onboarding, or add epics/features/stories by hand in backlog.yaml.</p>}

      {coverage.epics.map((epic) => (
        <EpicCard key={epic.id} epic={epic} project={project} entities={entities} open={isOpen(epic.id)} onToggle={() => toggle(epic.id)} onOpenEntity={onOpenEntity} index={index} />
      ))}

      {coverage.orphanFeatures.length > 0 && (
        <section style={{ marginTop: 28 }}>
          <h2>Features without an epic</h2>
          {coverage.orphanFeatures.map((f) => <FeatureCard key={f.id} feature={f} project={project} entities={entities} onOpenEntity={onOpenEntity} index={index} />)}
        </section>
      )}

      {coverage.orphanStories.length > 0 && (
        <section style={{ marginTop: 28 }}>
          <h2>Stories without a feature or epic</h2>
          {coverage.orphanStories.map((s) => <StoryCard key={s.id} story={s} onOpenEntity={onOpenEntity} index={index} />)}
        </section>
      )}
    </div>
  );
}

function EpicCard({
  epic, project, entities, open, onToggle, onOpenEntity, index,
}: {
  epic: EpicInfo;
  project: ProjectState;
  entities: EntitySummary[];
  open: boolean;
  onToggle(): void;
  onOpenEntity(id: string): void;
  index: ScenarioIndex;
}) {
  return (
    <section className="backlog-epic">
      <header className="backlog-epic-head" onClick={onToggle} role="button" tabIndex={0}>
        <span className="chip-toggle">{open ? '▾' : '▸'}</span>
        <h2>{epic.key && <span className="id">{epic.key}</span>} {epic.title}</h2>
        {epic.status !== 'confirmed' && <span className={`status-pill ${epic.status}`}><i /></span>}
        <span className="spacer" />
        <SegBar totals={epic.totals} />
        <Totalcount totals={epic.totals} />
      </header>
      {open && (
        <div className="backlog-epic-body">
          {epic.description && <p className="muted">{epic.description}</p>}
          {epic.features.map((f) => <FeatureCard key={f.id} feature={f} project={project} entities={entities} onOpenEntity={onOpenEntity} index={index} />)}
          {epic.stories.map((s) => <StoryCard key={s.id} story={s} onOpenEntity={onOpenEntity} index={index} />)}
          {epic.features.length === 0 && epic.stories.length === 0 && <p className="muted">Nothing under this epic yet.</p>}
        </div>
      )}
    </section>
  );
}
