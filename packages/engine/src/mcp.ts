import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolve } from 'node:path';
import type { Project } from '@tc/model';
export { template } from '@tc/model';

export type ToolKind = 'prepare' | 'read' | 'trigger';

export class ToolError extends Error {}

// Pool of MCP clients. Calls only tools from the project's allowlist;
// the call kind (setup or read) is checked separately, so a setup tool
// can't be passed off as a state probe and vice versa.
export class McpPool {
  private clients = new Map<string, Promise<Client>>();
  private project: Project;
  private root: string;

  constructor(project: Project, root: string) {
    this.project = project;
    this.root = root;
  }

  private client(server: string): Promise<Client> {
    let c = this.clients.get(server);
    if (!c) {
      const cfg = this.project.mcp[server];
      if (!cfg) throw new ToolError(`MCP server “${server}” is not defined in cartographer.yaml`);
      c = (async () => {
        const client = new Client({ name: 'test-cartographer', version: '0.1.0' });
        const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
        await client.connect(
          new StdioClientTransport({
            command: cfg.command,
            args: cfg.args,
            env: { ...env, ...cfg.env },
            cwd: resolve(this.root, cfg.cwd ?? '.'),
            stderr: 'pipe',
          }),
        );
        return client;
      })();
      this.clients.set(server, c);
    }
    return c;
  }

  allowed(tool: string, kind: ToolKind): boolean {
    const [server, name] = tool.split('.');
    return !!this.project.mcp[server]?.allow[kind].includes(name);
  }

  async call(tool: string, args: Record<string, unknown>, kind: ToolKind): Promise<unknown> {
    if (!this.allowed(tool, kind)) throw new ToolError(`Tool “${tool}” is not allowed for ${kind === 'prepare' ? 'setup' : kind === 'read' ? 'reading' : 'triggering'}`);
    const [server, name] = tool.split('.');
    const client = await this.client(server);
    const res = (await client.callTool({ name, arguments: args })) as { content?: { type: string; text?: string }[]; isError?: boolean };
    const text = (res.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    if (res.isError) throw new ToolError(`${tool}: ${text}`);
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  async close() {
    await Promise.all([...this.clients.values()].map(async (c) => (await c).close().catch(() => {})));
    this.clients.clear();
  }
}

export function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);
}

// Compares the state that was read with the expected field values.
export function mismatches(actual: unknown, match: Record<string, unknown>): string[] {
  return Object.entries(match).flatMap(([field, expected]) => {
    const got = getPath(actual, field);
    return JSON.stringify(got) === JSON.stringify(expected) ? [] : [`${field}: expected ${JSON.stringify(expected)}, read ${JSON.stringify(got)}`];
  });
}
