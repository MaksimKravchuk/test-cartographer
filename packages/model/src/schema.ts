import { z } from 'zod';

const Id = z.string().regex(/^[a-z][a-z0-9_-]*$/, 'id: lowercase Latin letters, digits, _ and -');

// ── Epistemic status ────────────────────────────────────────────────────
// observed  — the behavior was seen, but it has not been declared a requirement
// proposed  — proposed by an agent, no human decision yet
// confirmed — a person confirmed it: this is a requirement, tests are built from it
// rejected  — a person rejected it; kept so agents don't propose it again
// planned   — a requirement that isn't built yet: no tests, and code that lacks it isn't a bug
export const Status = z.enum(['observed', 'proposed', 'confirmed', 'rejected', 'planned']);
export type Status = z.infer<typeof Status>;

export const Provenance = z.object({
  source: z.enum(['human', 'agent']),
  agent: z.string().optional(),
  proposal: z.string().optional(),
  evidence: z.array(z.string()).default([]),
  // Knowledge sources (workspace/sources.yaml) that back this element, from the
  // proposal's `source` evidence — set when applying a decision.
  sources: z.array(z.string()).default([]),
  // The app showed it: an explorer read the entity back after acting and saw the effect.
  seen: z.boolean().optional(),
  note: z.string().optional(),
});
export type Provenance = z.infer<typeof Provenance>;

const meta = {
  status: Status.default('confirmed'),
  provenance: Provenance.optional(),
};

// A named value a person attaches to a subject or an object: an account's
// login and password, a test card number, a tenant id. Agents get fields as
// context and can type them into the app; tests reach them as
// {{roles.<id>.<field>}} / {{entities.<id>.<field>}} (see data.ts).
// `value` may use {{env.NAME}}. A secret is never shown to a model: the agent
// sees only its {{…}} reference, and the engine substitutes the value itself.
export const Field = z.object({
  id: Id, // the key in references: {{roles.seller.password}}
  value: z.string().default(''),
  secret: z.boolean().default(false),
  note: z.string().optional(), // what the value is for, in any language — told to agents as is
});
export type Field = z.infer<typeof Field>;

// ── Project ─────────────────────────────────────────────────────────────
export const Interface = z.object({
  id: Id,
  title: z.string(),
  baseUrl: z.string().url(),
});
export type Interface = z.infer<typeof Interface>;

export const Role = z.object({
  id: Id,
  title: z.string(),
  // human  — a person acting through an interface;
  // system — background jobs, schedulers, integrations: acts only through
  //          actions with `invoke` (a tool from mcp.*.allow.trigger).
  kind: z.enum(['human', 'system']).default('human'),
  interface: Id.optional(), // required for a human role (validateProject)
  // How the role signs in: an action from the library, run once per browser
  // context before the role acts. No login — the role acts as a guest.
  // Values in args may use {{env.NAME}} so test passwords stay out of the file.
  login: z
    .object({
      action: z.string(),
      args: z.record(z.string(), z.string()).default({}),
    })
    .optional(),
  // The role's own data: its account's login and password, a customer number…
  // login.args can refer to them as {{roles.<id>.<field>}}.
  fields: z.array(Field).default([]),
});
export type Role = z.infer<typeof Role>;

