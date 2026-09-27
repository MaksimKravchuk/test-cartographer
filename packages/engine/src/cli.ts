#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { buildPlan, coverage, Workspace } from '@tc/model';
import { compile } from './compile.ts';
import { runTests } from './run.ts';
import { exportMarkdown } from './export.ts';
import { validateAll } from './checks.ts';

const usage = `Test Cartographer

  tc validate              check the model and configuration
  tc plan [entity]         show the coverage plan
  tc compile               generate Playwright tests into generated/
  tc run [--grep text]     compile, run, save the report to runs/
  tc coverage [entity]     coverage summary from the latest results
  tc export md             export scenarios to export/*.md
  tc explore <agent> [--scripted]  run an agent (--scripted: from a script, no model)
  tc serve [--port 4317]   local engine API for the GUI

  --ws <path>              workspace (default: ./workspace or TC_WORKSPACE)`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    ws: { type: 'string' },
    grep: { type: 'string' },
    port: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
    scripted: { type: 'boolean' },
  },
});

const ws = new Workspace(resolve(values.ws ?? process.env.TC_WORKSPACE ?? 'workspace'));
const [cmd, arg] = positionals;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

async function entities(only?: string) {
  const ids = only ? [only] : await ws.entityIds();
  return Promise.all(ids.map(async (id) => (await ws.entity(id)).entity));
}

switch (cmd) {
  case 'validate': {
    const issues = await validateAll(ws);
    for (const i of issues) console.log(`${i.level === 'error' ? '✖' : '⚠'} ${i.path}: ${i.message}`);
    console.log(issues.length ? plural(issues.length, 'issue') : '✔ model is consistent');
    process.exitCode = issues.some((i) => i.level === 'error') ? 1 : 0;
    break;
  }
  case 'plan': {
    const project = await ws.project();
    const catalog = await ws.catalog();
    for (const e of await entities(arg))
      for (const s of buildPlan(e, project, catalog).scenarios)
        console.log(`${s.blocked ? '⛔' : '•'} ${s.id.padEnd(44)} ${s.preparation ?? '—'}  ${s.blocked ?? s.title}`);
    break;
  }
  case 'compile': {
    const r = await compile(ws);
    console.log(`✔ ${r.scenarios} scenarios → ${r.files.join(', ')}`);
    break;
  }
  case 'run': {
    const report = await runTests(ws, { grep: values.grep, onLog: (l) => console.log(l) });
    const counts: Record<string, number> = {};
    for (const r of Object.values(report.results)) counts[r.status] = (counts[r.status] ?? 0) + 1;
    console.log(`\nReport runs/${report.id}.json:`, counts);
    process.exitCode = counts.failed ? 1 : 0;
    break;
  }
  case 'coverage': {
    const project = await ws.project();
    const catalog = await ws.catalog();
    const results = await ws.latestResults();
    for (const e of await entities(arg)) {
      const c = coverage(e, buildPlan(e, project, catalog), results);
      console.log(`\n${e.title}: ${c.totals.passed}/${c.totals.scenarios} passed, ${c.totals.failed} failed, ${c.totals.blocked} blocked, ${c.totals['not-run']} not run`);
      const mark = { passed: '✅', failed: '❌', skipped: '⏭ ', blocked: '⛔', 'not-run': '⚪' };
      console.log('  ' + ''.padEnd(28) + c.variants.map((v) => v.padEnd(10)).join(''));
      for (const t of [...c.transitions, ...c.forbidden, ...c.rules, ...c.journeys])
        console.log('  ' + t.id.padEnd(28) + c.variants.map((v) => (t.cells[v] ? mark[t.cells[v]!.status] : ' ·').padEnd(10)).join(''));
    }
    break;
  }
  case 'export': {
    const files = await exportMarkdown(ws);
    console.log(`✔ ${files.join(', ')}`);
    break;
  }
  case 'explore': {
    const { explore } = await import('./agents/explore.ts');
    const p = await explore(ws, arg, { onLog: (l) => console.log(l), provider: values.scripted ? 'scripted' : 'live' });
    console.log(`\n✔ proposal ${p.id}: ${plural(p.ops.length, 'change')}, ${plural(p.findings.length, 'finding')}`);
    break;
  }
  case 'serve': {
    const { serve } = await import('./server.ts');
    await serve(ws, Number(values.port ?? 4317));
    break;
  }
  default:
    console.log(usage);
}
