import { useCallback, useEffect, useState } from 'react';
import { api, type Projects, type RecentProject } from '../api.ts';

type Props = {
  // Switching is off while there are unsaved edits or a running job.
  disabled: boolean;
  onNotify(m: string): void;
  onError(m: string): void;
};

// Every project the app knows about: favorites first, then recent ones. Open,
// create, pin, forget, or move a project's folder to the app's trash. Opening
// or creating switches the engine; the app reloads on its “project” event.
export function ProjectsView({ disabled, onNotify, onError }: Props) {
  const [projects, setProjects] = useState<Projects | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [openPath, setOpenPath] = useState('');
  const [newPath, setNewPath] = useState('');
  const [newName, setNewName] = useState('');

  const reload = useCallback(() => api.projects().then(setProjects).catch((e) => onError((e as Error).message)), [onError]);
  useEffect(() => {
    void reload();
  }, [reload]);

  const act = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try {
      await fn();
      setConfirm(null);
      if (done) onNotify(done);
      await reload();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const list = projects?.recent ?? [];
  const favorites = list.filter((p) => p.pinned);
  const recent = list.filter((p) => !p.pinned);

  const card = (p: RecentProject) => {
    const current = p.root === projects!.current;
    return (
      <article key={p.root} className={`entity-card project-card ${p.missing ? 'missing' : ''}`}>
        <div className="project-head">
          <button className="entity-open" disabled={busy || disabled || current || p.missing} onClick={() => act(() => api.openProject(p.root))}>
            <h2>{p.name}</h2>
            <span className="id">{p.root}</span>
            <div className="entity-flags">
              {current && <span className="flag proposed">Open now</span>}
              {p.missing && <span className="flag error">Folder not found</span>}
              {!current && !p.missing && <span className="muted">Opened {new Date(p.openedAt).toLocaleString()}</span>}
            </div>
          </button>
          <button className={`star ${p.pinned ? 'on' : ''}`} onClick={() => act(() => api.pinProject(p.root, !p.pinned))} aria-pressed={!!p.pinned} title={p.pinned ? 'Remove from favorites' : 'Add to favorites'}>
            {p.pinned ? '★' : '☆'}
          </button>
        </div>
        {!current && (
          <div className="entity-actions">
            {confirm === p.root ? (
              <>
                <span className="muted" title="~/.test-cartographer/trash">Move folder to trash?</span>
                <button className="btn small danger" disabled={busy} onClick={() => act(() => api.trashProject(p.root), `“${p.name}” moved to the trash`)}>Delete</button>
                <button className="btn small" onClick={() => setConfirm(null)}>Keep</button>
              </>
            ) : (
              <>
                <button className="btn small" disabled={busy} onClick={() => act(() => api.forgetProject(p.root))} title="The folder stays on disk">Remove from list</button>
                {!p.missing && <button className="btn small danger" onClick={() => setConfirm(p.root)}>Delete…</button>}
              </>
            )}
          </div>
        )}
      </article>
    );
  };

  return (
    <div className="page">
      <h1>Projects</h1>
      <p className="lede">
        A project is a folder with <code>cartographer.yaml</code>. Favorites stay pinned at the top of the project menu.
        {disabled && ' Save your edits and wait for running jobs before switching.'}
      </p>

      {favorites.length > 0 && (
        <>
          <h3 className="section-title">Favorites</h3>
          <div className="catalog">{favorites.map(card)}</div>
        </>
      )}
      {recent.length > 0 && (
        <>
          <h3 className="section-title">Recent</h3>
          <div className="catalog">{recent.map(card)}</div>
        </>
      )}

      <h3 className="section-title">Add a project</h3>
      <div className="catalog">
        <form
          className="entity-card new-entity"
          onSubmit={(e) => {
            e.preventDefault();
            void act(() => api.createProject(newPath.trim(), newName.trim()));
          }}
        >
          <h2>New project</h2>
          <p className="muted">From the template: a web interface, a guest and a signed-in role.</p>
          <label className="field">
            <span>Project name</span>
            <input className="text" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Marketplace" />
          </label>
          <label className="field">
            <span>Folder</span>
            <input className="text" value={newPath} onChange={(e) => setNewPath(e.target.value)} placeholder="/Users/you/projects/shop-tests" />
          </label>
          <button className="btn primary" disabled={busy || disabled || !newPath.trim() || !newName.trim()}>Create project</button>
        </form>

        <form
          className="entity-card new-entity"
          onSubmit={(e) => {
            e.preventDefault();
            void act(() => api.openProject(openPath.trim()));
          }}
        >
          <h2>Open existing</h2>
          <p className="muted">A folder that already contains cartographer.yaml.</p>
          <label className="field">
            <span>Folder</span>
            <input className="text" value={openPath} onChange={(e) => setOpenPath(e.target.value)} placeholder="/Users/you/projects/shop-tests" />
          </label>
          <button className="btn primary" disabled={busy || disabled || !openPath.trim()}>Open project</button>
        </form>
      </div>
    </div>
  );
}
