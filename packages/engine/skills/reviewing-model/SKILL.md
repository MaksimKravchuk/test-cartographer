---
name: reviewing-model
description: Checks an existing model element by element against every source and reports confirmations, contradictions, things not found, and behavior the sources have but the model lacks. Use in a review run, when a person already has a model and wants to know how well the sources support it.
metadata:
  tools: "model sources record"
---

# Reviewing a model

A review fills a table: one row per model element, one column per source. Each cell ends up as
"says the same", "says otherwise" or "looked, found nothing". The value is in the cells that disagree —
above all where the requirements and the code part ways, because that is either a bug or an outdated
document — and in an honest "not found" instead of a blank.

## Workflow

1. Call `model()`, then `model({ entity })` for each entity it lists. The rows are every role, state,
   action, transition, permit, rule, invariant and parameter.
2. Call `sources()`. The columns are the enabled sources.
3. Work entity by entity. For each element, look in each source and add one finding per cell (below).
4. While you are in a source, note behavior it describes that the model does not have. Propose it as new
   elements. If it comes only from code, it is behavior, not a requirement: add a finding (kind=gap) saying
   which requirement sources you searched.
5. Hand in each entity with `record()` as soon as it is done, so the table fills while the person watches.

## One finding per cell

| The source… | Finding | Must carry |
|---|---|---|
| says the same as the model | kind=confirmation | the element in `refs`, the quote as evidence |
| says something else | kind=contradiction | the element in `refs`, a quote from every side, and in the note which side wins by priority and why |
| was searched and has nothing | kind=gap | the source ids in `searched`, the files or queries in the note |

`refs` name the element as `<kind>:<entity>.<id>` — `rule:order.cancel-window`, `action:order.cancel`.
Keep a confirmation's note to a few words; the quote speaks for itself.

## Judgment calls

- **A disagreement is a finding, not a fix.** Do not update the model to match a source; the person decides
  which side is right.
- **An element with status "planned"** is required but not built yet. Code that lacks it is not a contradiction.
- **Partial support** — the source confirms the action but not its condition — is a confirmation for the
  action and a gap for the rule, not one vague finding.
- **Every element gets its cells.** A review that covers the easy half looks complete and is not; what you
  could not reach goes into the "Not reached:" finding.