export const McpServer = z.object({
  command: z.string(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  cwd: z.string().optional(),
  // Allowed tools. The engine will not call anything that isn't on the list.
  allow: z.object({
    prepare: z.array(z.string()).default([]),
    read: z.array(z.string()).default([]),
    // Tools that make the system act: run a background job, advance a test clock.
    trigger: z.array(z.string()).default([]),
  }),
});
export type McpServer = z.infer<typeof McpServer>;

// Agents don't call model APIs directly: they run inside a coding agent the
// user is already signed in to — Claude Code (Claude subscription), Codex
// (ChatGPT), GitHub Copilot or Cursor — which reaches our tools over MCP.
export const AgentProvider = z.enum(['claude', 'codex', 'copilot', 'cursor']);
export type AgentProvider = z.infer<typeof AgentProvider>;
export const Effort = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
export type Effort = z.infer<typeof Effort>;
// Runtimes whose subagents stay on our tools. Cursor's and Copilot's bring their own (files, shell).
export const SUBAGENTS: AgentProvider[] = ['claude', 'codex'];

export const Runtime = z.object({
  provider: AgentProvider,
  // Omitted: whatever the agent defaults to (its own settings).
  model: z.string().optional(),
  effort: Effort.optional(),
  // Tool calls per run.
  maxSteps: z.number().int().positive().default(60),
  // Let the agent hand parts of the work to subagents of its own (Claude Code
  // and Codex). They share the run's tools and its step budget.
  subagents: z.boolean().optional(),
  // Codex only: an OpenAI-compatible endpoint (Responses API) serving any
  // model, such as an open-weight one in Ollama, LM Studio or vLLM, in place
  // of a ChatGPT subscription.
  baseUrl: z.string().url().optional(),
});
export type Runtime = z.infer<typeof Runtime>;

// Per-agent override of the project runtime. A model only carries over while
// the provider stays the same — model names don't transfer between providers.
export const RuntimeOverride = z.object({
  provider: AgentProvider.optional(),
  model: z.string().optional(),
  effort: Effort.optional(),
  maxSteps: z.number().int().positive().optional(),
  subagents: z.boolean().optional(),
});
export type RuntimeOverride = z.infer<typeof RuntimeOverride>;

// What one agent run used, as its runtime reports it: a running total, sent
// again as it grows. The engine logs it as `📊 <json>` and the Agent tab reads the last one.
export type AgentUsage = {
  model?: string;
  // Input counts every prompt token, cached ones included; cacheRead/cacheWrite are parts of it.
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  // API-price equivalent in USD — subscriptions don't bill per token. `estimated`:
  // the runtime gave no cost, so it comes from the genai-prices table.
  costUsd?: number;
  estimated?: boolean;
  // GitHub Copilot bills premium requests instead.
  premiumRequests?: number;
  // How full the context window is now, when the runtime says.
  context?: { used: number; window?: number };
  seconds?: number;
};

export const AgentSpec = z.object({
  id: Id,
  title: z.string(),
  // explore — works in a role's interface against one entity; onboard — reads
  // knowledge sources and proposes the whole SOAR map plus the backlog.
  kind: z.enum(['explore', 'onboard']).default('explore'),
  // Required for `explore` (validateProject); an onboard agent isn't tied to a role or entity.
  role: Id.optional(),
  entity: Id.optional(),
  goal: z.string(),
  // Script for a deterministic (scripted) run: path from the workspace root.
  script: z.string().optional(),
  runtime: RuntimeOverride.optional(),
});

// Contracts available to agents: OpenAPI, GraphQL schemas, documentation.
export const Contract = z.object({
  id: Id,
  title: z.string(),
  url: z.string().url(),
});
export type Contract = z.infer<typeof Contract>;
export type AgentSpec = z.infer<typeof AgentSpec>;

// A project word and what it means, so people and agents name things the same way.
// ref: what it is in the model, as `entity` or `kind:entity.id` (e.g. `action:order.cancel`).
export const Term = z.object({
  term: z.string().min(1),
  definition: z.string().min(1),
  synonyms: z.array(z.string()).default([]),
  ref: z.string().optional(),
});
export type Term = z.infer<typeof Term>;

export const Project = z.object({
  name: z.string(),
  interfaces: z.array(Interface).min(1),
  roles: z.array(Role).min(1),
  mcp: z.record(Id, McpServer).default({}),
  contracts: z.array(Contract).default([]),
  // Default runtime for agents; without one (and no per-agent override) agents
  // can only run scripted.
  runtime: Runtime.optional(),
  agents: z.array(AgentSpec).default([]),
  glossary: z.array(Term).default([]),
});
export type Project = z.infer<typeof Project>;

// The runtime an agent actually runs with: its override on top of the project
// default. Undefined when neither names a provider.
export function resolveRuntime(project: Pick<Project, 'runtime'>, agent?: Pick<AgentSpec, 'runtime'>): Runtime | undefined {
  const base = project.runtime;
  const o = agent?.runtime ?? {};
  const provider = o.provider ?? base?.provider;
  if (!provider) return undefined;
  return {
    provider,
    model: o.model ?? (provider === base?.provider ? base.model : undefined),
    effort: o.effort ?? base?.effort,
    maxSteps: o.maxSteps ?? base?.maxSteps ?? 60,
    subagents: o.subagents ?? base?.subagents,
    baseUrl: provider === base?.provider ? base.baseUrl : undefined,
  };
}

// ── Entity model ────────────────────────────────────────────────────────
// Pseudo-state “before the instance exists”. A transition from NEW creates
// the instance; its action returns the new key.
export const NEW = '@new';
const StateRef = z.union([Id, z.literal(NEW)]);
export const ToolCall = z.object({
  tool: z.string().regex(/^[a-z][a-z0-9_-]*\.[A-Za-z0-9_-]+$/, 'tool: "<server>.<tool>"'),
  args: z.record(z.string(), z.unknown()).default({}),
});
export type ToolCall = z.infer<typeof ToolCall>;

export const Variant = z.object({
  id: Id,
  title: z.string(),
  description: z.string().optional(),
  ...meta,
});
export type Variant = z.infer<typeof Variant>;

// How to reach a state:
//   tool — call an allowed setup tool and take the entity key from the result;
//   path — reach state `from`, then walk the `via` transitions.
// If there is no explicit recipe, the engine looks for the shortest path through confirmed transitions.
export const Setup = z.discriminatedUnion('kind', [
  ToolCall.extend({
    kind: z.literal('tool'),
    key: z.string().default('id'),
  }),
  z.object({
    kind: z.literal('path'),
    from: Id,
    via: z.array(Id).min(1),
  }),
]);
export type Setup = z.infer<typeof Setup>;

export const State = z.object({
  id: Id,
  title: z.string(),
  description: z.string().optional(),
  initial: z.boolean().optional(),
  terminal: z.boolean().optional(),
  variants: z.array(Id).optional(), // no field — applies to all variants
  // Probe: the entity.reader result must contain these field values.
  match: z.record(z.string(), z.unknown()),
  setup: z.array(Setup).default([]),
  ...meta,
});
export type State = z.infer<typeof State>;

export const Effect = z.object({
  description: z.string(),
  // A verifiable effect: a field of the reader result after the transition.
  // Without field — a manual check, included in the scenario as a checklist item.
  field: z.string().optional(),
  equals: z.unknown().optional(),
  // With relation — the field is read from the related instance instead.
  relation: Id.optional(),
  // A numeric change relative to the value right before the transition.
  delta: z.number().optional(),
  variants: z.array(Id).optional(),
});
export type Effect = z.infer<typeof Effect>;

export const ActionKind = z.enum(['create', 'read', 'update', 'command', 'delete']);
export type ActionKind = z.infer<typeof ActionKind>;

// A verb subjects apply to the entity. It says nothing about states or
// permissions: transitions and permits say who may use it and what it does.
export const Action = z.object({
  id: Id,
  title: z.string(),
  description: z.string().optional(),
  kind: ActionKind.default('command'),
  // How a person performs it: an entry of the action library (workspace/actions).
  run: z.string().optional(),
  // How a test makes the system perform it: an allowed trigger tool.
  // {{key}}, {{variant}}, {{runTag}}, {{rel.<id>}} are available in args.
  invoke: ToolCall.optional(),
  // What makes the system do it in the product: a schedule, a timeout, an event. Documentation only.
  trigger: z.string().optional(),
  // Who performs it, as a person declared it; transitions and permits add their own `by`.
  by: z.array(Id).optional(),
  ...meta,
});
// NOTE: no .refine() (zod 4 refuses to .extend refined objects). "run or invoke" is a validator warning.
export type Action = z.infer<typeof Action>;

export const Transition = z.object({
  id: Id,
  title: z.string(),
  from: StateRef,
  to: Id,
  action: Id, // entity.actions[].id (was: action-library name)
  by: z.array(Id).min(1), // roles that may perform it (was: role: Id)
  guards: z.array(z.string()).default([]),
  variants: z.array(Id).optional(),
  effects: z.array(Effect).default([]),
  ...meta,
});
export type Transition = z.infer<typeof Transition>;

// Permission for an action that leaves the state as it is: `by` may perform
// `action` in `states` (absent — every state of the variant). Effects are checked after it.
export const Permit = z.object({
  id: Id,
  title: z.string(),
  action: Id,
  by: z.array(Id).min(1),
  states: z.array(Id).optional(),
  variants: z.array(Id).optional(),
  effects: z.array(Effect).default([]),
  ...meta,
});
export type Permit = z.infer<typeof Permit>;

// A condition a business rule puts on a transition.
//   authenticated — only a signed-in actor may perform it;
//   roles         — only these roles may perform it;
//   entity-state  — the related instance (through a relation) must be in one
//                   of the given states.
export const Condition = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('authenticated') }),
  z.object({ kind: z.literal('roles'), roles: z.array(Id).min(1) }),
  z.object({ kind: z.literal('entity-state'), relation: Id, states: z.array(Id).min(1) }),
]);
export type Condition = z.infer<typeof Condition>;

