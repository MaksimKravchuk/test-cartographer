import { isActive } from './reach.ts';
import type { Plan, Scenario } from './plan.ts';
import type { Entity, Evidence, Finding, Project, Proposal, Resolution, Source } from './schema.ts';

export type Quote = { evidence: Evidence; source?: Source };
export type Disagreement = {
  proposal: string;
  entity?: string;
  index: number;
  finding: Finding;
  quotes: Quote[];
  // The source whose word stands: the strongest priority among the quotes,
  // when priorities are on and exactly one source holds it.
  winner?: string;
  resolution?: Resolution;
  createdAt: string;
};

// Every finding agents reported, newest first, with its quotes and which side wins.
// Everything agents reported that needs a person: confirmations are left out (see allFindings).
export const disagreements = (proposals: Proposal[], sources: Source[], usePriority: boolean): Disagreement[] =>
  allFindings(proposals, sources, usePriority).filter((d) => d.finding.kind !== 'confirmation');

export function allFindings(proposals: Proposal[], sources: Source[], usePriority: boolean): Disagreement[] {
  const byId = new Map(sources.map((s) => [s.id, s]));
  return [...proposals]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .flatMap((p) =>
      p.findings.map((finding, index) => {
        const quotes = finding.evidence
          .map((id) => p.evidence.find((e) => e.id === id))
          .filter((e): e is Evidence => !!e)
          .map((evidence) => ({ evidence, source: evidence.source ? byId.get(evidence.source) : undefined }));
        const ranked = quotes.filter((q) => q.source).map((q) => q.source!);
        const best = Math.min(...ranked.map((s) => s.priority));
        const top = [...new Set(ranked.filter((s) => s.priority === best).map((s) => s.id))];
        const spread = new Set(ranked.map((s) => s.priority)).size > 1;
        return {
          proposal: p.id,
          entity: p.entity,
          index,
          finding,
          quotes,
          winner: usePriority && spread && top.length === 1 ? top[0] : undefined,
          resolution: p.resolutions.find((r) => r.finding === index),
          createdAt: p.createdAt,
        };
      }),
    );
}

const roleTitle = (project: Project, id: string) => project.roles.find((r) => r.id === id)?.title ?? id;

