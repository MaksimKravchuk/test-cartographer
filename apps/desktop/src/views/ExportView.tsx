import { useState } from 'react';
import { api } from '../api.ts';

export function ExportView({ onError }: { onError(m: string): void }) {
  const [files, setFiles] = useState<{ path: string; content: string }[] | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    try {
      setFiles((await api.exportMarkdown()).files);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <p className="lede">
        The Markdown covers every scenario in the plan: provenance, data setup, steps, assertions, and the last run result. Files are written to the workspace export/ folder.
      </p>
      <div className="row" style={{ marginBottom: 20 }}>
        <button className="btn primary" disabled={busy} onClick={run}>Export to Markdown</button>
        <span className="muted">Sync with Allure TestOps comes in a later release.</span>
      </div>
      {files?.map((f) => (
        <div key={f.path}>
          <div className="row" style={{ marginBottom: 6 }}>
            <span className="id">{f.path}</span>
            <button className="btn small" onClick={() => navigator.clipboard.writeText(f.content)}>Copy</button>
          </div>
          <pre className="md">{f.content}</pre>
        </div>
      ))}
    </div>
  );
}
