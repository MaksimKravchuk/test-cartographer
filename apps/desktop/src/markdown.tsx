import type { ReactNode } from 'react';

// Just enough Markdown for the spec the engine writes: headings, "- " lists,
// paragraphs, **bold**, _italic_ and `code`. A list item's trailing
// "— tests: `a`, `b`" becomes a compact count so rules stay readable.
// shortcut: no nested lists, tables or links; use a real parser if the spec grows them.

export type Heading = { level: number; text: string; id: string };

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\*\*(.+?)\*\*|`([^`]+)`|_(.+?)_/g;
  let at = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > at) out.push(text.slice(at, m.index));
    const k = out.length;
    out.push(m[1] !== undefined ? <b key={k}>{m[1]}</b> : m[2] !== undefined ? <code key={k}>{m[2]}</code> : <i key={k}>{m[3]}</i>);
    at = re.lastIndex;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

function item(text: string, key: number) {
  const m = / — tests: (.+)$/.exec(text);
  if (!m) return <li key={key}>{inline(text)}</li>;
  const tests = [...m[1].matchAll(/`([^`]+)`/g)].map((x) => x[1]);
  return (
    <li key={key}>
      {inline(text.slice(0, m.index))}{' '}
      <span className="tests" title={tests.join('\n')}>{tests.length} {tests.length === 1 ? 'test' : 'tests'}</span>
    </li>
  );
}

export function renderMarkdown(md: string): { nodes: ReactNode[]; headings: Heading[] } {
  const nodes: ReactNode[] = [];
  const headings: Heading[] = [];
  let list: ReactNode[] = [];
  const flush = () => {
    if (list.length) nodes.push(<ul key={nodes.length}>{list}</ul>);
    list = [];
  };
  for (const line of md.split('\n')) {
    const h = /^(#{1,3}) (.+)$/.exec(line);
    if (h) {
      flush();
      const level = h[1].length;
      const id = `${slug(h[2])}-${headings.length}`;
      headings.push({ level, text: h[2], id });
      const Tag = `h${level + 1}` as 'h2' | 'h3' | 'h4';
      nodes.push(<Tag key={nodes.length} id={id}>{inline(h[2])}</Tag>);
    } else if (line.startsWith('- ')) list.push(item(line.slice(2), list.length));
    else if (line.trim()) {
      flush();
      nodes.push(<p key={nodes.length}>{inline(line)}</p>);
    } else flush();
  }
  flush();
  return { nodes, headings };
}