// The product's specification, from what people have confirmed or observed:
// subjects, objects, and for every action who performs it and its rules with
// their sources. Open disagreements are listed at the end of each object.
// With `plans`, each transition and rule names the test scenarios that check it, and
// what no test checks is listed at the end.
export function renderSpec(project: Project, entities: Entity[], findings: Disagreement[], sources: Source[], plans?: Plan[]): string {
  const title = (id: string) => sources.find((s) => s.id === id)?.title ?? id;
  const untested: string[] = [];
  const tests = (entity: Entity, label: string, match: (s: Scenario) => boolean) => {
    if (!plans) return '';
    const ids = (plans.find((p) => p.entity === entity.id)?.scenarios ?? []).filter((s) => !s.blocked && match(s)).map((s) => `\`${s.id}\``);
    if (ids.length) return ` — tests: ${ids.join(', ')}`;
    untested.push(`- ${entity.title}: ${label}`);
    return ' _(no test)_';
  };
  const lines = [`# ${project.name} — specification`, ''];
  lines.push('## Subjects', '');
  for (const r of project.roles) lines.push(`- **${r.title}** — ${r.kind === 'system' ? 'background jobs and integrations' : 'a person'}`);
  lines.push('', '## Objects', '');
  for (const e of entities) lines.push(`- **${e.title}**${e.description ? ` — ${e.description}` : ''}`);
  for (const e of entities) {
    lines.push('', `## ${e.title}`, '');
    if (e.description) lines.push(e.description, '');
    const states = e.states.filter(isActive);
    if (states.length) lines.push(`States: ${states.map((s) => s.title).join(' · ')}`, '');
    for (const a of e.actions.filter(isActive)) {
      const by = new Set(a.by ?? []);
      for (const t of e.transitions) if (t.action === a.id && isActive(t)) t.by.forEach((x) => by.add(x));
      for (const p of e.permits) if (p.action === a.id && isActive(p)) p.by.forEach((x) => by.add(x));
      const observed = a.status === 'observed' ? ' _(observed, not a requirement)_' : '';
      lines.push(`### ${[...by].map((id) => roleTitle(project, id)).join(', ') || 'Nobody yet'} → ${a.title}${observed}`, '');
      const ts = e.transitions.filter((t) => t.action === a.id && isActive(t));
      for (const t of ts) {
        const move = `${a.title}: ${t.from === '@new' ? '(new)' : (e.states.find((s) => s.id === t.from)?.title ?? t.from)} → ${e.states.find((s) => s.id === t.to)?.title ?? t.to}`;
        lines.push(`- Moves ${e.title.toLowerCase()} from ${t.from === '@new' ? '(new)' : (e.states.find((s) => s.id === t.from)?.title ?? t.from)} to ${e.states.find((s) => s.id === t.to)?.title ?? t.to}${tests(e, move, (s) => s.kind === 'transition' && s.target === t.id)}`);
      }
      const tIds = new Set(ts.map((t) => t.id));
      const rules = e.rules.filter((r) => isActive(r) && (r.action === a.id || (r.transition && tIds.has(r.transition))));
      for (const r of rules) {
        const src = r.provenance?.sources.length ? ` — ${r.provenance.sources.map(title).join(', ')}` : '';
        lines.push(`- Rule: ${r.text}${r.status === 'observed' ? ' _(observed)_' : ''}${src}${tests(e, `rule “${r.text}”`, (s) => s.rules.includes(r.id) || (s.kind === 'rule' && s.target === r.id))}`);
      }
      if (!ts.length && !rules.length) lines.push('- No rules yet.');
      lines.push('');
    }
    const open = findings.filter((f) => f.entity === e.id && !f.resolution);
    if (open.length) {
      lines.push('### Open questions', '');
      for (const f of open) lines.push(`- ${f.finding.kind === 'contradiction' ? 'Disagreement' : f.finding.kind === 'gap' ? 'Gap' : 'Question'}: ${f.finding.note}`);
      lines.push('');
    }
    const planned = [
      ...e.actions.filter((a) => a.status === 'planned').map((a) => `Action: ${a.title}`),
      ...e.transitions.filter((t) => t.status === 'planned').map((t) => `${t.title}: ${e.states.find((s) => s.id === t.from)?.title ?? t.from} → ${e.states.find((s) => s.id === t.to)?.title ?? t.to}`),
      ...e.rules.filter((r) => r.status === 'planned').map((r) => `Rule: ${r.text}`),
      ...e.states.filter((s) => s.status === 'planned').map((s) => `State: ${s.title}`),
      ...e.permits.filter((p) => p.status === 'planned').map((p) => `${p.by.map((id) => roleTitle(project, id)).join(', ')} may ${e.actions.find((a) => a.id === p.action)?.title ?? p.action}${p.states?.length ? ` in ${p.states.map((id) => e.states.find((s) => s.id === id)?.title ?? id).join(', ')}` : ''}`),
      ...e.variants.filter((v) => v.status === 'planned').map((v) => `Variant: ${v.title}`),
      ...e.scenarios.filter((j) => j.status === 'planned').map((j) => `Scenario: ${j.title}`),
    ];
    if (planned.length) lines.push('### Planned, not built yet', '', ...planned.map((x) => `- ${x}`), '');
    const settled = findings.filter((f) => f.entity === e.id && f.resolution?.verdict === 'bug');
    if (settled.length) {
      lines.push('### Known defects', '');
      for (const f of settled) lines.push(`- ${f.finding.note}${f.resolution?.note ? ` (${f.resolution.note})` : ''}`);
      lines.push('');
    }
  }
  if (plans) lines.push('## Not checked by any test', '', ...(untested.length ? untested : ['Every transition and rule has a test.']), '');
  return lines.join('\n');
}

export type Lint = { entity: string; ref: string; message: string };
const VAGUE = /\b(usually|normally|typically|may|might|should|generally|often|sometimes|as needed|etc)\b/i;

