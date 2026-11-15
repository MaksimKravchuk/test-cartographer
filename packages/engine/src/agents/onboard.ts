// Onboarding agent: reads the knowledge sources a person uploaded (product
// docs, tracker exports, contracts, notes) and proposes the first SOAR map —
// roles, entities, their models — plus the backlog. Unlike the explorer it
// never touches a running app: everything it knows comes from what was
// uploaded, and every operation must cite an exact quote from it.
import { z } from 'zod';
import { checkRoles, Finding, isFileSource, Op, Proposal, redactFields, resolveRuntime, type AgentSpec, type Evidence, type Workspace } from '@tc/model';
import { readFile, stat } from 'node:fs/promises';
import { listOf, runAgent, type Tool } from './runtime.ts';
import { McpPool } from '../mcp.ts';
import { codePath, insideCode, listCode } from '../sources.ts';

export type OnboardOptions = {
  onLog?: (line: string) => void;
  provider?: 'scripted' | 'live';
  signal?: AbortSignal;
  // onboard — propose a model from scratch (or add to a thin one);
  // review  — check every element of the existing model against the sources.
  mode?: 'onboard' | 'review';
};

// Used when cartographer.yaml has no `kind: onboard` entry — a project can
// onboard before anyone has configured an agent at all.
const DEFAULT_AGENT: Pick<AgentSpec, 'id' | 'title' | 'kind' | 'goal' | 'script'> = {
  id: 'onboarding',
  title: 'Onboarding',
  kind: 'onboard',
  goal: 'Read the uploaded knowledge sources and propose the first SOAR map and backlog.',
};

// One group of a propose() call: the project's, or one entity's.
const ProposalGroup = z.object({ ops: listOf(Op).default([]), findings: listOf(Finding).default([]) });

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

const MODE_GOAL = {
  onboard: 'read everything known about the product — docs, tracker exports, contracts, notes, the code, systems behind MCP — and propose the SOAR model plus the backlog.',
  review: `review the model a person already has against everything known about the product. For every subject, object,
action and rule in model(), look for confirmation or contradiction in the sources; propose what the model is missing.
Report each disagreement as a finding (kind=contradiction) whose refs name the element ("rule:<entity>.<id>",
"action:<entity>.<id>") and whose evidence quotes every side; say in the note which side wins by priority and why.
A rule found only in the code is behavior, not a requirement: propose it and say so in a finding (kind=gap).
Cover every element, so the review fills a table of element × source: where a source says the same as the model,
add a finding (kind=confirmation) with that element in refs and the quote as evidence; where you looked and found
nothing, add a finding (kind=gap) whose note names the sources and files you searched.`,
};

const system = (p: { sourceList: string; contracts: string[]; mode: 'onboard' | 'review'; usePriority: boolean }) => `You are working for Test Cartographer: ${MODE_GOAL[p.mode]}

The model is Subject / Object / Action / Rule (SOAR): roles (human or system), entities with variants, states,
actions, transitions (who may move the entity from state to state) and permits (who may act without changing
state), and rules (conditions on a transition). Nothing you propose changes the model directly — a person
reviews every operation and decides accept / observe / reject.

The backlog is a view over that model, not a second one: epics group features, a feature is a slice of the
model by action (\`<entity>.<action>\`, cross-entity), and a story cites the exact elements it specifies. Stories
are sources and slices — everything about *behavior* still belongs in the model, not in the backlog.

Sources (id, kind, priority — 1 is the strongest): ${p.sourceList || 'none'}.
${p.usePriority ? 'When sources disagree, the lower priority number wins: requirements usually outrank code. Still report the disagreement.' : 'Priorities are off: report every disagreement and let the person decide.'}
How to read them: uploaded files — source({ id }); code folders — files({ source }) then read({ source, path });
MCP sources — fetch({ source, args? }) (the tool and default args are set per source; you may pass other args).
${p.contracts.length ? `Available contracts: ${p.contracts.join(', ')}.` : ''}

Rules:
- Call sources() first and read what's relevant from every source before proposing anything. In a code folder,
  start from the file list and read what implements the model's actions (routes, handlers, domain logic); skip tests,
  generated files and assets.
- Call model() first and don't propose what it already has — use op=update for a field that changed, never
  op=add for something that already exists.
- Every operation needs at least one quote: call quote({ source, text, path? }) with the exact text (path: the
  file inside a code folder) (it doesn't need
  to line-wrap the way the source does, but the words and punctuation must match) and put the evidence id it
  returns in that op's own \`evidence\` array. quote() fails if the text isn't actually in the source — never
  paraphrase, and never cite an evidence id in a group other than the one the quote was taken for.
- Never invent a requirement. If no source says it, it isn't one: don't propose it as a rule, add a finding
  (kind=question) saying what you looked for and where.
- When a search finds nothing, say where you searched (which sources, files or queries) in the finding's note, so
  "not found" can be told apart from "not looked for".
- model() lists openQuestions that earlier runs left. Try to answer each one from the sources. End the rationale
  with one line per open question: answered, partly or still open, and why.
- Describe what the product does, not how it's built: a rule names behavior a user or tester can see ("a buyer
  can cancel until payment"), never a function, table or flag. Avoid untestable words like "usually" or "may".
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
- action may also carry by: ["<role id>", …] — who performs it, when no transition or permit says so yet.
- rule: { id, title, text, action: "<action id>" } — knowledge in the product's words; add transition: "<transition id>"
  and requires: [{ kind: "authenticated" } | { kind: "roles", roles: [id] } | { kind: "entity-state", relation, states: [id] }]
  when the rule is a checkable condition on a transition.
For op=update: { kind, id, set: { fields } }. For op=remove: { kind, id } (entities can't be removed this way).

When you're done reading and quoting, call propose() exactly once.`;

