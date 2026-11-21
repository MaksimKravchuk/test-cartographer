# Install and run

Test Cartographer has no installer and no prebuilt app. You clone it, build it and run it from source, on Linux, Windows or macOS. This page covers getting it running and connecting your agent. What to do once it runs is in the [usage guide](usage.md).

## Requirements

- [Node.js 24+](https://nodejs.org)
- [pnpm](https://pnpm.io/installation). The version is pinned in `package.json`; `corepack enable` picks it up.
- Git.
- Optional: a coding agent you are signed in to (Claude Code, Codex, GitHub Copilot or Cursor). Without one, every agent step replays a recorded script, so you can try the whole loop first.

## Get it

```bash
git clone https://github.com/MaksimKravchuk/test-cartographer.git
cd test-cartographer
pnpm install
pnpm exec playwright install chromium   # once: the browser the tests and the explorer agent use
```

To update later: `git pull && pnpm install`.

## Run it

```bash
pnpm demo     # the demo shop on http://localhost:4400, the app under exploration
pnpm start    # builds the GUI, starts the engine on :4317 and opens it in your browser
```

The demo project (the `workspace/` folder) opens on its own. `pnpm demo` is only needed for the demo project; for your own product, point the project at your app instead.

Other ways to run it:

| Command | What you get |
|---|---|
| `pnpm start` | engine + web GUI in your browser (the usual way) |
| `pnpm app` | the same in a native window (Electron); the engine starts on its own |
| `pnpm tc serve` + `pnpm ui` | engine on :4317 and the GUI with hot reload on :5173, for working on the GUI |
| `pnpm tc <command>` | the engine from the command line, no GUI (see the [usage guide](usage.md#command-line)) |

`pnpm tc serve --port <n>` changes the engine port. `--ws <path>` (or `TC_WORKSPACE=<path>`) opens another project folder from the command line; in the GUI, use the project menu.

### Platforms

| | Linux | Windows | macOS |
|---|---|---|---|
| CLI, engine, web GUI (`pnpm start`) | ✓ | ✓ | ✓ |
| Native window (`pnpm app`) | ✓ | not tested in CI | ✓ |

Every ✓ runs in CI on that OS. The one exception is `arazzo-tool` (Arazzo chains as command tools), which runs on macOS and Linux only.

### A standalone Mac app, for yourself

On a Mac you can build a `.app` from your checkout: `pnpm --filter @tc/desktop package:mac` writes `apps/desktop/release/Test Cartographer-<version>-arm64.dmg`. It carries its own engine and the demo shop (copied to `~/Documents/Test Cartographer/Demo shop` on first launch; set `TC_WORKSPACE` to open another project). It is ad-hoc signed, so open it the first time with right-click → Open. This is optional and not a distributed build.

## Connect your agent

Test Cartographer is not an agent. It drives the coding agent you already use through the vendor's SDK (all bundled, no separate CLI install needed) with your local sign-in, so nothing is billed per token here: runs use your own plan.

1. Sign in once in a terminal:

   | Agent | Sign in | Runs use |
   |---|---|---|
   | Claude Code | `claude auth login` | your Claude plan's Agent SDK allowance |
   | Codex | `codex login` | your ChatGPT plan's Codex limits |
   | GitHub Copilot | `gh auth login` (or `copilot login`) | your Copilot plan's requests |
   | Cursor | `pnpm tc runtimes login cursor`, or **Sign in** in Settings | your Cursor plan's usage |

2. Pick it in **Settings › Agents** (provider, optional model and effort) and save, or set it in the project's `cartographer.yaml`:

   ```yaml
   runtime:
     provider: claude      # claude | codex | copilot | cursor
     model: ...            # optional
     effort: ...           # optional; doesn't apply to Cursor
     maxSteps: 60          # optional: tool calls per run (default 60)
   ```

3. Check it: `pnpm tc runtimes` prints the sign-in state of each runtime, `pnpm tc runtimes test <provider>` does a short end-to-end run (sign-in, the tool bridge, tool calls). **Test run** in Settings does the same.

While an agent runs, the engine serves its tools to it over MCP on `127.0.0.1`. The agent's built-in tools (shell, file edits, web) are off, so every call goes through the engine and lands in the evidence.

### Your own model, no subscription

Codex (Apache-2.0) can also run on any model served over the OpenAI Responses API instead of a ChatGPT sign-in, such as an open-weight model in Ollama, LM Studio or vLLM:

```yaml
runtime:
  provider: codex
  model: gpt-oss:20b                    # a model the endpoint serves
  baseUrl: http://localhost:11434/v1    # Ollama; LM Studio: http://localhost:1234/v1
```

Codex is then ready when the endpoint answers and lists its models. Results depend on the model: it has to follow long instructions and call tools reliably.

### No agent at all

Pick **None — scripted runs only** in Settings, or pass `--scripted` on the command line. Agent steps then replay `workspace/agents/*.yaml`: deterministic, no model.

## Check the install

```bash
pnpm tc validate    # the demo model is consistent and testable
pnpm tc run         # with `pnpm demo` running: ~300 tests, 3 fail on purpose (planted bugs in the demo shop)
```

Next: the [quickstart](quickstart.md) walks the whole loop on the demo shop in about 5 minutes, and the [usage guide](usage.md) explains how to work with your own product.

## Where things are stored

- A project is a plain folder with `cartographer.yaml`; everything you and the agents do is written there, so it works well in git.
- The list of recent projects is `~/.test-cartographer/projects.json`; deleted projects go to `~/.test-cartographer/trash`.
- The GUI stores nothing on its own.
