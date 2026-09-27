import { z } from 'zod';

const Id = z.string().regex(/^[a-z][a-z0-9_-]*$/, 'id: lowercase Latin letters, digits, _ and -');

// ── Epistemic status ────────────────────────────────────────────────────
// observed  — the behavior was seen, but it has not been declared a requirement
// proposed  — proposed by an agent, no human decision yet
// confirmed — a person confirmed it: this is a requirement, tests are built from it
// rejected  — a person rejected it; kept so agents don't propose it again
export const Status = z.enum(['observed', 'proposed', 'confirmed', 'rejected']);
export type Status = z.infer<typeof Status>;

export const Provenance = z.object({
  source: z.enum(['human', 'agent']),
  agent: z.string().optional(),
  proposal: z.string().optional(),
  evidence: z.array(z.string()).default([]),
  note: z.string().optional(),
});
export type Provenance = z.infer<typeof Provenance>;

const meta = {
  status: Status.default('confirmed'),
  provenance: Provenance.optional(),
};

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

export const Inference = z.object({
  provider: z.enum(['anthropic', 'openai-compatible', 'scripted']),
  model: z.string(),
  baseUrl: z.string().optional(),
  apiKeyEnv: z.string().optional(),
  maxSteps: z.number().int().positive().default(40),
  // Server-side fallback to another model on refusal (Claude API only).
  fallbacks: z.boolean().default(false),
});
export type Inference = z.infer<typeof Inference>;

export const AgentSpec = z.object({
  id: Id,
  title: z.string(),
  role: Id,
  entity: Id,
  goal: z.string(),
  // Script for a deterministic run (provider=scripted): path from the workspace root.
  script: z.string().optional(),
});

// Contracts available to agents: OpenAPI, GraphQL schemas, documentation.
export const Contract = z.object({
  id: Id,
  title: z.string(),
  url: z.string().url(),
});
export type Contract = z.infer<typeof Contract>;
export type AgentSpec = z.infer<typeof AgentSpec>;

export const Project = z.object({
  name: z.string(),
  interfaces: z.array(Interface).min(1),
  roles: z.array(Role).min(1),
  mcp: z.record(Id, McpServer).default({}),
  contracts: z.array(Contract).default([]),
  inference: Inference.optional(),
  agents: z.array(AgentSpec).default([]),
});
export type Project = z.infer<typeof Project>;

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
export const Rule = z.object({
  id: Id,
  title: z.string(),
  text: z.string(),
  transition: Id,
  requires: z.array(Condition).min(1),
  variants: z.array(Id).optional(),
  ...meta,
});
export type Rule = z.infer<typeof Rule>;

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
  reader: ToolCall,
  variants: z.array(Variant).min(1),
  states: z.array(State).default([]),
  actions: z.array(Action).default([]),
  transitions: z.array(Transition).default([]),
  permits: z.array(Permit).default([]),
  scenarios: z.array(Journey).default([]),
  rules: z.array(Rule).default([]),
  relations: z.array(Relation).default([]),
});
export type Entity = z.infer<typeof Entity>;

export type ElementKind = 'variant' | 'state' | 'action' | 'transition' | 'permit' | 'scenario' | 'rule';
export const elementCollections = {
  variant: 'variants',
  state: 'states',
  action: 'actions',
  transition: 'transitions',
  permit: 'permits',
  scenario: 'scenarios',
  rule: 'rules',
} as const satisfies Record<ElementKind, keyof Entity>;

export const elementSchemas = { variant: Variant, state: State, action: Action, transition: Transition, permit: Permit, scenario: Journey, rule: Rule };

// ── Agent proposals ─────────────────────────────────────────────────────
export const Evidence = z.object({
  id: z.string(),
  kind: z.enum(['screenshot', 'snapshot', 'network', 'contract', 'probe', 'note']),
  summary: z.string(),
  path: z.string().optional(),
  url: z.string().optional(),
});
export type Evidence = z.infer<typeof Evidence>;

const Kind = z.enum(['variant', 'state', 'action', 'transition', 'permit', 'scenario', 'rule']);

export const Op = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add'), kind: Kind, value: z.record(z.string(), z.unknown()), evidence: z.array(z.string()).default([]) }),
  z.object({ op: z.literal('update'), kind: Kind, id: Id, set: z.record(z.string(), z.unknown()), evidence: z.array(z.string()).default([]) }),
  z.object({ op: z.literal('remove'), kind: Kind, id: Id, evidence: z.array(z.string()).default([]) }),
]);
export type Op = z.infer<typeof Op>;

export const Finding = z.object({
  kind: z.enum(['gap', 'contradiction', 'question']),
  note: z.string(),
  refs: z.array(z.string()).default([]),
  evidence: z.array(z.string()).default([]),
});
export type Finding = z.infer<typeof Finding>;

export const Decision = z.object({
  op: z.number().int().nonnegative(),
  // accept  — accept as a requirement (confirmed)
  // observe — record as observed behavior, but not a requirement
  // reject  — reject
  verdict: z.enum(['accept', 'observe', 'reject']),
  note: z.string().optional(),
});
export type Decision = z.infer<typeof Decision>;

export const Proposal = z.object({
  id: z.string(),
  entity: Id,
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
