# Test Cartographer

A local macOS app where a person and AI agents explore a web application together, rebuild a model of how it behaves, and turn the confirmed model into Playwright tests.

Writing end-to-end tests usually starts with someone working out how the product actually behaves: which states an order goes through, who can cancel it and when, what must stay impossible. Test Cartographer does that work with you. Agents click through each role's interface and read your docs and backlog, propose what they find, and you decide what is a requirement. From the confirmed model the engine generates Playwright tests, including the negative ones: everything a role must *not* be able to do.

> **Status: early alpha.** It runs on macOS with Node.js 24+, and the file formats may still change. Issues and pull requests are welcome, see [CONTRIBUTING](CONTRIBUTING.md).

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
| `onboard [agent] [--scripted]` | the onboarding agent reads the knowledge sources and proposes roles, entities, the model, and the backlog |
| `backlog` | epics → features → stories, with totals and unmapped stories |

## Projects, entities, scenarios

The app is organized as **project → entities → scenarios**.

- **Project** — a workspace folder with `cartographer.yaml`. The app remembers recent projects (`~/.test-cartographer/projects.json`), opens existing ones and creates new ones from a template with a guest and a signed-in role. The Projects page (“Manage projects…” in the project menu) lists them all: open, create, star as a favorite, remove from the list (the folder stays), or delete — which moves the folder to `~/.test-cartographer/trash`. Favorites stay pinned at the top of the project menu and are never trimmed from the recent list. A project anywhere on disk gets a link to the engine in its own `node_modules`, so its generated tests and action library resolve `@tc/engine`.
- **Knowledge sources and the backlog** — a project can also hold what a person uploaded about the system (`sources.yaml` + `sources/`) and a backlog of epics, features and stories (`backlog.yaml`) — a view over the model, not a second one. See Onboarding and Backlog below.
- **Entities** — one file each in `entities/`: an order, a quota, a user account. The Overview shows the catalog with the size of each model and how its tests stand; the **Objects** page shows them as a map of object cards, parts drawn inside their parent and arrows for references. Removing an entity moves its files to `entities/.trash`.
- **Scenarios** of an entity come in four kinds:
  - **generated** from the model: one per confirmed transition and one per permit, for each role that may perform it and each variant;
  - **deny** — the closed world's negative matrix: for every human role, action and state not allowed by a confirmed transition or permit, a scenario asserts the action stays unavailable. A cell only an `observed`/`proposed` element allows is left undecided, not planned;
  - **journeys** written by people: a path of transitions checked end to end, for example an order from placement to delivery;
  - **business rules** in the product's own words, tied to a transition. A `roles` or `authenticated` condition produces no scenario of its own — it tags the deny scenarios it excludes, for traceability; an `entity-state` condition (“the related instance must be in state X”) still gets its own scenario per other reachable state of the related instance.

**Relations** link entities: `relations: [{ id: listing, entity: listing, field: listingId, requires: published, variants: { standard: physical } }]` on the order means an order refers to a listing through `listingId`, is created for a published listing, and a standard order goes with a physical listing. Every relation has a `kind`: `reference` (the default) — this entity holds the related one's key and needs it to exist; or `part-of` — this entity lives inside the related one, like a line item inside an order (an object has at most one parent). From that:

- **Setup dependencies.** Before preparing an order in any state, the engine prepares the related listing in the required state — with the listing's own setup tool or transitions — and passes its key to setup tools as `{{rel.listing}}` and to actions as `ctx.related.listing`.
- **Effects on related instances.** `{ relation: listing, field: stock, delta: -1 }` on a transition reads the listing right before the act and checks the change after it; `equals` checks an exact value.
- **Rules on a related state.** `{ kind: entity-state, relation: listing, states: [published] }` yields one negative scenario per other reachable state of the listing: the related instance is prepared in that state and the transition must be unavailable.

**Creating an instance** is a transition from `@new`. Its action creates the instance through the UI and returns the new key, so a state can be reached without a setup tool.

**Roles sign in** with an action from the library before they act (`role.login` in `cartographer.yaml`). Credentials can use `{{env.NAME}}` or a role's own data, `{{roles.<id>.<field>}}`. A role without a login acts as a guest.

**Data on subjects and objects.** A role or an entity can carry `fields` — named values a person attaches for agents and tests: the seller's login and password, a test card number, a promo code. On the Objects page, click a subject in the Subjects strip (or on an object's card) to open its card; both cards have a **Data** section to add and edit them.

```yaml
roles:
  - id: seller
    fields:
      - id: login
        value: seller
      - id: password
        value: "{{env.SELLER_PASSWORD}}"   # or a literal, for a demo account
        secret: true
        note: the marketplace account   # told to agents as is
    login:
      action: auth.login
      args: { username: "{{roles.seller.login}}", password: "{{roles.seller.password}}" }
```

