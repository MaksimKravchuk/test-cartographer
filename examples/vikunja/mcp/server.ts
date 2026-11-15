// Vikunja MCP server for the case study: data setup and read tools over the
// app's own REST API. Every project it creates is owned by `owner` and shared
// with `admin` (Admin), `writer` (Read & Write) and `reader` (Read only);
// `outsider` gets no share. `status` is derived so a state probe can match one field.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const API = (process.env.VIKUNJA_URL ?? 'http://localhost:3456') + '/api/v1';
const OWNER = { username: 'owner', password: process.env.OWNER_PASSWORD ?? 'owner-pass-123' };
const SHARES = [
  { username: 'admin', permission: 2 },
  { username: 'writer', permission: 1 },
  { username: 'reader', permission: 0 },
];

let token: string | undefined;
async function api(method: string, path: string, body?: unknown, attempt = 0): Promise<any> {
  try {
    return await call(method, path, body);
  } catch (e) {
    // shortcut: SQLite answers "database is locked" (HTTP 500) under parallel tests; use Postgres for a real test bed.
    if (attempt < 4 && String(e).includes('HTTP 500')) {
      await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
      return api(method, path, body, attempt + 1);
    }
    throw e;
  }
}

async function call(method: string, path: string, body?: unknown): Promise<any> {
  token ??= (await (await fetch(`${API}/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(OWNER) })).json()).token;
  const res = await fetch(API + path, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  // A trashed item answers 404 with code 4040 / 3017 and its trash details: that is a state, not an error.
  if (res.status === 404 && data?.details?.deleted_at) return { trashed: true, ...data.details };
  if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${JSON.stringify(data)}`);
  return data;
}

const ok = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v) }] });
const fail = (e: unknown) => ({ content: [{ type: 'text' as const, text: String(e instanceof Error ? e.message : e) }], isError: true });
const tool = (fn: (a: any) => Promise<unknown>) => async (a: any) => fn(a).then(ok, fail);

const projectView = (p: any) =>
  p.trashed ? { id: p.id, status: 'trashed', deleted_at: p.deleted_at } : { id: p.id, title: p.title, status: p.is_archived ? 'archived' : 'active', is_archived: p.is_archived, owner: p.owner?.username };
const taskView = (t: any) =>
  t.trashed ? { id: t.id, project_id: t.project_id, status: 'trashed', deleted_at: t.deleted_at, ...(t.project_id ? {} : { note: 'its project is in the trash' }) } : { id: t.id, title: t.title, project_id: t.project_id, status: t.done ? 'done' : 'open', done: t.done };

async function createProject(status: string, tag = 'tc') {
  const p = await api('PUT', '/projects', { title: `${tag} project` });
  for (const s of SHARES) await api('PUT', `/projects/${p.id}/users`, s);
  if (status === 'archived') await api('POST', `/projects/${p.id}`, { ...p, is_archived: true });
  if (status === 'trashed') await api('DELETE', `/projects/${p.id}`);
  return projectView(await api('GET', `/projects/${p.id}`));
}

const server = new McpServer({ name: 'vikunja', version: '1.0.0' });

server.registerTool(
  'create_project',
  {
    description: 'Create a test project owned by `owner`, shared with admin (Admin), writer (Read & Write), reader (Read only), in the given state. Returns { id, status }.',
    inputSchema: { status: z.enum(['active', 'archived', 'trashed']).default('active'), tag: z.string().optional() },
  },
  tool(({ status, tag }) => createProject(status, tag)),
);

server.registerTool(
  'create_task',
  {
    description: 'Create a test task in the given state. Without projectId it goes into a new active shared project (see create_project). Returns { id, project_id, status }.',
    inputSchema: {
      status: z.enum(['open', 'done', 'trashed']).default('open'),
      projectId: z.union([z.string(), z.number()]).optional().describe('Project to create the task in'),
      tag: z.string().optional(),
    },
  },
  tool(async ({ status, projectId, tag }) => {
    const pid = projectId ? Number(projectId) : (await createProject('active', tag)).id;
    // Tasks can't be created in an archived or trashed project: the project setup
    // already ran, so bring it back for a moment and put it back as it was.
    let project = await api('GET', `/projects/${pid}`);
    const wasTrashed = !!project.trashed;
    if (wasTrashed) {
      await api('POST', `/../v2/projects/${pid}/restore`); // restore exists only in API v2; fetch resolves the `..`
      project = await api('GET', `/projects/${pid}`);
    }
    if (project.is_archived) await api('POST', `/projects/${pid}`, { ...project, is_archived: false });
    const t = await api('PUT', `/projects/${pid}/tasks`, { title: `${tag ?? 'tc'} task`, done: status === 'done' });
    if (project.is_archived) await api('POST', `/projects/${pid}`, { ...project, is_archived: true });
    if (wasTrashed) await api('DELETE', `/projects/${pid}`);
    if (status === 'trashed') await api('DELETE', `/tasks/${t.id}`);
    // A task of a trashed project reads back as the project's trash notice: keep the task's own id.
    return { ...taskView(await api('GET', `/tasks/${t.id}`)), id: t.id, project_id: pid };
  }),
);

server.registerTool(
  'get_project',
  { description: 'Read a project as its owner: { id, title, status: active|archived|trashed }.', inputSchema: { id: z.union([z.string(), z.number()]) } },
  tool(async ({ id }) => projectView(await api('GET', `/projects/${id}`))),
);

server.registerTool(
  'get_task',
  { description: 'Read a task as the project owner: { id, project_id, status: open|done|trashed }.', inputSchema: { id: z.union([z.string(), z.number()]) } },
  tool(async ({ id }) => taskView(await api('GET', `/tasks/${id}`))),
);

await server.connect(new StdioServerTransport());
