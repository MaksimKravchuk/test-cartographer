import { readdir, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { isFileSource, type Project, type Source, type Workspace } from '@tc/model';
import { McpPool } from './mcp.ts';

export type SourceCheck = { id: string; ok: boolean; detail: string };

// Folders a code scan never descends into.
export const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next', '.turbo', '.venv', 'vendor', 'target']);
const MAX_FILES = 20_000;

export function codePath(root: string, path: string): string {
  const p = path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
  return isAbsolute(p) ? p : resolve(root, p);
}

// Files an agent may read from a code folder: not in SKIP folders, not .env*
// (secrets), relative to the folder. Capped at `limit`.
export async function listCode(dir: string, limit = MAX_FILES): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string, rel: string) => {
    const entries = (await readdir(d, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (out.length >= limit) return;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) await walk(join(d, e.name), r);
      } else if (e.isFile() && !e.name.startsWith('.env')) out.push(r);
    }
  };
  await walk(dir, '');
  return out;
}

async function countFiles(dir: string): Promise<number> {
  return (await listCode(dir)).length;
}

function describe(result: unknown): string {
  if (Array.isArray(result)) return `${result.length} items`;
  if (result && typeof result === 'object') {
    const list = Object.values(result).find(Array.isArray);
    if (list) return `${list.length} items`;
  }
  return `${String(typeof result === 'string' ? result : JSON.stringify(result)).length} chars`;
}

// Proves an agent will be able to read each source, through the same channel
// the engine will serve it over: the uploaded file, the folder on disk, or one
// allowed read call to the MCP server. It can't see what a token isn't allowed
// to see — the counts in `detail` are there so a person notices what's missing.
export async function checkSources(ws: Workspace, project: Project, only?: string): Promise<SourceCheck[]> {
  const sources = (await ws.sources()).filter((s) => !only || s.id === only);
  const mcp = new McpPool(project, ws.root);
  try {
    return await Promise.all(sources.map((s) => checkOne(ws, mcp, s)));
  } finally {
    await mcp.close();
  }
}

async function checkOne(ws: Workspace, mcp: McpPool, s: Source): Promise<SourceCheck> {
  const fail = (detail: string) => ({ id: s.id, ok: false, detail });
  try {
    if (isFileSource(s)) {
      const text = await ws.sourceText(s.id);
      return { id: s.id, ok: true, detail: `${text.split('\n').length} lines` };
    }
    if (s.kind === 'code') {
      const dir = codePath(ws.root, s.path!);
      if (!(await stat(dir).catch(() => null))?.isDirectory()) return fail(`No folder at ${dir}`);
      const n = await countFiles(dir);
      return { id: s.id, ok: n > 0, detail: n === 0 ? `${dir} has no files` : `${n >= MAX_FILES ? `${MAX_FILES}+` : n} files` };
    }
    const result = await mcp.call(s.read!.tool, s.read!.args, 'read');
    return { id: s.id, ok: true, detail: describe(result) };
  } catch (e) {
    return fail((e as Error).message);
  }
}
