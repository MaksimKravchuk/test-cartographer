import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import type { Workspace } from '@tc/model';
import type { Actions } from './runtime/actions.ts';

// Loads the workspace action library (actions/index.ts). The import cache
// is reset by mtime so the GUI sees edits without restarting the engine.
export async function loadActions(ws: Workspace): Promise<Actions> {
  const file = ws.path('actions', 'index.ts');
  if (!existsSync(file)) return {};
  const { statSync } = await import('node:fs');
  const url = `${pathToFileURL(file).href}?v=${statSync(file).mtimeMs}`;
  return ((await import(url)) as { default: Actions }).default;
}
