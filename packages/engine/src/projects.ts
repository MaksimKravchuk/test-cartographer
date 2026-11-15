// Projects: every project is a workspace folder. The app remembers recent
// projects, creates new ones from a template and makes sure generated tests
// and the action library can import the engine from any folder on disk.
import { existsSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type AgentProvider, Entity, Project, Workspace } from '@tc/model';

const home = () => process.env.TC_HOME ?? join(homedir(), '.test-cartographer');
const registry = () => join(home(), 'projects.json');
const enginePackage = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// `pinned` projects are favorites: they stay at the top of the switcher and are
// never dropped when the recent list is trimmed. `missing` is computed on read —
// the folder was moved or deleted outside the app.
export type RecentProject = { root: string; name: string; openedAt: string; pinned?: boolean; missing?: boolean };

const RECENT_LIMIT = 20;

async function readRegistry(): Promise<RecentProject[]> {
  try {
    return JSON.parse(await readFile(registry(), 'utf8')) as RecentProject[];
  } catch {
    return [];
  }
}

async function writeRegistry(list: RecentProject[]): Promise<void> {
  let unpinned = 0;
  const kept = list.filter((p) => p.pinned || ++unpinned <= RECENT_LIMIT).map(({ missing: _, ...p }) => p);
  await mkdir(home(), { recursive: true });
  await writeFile(registry(), JSON.stringify(kept, null, 2) + '\n');
}

export async function recentProjects(): Promise<RecentProject[]> {
  return (await readRegistry()).map((p) => (existsSync(join(p.root, 'cartographer.yaml')) ? p : { ...p, missing: true }));
}

export async function rememberProject(ws: Workspace): Promise<void> {
  const { name } = await ws.project();
  const list = await readRegistry();
  const pinned = list.find((p) => p.root === ws.root)?.pinned;
  await writeRegistry([{ root: ws.root, name, openedAt: new Date().toISOString(), ...(pinned && { pinned }) }, ...list.filter((p) => p.root !== ws.root)]);
}

export async function pinProject(root: string, pinned: boolean): Promise<void> {
  const list = await readRegistry();
  const entry = list.find((p) => p.root === root);
  if (!entry) throw new Error(`${root} is not in the project list`);
  if (pinned) entry.pinned = true;
  else delete entry.pinned;
  await writeRegistry(list);
}

// Forgetting only drops the project from the list; its folder stays where it is.
export async function forgetProject(root: string): Promise<void> {
  await writeRegistry((await readRegistry()).filter((p) => p.root !== root));
}

// Deleting a project moves its whole folder to ~/.test-cartographer/trash,
// like entities/.trash for an entity, so a misclick loses nothing.
export async function trashProject(root: string): Promise<string> {
  if (!existsSync(join(root, 'cartographer.yaml'))) throw new Error(`${root} is not a Test Cartographer project: cartographer.yaml is missing`);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = join(home(), 'trash', `${basename(root)}-${stamp}`);
  await mkdir(dirname(target), { recursive: true });
  try {
    await rename(root, target);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
    // Another volume: copy, then remove the original.
    await cp(root, target, { recursive: true, verbatimSymlinks: true });
    await rm(root, { recursive: true, force: true });
  }
  await forgetProject(root);
  return target;
}

// Generated specs import `@tc/engine/runtime` and the action library imports
// `@tc/engine/actions`. A project outside this repository gets a link to the
// engine in its own node_modules.
export async function ensureEngineLink(ws: Workspace): Promise<void> {
  try {
    createRequire(ws.path('package.json')).resolve('@tc/engine/runtime');
    return;
  } catch {
    // not resolvable from the project — link it
  }
  const target = ws.path('node_modules', '@tc', 'engine');
  await mkdir(dirname(target), { recursive: true });
  // A junction needs no admin rights on Windows; elsewhere the type is ignored.
  if (!existsSync(target)) await symlink(enginePackage, target, 'junction');
}

export async function openProject(root: string): Promise<Workspace> {
  const ws = new Workspace(resolve(expandHome(root)));
  if (!existsSync(ws.path('cartographer.yaml'))) throw new Error(`${ws.root} is not a Test Cartographer project: cartographer.yaml is missing`);
  await ws.project(); // validates
  await ensureEngineLink(ws);
  await rememberProject(ws);
  return ws;
}

const actionsTemplate = `// Action library: how each role performs a transition through its interface.
// The model refers to actions by name (\`transition.action\`, \`role.login.action\`).
import { defineActions } from '@tc/engine/actions';

export default defineActions({
  'auth.login': {
    description: 'Sign in with the role’s test account',
    async run({ page, open, args }) {
      await open('/login');
      await page.getByLabel(/email|username/i).fill(args.username);
      await page.getByLabel(/password/i).fill(args.password);
      await page.getByRole('button', { name: /sign in|log in/i }).click();
    },
  },
});
`;

// Paths typed by a person: `~/x` means their home folder.
export const expandHome = (p: string) => (p === '~' ? homedir() : p.startsWith('~/') || p.startsWith('~\\') ? join(homedir(), p.slice(2)) : p);

