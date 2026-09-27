import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { buildPlan, type RunReport, type ScenarioResult, type Workspace } from '@tc/model';
import { compile } from './compile.ts';
import { ensureEngineLink } from './projects.ts';

type PwResult = { status: string; duration: number; startTime: string; error?: { message?: string }; attachments?: { name: string; path?: string }[] };
type PwTest = { annotations: { type: string; description?: string }[]; results: PwResult[] };
type PwSpec = { tests: PwTest[] };
type PwSuite = { specs?: PwSpec[]; suites?: PwSuite[] };

function* specs(s: PwSuite): Generator<PwSpec> {
  yield* s.specs ?? [];
  for (const child of s.suites ?? []) yield* specs(child);
}

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

// ids — run only these scenarios; entity — run only this entity's scenarios.
export type RunOptions = { grep?: string; ids?: string[]; entity?: string; onLog?: (line: string) => void };

// Compiles the model, runs Playwright and saves the run report to runs/.
export async function runTests(ws: Workspace, opts: RunOptions = {}): Promise<RunReport> {
  await compile(ws);
  const id = new Date().toISOString().replace(/[:.]/g, '-');
  const startedAt = new Date().toISOString();
  const jsonFile = ws.path('runs', `${id}.playwright.json`);
  // Playwright comes from the engine, so projects anywhere on disk run the same version.
  const cli = createRequire(import.meta.url).resolve('@playwright/test/cli');
  await ensureEngineLink(ws);
  const args = [cli, 'test', '-c', ws.path('generated', 'playwright.config.ts'), '--reporter=json,line'];
  const escape = (x: string) => x.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const filters = [
    ...(opts.grep ? [opts.grep] : []),
    ...(opts.ids?.length ? [opts.ids.map((id) => `@id:${escape(id)}(\\s|$)`).join('|')] : []),
    ...(opts.entity ? [`@id:${escape(opts.entity)}/`] : []),
  ];
  if (filters.length > 1) throw new Error('Pass only one of grep, ids or entity');
  if (filters.length) args.push('--grep', filters[0]);

  await new Promise<void>((resolveRun, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: ws.root,
      env: { ...process.env, TC_RUN_ID: `run-${id}`, PLAYWRIGHT_JSON_OUTPUT_NAME: jsonFile, FORCE_COLOR: '0' },
    });
    const log = (buf: Buffer) => buf.toString().split('\n').filter(Boolean).forEach((l) => opts.onLog?.(stripAnsi(l)));
    child.stdout.on('data', log);
    child.stderr.on('data', log);
    child.on('error', reject);
    child.on('close', () => resolveRun());
  });

  const results: Record<string, ScenarioResult> = {};
  const raw = JSON.parse(await readFile(jsonFile, 'utf8')) as { suites: PwSuite[]; errors?: { message: string }[] };
  if (raw.errors?.length && !raw.suites.length) throw new Error(stripAnsi(raw.errors.map((e) => e.message).join('\n')));

  const project = await ws.project();
  const catalog = await ws.catalog();
  const blocked = new Set<string>();
  for (const eid of await ws.entityIds()) {
    const { entity } = await ws.entity(eid);
    for (const s of buildPlan(entity, project, catalog).scenarios) if (s.blocked) blocked.add(s.id);
  }

  for (const suite of raw.suites)
    for (const spec of specs(suite))
      for (const t of spec.tests) {
        const scenario = t.annotations.find((a) => a.type === 'tc-scenario')?.description;
        const r = t.results.at(-1);
        if (!scenario || !r) continue;
        const status = blocked.has(scenario) ? 'blocked' : r.status === 'passed' ? 'passed' : r.status === 'skipped' ? 'skipped' : 'failed';
        // A blocked scenario never actually runs — test.fixme() records why as a
        // 'fixme' annotation (see defineSuite() in runtime/index.ts) instead of an error.
        const fixmeReason = t.annotations.find((a) => a.type === 'fixme')?.description;
        results[scenario] = {
          status,
          durationMs: r.duration,
          at: r.startTime,
          error: r.error?.message ? stripAnsi(r.error.message) : status === 'blocked' ? fixmeReason : undefined,
          trace: r.attachments?.find((a) => a.name === 'trace')?.path,
        };
      }

  const report: RunReport = { id, startedAt, finishedAt: new Date().toISOString(), results };
  await ws.saveRun(report);
  return report;
}
