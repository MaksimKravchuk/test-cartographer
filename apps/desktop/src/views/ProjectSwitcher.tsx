import { useState } from 'react';
import { api, type Projects, type RecentProject } from '../api.ts';
import { Popup } from '../ui.tsx';

type Props = { name: string; root: string; disabled: boolean; onManage(): void; onError(m: string): void };

// Project menu at the top of the sidebar: favorites pinned on top, then recent
// projects. Creating, opening by path and deleting live on the Projects page.
// The engine switches and the app reloads on its “project” event.
export function ProjectSwitcher({ name, root, disabled, onManage, onError }: Props) {
  const [projects, setProjects] = useState<Projects | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => api.projects().then(setProjects).catch((e) => onError((e as Error).message));

  const switchTo = async (to: string, close: () => void) => {
    setBusy(true);
    try {
      await api.openProject(to);
      close();
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

  const item = (p: RecentProject, close: () => void) => (
    <li key={p.root} className="switcher-row">
      <button
        type="button"
        className="switcher-item"
        aria-current={p.root === projects!.current}
        disabled={disabled || busy || p.root === projects!.current}
        onClick={() => switchTo(p.root, close)}
      >
        <span>{p.name}</span>
        <span className="id">{p.root}</span>
      </button>
      <button type="button" className={`star ${p.pinned ? 'on' : ''}`} onClick={() => pin(p)} aria-pressed={!!p.pinned} aria-label={`Favorite: ${p.name}`}>
        <span aria-hidden>{p.pinned ? '★' : '☆'}</span>
      </button>
    </li>
  );

  const trigger = (
    <Popup
      name="Projects"
      className="switcher-menu"
      triggerClass="switcher-button"
      onOpen={load}
      label={<><span className="switcher-name">{name}</span><span className="switcher-path">{folder}</span></>}
    >
      {(close) => (
        <>
          {/* Open even while switching is off, so the reason is there to read. */}
          {disabled && <p className="switcher-note">Save your edits and wait for running jobs before switching projects.</p>}
          {favorites.length > 0 && (
            <>
              <h2 className="switcher-section">Favorites</h2>
              <ul>{favorites.map((p) => item(p, close))}</ul>
            </>
          )}
          {recent.length > 0 && (
            <>
              <h2 className="switcher-section">Recent projects</h2>
              <ul>{recent.map((p) => item(p, close))}</ul>
            </>
          )}
          <div className="switcher-foot">
            <button
              type="button"
              className="btn small"
              onClick={() => {
                close();
                onManage();
              }}
            >
              Manage projects…
            </button>
          </div>
        </>
      )}
    </Popup>
  );
  return <div className="switcher">{trigger}</div>;
}
