import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { Finding, Op } from '@tc/model';
import { listOf } from '../src/agents/runtime.ts';

// What the bridge serves for a tool: its input as JSON Schema, input-shaped.
const served = (s: z.ZodObject) => z.toJSONSchema(s, { io: 'input' }) as any;
const input = z.object({ ops: listOf(Op), findings: listOf(Finding).default([]) });

test('listOf: the agent is shown the item shape — fields, enums, required keys', () => {
  const { properties: p, required } = served(input);
  assert.deepEqual(required, ['ops']);
  assert.deepEqual(p.findings.default, []);
  assert.deepEqual(p.findings.items.required, ['kind', 'note']);
  assert.deepEqual(p.findings.items.properties.kind.enum, ['gap', 'contradiction', 'question']);
  const ops = p.ops.items.oneOf;
  assert.deepEqual(ops.map((o: any) => o.properties.op.const), ['add', 'update', 'remove']);
  assert.deepEqual(ops.map((o: any) => o.required), [['op', 'kind', 'value'], ['op', 'kind', 'id', 'set'], ['op', 'kind', 'id']]);
  assert.ok(ops[0].properties.kind.enum.includes('transition') && ops[0].properties.kind.enum.includes('story'));
});

test('listOf: items are not checked on parse — the tool checks them and explains', () => {
  const parsed = input.safeParse({ ops: [{ op: 'add' }], findings: [{ kind: 'gap' }] });
  assert.ok(parsed.success);
  assert.deepEqual(parsed.data.findings, [{ kind: 'gap' }]);
  assert.ok(!input.safeParse({ ops: 'none' }).success);
});
