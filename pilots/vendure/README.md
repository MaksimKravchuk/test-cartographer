# Pilot: Test Cartographer on a real shop (Vendure)

The demo shop was built for the tool: test ids on every button, test-only endpoints
that create an order in any state, and product docs written to disagree with the app
on purpose. This pilot points Cartographer at an app built by somebody else, with
the documentation a real team actually has — next to none.

- **System under test**: [Vendure](https://vendure.io) 3.7.3, stock config, its
  prebuilt Angular Admin UI, and the community Remix storefront. SQLite, no Docker.
- **Knowledge given to the tool**: the entity's name and how to read an order back.
  For onboarding only, a stale wiki page about the test stand and a 14-line Jira
  export of terse, half-empty tickets (`workspace/sources/`, in Russian, the way
  a real team would write them). No product docs, no API docs.
- **Ground truth**: `oracle/order.yaml`, derived from Vendure's source (the order
  state machine and the `@Allow` permissions of every admin mutation) and checked
  against the running stand. No agent can read it; `oracle/score.ts` scores
  proposals against it.

## Layout

```
app/          Vendure server, seed data (staff with three roles, a test buyer, two payment methods)
mcp/          the MCP adapter a QA team would have to write: create_order(state), get_order
workspace/    the Cartographer project: roles, entity, action library, sources, proposals, backlog
oracle/       ground truth and the scorer
results/      round-1 proposals, evidence and logs (round 2 lives in workspace/)
```

## Running it

```bash
./setup.sh                    # once: Vendure deps + database, storefront clone + build
./start.sh                    # Vendure on :3000 (admin at /admin), storefront on :4500, fresh seed
pnpm tc validate --ws pilots/vendure/workspace
pnpm tc explore manager-explorer --ws pilots/vendure/workspace     # live: Claude Code
pnpm tc run --ws pilots/vendure/workspace
node pilots/vendure/oracle/score.ts                                 # score workspace/proposals
node pilots/vendure/oracle/score.ts pilots/vendure/results/round-1/proposals
```

Roles: `manager` (order manager: Read/Create/Update/DeleteOrder), `support`
(ReadOrder only), `catalog` (no order permissions), `buyer`, `guest`.

## Results

Explorers ran live (Claude Code, Opus, effort high, 80 tool calls each) on an
entity with no states, actions or transitions at all.

### Round 1 — the explorer as it was

| run | states found (of 12) | real transitions | recall (edge × role) | findings |
|---|---|---|---|---|
| manager | 10 | 3, 0 wrong | 3 / 27 | 6 |
| support | 2 | — | — | 3 |
| buyer | 9 | 1, 0 wrong | 1 / 5 | 5 |
| onboarding (thin docs) | 6, by name only | 8, 0 wrong | 8 / 32 | 15 |

The agents reasoned well and the browser stopped them. Vendure's admin has no
test ids, its form inputs have `<label>`s not tied to them, and the menu with
Cancel / Refund & cancel / Modify / Manually transition opens from an icon-only
button. `click()` took a test id or a button/link name, and `fill()` took a test id
or a label, so the manager explorer couldn't fulfil, cancel or modify an order.
It reported each of these limits precisely. Support was signed out after its
first forbidden click and had no way back in.

### Round 2 — with element refs (this PR)

`snapshot()` now returns Playwright's AI snapshot with `[ref=…]` on every element,
and `click` / `fill` / `select` take a ref. Also new: `press`, `login` (sign in again
after the app signs you out), a short wait for the page to settle before a
snapshot, and creation modelled as a transition from `@new`.

| run | states found | real transitions | recall (edge × role) | findings |
|---|---|---|---|---|
| manager | 6 | 7, 0 wrong | 7 / 27 | 6 |
| support | 8 | — (verified every action is refused) | — | 3 |
| buyer | 9 | 3, 0 wrong | 3 / 5 | 7 |

All runs together, both rounds and onboarding: **11 of 12 states, 22 proposed
transitions, all 22 real, none with a wrong role; recall 14 / 32**. The manager
explorer went settle → fulfil → ship → deliver → refund & cancel, plus cancel and
modify, and then ran out of its 80 calls. What it missed is mostly the same
actions from more states (modify and refund & cancel from each shipping state),
partial shipping and draft orders. The one edge it proposed that wasn't in the
oracle, *Modifying → Payment authorized* ("Cancel modification"), turned out to be
real: the oracle was missing it.

### What the agents found in Vendure

All checked against the stand:

- **The admin ignores permissions in the UI.** Support (ReadOrder only) gets the
  same enabled Settle payment, Fulfill order, Cancel, Refund & cancel, Modify and
  Add note as the manager. The server refuses, and the admin then signs the user
  out. Found by support in both rounds. In round 2 it signed back in after each
  refusal and checked every action.
- A cancelled order whose payment was only authorized still offers **Settle
  payment**, and settling captures the money on a cancelled order with a $0 total.
- Cancelling leaves the authorization in place (payment stays `Authorized`).
  Refund & cancel of a delivered order leaves the refund `Pending` and the
  fulfillment `Delivered`.
- The manual-transition dialog offers *Cancelled* for a delivered order, and the
  server rejects it.
- **The storefront's checkout is broken** with this Vendure version: the shipping
  step renders no address or shipping-method form, so nobody can pay. The
  order-history "Actions for this order" button says *Not implemented*.

### Onboarding from what a team actually has

