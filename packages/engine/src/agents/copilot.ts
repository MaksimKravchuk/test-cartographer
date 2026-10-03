// GitHub Copilot runtime: runs on the Copilot subscription of the GitHub user
// signed in locally (Copilot CLI login, or the `gh` CLI's), through the
// Copilot SDK and the Copilot CLI bundled with it. Only the bridge's tools are
// available — no built-in tools, no user MCP config or custom instructions.
import { approveAll, CopilotClient, ToolSet } from '@github/copilot-sdk';
import type { Harness, RuntimeStatus } from './bridge.ts';

const TOOL_TIMEOUT_MS = 10 * 60_000;
// sendAndWait gives up after 60 s by default; a run is bounded by its step
// limit and the caller's signal instead.
const RUN_TIMEOUT_MS = 6 * 60 * 60_000;

export async function runCopilot(h: Harness): Promise<void> {
  const client = new CopilotClient({ logLevel: 'error', workingDirectory: h.cwd });
  await client.start();
  try {
    const session = await client.createSession({
      model: h.runtime.model,
      reasoningEffort: h.runtime.effort,
      systemMessage: { mode: 'replace', content: h.system },
      // MCP wire names are `<server>-<tool>`; listing ours keeps out built-in
      // tools and the GitHub MCP server that comes with Copilot.
      availableTools: h.toolNames.reduce((set, n) => set.addMcp(`tc-${n}`), new ToolSet()),
      mcpServers: { tc: { type: 'http', url: h.bridge.url, headers: { authorization: `Bearer ${h.bridge.token}` }, tools: ['*'], timeout: TOOL_TIMEOUT_MS } },
      onPermissionRequest: approveAll,
      workingDirectory: h.cwd,
      enableConfigDiscovery: false,
      skipCustomInstructions: true,
      enableSkills: false,
    });
    let failure: string | undefined;
    session.on('assistant.message', (e) => {
      if (e.data.content.trim()) h.onText(e.data.content.trim());
    });
    session.on('session.error', (e) => {
      failure = e.data.message;
    });
    const onAbort = () => void session.abort();
    h.abort.signal.addEventListener('abort', onAbort);
    try {
      await session.sendAndWait({ prompt: h.prompt }, RUN_TIMEOUT_MS);
    } finally {
      h.abort.signal.removeEventListener('abort', onAbort);
      await session.disconnect();
    }
    if (h.abort.signal.aborted) throw new Error('Copilot run aborted');
    if (failure) throw new Error(`Copilot: ${failure}`);
  } finally {
    await client.stop();
  }
}

export async function copilotStatus(): Promise<RuntimeStatus> {
  const client = new CopilotClient({ logLevel: 'none' });
  try {
    await client.start();
    const auth = await client.getAuthStatus();
    if (!auth.isAuthenticated)
      return {
        provider: 'copilot',
        ready: false,
        models: [],
        detail: 'Not signed in. Run `gh auth login` (or `copilot login`) with a GitHub account that has Copilot.',
      };
    const models = await client.listModels();
    return {
      provider: 'copilot',
      ready: true,
      account: auth.login,
      plan: auth.authType === 'gh-cli' ? 'via gh' : undefined,
      models: models.filter((m) => m.id !== 'auto').map((m) => ({ id: m.id, title: m.name })),
    };
  } catch (e) {
    return { provider: 'copilot', ready: false, models: [], detail: (e as Error).message };
  } finally {
    await client.stop().catch(() => {});
  }
}
