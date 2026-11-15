# Case study: Vikunja, from five help pages to 217 Playwright tests

[Vikunja](https://vikunja.io) is an open-source to-do app (Go + Vue, AGPL-3.0). We took v2.8.0, which had just added a trash, and ran the whole Test Cartographer loop on its sharing permissions: sources → model → agent research → human review → specification → Playwright tests. The agent was Claude Code, brought by the user. Cartographer doesn't ship one.

Everything here is in [`examples/vikunja`](../../examples/vikunja): the configuration, the agents' proposals with their quotes, every decision a person made and why, the spec and the action library. Vikunja itself and its help pages are fetched at pinned commits by `fetch-sources.sh` and never committed.

## In numbers

| | |
|---|---|
| Sources | 5 help pages (5,014 words) + `pkg/models` (99 Go files, 70k lines) |
| Subjects | 6 human roles (owner, Admin / Read & Write / Read only share, a user without a share, guest) + 1 system job |
| Agent runs | first research 12.5 min, review 12 min, two UI explorers about 15 min, in parallel |
| Proposed by agents | 171 operations, 90 findings: 44 confirmations, 10 contradictions, 16 gaps, 20 questions |
| Human decisions | 102 accepted as requirements, 61 kept as observed behavior, 8 struck out |
| Model | 2 objects, 142 elements: 34 actions, 18 transitions, 18 permits, 58 rules; 83 are requirements |
| Disagreements settled | 10: 3 bugs in the product, 1 outdated requirement, 6 not a problem |
| Tests | 217 scenarios (28 transitions, 16 permits, 167 deny, 6 rules): 209 pass, 3 fail on a real defect, 3 fail on a test-bed limit, 2 blocked |
| Hand-written code | action library (16 actions, 283 lines) and an MCP server for setup and reads (115 lines) |

## What we found in Vikunja

| # | Finding | How it was found | Kind |
|---|---|---|---|
| 1 | **An archived project's tasks still offer every edit.** The task page shows *Mark task done!*, *Delete*, an editable title and comments; each is refused with HTTP 412 "This project is archived". The help page says an archived project is read-only. | Rule added by a person after the action library was written; 3 generated tests fail on it (`task/rule-*_needs_active_project-project-archived`) | bug (UI) |
| 2 | **Duplicating a project doesn't copy its sub-projects**, although help-projects says it does. | First research quoted both sides; checked live (project 488 → 490, sub-project 489 not copied) | doc ↔ code |
| 3 | **A Read only share is offered *Add to Favorites*** on every task, then refused with *Forbidden*. | Read-only explorer | bug (UI) |
| 4 | **Edit, Archive and Delete dialogs open by direct URL** for users who may not use them (Read only, Read & Write for Delete). The server refuses with 403, so it's a UI defect, not a security hole. | Both explorers and the action library | bug (UI) |
| 5 | **Un-archiving shows "The project was successfully archived."** | Action library | bug (copy) |
| 6 | Two help pages disagree about **an Admin link share and the trash**: help-permissions gives Admin "full access", help-trash says link shares have no trash. The code lets an Admin link share delete the project. | Review | outdated docs |
| 7 | **No page says who may archive a project.** A Read & Write share can (HTTP 200); the code checks write access. | First research (question) + writer explorer | gap |
| 8 | **Permissions are inherited down the project tree** (nearest grant wins), and no help page says so. | First research, from the code | gap |
| 9 | A user without a share gets a blank project page but a proper *Not found* on a task page. | Action library | inconsistency |

Findings 1, 3, 4 and 5 come from the running app, 2, 6, 7 and 8 from comparing the docs with the code, and only 1 needed a test to prove. That's the point of the loop: most of the value shows up before the tests run, as contradictions with quotes from both sides.

## How the loop went

1. **Sources.** Five help pages as `doc` sources (priority 1) and `pkg/models` as a `code` source (priority 2). Requirements outrank code.
2. **First research** (`tc onboard`). The agent read every page and 16 model files and proposed 141 operations: roles, both objects, their states, actions, transitions, permits and 42 rules, plus a backlog of 3 epics, 6 features and 8 stories. Every operation cites an exact quote; the engine refused 2 paraphrased quotes. It asked 9 questions instead of guessing, for example which level is needed to archive.
3. **Human review.** We decided all 141 operations with one policy, written down in [`review/decide.py`](../../examples/vikunja/review/decide.py): structure is accepted; a claim only the code backs is kept as observed behavior, not a requirement; elements the action library can't drive yet (move, duplicate, teams, link shares, deleting forever) are observed; the link-share recipient role is struck out of scope.
4. **Wiring.** What no source can say, added by a person ([`review/wire.py`](../../examples/vikunja/review/wire.py)): how to read a project or task back, how to prepare each state, which library entry performs each action.
5. **Explorers.** A Read only explorer and a Read & Write explorer clicked through the UI in their roles and proposed 12 operations and 15 findings (findings 3, 4 and 7 above).
6. **Review** (`Review the model`). The agent checked every element against the docs and the code: 39 confirmations, 5 contradictions, 12 gaps and 4 questions, and 18 operations.
7. **Disagreements.** All 10 contradictions settled on the Report page: 3 bugs, 1 outdated, 6 not a problem.
8. **Specification and tests.** [`spec.md`](../../examples/vikunja/spec.md) lists each action with who may do it, its rules with their sources and the tests that check them. 217 Playwright scenarios run in 10 minutes on one machine.

The first test run failed 5 scenarios; all of them were errors in the model, not in Vikunja. The research had put `by` on the create action instead of a transition from `@new`, so the plan expected owners *not* to be able to create tasks. A person added the transition and three rules about archived projects ([`review/round2.py`](../../examples/vikunja/review/round2.py)), and the second run turned up finding 1.

## What we found in Test Cartographer

Running on a real product showed problems the demo shop never did. Fixed in this change:

- **The review couldn't read the model.** `model()` returned the whole 68 KB model at once, and Claude Code cut it to a 2 KB preview, so two review runs saw only the role list and proposed nothing. `model()` now returns an index of the entities and `model({ entity })` gives one entity with compact provenance.

Left as follow-ups:

- **Step budget.** The first research stopped at the 80-step limit after reading and quoting. It needed 153 tool calls; we raised `maxSteps` to 250.
- **A rejected role blocks the ops that name it.** Striking out the link-share role made two `read` permits impossible to accept as they were. A person had to reject them and add them again by hand. An "accept without this role" choice would help.
- **The agent proposed what validation then refused:** a permit on a create action, a rule on a relation called `self`, `by` on an action. Agents should validate before `propose`.
- **A `run` entry missing from the action library fails at run time** instead of planning as blocked. The explorers named two that don't exist.
- **Job results aren't queryable.** The engine streams job events but keeps no history, so a missed event means a lost error.

## Test-bed limits

- Vikunja on SQLite answers "database is locked" (HTTP 500) under parallel tests; the MCP server retries. Use Postgres for a real stand.
- A task of a trashed project can't be read back by anyone: the API answers with the project's trash notice. The three rule scenarios with a trashed project fail on that, not on a defect.
- Vikunja allows 10 logins per minute by default; the stand raises `ratelimit.noauthlimit`.

## Reproduce

See [`examples/vikunja/README.md`](../../examples/vikunja/README.md).
