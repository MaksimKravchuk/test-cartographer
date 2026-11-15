// Research agent: reads the knowledge sources of a project (product docs,
// tracker exports, code folders, systems behind MCP) and proposes the model —
// roles, entities, their models — plus the backlog; in review mode it checks
// the existing model against them. Unlike the explorer it never touches a
// running app, and every operation must cite an exact quote from a source.
// How it works is in skills/ (see skills.ts); the prompt here is only the task.
import { z } from 'zod';
import { checkRoles, Finding, isFileSource, Op, Proposal, type Provenance, redactFields, resolveRuntime, type AgentSpec, type Evidence, type RuntimeOverride, type Workspace } from '@tc/model';
import { readFile, stat } from 'node:fs/promises';
import { listOf, runAgent, type Tool } from './runtime.ts';
import { McpPool } from '../mcp.ts';
import { codePath, insideCode, listCode, searchCode } from '../sources.ts';
import { skillsPrompt, skillTool } from './skills.ts';

export type OnboardOptions = {
  onLog?: (line: string) => void;
  provider?: 'scripted' | 'live';
  // This run only, on top of the agent's own runtime (Ask agent's run settings).
  runtime?: RuntimeOverride;
  signal?: AbortSignal;
  // onboard — propose a model from scratch (or add to a thin one);
  // review  — check every element of the existing model against the sources.
  // clarify — a person can't answer one finding: dig into it and replace it with answerable, single-topic ones.
  mode?: 'onboard' | 'review' | 'clarify';
  // clarify: the finding to dig into.
  target?: { proposal: string; index: number };
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
const Groups = z.object({ rationale: z.string(), project: ProposalGroup.optional(), entities: z.record(z.string(), ProposalGroup).optional() });
type GroupsIn = { rationale: string; project?: { ops: unknown[]; findings: unknown[] }; entities?: Record<string, { ops: unknown[]; findings: unknown[] }> };

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

type Mode = NonNullable<OnboardOptions['mode']>;
const MODE_GOAL: Record<Mode, string> = {
  onboard: 'read everything known about the product — docs, tracker exports, contracts, notes, the code, systems behind MCP — and propose its model plus the backlog.',
  review: 'review the model a person already has against everything known about the product, element by element and source by source, and propose what the model is missing.',
  clarify: `give a person enough context to answer one finding they could not answer as written (it is quoted in the
first message). Investigate it: read the sources it touches and find where it shows for a user — the screen, the API route
and the response field, the CLI command — and quote what you find. Then replace it with findings a person can answer
on the spot. When the sources settle a part on their own, say so in a finding (kind=confirmation, with the quote)
instead of asking. Keep the original finding's kind for contradictions and gaps, and its refs. Propose model changes
only when the investigation shows them. This is one small investigation: hand everything in with a single propose(),
in the original finding's group (project, or the same entity), without record().`,
};

// What a run needs every time goes into the prompt; the rest a skill links to
// and the agent reads with skill(). Reading skills follow the source kinds.
const skillsFor = (mode: Mode, kinds: { requirements: boolean; code: boolean }) => [
  ...(mode === 'clarify' ? [] : ['planning-investigation']),
  ...(mode === 'review' ? ['reviewing-model'] : []),
  ...(kinds.requirements ? ['reading-requirements'] : []),
  ...(kinds.code ? ['reading-code'] : []),
  'citing-evidence',
  'asking-questions',
  'proposing-model-changes',
  'proposing-model-changes/references/entity-elements.md',
  'proposing-model-changes/references/project-elements.md',
];

const system = (p: { sourceList: string; contracts: string[]; mode: Mode; usePriority: boolean; skills: string }) => `You are a research agent of Test Cartographer, where people and agents rebuild a product's specification
from its sources and derive tests from it. Your task: ${MODE_GOAL[p.mode]}

Nothing you propose changes the model directly: a person reviews every operation and finding and decides.
Your job is to make each one easy to check — about one thing, in the product's words, with its evidence.

Sources (id, kind, priority — 1 is the strongest): ${p.sourceList || 'none'}.
${p.usePriority ? 'When sources disagree, the lower priority number wins: requirements usually outrank code. Still report the disagreement.' : 'Priorities are off: report every disagreement and let the person decide.'}
How to read them: uploaded files — source({ id }); code folders — files({ source }), search({ source, pattern }) and
read({ source, path }); MCP sources — fetch({ source, args? }) (the tool and default args are set per source; you may pass other args).
${p.contracts.length ? `Available contracts: ${p.contracts.join(', ')}.` : ''}

${p.skills}`;

export async function onboard(ws: Workspace, agentId: string | undefined, opts: OnboardOptions = {}): Promise<Proposal[]> {
  const log = opts.onLog ?? (() => {});
  const project = await ws.project();
  const agent = agentId ? project.agents.find((a) => a.id === agentId) : project.agents.find((a) => a.kind === 'onboard');
  if (agentId && !agent) throw new Error(`Agent “${agentId}” is not defined in cartographer.yaml`);
  if (agent && agent.kind !== 'onboard') throw new Error(`Agent “${agent.id}” is not an onboarding agent (kind “${agent.kind}”)`);
  const spec = agent ?? DEFAULT_AGENT;

  const runtime = opts.provider === 'scripted' ? 'scripted' : resolveRuntime({ runtime: resolveRuntime(project, agent) }, { runtime: opts.runtime }) ?? 'scripted';

  const timestamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  // Onboarding reads uploaded files only; code and MCP sources come with the research agent.
  const mode = opts.mode ?? 'onboard';
  const registry = await ws.sourceRegistry();
  const sources = registry.sources.filter((s) => s.enabled);
  const mcp = new McpPool(project, ws.root);
  const { backlog: baseBacklog, revision: backlogRevision } = await ws.backlog();
  const existing = await ws.entityIds();

  const sourceOf = (id: string, kinds?: string[]) => {
    const s = sources.find((x) => x.id === id);
    if (!s) throw new Error(`Unknown source “${id}”. Available: ${sources.map((x) => x.id).join(', ')}`);
    if (kinds && !kinds.includes(isFileSource(s) ? 'file' : s.kind)) throw new Error(`Source “${id}” is a ${s.kind} source — use ${isFileSource(s) ? 'source()' : s.kind === 'code' ? 'files(), search() and read()' : 'fetch()'}`);
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

  let done = false;
  let batches = 0;
  const saved: Proposal[] = [];

  const parseGroup = (label: string, ops: unknown[], findings: unknown[], known: Set<string>) => {
    const parsedOps = z.array(Op).safeParse(ops);
    if (!parsedOps.success) throw new Error(`${label}: ops do not match the schema: ${z.prettifyError(parsedOps.error)}`);
    const parsedFindings = z.array(Finding).safeParse(findings);
    if (!parsedFindings.success) throw new Error(`${label}: findings do not match the schema: ${z.prettifyError(parsedFindings.error)}`);
    const unknown = [...parsedOps.data, ...parsedFindings.data].flatMap((x) => x.evidence).filter((id) => !known.has(id));
    if (unknown.length) throw new Error(`${label}: unknown evidence ${[...new Set(unknown)].join(', ')}. Available: ${[...known].join(', ')}`);
    return { ops: parsedOps.data, findings: parsedFindings.data };
  };

  type Group = { ops: Op[]; findings: Finding[] };
  type Checked = { rationale: string; project?: Group; entities: [string, Group][] };
  const check = ({ rationale, project: projectIn, entities: entitiesIn }: GroupsIn): Checked => {
    const known = new Set(evidence.map((e) => e.id));
    if (!projectIn && !entitiesIn) throw new Error('needs at least a project or an entities group');
    const parsedProject = projectIn && parseGroup('project', projectIn.ops, projectIn.findings, known);
    const parsedEntities = Object.entries(entitiesIn ?? {}).map(([id, group]) => [id, parseGroup(`entity “${id}”`, group.ops, group.findings, known)] as [string, Group]);
    // `by` and rule roles reference role ids — the project's, ones added earlier in this run, or ones this same call adds.
    const roles = [
      ...project.roles,
      ...[...saved.filter((p) => !p.entity).flatMap((p) => p.ops), ...(parsedProject?.ops ?? [])].flatMap((op) =>
        op.kind === 'role' && op.op === 'add' ? [{ id: String(op.value.id), title: String(op.value.title ?? op.value.id) }] : [],
      ),
    ];
    const badRoles = parsedEntities.flatMap(([id, group]) =>
      group.ops.flatMap((op, i) => {
        const problem = checkRoles(op, roles);
        return problem ? [`entity “${id}” op #${i}: ${problem}`] : [];
      }),
    );
    if (badRoles.length) throw new Error(badRoles.join('\n'));
    // An entity group must change an entity that exists or that an entity op adds (now or earlier in this run).
    const added = [...saved.filter((p) => !p.entity).flatMap((p) => p.ops), ...(parsedProject?.ops ?? [])].flatMap((op) => (op.kind === 'entity' && op.op === 'add' ? [String(op.value.id)] : []));
    const entityIds = new Set([...existing, ...added]);
    const strays = parsedEntities.map(([id]) => id).filter((id) => !entityIds.has(id));
    if (strays.length) throw new Error(`No entity ${strays.map((id) => `“${id}”`).join(', ')}: there are ${[...entityIds].join(', ') || 'none'}. Add a new one with an entity op in project.ops, or use an existing id.`);
    return { rationale, project: parsedProject, entities: parsedEntities };
  };

  // Writes one proposal per group straight away, so the Inbox shows it while
  // the agent works on. `batch` numbers a record() call; propose() has none.
  const tag = mode === 'onboard' ? spec.id : mode;
  const save = async ({ rationale, project: group, entities }: Checked, batch?: number): Promise<Proposal[]> => {
    const base = `${timestamp}-${tag}${batch ? `-${batch}` : ''}`;
    const createdAt = new Date().toISOString();
    const out: Proposal[] = [];
    const make = (g: Group, extra: Partial<Proposal> & { id: string; baseRevision: string }) => {
      const refs = new Set([...g.ops, ...g.findings].flatMap((x) => x.evidence));
      out.push(Proposal.parse({ agent: spec.id, createdAt, rationale, evidence: evidence.filter((e) => refs.has(e.id)), ops: g.ops, findings: g.findings, ...extra }));
    };
    if (group) make(group, { id: base, baseRevision: backlogRevision });
    // An entity group with nothing in it would only add an empty card to the Inbox.
    for (const [entityId, g] of entities.filter(([, g]) => g.ops.length || g.findings.length))
      make(g, { id: `${base}-${entityId}`, entity: entityId, baseRevision: (await ws.entityIds()).includes(entityId) ? (await ws.entity(entityId)).revision : 'new' });
    for (const p of out) await ws.saveProposal(p);
    saved.push(...out);
    return out;
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
      description: 'List the files of a code-folder source (what git tracks, or without git everything but node_modules, build output and .git; never .env files), optionally under a sub-folder (a path, not a glob).',
      input: z.object({ source: z.string(), dir: z.string().default('') }),
      run: async ({ source, dir }) => {
        const s = sourceOf(source, ['code']);
        const list = await listCode(codePath(ws.root, s.path!), undefined, dir);
        return list.length > 800 ? `${list.slice(0, 800).join('\n')}\n… ${list.length - 800} more — narrow with dir` : list.join('\n') || `no files under “${dir}”`;
      },
    },
    {
      name: 'search',
      description: 'Search a code-folder source with a regular expression (per line). Returns path:line: text and how many files were searched; then read() around a hit.',
      input: z.object({ source: z.string(), pattern: z.string(), dir: z.string().default(''), ignoreCase: z.boolean().default(false) }),
      run: async ({ source, pattern, dir, ignoreCase }) => searchCode(codePath(ws.root, sourceOf(source, ['code']).path!), pattern, { dir, ignoreCase }),
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
      description:
        'The current model: project roles/interfaces, an index of the entities, the backlog and open questions; model({ entity }) gives one entity in full. ' +
        'Secret field values show as their {{…}} reference.',
      input: z.object({ entity: z.string().optional() }),
      run: async ({ entity }) => {
        // Provenance is kept to who added it and which sources back it: proposal and evidence ids are most of an entity's size.
        const compact = (v: unknown): unknown =>
          Array.isArray(v) ? v.map(compact)
          : v && typeof v === 'object'
            ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === 'provenance' ? { source: (x as Provenance).source, sources: (x as Provenance).sources, seen: (x as Provenance).seen } : compact(x)]))
            : v;
        const entities = Object.fromEntries(redactFields('entities', Object.values(await ws.catalog()), process.env).map((e) => [e.id, compact(e)]));
        if (entity) {
          if (!entities[entity]) throw new Error(`No entity “${entity}”: there are ${Object.keys(entities).join(', ') || 'none'}`);
          return JSON.stringify(entities[entity]);
        }
        // One call per entity keeps every result readable: the whole Vikunja model was 68 KB and the runtime cut it to a preview.
        const proposals = await ws.proposals();
        return JSON.stringify({
          project: { roles: redactFields('roles', project.roles, process.env), interfaces: project.interfaces, glossary: project.glossary },
          entities: Object.values(entities).map((e: any) => ({ id: e.id, title: e.title, description: e.description, states: e.states.map((x: any) => x.id), actions: e.actions.map((x: any) => x.id), rules: e.rules.length })),
          backlog: baseBacklog,
          // What earlier runs left open: questions and gaps nobody has settled yet.
          openQuestions: proposals.flatMap((p) =>
            p.findings.flatMap((f, i) => (['gap', 'question', 'source'].includes(f.kind) && !p.resolutions.some((r) => r.finding === i) ? [{ kind: f.kind, refs: f.refs, note: f.note }] : [])),
          ),
          answers: proposals.flatMap((p) =>
            p.resolutions.flatMap((r) => {
              const f = p.findings[r.finding];
              return f && f.kind !== 'contradiction' && r.verdict !== 'clarified' ? [{ kind: f.kind, refs: f.refs, note: f.note, answer: r.verdict, ...(r.note ? { text: r.note } : {}) }] : [];
            }),
          ),
        });
      },
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
      name: 'record',
      description:
        'Save part of the result now, in the same shape as propose(): a person starts reviewing it while you go on. ' +
        'Call it each time you finish an entity or a batch of findings; never repeat what you already recorded.',
      input: Groups,
      run: async (input: GroupsIn) => {
        return `recorded ${(await save(check(input), ++batches)).map((p) => p.id).join(', ')} — go on, and call propose() at the end`;
      },
    },
    {
      name: 'propose',
      description: 'Finish: submit the rest of the result (what record() has not saved yet) — one project-level proposal and/or one per entity. Call exactly once.',
      input: Groups,
      run: async (input: GroupsIn) => {
        // Everything may already be recorded; then propose only closes the run.
        const empty = !input.project && !input.entities;
        // The closing rationale says what the run covered; with everything recorded already it is saved nowhere else.
        log(`💬 ${input.rationale}`);
        if (!(empty && batches)) await save(check(input));
        done = true;
        return 'proposal(s) recorded';
      },
    },
  ];

  const skills = skillsFor(mode, { requirements: sources.some((s) => s.kind !== 'code'), code: sources.some((s) => s.kind === 'code') });
  tools.push(skillTool(skills.filter((s) => !s.includes('/'))));

  // clarify: the finding a person couldn't answer, with its quotes, is the agent's whole brief.
  let brief = '';
  const target = mode === 'clarify' ? opts.target : undefined;
  if (mode === 'clarify') {
    if (!target) throw new Error('clarify needs the finding to dig into');
    const original = await ws.proposal(target.proposal);
    const f = original.findings[target.index];
    if (!f) throw new Error(`No finding #${target.index} in proposal “${target.proposal}”`);
    const quotes = f.evidence.flatMap((id) => original.evidence.filter((e) => e.id === id)).map((e) => `- ${e.source ?? 'app'}${e.path ? ` (${e.path})` : ''}: “${e.summary}”`);
    brief = [
      `A person can't answer this ${f.kind} as written and asked for more context.`,
      `Group: ${original.entity ? `entities.${original.entity}` : 'project'}. Refs: ${f.refs.join(', ') || 'none'}.`,
      `Finding: ${f.note}`,
      quotes.length ? `Its evidence:\n${quotes.join('\n')}` : 'It has no evidence.',
      'Call model() and sources(), investigate, then propose() the findings that replace it.',
    ].filter(Boolean).join('\n');
  }

  try {
    await runAgent({
      runtime,
      system: system({
        sourceList: sources.map((s) => `${s.id} (${s.kind}, priority ${s.priority}): ${s.title}`).join('; '),
        contracts: project.contracts.map((c) => `${c.id} (${c.title})`),
        mode,
        usePriority: registry.usePriority,
        skills: skillsPrompt(skills, tools.map((t) => t.name)),
      }),
      prompt: mode === 'review' ? 'Start the review: call model() and sources(), then check each element.' : mode === 'clarify' ? brief : `Start onboarding. Goal: ${spec.goal}`,
      tools,
      deliver: 'propose',
      script: mode !== 'onboard' ? ws.path(`agents/${mode}.yaml`) : spec.script ? ws.path(spec.script) : undefined,
      isDone: () => done,
      onLog: log,
      signal: opts.signal,
    });
  } finally {
    await mcp.close();
  }
  if (!done) throw new Error('The agent finished without an accepted proposal (propose was never called or was rejected)');

  // The original leaves the queue once something replaces it; with nothing new it stays open,
  // and an answer a person gave while the agent worked stands.
  const replacements = saved.reduce((n, p) => n + p.findings.length + p.ops.length, 0);
  const original = target && replacements ? await ws.proposal(target.proposal) : undefined;
  if (target && original && !original.resolutions.some((r) => r.finding === target.index)) {
    const note = `More context: ${saved.map((p) => p.id).join(', ')}`;
    const rest = original.resolutions.filter((r) => r.finding !== target.index);
    await ws.saveProposal({ ...original, resolutions: [...rest, { finding: target.index, verdict: 'clarified', note, at: new Date().toISOString() }] });
  }

  return saved;
}
