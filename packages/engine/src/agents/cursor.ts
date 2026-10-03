// Cursor runtime: runs on the Cursor plan of the account signed in through
// the Cursor SDK (it mints a user API key, billed like IDE usage). The agent
// loop runs in-process; its only tools are the bridge's.
import { Agent, Cursor } from '@cursor/sdk';
import type { Harness, RuntimeStatus } from './bridge.ts';

export async function runCursor(h: Harness): Promise<void> {
  const agent = await Agent.create({
    model: h.runtime.model ? { id: h.runtime.model } : undefined,
    systemPrompt: h.system,
    tools: ['mcp'],
    mcpServers: { tc: { type: 'http', url: h.bridge.url, headers: { authorization: `Bearer ${h.bridge.token}` } } },
    local: { cwd: h.cwd, settingSources: [] },
  });
  try {
    const run = await agent.send(h.prompt);
    const onAbort = () => void run.cancel();
    h.abort.signal.addEventListener('abort', onAbort);
    // Assistant text may arrive in pieces: gather it up to the next tool call.
    let text = '';
    const flush = () => {
      if (text.trim()) h.onText(text.trim());
      text = '';
    };
    try {
      for await (const m of run.stream()) {
        if (m.type === 'assistant') {
          for (const b of m.message.content) if (b.type === 'text') text += b.text;
        } else flush();
      }
      flush();
      const r = await run.wait();
      if (r.status === 'error') throw new Error(`Cursor: ${r.error?.message ?? 'the run failed'}`);
      if (r.status === 'cancelled') throw new Error('Cursor run cancelled');
    } finally {
      h.abort.signal.removeEventListener('abort', onAbort);
    }
  } finally {
    agent.close();
  }
}

export async function cursorStatus(): Promise<RuntimeStatus> {
  try {
    const auth = await Cursor.auth.status();
    if (auth.status !== 'logged-in')
      return { provider: 'cursor', ready: false, models: [], detail: 'Not signed in. Use Sign in (or `tc runtimes login cursor`) and log in with your Cursor account.' };
    const models = await Cursor.models.list();
    return { provider: 'cursor', ready: true, account: auth.email, models: models.map((m) => ({ id: m.id, title: m.displayName })) };
  } catch (e) {
    return { provider: 'cursor', ready: false, models: [], detail: (e as Error).message };
  }
}

// Opens Cursor's login page in the browser and waits until the user finishes;
// the minted key is stored where the SDK looks for it.
export async function cursorLogin(onUrl: (url: string) => void, signal?: AbortSignal): Promise<string | undefined> {
  const r = await Cursor.auth.login({ onLoginUrl: onUrl, signal, apiKeyName: 'Test Cartographer' });
  return r.email;
}
