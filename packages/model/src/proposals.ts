import {
  elementCollections,
  elementSchemas,
  Entity,
  type Decision,
  type ElementKind,
  type Op,
  type Proposal,
} from './schema.ts';

export type Conflict = { op: number; message: string };

type AnyElement = { id: string; status: string; provenance?: unknown };

function collection(entity: Entity, kind: ElementKind): AnyElement[] {
  return entity[elementCollections[kind]] as AnyElement[];
}

// Checks whether an operation can be applied to the current model. The proposal
// was created against baseRevision; if the model has changed since then, only
// operations that actually broke count as conflicts.
export function checkOp(entity: Entity, op: Op): string | null {
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

export function conflicts(entity: Entity, proposal: Proposal): Conflict[] {
  return proposal.ops.flatMap((op, i) => {
    const message = checkOp(entity, op);
    return message ? [{ op: i, message }] : [];
  });
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
    const problem = checkOp(next, op);
    if (problem) throw new Error(`Operation #${d.op}: ${problem}`);
    if (d.verdict === 'reject' && op.op !== 'add') continue;

    const list = collection(next, op.kind);
    const provenance = {
      source: 'agent' as const,
      agent: proposal.agent,
      proposal: proposal.id,
      evidence: op.evidence,
      ...(d.note ? { note: d.note } : {}),
    };
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