// What makes the model hard to test, without running an agent: actions
// nobody performs or with nothing said about them, rules in vague words,
// states nothing leads to or nothing leaves (except terminal ones).
export function lintModel(entities: Entity[]): Lint[] {
  const out: Lint[] = [];
  for (const e of entities) {
    const transitions = e.transitions.filter(isActive);
    for (const a of e.actions.filter(isActive)) {
      const ts = transitions.filter((t) => t.action === a.id);
      const by = (a.by?.length ?? 0) + ts.length + e.permits.filter((p) => isActive(p) && p.action === a.id).length;
      if (!by) out.push({ entity: e.id, ref: `action:${e.id}.${a.id}`, message: `Nobody performs “${a.title}”` });
      const ids = new Set(ts.map((t) => t.id));
      const rules = e.rules.filter((r) => isActive(r) && (r.action === a.id || (r.transition && ids.has(r.transition))));
      if (!ts.length && !rules.length) out.push({ entity: e.id, ref: `action:${e.id}.${a.id}`, message: `Nothing is known about “${a.title}”: no rules and no state change` });
    }
    for (const r of e.rules.filter(isActive)) {
      const m = VAGUE.exec(r.text);
      if (m) out.push({ entity: e.id, ref: `rule:${e.id}.${r.id}`, message: `“${m[0]}” can't be tested: say exactly when it holds — “${r.text}”` });
      if (!r.provenance?.sources.length) out.push({ entity: e.id, ref: `rule:${e.id}.${r.id}`, message: `No source backs “${r.title}”: find it in the requirements or the code, or it stays one person's word` });
    }
    for (const s of e.states.filter(isActive)) {
      const into = s.initial || s.setup.length > 0 || transitions.some((t) => t.to === s.id);
      const out_ = s.terminal || transitions.some((t) => t.from === s.id);
      if (!into) out.push({ entity: e.id, ref: `state:${e.id}.${s.id}`, message: `Nothing leads to “${s.title}”` });
      if (!out_) out.push({ entity: e.id, ref: `state:${e.id}.${s.id}`, message: `Nothing leaves “${s.title}”, and it isn't marked terminal` });
    }
  }
  return out;
}

// What each source says about each element of the model. `confirms` comes from
// the element's provenance; an open finding that names the element and quotes
// the source overrides it, except that the side which stands by priority confirms. No cell means the source said nothing either way.
export type ReviewCell = 'confirms' | 'contradicts' | 'gap' | 'question';
// The three marks a reviewer reads first: what the requirements say (every source
// that isn't code), what the code says, and whether the app showed it.
export type ReviewMarks = { requirements?: ReviewCell; code?: ReviewCell; app: boolean };
export type ReviewRow = { entity: string; ref: string; title: string; cells: Record<string, ReviewCell>; marks: ReviewMarks };
const rank: Record<ReviewCell, number> = { confirms: 0, question: 1, gap: 2, contradicts: 3 };
const findingCell = { contradiction: 'contradicts', gap: 'gap', question: 'question', confirmation: 'confirms' } as const;

export function reviewMatrix(entities: Entity[], findings: Disagreement[], sources: Pick<Source, 'id' | 'kind'>[] = []): ReviewRow[] {
  const isCode = new Set(sources.filter((s) => s.kind === 'code').map((s) => s.id));
  const strongest = (cells: ReviewCell[]) => cells.reduce<ReviewCell | undefined>((a, c) => (a === undefined || rank[c] > rank[a] ? c : a), undefined);
  const open = findings.filter((f) => !f.resolution);
  return entities.flatMap((e) => {
    const stateTitle = (id: string) => (id === '@new' ? '(new)' : (e.states.find((s) => s.id === id)?.title ?? id));
    const actionTitle = (id: string) => e.actions.find((a) => a.id === id)?.title ?? id;
    const elements = [
      ...e.states.filter(isActive).map((x) => ({ x, ref: `state:${e.id}.${x.id}`, title: `State: ${x.title}` })),
      ...e.actions.filter(isActive).map((x) => ({ x, ref: `action:${e.id}.${x.id}`, title: `Action: ${x.title}` })),
      ...e.transitions.filter(isActive).map((x) => ({ x, ref: `transition:${e.id}.${x.id}`, title: `${actionTitle(x.action)}: ${stateTitle(x.from)} → ${stateTitle(x.to)}` })),
      ...e.rules.filter(isActive).map((x) => ({ x, ref: `rule:${e.id}.${x.id}`, title: `Rule: ${x.text}` })),
    ];
    return elements.map(({ x, ref, title }) => {
      const cells: Record<string, ReviewCell> = {};
      for (const s of x.provenance?.sources ?? []) cells[s] = 'confirms';
      const found: Record<string, ReviewCell> = {};
      for (const f of open.filter((f) => f.finding.refs.includes(ref)))
        for (const s of [...f.quotes.map((q) => q.evidence.source), ...(f.finding.searched ?? [])]) {
          if (!s) continue;
          const cell = s === f.winner ? 'confirms' : findingCell[f.finding.kind];
          // Several findings may quote one source: the strongest stands, whatever their order.
          if (!found[s] || rank[cell] > rank[found[s]]) found[s] = cell;
        }
      Object.assign(cells, found);
      const marks = {
        requirements: strongest(Object.entries(cells).filter(([id]) => !isCode.has(id)).map(([, c]) => c)),
        code: strongest(Object.entries(cells).filter(([id]) => isCode.has(id)).map(([, c]) => c)),
        app: !!x.provenance?.seen,
      };
      return { entity: e.id, ref, title: `${e.title} · ${title}`, cells, marks };
    });
  });
}
