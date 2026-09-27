# Test Cartographer

A local macOS app where a person and AI agents explore a web application together, rebuild a model of how it behaves, and turn the confirmed model into Playwright tests.

## Quick start

```bash
pnpm install
pnpm exec playwright install chromium   # once
pnpm demo                               # demo shop on :4400 (the app under exploration)
pnpm tc serve                           # engine on :4317
pnpm ui                                 # GUI in the browser on :5173
```

As a native window: `pnpm app` (builds the GUI and launches Electron; the engine starts automatically).

Engine CLI — `pnpm tc <command>`:

| Command | What it does |
|---|---|
| `validate` | reference integrity, tool allowlist, action library coverage, state reachability |
| `plan` | coverage plan: one scenario per confirmed transition and permit, plus one per denied cell of the access matrix, for each role and variant |
| `compile` | generates `workspace/generated/*.spec.ts` |
| `run [--grep]` | compiles, runs, and writes a report to `workspace/runs/`; the GUI can also run one scenario or one entity |
| `coverage` | transition × variant matrix from the latest results |
| `export md` | scenarios to `workspace/export/*.md` |
| `explore <agent> [--scripted]` | an agent explores its role's interface and writes a proposal |

## Projects, entities, scenarios

The app is organized as **project → entities → scenarios**.

- **Project** — a workspace folder with `cartographer.yaml`. The app remembers recent projects (`~/.test-cartographer/projects.json`), opens existing ones and creates new ones from a template with a guest and a signed-in role. A project anywhere on disk gets a link to the engine in its own `node_modules`, so its generated tests and action library resolve `@tc/engine`.
- **Entities** — one file each in `entities/`: an order, a quota, a user account. The Overview shows the catalog with the size of each model and how its tests stand. Removing an entity moves its files to `entities/.trash`.
- **Scenarios** of an entity come in four kinds:
  - **generated** from the model: one per confirmed transition and one per permit, for each role that may perform it and each variant;
  - **deny** — the closed world's negative matrix: for every human role, action and state not allowed by a confirmed transition or permit, a scenario asserts the action stays unavailable. A cell only an `observed`/`proposed` element allows is left undecided, not planned;
  - **journeys** written by people: a path of transitions checked end to end, for example an order from placement to delivery;
  - **business rules** in the product's own words, tied to a transition. A `roles` or `authenticated` condition produces no scenario of its own — it tags the deny scenarios it excludes, for traceability; an `entity-state` condition (“the related instance must be in state X”) still gets its own scenario per other reachable state of the related instance.

**Relations** link entities: `relations: [{ id: listing, entity: listing, field: listingId, requires: published, variants: { standard: physical } }]` on the order means an order refers to a listing through `listingId`, is created for a published listing, and a standard order goes with a physical listing. From that:

- **Setup dependencies.** Before preparing an order in any state, the engine prepares the related listing in the required state — with the listing's own setup tool or transitions — and passes its key to setup tools as `{{rel.listing}}` and to actions as `ctx.related.listing`.
- **Effects on related instances.** `{ relation: listing, field: stock, delta: -1 }` on a transition reads the listing right before the act and checks the change after it; `equals` checks an exact value.
- **Rules on a related state.** `{ kind: entity-state, relation: listing, states: [published] }` yields one negative scenario per other reachable state of the listing: the related instance is prepared in that state and the transition must be unavailable.

**Creating an instance** is a transition from `@new`. Its action creates the instance through the UI and returns the new key, so a state can be reached without a setup tool.

**Roles sign in** with an action from the library before they act (`role.login` in `cartographer.yaml`). Credentials can use `{{env.NAME}}`. A role without a login acts as a guest.

## Layout

```
apps/desktop      GUI: map (React Flow), inspector, proposals, coverage; Electron shell
packages/engine   engine: local API, MCP clients, test compiler and runner, agents
packages/model    model schema, reachability, plan, coverage, proposals, Markdown — no browser I/O
demo/shop         demo shop (buyer storefront + Marketplace) and its MCP server
workspace         example workspace — a plain folder that works well in git
```

The GUI stores nothing on its own: workspace files are the source of truth. The engine watches them and tells the GUI when they change.

