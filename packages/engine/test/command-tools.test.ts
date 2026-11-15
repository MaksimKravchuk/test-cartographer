import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const server = fileURLToPath(new URL('../src/command-tools.ts', import.meta.url));
const tools = fileURLToPath(new URL('./fixtures/command-tools.yaml', import.meta.url));

test('command tools: a script becomes an MCP tool — schema in, JSON on stdin, stdout out, failures as errors', async () => {
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [server, tools] }));
  try {
    const { tools: listed } = await client.listTools();
    assert.deepEqual(listed.map((t) => t.name), ['create_order', 'broken']);
    assert.deepEqual(listed[0].inputSchema.required, ['status']);

    const ok = (await client.callTool({ name: 'create_order', arguments: { status: 'paid', tag: 'run-1' } })) as any;
    assert.equal(ok.isError, false);
    assert.deepEqual(JSON.parse(ok.content[0].text), { id: 'o-1', status: 'paid', tag: 'run-1' });

    const bad = (await client.callTool({ name: 'broken', arguments: {} })) as any;
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /exit 3\nno db/);
  } finally {
    await client.close();
  }
});
