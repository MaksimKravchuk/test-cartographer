# Agent skills

How Test Cartographer's agents work — how they plan a run, read requirements and code, explore an app, cite
evidence, ask questions and propose model changes — lives here, one folder per skill, in the
[Agent Skills](https://agentskills.io/specification) format: `SKILL.md` (frontmatter + instructions) and
optional `references/`.

| Skill | Job | Research | Review | Explore |
|---|---|:-:|:-:|:-:|
| `planning-investigation` | scope, map, questions, closing status of each | ✓ | ✓ | ✓ |
| `reading-requirements` | docs, tracker, MCP systems → elements | if such a source | if such a source | |
| `reading-code` | code → behavior, without implementation detail | if a code source | if a code source | |
| `reviewing-model` | element × source: confirmed, contradicted, not found | | ✓ | |
| `exploring-app` | live app as one role, confirmed by reading back | | | ✓ |
| `citing-evidence` | exact quotes, what they prove, bounded "not found" | ✓ | ✓ | |
| `asking-questions` | one decision per question, readable out of context | ✓ | ✓ | ✓ |
| `proposing-model-changes` | element shapes, handing in | ✓ | ✓ | ✓ |

## How the engine uses them

The agent runtimes (Claude Code, Codex, Copilot, Cursor) run without disk access, so they cannot load skills
the native way. Instead `src/agents/skills.ts` puts the skills a task needs into the system prompt and
offers a `skill({ name, file })` tool for the reference files a skill links to. Which skills a task gets is
decided in code (`skillsFor` in `onboard.ts`, `SKILLS` in `explore.ts`), from the task and the kinds of
sources — the agent does not have to guess from descriptions. The prompts in those files hold only the task
itself: role, sources, goal.

`metadata.tools` lists the engine tools a skill tells the agent to call. A run refuses to start if a skill
names a tool the run does not have, and `test/skills.test.ts` checks that every tool a skill mentions is listed.

The folders are plain Agent Skills, so they can also be installed into an agent of your own.

## Writing and changing skills

The rules below come from the vendors' guides; `pnpm test:unit` checks the mechanical ones.

- **Only what the model does not already know.** Every line competes for context. Explain the product's
  rules and the reasons behind them, not what a state machine or a regular expression is.
- **Say why.** A reason lets the agent handle a case the rule did not foresee. Plain wording works better
  than capitals: current models follow instructions closely and overreact to "ALWAYS" and "NEVER".
- **One job per skill, one owner per rule.** The same rule in two skills drifts into a contradiction, and
  contradictions cost the agent more than gaps. Use the same word for the same thing everywhere.
- **Match freedom to fragility.** Exact shapes and steps where a mistake breaks something (element shapes,
  evidence); heuristics where judgment is needed (what belongs in the model).
- **Steps as a numbered workflow; examples as input and output.** Examples steer more than descriptions.
- **Description:** third person, what the skill does and when to use it, key words first, at most 1024
  characters. Name: lowercase with hyphens, same as the folder.
- **`SKILL.md` under 500 lines.** Longer material goes to `references/`, linked from `SKILL.md` and never
  from another reference; a reference over 100 lines starts with `## Contents`.
- **Deterministic work belongs in an engine tool**, not in instructions (`search()`, `quote()`): a skill
  says when to call it.
- **Change a skill because of something an agent did.** Run it, read the log and the proposals, then edit.

Sources: Anthropic, [Skill authoring best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)
and [Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices);
OpenAI, [Agent Skills for Codex](https://developers.openai.com/codex/skills) and the
[GPT-5 prompting guide](https://developers.openai.com/cookbook/examples/gpt-5/gpt-5_prompting_guide);
xAI, [Prompt engineering for Grok Code](https://docs.x.ai/docs/guides/grok-code-prompt-engineering)
(sections marked with tags, a stable prompt prefix); the [Agent Skills specification](https://agentskills.io/specification).

## Credits

The working methods adapt ideas from [REA](https://github.com/morluto/rea) (MIT) — planning an investigation,
observation versus inference, bounded "not found", confirming a change by reading it back; from the
[Rosetta reverse-engineering skill](https://github.com/griddynamics/rosetta) (Apache-2.0) — telling behavior
from implementation, hidden state machines, consolidating scattered checks; from
[meirm/reverse-engineering-skill](https://github.com/meirm/reverse-engineering-skill) (MIT) — tracing from
entry points; and from [Playwright's test agents](https://github.com/microsoft/playwright) (Apache-2.0) —
tools per role, independent checks from a fresh state. The text is our own.