// A business rule in the product's own words, tied to the transition it
// constrains. Each condition yields negative scenarios: the transition must
// be unavailable when the condition doesn't hold.
// A rule may also be plain knowledge: text tied to an action, with no
// transition or conditions yet — it documents the product and produces no
// scenario until someone formalizes it.
export const Rule = z.object({
  id: Id,
  title: z.string(),
  text: z.string(),
  action: Id.optional(), // entity.actions[].id the rule belongs to
  transition: Id.optional(),
  requires: z.array(Condition).default([]),
  variants: z.array(Id).optional(),
  ...meta,
});
export type Rule = z.infer<typeof Rule>;

// What always holds for the object, whatever happened before: "a shipped
// order is always paid for". `holds` (reader field values) makes it checkable:
// every test checks it each time the instance is read in one of `states`
// (all states when omitted). Without `holds` it is knowledge for the spec.
export const Invariant = z.object({
  id: Id,
  title: z.string(),
  text: z.string(),
  states: z.array(Id).optional(),
  variants: z.array(Id).optional(),
  holds: z.record(z.string(), z.unknown()).optional(),
  ...meta,
});
export type Invariant = z.infer<typeof Invariant>;

// A reference to another entity. `field` holds the related key in this
// entity's reader result. `requires` is the state the related instance must be
// in when this one is created; setup prepares it first and passes its key as
// {{rel.<id>}} to setup tools and as ctx.related.<id> to actions.
// `variants` maps this entity's variants to the related entity's variants.
export const Relation = z.object({
  id: Id,
  title: z.string().optional(),
  entity: Id,
  field: z.string(),
  requires: Id.optional(),
  variants: z.record(Id, Id).optional(),
  // reference — this entity holds the related one's key and needs it to exist (an order and its listing).
  // part-of   — this entity lives inside the related one (a line item inside an order): the objects
  //             map draws it within the parent's card. An entity is part of at most one parent.
  kind: z.enum(['reference', 'part-of']).default('reference'),
});
export type Relation = z.infer<typeof Relation>;

