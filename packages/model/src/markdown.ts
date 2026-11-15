import { NEW, type Entity, type Project, type ScenarioResult } from './schema.ts';
import type { Plan, Scenario } from './plan.ts';
import type { Step } from './reach.ts';

const icons: Record<string, string> = { passed: '✅', failed: '❌', skipped: '⏭️', blocked: '⛔', 'not-run': '⚪' };
const phases = { arrange: 'Arrange', act: 'Act', assert: 'Assert' } as const;

const fmt = (v: unknown) => '`' + JSON.stringify(v) + '`';
const matchText = (m: Record<string, unknown>) =>
  Object.entries(m).map(([k, v]) => `${k} = ${fmt(v)}`).join(', ');

export function renderMarkdown(
  project: Project,
  entity: Entity,
  plan: Plan,
  results: Record<string, ScenarioResult>,
): string {
  const state = (id: string) => (id === NEW ? 'New' : (entity.states.find((s) => s.id === id)?.title ?? id));
  const role = (id: string) => project.roles.find((r) => r.id === id)?.title ?? id;
  const variant = (id: string) => entity.variants.find((v) => v.id === id)?.title ?? id;

  const via = (s: { run?: string; invoke?: { tool: string } }) => (s.invoke ? `invoke \`${s.invoke.tool}\`` : s.run ? `run \`${s.run}\`` : 'no binding');

  const stepText = (s: Step): string => {
    switch (s.do) {
      case 'prepare':
        return `Prepare data: call \`${s.tool}\` ${fmt(s.args)}, entity key from field \`${s.key}\``;
      case 'transition':
        return `${role(s.role)}: “${s.title}” (${state(s.from)} → ${state(s.to)}), action \`${s.action}\` (${via(s)})`;
      case 'perform':
        return `${role(s.role)}: “${s.title}” in “${state(s.state)}”, action \`${s.action}\` (${via(s)})`;
      case 'expectState':
        return `State “${state(s.state)}” confirmed by reading: ${matchText(s.match)}`;
      case 'expectInvariant':
        return `Invariant “${s.title}” holds: ${matchText(s.match)}`;
      case 'expectField':
        return `${s.description}: \`${s.field}\` = ${fmt(s.equals)}`;
      case 'expectUnavailable':
        return `${role(s.role)} cannot run \`${s.run}\` (action \`${s.action}\`) in state “${state(s.state)}”`;
      case 'manual':
        return `Manual check: ${s.description}`;
      case 'related':
        return `Prepare the related ${s.entity} (${s.variant}) in state “${s.state}”: ${s.steps.map(stepText).join('; ')}`;
      case 'expectRelated':
        return `${s.description}: related \`${s.relation}.${s.field}\` ${s.delta !== undefined ? `changes by ${s.delta}` : `= ${fmt(s.equals)}`}`;
    }
  };

  const provenanceText = (sc: Scenario) => {
    const p = sc.provenance;
    if (!p || p.source === 'human') return 'modeled by a person';
    const ev = p.evidence.length ? `; evidence: ${p.evidence.join(', ')}` : '';
    return `proposed by agent \`${p.agent}\` (${p.proposal}), confirmed by a person${ev}`;
  };

  const prep = {
    tool: 'setup tool',
    path: 'explicit transition path',
    auto: 'shortest path through confirmed transitions',
    none: 'none — the scenario creates the instance',
  };

  const lines: string[] = [];
  const total = plan.scenarios.length;
  const passed = plan.scenarios.filter((s) => results[s.id]?.status === 'passed').length;
  const blocked = plan.scenarios.filter((s) => s.blocked).length;
  lines.push(`# ${entity.title}: scenarios`, '');
  lines.push(`Project: ${project.name}. Scenarios: ${total}, passed: ${passed}, blocked: ${blocked}.`, '');
  lines.push(`Variants: ${entity.variants.filter((v) => v.status === 'confirmed').map((v) => `${v.title} (\`${v.id}\`)`).join(', ')}.`, '');

  for (const sc of plan.scenarios) {
    const r = results[sc.id];
    const status = sc.blocked ? 'blocked' : (r?.status ?? 'not-run');
    lines.push(`## ${icons[status]} ${sc.title} — ${variant(sc.variant)}`, '');
    lines.push(`- ID: \`${sc.id}\``);
    lines.push(`- Role: ${role(sc.role)}`);
    lines.push(`- Provenance: ${provenanceText(sc)}`);
    const rule = sc.kind === 'rule' ? entity.rules.find((r) => r.id === sc.target) : undefined;
    if (rule) lines.push(`- Business rule: ${rule.text}`);
    // Traceability: a deny scenario a `roles`/`authenticated` rule was checked against.
    if (sc.rules.length) lines.push(`- Checks rule(s): ${sc.rules.map((id) => entity.rules.find((r) => r.id === id)?.title ?? id).join(', ')}`);
    const journey = sc.kind === 'journey' ? entity.scenarios.find((j) => j.id === sc.target) : undefined;
    if (journey?.description) lines.push(`- About: ${journey.description}`);
    if (sc.blocked) {
      lines.push(`- Blocked: ${sc.blocked}`, '');
      continue;
    }
    lines.push(`- Setup: ${prep[sc.preparation!]}`);
    lines.push(`- Last run: ${r ? `${r.status}, ${r.at}${r.error ? ` — ${r.error.split('\n')[0]}` : ''}` : 'not run yet'}`, '');
    sc.steps.forEach((s, i) => lines.push(`${i + 1}. **${phases[s.phase]}.** ${stepText(s)}`));
    lines.push('');
  }
  return lines.join('\n');
}
