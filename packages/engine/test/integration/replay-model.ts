// A stand-in for an open model behind an OpenAI-compatible endpoint (what
// Ollama, LM Studio or vLLM serve): it answers Codex's Responses API calls by
// replaying an agent's script as tool calls, one per turn, then says it's done.
// So the real Codex CLI runs the real loop through our bridge, with no sign-in.
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import YAML from 'yaml';

type Step = { call: string; input?: Record<string, unknown> };
type Item = { type: string; name?: string; output?: unknown; call_id?: string };

export async function startReplayModel() {
  let steps: Step[] = [];
  const seen: string[][] = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    if (req.url?.endsWith('/models')) return void res.end(JSON.stringify({ data: [{ id: 'replay' }] }));
    const { tools = [], input = [] } = JSON.parse(body || '{}') as { tools?: { type?: string; name?: string; tools?: { name: string }[] }[]; input?: Item[] };
    const names = tools.flatMap((t) => (t.name ? [t.name] : []));
    seen.push(names);
    const done = input.filter((i) => i.type === 'function_call').length;
    // The instance key a prepare() call returned, for "{{key}}" in a script.
    const outputs = input.filter((i) => i.type === 'function_call_output').map((i) => JSON.stringify(i.output));
    const key = outputs.reverse().map((o) => /\\*"id\\*"\s*:\s*\\*"([\w-]+)/.exec(o)?.[1]).find(Boolean) ?? '';
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (o: Record<string, unknown>) => res.write(`event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`);
    const id = `r${seen.length}`;
    send({ type: 'response.created', response: { id } });
    const step = steps[done];
    if (step) {
      // Codex offers MCP tools inside a namespace (mcp__<server>); a call names both.
      const ns = tools.find((t) => t.type === 'namespace' && t.tools?.some((x) => x.name === step.call))?.name;
      const args = JSON.stringify(step.input ?? {}).replaceAll('{{key}}', key);
      send({ type: 'response.output_item.done', item: { type: 'function_call', id: `fc${seen.length}`, call_id: `call${seen.length}`, name: step.call, namespace: ns, arguments: args } });
    } else {
      send({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: `m${seen.length}`, content: [{ type: 'output_text', text: 'Done.' }] } });
    }
    send({ type: 'response.completed', response: { id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    // Tool names Codex offered, per request — to check it saw only ours.
    seen,
    async replay(script: string) {
      steps = (YAML.parse(await readFile(script, 'utf8')) as { steps: Step[] }).steps;
    },
    stop: () => new Promise<void>((r) => server.close(() => r())),
  };
}