// What is at a folder path, so the project form can say what will happen
// before anyone presses a button: a project to open, an empty folder to create
// one in, a folder still to be made, or nothing usable.
export async function inspectFolder(input: string) {
  const path = resolve(expandHome(input.trim() || '~'));
  const st = await stat(path).catch(() => null);
  const dir = !!st?.isDirectory();
  const entries = dir ? await readdir(path, { withFileTypes: true }).catch(() => []) : [];
  const visible = entries.filter((e) => !e.name.startsWith('.'));
  let project: string | undefined;
  if (dir && existsSync(join(path, 'cartographer.yaml'))) project = await new Workspace(path).project().then((p) => p.name, () => basename(path));
  const parent = dirname(path);
  return {
    path,
    exists: !!st,
    dir,
    empty: dir && visible.length === 0,
    project,
    parent,
    parentExists: parent === path || existsSync(parent),
    home: homedir(),
    // shortcut: first 200 subfolders only, enough to browse; add paging if someone keeps thousands of folders in one place.
    children: visible.filter((e) => e.isDirectory()).map((e) => e.name).sort((a, b) => a.localeCompare(b)).slice(0, 200),
  };
}

export type NewProjectOptions = { baseUrl?: string; code?: string; provider?: AgentProvider };

export async function createProject(root: string, name: string, options: NewProjectOptions = {}): Promise<Workspace> {
  const ws = new Workspace(resolve(expandHome(root)));
  if (existsSync(ws.path('cartographer.yaml'))) throw new Error(`${ws.root} already contains a project`);
  const project = Project.parse({
    name,
    interfaces: [{ id: 'web', title: 'Web app', baseUrl: options.baseUrl ?? 'http://localhost:3000' }],
    ...(options.provider ? { runtime: { provider: options.provider } } : {}),
    roles: [
      { id: 'guest', title: 'Guest', kind: 'human', interface: 'web' },
      {
        id: 'user',
        title: 'Signed-in user',
        kind: 'human',
        interface: 'web',
        fields: [
          { id: 'login', value: '{{env.TC_USER}}' },
          { id: 'password', value: '{{env.TC_PASSWORD}}', secret: true },
        ],
        login: { action: 'auth.login', args: { username: '{{roles.user.login}}', password: '{{roles.user.password}}' } },
      },
    ],
  });
  await mkdir(ws.path('entities'), { recursive: true });
  await mkdir(ws.path('actions'), { recursive: true });
  // Through saveProject, so the history says the starting subjects came from this template.
  await ws.saveProject(project, { kind: 'template' });
  await writeFile(ws.path('actions', 'index.ts'), actionsTemplate);
  await writeFile(ws.path('package.json'), JSON.stringify({ name: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), private: true, type: 'module' }, null, 2) + '\n');
  await writeFile(ws.path('.gitignore'), 'node_modules/\nruns/\ngenerated/\nexport/\n');
  if (options.code) await ws.addLinkedSource({ kind: 'code', path: resolve(expandHome(options.code)) });
  return openProject(ws.root);
}

// Thrown by createEntity for a `partOf` that doesn't name an existing entity
// — distinct from the "already exists" error so callers can tell them apart (see server.ts).
export class UnknownParentError extends Error {}

// "line-item" → "lineItem", for the part-of relation's field name.
const camelCase = (id: string) => id.replace(/[-_]+([a-z0-9])/g, (_, c: string) => c.toUpperCase());

// A new entity starts with one variant and no states. The reader points at an
// allowed read tool named after the entity, or at a placeholder the validator
// flags until someone picks the right tool. With `partOf`, it starts nested
// under that object: a part-of relation to it, keyed by its id.
export async function createEntity(ws: Workspace, input: { id: string; title: string; description?: string; partOf?: string }): Promise<Entity> {
  if ((await ws.entityIds()).includes(input.id)) throw new Error(`Entity “${input.id}” already exists`);
  const project = await ws.project();
  const read = Object.entries(project.mcp).flatMap(([server, cfg]) => cfg.allow.read.map((t) => `${server}.${t}`));
  let relations: Entity['relations'] = [];
  if (input.partOf) {
    if (!(await ws.entityIds()).includes(input.partOf)) throw new UnknownParentError(`Entity “${input.partOf}” doesn't exist`);
    const { entity: parent } = await ws.entity(input.partOf);
    relations = [{ id: input.partOf, title: parent.title, entity: input.partOf, field: `${camelCase(input.partOf)}Id`, kind: 'part-of' }];
  }
  const entity = Entity.parse({
    ...input,
    reader: { tool: read.find((t) => t.includes(input.id.replace(/-/g, '_'))) ?? `mcp.get_${input.id.replace(/-/g, '_')}`, args: { id: '{{key}}' } },
    variants: [{ id: 'default', title: 'Default' }],
    actions: [],
    permits: [],
    relations,
  });
  await ws.saveEntity(entity);
  return entity;
}
