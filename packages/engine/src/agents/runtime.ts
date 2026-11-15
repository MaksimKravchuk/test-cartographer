// Agent runtime. An agent is a system prompt, a first message and a set of
// tools; runAgent hands them to the configured runtime and returns when the
// agent stops. Claude Code, Codex, Copilot and Cursor drive their own loop and
// reach the tools through the MCP bridge; `scripted` replays a YAML script with no model.
// Either way every tool call goes through one `invoke`, which validates,
// logs and enforces the step limit.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { SUBAGENTS, template, type AgentProvider, type Runtime } from '@tc/model';
import { openBridge, type BridgeResult, type Harness, type RuntimeStatus } from './bridge.ts';
import { claudeStatus, runClaude } from './claude.ts';
import { codexStatus, runCodex } from './codex.ts';
import { copilotStatus, runCopilot } from './copilot.ts';
import { cursorStatus, runCursor } from './cursor.ts';

export { cursorLogin } from './cursor.ts';

const runtimes: Record<AgentProvider, { title: string; run(h: Harness): Promise<void>; status(baseUrl?: string): Promise<RuntimeStatus> }> = {
  claude: { title: 'Claude Code', run: runClaude, status: claudeStatus },
  codex: { title: 'Codex', run: runCodex, status: codexStatus },
  copilot: { title: 'GitHub Copilot', run: runCopilot, status: copilotStatus },
  cursor: { title: 'Cursor', run: runCursor, status: cursorStatus },
};

export type { RuntimeStatus } from './bridge.ts';

export type Tool = { name: string; description: string; input: z.ZodObject; run(input: any): Promise<string> };

// A list argument the agent is shown as `item[]` — its fields, enums and
// required keys in the tool's JSON Schema — but that is parsed only as a list
// of objects. The tool's `run` checks the items against `item` itself, so a
// mistake is logged and answered with the tool's own message.
export const listOf = (item: z.ZodType) => {
  const { $schema: _, ...shown } = z.toJSONSchema(z.array(item), { io: 'input' });
  return z.array(z.record(z.string(), z.unknown())).meta(shown);
};

export type AgentRun = {
  runtime: Runtime | 'scripted';
  system: string;
  prompt: string;
  tools: Tool[];
  // The tool that hands in the result. It doesn't count against the step
  // budget, so a rejected delivery can still be fixed once the budget is spent.
  deliver: string;
  // Scripted runs: absolute path of the script, and the variables its steps
  // are templated with.
  script?: string;
  vars?: () => Record<string, unknown>;
  // True once the agent has delivered its result; later calls are refused.
  isDone(): boolean;
  onLog(line: string): void;
  signal?: AbortSignal;
};

// Results count down the last WRAP_UP calls; an agent gets DELIVERY_TRIES
// deliveries and OVERRUNS refused calls past the budget before it's stopped.
const WRAP_UP = 5;
const DELIVERY_TRIES = 5;
const OVERRUNS = 3;

const Script = z.object({
  steps: z.array(z.object({ say: z.string().optional(), call: z.string(), input: z.record(z.string(), z.unknown()).default({}) })),
});

