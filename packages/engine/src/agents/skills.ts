// Skills: the agents' working instructions, kept as Agent Skills folders
// (skills/<name>/SKILL.md plus references/) so that people can read and edit
// them and other agents can install them as they are. Our runtimes have no
// disk access, so the engine puts the skills a task needs into the system
// prompt and serves the reference files they link to through the skill() tool.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import type { Tool } from './runtime.ts';

export const SKILLS_DIR = resolve(import.meta.dirname, '../../skills');

const Frontmatter = z.object({
  name: z.string(),
  description: z.string(),
  // The engine tools the skill tells the agent to call.
  metadata: z.object({ tools: z.string().default('') }).default({ tools: '' }),
});

export type Skill = { name: string; description: string; tools: string[]; body: string; references: string[] };

export function loadSkill(name: string): Skill {
  const dir = join(SKILLS_DIR, name);
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(readFileSync(join(dir, 'SKILL.md'), 'utf8'));
  if (!m) throw new Error(`Skill “${name}” has no frontmatter`);
  const meta = Frontmatter.parse(YAML.parse(m[1]));
  const refs = join(dir, 'references');
  return {
    name: meta.name,
    description: meta.description,
    tools: meta.metadata.tools.split(/\s+/).filter(Boolean),
    body: m[2].trim(),
    references: existsSync(refs) ? readdirSync(refs).filter((f) => f.endsWith('.md')).sort().map((f) => `references/${f}`) : [],
  };
}

const reference = (skill: Skill, file: string): string => {
  if (!skill.references.includes(file)) throw new Error(`Skill “${skill.name}” has no file “${file}”. It has: ${skill.references.join(', ') || 'none'}`);
  return readFileSync(join(SKILLS_DIR, skill.name, file), 'utf8').trim();
};

// The skills section of a system prompt. An item is a skill name, or
// `<name>/references/<file>.md` to put that reference file in as well: one
// the task always needs. Throws when a skill names a tool the run doesn't
// have, so a skill can't drift away from the tools of the task that uses it.
export function skillsPrompt(items: string[], toolNames: string[]): string {
  const parts = items.map((item) => {
    const [name, ...rest] = item.split('/');
    const skill = loadSkill(name);
    if (rest.length) return `<reference skill="${name}" file="${rest.join('/')}">\n${reference(skill, rest.join('/'))}\n</reference>`;
    const missing = skill.tools.filter((t) => !toolNames.includes(t));
    if (missing.length) throw new Error(`Skill “${name}” needs tools this run doesn't have: ${missing.join(', ')}`);
    return `<skill name="${name}">\n${skill.body}\n</skill>`;
  });
  return `How to do this work is in the skills below; follow them. Where a skill links to a reference file that isn't
included here, read it with skill({ name, file }) when you reach the step that needs it.

${parts.join('\n\n')}`;
}

// Reads a reference file of one of the run's skills.
export function skillTool(names: string[]): Tool {
  return {
    name: 'skill',
    description: 'Read a reference file a skill links to, e.g. skill({ name: "reading-code", file: "references/entry-points.md" }).',
    input: z.object({ name: z.string(), file: z.string() }),
    run: async ({ name, file }: { name: string; file: string }) => {
      if (!names.includes(name)) throw new Error(`No skill “${name}”. This run has: ${names.join(', ')}`);
      return reference(loadSkill(name), file);
    },
  };
}
