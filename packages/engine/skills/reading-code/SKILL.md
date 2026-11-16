---
name: reading-code
description: Recovers product behavior from source code - entry points, entities and their parameters, lifecycle states, who may do what, and the conditions on each action - while leaving implementation details out. Use when a run has a code-folder source, to find what the product actually does and compare it with what the requirements say.
metadata:
  tools: "files outline search read quote declare skill"
---

# Reading code

Code shows how the product works; the model records what it does and why that matters to its users. The
work is mostly filtering. Reading code is also inference, not observation: you conclude what would happen,
you have not seen it happen. A rule found only in code is therefore behavior, not a requirement — propose
it, and say so in a finding (kind=gap) that names where you looked for a requirement.

## Workflow

1. **Map.** `files({ source })` for the top of the tree. Name the framework and where routes, domain logic and
   data models live. Skip tests, generated files, vendored code and assets.
2. **Find the entry points** with `search()` rather than reading file after file. Entry points are not only
   HTTP routes: scheduled jobs, queue consumers and webhooks are actions of a system role. Patterns for common
   frameworks are in [references/entry-points.md](references/entry-points.md).
3. **Find the entities.** `outline({ source, path })` on the domain and model folders lists every type with its
   fields and every enum with its variants in one call: start there, then `read()` only what needs a closer look.
   Data models, migrations and API schemas give entities and their parameters. Keep every parameter a
   user or a client can see — in a screen, an API response, an export — including the ones the system sets
   (`created_at`, `completed_at`): tests check them. Leave out storage internals nobody sees.
   An enum of commands or events lists the operations: each variant a user can trigger is an action.
   Once a type is an entity, `declare({ entity, source, path, type, as: "attributes" })` proposes all its fields
   in one call, and `as: "states"` its status enum's variants; name internals in `skip`. Then spend your calls on
   what only reading shows: types of links and enums, who may change what, the rules.
4. **Trace each action** — entity by entity, every entity on the map, not only the first few — from its
   entry point to the data it changes. One action per operation a user or client can call: a route, an MCP
   tool, a CLI command, a button, reads too (list, get, search, export); don't fold several into one. Trace
   it with `read()` around the hits. Note who may call it, what is checked first, and what changes.
5. **Consolidate**, then quote. One action is often checked in three places (a handler checks the state, a
   model checks expiry, a service checks stock): that is one rule with three conditions, not three rules.

## Is it part of the model?

Ask of every detail:

- **Would it be in the requirements if the product were rebuilt?** If not, it is legacy or plumbing. If it is
  a workaround, the need behind it may still be real: note the need, leave the workaround out.
- **Would a product owner care?** A link that expires after 7 days matters. A 32-byte token does not.
- **Could it be swapped without changing the product?** Then it is implementation.

The user's view settles hard cases: a "Sign in with Google" button is behavior, Google as a hidden backend
is not. One payment provider is implementation; three the user chooses between are variants.

## What code structures mean

| In the code | In the model |
|---|---|
| Status enum, or its values in conditions | States; the enum is a lifecycle attribute |
| Nullable timestamps or flags (`paid_at`, `cancelled_at`, `is_archived`) | Hidden states — name them |
| Guard clause before a change (`if order.status != 'new': raise`) | A condition of the rule on that transition |
| Role or permission check | `by` on the transition, permit or attribute |
| Class-level validator, database constraint (`balance >= 0`) | An invariant |
| Foreign key (`customer_id`) | A link attribute to that entity |
| Scheduled job, queue consumer, webhook | An action of a system role |
| Several implementations behind one interface, chosen by the user | Variants |

## Leave out, or report instead

- **Plumbing:** token formats, caches, retries, logging, dependency wiring, how an external service is called.
  "Notify the buyer" is the behavior; the HTTP call that sends the email is not. What a user can see of
  access is behavior, not plumbing: signing in and out, a session that expires or is revoked everywhere, an
  invite needed to sign up, a code that must be entered within 10 minutes.
- **Dead code.** Before proposing behavior from a function, `search()` for what calls it. Unreachable code
  stays out of the model; mention it in a finding only if it looks like an unfinished feature.
- **Bugs and loose ends** — an empty catch, a TODO that states a business rule, commented-out logic, a
  partial success with no rollback. The model describes intended behavior, so these become findings, not
  elements: a question when intent is unclear, a contradiction when a source says otherwise.

## Quoting code

Quote the line that decides the behavior — the condition, not the function signature — with
`quote({ source, path, text })`.
