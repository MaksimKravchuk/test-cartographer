# Evaluating agents against a reference

`tc eval` measures how close a workspace's model comes to a reference description of the same product. It is how
prompt and skill changes are compared: run the same research on a fresh workspace with each version, then score both
against one reference.

```bash
pnpm tc --ws <workspace> eval <reference>            # names only, free
pnpm tc --ws <workspace> eval <reference> --judge claude --model sonnet --out report.md --json report.json
```

The model is what a person confirmed **plus every proposal, as if all were accepted** (rejected elements don't count):
the point is to score what the agents claim. The reference is either a YAML file in the format below or another
workspace directory, whose confirmed model is used (proposals ignored) — for example a hand-checked copy of the same
project.

## What it reports

For each category — subject, object, param, state, transition, action, rule:

- **recall**: reference items some model item matches, of all reference items; also over high-confidence items only;
- **precision**: model items that match a reference item, of all model items;
- **missing**: reference items nothing matched (high confidence first);
- **not in the reference**: model items that match nothing. Some are invented, some are things the reference lacks;
- **contradicted** (with `--judge`): model items a reference item contradicts.

A reference can be wrong or out of date. Treat a contradiction or an extra as something to review, not as an agent
error by definition.

## Matching

1. **Names.** Ids, titles, glossary entries and reference synonyms are split into words (`dueDate`, `due_date`,
   "Due date" are the same) and compared by overlap; one-word names also by spelling (`colour` / `color`). Each model
   item lands on its closest reference item, so an agent that splits one object in two isn't punished twice.
   Params, states, actions and rules are matched only inside matched objects. Actions compare verbs by meaning
   (add = create, edit = update) and ignore the object's own name ("Create task" in Task is "create").
2. **Transitions** match when a model transition joins states that match the reference's `from` and `to`; `*` is any
   state and `@new` is creation.
3. **Rules** are prose: names give a weak signal only. `--judge <provider>` sends what names left unmatched, per
   object, to an agent that pairs items stating the same thing and lists contradictions. Rule-like model items are
   rules, invariants, transition guards and effects, and rights notes on params.

## Reference format

```yaml
name: My product
subjects:
  - { id: member, names: [Signed-in user, owner], conf: high, area: identity }
objects:
  - id: task
    names: [Next step, tasks.tasks]       # synonyms: code, database, API, UI, docs
    conf: high                            # high | medium | low — how sure the reference is
    area: tasks                           # groups the "recall by area" table
    params: [{ id: due_date, names: [due], values: [] }]
    states: [{ id: inbox }, { id: completed, names: [Done] }]
    actions: [{ id: create, names: [Create task], by: [member] }]
    transitions:
      - { from: ['@new'], to: [inbox, next] }
      - { from: ['*'], to: [completed], action: complete }
    rules:
      - { text: A waiting task needs who it waits for, conf: high, where: 'src/tasks.rs:140' }
rules: []                                 # rules no single object owns
```

Keep references of private products out of this repository: pass a path outside it.
