// The explorer's browser tools are Playwright MCP's own (`browser_*`), served
// in-process on the page the engine signed in. We only narrow them to the
// role's interface, type data references for the agent and keep evidence.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { Tool } from './runtime.ts';

// Playwright MCP ships inside playwright-core; @playwright/mcp's index.js is this same require.
const require = createRequire(import.meta.url);
const { tools: playwright } = require(require.resolve('playwright-core/lib/coreBundle', { paths: [require.resolve('@playwright/test')] }));

// What a role does in its own interface. Left out: tabs, closing the browser,
// running page code, routes, uploads and anything that writes files.
export const BROWSER_TOOLS = [
  'browser_navigate', 'browser_navigate_back', 'browser_snapshot', 'browser_click', 'browser_hover', 'browser_type', 'browser_fill_form',
  'browser_select_option', 'browser_press_key', 'browser_handle_dialog', 'browser_wait_for', 'browser_network_requests',
];

type Options = {
  // The interface's baseUrl: a relative URL opens under it; another origin is refused.
  base: string;
  // Replaces {{roles.<id>.<field>}} / {{entities.<id>.<field>}} with the real value.
  fill: (text: string) => string;
  // A snapshot or a request list the agent asked for: save it as evidence, return what the agent reads.
  onSnapshot: (text: string, note?: string) => Promise<string>;
  onNetwork: (text: string) => Promise<string>;
};

export async function browserTools(page: Page, o: Options): Promise<{ tools: Tool[]; close(): Promise<void> }> {
  const out = await mkdtemp(join(tmpdir(), 'tc-browser-'));
  const server = await playwright.createConnection(
    { capabilities: ['network'], imageResponses: 'omit', outputDir: out },
    async () => page.context(),
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'test-cartographer', version: '0.1.0' });
  await client.connect(b);
  const origin = new URL(o.base).origin;
  const base = o.base.replace(/\/$/, '');

  // shortcut: checks only the explorer's own page; a link that opens a new tab isn't followed, add browser_tabs if apps need it.
  const stayInside = async () => {
    if (new URL(page.url()).origin === origin || page.url() === 'about:blank') return;
    await page.goBack();
    throw new Error('Navigation outside the interface was cancelled');
  };

  const call = async (name: string, args: Record<string, unknown>) => {
    // The agent has no disk: results come back as text, never as files.
    delete args.filename;
    const note = typeof args.note === 'string' ? args.note : undefined;
    delete args.note;
    if (name === 'browser_navigate') {
      const url = String(args.url ?? '');
      args.url = /^[a-z]+:/i.test(url) ? url : base + (url.startsWith('/') ? url : `/${url}`);
      if (new URL(String(args.url)).origin !== origin) throw new Error('Only pages of your own interface');
    }
    if (name === 'browser_type' && typeof args.text === 'string') args.text = o.fill(args.text);
    if (name === 'browser_fill_form' && Array.isArray(args.fields))
      args.fields = args.fields.map((f: Record<string, unknown>) => (typeof f.value === 'string' ? { ...f, value: o.fill(f.value) } : f));
    const r = (await client.callTool({ name, arguments: args })) as { content: { type: string; text?: string }[]; isError?: boolean };
    // After an action Playwright links a snapshot file the agent can't open: take browser_snapshot() for the page.
    const text = r.content.flatMap((c) => (c.type === 'text' && c.text ? [c.text] : [])).join('\n').replace(/^### Snapshot\n- \[Snapshot\]\(.*\)$/gm, '').trim();
    if (r.isError) throw new Error(text);
    await stayInside();
    if (name === 'browser_snapshot') return o.onSnapshot(text, note);
    if (name === 'browser_network_requests') return o.onNetwork(text);
    return text;
  };

  const { tools } = await client.listTools();
  return {
    tools: tools
      .filter((t) => BROWSER_TOOLS.includes(t.name))
      .map((t) => {
        const { $schema: _, properties, ...schema } = t.inputSchema as Record<string, unknown> & { properties?: Record<string, unknown> };
        const { filename: __, ...shown } = properties ?? {};
        // A person reads the note as the evidence's caption.
        if (t.name === 'browser_snapshot') shown.note = { type: 'string', description: 'What is visible on the page' };
        // Playwright checks the arguments itself; the agent is shown its schema.
        return { name: t.name, description: t.description ?? '', input: z.looseObject({}), schema: { ...schema, properties: shown }, run: (args) => call(t.name, { ...args }) };
      }),
    close: async () => {
      await client.close();
      await server.close();
      await rm(out, { recursive: true, force: true });
    },
  };
}
