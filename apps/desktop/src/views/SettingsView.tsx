import { useEffect, useState } from 'react';
import type { Project } from '@tc/model';
import { api, type ProjectState } from '../api.ts';
import { nextId } from '../graph.ts';

type Props = { project: ProjectState; onSaved(): void; onError(m: string): void };

// Interfaces and roles of the project. Agent runtimes live on the Agents page;
// MCP servers stay in cartographer.yaml — they hold commands and keys that are
// safer to edit in a file.
export function SettingsView({ project, onSaved, onError }: Props) {
  const [draft, setDraft] = useState<Project>(project.project);
  const [busy, setBusy] = useState(false);
  useEffect(() => setDraft(project.project), [project.project]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(project.project);

  const setIface = (i: number, patch: Partial<Project['interfaces'][number]>) =>
    setDraft({ ...draft, interfaces: draft.interfaces.map((x, n) => (n === i ? { ...x, ...patch } : x)) });
  const setRole = (i: number, patch: Partial<Project['roles'][number]>) =>
    setDraft({ ...draft, roles: draft.roles.map((x, n) => (n === i ? { ...x, ...patch } : x)) });

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

  const loginActions = project.actions.map((a) => a.name);

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
      <p className="muted">Each role works through one interface. Actions open paths relative to its base URL.</p>
      <table className="grid">
        <thead><tr><th>ID</th><th>Title</th><th>Base URL</th><th /></tr></thead>
        <tbody>
          {draft.interfaces.map((x, i) => (
            <tr key={i}>
              <td><input className="text id" value={x.id} onChange={(e) => setIface(i, { id: e.target.value })} /></td>
              <td><input className="text" value={x.title} onChange={(e) => setIface(i, { title: e.target.value })} /></td>
              <td><input className="text" value={x.baseUrl} onChange={(e) => setIface(i, { baseUrl: e.target.value })} /></td>
              <td>
                <button className="btn small" disabled={draft.interfaces.length === 1 || draft.roles.some((r) => r.interface === x.id)} title="Interfaces used by a role can't be removed" onClick={() => setDraft({ ...draft, interfaces: draft.interfaces.filter((_, n) => n !== i) })}>
                  Remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button className="btn small" onClick={() => setDraft({ ...draft, interfaces: [...draft.interfaces, { id: nextId('interface', draft.interfaces.map((x) => x.id)), title: 'New interface', baseUrl: 'http://localhost:3000' }] })}>
        Add interface
      </button>

      <h2>Roles</h2>
      <p className="muted">
        A human role works through an interface and may sign in before it acts; without a sign-in action it acts as a guest — rules like “only
        signed-in users” are checked with it. A system role (cron, scheduler, integration) has no interface and acts only through actions with an
        invoke tool. Use <span className="id">{'{{env.NAME}}'}</span> in credentials to keep real passwords out of the file.
      </p>
      <table className="grid">
        <thead><tr><th>ID</th><th>Title</th><th>Kind</th><th>Interface</th><th>Sign-in action</th><th>Credentials</th><th /></tr></thead>
        <tbody>
          {draft.roles.map((r, i) => (
            <tr key={i}>
              <td><input className="text id" value={r.id} onChange={(e) => setRole(i, { id: e.target.value })} /></td>
              <td><input className="text" value={r.title} onChange={(e) => setRole(i, { title: e.target.value })} /></td>
              <td>
                <select
                  className="text"
                  style={{ minWidth: 100 }}
                  value={r.kind}
                  onChange={(e) => {
                    const kind = e.target.value as 'human' | 'system';
                    setRole(i, kind === 'system' ? { kind, interface: undefined, login: undefined } : { kind, interface: r.interface ?? draft.interfaces[0]?.id });
                  }}
                >
                  <option value="human">Person</option>
                  <option value="system">System</option>
                </select>
              </td>
              <td>
                {r.kind === 'human' ? (
                  <select className="text" value={r.interface} onChange={(e) => setRole(i, { interface: e.target.value })}>
                    {draft.interfaces.map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}
                  </select>
                ) : (
                  <span className="muted">— no interface —</span>
                )}
              </td>
              <td>
                {r.kind === 'human' ? (
                  <select
                    className="text"
                    value={r.login?.action ?? ''}
                    onChange={(e) => setRole(i, { login: e.target.value ? { action: e.target.value, args: r.login?.args ?? {} } : undefined })}
                  >
                    <option value="">Guest — no sign-in</option>
                    {[...new Set([...loginActions, ...(r.login ? [r.login.action] : [])])].map((a) => <option key={a} value={a}>{a}</option>)}
                  </select>
                ) : (
                  <span className="muted">—</span>
                )}
              </td>
              <td>
                {r.login && (
                  <input
                    className="text id"
                    value={Object.entries(r.login.args).map(([k, v]) => `${k}=${v}`).join(', ')}
                    placeholder="username=buyer, password={{env.BUYER_PASSWORD}}"
                    onChange={(e) =>
                      setRole(i, {
                        login: {
                          action: r.login!.action,
                          args: Object.fromEntries(
                            e.target.value.split(',').map((p) => p.trim()).filter((p) => p.includes('=')).map((p) => [p.slice(0, p.indexOf('=')).trim(), p.slice(p.indexOf('=') + 1).trim()]),
                          ),
                        },
                      })
                    }
                  />
                )}
              </td>
              <td>
                <button className="btn small" disabled={draft.roles.length === 1} onClick={() => setDraft({ ...draft, roles: draft.roles.filter((_, n) => n !== i) })}>Remove</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button className="btn small" onClick={() => setDraft({ ...draft, roles: [...draft.roles, { id: nextId('role', draft.roles.map((x) => x.id)), title: 'New role', kind: 'human', interface: draft.interfaces[0].id }] })}>
        Add role
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
