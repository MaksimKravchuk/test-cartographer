# Contributing

Thanks for wanting to help. Bug reports, ideas, docs fixes and code are all welcome.

## Before you start

- For anything bigger than a small fix, open an issue first so we can agree on the approach before you spend time on it.
- The first time you open a pull request, a bot asks you to sign the [Contributor License Agreement](CLA.md) by posting a comment. You keep the copyright in your work. The CLA lets the project be offered under other licenses later without having to track down every past contributor.

## Setup

You need Node.js 24 or newer and pnpm (the version is pinned in `package.json`; `corepack enable` picks it up).

```bash
pnpm install
pnpm exec playwright install chromium   # once
```

How to run the demo shop, the engine and the GUI is in the [README](README.md#quick-start).

## Checks

Run these before you push. CI runs the same ones on every pull request:

```bash
pnpm typecheck         # tsc, no emit (packages and the GUI)
pnpm tc validate       # the example workspace is consistent
pnpm test              # unit + component + integration, below
```

The tests come in four levels:

| Level | Command | Where | What |
| --- | --- | --- | --- |
| Unit | `pnpm test:unit` | `packages/*/test/*.test.ts` | the model and engine logic, no I/O (node --test) |
| Component | `pnpm test:component` | `apps/desktop/test/` | GUI logic and React views in jsdom (Vitest + Testing Library) |
| Integration | `pnpm test:integration` | `packages/*/test/integration/` | the engine API, the CLI, MCP tools and scripted agents over a copy of `workspace/`, against the demo shop |
| End to end | `pnpm test:e2e` | `tests/e2e/` | the built GUI in Chromium, the Electron window, and a full `Run all tests` against the demo shop (Playwright) |

Integration and e2e tests start the demo shop on port 4400 unless one is already running, and never touch `workspace/` itself: they work on a throwaway copy (`.tc-test-*`, removed afterwards). The full run expects exactly the demo shop's deliberate bugs to fail (`tests/e2e/pipeline.spec.ts`); if you change the demo shop or the model, update that list. On Linux, the Electron test needs a display: `xvfb-run -a pnpm test:e2e`. Agents never call a model in tests: they replay their `script:` (provider `scripted`), and a fake MCP client stands in for Claude Code / Codex at the tool bridge.

## Pull requests

- Keep a pull request to one change, and describe what it does and why.
- Add or update a test at the right level (see the table above) when you change logic.
- If you change how something works for users, update the README in the same pull request.
- Don't commit real credentials. Workspace values that are secrets should be `{{env.NAME}}` references.

## Layout

`packages/model` is the model, with no browser or network I/O. `packages/engine` is the local API, the agents, the test compiler and the runner; how the agents work is written as skills in `packages/engine/skills` (its README has the rules for changing them). `apps/desktop` is the GUI. `demo/shop` is the app the example explores. `workspace` is the example project. The README describes each in detail.
