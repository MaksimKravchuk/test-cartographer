// The skills are prompts, so nothing compiles them: these checks hold them to
// the Agent Skills format and to the tools the engine really offers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadSkill, SKILLS_DIR, skillsPrompt, skillTool } from '../src/agents/skills.ts';

const names = readdirSync(SKILLS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
// A tool call a skill mentions: a code span that starts with `name(`.
const calls = (text: string) => [...text.matchAll(/`(\w+)\(/g)].map((m) => m[1]);
const links = (text: string) => [...text.matchAll(/\]\((references\/[^)]+)\)/g)].map((m) => m[1]);

for (const name of names) {
  test(`skill ${name}: follows the Agent Skills format`, () => {
    const skill = loadSkill(name);
    assert.equal(skill.name, name, 'name matches its folder');
    assert.match(name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
    assert.ok(name.length <= 64 && !/claude|anthropic/.test(name));
    assert.ok(skill.description.length > 0 && skill.description.length <= 1024, 'description is 1–1024 characters');
    assert.doesNotMatch(skill.description, /[<>]|^(I|You|We)\b/, 'description is in the third person, without tags');
    assert.match(skill.description, /\bUse (when|whenever|in|at|before)\b/, 'description says when to use the skill');
    assert.ok(skill.body.split('\n').length <= 500, 'SKILL.md stays under 500 lines');

    assert.deepEqual(links(skill.body).filter((f) => !skill.references.includes(f)), [], 'every linked reference exists');
    assert.deepEqual(skill.references.filter((f) => !links(skill.body).includes(f)), [], 'every reference is linked from SKILL.md');
    const texts = [skill.body];
    for (const file of skill.references) {
      const text = readFileSync(join(SKILLS_DIR, name, file), 'utf8');
      assert.deepEqual(links(text), [], `${file}: references stay one level deep`);
      if (text.split('\n').length > 100) assert.match(text, /^## Contents$/m, `${file}: a long reference starts with its contents`);
      texts.push(text);
    }
    assert.deepEqual([...new Set(texts.flatMap(calls))].filter((t) => !skill.tools.includes(t)), [], 'every tool it calls is listed in metadata.tools');
  });
}

test('entry-point search patterns are valid regular expressions', () => {
  const text = readFileSync(join(SKILLS_DIR, 'reading-code/references/entry-points.md'), 'utf8');
  const patterns = [...text.matchAll(/^- [^`\n]*: `([^`]+)`/gm)].map((m) => m[1]);
  assert.ok(patterns.length > 20);
  for (const p of patterns) assert.doesNotThrow(() => new RegExp(p), p);
  assert.match("app.post('/orders/:id/cancel', cancel)", new RegExp(patterns[0]));
});

test('skillsPrompt: puts skills and asked-for references in, and refuses a skill whose tools the run lacks', () => {
  const tools = ['model', 'record', 'propose'];
  const prompt = skillsPrompt(['proposing-model-changes', 'proposing-model-changes/references/entity-elements.md'], tools);
  assert.match(prompt, /<skill name="proposing-model-changes">\n# Proposing model changes/);
  assert.match(prompt, /<reference skill="proposing-model-changes" file="references\/entity-elements.md">/);
  assert.doesNotMatch(prompt, /^---$/m, 'frontmatter stays out of the prompt');
  assert.throws(() => skillsPrompt(['reading-code'], tools), /needs tools this run doesn't have: files, search, read, quote, skill/);
});

test('skill(): reads a reference of a skill the run has, and says what exists otherwise', async () => {
  const tool = skillTool(['reading-code']);
  assert.match(await tool.run({ name: 'reading-code', file: 'references/entry-points.md' }), /^# Search patterns/);
  await assert.rejects(tool.run({ name: 'reading-code', file: '../../package.json' }), /has no file .* It has: references\/entry-points.md/);
  await assert.rejects(tool.run({ name: 'exploring-app', file: 'references/x.md' }), /No skill “exploring-app”. This run has: reading-code/);
});
