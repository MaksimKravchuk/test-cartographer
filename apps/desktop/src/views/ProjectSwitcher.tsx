import { useEffect, useRef, useState } from 'react';
import { api, type Projects, type RecentProject } from '../api.ts';

type Props = { name: string; root: string; disabled: boolean; onManage(): void; onError(m: string): void };

// Project menu at the top of the sidebar: favorites pinned on top, then recent
// projects. Creating, opening by path and deleting live on the Projects page.
// The engine switches and the app reloads on its “project” event.
export function ProjectSwitcher({ name, root, disabled, onManage, onError }: Props) {
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<Projects | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    api.projects().then(setProjects).catch((e) => onError((e as Error).message));
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open, onError]);

  const switchTo = async (to: string) => {
    setBusy(true);
    try {
      await api.openProject(to);
      setOpen(false);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const pin = async (p: RecentProject) => {
    try {
      await api.pinProject(p.root, !p.pinned);
      setProjects(await api.projects());
    } catch (e) {
      onError((e as Error).message);
    }
  };

  const available = projects?.recent.filter((p) => !p.missing) ?? [];
  const favorites = available.filter((p) => p.pinned);
  const recent = available.filter((p) => !p.pinned);
  const folder = root.split('/').slice(-2).join('/');

  const item = (p: RecentProject) => (
    <div key={p.root} className="switcher-row">
      <button
        className="switcher-item"
        aria-current={p.root === projects!.current}
        disabled={busy || p.root === projects!.current}
        onClick={() => switchTo(p.root)}
      >
        <span>{p.name}</span>
        <span className="id">{p.root}</span>
      </button>
      <button className={`star ${p.pinned ? 'on' : ''}`} onClick={() => pin(p)} aria-pressed={!!p.pinned} title={p.pinned ? 'Remove from favorites' : 'Add to favorites'}>
        {p.pinned ? '★' : '☆'}
      </button>
    </div>
  );

  return (
    <div className="switcher" ref={ref}>
      <button className="switcher-button" onClick={() => setOpen(!open)} disabled={disabled} aria-expanded={open} title={disabled ? 'Save your edits and wait for running jobs before switching' : root}>
        <span className="switcher-name">{name}</span>
        <span className="switcher-path">{folder}</span>
      </button>
      {open && (
        <div className="switcher-menu" role="dialog" aria-label="Projects">
          {favorites.length > 0 && (
            <>
              <div className="switcher-section">Favorites</div>
              {favorites.map(item)}
            </>
          )}
          {recent.length > 0 && (
            <>
              <div className="switcher-section">Recent projects</div>
              {recent.map(item)}
            </>
          )}
          <div className="row" style={{ padding: 8, gap: 6, borderTop: '1px solid var(--rule)' }}>
            <button
              className="btn small"
              onClick={() => {
                setOpen(false);
                onManage();
              }}
            >
              Manage projects…
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