// An authored scenario: a path through the lifecycle that matters as a whole,
// for example the full happy path of an order. Generated scenarios cover each
// transition on its own; journeys cover how transitions chain together.
export const Journey = z.object({
  id: Id,
  title: z.string(),
  description: z.string().optional(),
  variants: z.array(Id).optional(), // absent — every variant the path applies to
  start: StateRef, // state the instance is prepared in (@new — the path creates it)
  path: z.array(Id).min(1), // transition ids, in order
  tags: z.array(z.string()).default([]),
  ...meta,
});
export type Journey = z.infer<typeof Journey>;

export const Entity = z.object({
  id: Id,
  title: z.string(),
  description: z.string().optional(),
  // Correlation key: identifies the same object across all interfaces.
  key: z.string().default('id'),
  // How to read an instance's actual state. {{key}} is available in args.
  // Optional: an onboarding agent may propose an entity before anyone knows how
  // to read it back. Without a reader nothing can be verified — every scenario
  // of the entity plans as blocked (see plan.ts) and validateEntity warns.
  reader: ToolCall.optional(),
  variants: z.array(Variant).min(1),
  states: z.array(State).default([]),
  actions: z.array(Action).default([]),
  transitions: z.array(Transition).default([]),
  permits: z.array(Permit).default([]),
  scenarios: z.array(Journey).default([]),
  rules: z.array(Rule).default([]),
  invariants: z.array(Invariant).default([]),
  relations: z.array(Relation).default([]),
  // Data a person attached to the object for agents and tests: a test card
  // number, a promo code, an existing instance to start from.
  fields: z.array(Field).default([]),
});
export type Entity = z.infer<typeof Entity>;

export type ElementKind = 'variant' | 'state' | 'action' | 'transition' | 'permit' | 'scenario' | 'rule' | 'invariant';
export const elementCollections = {
  variant: 'variants',
  state: 'states',
  action: 'actions',
  transition: 'transitions',
  permit: 'permits',
  scenario: 'scenarios',
  rule: 'rules',
  invariant: 'invariants',
} as const satisfies Record<ElementKind, keyof Entity>;

export const elementSchemas = { variant: Variant, state: State, action: Action, transition: Transition, permit: Permit, scenario: Journey, rule: Rule, invariant: Invariant };

