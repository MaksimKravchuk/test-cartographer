import { pathToFileURL } from 'node:url';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import YAML from 'yaml';
import type { Workspace } from '@tc/model';
import { stepsAction, type Actions } from './runtime/actions.ts';

// Actions an agent wrote as steps and a person accepted: actions/generated/<name>.yaml.
export function generatedActions(ws: Workspace): Record<string, unknown> {
  const dir = ws.path('actions', 'generated');
  if (!existsSync(dir)) return {};
  return Object.fromEntries(
    readdirSync(dir).filter((f) => f.endsWith('.yaml')).sort().map((f) => [f.slice(0, -5), YAML.parse(readFileSync(`${dir}/${f}`, 'utf8'))]),
  );
}

// Loads the workspace action library: actions/index.ts plus actions/generated/
// (a hand-written entry of the same name wins). The import cache is reset by
// mtime so the GUI sees edits without restarting the engine.
export async function loadActions(ws: Workspace): Promise<Actions> {
  const file = ws.path('actions', 'index.ts');
  const own = existsSync(file)
    ? ((await import(`${pathToFileURL(file).href}?v=${statSync(file).mtimeMs}`)) as { default: Actions }).default
    : {};
  const generated = Object.fromEntries(Object.entries(generatedActions(ws)).map(([name, def]) => [name, stepsAction(def)]));
  return { ...generated, ...own };
}
