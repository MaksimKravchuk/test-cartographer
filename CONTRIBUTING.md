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
pnpm test         # unit tests (node --test)
pnpm typecheck    # tsc, no emit
pnpm tc validate  # the example workspace is consistent
```

## Pull requests

- Keep a pull request to one change, and describe what it does and why.
- Add or update a test in `packages/*/test/` when you change logic in `packages/model` or `packages/engine`.
- If you change how something works for users, update the README in the same pull request.
- Don't commit real credentials. Workspace values that are secrets should be `{{env.NAME}}` references.

## Layout

`packages/model` is the model, with no browser or network I/O. `packages/engine` is the local API, the agents, the test compiler and the runner. `apps/desktop` is the GUI. `demo/shop` is the app the example explores. `workspace` is the example project. The README describes each in detail.