// ── Knowledge sources ── workspace/sources.yaml + files in workspace/sources/
// doc / backlog / contract / note — an uploaded text file in workspace/sources/
//   (backlog = a tracker export);
// code — a folder on disk with the product's source code (`path`);
// mcp  — a system reached through an MCP server of cartographer.yaml, such as
//   Confluence or Jira; `read` is an allowed read tool that proves access.
export const FILE_SOURCE_KINDS = ['doc', 'backlog', 'contract', 'note'] as const;
export type FileSourceKind = (typeof FILE_SOURCE_KINDS)[number];
export const SourceKind = z.enum([...FILE_SOURCE_KINDS, 'code', 'mcp']);
export type SourceKind = z.infer<typeof SourceKind>;
export const isFileSource = (s: { kind: SourceKind }) => (FILE_SOURCE_KINDS as readonly string[]).includes(s.kind);
export const Source = z
  .object({
    id: Id,
    title: z.string(),
    kind: SourceKind.default('doc'),
    file: z.string().optional(), // file name inside workspace/sources/ (file kinds)
    path: z.string().optional(), // folder, absolute or relative to the workspace (code)
    read: ToolCall.optional(), // access probe (mcp)
    // Who wins when sources disagree: 1 is the strongest. Requirements default
    // to 1, code to 2. Equal numbers — no winner, a person decides.
    priority: z.number().int().min(1).default(1),
    // A disabled source stays listed but no agent reads it.
    enabled: z.boolean().default(true),
    addedAt: z.string(), // ISO
    note: z.string().optional(),
  })
  .superRefine((s, ctx) => {
    const need = isFileSource(s) ? 'file' : s.kind === 'code' ? 'path' : 'read';
    if (s[need] === undefined) ctx.addIssue({ code: 'custom', path: [need], message: `a ${s.kind} source needs \`${need}\`` });
  });
export type Source = z.infer<typeof Source>;
export const SourceRegistry = z.object({
  // false — priorities are ignored: every disagreement goes to a person.
  usePriority: z.boolean().default(true),
  sources: z.array(Source).default([]),
});
export type SourceRegistry = z.infer<typeof SourceRegistry>;

// ── Backlog ── workspace/backlog.yaml (absent file = empty backlog)
// "<entity>.<action>"
export const ActionRef = z.string().regex(/^[a-z][a-z0-9_-]*\.[a-z][a-z0-9_-]*$/, 'action ref: "<entity>.<action>"');
// "<kind>:<entity>.<id>"
export const ElementRef = z.string().regex(
  /^(action|transition|permit|rule|journey):[a-z][a-z0-9_-]*\.[a-z][a-z0-9_-]*$/,
  'element ref: "<action|transition|permit|rule|journey>:<entity>.<id>"',
);

export const Epic = z.object({
  id: Id,
  title: z.string(),
  description: z.string().optional(),
  key: z.string().optional(), // tracker key, e.g. SHOP-1
  url: z.string().optional(),
  ...meta,
});
export type Epic = z.infer<typeof Epic>;

export const Feature = z.object({
  id: Id,
  title: z.string(),
  description: z.string().optional(),
  epic: Id.optional(),
  key: z.string().optional(),
  url: z.string().optional(),
  actions: z.array(ActionRef).default([]), // the slice of the model this feature is about
  ...meta,
});
export type Feature = z.infer<typeof Feature>;

export const Story = z.object({
  id: Id,
  title: z.string(),
  text: z.string().optional(), // "As a … I want … so that …"
  acceptance: z.array(z.string()).default([]), // acceptance criteria, in the product's words
  feature: Id.optional(),
  epic: Id.optional(), // a story sits under a feature, or directly under an epic
  key: z.string().optional(),
  url: z.string().optional(),
  trackerStatus: z.string().optional(), // "Done", "To Do" … as the tracker says
  covers: z.array(ElementRef).default([]), // model elements this story specifies
  ...meta,
});
export type Story = z.infer<typeof Story>;

export const Backlog = z.object({
  epics: z.array(Epic).default([]),
  features: z.array(Feature).default([]),
  stories: z.array(Story).default([]),
});
export type Backlog = z.infer<typeof Backlog>;

// A new entity as proposed at the project level: just enough to create
// entities/<id>.yaml. Accepting fills in default variants and empty element lists.
export const EntityCreate = z.object({
  id: Id,
  title: z.string(),
  description: z.string().optional(),
  key: z.string().default('id'),
  reader: ToolCall.optional(),
  variants: z.array(Variant).optional(),
});
export type EntityCreate = z.infer<typeof EntityCreate>;

