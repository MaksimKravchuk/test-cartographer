// Scores what the agents proposed against the oracle (order.yaml). States are
// matched by `match.state` — the value the reader actually returns — so the ids
// an agent made up don't matter; a state with no such match falls back to its id
// through `state_aliases` and is counted separately. Transitions are matched by
// their (from, to) pair, roles by id.
//
//   node score.ts [proposals dir] [--model entities/order.yaml | none]
//   (defaults: ../workspace/proposals and ../workspace/entities/order.yaml)
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import YAML from 'yaml';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { model: { type: 'string' }, json: { type: 'boolean' } } });
const dir = resolve(positionals[0] ?? join(import.meta.dirname, '../workspace/proposals'));
const modelFile = resolve(values.model ?? join(import.meta.dirname, '../workspace/entities/order.yaml'));
const oracle = YAML.parse(readFileSync(join(import.meta.dirname, 'order.yaml'), 'utf8'));

type Edge = { from: string; to: string; by: string[]; id: string };
const ORACLE_STATES: string[] = oracle.states;
const alias = new Map<string, string>(
  Object.entries(oracle.state_aliases as Record<string, string[]>).flatMap(([state, ids]) => ids.map((id) => [id, state] as [string, string])),
);
// Expand list-valued `from`; drop the "any → any" manual transition, it isn't a single edge.
const oracleEdges: Edge[] = oracle.transitions
  .filter((t: any) => t.from !== 'any')
  .flatMap((t: any) => [t.from].flat().map((from: string) => ({ from, to: t.to, by: t.by, id: t.id })));
const isReal = (from: string, to: string) => oracleEdges.some((e) => e.from === from && e.to === to);

const model = existsSync(modelFile) ? YAML.parse(readFileSync(modelFile, 'utf8')) : { states: [], transitions: [], permits: [] };
const proposals = readdirSync(dir)
  .filter((f) => f.endsWith('.yaml'))
  .sort()
  .map((f) => YAML.parse(readFileSync(join(dir, f), 'utf8')));

type Mapped = { id: string; from: string; to: string; by: string[] };
function mapProposal(states: any[], transitions: any[]) {
  const byMatch = new Map<string, string>();
  const byName = new Map<string, string>();
  for (const s of states) {
    const v = Object.values(s.match ?? {}).find((x) => typeof x === 'string' && ORACLE_STATES.includes(x as string)) as string | undefined;
    if (v) byMatch.set(s.id, v);
    else if (alias.has(s.id)) byName.set(s.id, alias.get(s.id)!);
  }
  const name = (id: string) => (id === '@new' ? '@new' : byMatch.get(id) ?? byName.get(id) ?? `?${id}`);
  const edges: Mapped[] = transitions.flatMap((t) => [t.from].flat().map((from: string) => ({ id: t.id, from: name(from), to: name(t.to), by: t.by ?? [] })));
  return { byMatch, byName, edges, name };
}

const pick = (ops: any[], kind: string) => ops.filter((o) => o.op === 'add' && o.kind === kind).map((o) => o.value);
const rows: any[] = [];

function report(label: string, roles: string[], m: ReturnType<typeof mapProposal>, permits: any[], findings: any[]) {
  const states = new Set([...m.byMatch.values()]);
  const named = new Set([...m.byName.values()].filter((s) => !states.has(s)));
  const real = m.edges.filter((e) => isReal(e.from, e.to));
  const unreal = m.edges.filter((e) => !isReal(e.from, e.to));
  const wanted = oracleEdges.flatMap((e) => e.by.filter((r) => roles.includes(r)).map((r) => ({ ...e, role: r })));
  const hit = wanted.filter((w) => m.edges.some((p) => p.from === w.from && p.to === w.to && p.by.includes(w.role)));
  const wrongRole = m.edges.flatMap((p) => {
    const e = oracleEdges.find((x) => x.from === p.from && x.to === p.to);
    return e ? p.by.filter((r) => !e.by.includes(r)).map((r) => `${p.id} (${p.from}→${p.to}) by ${r}`) : [];
  });
  rows.push({ label, states: states.size, named: named.size, edges: m.edges.length, real: real.length, unreal: unreal.length, hit: hit.length, wanted: wanted.length, wrongRole: wrongRole.length, findings: findings.length });

  console.log(`\n── ${label}`);
  console.log(`states:      ${states.size}/${ORACLE_STATES.length} by match [${[...states].join(', ')}]${named.size ? ` + ${named.size} by name only [${[...named].join(', ')}]` : ''}`);
  console.log(`transitions: ${m.edges.length} proposed edges, ${real.length} real, ${unreal.length} not in the oracle`);
  for (const p of unreal) console.log(`   ✗ ${p.id}: ${p.from} → ${p.to} by ${p.by.join(',')}`);
  console.log(`recall:      ${hit.length}/${wanted.length} (edge × role) for ${roles.join(', ') || '—'}`);
  for (const w of wanted.filter((w) => !hit.includes(w))) console.log(`   · missed ${w.id}: ${w.from} → ${w.to} (${w.role})`);
  if (wrongRole.length) console.log(`wrong role:  ${wrongRole.join('; ')}`);
  console.log(`permits:     ${permits.map((p) => `${p.id} by ${(p.by ?? []).join(',')}${p.states ? ` in ${p.states.map(m.name).join(',')}` : ''}`).join('; ') || '—'}`);
  console.log(`findings:    ${findings.length}`);
  for (const f of findings) console.log(`   [${f.kind}] ${String(f.note).replace(/\s+/g, ' ').slice(0, 240)}`);
}

const union = { byMatch: new Map<string, string>(), byName: new Map<string, string>(), edges: [] as Mapped[], name: (id: string) => id };
const unionRoles = new Set<string>();
const unionPermits: any[] = [];
for (const p of proposals) {
  if (p.entity && p.entity !== 'order') continue;
  const ops = p.ops ?? [];
  const m = mapProposal([...(model.states ?? []), ...pick(ops, 'state')], pick(ops, 'transition'));
  // An explorer is scored on its own role; onboarding on every role it names.
  const roles = p.role ? [p.role] : [...new Set(m.edges.flatMap((e) => e.by))];
  report(`${p.agent}${p.entity ? '' : ' (project)'}  [${p.id}]`, roles, m, pick(ops, 'permit'), p.findings ?? []);
  m.byMatch.forEach((v, k) => union.byMatch.set(`${p.id}:${k}`, v));
  m.byName.forEach((v, k) => union.byName.set(`${p.id}:${k}`, v));
  union.edges.push(...m.edges);
  roles.forEach((r) => unionRoles.add(r));
  unionPermits.push(...pick(ops, 'permit'));
}
report('all proposals together', [...unionRoles], union, unionPermits, []);

console.log('\n| proposal | states (match / name) | edges: real / not real | recall (edge × role) | wrong role | findings |');
console.log('|---|---|---|---|---|---|');
for (const r of rows) console.log(`| ${r.label.replace(/\s+\[.*$/, '')} | ${r.states} / ${r.named} | ${r.real} / ${r.unreal} | ${r.hit}/${r.wanted} | ${r.wrongRole} | ${r.findings} |`);
