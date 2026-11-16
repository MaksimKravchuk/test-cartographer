---
name: asking-questions
description: Writes questions for the person who reviews the model - one decision per question, readable without the run's context, with what is known, what is missing and the likely answers. Use before adding any finding of kind question, and when deciding whether something is a question, a gap or a contradiction.
metadata:
  tools: "model"
---

# Asking questions

A question lands in an inbox among dozens of others and is read hours later by someone who did not watch
the run. It costs their attention and leaves an element unsettled until they answer. So ask few, and make
each one answerable in a single reply.

## Before asking

Try to answer it yourself from the sources. Ask only what a person alone can settle:

- whether observed behavior is intended;
- which of two readings of a requirement is meant;
- knowledge that is in no source (where a state can be observed, which term is the main one).

Other things that feel like questions have their own kind:

| Situation | Kind | Say |
|---|---|---|
| You tried to check something and could not | gap | what you tried and what stopped you |
| You searched and found nothing | gap | where you searched (`searched`) |
| Two sources say different things | contradiction | each side, quoted |
| A source cannot be read or looks incomplete (an empty page, a folder its README describes but with no files) | source | what you tried — it is a problem with the inputs, not the product |

`model()` lists open questions from earlier runs. Try to answer each from the sources, and do not ask
again one that is still open: report its status in the rationale instead. `model().answers` holds what a
person has already answered: take those as given and do not ask them again.

## Form

- **One question per finding.** If the note needs "and also", it is two findings.
- **`refs` name the element** it is about, as `<kind>:<entity>.<id>` — `rule:order.cancel-window`,
  `state:project.archived`.
- **The note is three short parts:** what is known (with evidence) and where it shows for a user (screen,
  API field, command), what is missing, then the question, last.
- **`options` hold the likely answers** when yes or no does not fit: up to 6 short ones. The person picks
  one or answers in their own words.
- **Two names for one thing** (the docs say Location, the code says place): ask with
  `synonym: { term: "<the model's word>", synonym: "<the other word>" }`. A yes files it in the glossary.

## Examples

**Bundled — hard to answer:**

```
note: Neither entity has a reader yet, so no state can be verified by reading the object back. The five
  help pages describe the web UI only and give no field names a tester could assert on. Where should a
  project or task be read back from — the web app or the API? Also it is unclear whether a restored
  task keeps its done state.
```

**Split into one gap and two questions:**

```
kind: gap
refs: ["entity:task"]
note: No task state could be verified: the entity has no reader, and the help pages name no fields.

kind: question
refs: ["entity:task"]
note: The help pages describe tasks only through the web UI (e4). Where should a test read a task's
  state back from?
options: ["The web app", "The API"]

kind: question
refs: ["transition:task.restore"]
note: The trash page says a restored task "goes into the done bucket if the task is done" (e9); no page
  says it outright. Does a restored task keep its done state: yes or no?
```

**Observed behavior that may be a bug:**

```
kind: question
refs: ["action:project.duplicate"]
note: The menu hides Duplicate for an archived project, but the page opens by its address and the copy is
  created (e12, e13). Is duplicating an archived project intended?
options: ["Intended", "A bug: refuse it like Edit"]
```
