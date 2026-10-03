// Local engine API. The GUI (Electron or browser) works only through it;
// the workspace files are the source of truth.
import { Hono } from 'hono';
import { serve as serveHttp } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { streamSSE } from 'hono/streaming';
import { watch, existsSync, type FSWatcher } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AgentProvider, applyDecisions, applyProjectDecisions, Backlog, backlogCoverage, buildPlan, conflicts, coverage, Decision, Entity, Project,
  RevisionConflict, SourceKind, validateBacklog, validateEntity, validateProject, type ProjectState, type Workspace,
} from '@tc/model';
import { z } from 'zod';
import { loadActions } from './actions-loader.ts';
import { runTests } from './run.ts';
import { exportMarkdown } from './export.ts';
import { explore } from './agents/explore.ts';
import { onboard } from './agents/onboard.ts';
import { cursorLogin, runtimeStatus, testRuntime } from './agents/runtime.ts';
import { createEntity, createProject, openProject, recentProjects, rememberProject } from './projects.ts';

type Event =
  | { type: 'log'; job: string; line: string }
  | { type: 'job'; job: string; kind: string; state: 'running' | 'done' | 'failed'; result?: unknown; error?: string }
  | { type: 'changed'; path: string }
  | { type: 'project'; root: string };

// The engine serves one project at a time; the GUI can switch it.
export function createApp(initial: Workspace) {
  let ws = initial;
  const app = new Hono();
  const listeners = new Set<(e: Event) => void>();
  const emit = (e: Event) => listeners.forEach((l) => l(e));
  const jobs = new Map<string, { kind: string; state: string; controller: AbortController }>();

  // Changes to workspace files (git pull, edits in an editor) show up in the GUI immediately.
  let pending: NodeJS.Timeout | undefined;
  const changed = new Set<string>();
  let watcher: FSWatcher | undefined;
  const watchProject = () => {
    watcher?.close();
    try {
      watcher = watch(ws.root, { recursive: true }, (_ev, file) => {
        if (!file || /^(runs|generated|evidence|node_modules|export)\//.test(file)) return;
        changed.add(file);
        clearTimeout(pending);
        pending = setTimeout(() => {
          for (const path of changed) emit({ type: 'changed', path });
          changed.clear();
        }, 150);
      });
    } catch {
      // Recursive fs.watch is unavailable — the GUI will refresh on user actions.
    }
  };
  watchProject();
  void rememberProject(ws).catch(() => {});

  const switchTo = (next: Workspace) => {
    if ([...jobs.values()].some((j) => j.state === 'running')) throw new HttpError(409, 'Wait for the running job to finish before switching projects');
    ws = next;
    watchProject();
    emit({ type: 'project', root: ws.root });
  };

  const startJob = (kind: string, fn: (log: (l: string) => void, signal: AbortSignal) => Promise<unknown>) => {
    for (const j of jobs.values()) if (j.kind === kind && j.state === 'running') throw new HttpError(409, `Job “${kind}” is already running`);
    const id = `${kind}-${Date.now().toString(36)}`;
    const controller = new AbortController();
    jobs.set(id, { kind, state: 'running', controller });
    emit({ type: 'job', job: id, kind, state: 'running' });
    fn((line) => emit({ type: 'log', job: id, line }), controller.signal)
      .then((result) => {
        jobs.get(id)!.state = 'done';
        emit({ type: 'job', job: id, kind, state: 'done', result });
      })
      .catch((e: Error) => {
        jobs.get(id)!.state = 'failed';
        emit({ type: 'job', job: id, kind, state: 'failed', error: e.message });
      });
    return id;
  };

  const entityState = async (id: string) => {
    const project = await ws.project();
  const catalog = await ws.catalog();
    const { entity, revision } = await ws.entity(id);
    const actions = await loadActions(ws).catch(() => ({}));
    const plan = buildPlan(entity, project, catalog);
    const latest = await ws.latestResults();
    return {
      entity,
      revision,
      layout: await ws.layout(id),
      issues: validateEntity(entity, project, new Set(Object.keys(actions)), catalog),
      plan,
      coverage: coverage(entity, plan, latest, project),
      results: Object.fromEntries(plan.scenarios.flatMap((sc) => (latest[sc.id] ? [[sc.id, latest[sc.id]]] : []))),
      // Titles, states and variants of every entity, for relation editors.
      catalog: Object.fromEntries(
        Object.values(catalog).map((e) => [
          e.id,
          { title: e.title, states: e.states.map((x) => ({ id: x.id, title: x.title })), variants: e.variants.map((x) => ({ id: x.id, title: x.title })) },
        ]),
      ),
    };
  };

  app.onError((err, c) => {
    const status = err instanceof HttpError ? err.status : err instanceof RevisionConflict ? 409 : err instanceof z.ZodError ? 400 : 500;
    return c.json({ error: err instanceof z.ZodError ? z.prettifyError(err) : err.message }, status as 400);
  });

  app.get('/api/project', async (c) => {
    const project = await ws.project();
  const catalog = await ws.catalog();
    const actions = await loadActions(ws).catch(() => ({}));
    return c.json({
      root: ws.root,
      project,
      issues: validateProject(project, new Set(Object.keys(actions))),
      entities: await ws.entityIds(),
      actions: Object.entries(actions).map(([name, a]) => ({ name, description: a.description ?? '', checksAvailability: !!a.available })),
      jobs: [...jobs].map(([id, j]) => ({ id, kind: j.kind, state: j.state })),
    });
  });

  app.put('/api/project', async (c) => {
    const { project } = z.object({ project: Project }).parse(await c.req.json());
    await ws.saveProject(project);
    return c.json({ ok: true });
  });

  app.get('/api/projects', async (c) => c.json({ current: ws.root, recent: await recentProjects() }));

  app.post('/api/projects/open', async (c) => {
    const { root } = z.object({ root: z.string().min(1) }).parse(await c.req.json());
    switchTo(await openProject(root).catch((e: Error) => { throw new HttpError(400, e.message); }));
    return c.json({ root: ws.root });
  });

  app.post('/api/projects/create', async (c) => {
    const { root, name } = z.object({ root: z.string().min(1), name: z.string().min(1) }).parse(await c.req.json());
    switchTo(await createProject(root, name).catch((e: Error) => { throw new HttpError(400, e.message); }));
    return c.json({ root: ws.root });
  });

  // The entity catalog: one row per entity with its size and test status.
  app.get('/api/entities', async (c) => {
    const project = await ws.project();
  const catalog = await ws.catalog();
    const results = await ws.latestResults();
    const proposals = await ws.proposals();
    const out = [];
    for (const id of await ws.entityIds()) {
      const { entity } = await ws.entity(id);
      const plan = buildPlan(entity, project, catalog);
      const cov = coverage(entity, plan, results, project);
      out.push({
        id,
        title: entity.title,
        description: entity.description ?? '',
        counts: {
          variants: entity.variants.filter((v) => v.status === 'confirmed').length,
          states: entity.states.filter((s) => s.status === 'confirmed').length,
          actions: entity.actions.filter((a) => a.status === 'confirmed').length,
          transitions: entity.transitions.filter((t) => t.status === 'confirmed').length,
          permits: entity.permits.filter((p) => p.status === 'confirmed').length,
          rules: entity.rules.filter((r) => r.status === 'confirmed').length,
          journeys: entity.scenarios.filter((j) => j.status === 'confirmed').length,
          observations: [...entity.states, ...entity.actions, ...entity.transitions, ...entity.permits, ...entity.rules].filter((x) => x.status === 'observed').length,
        },
        totals: cov.totals,
        relations: entity.relations.map((r) => ({
          id: r.id,
          entity: r.entity,
          title: catalog[r.entity]?.title ?? r.entity,
          requires: catalog[r.entity]?.states.find((x) => x.id === r.requires)?.title ?? r.requires ?? null,
        })),
        pendingProposals: proposals.filter((p) => p.entity === id && p.status === 'pending').length,
        errors: validateEntity(entity, project, undefined, catalog).filter((i) => i.level === 'error').length,
      });
    }
    return c.json(out);
  });

  app.post('/api/entities', async (c) => {
    const input = z.object({ id: z.string().regex(/^[a-z][a-z0-9_-]*$/), title: z.string().min(1), description: z.string().optional() }).parse(await c.req.json());
    const entity = await createEntity(ws, input).catch((e: Error) => { throw new HttpError(409, e.message); });
    return c.json(await entityState(entity.id));
  });

  app.delete('/api/entities/:id', async (c) => {
    await ws.trashEntity(c.req.param('id'));
    return c.json({ ok: true });
  });

  app.get('/api/entities/:id', async (c) => c.json(await entityState(c.req.param('id'))));

  app.put('/api/entities/:id', async (c) => {
    const body = z.object({ entity: Entity, revision: z.string() }).parse(await c.req.json());
    if (body.entity.id !== c.req.param('id')) throw new HttpError(400, 'Entity id does not match the URL');
    await ws.saveEntity(body.entity, body.revision);
    return c.json(await entityState(body.entity.id));
  });

  app.put('/api/entities/:id/layout', async (c) => {
    await ws.saveLayout(c.req.param('id'), z.record(z.string(), z.object({ x: z.number(), y: z.number() })).parse(await c.req.json()));
    return c.json({ ok: true });
  });

  // Knowledge sources: what onboarding reads. Text only — the workspace keeps
  // docs, tracker exports, contracts and notes as plain files it can diff.
  app.get('/api/sources', async (c) => {
    const list = await ws.sources();
    const out = await Promise.all(
      list.map(async (s) => {
        const text = await ws.sourceText(s.id);
        return { ...s, lines: text.split('\n').length, size: Buffer.byteLength(text, 'utf8') };
      }),
    );
    return c.json({ sources: out });
  });

  app.post('/api/sources', async (c) => {
    const input = z.object({ name: z.string().min(1), content: z.string(), kind: SourceKind.optional(), title: z.string().optional() }).parse(await c.req.json());
    const source = await ws.addSource(input).catch((e: Error) => {
      throw new HttpError(400, e.message);
    });
    return c.json(source);
  });

  app.get('/api/sources/:id', async (c) => {
    const id = c.req.param('id');
    const source = (await ws.sources()).find((s) => s.id === id);
    if (!source) return c.notFound();
    return c.json({ source, text: await ws.sourceText(id) });
  });

  app.delete('/api/sources/:id', async (c) => {
    await ws.removeSource(c.req.param('id')).catch((e: Error) => {
      throw new HttpError(404, e.message);
    });
    return c.json({ ok: true });
  });

  // The backlog: epics/features/stories, and their coverage over the model.
  app.get('/api/backlog', async (c) => {
    const project = await ws.project();
    const catalog = await ws.catalog();
    const { backlog, revision } = await ws.backlog();
    const plans: Record<string, ReturnType<typeof buildPlan>> = {};
    for (const id of await ws.entityIds()) plans[id] = buildPlan((await ws.entity(id)).entity, project, catalog);
    const results = await ws.latestResults();
    return c.json({
      backlog,
      revision,
      coverage: backlogCoverage(backlog, project, catalog, plans, results),
      issues: validateBacklog(backlog, catalog),
    });
  });

  app.put('/api/backlog', async (c) => {
    const { backlog, revision } = z.object({ backlog: Backlog, revision: z.string() }).parse(await c.req.json());
    return c.json({ revision: await ws.saveBacklog(backlog, revision) });
  });

  app.get('/api/proposals', async (c) => {
    const list = await ws.proposals();
    const project = await ws.project();
    const { backlog, revision: backlogRevision } = await ws.backlog();
    const entityIds = await ws.entityIds();
    const state: ProjectState = { project, backlog, entityIds };
    const out = [];
    for (const p of list) {
      if (!p.entity) {
        out.push({ ...p, stale: p.baseRevision !== backlogRevision, conflicts: p.status === 'pending' ? conflicts(state, p) : [] });
        continue;
      }
      if (!entityIds.includes(p.entity)) {
        out.push({ ...p, stale: false, conflicts: p.status === 'pending' ? conflicts(undefined, p) : [] });
        continue;
      }
      const { entity, revision } = await ws.entity(p.entity);
      out.push({ ...p, stale: p.baseRevision !== revision, conflicts: p.status === 'pending' ? conflicts(entity, p) : [] });
    }
    return c.json(out);
  });

  app.post('/api/proposals/:id/decide', async (c) => {
    const { decisions } = z.object({ decisions: z.array(Decision) }).parse(await c.req.json());
    const proposal = await ws.proposal(c.req.param('id'));
    if (proposal.status !== 'pending') throw new HttpError(409, 'The proposal has already been decided');

    if (!proposal.entity) {
      const project = await ws.project();
      const { backlog, revision: backlogRevision } = await ws.backlog();
      const entityIds = await ws.entityIds();
      const { project: nextProject, backlog: nextBacklog, created } = applyProjectDecisions({ project, backlog, entityIds }, proposal, decisions);
      // Most project-level proposals only touch the backlog or add entities —
      // don't rewrite cartographer.yaml (and disturb its comments/mtime) unless
      // an applied op actually changed roles or interfaces.
      if (JSON.stringify(nextProject) !== JSON.stringify(project)) await ws.saveProject(nextProject);
      await ws.saveBacklog(nextBacklog, backlogRevision || undefined);
      for (const e of created) await ws.saveEntity(e);
      // applyProjectDecisions only validates an accepted `entity` update (it
      // doesn't have the entity file) — merge its fields into that file here.
      for (const d of decisions) {
        const op = proposal.ops[d.op];
        if (op?.kind === 'entity' && op.op === 'update' && d.verdict === 'accept') {
          const { entity, revision } = await ws.entity(op.id);
          await ws.saveEntity(Entity.parse({ ...entity, ...op.set }), revision);
        }
      }
      await ws.saveProposal({ ...proposal, status: 'decided', decisions, decidedAt: new Date().toISOString() });
      return c.json({ project: nextProject, backlog: nextBacklog, created: created.map((e) => e.id) });
    }

    if (!(await ws.entityIds()).includes(proposal.entity))
      throw new HttpError(409, `Entity “${proposal.entity}” doesn't exist yet — accept it in the project proposal first`);
    const { entity, revision } = await ws.entity(proposal.entity);
    const next = applyDecisions(entity, proposal, decisions);
    await ws.saveEntity(next, revision);
    await ws.saveProposal({ ...proposal, status: 'decided', decisions, decidedAt: new Date().toISOString() });
    return c.json(await entityState(proposal.entity));
  });

  app.post('/api/runs', async (c) => {
    const opts = z
      .object({ grep: z.string().optional(), ids: z.array(z.string()).optional(), entity: z.string().optional() })
      .parse(await c.req.json().catch(() => ({})));
    const job = startJob('run', async (log) => {
      const r = await runTests(ws, { ...opts, onLog: log });
      return { id: r.id, results: Object.keys(r.results).length };
    });
    return c.json({ job });
  });

  app.post('/api/agents/:id/explore', async (c) => {
    const { provider } = z.object({ provider: z.enum(['live', 'scripted']).default('live') }).parse(await c.req.json().catch(() => ({})));
    const agent = c.req.param('id');
    const job = startJob(`explore:${agent}`, async (log, signal) => {
      const p = await explore(ws, agent, { onLog: log, provider, signal });
      return { proposal: p.id, ops: p.ops.length, findings: p.findings.length };
    });
    return c.json({ job });
  });

  // Dispatches by the agent's own kind — explore keeps the alias above for callers who already know it's an explorer.
  app.post('/api/agents/:id/run', async (c) => {
    const { provider } = z.object({ provider: z.enum(['live', 'scripted']).default('live') }).parse(await c.req.json().catch(() => ({})));
    const id = c.req.param('id');
    const agent = (await ws.project()).agents.find((a) => a.id === id);
    if (!agent) throw new HttpError(404, `Agent “${id}” is not defined in cartographer.yaml`);
    if (agent.kind === 'onboard') {
      const job = startJob(`onboard:${id}`, async (log, signal) => {
        const proposals = await onboard(ws, id, { onLog: log, provider, signal });
        return { proposals: proposals.map((p) => p.id), ops: proposals.reduce((n, p) => n + p.ops.length, 0), findings: proposals.reduce((n, p) => n + p.findings.length, 0) };
      });
      return c.json({ job });
    }
    const job = startJob(`explore:${id}`, async (log, signal) => {
      const p = await explore(ws, id, { onLog: log, provider, signal });
      return { proposal: p.id, ops: p.ops.length, findings: p.findings.length };
    });
    return c.json({ job });
  });

  // The configured onboarding agent (or the built-in default, if none is set up yet).
  app.post('/api/onboarding/run', async (c) => {
    const { provider } = z.object({ provider: z.enum(['live', 'scripted']).default('live') }).parse(await c.req.json().catch(() => ({})));
    const job = startJob('onboard', async (log, signal) => {
      const proposals = await onboard(ws, undefined, { onLog: log, provider, signal });
      return { proposals: proposals.map((p) => p.id), ops: proposals.reduce((n, p) => n + p.ops.length, 0), findings: proposals.reduce((n, p) => n + p.findings.length, 0) };
    });
    return c.json({ job });
  });

  // Claude Code and Codex as signed in on this machine — no prompt is sent.
  app.get('/api/runtimes', async (c) => c.json(await runtimeStatus()));

  app.post('/api/runtimes/:provider/test', async (c) => {
    const provider = AgentProvider.parse(c.req.param('provider'));
    const { model } = z.object({ model: z.string().optional() }).parse(await c.req.json().catch(() => ({})));
    const job = startJob(`test:${provider}`, (log, signal) => testRuntime(provider, model, log, signal));
    return c.json({ job });
  });

  // Cursor signs in through its SDK: the engine opens the login page in the
  // browser and the job ends when the user has finished there.
  app.post('/api/runtimes/cursor/login', (c) => {
    const job = startJob('login:cursor', async (log, signal) => {
      const email = await cursorLogin((url) => log(`Opened ${url} — finish signing in there.`), signal);
      log(`✓ signed in${email ? ` as ${email}` : ''}`);
      return { email };
    });
    return c.json({ job });
  });

  app.post('/api/jobs/:id/cancel', (c) => {
    jobs.get(c.req.param('id'))?.controller.abort();
    return c.json({ ok: true });
  });

  app.post('/api/export/markdown', async (c) => {
    const files = await exportMarkdown(ws);
    return c.json({ files: await Promise.all(files.map(async (f) => ({ path: f, content: await readFile(ws.path(f), 'utf8') }))) });
  });

  // Agent evidence: screenshots, snapshots, read results.
  app.get('/api/files/evidence/*', async (c) => {
    const rel = c.req.path.replace(/^\/api\/files\//, '');
    const file = resolve(ws.root, decodeURIComponent(rel));
    if (relative(ws.path('evidence'), file).startsWith('..')) throw new HttpError(400, 'bad path');
    if (!existsSync(file)) return c.notFound();
    const type = file.endsWith('.png') ? 'image/png' : file.endsWith('.json') ? 'application/json' : 'text/plain; charset=utf-8';
    return c.body(await readFile(file), 200, { 'content-type': type });
  });

  app.get('/api/events', (c) =>
    streamSSE(c, async (stream) => {
      const send = (e: Event) => void stream.writeSSE({ data: JSON.stringify(e) });
      listeners.add(send);
      stream.onAbort(() => {
        listeners.delete(send);
      });
      while (!stream.aborted) await stream.sleep(15_000).then(() => stream.writeSSE({ event: 'ping', data: '' }));
    }),
  );

  // The built GUI (apps/desktop/dist), if present.
  const dist = resolve(dirname(fileURLToPath(import.meta.url)), '../../../apps/desktop/dist');
  if (existsSync(dist)) {
    app.use('/*', serveStatic({ root: relative(process.cwd(), dist) }));
    app.get('*', async (c) => c.html(await readFile(resolve(dist, 'index.html'), 'utf8')));
  }

  return app;
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function serve(ws: Workspace, port: number): Promise<void> {
  return new Promise((ok) => {
    serveHttp({ fetch: createApp(ws).fetch, port, hostname: '127.0.0.1' }, (info) => {
      console.log(`Test Cartographer engine: http://127.0.0.1:${info.port}  (workspace ${ws.root})`);
      ok();
    });
  });
}
