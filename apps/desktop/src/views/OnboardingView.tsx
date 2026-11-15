import { useEffect, useState } from 'react';
import type { DragEvent } from 'react';
import type { FileSourceKind, Source, SourceKind } from '@tc/model';
import { api, type ProjectState, type SourceCheck, type SourceInfo } from '../api.ts';

type Props = {
  project: ProjectState;
  reloadToken: number;
  onError(m: string): void;
};
type Adding = 'file' | 'code' | 'mcp' | null;

const kindLabel: Record<SourceKind, string> = { doc: 'Product doc', backlog: 'Tracker export', contract: 'API contract', note: 'Note', code: 'Code folder', mcp: 'Via MCP' };
const fileKinds: FileSourceKind[] = ['doc', 'backlog', 'contract', 'note'];
const where = (s: SourceInfo) => (s.kind === 'code' ? s.path : s.kind === 'mcp' ? s.read?.tool : `${s.lines} lines`);

function readAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error(`Could not read ${file.name}`));
    reader.readAsText(file);
  });
}

// Every source of knowledge about the product, in one place: uploaded files,
// code folders, systems behind MCP (Confluence, Jira). Each has a priority —
// who wins when sources disagree — and an access check. Adding a source opens
// one form at a time from the Add source menu. Agents start from Ask agent.
export function OnboardingView({ project, reloadToken, onError }: Props) {
  const [adding, setAdding] = useState<Adding>(null);
  const [menu, setMenu] = useState(false);
  const [sources, setSources] = useState<SourceInfo[] | null>(null);
  const [kind, setKind] = useState<FileSourceKind>('doc');
  const [usePriority, setUsePriority] = useState(true);
  const [checks, setChecks] = useState<Record<string, SourceCheck>>({});
  const [checking, setChecking] = useState(false);
  const [codePath, setCodePath] = useState('');
  const [mcpTool, setMcpTool] = useState('');
  const [mcpArgs, setMcpArgs] = useState('{}');
  const [mcpTitle, setMcpTitle] = useState('');
  const readTools = Object.entries(project.project.mcp).flatMap(([server, m]) => m.allow.read.map((t) => `${server}.${t}`));
  const [dragOver, setDragOver] = useState(false);
  const [pasteName, setPasteName] = useState('');
  const [pasteContent, setPasteContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [viewing, setViewing] = useState<{ source: Source; text: string } | null>(null);
  const load = () => {
    api.sources().then((r) => { setSources(r.sources); setUsePriority(r.usePriority); }).catch((e) => onError((e as Error).message));
  };
  useEffect(() => { load(); }, [reloadToken]);

  const addFiles = async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (!list.length) return;
    setBusy(true);
    try {
      for (const file of list) await api.addSource({ name: file.name, content: await readAsText(file), kind });
      load();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const addPasted = async () => {
    setBusy(true);
    try {
      await api.addSource({ name: pasteName.trim(), content: pasteContent, kind });
      setPasteName('');
      setPasteContent('');
      load();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const act = async (f: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await f();
      load();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const addCode = () => act(async () => { await api.addSource({ kind: 'code', path: codePath.trim() }); setCodePath(''); });
  const addMcp = () =>
    act(async () => {
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(mcpArgs || '{}');
      } catch {
        throw new Error('Arguments must be a JSON object, e.g. {"space": "SHOP"}');
      }
      await api.addSource({ kind: 'mcp', read: { tool: mcpTool, args }, title: mcpTitle.trim() || undefined });
      setMcpTitle('');
      setMcpArgs('{}');
    });

  const checkAccess = async () => {
    setChecking(true);
    try {
      const r = await api.checkSources();
      setChecks(Object.fromEntries(r.checks.map((c) => [c.id, c])));
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setChecking(false);
    }
  };

  const remove = async (id: string) => {
    try {
      await api.removeSource(id);
      setConfirmRemove(null);
      load();
    } catch (e) {
      onError((e as Error).message);
    }
  };

  const view = async (id: string) => {
    try {
      setViewing(await api.sourceText(id));
    } catch (e) {
      onError((e as Error).message);
    }
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    void addFiles(e.dataTransfer.files);
  };

  const open = (a: Adding) => {
    setAdding(a);
    setMenu(false);
  };

  return (
    <div className="page onboarding">
      <div className="row page-head">
        <div>
          <h1>Sources</h1>
          <p className="lede" style={{ margin: 0 }}>What agents read: product docs, tracker exports, API contracts, notes, the code, and systems such as Confluence or Jira through MCP.</p>
        </div>
        <span className="spacer" />
        <label className="switch-label" title="Off: every disagreement between sources goes to you">
          <input type="checkbox" role="switch" checked={usePriority} disabled={busy} onChange={(e) => act(() => api.setUsePriority(e.target.checked))} />
          Use priorities
        </label>
        <button className="btn" disabled={checking || !sources?.length} onClick={checkAccess}>{checking ? 'Checking…' : 'Check access'}</button>
        <div className="menu-anchor">
          <button className="btn primary" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>
            Add source <span aria-hidden className="caret">▾</span>
          </button>
          {menu && (
            <div className="menu" role="menu" aria-label="Add source">
              <button role="menuitem" onClick={() => open('file')}><b>Document</b><small>Upload or paste a product doc, tracker export, API contract or note</small></button>
              <button role="menuitem" onClick={() => open('code')}><b>Code folder</b><small>A repository or folder on this computer</small></button>
              <button role="menuitem" onClick={() => open('mcp')}><b>Through MCP</b><small>Confluence, Jira and other systems behind an MCP server</small></button>
            </div>
          )}
        </div>
      </div>
      {usePriority && <p className="muted hint-line">When sources disagree, the one with the higher priority stands: 1 is the strongest. Requirements outrank code by default.</p>}

      <div className="sources-list">
        <table className="grid">
          <thead>
            <tr><th>On</th><th>Priority</th><th>Source</th><th>Kind</th><th>Where</th><th>Access</th><th /></tr>
          </thead>
          <tbody>
            {sources?.map((s) => (
              <tr key={s.id} className={s.enabled ? undefined : 'off'}>
                <td>
                  <input type="checkbox" aria-label={`Use ${s.title}`} checked={s.enabled} disabled={busy} onChange={(e) => act(() => api.updateSource(s.id, { enabled: e.target.checked }))} />
                </td>
                <td>
                  <select className="text prio" aria-label={`Priority of ${s.title}`} value={s.priority} disabled={busy || !usePriority} onChange={(e) => act(() => api.updateSource(s.id, { priority: Number(e.target.value) }))}>
                    {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                </td>
                <td><b>{s.title}</b><div className="id">{s.id}</div></td>
                <td><span className="kind">{kindLabel[s.kind]}</span></td>
                <td className="muted"><span className="id">{where(s)}</span></td>
                <td>
                  {checks[s.id] ? (
                    <span className="access" title={checks[s.id].detail}><span className={`dot ${checks[s.id].ok ? 'ok' : 'bad'}`} /> {checks[s.id].ok ? 'readable' : 'no access'} <span className="muted">{checks[s.id].detail}</span></span>
                  ) : <span className="access muted"><span className="dot" /> not checked</span>}
                </td>
                <td>
                  <div className="row" style={{ justifyContent: 'end' }}>
                    {s.file && <button className="btn small ghost" onClick={() => view(s.id)}>View</button>}
                    {confirmRemove === s.id ? (
                      <>
                        <span className="muted">{s.file ? 'Move to sources/.trash?' : 'Remove from the list?'}</span>
                        <button className="btn small danger" onClick={() => remove(s.id)}>Remove</button>
                        <button className="btn small" onClick={() => setConfirmRemove(null)}>Keep</button>
                      </>
                    ) : (
                      <button className="btn small ghost" onClick={() => setConfirmRemove(s.id)}>Remove…</button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {sources?.length === 0 && <tr><td colSpan={7} className="muted">No sources yet. Use Add source to bring in docs, code or a system through MCP.</td></tr>}
            {!sources && <tr><td colSpan={7} className="muted">Loading…</td></tr>}
          </tbody>
        </table>
      </div>

      {adding && (
        <section className="add-panel" aria-label="Add a source">
          <div className="row">
            <h2 style={{ margin: 0 }}>{adding === 'file' ? 'Add a document' : adding === 'code' ? 'Add a code folder' : 'Add a source through MCP'}</h2>
            <span className="spacer" />
            <button className="btn small ghost" onClick={() => setAdding(null)}>Close</button>
          </div>

          {adding === 'code' && (
            <div className="row" style={{ alignItems: 'flex-end' }}>
              <label className="field" style={{ flex: 1, marginBottom: 0 }}>
                <span>Folder on this computer (absolute, ~/…, or relative to the project)</span>
                <input className="text" autoFocus value={codePath} onChange={(e) => setCodePath(e.target.value)} placeholder="~/work/shop" />
              </label>
              <button className="btn primary" disabled={busy || !codePath.trim()} onClick={addCode}>Add folder</button>
            </div>
          )}

          {adding === 'mcp' && (readTools.length === 0 ? (
            <p className="muted">No MCP server has read tools yet. Add one in Settings (for example an Atlassian MCP server for Confluence or Jira) and allow a read tool.</p>
          ) : (
            <div className="row" style={{ alignItems: 'flex-end' }}>
              <label className="field" style={{ marginBottom: 0 }}>
                <span>Read tool that proves access</span>
                <select className="text" value={mcpTool} onChange={(e) => setMcpTool(e.target.value)}>
                  <option value="">Choose…</option>
                  {readTools.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </label>
              <label className="field" style={{ flex: 1, marginBottom: 0 }}>
                <span>Arguments (JSON)</span>
                <input className="text" value={mcpArgs} onChange={(e) => setMcpArgs(e.target.value)} placeholder='{"space": "SHOP"}' />
              </label>
              <label className="field" style={{ marginBottom: 0 }}>
                <span>Title</span>
                <input className="text" value={mcpTitle} onChange={(e) => setMcpTitle(e.target.value)} placeholder="Confluence · SHOP" />
              </label>
              <button className="btn primary" disabled={busy || !mcpTool} onClick={addMcp}>Add</button>
            </div>
          ))}

          {adding === 'file' && (
            <>
              <label className="field" style={{ maxWidth: 260 }}>
                <span>Kind</span>
                <select className="text" value={kind} onChange={(e) => setKind(e.target.value as FileSourceKind)}>
                  {fileKinds.map((k) => <option key={k} value={k}>{kindLabel[k]}</option>)}
                </select>
              </label>
              <div
                className={`dropzone ${dragOver ? 'over' : ''}`}
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={onDrop}
              >
                <p>Drag files here, or</p>
                <label className="btn small" style={{ cursor: 'pointer' }}>
                  Choose files…
                  <input type="file" multiple style={{ display: 'none' }} disabled={busy} onChange={(e) => { void addFiles(e.target.files ?? []); e.target.value = ''; }} />
                </label>
                <p className="muted">Read as text. Binary or oversized files come back with a clear error.</p>
              </div>
              <h3 style={{ marginTop: 20 }}>Or paste text</h3>
              <label className="field">
                <span>Name</span>
                <input className="text" value={pasteName} onChange={(e) => setPasteName(e.target.value)} placeholder="Refund policy notes" />
              </label>
              <label className="field">
                <span>Text</span>
                <textarea className="text" style={{ minHeight: 120 }} value={pasteContent} onChange={(e) => setPasteContent(e.target.value)} />
              </label>
              <button className="btn primary" disabled={busy || !pasteName.trim() || !pasteContent.trim()} onClick={addPasted}>Add pasted text</button>
            </>
          )}
        </section>
      )}

      {viewing && (
        <div className="lightbox" onClick={() => setViewing(null)} role="dialog" aria-label={viewing.source.title}>
          <figure onClick={(e) => e.stopPropagation()} style={{ width: 'min(900px, 90vw)' }}>
            <pre className="md" style={{ maxHeight: '70vh', overflow: 'auto', margin: 0 }}>{viewing.text}</pre>
            <figcaption><b>{viewing.source.title}</b> <span className="id">{viewing.source.file}</span></figcaption>
          </figure>
        </div>
      )}
    </div>
  );
}
