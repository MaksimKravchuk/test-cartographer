// Codex runtime: runs on the ChatGPT subscription Codex is signed in to,
// through the Codex SDK (it drives the Codex CLI bundled with it). The agent
// gets a read-only sandbox in an empty directory; our tools come over MCP.
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Codex } from '@openai/codex-sdk';
import type { Harness, RuntimeStatus } from './bridge.ts';

const TOKEN_ENV = 'TC_BRIDGE_TOKEN';

// Without an API key in the environment Codex uses its ChatGPT sign-in.
const subscriptionEnv = () => {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'OPENAI_API_KEY' && k !== 'CODEX_API_KEY') env[k] = v;
  return env;
};

export async function runCodex(h: Harness): Promise<void> {
  const codex = new Codex({
    env: { ...subscriptionEnv(), [TOKEN_ENV]: h.bridge.token },
    config: {
      developer_instructions: h.system,
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

export async function codexStatus(): Promise<RuntimeStatus> {
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
