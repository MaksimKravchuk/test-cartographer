import {
  Backlog,
  elementCollections,
  elementSchemas,
  Entity,
  EntityCreate,
  Epic,
  Feature,
  Interface,
  Project,
  Role,
  Story,
  type Decision,
  type ElementKind,
  type Op,
  type Proposal,
} from './schema.ts';

export type Conflict = { op: number; message: string };

type AnyElement = { id: string; status: string; provenance?: unknown };

// State a project-level proposal applies against: the project, the backlog,
// and the ids of entities that already exist (an onboarding proposal may
// reference an entity it is itself proposing to create).
export type ProjectState = { project: Project; backlog: Backlog; entityIds: string[] };

const elementKinds = new Set<string>(Object.keys(elementCollections));
function isElementKind(kind: string): kind is ElementKind {
  return elementKinds.has(kind);
}

function isProjectState(x: Entity | ProjectState): x is ProjectState {
  return 'entityIds' in x;
}

function collection(entity: Entity, kind: ElementKind): AnyElement[] {
  return entity[elementCollections[kind]] as AnyElement[];
}

const projectLists = {
  role: (s: ProjectState) => s.project.roles as { id: string }[],
  interface: (s: ProjectState) => s.project.interfaces as { id: string }[],
  epic: (s: ProjectState) => s.backlog.epics as { id: string }[],
  feature: (s: ProjectState) => s.backlog.features as { id: string }[],
  story: (s: ProjectState) => s.backlog.stories as { id: string }[],
} as const;

function checkEntityOp(entity: Entity, op: Op): string | null {
  if (!isElementKind(op.kind)) return `“${op.kind}” is not an entity-level operation`;
  const list = collection(entity, op.kind);
  if (op.op === 'add') {
    const id = op.value.id;
    if (typeof id !== 'string') return 'The added element has no id';
    if (list.some((x) => x.id === id)) return `“${id}” already exists in the model`;
    return null;
  }
  if (!list.some((x) => x.id === op.id)) return `“${op.id}” is not in the model`;
  return null;
}

function checkProjectOp(state: ProjectState, op: Op): string | null {
  if (isElementKind(op.kind)) return `“${op.kind}” is not a project-level operation`;
  if (op.kind === 'entity') {
    if (op.op === 'remove') return "Entities can't be removed through a proposal";
    const known = new Set(state.entityIds);
    if (op.op === 'add') {
      const id = op.value.id;
      if (typeof id !== 'string') return 'The added element has no id';
      return known.has(id) ? `“${id}” already exists in the model` : null;
    }
    return known.has(op.id) ? null : `“${op.id}” is not in the model`;
  }
  const list = projectLists[op.kind](state);
  if (op.op === 'add') {
    const id = op.value.id;
    if (typeof id !== 'string') return 'The added element has no id';
    return list.some((x) => x.id === id) ? `“${id}” already exists in the model` : null;
  }
  return list.some((x) => x.id === op.id) ? null : `“${op.id}” is not in the model`;
}

// Checks whether an operation can be applied to the current model. The proposal
// was created against baseRevision; if the model has changed since then, only
// operations that actually broke count as conflicts.
export function checkOp(entity: Entity, op: Op): string | null;
export function checkOp(state: ProjectState, op: Op): string | null;
export function checkOp(target: Entity | ProjectState, op: Op): string | null {
  return isProjectState(target) ? checkProjectOp(target, op) : checkEntityOp(target, op);
}

export function conflicts(entity: Entity | undefined, proposal: Proposal): Conflict[];
export function conflicts(state: ProjectState, proposal: Proposal): Conflict[];
export function conflicts(target: Entity | ProjectState | undefined, proposal: Proposal): Conflict[] {
  // An entity-level proposal for an entity that doesn't exist yet (still only a
  // project-level proposal to create it) — every op is blocked the same way.
  if (!target) {
    const message = `Entity “${proposal.entity}” doesn't exist yet — accept it in the project proposal first`;
    return proposal.ops.map((_, i) => ({ op: i, message }));
  }
  return proposal.ops.flatMap((op, i) => {
    const message = isProjectState(target) ? checkProjectOp(target, op) : checkEntityOp(target, op);
    return message ? [{ op: i, message }] : [];
  });
}

// provenance.sources: the ids of knowledge sources behind the op's `source`
// evidence — how a reviewer sees which document backed a proposed element.
function buildProvenance(proposal: Proposal, evidenceIds: string[], note?: string) {
  const sources = evidenceIds
    .map((id) => proposal.evidence.find((e) => e.id === id))
    .filter((e): e is NonNullable<typeof e> => !!e && e.kind === 'source' && !!e.source)
    .map((e) => e.source!);
  return {
    source: 'agent' as const,
    agent: proposal.agent,
    proposal: proposal.id,
    evidence: evidenceIds,
    sources: [...new Set(sources)],
    ...(note ? { note } : {}),
  };
}