// Resolves when the agent stops. Throws when the caller stopped it, it ran out
// of steps or the runtime failed — unless it had already delivered by then.
// Whether it delivered at all is for the caller to check with isDone().
export async function runAgent(run: AgentRun): Promise<void> {
  const limit = run.runtime === 'scripted' ? Infinity : run.runtime.maxSteps;
  const abort = new AbortController();
  let steps = 0;
  let deliveries = 0;
  let overruns = 0;
  let exhausted = false;
  const stop = (why: string) => {
    if (!exhausted) run.onLog(`⚠ ${why} — stopping the agent`);
    exhausted = true;
    setTimeout(() => abort.abort(), 0);
  };

  const invoke = async (name: string, input: unknown): Promise<BridgeResult> => {
    if (run.isDone()) return { content: 'The result is already recorded — stop now.', isError: true };
    let left = Infinity;
    if (name === run.deliver) {
      if (++deliveries > DELIVERY_TRIES) {
        stop(`${DELIVERY_TRIES} deliveries rejected`);
        return { content: 'Too many rejected attempts — stop now.', isError: true };
      }
    } else if (++steps > limit) {
      if (++overruns >= OVERRUNS) stop(`step limit (${limit}) reached`);
      return { content: `The budget of ${limit} tool calls is used up. Call ${run.deliver} now with what you have.`, isError: true };
    } else left = limit - steps;
    // Near the end of the budget every result counts down, so the agent
    // delivers instead of running out mid-exploration.
    const note = (r: BridgeResult): BridgeResult =>
      left <= WRAP_UP ? { ...r, content: `${r.content}\n\n[${left} tool call${left === 1 ? '' : 's'} left before you must call ${run.deliver}.]` } : r;
    const tool = run.tools.find((t) => t.name === name);
    if (!tool) return note({ content: `No tool ${name}`, isError: true });
    const parsed = tool.input.safeParse(input);
    if (!parsed.success) return note({ content: `Invalid arguments: ${z.prettifyError(parsed.error)}`, isError: true });
    run.onLog(`🔧 ${name} ${JSON.stringify(input).slice(0, 160)}`);
    try {
      return note({ content: await tool.run(parsed.data) });
    } catch (e) {
      run.onLog(`   ⚠ ${(e as Error).message}`);
      return note({ content: (e as Error).message, isError: true });
    }
  };

  const stopped = () => new Error('The run was stopped');
  if (run.signal?.aborted) throw stopped();

  if (run.runtime === 'scripted') {
    if (!run.script) throw new Error('This agent has no script to replay — add `script:` to it in cartographer.yaml');
    const { steps: script } = Script.parse(YAML.parse(await readFile(run.script, 'utf8')));
    for (const step of script) {
      if (run.signal?.aborted) throw stopped();
      if (run.isDone()) break;
      if (step.say) run.onLog(`💬 ${step.say}`);
      const r = await invoke(step.call, template(step.input, run.vars?.() ?? {}));
      if (r.isError) throw new Error(`Script aborted: ${r.content}`);
    }
    return;
  }

  const runtime = { ...run.runtime, subagents: !!run.runtime.subagents && SUBAGENTS.includes(run.runtime.provider) };
  const bridge = await openBridge(
    run.tools.map((t) => {
      const { $schema: _, ...inputSchema } = z.toJSONSchema(t.input, { io: 'input' }) as Record<string, unknown>;
      return { name: t.name, description: t.description, inputSchema };
    }),
    invoke,
  );
  const cwd = await mkdtemp(join(tmpdir(), 'tc-agent-'));
  const onAbort = () => abort.abort();
  run.signal?.addEventListener('abort', onAbort);
  run.onLog(`▶ ${runtimes[runtime.provider].title}${runtime.model ? ` · ${runtime.model}` : ''}${runtime.effort ? ` · effort ${runtime.effort}` : ''}${runtime.subagents ? ' · subagents' : ''}`);
  try {
    const delegation = runtime.subagents
      ? `\n\nYou may hand separate parts of the work (a source, an object, a batch of checks) to subagents; they share this budget. Only you call ${run.deliver}: tell every subagent not to.`
      : '';
    const system = `${run.system}\n\nThis run has a budget of ${limit} tool calls; ${run.deliver} doesn't count against it.${delegation}`;
    const harness = { system, prompt: run.prompt, runtime, toolNames: run.tools.map((t) => t.name), deliver: run.deliver, bridge, cwd, abort, onText: (t: string) => run.onLog(`💬 ${t}`) };
    await runtimes[runtime.provider].run(harness);
  } catch (e) {
    if (run.signal?.aborted) throw stopped();
    if (!run.isDone()) throw exhausted ? new Error('The agent was stopped before delivering an accepted result') : e;
  } finally {
    run.signal?.removeEventListener('abort', onAbort);
    await bridge.close();
    await rm(cwd, { recursive: true, force: true });
  }
}

export const runtimeTitle = (p: AgentProvider) => runtimes[p].title;

// endpoint: the project's runtime.baseUrl, which Codex uses instead of a sign-in.
export async function runtimeStatus(endpoint?: string): Promise<RuntimeStatus[]> {
  return Promise.all(Object.values(runtimes).map((r) => r.status(endpoint)));
}

// End-to-end check of a runtime: sign-in, the bridge and tool calls. The agent
// must fetch a word from one tool and hand it to another. Costs one short run.
export async function testRuntime(
  provider: AgentProvider,
  model: string | undefined,
  onLog: (line: string) => void,
  signal?: AbortSignal,
  baseUrl?: string,
): Promise<{ ok: boolean; seconds: number }> {
  const t0 = Date.now();
  let word: string | undefined;
  const tools: Tool[] = [
    { name: 'ping', description: 'Returns the secret word.', input: z.object({}), run: async () => 'The secret word is "meridian".' },
    {
      name: 'finish',
      description: 'Report the secret word.',
      input: z.object({ word: z.string() }),
      run: async (input: { word: string }) => {
        word = input.word;
        return 'Recorded. You are done — stop now.';
      },
    },
  ];
  await runAgent({
    runtime: { provider, model, effort: 'low', maxSteps: 6, baseUrl: provider === 'codex' ? baseUrl : undefined },
    system: 'You are checking that tools work. Use only the provided tools: call ping, then call finish with the secret word ping returned, then stop.',
    prompt: 'Run the check.',
    tools,
    deliver: 'finish',
    isDone: () => word !== undefined,
    onLog,
    signal,
  });
  const ok = word?.toLowerCase() === 'meridian';
  onLog(ok ? '✓ tools work' : `✗ expected “meridian”, got ${word === undefined ? 'nothing' : `“${word}”`}`);
  return { ok, seconds: Math.round((Date.now() - t0) / 100) / 10 };
}
