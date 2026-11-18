#!/usr/bin/env node
// Command tools: an MCP server (stdio) that turns the scripts a team already
// has — a pytest fixture wrapper, a DB seed, `newman run`, `hurl`, an Arazzo
// workflow under `redocly respect` — into tools, so nobody writes an MCP server.
// Add it to cartographer.yaml like any MCP server and list its tools in `allow`:
//
//   mcp:
//     fixtures:
//       command: node
//       args: [<engine>/src/command-tools.ts, fixtures.yaml]
//       allow: { prepare: [create_order] }
//
// fixtures.yaml:
//
//   tools:
//     create_order:
//       description: Create a test order in the given state. Prints the order (JSON).
//       command: python
//       args: [-m, tests.fixtures_cli, create_order]
//       input: { type: object, properties: { status: { type: string } } }
//
// The tool's arguments go to the command as JSON on stdin (never through a
// shell), stdout is the result. Exit code ≠ 0 is a tool error with stderr.
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { parse } from 'yaml';
import { z } from 'zod';

const CommandTool = z.object({
  description: z.string(),
  command: z.string(),
  args: z.array(z.string()).default([]),
  // JSON Schema of the arguments, shown to the agent as the tool's inputSchema.
  input: z.record(z.string(), z.unknown()).default({ type: 'object' }),
  cwd: z.string().optional(),
  timeout: z.number().positive().default(60),
});
export const CommandTools = z.object({ tools: z.record(z.string(), CommandTool) });
export type CommandTools = z.infer<typeof CommandTools>;

export function loadCommandTools(file: string): { tools: CommandTools['tools']; root: string } {
  return { tools: CommandTools.parse(parse(readFileSync(file, 'utf8'))).tools, root: dirname(resolve(file)) };
}

export function runCommandTool(
  tool: CommandTools['tools'][string],
  root: string,
  input: unknown,
): Promise<{ text: string; isError: boolean }> {
  return new Promise((done) => {
    const child = execFile(
      tool.command,
      tool.args,
      { cwd: resolve(root, tool.cwd ?? '.'), timeout: tool.timeout * 1000, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (!err) return done({ text: stdout.trim(), isError: false });
        const why = err.killed ? `timed out after ${tool.timeout}s` : `exit ${err.code ?? err.message}`;
        done({ text: `${why}\n${(stderr || stdout).trim().slice(-4000)}`, isError: true });
      },
    );
    // A command that exits without reading stdin makes the write fail (EPIPE);
    // its exit already reports the failure, so the stream error must not crash the server.
    child.stdin?.on('error', () => {});
    child.stdin?.end(JSON.stringify(input ?? {}));
  });
}

export async function serveCommandTools(file: string) {
  const { tools, root } = loadCommandTools(file);
  const server = new Server({ name: 'command-tools', version: '0.1.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Object.entries(tools).map(([name, t]) => ({ name, description: t.description, inputSchema: { type: 'object', ...t.input } })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = tools[req.params.name];
    if (!tool) return { content: [{ type: 'text', text: `No tool “${req.params.name}”` }], isError: true };
    const r = await runCommandTool(tool, root, req.params.arguments);
    return { content: [{ type: 'text', text: r.text }], isError: r.isError };
  });
  await server.connect(new StdioServerTransport());
}

if (import.meta.main) {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: command-tools.ts <tools.yaml>');
    process.exit(2);
  }
  await serveCommandTools(file);
}
