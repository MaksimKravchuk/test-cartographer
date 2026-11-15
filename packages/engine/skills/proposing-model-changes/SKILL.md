---
name: proposing-model-changes
description: Turns findings into proposed operations on the Test Cartographer model - roles, entities, parameters, states, actions, transitions, permits, rules, invariants and backlog items - in the exact shapes the engine accepts, and hands them in with record and propose. Use whenever adding, updating or removing a model element.
metadata:
  tools: "model record propose"
---

# Proposing model changes

The model describes a product as subjects, objects, actions and rules: **roles** (human or system),
**entities** with variants, parameters and states, **actions**, **transitions** (who may move an entity
from state to state), **permits** (who may act without changing state), **rules** (conditions on an action
or transition) and **invariants** (what always holds). Tests are generated from it, so a vague or invented
element becomes a wrong test.

Nothing you propose changes the model directly. A person reviews each operation and accepts it, keeps it
as observed behavior, or rejects it.

## Before proposing

1. Call `model()`, then `model({ entity })` for each entity you will touch.
2. Do not propose what is already there. A field that differs is `op: update`, never a second `op: add`.
3. Name things with the words in the model's glossary: a synonym listed there is the same thing as its term.
4. New ids are Latin, lowercase, kebab-case, and say what the element is (`cancel-after-payment`).
5. An element belongs to an entity that exists. To describe a new entity, add it with an `entity` operation
   first; the engine refuses operations on an entity that is neither in the model nor added in this run.

## A good operation

- **One element per operation**, with its own evidence.
- **Behavior a user or tester can see**, in the product's words: "a buyer can cancel until payment" — never
  a function, table or flag.
- **Checkable wording.** A rule that says "usually" or "may" cannot become a test.
- **Nothing invented.** If no source says it and you did not see it, it is not an element. Report what you
  looked for as a finding instead.
- **A state's `match`** names a field and value only when you know what the app shows for that state.
  Otherwise leave `match: {}` and ask where the state can be observed.

## Shapes

For `op: add` the `value` must have the shape of its kind; the engine stores what it is given.
Entity-level kinds are in [references/entity-elements.md](references/entity-elements.md), project-level
kinds and the backlog in [references/project-elements.md](references/project-elements.md).

```
{ op: "add",    kind, value: { …shape… }, evidence: [ids] }
{ op: "update", kind, id, set: { fields }, evidence: [ids] }
{ op: "remove", kind, id, evidence: [ids] }        entities cannot be removed
```

## Handing in

1. Each time an entity or a batch of findings is done, call `record()` with it. The person starts reviewing
   while you continue, and finished work survives if the run is cut short.
2. Never send the same operation or finding twice.
3. Call `propose()` exactly once, at the end, with whatever is left — or with the rationale alone when
   `record()` already has everything.
4. If the engine rejects a call, read its message, fix that part and send it again.

The rationale says in a few sentences what was covered and how, and ends with the status of each question
from the plan.
