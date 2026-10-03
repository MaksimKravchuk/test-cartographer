// Tool bridge. Claude Code and Codex run their own agent loop, so the only way
// to hand them our tools is MCP: for the length of one run we serve the
// agent's tools over streamable HTTP on 127.0.0.1, behind a random bearer
// token. Every call still goes through `invoke`, so logs and evidence stay ours.
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { AgentProvider, Runtime } from '@tc/model';

export type BridgeTool = { name: string; description: string; inputSchema: Record<string, unknown> };
export type BridgeResult = { content: string; isError?: boolean };

export type Bridge = { url: string; token: string; close(): Promise<void> };

// One run handed to Claude Code or Codex: they drive the loop and reach the
// tools (named `toolNames`) through the bridge.
export type Harness = {
  system: string;
  prompt: string;
  runtime: Runtime;
  toolNames: string[];
  bridge: Bridge;
  cwd: string;
  abort: AbortController;
  onText(text: string): void;
};

export type RuntimeStatus = {
  provider: AgentProvider;
  // Installed and signed in to a subscription — a run can start.
  ready: boolean;
  version?: string;
  account?: string;
  plan?: string;
  models: { id: string; title: string }[];
  // What's wrong and how to fix it, when not ready.
  detail?: string;
};

const readBody = async (req: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : undefined;
};

export async function openBridge(tools: BridgeTool[], invoke: (name: string, input: unknown) => Promise<BridgeResult>): Promise<Bridge> {
  const token = randomBytes(24).toString('hex');

  // One call at a time, in arrival order, even when the agent issues several
  // in parallel: tools share run state (the evidence counter, the remembered
  // key, the browser page), so they must not interleave.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = (name: string, input: unknown) => {
    const result = queue.then(() => invoke(name, input));
    queue = result.catch(() => {});
    return result;
  };

  // Stateless mode: a fresh MCP server per request, no session bookkeeping.
  const mcpServer = () => {
    const s = new Server({ name: 'test-cartographer', version: '0.1.0' }, { capabilities: { tools: {} } });
    s.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: { type: 'object', ...t.inputSchema } })),
    }));
    s.setRequestHandler(CallToolRequestSchema, async (req) => {
      const r = await serial(req.params.name, req.params.arguments ?? {});
      return { content: [{ type: 'text', text: r.content }], isError: r.isError ?? false };
    });
    return s;
  };

  const http = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end();
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' }).end();
      return;
    }
    try {
      const body = await readBody(req);
      const server = mcpServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' }).end((e as Error).message);
    }
  });

  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        http.closeAllConnections();
        http.close(() => resolve());
      }),
  };
}
