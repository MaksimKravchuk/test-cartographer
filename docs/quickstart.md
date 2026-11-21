# Quickstart: the whole loop in 5 minutes

This walks the loop on the bundled demo shop: sources → model → your agent's review → the inbox of findings → specification → Playwright tests. The top bar follows the same order: **Sources · Model · Inbox · Spec · Tests**. You don't need an agent to try it: without one, every agent step replays a recorded script from `workspace/agents/`, so you see exactly what an agent would do.

![The knowledge loop on the demo shop](media/loop.gif)

## 0. Install (2 minutes)

You need [Node.js 24+](https://nodejs.org) and [pnpm](https://pnpm.io/installation). Details, other ways to run it and platforms are in [install and run](install.md).

```bash
git clone https://github.com/MaksimKravchuk/test-cartographer.git
cd test-cartographer
pnpm install
pnpm exec playwright install chromium
pnpm demo        # demo shop on http://localhost:4400 (keep it running)
```

In a second terminal:

```bash
pnpm start       # builds the app, starts the engine on :4317 and opens it in your browser
```

The demo project opens on its own. It is the plain folder `workspace/`: everything you do below changes files there, so `git status` shows it and `git checkout workspace` undoes it.

## 1. Pick your agent

Test Cartographer is not an agent: it drives the coding agent you already use and gives it the tools (read sources, quote them, click through the app, propose changes). Open **Settings** (⚙ at the top right) › **Agents**:

- **With an agent.** Sign in once in a terminal (`claude auth login`, `codex login`, `gh auth login`, or **Sign in** on the Cursor card; see [connect your agent](install.md#connect-your-agent)), pick it as the **Provider** and press **Save settings**. **Test run** checks it end to end. Runs use your own plan; nothing is billed per token here.
- **Without one.** Pick **None — scripted runs only** and **Save settings**. The steps below then replay the recorded runs.

## 2. Sources

Open **Sources**. New ones come from **Add source** (a document, a code folder, or a system through MCP). The demo has three: a product overview (`product-overview.md`), a Jira-like export (`backlog.csv`) and the shop's code folder. Requirements have priority 1, code priority 2, so when they disagree the requirement stands by default.

Press **Check access**. Each source shows *readable* with what an agent can read: lines of a file, files in a folder. A source behind MCP (Confluence, Jira) is checked with one real call.

## 3. Model and review

Open **Model**. The demo already has one: subjects and objects on the left (guest, buyer, seller, the shop's background jobs; order, listing, line item), the selected object's actions by subject in the middle, and **What to do next** on the right: what the model checks find without an agent, such as actions nobody described and rules no source backs.

Open **Ask agent › Review the model**. The agent reads each source against each element of the model, quotes what it finds and proposes (the status chip next to **Ask agent** shows it working; click it for progress and the raw log):

- confirmations: the docs and the code say the same as the model;
- what's missing: a rule or an action the sources describe and the model doesn't;
- contradictions: the product overview says *"A buyer can cancel an order only until it has been paid"*, while `demo/shop/domain.ts` lets the buyer cancel a paid order.

Findings appear in place with a dashed border. Click **Cancel** in the buyer's row to see that action's rules with their quotes and their R / C / A marks (what the requirements, the code and the app say), then decide each finding: **Accept as requirement**, tests check it; **Observed only**, that's how it works but no source requires it; **Not built yet**, required but not built; **Strike out**, agents won't propose it again.

## 4. Inbox

Open **Inbox**. Everything waiting for a decision is one queue: contradictions, questions, gaps and the agents' proposed changes. A contradiction shows each source's quote side by side, with the one that stands by priority framed. Settle the cancel one as **Bug in the product** (or press **B**): the requirement wins and the tests will check it. **Requirements are outdated** (**U**) would make the code the truth instead; **Not a problem** (**N**) closes it. A question is answered **Yes**, **No** or in your own words (a yes to “is X the same as Y?” adds the synonym to **Model → Glossary**), and a source problem, where an agent couldn't read part of a source, is marked fixed or left out on purpose. When you can't answer an item as written, **Need more context** (**M**) sends the agent back to the sources: it finds where the thing shows in the app or API, quotes it, and replaces the item with questions that ask one thing each. **J** and **K** move through the queue.

**Inbox › By source** shows the same review as a table: every element against every source, ✓ confirms, ✕ contradicts.

## 5. Specification

Open **Spec**: the confirmed model as one document with contents, who performs each action, its rules and how many tests check each, open questions and known defects. **Save as Markdown** writes it to `workspace/export/spec.md`.

## 6. Tests

Open **Tests** and press **Run all tests**. The engine generates Playwright tests from the model, about 300 for the demo, including the negative ones (everything a role must *not* be able to do), runs them against the shop and shows the results on **Tests › Overview** and per object. It takes a couple of minutes.

Three tests fail, on purpose: the demo shop has planted bugs. The buyer can still cancel a paid order and an accepted one (the disagreement from step 4), and the seller can archive an out-of-stock listing. Each failure is either a bug to report or a rule to revisit, which takes you back to step 3. That's the loop.

The same from the command line:

```bash
pnpm tc validate          # is the model consistent and testable
pnpm tc run               # compile and run the tests, report in workspace/runs/
pnpm tc coverage          # what is covered, per transition and variant
pnpm tc export md         # scenarios as Markdown
```

The generated tests are a plain Playwright project (`workspace/generated/`), so CI can run them without the app.

## Next: your own product

- **Settings › Projects › New project** creates an empty workspace anywhere on disk.
- On **Sources**, use **Add source** for your docs, tracker exports, a code folder, or Confluence/Jira through MCP, and press **Check access**.
- On **Model**, write what you know by hand, or use **Ask agent › Research from scratch** to have your agent propose subjects, objects, actions and rules from the sources, then **Review the model** as above.
- An explorer agent can also click through each role's interface: **Ask agent › Explore the app**, or `pnpm tc explore <agent>`.

The [usage guide](usage.md) describes the loop, the model, the agents and the test runtime in full.