From 14 terse tickets and a stale wiki page, onboarding proposed 8 transitions,
all real, and did not invent anything else. It flagged both contradictions planted
in the sources: the wiki says *Paid* while a ticket says card payments are only
authorized, and the wiki says support does refunds while a ticket says it is
read-only. It also turned every empty ticket into a gap. It could not give its
states a `match`, because no source says what the app shows, so its model could
not be merged with the explorers'.

### From proposals to running tests

Proposals were decided through the engine's own API, the same path the GUI uses.
Duplicate states across explorers came up as clean conflicts, because the
explorers had named states after what `get_order` returns. The onboarding model
was rejected in favour of the observed one, and its backlog was kept.

What a person still had to do:

| step | effort |
|---|---|
| MCP adapter: reach any order state through the shop's own APIs, read it back | ~270 lines (`mcp/`) |
| entity skeleton: name, key, reader | 10 lines |
| review fixes: a read permit for the manager (no explorer proposed one, so the closed world denied it); support's read widened to every state; a create action split from "add more items"; setup recipes on states | 4 edits |
| action library: 14 actions over two UIs without test ids | ~290 lines |
| relink the Jira stories to the observed model | 5 stories |

The plan: **749 scenarios: 17 positive, 732 deny.**

- Positive: **16 / 17 pass**. The one failure is the storefront checkout defect above.
- Deny matrix: 732 scenarios, 29 minutes on 2 workers. `oracle/deny.ts` sorts them against the oracle:

  | result | count |
  |---|---|
  | passed: denied in the app as well | 629 |
  | **UI offers it and the role may really do it — the model is missing it** | 23 |
  | **UI offers it, the server refuses — the admin ignores permissions (support)** | 30 |
  | UI offers it, the oracle doesn't allow it | 11 |
  | failed before the check: another test moved the shared buyer cart on | 36 |
  | test timeout | 3 |

  So the deny matrix doubles as a recall check on the agents' model. Its 23 "missing" cells are exactly what the explorers didn't reach: refund & cancel, modify and fulfil from the other shipping states, and cancel at payment. It also found a rule nobody had modelled: Vendure's default `OrderByCodeAccessStrategy('2h')` lets anyone who is signed out open any order by its code for two hours, and the guest cells caught it. Of the 11 cells the oracle doesn't allow, 5 are the action library's fault: `available()` for "modify" checks only that "Manually transition to state..." is in the menu, not that Modifying is one of its options. The other 6 are real: settle on a cancelled order; cancel offered on a cart and a draft; the buyer's own cart shown on the confirmation page.

## What this says about Cartographer

Fixed in this PR:

1. **The explorer couldn't operate a real UI.** Added refs, `select`, `press`,
   `login`, a settle wait, and `@new` for creation (packages/engine/src/agents/explore.ts).
2. **Validation flagged rejected elements** (empty probes, missing runs) that
   nothing plans (packages/model/src/validate.ts).

Open, by impact:

1. **No path for an app without docs.** The explorer refuses an entity with no
   reader, and onboarding needs sources. Someone has to hand-write the entity and
   an MCP adapter before any agent runs. A UI-first onboarding — explore and
   propose the entities and the reader — would close the gap.
2. **The MCP adapter is the biggest integration cost.** Real apps have no
   "create an order in state X" endpoint, so the adapter drives real flows: guest
   checkout, a lock around the shared buyer cart, restocking the test variants
   once a run has bought them out. A setup helper generated from the GraphQL or
   OpenAPI schema would take most of this off the team.
3. **Deny means "the UI doesn't offer it", and that's half the story.** Vendure
   offers support the buttons and refuses on the server. The matrix can show that
   the UI offers it, but it can't separately state that the server refuses, which
   is the requirement. A deny check could also try the action through the API as
   that role.
4. **The deny matrix is mostly noise.** 732 of 749 scenarios are deny, and over
   half of them ask about an action of the other interface (can the catalog
   manager add to cart in a shipped order?). If an action named its interface, the
   matrix could skip those cells.
5. **One action, one `run`.** "View order" is a storefront page for the buyer and
   an admin page for support. Explorers of the two interfaces both called it
   `view-order`, which conflicts, and a reviewer can't rename an op on accept.
   `run` per interface, or namespaced ids, would fix it.
6. **The documented model and the observed model don't merge.** Onboarding's
   states have no `match`, so they can't be matched to observed ones. Rejecting
   them left every story linked to nothing until a person relinked them.
7. **80 calls is not enough for a back office.** Each action costs a snapshot, a
   click or two and a read. Split exploration by state group, or run several
   explorers per role.
8. **The explorer skips the obvious read permit** for its own role, and the
   closed world then denies the manager opening an order. Prompt for it, or warn
   when a role has transitions but no read permit.
9. **Shared accounts and parallel workers collide**, because the buyer has one
   cart. There is no per-role concurrency setting and no per-scenario account.
10. **The browser inherits the OS locale.** The Vendure admin crashed on
    `en-US@POSIX` in a container. Pin the locale per interface.

What worked as hoped:

- No invented behavior. Every proposed transition was real and every role
  assignment correct, from the explorers and from onboarding alike.
- Explorers converged on the same state ids through `match`, so deduplication was free.
- Secrets never leaked: no password appears in any evidence or proposal.
- Findings were specific and checkable, and found real defects in Vendure.
- The generated tests ran against a real app with no test ids. The 16 positive
  scenarios that should pass did.
