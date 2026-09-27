import { useEffect, useRef, useState } from 'react';
import { api, type Projects } from '../api.ts';

type Props = { name: string; root: string; disabled: boolean; onError(m: string): void };

// Project menu at the top of the sidebar: recent projects, open a folder,
// create a new project from the template. The engine switches and the app
// reloads on its “project” event.
export function ProjectSwitcher({ name, root, disabled, onError }: Props) {
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<Projects | null>(null);
  const [mode, setMode] = useState<'list' | 'open' | 'create'>('list');
  const [path, setPath] = useState('');
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setMode('list');
    api.projects().then(setProjects).catch((e) => onError((e as Error).message));
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open, onError]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      setOpen(false);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const folder = root.split('/').slice(-2).join('/');

  return (
    <div className="switcher" ref={ref}>
      <button className="switcher-button" onClick={() => setOpen(!open)} disabled={disabled} aria-expanded={open} title={disabled ? 'Save your edits and wait for running jobs before switching' : root}>
        <span className="switcher-name">{name}</span>
        <span className="switcher-path">{folder}</span>
      </button>
      {open && (
        <div className="switcher-menu" role="dialog" aria-label="Projects">
          {mode === 'list' && (
            <>
              <div className="switcher-section">Recent projects</div>
              {projects?.recent.map((p) => (
                <button
                  key={p.root}
                  className="switcher-item"
                  aria-current={p.root === projects.current}
                  disabled={busy || p.root === projects.current}
                  onClick={() => act(() => api.openProject(p.root))}
                >
                  <span>{p.name}</span>
                  <span className="id">{p.root}</span>
                </button>
              ))}
              <div className="row" style={{ padding: 8, gap: 6 }}>
                <button className="btn small" onClick={() => setMode('open')}>Open project…</button>
                <button className="btn small" onClick={() => setMode('create')}>New project…</button>
              </div>
            </>
          )}
          {mode !== 'list' && (
            <form
              style={{ padding: 12 }}
              onSubmit={(e) => {
                e.preventDefault();
                void act(() => (mode === 'open' ? api.openProject(path) : api.createProject(path, newName)));
              }}
            >
              <label className="field">
                <span>{mode === 'open' ? 'Project folder (contains cartographer.yaml)' : 'Folder for the new project'}</span>
                <input className="text" autoFocus value={path} onChange={(e) => setPath(e.target.value)} placeholder="/Users/you/projects/shop-tests" />
              </label>
              {mode === 'create' && (
                <label className="field">
                  <span>Project name</span>
                  <input className="text" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Marketplace" />
                </label>
              )}
              <div className="row">
                <button className="btn primary" disabled={busy || !path || (mode === 'create' && !newName)}>
                  {mode === 'open' ? 'Open project' : 'Create project'}
                </button>
                <button type="button" className="btn" onClick={() => setMode('list')}>Back</button>
              </div>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
