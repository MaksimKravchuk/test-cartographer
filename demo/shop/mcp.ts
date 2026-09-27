// Demo shop MCP server: data setup tools and read tools (orders and listings).
// The engine starts it over stdio as configured in cartographer.yaml.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const SHOP_URL = process.env.SHOP_URL ?? 'http://localhost:4400';
const TEST_TOKEN = process.env.SHOP_TEST_TOKEN ?? 'demo-test-token';

const server = new McpServer({ name: 'demo-shop', version: '1.0.0' });

async function call(path: string, init?: RequestInit) {
  const res = await fetch(SHOP_URL + path, init);
  const text = await res.text();
  if (!res.ok) return { content: [{ type: 'text' as const, text: `HTTP ${res.status}: ${text}` }], isError: true };
  return { content: [{ type: 'text' as const, text }] };
}

server.registerTool(
  'create_order',
  {
    description: 'Create a test order directly in the given state. Returns the full order (JSON).',
    inputSchema: {
      variant: z.enum(['standard', 'digital', 'preorder']),
      status: z.string().default('created'),
      tag: z.string().optional().describe('Tag that isolates test data'),
      listingId: z.string().optional().describe('Listing the order was placed from (item and total are taken from it)'),
    },
  },
  async ({ variant, status, tag, listingId }) =>
    call('/test/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-token': TEST_TOKEN },
      body: JSON.stringify({ variant, status, tag, listingId }),
    }),
);

server.registerTool(
  'get_order',
  {
    description: 'Read the actual state of an order by id (JSON).',
    inputSchema: { id: z.string() },
  },
  async ({ id }) => call(`/api/orders/${encodeURIComponent(id)}`),
);

server.registerTool(
  'create_listing',
  {
    description: 'Create a test listing directly in the given state. Returns the full listing (JSON).',
    inputSchema: {
      variant: z.enum(['physical', 'digital']),
      status: z.string().default('draft'),
      tag: z.string().optional().describe('Tag that isolates test data'),
    },
  },
  async ({ variant, status, tag }) =>
    call('/test/listings', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-token': TEST_TOKEN },
      body: JSON.stringify({ variant, status, tag }),
    }),
);

server.registerTool(
  'get_listing',
  {
    description: 'Read the actual state of a listing by id (JSON).',
    inputSchema: { id: z.string() },
  },
  async ({ id }) => call(`/api/listings/${encodeURIComponent(id)}`),
);

server.registerTool(
  'run_jobs',
  {
    description:
      'Run the shop background jobs now, as if advanceMinutes had passed since this moment (test only). ' +
      'Currently just "unpaid orders expire". Returns { processed: [...ids] } (JSON).',
    inputSchema: {
      only: z.string().optional().describe('Only run the job for this order id, so parallel tests stay isolated'),
      advanceMinutes: z.number().optional().describe('Minutes to simulate as having passed since now (default 0)'),
    },
  },
  async ({ only, advanceMinutes }) =>
    call('/test/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-token': TEST_TOKEN },
      body: JSON.stringify({ only, advanceMinutes }),
    }),
);

await server.connect(new StdioServerTransport());
