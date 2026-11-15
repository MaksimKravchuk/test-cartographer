import { isActive } from './reach.ts';
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
export function disagreements(proposals: Proposal[], sources: Source[], usePriority: boolean): Disagreement[] {
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
export function renderSpec(project: Project, entities: Entity[], findings: Disagreement[], sources: Source[]): string {
  const title = (id: string) => sources.find((s) => s.id === id)?.title ?? id;
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
      for (const t of ts) lines.push(`- Moves ${e.title.toLowerCase()} from ${t.from === '@new' ? '(new)' : (e.states.find((s) => s.id === t.from)?.title ?? t.from)} to ${e.states.find((s) => s.id === t.to)?.title ?? t.to}`);
      const tIds = new Set(ts.map((t) => t.id));
      const rules = e.rules.filter((r) => isActive(r) && (r.action === a.id || (r.transition && tIds.has(r.transition))));
      for (const r of rules) {
        const src = r.provenance?.sources.length ? ` — ${r.provenance.sources.map(title).join(', ')}` : '';
        lines.push(`- Rule: ${r.text}${r.status === 'observed' ? ' _(observed)_' : ''}${src}`);
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
    const settled = findings.filter((f) => f.entity === e.id && f.resolution?.verdict === 'bug');
    if (settled.length) {
      lines.push('### Known defects', '');
      for (const f of settled) lines.push(`- ${f.finding.note}${f.resolution?.note ? ` (${f.resolution.note})` : ''}`);
      lines.push('');
    }
  }
  return lines.join('\n');
}
