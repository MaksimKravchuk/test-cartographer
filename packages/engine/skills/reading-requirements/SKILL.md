---
name: reading-requirements
description: Extracts roles, entities, states, actions, rules and backlog items from requirement sources - product docs, wiki pages, tracker exports, contracts, notes, MCP systems such as Confluence or Jira. Use when a run has uploaded-file or MCP sources, to turn what the product should do into model elements.
metadata:
  tools: "model sources source fetch"
---

# Reading requirements

Documents and tracker items state intent: what the product is supposed to do. That makes them the strongest
ground for calling something a requirement, and the weakest for claiming the product really behaves that way.

## Workflow

1. Call `sources()` and note each source's size. Read a file with `source({ id, offset, limit })` page by page;
   call an MCP source with `fetch({ source, args? })` and ask for less when a result comes back truncated.
2. On the first pass through a source, collect its vocabulary: who acts (roles), what they act on (entities),
   the words for an entity's condition ("draft", "paid", "archived" — states), the verbs (actions).
3. On the second pass, collect what constrains those verbs: who may, in which state, on what condition, with
   what limit or deadline, and what must always hold.
4. Map tracker items to the model last, once the elements they talk about exist.

## What to extract

- **A rule in the product's words, in a form a tester can check.** Prefer these shapes:
  "When <trigger>, <the product> <response>", "While <state>, <the product> <behavior>",
  "If <condition>, then <response>". Words such as "usually", "may" or "as needed" cannot be tested: if
  the source uses them, quote it and ask what the exact condition is.
- **Numbers and deadlines exactly as written** — "within 14 days", "up to 5 items". They are the cheapest
  rules to test and the easiest to lose.
- **What is always true** ("a shipped order is always paid for") as an invariant, not as a rule on one transition.
- **Planned behavior.** A story that is not done describes something required but not built. Keep its tracker
  status; it is still part of the model, and code that lacks it is not a contradiction.

## Judgment calls

- **One thing, two names.** Different documents often name the same thing differently ("request", "ticket").
  Use the term from `model().glossary`. If two names look like one thing and the glossary is silent, ask
  (a question with `synonym`) instead of creating two entities.
- **A sentence that reads two ways** is a question for the person, not a guess.
- **Silence is not a requirement.** If no source says it, it is not one — however sensible it seems.
- **A story that fits no element yet** keeps its `covers` empty or partial, with a finding (kind=gap) saying
  which behavior is missing. Never point a story at an element that does not exist.