### Model

`workspace/entities/order.yaml` holds variants, states, actions, transitions, and permits. Every element has a status and provenance:

- `confirmed` — a requirement: only these elements go into the test plan;
- `observed` — "this is how it works, but it's not a requirement": kept in the model, not planned;
- `proposed` — waiting for a person to decide;
- `rejected` — kept so agents don't propose it again.

`provenance` records who added the element (a person or an agent), the proposal ID, and evidence IDs (screenshots, page snapshots, read results).

**Subjects.** `cartographer.yaml → roles` gives each role a `kind`: `human` acts through an interface; `system` (a background job, a scheduler, an integration) has no interface and acts only through actions with an `invoke` tool — one of `mcp.*.allow.trigger`.

**Actions** (`entity.actions`) are verbs on the entity with no notion of state or permission: `run` is an entry of the action library a person performs through the UI; `invoke` is an MCP trigger tool a test uses to make the system perform it; `trigger` is prose describing what makes the product do it on its own (a schedule, a timeout, an event) — documentation only, nothing a test runs.

**Transitions** tie an action to who may perform it and what it does: `action` (the id of an `entity.actions` entry), `by` (the roles allowed to perform it), `from → to`, effects. **Permits** are the same idea for an action that leaves the state as it is (a read, an update): `by` may perform `action` over a set of `states` (every state, if none are given).

**Closed world.** For human roles, anything not allowed by a confirmed transition or permit is denied. The engine derives the full negative matrix — role × action × state — and plans one deny scenario per denied cell; a cell only an unconfirmed element allows is left undecided instead.

**State probe.** `entity.reader` describes how to read an instance's actual state through an allowed MCP tool; `state.match` lists the fields that must match. The probe runs after every data setup and after every transition.

**Setup.** A state is reached in one of three ways:
1. `setup: tool` — through a setup tool;
2. `setup: path` — an explicit path of transitions;
3. no recipe — the engine finds the shortest path through confirmed transitions from a state a setup tool can prepare.

**Allowlist.** The engine only calls tools listed in `cartographer.yaml → mcp.*.allow`, and setup, read, and trigger calls are each kept to their own list.

### Agent proposals

An agent works in one role's interface: it opens pages, takes snapshots, clicks, and prepares data. The result is `proposals/*.yaml`: a patch to the model (`add` / `update` / `remove`) plus findings (gap, contradiction, question) and evidence. For each operation a person picks one of three:

- **Requirement** — the element becomes `confirmed`;
- **Observation** — `observed`;
- **Reject**.

A proposal is created against a specific model revision. If the model has changed since, only operations that actually broke count as conflicts.

Inference is configured in `cartographer.yaml → inference`: `anthropic`, `openai-compatible` (local and third-party models), or `scripted` — a deterministic replay of a script from `workspace/agents/*.yaml`, no model needed.

### Tests

A generated spec contains only scenario data. Execution (setup through MCP, probes, actions, deny checks) lives in `@tc/engine/runtime`, and role actions live in `workspace/actions/index.ts`. The result is a regular Playwright project you can run in CI without the GUI: `pnpm tc run`.

Every scenario has a stable ID, `entity/transition/variant`. It flows through the plan, the test, the run report, and the Markdown, and Allure TestOps will attach to the same ID.

## First release and what's next

Done:
- projects, an entity catalog, and scenarios per entity: generated, journeys, and business rules;
- actions separated from transitions and permits, human and system subjects, and a closed-world access matrix with deny scenarios;
- creation transitions and role sign-in;
- relations between entities: setup dependencies, effects on related instances, rules on a related state;
- the Order and Listing entities with variants;
- two interfaces and two agents;
- an editable map with agent proposals overlaid on it;
- a setup tool verified by reading;
- test generation and runs for transitions, permits, and the access matrix;
- coverage and Markdown export.

Next:
- syncing scenarios and pushing results to Allure TestOps (through the same scenario IDs);
- cleaning up test data by `runTag`;
- creating entities from the GUI;
- agent-authored changes to the action library, reviewed by a person;
- packaging as a `.app`.
