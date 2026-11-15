#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { AgentProvider, backlogCoverage, buildPlan, coverage, type Totals, Workspace } from '@tc/model';
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
  tc explore <agent> [--scripted]  run an explorer agent (--scripted: from a script, no model)
  tc onboard [agent] [--scripted]  run the onboarding agent over the knowledge sources
  tc backlog               show epics → features → stories, with totals and unmapped stories
  tc runtimes              sign-in state of the runtimes agents run in: Claude Code, Codex, Copilot, Cursor
  tc runtimes test <provider> [--model m]  short end-to-end run: sign-in, MCP bridge, tool calls
  tc runtimes login cursor sign in to Cursor in the browser
  tc serve [--port 4317] [--open]  local engine API and the web GUI (--open: in your browser)

  --ws <path>              workspace (default: ./workspace or TC_WORKSPACE)`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    ws: { type: 'string' },
    grep: { type: 'string' },
    port: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
    scripted: { type: 'boolean' },
    model: { type: 'string' },
    open: { type: 'boolean' },
  },
});

const ws = new Workspace(resolve(values.ws ?? process.env.TC_WORKSPACE ?? 'workspace'));
const [cmd, arg] = positionals;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

// The default browser on macOS, Windows and Linux.
function openInBrowser(url: string) {
  const [command, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  spawn(command, args, { stdio: 'ignore', detached: true }).on('error', () => console.log(`Open ${url} in your browser.`)).unref();
}

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
    const kinds = ['transition', 'permit', 'deny', 'journey', 'rule'] as const;
    for (const e of await entities(arg)) {
      const scenarios = buildPlan(e, project, catalog).scenarios;
      console.log(`\n${e.title}`);
      for (const kind of kinds) {
        const group = scenarios.filter((s) => s.kind === kind);
        if (!group.length) continue;
        console.log(`  ${kind} (${plural(group.length, 'scenario')})`);
        for (const s of group) console.log(`    ${s.blocked ? '⛔' : '•'} ${s.id.padEnd(42)} ${s.preparation ?? '—'}  ${s.blocked ?? s.title}`);
      }
    }
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
    const mark: Record<string, string> = { passed: '✅', failed: '❌', skipped: '⏭ ', blocked: '⛔', 'not-run': '⚪' };
    for (const e of await entities(arg)) {
      const c = coverage(e, buildPlan(e, project, catalog), results, project);
      console.log(`\n${e.title}: ${c.totals.passed}/${c.totals.scenarios} passed, ${c.totals.failed} failed, ${c.totals.blocked} blocked, ${c.totals['not-run']} not run`);
      console.log('  ' + ''.padEnd(28) + c.variants.map((v) => v.padEnd(10)).join(''));
      for (const t of [...c.transitions, ...c.permits, ...c.rules, ...c.journeys])
        console.log('  ' + t.id.padEnd(28) + c.variants.map((v) => (t.cells[v] ? mark[t.cells[v]!.status] : ' ·').padEnd(10)).join(''));

      // Closed-world access matrix: per-variant counts, plus the denied cells' own results.
      for (const v of c.variants) {
        const rows = c.access.flatMap((a) => (a.cells[v] ? [{ ...a, cell: a.cells[v]! }] : []));
        const counts = { allowed: 0, undecided: 0, denied: 0 };
        for (const r of rows) counts[r.cell.decision]++;
        console.log(`  access [${v}]: ${counts.allowed} allowed, ${counts.undecided} undecided, ${counts.denied} denied`);
        for (const r of rows) {
          if (r.cell.decision !== 'denied') continue;
          console.log(`    ${r.cell.result ? mark[r.cell.result.status] : '⚪'} ${r.role} “${r.action}” @ ${r.state}`);
        }
      }
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
  case 'runtimes': {
    const { cursorLogin, runtimeStatus, runtimeTitle, testRuntime } = await import('./agents/runtime.ts');
    if (arg === 'login') {
      if (positionals[2] !== 'cursor') throw new Error('Only Cursor signs in from here: Claude Code — `claude auth login`, Codex — `codex login`, Copilot — `gh auth login`');
      const email = await cursorLogin((url) => console.log(`Opened ${url} — finish signing in there.`));
      console.log(`✔ signed in to Cursor${email ? ` as ${email}` : ''}`);
      break;
    }
    const configured = (await ws.project().catch(() => undefined))?.runtime;
    const endpoint = configured?.baseUrl;
    if (arg === 'test') {
      const provider = AgentProvider.parse(positionals[2]);
      // The project's model, unless --model says otherwise: an endpoint serves only the models it has.
      const model = values.model ?? (configured?.provider === provider ? configured.model : undefined);
      const r = await testRuntime(provider, model, (l) => console.log(l), undefined, endpoint);
      console.log(`\n${r.ok ? '✔' : '✘'} ${provider} in ${r.seconds}s`);
      if (!r.ok) process.exitCode = 1;
      break;
    }
    for (const s of await runtimeStatus(endpoint)) {
      const who = [s.account, s.plan, s.version && `v${s.version}`].filter(Boolean).join(' · ');
      console.log(`${s.ready ? '✔' : '✘'} ${runtimeTitle(s.provider)}${who ? ` — ${who}` : ''}`);
      if (s.detail) console.log(`  ${s.detail}`);
      if (s.models.length) console.log(`  models: ${s.models.map((m) => m.id).join(', ')}`);
    }
    break;
  }
  case 'onboard': {
    const { onboard } = await import('./agents/onboard.ts');
    const proposals = await onboard(ws, arg, { onLog: (l) => console.log(l), provider: values.scripted ? 'scripted' : 'live' });
    for (const p of proposals)
      console.log(`\n✔ proposal ${p.id}${p.entity ? ` (${p.entity})` : ' (project)'}: ${plural(p.ops.length, 'change')}, ${plural(p.findings.length, 'finding')}`);
    break;
  }
  case 'backlog': {
    const project = await ws.project();
    const catalog = await ws.catalog();
    const { backlog } = await ws.backlog();
    const plans = Object.fromEntries(await Promise.all((await ws.entityIds()).map(async (id) => [id, buildPlan((await ws.entity(id)).entity, project, catalog)] as const)));
    const results = await ws.latestResults();
    const cov = backlogCoverage(backlog, project, catalog, plans, results);
    const line = (t: Totals) => `${t.passed}/${t.scenarios} passed, ${t.failed} failed, ${t.blocked} blocked, ${t['not-run']} not run`;
    for (const epic of cov.epics) {
      console.log(`\n${epic.title}${epic.key ? ` (${epic.key})` : ''} — ${line(epic.totals)}`);
      for (const feature of epic.features) {
        console.log(`  ${feature.title}${feature.key ? ` (${feature.key})` : ''} — ${line(feature.totals)}`);
        for (const story of feature.stories) console.log(`    • ${story.title}${story.key ? ` (${story.key})` : ''} — ${line(story.totals)}`);
      }
      for (const story of epic.stories) console.log(`  • ${story.title}${story.key ? ` (${story.key})` : ''} — ${line(story.totals)}`);
    }
    if (cov.orphanFeatures.length) {
      console.log('\nOrphan features (no epic)');
      for (const f of cov.orphanFeatures) console.log(`  ${f.title}${f.key ? ` (${f.key})` : ''} — ${line(f.totals)}`);
    }
    if (cov.orphanStories.length) {
      console.log('\nOrphan stories (no feature or epic)');
      for (const s of cov.orphanStories) console.log(`  ${s.title}${s.key ? ` (${s.key})` : ''} — ${line(s.totals)}`);
    }
    console.log(`\nUnmapped stories (${cov.unmappedStories.length}): ${cov.unmappedStories.join(', ') || 'none'}`);
    break;
  }
  case 'serve': {
    const { serve } = await import('./server.ts');
    const url = await serve(ws, Number(values.port ?? 4317));
    if (values.open) openInBrowser(url);
    break;
  }
  default:
    console.log(usage);
}