- **Agents** get every subject's and object's fields in their instructions; the explorer's `model()` also shows the entities its entity is related to. An explorer can type into the app with `fill()`, passing a field reference such as `{{roles.seller.password}}`; the engine substitutes the value.
- **A secret never reaches the model**: it sees only the reference, and any secret value that comes back in a page snapshot, a read result or an error is replaced with that reference before the agent gets it.
- **Tests** template `{{roles.<id>.<field>}}` / `{{entities.<id>.<field>}}` in login args, and actions in the library get every value as `ctx.data`.
- Values are stored as plain text in `cartographer.yaml` / `entities/<id>.yaml`; for a real account put `{{env.NAME}}` as the value.

## Layout

```
apps/desktop      GUI: map (React Flow), inspector, proposals, coverage; Electron shell
packages/engine   engine: local API, MCP clients, test compiler and runner, agents
packages/model    model schema, reachability, plan, coverage, proposals, Markdown — no browser I/O
demo/shop         demo shop (buyer storefront + Marketplace) and its MCP server
workspace         example workspace — a plain folder that works well in git (entities/, sources.yaml + sources/, backlog.yaml)
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

**State probe.** `entity.reader` describes how to read an instance's actual state through an allowed MCP tool; `state.match` lists the fields that must match. The probe runs after every data setup and after every transition. `reader` is optional: an onboarding agent may propose an entity nobody can read back yet. Without one, every scenario of the entity plans as `blocked` (“No reader: add entity.reader so states can be verified”), and validation warns.

**Setup.** A state is reached in one of three ways:
1. `setup: tool` — through a setup tool;
2. `setup: path` — an explicit path of transitions;
3. no recipe — the engine finds the shortest path through confirmed transitions from a state a setup tool can prepare.

**Allowlist.** The engine only calls tools listed in `cartographer.yaml → mcp.*.allow`, and setup, read, and trigger calls are each kept to their own list.

### Backlog: epics, features, stories

`workspace/backlog.yaml` holds epics, features and stories — a view over the model, not a second one: everything about *behavior* still lives in the entities. An absent file is an empty backlog.

- **Feature** — a slice of the model by action: `feature.actions` lists `<entity>.<action>` refs, cross-entity. `cancel-and-refund` (epic `checkout`) has `actions: [order.cancel]`; `manage-listings` spans four listing actions.
- **Story** — `story.covers` cites the exact elements it specifies, as `<kind>:<entity>.<id>`:
  - `action:order.cancel` — every scenario that exercises that action, whatever kind it is;
  - `transition:listing.archive-out-of-stock` — that transition's own scenario, rule scenarios tied to it, and journeys that walk through it;
  - `permit:review.edit-review` — that permit's scenario;
  - `rule:<entity>.<id>` — that rule's own scenario and any scenario whose `rules` include it;
  - `journey:<entity>.<id>` — that journey's scenario.

  A story with no `covers` ref that resolves is **unmapped** — a requirement not in the model yet; `tc backlog` and the GUI's Backlog view both call these out.
- **Coverage** rolls up from each entity's plan: a feature's totals are its actions' scenarios plus its stories' scenarios (deduplicated); an epic's totals are the union of its features' and its own direct stories'. Totals count passed / failed / blocked / not-run, the same statuses as entity coverage.

Compiled scenarios carry their backlog trace as `@epic:<id>`, `@feature:<id>`, `@story:<key or id>` tags and matching annotations, so Allure TestOps groups results the same way.

### Agent proposals

An agent works in one role's interface: it opens pages, takes snapshots, clicks, and prepares data. The result is `proposals/*.yaml`: a patch to the model (`add` / `update` / `remove`) plus findings (gap, contradiction, question) and evidence. For each operation a person picks one of three:

- **Requirement** — the element becomes `confirmed`;
- **Observation** — `observed`;
- **Reject**.

A proposal patches one entity, or — with no `entity` field — the project itself: roles, interfaces, new entities, epics, features, stories (only onboarding writes these). A `role` / `interface` / `entity` op has no status of its own, so there's no "Observation" for it: accept applies it, reject skips it.

A proposal is created against a specific model revision (the backlog revision, for a project-level one). If the model has changed since, only operations that actually broke count as conflicts.

Agents don't call model APIs and nothing is billed per token: they run inside a coding agent you're already signed in to — **Claude Code** on your Claude subscription, **Codex** on your ChatGPT subscription, **GitHub Copilot** on your Copilot plan, or **Cursor** on your Cursor plan. The engine drives it through the vendor's SDK (Claude Agent SDK, Codex SDK, Copilot SDK, Cursor SDK — all bundled, no separate CLI install) using the local sign-in: `claude auth login`, `codex login`, `gh auth login` (or `copilot login`), and for Cursor the **Sign in** button / `tc runtimes login cursor` and serves the agent's tools to it over MCP on `127.0.0.1` for the length of a run; built-in tools (shell, file edits, web) are off, so every call still goes through the engine and lands in the evidence. The runtime is set in `cartographer.yaml → runtime` (`provider: claude | codex | copilot | cursor`, optional `model`, `effort`, `maxSteps` — tool calls per run), and an agent can override it with its own `runtime:`; the GUI's **Agents** page edits both, shows each runtime's sign-in state and models, and has a **Test run** button. `tc runtimes` prints the same status, `tc runtimes test <provider>` does a short end-to-end run. Claude runs draw from your plan's Agent SDK allowance, Codex runs from your ChatGPT plan's Codex limits, Copilot runs from your Copilot plan's requests, Cursor runs from your Cursor plan's usage (effort doesn't apply to Cursor).

`--scripted` (and **Scripted** in the GUI) replays the agent's script from `workspace/agents/*.yaml` instead — deterministic, no model needed.

### Onboarding

A person uploads what they already know about the system under test — product docs, a tracker export, API contracts, notes — as knowledge sources: `workspace/sources.yaml` lists them (id, title, kind: `doc` / `backlog` / `contract` / `note`), the files themselves live in `workspace/sources/`. The GUI's Sources page adds them by file picker, drag-and-drop, or pasted text, and shows a **Run onboarding** button; removing a source moves it to `sources/.trash`, like an entity.

The onboarding agent (`tc onboard [agent] [--scripted]`) reads every source and proposes the first model: roles, entities (new ones too), actions, states, transitions, permits, rules, and the backlog. Every operation cites an exact quote: `quote({ source, text })` refuses text that isn't actually in that source, so the agent can't cite what isn't there. When a source and the model (or two sources) disagree, or a tracker story doesn't map to anything in the model yet, it writes a finding (`contradiction`, `gap`) instead of guessing.

The result is reviewed like any proposal, split by scope: one **project-level** proposal for roles, interfaces, new entities, and backlog items, plus one proposal per entity for its own states/actions/transitions/permits/rules. An entity-level proposal for an entity that isn't accepted yet waits — it can only be decided once the project proposal has created that entity. Accepted operations keep `provenance.sources`, the ids of the knowledge sources that back them.

**Sources page.** Besides uploaded files, a source can be a **code folder** (`kind: code`, `path` — absolute, `~/…` or relative to the workspace) or a system behind an **MCP server** (`kind: mcp`, `read` — an allowed read tool from `mcp.*.allow.read` with its args, e.g. a Confluence or Jira MCP server). Every source has a `priority` (1 is the strongest; requirements default to 1, code to 2) and can be switched off with `enabled: false`; `usePriority: false` at the top of `sources.yaml` turns priorities off, so every disagreement goes to a person. **Check access** proves each enabled source can be read the way agents will read it — the file, the folder (files counted, skipping `node_modules`, `.git`, build output), or one call to the read tool — and shows the counts so a missing page or folder is noticed. Onboarding still reads uploaded files only; code and MCP sources are for the research agent that comes next.

Onboarding runs `scripted` — a deterministic replay from `workspace/agents/onboarding.yaml`, no model call — or `live`, the same distinction as an explorer.

`demo/shop/knowledge/` is a worked example for the demo shop: `product-overview.md` (a product doc) and `backlog.csv` (a Jira-like export of epics, features and stories), already uploaded as `workspace/sources.yaml` + `workspace/sources/`. It's written to disagree with the running app on purpose: it documents that a buyer can cancel only until payment and the seller cancels (rejects) afterward, which the demo doesn't enforce; that a seller can archive a listing in any state, including out of stock, which settles something the model had left undecided; and a buyer-reviews feature the app has no UI or API for at all, onboarded as a new `review` entity with no reader, so its scenarios can only plan as `blocked` until one exists. It also documents the unpaid-order expiry the model already has. `workspace/agents/onboarding.yaml` is a scripted run over this pack with the tools above.

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
- coverage and Markdown export;
- knowledge sources and an onboarding agent that reads them and proposes the first model and backlog, every operation backed by an exact quote;
- the backlog — epics, features, stories — as a view over the model: features slice it by action, stories cite the elements they cover, coverage rolls up per epic/feature/story, and unmapped stories are called out;
- scenarios tagged and annotated by epic/feature/story for Allure TestOps.

Next:
- actually pushing runs to Allure TestOps (the scenario IDs and epic/feature/story labels are already on every compiled test);
- cleaning up test data by `runTag`;
- creating entities from the GUI;
- agent-authored changes to the action library, reviewed by a person;
- packaging as a `.app`.

## License

[Apache License 2.0](LICENSE). Contributions are accepted under the [Contributor License Agreement](CLA.md).

The agent runtimes are third-party SDKs installed as dependencies, each under its own terms, which this project's license doesn't cover: the Claude Agent SDK ([Anthropic Commercial Terms](https://www.anthropic.com/legal/commercial-terms)), the Cursor SDK ([Cursor Terms of Service](https://cursor.com/terms-of-service)), the GitHub Copilot SDK (MIT) and the Codex SDK (Apache-2.0). Using one also requires an account with that vendor.
