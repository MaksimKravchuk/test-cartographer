// Inference providers. The explorer agent talks to the model through a narrow
// Session interface: “here are the tool results — which calls next?”.
// Playwright does not provide a model — the user plugs one in.
import Anthropic from '@anthropic-ai/sdk';
import { readFile } from 'node:fs/promises';
import YAML from 'yaml';
import { z } from 'zod';
import type { Inference } from '@tc/model';

export type ToolSpec = { name: string; description: string; input: z.ZodObject };
export type Call = { id: string; name: string; input: unknown };
export type ToolResult = { id: string; content: string; isError?: boolean };
export type Turn = { text: string; calls: Call[]; done: boolean };

export interface Session {
  next(results: ToolResult[]): Promise<Turn>;
}

export type SessionInit = { system: string; prompt: string; tools: ToolSpec[]; vars: () => Record<string, unknown> };

const jsonSchema = (t: ToolSpec) => {
  const { $schema: _, ...schema } = z.toJSONSchema(t.input) as Record<string, unknown>;
  return schema;
};

// ── Anthropic ───────────────────────────────────────────────────────────
class AnthropicSession implements Session {
  private client: Anthropic;
  private messages: Anthropic.Beta.BetaMessageParam[];
  private cfg: Inference;
  private init: SessionInit;

  constructor(cfg: Inference, init: SessionInit) {
    const apiKey = cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] : undefined;
    this.client = new Anthropic({ ...(apiKey ? { apiKey } : {}), ...(cfg.baseUrl ? { baseURL: cfg.baseUrl } : {}) });
    this.cfg = cfg;
    this.init = init;
    this.messages = [{ role: 'user', content: init.prompt }];
  }

  async next(results: ToolResult[]): Promise<Turn> {
    if (results.length)
      this.messages.push({
        role: 'user',
        content: results.map((r) => ({ type: 'tool_result' as const, tool_use_id: r.id, content: r.content, is_error: r.isError })),
      });

    const params = {
      model: this.cfg.model,
      max_tokens: 16000,
      system: [{ type: 'text' as const, text: this.init.system, cache_control: { type: 'ephemeral' as const } }],
      tools: this.init.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: jsonSchema(t) as Anthropic.Beta.BetaTool.InputSchema,
      })),
      messages: this.messages,
      output_config: { effort: 'high' },
      // Server-side fallback when safety classifiers refuse (Opus 5 / Fable 5.1).
      ...(this.cfg.fallbacks ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {}),
    };
    const msg = await this.client.beta.messages.create(params as unknown as Anthropic.Beta.MessageCreateParamsNonStreaming);

    if (msg.stop_reason === 'refusal') return { text: 'The model refused to continue.', calls: [], done: true };
    if (msg.stop_reason === 'max_tokens') throw new Error('The model response was cut off at max_tokens');
    this.messages.push({ role: 'assistant', content: msg.content });
    if (msg.stop_reason === 'pause_turn') return { text: '', calls: [], done: false };

    const text = msg.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');
    const calls = msg.content.flatMap((b) => (b.type === 'tool_use' ? [{ id: b.id, name: b.name, input: b.input }] : []));
    return { text, calls, done: calls.length === 0 };
  }
}

// ── OpenAI-compatible endpoint (local and third-party models) ───────────
type OaiMessage = { role: string; content: string | null; tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]; tool_call_id?: string };

class OpenAICompatibleSession implements Session {
  private messages: OaiMessage[];
  private cfg: Inference;
  private init: SessionInit;

  constructor(cfg: Inference, init: SessionInit) {
    if (!cfg.baseUrl) throw new Error('inference.baseUrl is required for openai-compatible');
    this.cfg = cfg;
    this.init = init;
    this.messages = [
      { role: 'system', content: init.system },
      { role: 'user', content: init.prompt },
    ];
  }

  async next(results: ToolResult[]): Promise<Turn> {
    for (const r of results) this.messages.push({ role: 'tool', tool_call_id: r.id, content: r.isError ? `ERROR: ${r.content}` : r.content });
    const key = this.cfg.apiKeyEnv ? process.env[this.cfg.apiKeyEnv] : undefined;
    const res = await fetch(`${this.cfg.baseUrl!.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({
        model: this.cfg.model,
        messages: this.messages,
        tools: this.init.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: jsonSchema(t) } })),
      }),
    });
    if (!res.ok) throw new Error(`Provider responded ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { choices: { message: OaiMessage }[] };
    const m = data.choices[0].message;
    this.messages.push(m);
    const calls = (m.tool_calls ?? []).map((c) => ({ id: c.id, name: c.function.name, input: JSON.parse(c.function.arguments || '{}') }));
    return { text: m.content ?? '', calls, done: calls.length === 0 };
  }
}

// ── Scripted provider: deterministic replay ─────────────────────────────
// Used for demos, tests and debugging tools without a model.
const Script = z.object({
  steps: z.array(z.object({ say: z.string().optional(), call: z.string(), input: z.record(z.string(), z.unknown()).default({}) })),
});

class ScriptedSession implements Session {
  private steps: z.infer<typeof Script>['steps'];
  private i = 0;
  private vars: () => Record<string, unknown>;

  constructor(steps: z.infer<typeof Script>['steps'], vars: () => Record<string, unknown>) {
    this.steps = steps;
    this.vars = vars;
  }

  async next(results: ToolResult[]): Promise<Turn> {
    const failed = results.find((r) => r.isError);
    if (failed) throw new Error(`Script aborted: ${failed.content}`);
    const step = this.steps[this.i++];
    if (!step) return { text: '', calls: [], done: true };
    const { template } = await import('@tc/model');
    return { text: step.say ?? '', calls: [{ id: `s${this.i}`, name: step.call, input: template(step.input, this.vars()) }], done: false };
  }
}

export async function createSession(cfg: Inference, init: SessionInit, script?: string): Promise<Session> {
  switch (cfg.provider) {
    case 'anthropic':
      return new AnthropicSession(cfg, init);
    case 'openai-compatible':
      return new OpenAICompatibleSession(cfg, init);
    case 'scripted': {
      if (!script) throw new Error('For provider=scripted the agent must specify a script');
      return new ScriptedSession(Script.parse(YAML.parse(await readFile(script, 'utf8'))).steps, init.vars);
    }
  }
}
