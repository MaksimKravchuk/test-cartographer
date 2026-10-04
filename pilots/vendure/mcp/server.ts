// MCP server Test Cartographer starts for the Vendure pilot: data setup and
// read tools over Vendure's own GraphQL APIs (see orders.ts).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createOrder, ORDER_STATES, PAYMENT_METHODS, readOrder } from './orders.ts';

const server = new McpServer({ name: 'vendure-pilot', version: '0.1.0' });

const reply = async (fn: () => Promise<unknown>) => {
  try {
    return { content: [{ type: 'text' as const, text: JSON.stringify(await fn(), null, 2) }] };
  } catch (e) {
    return { content: [{ type: 'text' as const, text: (e as Error).message }], isError: true };
  }
};

server.registerTool(
  'create_order',
  {
    description:
      'Create a test order and bring it to the given state through the shop\'s own APIs (a buyer checks out, staff settle, fulfil, ship, deliver or cancel). ' +
      'Returns the order (JSON): id, code, state, paymentMethod, paymentState, fulfillmentStates, lines.',
    inputSchema: {
      state: z.enum(ORDER_STATES).describe('Order state to reach'),
      payment: z.enum(PAYMENT_METHODS).default('standard-payment').describe('standard-payment is authorized and settled later by staff; prepaid is settled at checkout'),
      owner: z.enum(['buyer', 'guest']).default('guest').describe('buyer: the order belongs to the test buyer account and shows in the buyer\'s storefront account; guest: a new guest customer'),
      tag: z.string().optional().describe('Tag that isolates test data'),
    },
  },
  async (args) => reply(() => createOrder(args)),
);

server.registerTool(
  'get_order',
  {
    description: 'Read the actual state of an order by id (JSON): state, payment and fulfillment states, lines.',
    inputSchema: { id: z.string() },
  },
  async ({ id }) => reply(() => readOrder(id)),
);

await server.connect(new StdioServerTransport());
