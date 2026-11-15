import { useEffect, useState } from 'react';
import { api } from '../api.ts';

// The end of the loop: a plain-text description of the product built from what
// people confirmed — subjects, objects, actions, rules with their sources, and
// what's still open. Tests are generated from the same model.
export function SpecView({ reloadToken, onError }: { reloadToken: number; onError(m: string): void }) {
  const [md, setMd] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  useEffect(() => {
    api.spec().then((r) => setMd(r.markdown)).catch((e) => onError((e as Error).message));
  }, [reloadToken]);
  const save = async () => {
    try {
      setSaved((await api.exportSpec()).file);
    } catch (e) {
      onError((e as Error).message);
    }
  };
  return (
    <div className="page">
      <div className="row">
        <h1 style={{ margin: 0 }}>Specification</h1>
        <span className="spacer" />
        {saved && <span className="muted">Saved to {saved}</span>}
        <button className="btn primary" onClick={save}>Save as Markdown</button>
      </div>
      <p className="lede">Everything confirmed about the product so far, in one document. Open questions come from the Disagreements page.</p>
      <pre className="md" style={{ whiteSpace: 'pre-wrap' }}>{md ?? 'Loading…'}</pre>
    </div>
  );
}