// ── Agent proposals ─────────────────────────────────────────────────────
export const Evidence = z.object({
  id: z.string(),
  kind: z.enum(['screenshot', 'snapshot', 'network', 'contract', 'probe', 'note', 'source']),
  summary: z.string(), // for a `source` evidence: the exact quote
  path: z.string().optional(), // for a `source` evidence, may hold "<file>#L<from>-L<to>"
  url: z.string().optional(),
  source: z.string().optional(), // for a `source` evidence: the knowledge source id
});
export type Evidence = z.infer<typeof Evidence>;

// Entity-level op kinds patch an entity's own collections (unchanged).
export const ElementOpKind = z.enum(['variant', 'state', 'action', 'transition', 'permit', 'scenario', 'rule', 'invariant']);
// Project-level op kinds patch the project or the backlog — a proposal with no
// `entity` (see Proposal below) is a project-level proposal.
export const ProjectOpKind = z.enum(['role', 'interface', 'entity', 'epic', 'feature', 'story']);
// One flat enum rather than a union of the two: an agent sees a single list of
// kinds in the tool's JSON Schema, and a wrong kind gets "expected one of …".
const Kind = z.enum([...ElementOpKind.options, ...ProjectOpKind.options]);

export const Op = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add'), kind: Kind, value: z.record(z.string(), z.unknown()), evidence: z.array(z.string()).default([]) }),
  z.object({ op: z.literal('update'), kind: Kind, id: Id, set: z.record(z.string(), z.unknown()), evidence: z.array(z.string()).default([]) }),
  z.object({ op: z.literal('remove'), kind: Kind, id: Id, evidence: z.array(z.string()).default([]) }),
]);
export type Op = z.infer<typeof Op>;

export const Finding = z.object({
  // confirmation — a source says the same as the model: it fills the review matrix, it isn't a to-do.
  kind: z.enum(['gap', 'contradiction', 'question', 'confirmation']),
  note: z.string(),
  refs: z.array(z.string()).default([]),
  evidence: z.array(z.string()).default([]),
  // For a "not found" gap: the sources searched without finding it.
  searched: z.array(z.string()).optional(),
});
export type Finding = z.infer<typeof Finding>;

export const Decision = z.object({
  op: z.number().int().nonnegative(),
  // accept  — accept as a requirement (confirmed)
  // observe — record as observed behavior, but not a requirement
  // reject  — reject
  verdict: z.enum(['accept', 'observe', 'reject', 'plan']),
  note: z.string().optional(),
});
export type Decision = z.infer<typeof Decision>;

export const Resolution = z.object({
  finding: z.number().int().nonnegative(),
  verdict: z.enum(['bug', 'outdated', 'fine']),
  note: z.string().optional(),
  at: z.string(),
});
export type Resolution = z.infer<typeof Resolution>;

export const Proposal = z.object({
  id: z.string(),
  entity: Id.optional(), // absent — a project-level proposal (role/interface/entity/epic/feature/story)
  agent: z.string(),
  role: Id.optional(),
  createdAt: z.string(),
  baseRevision: z.string(),
  rationale: z.string(),
  evidence: z.array(Evidence).default([]),
  ops: z.array(Op).default([]),
  findings: z.array(Finding).default([]),
  status: z.enum(['pending', 'decided']).default('pending'),
  decisions: z.array(Decision).default([]),
  decidedAt: z.string().optional(),
  // A person's answer to a finding (by index), from the Disagreements page:
  // bug — the product is wrong, the stronger source stands; outdated — the
  // stronger source is out of date; fine — not a problem.
  resolutions: z.array(Resolution).default([]),
});
export type Proposal = z.infer<typeof Proposal>;

// ── Run results ─────────────────────────────────────────────────────────
export const ScenarioResult = z.object({
  status: z.enum(['passed', 'failed', 'skipped', 'blocked']),
  durationMs: z.number().default(0),
  at: z.string(),
  error: z.string().optional(),
  trace: z.string().optional(),
});
export type ScenarioResult = z.infer<typeof ScenarioResult>;

export const RunReport = z.object({
  id: z.string(),
  startedAt: z.string(),
  finishedAt: z.string(),
  results: z.record(z.string(), ScenarioResult),
});
export type RunReport = z.infer<typeof RunReport>;
