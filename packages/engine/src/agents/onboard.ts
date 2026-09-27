// Onboarding agent: reads the knowledge sources a person uploaded (product
// docs, tracker exports, contracts, notes) and proposes the first SOAR map —
// roles, entities, their models — plus the backlog. Unlike the explorer it
// never touches a running app: everything it knows comes from what was
// uploaded, and every operation must cite an exact quote from it.
import { z } from 'zod';
import { Finding, Op, Proposal, type AgentSpec, type Evidence, type Workspace } from '@tc/model';
import { createSession, type ToolResult, type ToolSpec } from './providers.ts';

export type OnboardOptions = {
  onLog?: (line: string) => void;
  provider?: 'scripted' | 'live';
  signal?: AbortSignal;
};

// Used when cartographer.yaml has no `kind: onboard` entry — a project can
// onboard before anyone has configured an agent at all.
const DEFAULT_AGENT: Pick<AgentSpec, 'id' | 'title' | 'kind' | 'goal' | 'script'> = {
  id: 'onboarding',
  title: 'Onboarding',
  kind: 'onboard',
  goal: 'Read the uploaded knowledge sources and propose the first SOAR map and backlog.',
};

const collapse = (s: string) => s.trim().replace(/\s+/g, ' ');
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Best-effort line span for a quote: the source may wrap it across several
// lines, so the words are matched with `\s+` between them (collapsing spaces
// and newlines alike) against the file's own text, to report where it landed.
function findLines(source: string, quote: string): { from: number; to: number } | null {
  const words = quote.trim().split(/\s+/).filter(Boolean).map(escapeRegExp);
  if (!words.length) return null;
  const m = new RegExp(words.join('\\s+')).exec(source);
  if (!m) return null;
  return { from: source.slice(0, m.index).split('\n').length, to: source.slice(0, m.index + m[0].length).split('\n').length };
}

const system = (p: { sourceList: string; contracts: string[] }) => `You are onboarding Test Cartographer onto a project: read everything a person uploaded — product docs, tracker exports, contracts, notes — and propose the first SOAR model plus the backlog.

The model is Subject / Object / Action / Rule (SOAR): roles (human or system), entities with variants, states,
actions, transitions (who may move the entity from state to state) and permits (who may act without changing
state), and rules (conditions on a transition). Nothing you propose changes the model directly — a person
reviews every operation and decides accept / observe / reject.

The backlog is a view over that model, not a second one: epics group features, a feature is a slice of the
model by action (\`<entity>.<action>\`, cross-entity), and a story cites the exact elements it specifies. Stories
are sources and slices — everything about *behavior* still belongs in the model, not in the backlog.

Uploaded sources: ${p.sourceList || 'none'}.
${p.contracts.length ? `Available contracts: ${p.contracts.join(', ')}.` : ''}

Rules:
- Call sources() and read every source with source() before proposing anything.
- Call model() first and don't propose what it already has — use op=update for a field that changed, never
  op=add for something that already exists.
- Every operation needs at least one quote: call quote({ source, text }) with the exact text (it doesn't need
  to line-wrap the way the source does, but the words and punctuation must match) and put the evidence id it
  returns in that op's own \`evidence\` array. quote() fails if the text isn't actually in the source — never
  paraphrase, and never cite an evidence id in a group other than the one the quote was taken for.
- A state's \`match\` should only name a field/value when a source actually says what the app shows for it;
  otherwise leave \`match: {}\` and add a finding (kind=question) asking where that state is observable.
- If two sources disagree, or a source contradicts what model() already has, report it as a finding
  (kind=contradiction) instead of silently picking one side. If a tracker story can't be mapped to any model
  element yet (the behavior isn't proposed, or doesn't exist), leave its \`covers\` empty or partial and add a
  finding (kind=gap) instead of inventing a ref.
- Call propose() exactly once, with one project-level group (project: { ops, findings }) for roles, interfaces,
  new entities, epics, features and stories, and one group per entity you change (entities: { <id>: { ops,
  findings } }) for that entity's own states/actions/transitions/permits/rules.

Element shapes (op=add, value):
Project-level (in project.ops):
- role: { id, title, kind: "human"|"system", interface?: "<interface id>", login?: { action, args } }
- interface: { id, title, baseUrl }
- entity: { id, title, description?, key?, reader?, variants?: [{ id, title }] } — creates entities/<id>.yaml;
  leave \`reader\` out when nobody knows how to read this entity back yet.
- epic: { id, title, description?, key?, url? }
- feature: { id, title, description?, epic?: "<epic id>", key?, url?, actions: ["<entity>.<action>", …] } — e.g.
  actions: ["order.place", "order.pay"] for a checkout feature spanning the order entity's place and pay actions.
- story: { id, title, text?, acceptance: [string, …], feature?: "<feature id>", epic?: "<epic id>", key?, url?,
  trackerStatus?, covers: ["<action|transition|permit|rule|journey>:<entity>.<id>", …] } — e.g. covers:
  ["transition:order.pay", "action:order.cancel"] once those elements exist (proposed or confirmed); leave
  covers empty and add a gap finding when they don't yet.
Entity-level (in entities.<id>.ops) — unchanged from an explorer's proposal:
- variant: { id, title }
- state: { id, title, variants?: [id], match: { <field>: <value> } }
- action: { id, title, kind?: "create"|"read"|"update"|"command"|"delete" }
- transition: { id, title, from, to, action: "<action id>", by: ["<role id>", …], guards?: [text], effects?: [{ description, field?, equals? }] }
- permit: { id, title, action: "<action id>", by: ["<role id>", …], states?: [id], effects?: [...] }
- scenario (a journey): { id, title, start, path: ["<transition id>", …] }
- rule: { id, title, text, transition: "<transition id>", requires: [{ kind: "authenticated" } | { kind: "roles", roles: [id] } | { kind: "entity-state", relation, states: [id] }] }
For op=update: { kind, id, set: { fields } }. For op=remove: { kind, id } (entities can't be removed this way).

When you're done reading and quoting, call propose() exactly once.`;

