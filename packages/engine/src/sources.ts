import { execFile } from 'node:child_process';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { isFileSource, type Project, type Source, type Workspace } from '@tc/model';
import { McpPool } from './mcp.ts';

export type SourceCheck = { id: string; ok: boolean; detail: string };

// Folders a code scan never descends into.
export const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next', '.turbo', '.venv', 'vendor', 'target', '.gradle', '.idea', '.cxx', '__pycache__', 'Pods', '.dart_tool']);
const MAX_FILES = 20_000;
const run = promisify(execFile);

export function codePath(root: string, path: string): string {
  const p = path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
  return isAbsolute(p) ? p : resolve(root, p);
}

// A file an agent asked for inside a code folder, by real path on both sides:
// a symlink inside the folder must not lead out of it, or to a .env file.
export async function insideCode(root: string, path: string): Promise<{ abs: string; rel: string }> {
  const realRoot = await realpath(root);
  const abs = await realpath(resolve(realRoot, path)).catch(() => {
    throw new Error(`No file “${path}”`);
  });
  const rel = relative(realRoot, abs);
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).some((part) => part.startsWith('.env'))) throw new Error(`“${path}” is outside the code folder`);
  return { abs, rel };
}

// Files an agent may read from a code folder, relative to it, optionally only
// under `sub`: what git tracks or would track (so .gitignore'd caches and build
// output stay out), else a walk that skips SKIP folders. Never .env* (secrets).
// Capped at `limit`, which is why `sub` walks only that folder: a big sibling
// (an Android tree with its caches) must not use up the cap before it.
export async function listCode(dir: string, limit = MAX_FILES, sub = ''): Promise<string[]> {
  sub = sub.replace(/\\/g, '/').replace(/[*?].*$/, '').replace(/^\.?\/+/, '').replace(/\/+$/, '');
  // The sub-folder must stay inside the source by real path (no "..", no symlink out); a missing one lists nothing.
  if (sub) {
    const inside = await insideCode(dir, sub).catch((e: Error) => (e.message.startsWith('No file') ? undefined : Promise.reject(e)));
    if (!inside) return [];
    sub = inside.rel.split(sep).join('/');
  }
  const secret = (r: string) => r.split('/').some((part) => part.startsWith('.env'));
  // An empty answer may just mean the folder itself is .gitignore'd: walk it then.
  const fromGit = (await gitFiles(dir, sub))?.filter((r) => !secret(r));
  if (fromGit?.length) return fromGit.slice(0, limit);
  const out: string[] = [];
  const walk = async (d: string, rel: string) => {
    const entries = (await readdir(d, { withFileTypes: true }).catch(() => [])).sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (out.length >= limit) return;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) await walk(join(d, e.name), r);
      } else if (e.isFile() && !e.name.startsWith('.env')) out.push(r);
    }
  };
  if (!secret(sub) && !sub.split('/').some((part) => SKIP.has(part))) await walk(sub ? join(dir, sub) : dir, sub);
  return out;
}

// Lines of a code folder matching a regular expression, as `path:line: text`, with
// what was searched: "nothing found" only means something next to that count.
// Files over 512 KB, binary files and lines over 2000 characters (minified code) are skipped.
export async function searchCode(root: string, pattern: string, opts: { dir?: string; ignoreCase?: boolean; limit?: number } = {}): Promise<string> {
  let re: RegExp;
  try {
    re = new RegExp(pattern, opts.ignoreCase ? 'i' : '');
  } catch (e) {
    throw new Error(`Bad pattern: ${(e as Error).message}`);
  }
  const limit = opts.limit ?? 100;
  const files = await listCode(root, MAX_FILES, opts.dir);
  const hits: string[] = [];
  let searched = 0;
  for (const f of files) {
    if (hits.length >= limit) break;
    const abs = join(root, f);
    if ((await stat(abs)).size > 512 * 1024) continue;
    const text = await readFile(abs, 'utf8');
    if (text.includes('\0')) continue;
    searched++;
    text.split('\n').forEach((line, i) => {
      if (hits.length < limit && line.length <= 2000 && re.test(line)) hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 300)}`);
    });
  }
  const scope = `searched ${searched} of ${files.length} files${opts.dir ? ` under ${opts.dir}` : ''}`;
  if (!hits.length) return `no match (${scope})`;
  return `${hits.join('\n')}\n(${hits.length >= limit ? `first ${limit} matches — narrow the pattern or dir; ` : ''}${scope})`;
}

// Tracked files (into submodules too) plus untracked ones .gitignore doesn't
// exclude; undefined when `dir` isn't in a git work tree or git isn't installed.
async function gitFiles(dir: string, sub: string): Promise<string[] | undefined> {
  const git = async (...args: string[]) => (await run('git', ['-C', dir, ...args, '-z', '--', sub || '.'], { maxBuffer: 256 * 1024 * 1024 })).stdout.split('\0').filter(Boolean);
  try {
    const [tracked, untracked] = await Promise.all([git('ls-files', '--cached', '--recurse-submodules'), git('ls-files', '--others', '--exclude-standard')]);
    return [...new Set([...tracked, ...untracked])].sort((a, b) => a.localeCompare(b));
  } catch {
    return undefined;
  }
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
