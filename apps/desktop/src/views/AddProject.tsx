import { useEffect, useState, type ReactNode } from 'react';
import type { AgentProvider } from '@tc/model';
import { api, runtimeTitle, type FolderInfo, type RuntimeStatus } from '../api.ts';
import { Modal } from '../ui.tsx';

// Add a project: start a new one or open one that exists. Every field says what
// will happen as you type (the engine checks the path), so the button is only
// off for a reason that is written next to it.

type Mode = 'new' | 'open';
type Props = { disabled: boolean; busy: boolean; onSubmit(fn: () => Promise<unknown>): void };

// Electron's preload gives a native folder dialog; a web browser can't, so the
// form browses folders through the engine instead.
const native = (window as { cartographer?: { pickFolder(start?: string): Promise<string | null> } }).cartographer;

// The engine's view of a typed path, checked a moment after typing stops.
// Null until the path as typed now has been checked, so an older answer never stands in for it.
function useFolder(path: string): FolderInfo | null {
  const [checked, setChecked] = useState<{ path: string; info: FolderInfo | null } | null>(null);
  useEffect(() => {
    if (!path.trim()) return;
    let live = true;
    const t = setTimeout(() => void api.folder(path).then((info) => live && setChecked({ path, info }), () => live && setChecked({ path, info: null })), 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [path]);
  return path.trim() && checked?.path === path ? checked.info : null;
}

type Hint = { tone?: 'ok' | 'bad'; text: ReactNode };

function FolderField({ label, value, onChange, hint, id }: { label: string; value: string; onChange(v: string): void; hint: Hint; id: string }) {
  const [browsing, setBrowsing] = useState<string | null>(null);
  const choose = async () => {
    if (native) {
      const picked = await native.pickFolder(value || undefined);
      if (picked) onChange(picked);
    } else setBrowsing(browsing === null ? value || '~' : null);
  };
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="folder-row">
        <input id={id} className="text mono" value={value} spellCheck={false} onChange={(e) => onChange(e.target.value)} aria-describedby={`${id}-hint`} />
        <button type="button" className="btn" onClick={choose} aria-haspopup={native ? undefined : 'dialog'}>Choose…</button>
      </div>
      {browsing !== null && <FolderBrowser start={browsing} onPick={(p) => { onChange(p); setBrowsing(null); }} onClose={() => setBrowsing(null)} />}
      <span id={`${id}-hint`} className={`field-hint ${hint.tone ?? ''}`}>{hint.text}</span>
    </div>
  );
}

function FolderBrowser({ start, onPick, onClose }: { start: string; onPick(p: string): void; onClose(): void }) {
  const [at, setAt] = useState(start);
  const [info, setInfo] = useState<FolderInfo | null>(null);
  useEffect(() => {
    void api.folder(at).then(async (i) => {
      // A typed path that isn't a folder yet: start from the nearest folder above it.
      if (!i.dir && i.parentExists && i.parent !== i.path) setAt(i.parent);
      else if (!i.dir) setAt(i.home);
      else setInfo(i);
    }, () => setInfo(null));
  }, [at]);
  const join = (name: string) => (info!.path.endsWith('/') || info!.path.endsWith('\\') ? info!.path + name : `${info!.path}${info!.path.includes('\\') ? '\\' : '/'}${name}`);
  return (
    <Modal title="Choose a folder" onClose={onClose}>
      {(close) => (
        <div className="folder-browser">
          <p className="folder-browser-head id">{info?.path ?? '…'}</p>
          <ul>
            {info && info.parent !== info.path && <li><button type="button" onClick={() => setAt(info.parent)}>↑ Up</button></li>}
            {info?.children.map((c) => <li key={c}><button type="button" onClick={() => setAt(join(c))}>{c}</button></li>)}
            {info && info.children.length === 0 && <li className="muted">No folders inside</li>}
          </ul>
          <div className="folder-browser-foot">
            <button type="button" className="btn primary small" disabled={!info} onClick={() => { close(); if (info) onPick(info.path); }}>Use this folder</button>
          </div>
        </div>
      )}
    </Modal>
  );
}

const isUrl = (s: string) => {
  try {
    return ['http:', 'https:'].includes(new URL(s).protocol);
  } catch {
    return false;
  }
};

export function AddProject({ disabled, busy, onSubmit }: Props) {
  const [mode, setMode] = useState<Mode>('new');
  const [name, setName] = useState('');
  const [folder, setFolder] = useState('');
  const [folderEdited, setFolderEdited] = useState(false);
  const [url, setUrl] = useState('http://localhost:3000');
  const [code, setCode] = useState('');
  const [provider, setProvider] = useState<AgentProvider | ''>('');
  const [openPath, setOpenPath] = useState('');
  const [home, setHome] = useState<string | null>(null);
  const [runtimes, setRuntimes] = useState<RuntimeStatus[] | null>(null);

  useEffect(() => {
    void api.folder('~').then((i) => setHome(i.path), () => {});
    void api.runtimes().then((r) => {
      setRuntimes(r);
      setProvider((p) => p || (r.find((x) => x.ready)?.provider ?? ''));
    }, () => setRuntimes([]));
  }, []);

  // Until someone types a folder, it follows the name: ~/Test Cartographer/<name>.
  useEffect(() => {
    if (folderEdited || !home) return;
    const sep = home.includes('\\') ? '\\' : '/';
    setFolder(name.trim() ? `${home}${sep}Test Cartographer${sep}${name.trim().replace(/[\\/:*?"<>|]+/g, '-')}` : '');
  }, [name, home, folderEdited]);

  const target = useFolder(folder);
  const codeInfo = useFolder(code);
  const existing = useFolder(openPath);

  const switchTo = (m: Mode, path: string) => {
    setMode(m);
    if (m === 'open') setOpenPath(path);
    else {
      setFolder(path);
      setFolderEdited(true);
    }
  };

  const folderHint: Hint = !folder.trim()
    ? { text: 'Where the project’s files go. A folder that doesn’t exist yet is fine.' }
    : !target
      ? { text: 'Checking…' }
      : target.project
        ? { tone: 'bad', text: <>Already a project, “{target.project}”. <button type="button" className="btn link" onClick={() => switchTo('open', folder)}>Open it instead</button></> }
        : target.exists && !target.dir
          ? { tone: 'bad', text: 'That’s a file, not a folder.' }
          : target.dir && target.empty
            ? { tone: 'ok', text: 'Empty folder: the project goes here.' }
            : target.dir
              ? { tone: 'ok', text: 'The folder has other files; the project’s files go next to them.' }
              : target.parentExists
                ? { tone: 'ok', text: 'A new folder will be created.' }
                : { tone: 'ok', text: `A new folder will be created, along with the missing folders above it.` };

  const urlOk = isUrl(url.trim());
  const codeHint: Hint = !code.trim()
    ? { text: 'Optional. Agents read the code to check the model against what the app really does.' }
    : !codeInfo
      ? { text: 'Checking…' }
      : codeInfo.dir
        ? { tone: 'ok', text: `${codeInfo.children.length} folders inside.` }
        : { tone: 'bad', text: codeInfo.exists ? 'That’s a file, not a folder.' : 'Folder not found.' };

  const newBlocker = disabled
    ? 'Save your edits and wait for running jobs first.'
    : !name.trim()
      ? 'Name the project.'
      : !folder.trim()
        ? 'Choose a folder.'
        : folderHint.tone === 'bad'
          ? 'Choose another folder.'
          : !target
            ? 'Checking the folder…'
            : !urlOk
              ? 'Enter the app’s address, starting with http:// or https://.'
              : code.trim() && codeHint.tone !== 'ok'
                ? 'Fix the code folder or leave it empty.'
                : null;

  const openHint: Hint = !openPath.trim()
    ? { text: 'A folder with cartographer.yaml in it.' }
    : !existing
      ? { text: 'Checking…' }
      : existing.project
        ? { tone: 'ok', text: `Test Cartographer project “${existing.project}”.` }
        : existing.dir
          ? { tone: 'bad', text: <>No cartographer.yaml here. <button type="button" className="btn link" onClick={() => switchTo('new', openPath)}>Create a project here</button></> }
          : { tone: 'bad', text: existing.exists ? 'That’s a file, not a folder.' : 'Folder not found.' };
  const openBlocker = disabled ? 'Save your edits and wait for running jobs first.' : !openPath.trim() ? 'Choose a folder.' : openHint.tone !== 'ok' ? 'Choose a folder with a project in it.' : null;

  return (
    <section className="add-project" aria-label="Add a project">
      <div className="seg" role="group" aria-label="Add a project">
        <button type="button" aria-pressed={mode === 'new'} onClick={() => setMode('new')}>New project</button>
        <button type="button" aria-pressed={mode === 'open'} onClick={() => setMode('open')}>Open existing</button>
      </div>

      {mode === 'new' ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!newBlocker) onSubmit(() => api.createProject(folder.trim(), name.trim(), { baseUrl: url.trim(), code: code.trim() || undefined, provider: provider || undefined }));
          }}
        >
          <div className="field">
            <label htmlFor="np-name">Name</label>
            <input id="np-name" className="text" value={name} autoFocus onChange={(e) => setName(e.target.value)} aria-describedby="np-name-hint" />
            <span id="np-name-hint" className="field-hint">Shown in the project menu, for example the product you test.</span>
          </div>
          <FolderField id="np-folder" label="Folder" value={folder} onChange={(v) => { setFolder(v); setFolderEdited(true); }} hint={folderHint} />
          <div className="field">
            <label htmlFor="np-url">App address</label>
            <input id="np-url" type="url" inputMode="url" className="text mono" value={url} spellCheck={false} onChange={(e) => setUrl(e.target.value)} aria-describedby="np-url-hint" aria-invalid={!urlOk} />
            <span id="np-url-hint" className={`field-hint ${urlOk ? '' : 'bad'}`}>{urlOk ? 'Where the app under test runs. Roles open its pages from here.' : 'Starts with http:// or https://.'}</span>
          </div>
          <FolderField id="np-code" label="Code folder" value={code} onChange={setCode} hint={codeHint} />
          <div className="field">
            <label htmlFor="np-agent">Agent</label>
            <select id="np-agent" className="text" value={provider} onChange={(e) => setProvider(e.target.value as AgentProvider | '')} aria-describedby="np-agent-hint">
              <option value="">Decide later</option>
              {(runtimes ?? []).map((r) => (
                <option key={r.provider} value={r.provider}>{runtimeTitle[r.provider]}{r.ready ? '' : ' (not signed in)'}</option>
              ))}
            </select>
            <span id="np-agent-hint" className="field-hint">
              {runtimes === null ? 'Looking for coding agents on this computer…' : 'The coding agent that researches sources and explores the app, as signed in on this computer.'}
            </span>
          </div>
          <p className="muted form-note">
            Starts with two roles, Guest and Signed-in user, whose test account comes from TC_USER and TC_PASSWORD. Change roles and accounts in Settings › Project.
          </p>
          <div className="form-foot">
            <button className="btn primary" disabled={busy || !!newBlocker}>Create project</button>
            {newBlocker && <span className="muted">{newBlocker}</span>}
          </div>
        </form>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!openBlocker) onSubmit(() => api.openProject(openPath.trim()));
          }}
        >
          <FolderField id="op-folder" label="Folder" value={openPath} onChange={setOpenPath} hint={openHint} />
          <div className="form-foot">
            <button className="btn primary" disabled={busy || !!openBlocker}>Open project</button>
            {openBlocker && <span className="muted">{openBlocker}</span>}
          </div>
        </form>
      )}
    </section>
  );
}
