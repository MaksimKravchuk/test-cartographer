// Codex runtime: runs on the ChatGPT subscription Codex is signed in to,
// through the Codex SDK (it drives the Codex CLI bundled with it). Its own
// tools are switched off — the agent only has ours, over MCP.
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Codex } from '@openai/codex-sdk';
import type { Harness, RuntimeStatus } from './bridge.ts';

const TOKEN_ENV = 'TC_BRIDGE_TOKEN';

// Codex gets only what it needs to run and find its ChatGPT sign-in — not the
// engine's environment, which may hold credentials (and an API key would
// switch it to per-token billing).
const PASS_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR', 'CODEX_HOME', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR'];
const subscriptionEnv = () => {
  const env: Record<string, string> = {};
  for (const k of PASS_ENV) if (process.env[k] !== undefined) env[k] = process.env[k]!;
  return env;
};

// Codex features that give the agent tools of its own. A read-only sandbox
// still lets the shell read the whole disk, so the shell goes too.
const BUILTIN_TOOLS = [
  'shell_tool', 'unified_exec', 'view_image', 'browser_use', 'browser_use_external', 'in_app_browser', 'computer_use',
  'image_generation', 'apps', 'plugins', 'memories', 'multi_agent', 'skill_search', 'tool_suggest', 'goals',
];
// Item types that only a built-in tool produces. Seeing one means a feature
// above slipped through (say, a new Codex version): the run is stopped.
const BUILTIN_ITEMS = new Set(['command_execution', 'file_change', 'web_search']);

// A model endpoint (runtime.baseUrl) replaces the ChatGPT sign-in: Codex talks
// the Responses API to it, so any model served that way works, open ones included.
const endpointConfig = (baseUrl: string | undefined): Record<string, string | Record<string, Record<string, string>>> =>
  baseUrl ? { model_provider: 'tc-endpoint', model_providers: { 'tc-endpoint': { name: 'Model endpoint', base_url: baseUrl, wire_api: 'responses' } } } : {};
// A local endpoint must not go through an outbound proxy.
const noProxy = (env: Record<string, string>, baseUrl: string | undefined): Record<string, string> => {
  if (!baseUrl) return {};
  const host = new URL(baseUrl).hostname;
  const list = [env.NO_PROXY ?? env.no_proxy, host].filter(Boolean).join(',');
  return { NO_PROXY: list, no_proxy: list };
};

export async function runCodex(h: Harness): Promise<void> {
  const env = subscriptionEnv();
  const codex = new Codex({
    env: { ...env, ...noProxy(env, h.runtime.baseUrl), [TOKEN_ENV]: h.bridge.token },
    config: {
      ...endpointConfig(h.runtime.baseUrl),
      developer_instructions: h.system,
      features: Object.fromEntries(BUILTIN_TOOLS.map((f) => [f, false])),
      mcp_servers: {
        // `approve`: our tools run without asking — there is nobody to ask.
        tc: { url: h.bridge.url, bearer_token_env_var: TOKEN_ENV, default_tools_approval_mode: 'approve', tool_timeout_sec: 600 },
      },
    },
  });
  const thread = codex.startThread({
    model: h.runtime.model,
    modelReasoningEffort: h.runtime.effort,
    sandboxMode: 'read-only',
    approvalPolicy: 'never',
    workingDirectory: h.cwd,
    skipGitRepoCheck: true,
    webSearchMode: 'disabled',
    networkAccessEnabled: false,
  });
  const { events } = await thread.runStreamed(h.prompt, { signal: h.abort.signal });
  for await (const e of events) {
    if ((e.type === 'item.started' || e.type === 'item.completed') && BUILTIN_ITEMS.has(e.item.type)) {
      h.abort.abort();
      throw new Error(`Codex tried to use a built-in tool (${e.item.type}) — stopped the run`);
    }
    if (e.type === 'item.completed' && e.item.type === 'agent_message' && e.item.text.trim()) h.onText(e.item.text.trim());
    if (e.type === 'turn.failed') throw new Error(`Codex: ${e.error.message}`);
    if (e.type === 'error') throw new Error(`Codex: ${e.message}`);
  }
}

// The CLI bundled with the SDK, so status matches what a run will use.
const cli = async (args: string[]) => {
  const launcher = createRequire(fileURLToPath(import.meta.resolve('@openai/codex-sdk'))).resolve('@openai/codex/bin/codex.js');
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [launcher, ...args], { env: subscriptionEnv(), timeout: 30_000, maxBuffer: 32 * 1024 * 1024 });
  return (stdout + stderr).trim();
};

// With a model endpoint, ready means it answers and lists its models.
async function endpointStatus(baseUrl: string): Promise<RuntimeStatus> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const { data = [] } = (await res.json()) as { data?: { id: string }[] };
    return { provider: 'codex', ready: true, account: `Model endpoint ${baseUrl}`, models: data.map((m) => ({ id: m.id, title: m.id })) };
  } catch (e) {
    return { provider: 'codex', ready: false, models: [], detail: `The model endpoint ${baseUrl} doesn't answer: ${(e as Error).message}` };
  }
}

export async function codexStatus(baseUrl?: string): Promise<RuntimeStatus> {
  if (baseUrl) return endpointStatus(baseUrl);
  try {
    const [version, login] = await Promise.all([cli(['--version']), cli(['login', 'status']).catch((e) => String(e.stderr ?? e.message))]);
    const chatgpt = /logged in using chatgpt/i.test(login);
    const models = chatgpt
      ? ((JSON.parse(await cli(['debug', 'models'])) as { models: { slug: string; display_name: string; visibility: string }[] }).models
          .filter((m) => m.visibility === 'list')
          .map((m) => ({ id: m.slug, title: m.display_name })))
      : [];
    return {
      provider: 'codex',
      ready: chatgpt,
      version: version.replace(/^codex-cli\s*/, ''),
      account: chatgpt ? 'ChatGPT' : undefined,
      models,
      detail: chatgpt
        ? undefined
        : /api key/i.test(login)
          ? 'Codex is signed in with an API key (billed per token). Run `codex login` and sign in with ChatGPT.'
          : 'Not signed in. Run `codex login` and sign in with ChatGPT.',
    };
  } catch (e) {
    return { provider: 'codex', ready: false, models: [], detail: (e as Error).message };
  }
}
