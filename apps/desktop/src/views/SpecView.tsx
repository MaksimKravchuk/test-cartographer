import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { renderMarkdown } from '../markdown.tsx';

// The end of the loop: a description of the product built from what people
// confirmed — subjects, objects, actions, rules with the tests that check them,
// and what's still open. Tests are generated from the same model.
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
  const doc = md === null ? null : renderMarkdown(md);
  return (
    <div className="spec">
      <nav className="toc" aria-label="Contents">
        <div className="tree-h">Contents</div>
        {doc?.headings.filter((h) => h.level === 2 || h.level === 3).map((h) => (
          <a key={h.id} href={`#${h.id}`} className={`l${h.level}`} onClick={(e) => { e.preventDefault(); document.getElementById(h.id)?.scrollIntoView({ block: 'start' }); }}>
            {h.text}
          </a>
        ))}
      </nav>
      <div className="spec-page">
        <div className="row spec-bar">
          <span className="muted">Everything confirmed about the product so far. Open questions are settled in the Inbox.</span>
          <span className="spacer" />
          {saved && <span className="muted">Saved to {saved}</span>}
          <button className="btn" onClick={save}>Save as Markdown</button>
        </div>
        <article className="spec-doc">{doc ? doc.nodes : <p className="muted">Loading…</p>}</article>
      </div>
    </div>
  );
}
