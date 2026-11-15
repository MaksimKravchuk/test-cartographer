import { useEffect, useState } from 'react';
import type { DragEvent } from 'react';
import type { FileSourceKind, Source, SourceKind } from '@tc/model';
// schema.ts only: the package index pulls in Node-only workspace.ts (see AccessMatrix.tsx).
import { resolveRuntime } from '@tc/model/schema';
import { api, runtimeTitle, type Job, type ProjectState, type SourceCheck, type SourceInfo } from '../api.ts';

type Props = {
  project: ProjectState;
  job: Job | null;
  running: boolean;
  reloadToken: number;
  onOpenProposals(): void;
  onError(m: string): void;
};

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
// who wins when sources disagree — and an access check. Onboarding reads the
// enabled uploaded files and proposes the first SOAR map plus the backlog.
export function OnboardingView({ project, job, running, reloadToken, onOpenProposals, onError }: Props) {
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
  // The onboarding agent is the project's `kind: 'onboard'` agent, if any —
  // an onboard agent isn't tied to a role/entity, so there's only ever one to consider.
  const onboardAgent = project.project.agents.find((a) => a.kind === 'onboard');
  const runtime = resolveRuntime(project.project, onboardAgent);
  const [provider, setProvider] = useState<'live' | 'scripted'>(runtime ? 'live' : 'scripted');
  const [ranJobId, setRanJobId] = useState<string | null>(null);
  const [finished, setFinished] = useState(false);

  const load = () => {
    api.sources().then((r) => { setSources(r.sources); setUsePriority(r.usePriority); }).catch((e) => onError((e as Error).message));
  };
  useEffect(() => { load(); }, [reloadToken]);

  useEffect(() => {
    if (job && ranJobId && job.id === ranJobId && job.state !== 'running') {
      if (job.state === 'done') setFinished(true);
      setRanJobId(null);
    }
  }, [job, ranJobId]);

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

  const runOnboarding = async () => {
    setFinished(false);
    try {
      const { job: id } = await api.runOnboarding(provider);
      setRanJobId(id);
    } catch (e) {
      onError((e as Error).message);
    }
  };

  return (
    <div className="page onboarding">
      <h1>Sources</h1>
      <p className="lede">
        Everything known about the product, in one place: product docs, tracker exports, API contracts, notes, the code,
        and systems such as Confluence or Jira through MCP. Check that agents can reach each one, and set who wins when they
        disagree: priority 1 is the strongest — requirements outrank code by default.
      </p>

      <section>
        <div className="row">
          <h2 style={{ margin: 0 }}>Sources {sources ? `(${sources.length})` : ''}</h2>
          <label className="row" style={{ gap: 6 }}>
            <input type="checkbox" checked={usePriority} disabled={busy} onChange={(e) => act(() => api.setUsePriority(e.target.checked))} />
            Use priorities <span className="muted">(off: every disagreement goes to you)</span>
          </label>
          <button className="btn primary" disabled={checking || !sources?.length} onClick={checkAccess}>{checking ? 'Checking…' : 'Check access'}</button>
        </div>
        <table className="grid">
          <thead>
            <tr><th>On</th><th>Priority</th><th>Title</th><th>Kind</th><th>Where</th><th>Access</th><th /></tr>
          </thead>
          <tbody>
            {sources?.map((s) => (
              <tr key={s.id} className={s.enabled ? undefined : 'muted'}>
                <td>
                  <input type="checkbox" aria-label={`Use ${s.title}`} checked={s.enabled} disabled={busy} onChange={(e) => act(() => api.updateSource(s.id, { enabled: e.target.checked }))} />
                </td>
                <td>
                  <select className="text" aria-label={`Priority of ${s.title}`} value={s.priority} disabled={busy || !usePriority} onChange={(e) => act(() => api.updateSource(s.id, { priority: Number(e.target.value) }))}>
                    {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                </td>
                <td>{s.title}<div className="id">{s.id}</div></td>
                <td className="muted">{kindLabel[s.kind]}</td>
                <td className="muted"><span className="id">{where(s)}</span></td>
                <td>
                  {checks[s.id] ? (
                    <span style={{ color: checks[s.id].ok ? 'var(--pass)' : 'var(--fail)' }} title={checks[s.id].detail}>{checks[s.id].ok ? '✓' : '✗'} {checks[s.id].detail}</span>
                  ) : <span className="muted">not checked</span>}
                </td>
                <td>
                  <div className="row">
                    {s.file && <button className="btn small" onClick={() => view(s.id)}>View</button>}
                    {confirmRemove === s.id ? (
                      <>
                        <span className="muted">{s.file ? 'Move to sources/.trash?' : 'Remove from the list?'}</span>
                        <button className="btn small danger" onClick={() => remove(s.id)}>Remove</button>
                        <button className="btn small" onClick={() => setConfirmRemove(null)}>Keep</button>
                      </>
                    ) : (
                      <button className="btn small" onClick={() => setConfirmRemove(s.id)}>Remove…</button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {sources?.length === 0 && <tr><td colSpan={7} className="muted">No sources yet — add one below.</td></tr>}
            {!sources && <tr><td colSpan={7} className="muted">Loading…</td></tr>}
          </tbody>
        </table>
      </section>

      <section>
        <h2>Add a code folder</h2>
        <div className="row">
          <label className="field" style={{ flex: 1, marginBottom: 0 }}>
            <span>Folder on this computer (absolute, ~/…, or relative to the project)</span>
            <input className="text" value={codePath} onChange={(e) => setCodePath(e.target.value)} placeholder="~/work/shop" />
          </label>
          <button className="btn" disabled={busy || !codePath.trim()} onClick={addCode}>Add folder</button>
        </div>

        <h2 style={{ marginTop: 24 }}>Add a source through MCP</h2>
        {readTools.length === 0 ? (
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
            <button className="btn" disabled={busy || !mcpTool} onClick={addMcp}>Add</button>
          </div>
        )}

        <h2 style={{ marginTop: 24 }}>Upload a file</h2>
        <label className="field" style={{ maxWidth: 260 }}>
          <span>Kind (applies to what you add next)</span>
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
            <input
              type="file"
              multiple
              style={{ display: 'none' }}
              disabled={busy}
              onChange={(e) => { void addFiles(e.target.files ?? []); e.target.value = ''; }}
            />
          </label>
          <p className="muted">Read as text in the browser. Binary or oversized files come back with a clear error.</p>
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
        <button className="btn" disabled={busy || !pasteName.trim() || !pasteContent.trim()} onClick={addPasted}>Add pasted text</button>
      </section>

      <section>
        <h2>Run onboarding</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          Reads every enabled uploaded file above (code and MCP sources come with the research agent, next) and writes a project-level proposal — nothing changes in the model until you decide it on the Proposals page.
        </p>
        <div className="row">
          <label className="field" style={{ marginBottom: 0 }}>
            <span>Who onboards</span>
            <select className="text" value={provider} onChange={(e) => setProvider(e.target.value as 'live' | 'scripted')}>
              {runtime && (
                <option value="live">
                  Live — {runtimeTitle[runtime.provider]}{runtime.model ? ` · ${runtime.model}` : ''}
                </option>
              )}
              <option value="scripted">Recorded script, no model</option>
            </select>
          </label>
          <button className="btn primary" disabled={running || !sources?.some((s) => s.enabled && s.file)} onClick={runOnboarding}>
            {running ? 'Job running…' : 'Run onboarding'}
          </button>
        </div>
        {!sources?.some((s) => s.enabled && s.file) && <p className="muted">Upload at least one file first.</p>}
        {finished && (
          <div className="finding" style={{ marginTop: 12 }}>
            Onboarding finished. <button className="btn small" onClick={onOpenProposals}>Go to Proposals</button>
          </div>
        )}
      </section>

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
