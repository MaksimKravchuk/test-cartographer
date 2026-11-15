import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveOutputs, type Workflow } from '../src/arazzo-tool.ts';

test('arazzo tool: workflow outputs are resolved from the step responses Respect logged', () => {
  const wf: Workflow = {
    workflowId: 'orderFromListing',
    steps: [
      { stepId: 'listing', outputs: { id: '$response.body#/id' } },
      { stepId: 'order', outputs: { id: '$response.body#/id', code: '$statusCode', item: '$response.body#/lines/0/sku' } },
    ],
    outputs: { orderId: '$steps.order.outputs.id', listingId: '$steps.listing.outputs.id', code: '$steps.order.outputs.code', sku: '$steps.order.outputs.item', missing: '$inputs.x' },
  };
  const executed = [
    { stepId: 'listing', status: 'success', response: { statusCode: 201, body: { id: 'lst_1' } } },
    { stepId: 'order', status: 'success', response: { statusCode: 201, body: { id: 'ord_1', lines: [{ sku: 'L-1' }] } } },
  ];
  assert.deepEqual(resolveOutputs(wf, executed), { orderId: 'ord_1', listingId: 'lst_1', code: 201, sku: 'L-1', missing: undefined });
});
