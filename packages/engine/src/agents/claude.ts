// Claude Code runtime: runs on the Claude subscription the user is signed in
// to locally, through the Agent SDK. Only the bridge's tools are available —
// no built-in tools, no user settings or MCP servers.
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Harness, RuntimeStatus } from './bridge.ts';

const TOOL_TIMEOUT_MS = 10 * 60_000;

// Without these Claude Code bills the account's own login, not an API key or
// a third-party backend. CLAUDECODE is dropped so a run started from inside a
// Claude Code session isn't treated as nested.
const subscriptionEnv = () => {
  const env: Record<string, string | undefined> = { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'test-cartographer/0.1.0' };
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDECODE'])
    delete env[k];
  return env;
};

export async function runClaude(h: Harness): Promise<void> {
  const q = query({
    prompt: h.prompt,
    options: {
      systemPrompt: h.system,
      model: h.runtime.model,
      effort: h.runtime.effort,
      tools: [],
      allowedTools: h.toolNames.map((n) => `mcp__tc__${n}`),
      permissionMode: 'dontAsk',
      settingSources: [],
      strictMcpConfig: true,
      persistSession: false,
      mcpServers: { tc: { type: 'http', url: h.bridge.url, headers: { authorization: `Bearer ${h.bridge.token}` }, timeout: TOOL_TIMEOUT_MS } },
      // Our step limit is the real one; this only stops a runaway loop.
      maxTurns: h.runtime.maxSteps + 10,
      cwd: h.cwd,
      env: subscriptionEnv(),
      abortController: h.abort,
    },
  });
  for await (const m of q) {
    if (m.type === 'assistant')
      for (const b of m.message.content) if (b.type === 'text' && b.text.trim()) h.onText(b.text.trim());
    if (m.type === 'result') {
      if (m.subtype !== 'success') throw new Error(`Claude Code stopped (${m.subtype}): ${m.errors.join('; ') || 'no details'}`);
      if (m.is_error) throw new Error(`Claude Code: ${m.result}`);
    }
  }
}

// Sign-in state and models, read from Claude Code's handshake — no prompt is
// sent, so this costs nothing.
export async function claudeStatus(): Promise<RuntimeStatus> {
  const abort = new AbortController();
  const idle = (async function* () {
    await new Promise((resolve) => abort.signal.addEventListener('abort', resolve));
  })();
  const q = query({ prompt: idle as AsyncIterable<never>, options: { abortController: abort, settingSources: [], persistSession: false, tools: [], env: subscriptionEnv() } });
  let timer: NodeJS.Timeout | undefined;
  try {
    const init = await Promise.race([
      q.initializationResult(),
      new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error('Claude Code did not respond in 30 s')), 30_000))),
    ]);
    const a = init.account;
    const signedIn = !!(a.email || a.subscriptionType);
    return {
      provider: 'claude',
      ready: signedIn,
      account: a.email,
      plan: a.subscriptionType,
      // An omitted model already means Claude Code's default.
      models: init.models.filter((m) => m.value !== 'default').map((m) => ({ id: m.value, title: m.displayName })),
      detail: signedIn ? undefined : 'Not signed in. Run `claude auth login` and sign in with your Claude account.',
    };
  } catch (e) {
    return { provider: 'claude', ready: false, models: [], detail: (e as Error).message };
  } finally {
    // When the handshake wins the race the timer is still pending and would
    // keep the process (`tc runtimes`) alive for up to 30 s.
    clearTimeout(timer);
    abort.abort();
    try {
      for await (const _ of q);
    } catch {
      // aborted on purpose
    }
  }
}
