import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Entity, Project, objectParents, validateEntity } from '../src/index.ts';

const project = Project.parse({
  name: 'Test',
  interfaces: [{ id: 'ui', title: 'UI', baseUrl: 'http://localhost/ui' }],
  roles: [{ id: 'client', title: 'Client', interface: 'ui' }],
});

// A bare entity with no lifecycle — objectParents and the part-of checks only look at `id`/`relations`.
function bare(id: string, title: string, relations: Record<string, unknown>[] = []) {
  return Entity.parse({ id, title, variants: [{ id: 'default', title: 'Default' }], relations });
}

const reference = (entity: string) => ({ id: entity, entity, field: `${entity}Id` });
const partOf = (entity: string) => ({ id: entity, entity, field: `${entity}Id`, kind: 'part-of' });

test('objectParents: a part-of relation to an existing entity sets the parent', () => {
  const order = bare('order', 'Order');
  const lineItem = bare('line-item', 'Line Item', [partOf('order')]);
  assert.deepEqual(objectParents([order, lineItem]), { order: null, 'line-item': 'order' });
});

test('objectParents: a part-of relation to a missing target leaves the parent null', () => {
  const lineItem = bare('line-item', 'Line Item', [partOf('ghost')]);
  assert.deepEqual(objectParents([lineItem]), { 'line-item': null });
});

test('objectParents: a part-of cycle resolves to null for every entity on it', () => {
  const a = bare('a', 'A', [partOf('b')]);
  const b = bare('b', 'B', [partOf('a')]);
  assert.deepEqual(objectParents([a, b]), { a: null, b: null });
});

test('objectParents: only the first part-of relation counts, later ones are ignored', () => {
  const order = bare('order', 'Order');
  const listing = bare('listing', 'Listing');
  const lineItem = bare('line-item', 'Line Item', [partOf('order'), partOf('listing')]);
  assert.deepEqual(objectParents([order, listing, lineItem])['line-item'], 'order');
});

test('objectParents: a reference relation is not a part-of relation', () => {
  const listing = bare('listing', 'Listing');
  const order = bare('order', 'Order', [reference('listing')]);
  assert.deepEqual(objectParents([order, listing]), { order: null, listing: null });
});

test('validate: a part-of relation to itself is an error', () => {
  const lineItem = bare('line-item', 'Line Item', [partOf('line-item')]);
  const messages = validateEntity(lineItem, project, undefined, { 'line-item': lineItem }).map((i) => i.message).join('\n');
  assert.match(messages, /An object can't be part of itself/);
});

test('validate: a second part-of relation is an error naming the first parent', () => {
  const order = bare('order', 'Order');
  const listing = bare('listing', 'Listing');
  const lineItem = bare('line-item', 'Line Item', [partOf('order'), partOf('listing')]);
  const catalog = { order, listing, 'line-item': lineItem };
  const messages = validateEntity(lineItem, project, undefined, catalog).map((i) => i.message).join('\n');
  assert.match(messages, /Already part of Order; an object has one parent/);
});

test('validate: a part-of cycle through the catalog is an error naming the whole loop', () => {
  const lineItem = bare('line-item', 'Line Item', [partOf('order')]);
  const order = bare('order', 'Order', [partOf('line-item')]);
  const catalog = { order, 'line-item': lineItem };
  const messages = validateEntity(lineItem, project, undefined, catalog).map((i) => i.message).join('\n');
  assert.match(messages, /Part-of cycle: line-item → order → line-item/);
});