// Applies a person's decisions to the model and returns the new model.
// accept  → the element becomes a requirement (confirmed);
// observe → the element is recorded as observed behavior (observed);
// reject  → for add, the element is kept as rejected so agents don't propose it again.
export function applyDecisions(entity: Entity, proposal: Proposal, decisions: Decision[]): Entity {
  const next: Entity = structuredClone(entity);
  for (const d of decisions) {
    const op = proposal.ops[d.op];
    if (!op) throw new Error(`No operation #${d.op}`);
    const problem = checkEntityOp(next, op);
    if (problem) throw new Error(`Operation #${d.op}: ${problem}`);
    if (d.verdict === 'reject' && op.op !== 'add') continue;
    // checkEntityOp above already rejected a non-element kind — this guard only narrows the type.
    if (!isElementKind(op.kind)) throw new Error(`Operation #${d.op}: not an entity-level operation`);

    const list = collection(next, op.kind);
    const provenance = buildProvenance(proposal, op.evidence, d.note);
    const status = d.verdict === 'accept' ? 'confirmed' : d.verdict === 'observe' ? 'observed' : 'rejected';

    if (op.op === 'add') {
      const parsed = elementSchemas[op.kind].parse({ ...op.value, status, provenance });
      list.push(parsed as AnyElement);
    } else if (op.op === 'update') {
      const i = list.findIndex((x) => x.id === op.id);
      const merged = { ...list[i], ...op.set, provenance };
      // A change accepted as an “observation” does not raise the element's status.
      if (d.verdict === 'observe') merged.status = 'observed';
      list[i] = elementSchemas[op.kind].parse(merged) as AnyElement;
    } else {
      const i = list.findIndex((x) => x.id === op.id);
      if (d.verdict === 'accept') list.splice(i, 1);
      else list[i] = { ...list[i], status: 'observed', provenance };
    }
  }
  return Entity.parse(next);
}

// Applies the project-level ops — role/interface/entity/epic/feature/story,
// see ProjectOpKind in schema.ts. `entity` creation is returned separately
// (`created`): the entity itself doesn't live in `project` or `backlog`, so
// the caller writes its file.
export function applyProjectDecisions(
  state: ProjectState,
  proposal: Proposal,
  decisions: Decision[],
): { project: Project; backlog: Backlog; created: Entity[] } {
  const project: Project = structuredClone(state.project);
  const backlog: Backlog = structuredClone(state.backlog);
  const created: Entity[] = [];

  const applySimple = <T extends { id: string }>(list: T[], schema: { parse: (v: unknown) => T }, op: Op, verdict: Decision['verdict'], index: number, label: string) => {
    if (verdict === 'observe') throw new Error(`Operation #${index}: "observe" is not a valid verdict for a ${label}`);
    if (verdict === 'reject') return;
    if (op.op === 'add') list.push(schema.parse(op.value));
    else if (op.op === 'update') {
      const i = list.findIndex((x) => x.id === op.id);
      list[i] = schema.parse({ ...list[i], ...op.set });
    } else {
      const i = list.findIndex((x) => x.id === op.id);
      list.splice(i, 1);
    }
  };

  for (const d of decisions) {
    const op = proposal.ops[d.op];
    if (!op) throw new Error(`No operation #${d.op}`);
    const problem = checkProjectOp({ project, backlog, entityIds: state.entityIds }, op);
    if (problem) throw new Error(`Operation #${d.op}: ${problem}`);

    if (op.kind === 'role') applySimple(project.roles, Role, op, d.verdict, d.op, 'role');
    else if (op.kind === 'interface') applySimple(project.interfaces, Interface, op, d.verdict, d.op, 'interface');
    else if (op.kind === 'entity') {
      if (d.verdict === 'observe') throw new Error(`Operation #${d.op}: "observe" is not a valid verdict for an entity`);
      if (op.op === 'remove') throw new Error(`Operation #${d.op}: entities can't be removed through a proposal`);
      if (d.verdict === 'reject') continue;
      if (op.op === 'add') {
        const input = EntityCreate.parse(op.value);
        created.push(
          Entity.parse({
            id: input.id,
            title: input.title,
            description: input.description,
            key: input.key,
            reader: input.reader,
            variants: input.variants?.length ? input.variants : [{ id: 'default', title: 'Default' }],
          }),
        );
      }
      // `update` on an entity that already exists changes its top-level fields
      // (title, description, key, reader) — the caller loads and saves that
      // entity file itself, the same way it applies any other entity change.
    } else {
      // epic / feature / story follow the same accept/observe/reject rules as entity elements.
      const listKey = op.kind === 'epic' ? 'epics' : op.kind === 'feature' ? 'features' : 'stories';
      const schema = op.kind === 'epic' ? Epic : op.kind === 'feature' ? Feature : Story;
      const list = backlog[listKey] as AnyElement[];
      if (d.verdict === 'reject' && op.op !== 'add') continue;
      const provenance = buildProvenance(proposal, op.evidence, d.note);
      const status = d.verdict === 'accept' ? 'confirmed' : d.verdict === 'observe' ? 'observed' : 'rejected';
      if (op.op === 'add') {
        list.push(schema.parse({ ...op.value, status, provenance }) as AnyElement);
      } else if (op.op === 'update') {
        const i = list.findIndex((x) => x.id === op.id);
        const merged = { ...list[i], ...op.set, provenance };
        if (d.verdict === 'observe') merged.status = 'observed';
        list[i] = schema.parse(merged) as AnyElement;
      } else {
        const i = list.findIndex((x) => x.id === op.id);
        if (d.verdict === 'accept') list.splice(i, 1);
        else list[i] = { ...list[i], status: 'observed', provenance };
      }
    }
  }
  return { project: Project.parse(project), backlog: Backlog.parse(backlog), created };
}
