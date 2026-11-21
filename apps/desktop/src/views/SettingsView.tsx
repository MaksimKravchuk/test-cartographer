import { useEffect, useState } from 'react';
import type { Project } from '@tc/model';
import { api, type ProjectState } from '../api.ts';
import { nextId } from '../graph.ts';

type Props = { project: ProjectState; onSaved(): void; onError(m: string): void };

// Name and interfaces of the project. How each subject signs in is on its page in
// Model; agent runtimes live on the Agents page;
// MCP servers stay in cartographer.yaml — they hold commands and keys that are
// safer to edit in a file.
export function SettingsView({ project, onSaved, onError }: Props) {
  const [draft, setDraft] = useState<Project>(project.project);
  const [busy, setBusy] = useState(false);
  useEffect(() => setDraft(project.project), [project.project]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(project.project);

  const setIface = (i: number, patch: Partial<Project['interfaces'][number]>) =>
    setDraft({ ...draft, interfaces: draft.interfaces.map((x, n) => (n === i ? { ...x, ...patch } : x)) });

  const save = async () => {
    setBusy(true);
    try {
      await api.saveProject(draft);
      onSaved();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page settings">
      <h1>Project settings</h1>
      <p className="lede">
        Stored in <span className="id">{project.root}/cartographer.yaml</span>.
      </p>

      <label className="field" style={{ maxWidth: 420 }}>
        <span>Project name</span>
        <input className="text" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
      </label>

      <h2>Interfaces</h2>
      <p className="muted">Each subject works through one interface (set on its page in Model). Actions open paths relative to its base URL.</p>
      <table className="grid">
        <thead><tr><th>ID</th><th>Title</th><th>Base URL</th><th /></tr></thead>
        <tbody>
          {draft.interfaces.map((x, i) => (
            <tr key={i}>
              <td><input className="text id" value={x.id} onChange={(e) => setIface(i, { id: e.target.value })} /></td>
              <td><input className="text" value={x.title} onChange={(e) => setIface(i, { title: e.target.value })} /></td>
              <td><input className="text" value={x.baseUrl} onChange={(e) => setIface(i, { baseUrl: e.target.value })} /></td>
              <td>
                {draft.roles.some((r) => r.interface === x.id) ? (
                  <span className="muted">Used by a subject</span>
                ) : (
                  <button type="button" className="btn small" disabled={draft.interfaces.length === 1} onClick={() => setDraft({ ...draft, interfaces: draft.interfaces.filter((_, n) => n !== i) })}>
                    Remove
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button className="btn small" onClick={() => setDraft({ ...draft, interfaces: [...draft.interfaces, { id: nextId('interface', draft.interfaces.map((x) => x.id)), title: 'New interface', baseUrl: 'http://localhost:3000' }] })}>
        Add interface
      </button>

      <h2>Data tools (MCP)</h2>
      <p className="muted">Edit these in cartographer.yaml. The engine only calls the tools listed here.</p>
      <table className="grid">
        <thead><tr><th>Server</th><th>Command</th><th>Setup tools</th><th>Read tools</th><th>Trigger tools</th></tr></thead>
        <tbody>
          {Object.entries(draft.mcp).map(([id, m]) => (
            <tr key={id}>
              <td className="id">{id}</td>
              <td className="id">{[m.command, ...m.args].join(' ')}</td>
              <td className="id">{m.allow.prepare.join(', ') || '—'}</td>
              <td className="id">{m.allow.read.join(', ') || '—'}</td>
              <td className="id">{m.allow.trigger.join(', ') || '—'}</td>
            </tr>
          ))}
          {Object.keys(draft.mcp).length === 0 && <tr><td colSpan={5} className="muted">No data tools yet. Without one, states can only be reached through transitions and can't be verified by reading.</td></tr>}
        </tbody>
      </table>

      <div className="row" style={{ marginTop: 24 }}>
        <button className="btn primary" disabled={!dirty || busy} onClick={save}>Save settings</button>
        {dirty && <button className="btn" onClick={() => setDraft(project.project)}>Discard</button>}
      </div>
    </div>
  );
}