export async function onboard(ws: Workspace, agentId: string | undefined, opts: OnboardOptions = {}): Promise<Proposal[]> {
  const log = opts.onLog ?? (() => {});
  const project = await ws.project();
  const agent = agentId ? project.agents.find((a) => a.id === agentId) : project.agents.find((a) => a.kind === 'onboard');
  if (agentId && !agent) throw new Error(`Agent “${agentId}” is not defined in cartographer.yaml`);
  if (agent && agent.kind !== 'onboard') throw new Error(`Agent “${agent.id}” is not an onboarding agent (kind “${agent.kind}”)`);
  const spec = agent ?? DEFAULT_AGENT;

  const runtime = opts.provider === 'scripted' ? 'scripted' : resolveRuntime(project, agent) ?? 'scripted';

  const timestamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  // Onboarding reads uploaded files only; code and MCP sources come with the research agent.
  const mode = opts.mode ?? 'onboard';
  const registry = await ws.sourceRegistry();
  const sources = registry.sources.filter((s) => s.enabled);
  const mcp = new McpPool(project, ws.root);
  const { backlog: baseBacklog, revision: backlogRevision } = await ws.backlog();
  const existingEntities = new Set(await ws.entityIds());

  const sourceOf = (id: string, kinds?: string[]) => {
    const s = sources.find((x) => x.id === id);
    if (!s) throw new Error(`Unknown source “${id}”. Available: ${sources.map((x) => x.id).join(', ')}`);
    if (kinds && !kinds.includes(isFileSource(s) ? 'file' : s.kind)) throw new Error(`Source “${id}” is a ${s.kind} source — use ${isFileSource(s) ? 'source()' : s.kind === 'code' ? 'files() and read()' : 'fetch()'}`);
    return s;
  };
  const textCache = new Map<string, string>();
  const sourceText = async (id: string) => {
    let t = textCache.get(id);
    if (t === undefined) {
      sourceOf(id, ['file']);
      t = await ws.sourceText(id);
      textCache.set(id, t);
    }
    return t;
  };
  // A file inside a code folder; refuses paths that leave the folder and .env* files.
  const codeText = async (id: string, path: string) => {
    const s = sourceOf(id, ['code']);
    const root = codePath(ws.root, s.path!);
    const { abs, rel } = await insideCode(root, path).catch((e: Error) => {
      throw new Error(`${e.message} (source “${id}”)`);
    });
    const key = `${id}:${rel}`;
    let t = textCache.get(key);
    if (t === undefined) {
      if ((await stat(abs)).size > 512 * 1024) throw new Error(`“${path}” is larger than 512 KB`);
      t = await readFile(abs, 'utf8');
      if (t.includes('\0')) throw new Error(`“${path}” is a binary file`);
      textCache.set(key, t);
    }
    return { rel, text: t };
  };
  // Everything fetched from an MCP source, so quote() can check against it.
  const fetched = new Map<string, string[]>();

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

  const tools: Tool[] = [
    {
      name: 'sources',
      description: 'List every source: id, title, kind, priority (1 is the strongest), and its size or tool.',
      input: z.object({}),
      run: async () =>
        JSON.stringify(
          await Promise.all(
            sources.map(async (s) => ({
              id: s.id,
              title: s.title,
              kind: s.kind,
              priority: registry.usePriority ? s.priority : undefined,
              ...(isFileSource(s) ? { lines: (await sourceText(s.id)).split('\n').length } : s.kind === 'code' ? { path: s.path } : { tool: s.read!.tool, args: s.read!.args }),
            })),
          ),
        ),
    },
    {
      name: 'files',
      description: 'List the files of a code-folder source (skips node_modules, build output, .git and .env files), optionally under a sub-folder.',
      input: z.object({ source: z.string(), dir: z.string().default('') }),
      run: async ({ source, dir }) => {
        const s = sourceOf(source, ['code']);
        const all = await listCode(codePath(ws.root, s.path!));
        const prefix = dir.replace(/^\.?\/?/, '').replace(/\/?$/, dir ? '/' : '');
        const list = all.filter((f) => f.startsWith(prefix));
        return list.length > 800 ? `${list.slice(0, 800).join('\n')}\n… ${list.length - 800} more — narrow with dir` : list.join('\n') || 'no files';
      },
    },
    {
      name: 'read',
      description: 'Read a file of a code-folder source with line numbers. lines [offset, offset+limit); offset is 1-based.',
      input: z.object({ source: z.string(), path: z.string(), offset: z.number().int().positive().default(1), limit: z.number().int().positive().default(300) }),
      run: async ({ source, path, offset, limit }) => {
        const lines = (await codeText(source, path)).text.split('\n');
        return lines.slice(offset - 1, offset - 1 + limit).map((l, i) => `${offset + i}: ${l}`).join('\n');
      },
    },
    {
      name: 'fetch',
      description: "Call an MCP source's read tool (or another read tool of the same server) and get its text. Quote from it with quote({ source, text }).",
      input: z.object({ source: z.string(), tool: z.string().optional(), args: z.record(z.string(), z.unknown()).optional() }),
      run: async ({ source, tool, args }) => {
        const s = sourceOf(source, ['mcp']);
        const server = s.read!.tool.split('.')[0];
        const name = tool ? (tool.includes('.') ? tool : `${server}.${tool}`) : s.read!.tool;
        if (name.split('.')[0] !== server) throw new Error(`Source “${source}” reads through the “${server}” server only`);
        const result = await mcp.call(name, args ?? s.read!.args, 'read');
        const text = typeof result === 'string' ? result : JSON.stringify(result, null, 1);
        fetched.set(source, [...(fetched.get(source) ?? []), text]);
        return text.length > 40_000 ? `${text.slice(0, 40_000)}\n… truncated (${text.length} chars) — fetch narrower` : text;
      },
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
      description: 'The current model: project roles/interfaces, every entity, and the backlog. Secret field values show as their {{…}} reference.',
      input: z.object({}),
      run: async () =>
        JSON.stringify({
          project: { roles: redactFields('roles', project.roles, process.env), interfaces: project.interfaces },
          entities: Object.fromEntries(redactFields('entities', Object.values(await ws.catalog()), process.env).map((e) => [e.id, e])),
          backlog: baseBacklog,
          // What earlier runs left open: questions and gaps nobody has settled yet.
          openQuestions: (await ws.proposals()).flatMap((p) =>
            p.findings.flatMap((f, i) => ((f.kind === 'gap' || f.kind === 'question') && !p.resolutions.some((r) => r.finding === i) ? [{ kind: f.kind, refs: f.refs, note: f.note }] : [])),
          ),
        }),
    },
    {
      name: 'quote',
      description: 'Cite an exact quote from a source as evidence (path: the file, for a code folder). Fails if the text (whitespace-collapsed) is not there.',
      input: z.object({ source: z.string(), text: z.string(), path: z.string().optional() }),
      run: async ({ source, text, path }) => {
        const s = sourceOf(source);
        const missing = () => new Error(`“${text}” is not in source “${source}”${path ? ` at ${path}` : ''} — quote the exact text, don't paraphrase`);
        let src: string;
        let file: string | undefined;
        if (isFileSource(s)) [src, file] = [await sourceText(source), s.file];
        else if (s.kind === 'code') {
          if (!path) throw new Error(`Quoting code needs the file: quote({ source: "${source}", path, text })`);
          const c = await codeText(source, path);
          [src, file] = [c.text, c.rel];
        } else {
          src = (fetched.get(source) ?? []).find((t) => collapse(t).includes(collapse(text))) ?? '';
          if (!src) throw new Error(`“${text}” is not in anything fetched from “${source}” yet — fetch() it first`);
        }
        if (!collapse(src).includes(collapse(text))) throw missing();
        const lines = file ? findLines(src, text) : null;
        const id = addEvidence({ kind: 'source', summary: text, source, path: lines ? `${file}#L${lines.from}-L${lines.to}` : file });
        return JSON.stringify({ evidence: id });
      },
    },
    {
      name: 'propose',
      description: 'Finish onboarding: submit one project-level proposal and/or one per entity. Call exactly once.',
      input: z.object({
        rationale: z.string(),
        project: ProposalGroup.optional(),
        entities: z.record(z.string(), ProposalGroup).optional(),
      }),
      run: async (input: {
        rationale: string;
        project?: { ops: unknown[]; findings: unknown[] };
        entities?: Record<string, { ops: unknown[]; findings: unknown[] }>;
      }) => {
        const { rationale: r, project: projectIn, entities: entitiesIn } = input;
        const known = new Set(evidence.map((e) => e.id));
        if (!projectIn && !entitiesIn) throw new Error('propose needs at least a project or an entities group');
        const parsedProject = projectIn && parseGroup('project', projectIn.ops, projectIn.findings, known);
        const parsedEntities = Object.entries(entitiesIn ?? {}).map(([id, group]) => [id, parseGroup(`entity “${id}”`, group.ops, group.findings, known)] as const);
        // `by` and rule roles reference role ids — the project's, or ones this same proposal adds.
        const roles = [
          ...project.roles,
          ...(parsedProject?.ops ?? []).flatMap((op) => (op.kind === 'role' && op.op === 'add' ? [{ id: String(op.value.id), title: String(op.value.title ?? op.value.id) }] : [])),
        ];
        const badRoles = parsedEntities.flatMap(([id, group]) =>
          group.ops.flatMap((op, i) => {
            const problem = checkRoles(op, roles);
            return problem ? [`entity “${id}” op #${i}: ${problem}`] : [];
          }),
        );
        if (badRoles.length) throw new Error(badRoles.join('\n'));
        projectGroup = parsedProject;
        for (const [id, group] of parsedEntities) entityGroups.set(id, group);
        rationale = r;
        done = true;
        return 'proposal(s) recorded';
      },
    },
  ];

  try {
    await runAgent({
      runtime,
      system: system({
        sourceList: sources.map((s) => `${s.id} (${s.kind}, priority ${s.priority}): ${s.title}`).join('; '),
        contracts: project.contracts.map((c) => `${c.id} (${c.title})`),
        mode,
        usePriority: registry.usePriority,
      }),
      prompt: mode === 'review' ? 'Start the review: call model() and sources(), then check each element.' : `Start onboarding. Goal: ${spec.goal}`,
      tools,
      deliver: 'propose',
      script: mode === 'review' ? ws.path('agents/review.yaml') : spec.script ? ws.path(spec.script) : undefined,
      isDone: () => done,
      onLog: log,
      signal: opts.signal,
    });
  } finally {
    await mcp.close();
  }
  if (!done) throw new Error('The agent finished without an accepted proposal (propose was never called or was rejected)');

  const proposals: Proposal[] = [];
  const createdAt = new Date().toISOString();
  if (projectGroup) {
    const refs = new Set([...projectGroup.ops, ...projectGroup.findings].flatMap((x) => x.evidence));
    proposals.push(
      Proposal.parse({
        id: `${timestamp}-${mode === 'review' ? 'review' : spec.id}`,
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
        id: `${timestamp}-${mode === 'review' ? 'review' : spec.id}-${entityId}`,
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
