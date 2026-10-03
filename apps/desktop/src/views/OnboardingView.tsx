import { useEffect, useState } from 'react';
import type { DragEvent } from 'react';
import type { Source, SourceKind } from '@tc/model';
// schema.ts only: the package index pulls in Node-only workspace.ts (see AccessMatrix.tsx).
import { resolveRuntime } from '@tc/model/schema';
import { api, runtimeTitle, type Job, type ProjectState, type SourceInfo } from '../api.ts';

type Props = {
  project: ProjectState;
  job: Job | null;
  running: boolean;
  reloadToken: number;
  onOpenProposals(): void;
  onError(m: string): void;
};

const kindLabel: Record<SourceKind, string> = { doc: 'Product doc', backlog: 'Tracker export', contract: 'API contract', note: 'Note' };

function readAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error(`Could not read ${file.name}`));
    reader.readAsText(file);
  });
}

// Everything you know about the system under test, gathered in one place so
// the onboarding agent can propose the first SOAR map plus the backlog from it.
export function OnboardingView({ project, job, running, reloadToken, onOpenProposals, onError }: Props) {
  const [sources, setSources] = useState<SourceInfo[] | null>(null);
  const [kind, setKind] = useState<SourceKind>('doc');
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
    api.sources().then((r) => setSources(r.sources)).catch((e) => onError((e as Error).message));
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
      <h1>Onboarding</h1>
      <p className="lede">
        Upload everything you know about the system under test — product docs, a tracker export with epics/features/stories,
        API contracts, notes. An onboarding agent reads them and proposes the first map: roles, entities, actions, states,
        transitions, permits, rules, plus the backlog. Every proposed element cites an exact quote — you decide what becomes a requirement.
      </p>

      <section>
        <h2>Sources {sources ? `(${sources.length})` : ''}</h2>
        <table className="grid">
          <thead>
            <tr><th>Title</th><th>Kind</th><th>Lines</th><th>Added</th><th /></tr>
          </thead>
          <tbody>
            {sources?.map((s) => (
              <tr key={s.id}>
                <td>{s.title}<div className="id">{s.id}</div></td>
                <td className="muted">{kindLabel[s.kind]}</td>
                <td className="muted">{s.lines}</td>
                <td className="muted">{new Date(s.addedAt).toLocaleDateString()}</td>
                <td>
                  <div className="row">
                    <button className="btn small" onClick={() => view(s.id)}>View</button>
                    {confirmRemove === s.id ? (
                      <>
                        <span className="muted">Move to sources/.trash?</span>
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
            {sources?.length === 0 && <tr><td colSpan={5} className="muted">No sources yet — add one below.</td></tr>}
            {!sources && <tr><td colSpan={5} className="muted">Loading…</td></tr>}
          </tbody>
        </table>
      </section>

      <section>
        <h2>Add a source</h2>
        <label className="field" style={{ maxWidth: 260 }}>
          <span>Kind (applies to what you add next)</span>
          <select className="text" value={kind} onChange={(e) => setKind(e.target.value as SourceKind)}>
            {(Object.keys(kindLabel) as SourceKind[]).map((k) => <option key={k} value={k}>{kindLabel[k]}</option>)}
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
          Reads every source above and writes a project-level proposal — nothing changes in the model until you decide it on the Proposals page.
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
          <button className="btn primary" disabled={running || !sources?.length} onClick={runOnboarding}>
            {running ? 'Job running…' : 'Run onboarding'}
          </button>
        </div>
        {!sources?.length && <p className="muted">Add at least one source first.</p>}
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
