import { useEffect, useState } from 'react';
import type { Role } from '@tc/model';
import type { ProjectState } from '../api.ts';

// How tests act as a subject: a person works through an interface and may sign in first;
// without a sign-in action it acts as a guest. A system subject (cron, scheduler,
// integration) has no interface and acts only through actions with an invoke tool.
export function SubjectConnection({ role, project, busy, onSave }: { role: Role; project: ProjectState; busy: boolean; onSave(r: Role): void }) {
  const [draft, setDraft] = useState<Role>(role);
  useEffect(() => setDraft(role), [role]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(role);
  const set = (patch: Partial<Role>) => setDraft({ ...draft, ...patch });
  const ifaces = project.project.interfaces;
  const logins = [...new Set([...project.actions.map((a) => a.name), ...(draft.login ? [draft.login.action] : [])])];
  return (
    <details className="tech" open={dirty || undefined}>
      <summary>How tests act as {role.title}</summary>
      <div className="conn">
        <label className="field">
          <span>Kind</span>
          <select
            className="text"
            value={draft.kind}
            onChange={(e) => {
              const kind = e.target.value as Role['kind'];
              set(kind === 'system' ? { kind, interface: undefined, login: undefined } : { kind, interface: draft.interface ?? ifaces[0]?.id });
            }}
          >
            <option value="human">Person</option>
            <option value="system">System</option>
          </select>
        </label>
        {draft.kind === 'human' && (
          <>
            <label className="field">
              <span>Interface</span>
              <select className="text" value={draft.interface} onChange={(e) => set({ interface: e.target.value })}>
                {ifaces.map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}
              </select>
            </label>
            <label className="field">
              <span>Sign-in action</span>
              <select className="text" value={draft.login?.action ?? ''} onChange={(e) => set({ login: e.target.value ? { action: e.target.value, args: draft.login?.args ?? {} } : undefined })}>
                <option value="">Guest — no sign-in</option>
                {logins.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            </label>
            {draft.login && (
              <label className="field">
                <span>Credentials (use {'{{env.NAME}}'} to keep passwords out of the file)</span>
                <input
                  className="text id"
                  value={Object.entries(draft.login.args).map(([k, v]) => `${k}=${v}`).join(', ')}
                  placeholder="username=buyer, password={{env.BUYER_PASSWORD}}"
                  onChange={(e) =>
                    set({
                      login: {
                        action: draft.login!.action,
                        args: Object.fromEntries(
                          e.target.value.split(',').map((p) => p.trim()).filter((p) => p.includes('=')).map((p) => [p.slice(0, p.indexOf('=')).trim(), p.slice(p.indexOf('=') + 1).trim()]),
                        ),
                      },
                    })
                  }
                />
              </label>
            )}
          </>
        )}
      </div>
      {dirty && (
        <div className="tech-bar">
          <span className="spacer" />
          <button type="button" className="btn small" onClick={() => setDraft(role)}>Discard</button>
          <button type="button" className="btn small primary" disabled={busy} onClick={() => onSave(draft)}>Save</button>
        </div>
      )}
    </details>
  );
}