export async function onboard(ws: Workspace, agentId: string | undefined, opts: OnboardOptions = {}): Promise<Proposal[]> {
  const log = opts.onLog ?? (() => {});
  const project = await ws.project();
  const agent = agentId ? project.agents.find((a) => a.id === agentId) : project.agents.find((a) => a.kind === 'onboard');
  if (agentId && !agent) throw new Error(`Agent “${agentId}” is not defined in cartographer.yaml`);
  if (agent && agent.kind !== 'onboard') throw new Error(`Agent “${agent.id}” is not an onboarding agent (kind “${agent.kind}”)`);
  const spec = agent ?? DEFAULT_AGENT;

  const scripted = opts.provider === 'scripted' || !project.inference || project.inference.provider === 'scripted';
  const inference = scripted ? { provider: 'scripted' as const, model: 'script', maxSteps: 400, fallbacks: false } : project.inference!;

  const timestamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const sources = await ws.sources();
  const { backlog: baseBacklog, revision: backlogRevision } = await ws.backlog();
  const existingEntities = new Set(await ws.entityIds());

  const textCache = new Map<string, string>();
  const sourceText = async (id: string) => {
    let t = textCache.get(id);
    if (t === undefined) {
      t = await ws.sourceText(id); // throws "Unknown source ..." for a bad id
      textCache.set(id, t);
    }
    return t;
  };

  const evidence: Evidence[] = [];
  const addEvidence = (e: Omit<Evidence, 'id'>) => {
    const id = `e${evidence.length + 1}`;
    evidence.push({ id, ...e });
    return id;
  };

  let rationale = '';
  let projectGroup: { ops: Op[]; findings: Finding[] } | undefined;
  const entityGroups = new Map<string, { ops: Op[]; findings: Finding[] }>();
  let done = false;

  const parseGroup = (label: string, ops: unknown[], findings: unknown[], known: Set<string>) => {
    const parsedOps = z.array(Op).safeParse(ops);
    if (!parsedOps.success) throw new Error(`${label}: ops do not match the schema: ${z.prettifyError(parsedOps.error)}`);
    const parsedFindings = z.array(Finding).safeParse(findings);
    if (!parsedFindings.success) throw new Error(`${label}: findings do not match the schema: ${z.prettifyError(parsedFindings.error)}`);
    const unknown = [...parsedOps.data, ...parsedFindings.data].flatMap((x) => x.evidence).filter((id) => !known.has(id));
    if (unknown.length) throw new Error(`${label}: unknown evidence ${[...new Set(unknown)].join(', ')}. Available: ${[...known].join(', ')}`);
    return { ops: parsedOps.data, findings: parsedFindings.data };
  };

  const tools: (ToolSpec & { run(input: any): Promise<string> })[] = [
    {
      name: 'sources',
      description: 'List every uploaded knowledge source: id, title, kind and line count.',
      input: z.object({}),
      run: async () => JSON.stringify(await Promise.all(sources.map(async (s) => ({ id: s.id, title: s.title, kind: s.kind, lines: (await sourceText(s.id)).split('\n').length })))),
    },
    {
      name: 'source',
      description: 'Read a source’s text with line numbers. lines [offset, offset+limit); offset is 1-based.',
      input: z.object({ id: z.string(), offset: z.number().int().positive().default(1), limit: z.number().int().positive().default(200) }),
      run: async ({ id, offset, limit }) => {
        const lines = (await sourceText(id)).split('\n');
        return lines.slice(offset - 1, offset - 1 + limit).map((l, i) => `${offset + i}: ${l}`).join('\n');
      },
    },
    {
      name: 'model',
      description: 'The current model: project roles/interfaces, every entity, and the backlog.',
      input: z.object({}),
      run: async () => JSON.stringify({ project: { roles: project.roles, interfaces: project.interfaces }, entities: await ws.catalog(), backlog: baseBacklog }),
    },
    {
      name: 'quote',
      description: 'Cite an exact quote from a source as evidence. Fails if the text (whitespace-collapsed) is not in that source.',
      input: z.object({ source: z.string(), text: z.string() }),
      run: async ({ source, text }) => {
        const src = await sourceText(source);
        if (!collapse(src).includes(collapse(text))) throw new Error(`“${text}” is not in source “${source}” — quote the exact text, don't paraphrase`);
        const lines = findLines(src, text);
        const file = sources.find((s) => s.id === source)!.file;
        const id = addEvidence({ kind: 'source', summary: text, source, path: lines ? `${file}#L${lines.from}-L${lines.to}` : undefined });
        return JSON.stringify({ evidence: id });
      },
    },
    {
      name: 'propose',
      description: 'Finish onboarding: submit one project-level proposal and/or one per entity. Call exactly once.',
      input: z.object({
        rationale: z.string(),
        project: z
          .object({ ops: z.array(z.record(z.string(), z.unknown())).default([]), findings: z.array(z.record(z.string(), z.unknown())).default([]) })
          .optional(),
        entities: z
          .record(z.string(), z.object({ ops: z.array(z.record(z.string(), z.unknown())).default([]), findings: z.array(z.record(z.string(), z.unknown())).default([]) }))
          .optional(),
      }),
      run: async (input: {
        rationale: string;
        project?: { ops: unknown[]; findings: unknown[] };
        entities?: Record<string, { ops: unknown[]; findings: unknown[] }>;
      }) => {
        const { rationale: r, project: projectIn, entities: entitiesIn } = input;
        const known = new Set(evidence.map((e) => e.id));
        if (!projectIn && !entitiesIn) throw new Error('propose needs at least a project or an entities group');
        if (projectIn) projectGroup = parseGroup('project', projectIn.ops, projectIn.findings, known);
        for (const [id, group] of Object.entries(entitiesIn ?? {})) entityGroups.set(id, parseGroup(`entity “${id}”`, group.ops, group.findings, known));
        rationale = r;
        done = true;
        return 'proposal(s) recorded';
      },
    },
  ];

  const session = await createSession(
    inference,
    {
      system: system({
        sourceList: sources.map((s) => `${s.id} (${s.kind}): ${s.title}`).join('; '),
        contracts: project.contracts.map((c) => `${c.id} (${c.title})`),
      }),
      prompt: `Start onboarding. Goal: ${spec.goal}`,
      tools,
      vars: () => ({}),
    },
    spec.script ? ws.path(spec.script) : undefined,
  );

  let results: ToolResult[] = [];
  for (let step = 0; step < inference.maxSteps && !done; step++) {
    if (opts.signal?.aborted) throw new Error('Onboarding stopped');
    const turn = await session.next(results);
    if (turn.text) log(`💬 ${turn.text}`);
    if (turn.done) break;
    results = [];
    for (const call of turn.calls) {
      const tool = tools.find((t) => t.name === call.name);
      const parsed = tool?.input.safeParse(call.input);
      if (!tool || !parsed?.success) {
        results.push({ id: call.id, content: tool ? `Invalid arguments: ${z.prettifyError(parsed!.error!)}` : `No tool ${call.name}`, isError: true });
        continue;
      }
      log(`🔧 ${call.name} ${JSON.stringify(call.input).slice(0, 160)}`);
      try {
        results.push({ id: call.id, content: await tool.run(parsed.data) });
      } catch (e) {
        log(`   ⚠ ${(e as Error).message}`);
        results.push({ id: call.id, content: (e as Error).message, isError: true });
      }
    }
  }
  if (!done) throw new Error('The agent finished without a proposal (propose was not called)');

  const proposals: Proposal[] = [];
  const createdAt = new Date().toISOString();
  if (projectGroup) {
    const refs = new Set([...projectGroup.ops, ...projectGroup.findings].flatMap((x) => x.evidence));
    proposals.push(
      Proposal.parse({
        id: `${timestamp}-${spec.id}`,
        agent: spec.id,
        createdAt,
        baseRevision: backlogRevision,
        rationale,
        evidence: evidence.filter((e) => refs.has(e.id)),
        ops: projectGroup.ops,
        findings: projectGroup.findings,
      }),
    );
  }
  for (const [entityId, group] of entityGroups) {
    const refs = new Set([...group.ops, ...group.findings].flatMap((x) => x.evidence));
    const baseRevision = existingEntities.has(entityId) ? (await ws.entity(entityId)).revision : 'new';
    proposals.push(
      Proposal.parse({
        id: `${timestamp}-${spec.id}-${entityId}`,
        entity: entityId,
        agent: spec.id,
        createdAt,
        baseRevision,
        rationale,
        evidence: evidence.filter((e) => refs.has(e.id)),
        ops: group.ops,
        findings: group.findings,
      }),
    );
  }
  for (const p of proposals) await ws.saveProposal(p);
  return proposals;
}
