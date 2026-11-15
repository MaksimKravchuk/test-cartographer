#!/usr/bin/env node
// Runs one Arazzo workflow with Redocly Respect and prints its outputs (JSON),
// so a chain of API calls can be a command tool (see command-tools.ts):
//
//   tools:
//     order_from_listing:
//       description: Publish a listing and place an order for it. Prints { orderId, listingId, total }.
//       command: node
//       args: [<engine>/src/arazzo-tool.ts, order.arazzo.yaml, orderFromListing]
//       input: { properties: { status: { type: string } }, required: [status] }
//
// Inputs come as JSON on stdin and go to the workflow as its `inputs`. Respect's
// JSON log has the step responses but not the outputs, so they are resolved here.
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { text } from 'node:stream/consumers';
import { parse } from 'yaml';

const RESPECT = ['--yes', '@redocly/cli@2.78.0', 'respect'];

type Step = { stepId: string; outputs?: Record<string, string> };
export type Workflow = { workflowId: string; steps: Step[]; outputs?: Record<string, string> };
type Executed = { stepId: string; status: string; response?: { statusCode: number; body: unknown }; checks?: { passed: boolean; message: string }[] };

const pointer = (value: unknown, ptr: string) =>
  ptr
    .split('/')
    .slice(1)
    .map((k) => k.replace(/~1/g, '/').replace(/~0/g, '~'))
    .reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), value);

// shortcut: only `$steps.<id>.outputs.<name>` over `$statusCode` / `$response.body[#/ptr]`; extend when a workflow needs more.
export function resolveOutputs(wf: Workflow, executed: Executed[]): Record<string, unknown> {
  const stepValue = (stepId: string, name: string) => {
    const expr = wf.steps.find((s) => s.stepId === stepId)?.outputs?.[name];
    const res = executed.findLast((e) => e.stepId === stepId)?.response;
    if (!expr || !res) return undefined;
    if (expr === '$statusCode') return res.statusCode;
    const m = /^\$response\.body(?:#(\/.*))?$/.exec(expr);
    return m ? (m[1] ? pointer(res.body, m[1]) : res.body) : undefined;
  };
  return Object.fromEntries(
    Object.entries(wf.outputs ?? {}).map(([k, expr]) => {
      const m = /^\$steps\.([^.]+)\.outputs\.(.+)$/.exec(expr);
      return [k, m ? stepValue(m[1], m[2]) : undefined];
    }),
  );
}

async function main(file: string, workflowId: string) {
  // shortcut: npx.cmd needs a shell on Windows, which would mangle the JSON input; add a Windows path when someone needs it.
  if (process.platform === 'win32') throw new Error('arazzo-tool runs on macOS and Linux only for now');
  const wf = (parse(await readFile(file, 'utf8')) as { workflows: Workflow[] }).workflows.find((w) => w.workflowId === workflowId);
  if (!wf) throw new Error(`No workflow “${workflowId}” in ${file}`);
  const input = (await text(process.stdin)) || '{}';
  const dir = await mkdtemp(join(tmpdir(), 'tc-arazzo-'));
  try {
    const log = join(dir, 'log.json');
    const args = [...RESPECT, file, '-w', workflowId, '-i', input, '-J', log];
    const { failed, output } = await new Promise<{ failed: boolean; output: string }>((done) =>
      execFile('npx', args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) =>
        done({ failed: !!err, output: `${stdout}${stderr}` }),
      ),
    );
    const report = JSON.parse(await readFile(log, 'utf8').catch(() => '{"files":{}}')) as {
      files: Record<string, { executedWorkflows: { workflowId: string; executedSteps: Executed[] }[] }>;
    };
    const steps = Object.values(report.files).flatMap((f) => f.executedWorkflows).find((w) => w.workflowId === workflowId)?.executedSteps ?? [];
    const bad = steps.find((s) => s.status !== 'success');
    if (failed || bad) {
      const why = bad ? `step ${bad.stepId}: ${(bad.checks ?? []).filter((c) => !c.passed).map((c) => c.message).join('; ')}` : output.trim().slice(-2000);
      console.error(why);
      process.exit(1);
    }
    console.log(JSON.stringify(resolveOutputs(wf, steps)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [file, workflowId] = process.argv.slice(2);
  if (!file || !workflowId) {
    console.error('usage: arazzo-tool.ts <file.arazzo.yaml> <workflowId>');
    process.exit(2);
  }
  await main(file, workflowId);
}
