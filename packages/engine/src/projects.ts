// Projects: every project is a workspace folder. The app remembers recent
// projects, creates new ones from a template and makes sure generated tests
// and the action library can import the engine from any folder on disk.
import { existsSync } from 'node:fs';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Entity, Project, toYaml, Workspace } from '@tc/model';

const home = () => process.env.TC_HOME ?? join(homedir(), '.test-cartographer');
const registry = () => join(home(), 'projects.json');
const enginePackage = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export type RecentProject = { root: string; name: string; openedAt: string };

export async function recentProjects(): Promise<RecentProject[]> {
  try {
    const list = JSON.parse(await readFile(registry(), 'utf8')) as RecentProject[];
    return list.filter((p) => existsSync(join(p.root, 'cartographer.yaml')));
  } catch {
    return [];
  }
}

export async function rememberProject(ws: Workspace): Promise<void> {
  const { name } = await ws.project();
  const list = (await recentProjects()).filter((p) => p.root !== ws.root);
  list.unshift({ root: ws.root, name, openedAt: new Date().toISOString() });
  await mkdir(home(), { recursive: true });
  await writeFile(registry(), JSON.stringify(list.slice(0, 20), null, 2) + '\n');
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
  if (!existsSync(target)) await symlink(enginePackage, target, 'dir');
}

export async function openProject(root: string): Promise<Workspace> {
  const ws = new Workspace(resolve(root));
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

export async function createProject(root: string, name: string): Promise<Workspace> {
  const ws = new Workspace(resolve(root));
  if (existsSync(ws.path('cartographer.yaml'))) throw new Error(`${ws.root} already contains a project`);
  const project = Project.parse({
    name,
    interfaces: [{ id: 'web', title: 'Web app', baseUrl: 'http://localhost:3000' }],
    roles: [
      { id: 'guest', title: 'Guest', kind: 'human', interface: 'web' },
      {
        id: 'user',
        title: 'Signed-in user',
        kind: 'human',
        interface: 'web',
        login: { action: 'auth.login', args: { username: '{{env.TC_USER}}', password: '{{env.TC_PASSWORD}}' } },
      },
    ],
  });
  await mkdir(ws.path('entities'), { recursive: true });
  await mkdir(ws.path('actions'), { recursive: true });
  await writeFile(ws.path('cartographer.yaml'), toYaml(project));
  await writeFile(ws.path('actions', 'index.ts'), actionsTemplate);
  await writeFile(ws.path('package.json'), JSON.stringify({ name: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), private: true, type: 'module' }, null, 2) + '\n');
  await writeFile(ws.path('.gitignore'), 'node_modules/\nruns/\ngenerated/\nexport/\n');
  return openProject(ws.root);
}

// A new entity starts with one variant and no states. The reader points at an
// allowed read tool named after the entity, or at a placeholder the validator
// flags until someone picks the right tool.
export async function createEntity(ws: Workspace, input: { id: string; title: string; description?: string }): Promise<Entity> {
  if ((await ws.entityIds()).includes(input.id)) throw new Error(`Entity “${input.id}” already exists`);
  const project = await ws.project();
  const read = Object.entries(project.mcp).flatMap(([server, cfg]) => cfg.allow.read.map((t) => `${server}.${t}`));
  const entity = Entity.parse({
    ...input,
    reader: { tool: read.find((t) => t.includes(input.id.replace(/-/g, '_'))) ?? `mcp.get_${input.id.replace(/-/g, '_')}`, args: { id: '{{key}}' } },
    variants: [{ id: 'default', title: 'Default' }],
    actions: [],
    permits: [],
  });
  await ws.saveEntity(entity);
  return entity;
}
