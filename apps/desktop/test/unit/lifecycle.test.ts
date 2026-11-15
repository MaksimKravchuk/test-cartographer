import { describe, expect, it } from 'vitest';
import type { Entity } from '@tc/model';
import { lifecycleOrder } from '../../src/views/LifecycleView.tsx';
import { lifecycles } from '../../src/views/ObjectParts.tsx';

describe('lifecycleOrder', () => {
  it('orders states the way an instance goes through them, final states last', () => {
    const states = [{ id: 'cancelled', terminal: true }, { id: 'paid' }, { id: '@new' }, { id: 'open' }, { id: 'orphan' }];
    const edges = [{ from: '@new', to: 'open' }, { from: 'open', to: 'cancelled' }, { from: 'open', to: 'paid' }];
    expect(lifecycleOrder(states, edges)).toEqual(['@new', 'open', 'paid', 'orphan', 'cancelled']);
  });
});


describe('lifecycles', () => {
  const st = (id: string, match: Record<string, unknown>) => ({ id, title: id, match, setup: [], status: 'confirmed' });
  const entity = (attributes: unknown[]) =>
    ({ attributes, states: [st('open', { status: 'open' }), st('done', { status: 'done' }), st('trash', { trashed: true })] }) as unknown as Entity;
  it('makes one table per enum parameter that states match on', () => {
    const e = entity([{ id: 'status', title: 'Status', type: 'enum', values: ['open', 'done'], status: 'confirmed' }, { id: 'title', title: 'Title', type: 'text', status: 'confirmed' }]);
    expect(lifecycles(e)).toEqual([{ title: 'Status', states: ['open', 'done'] }]);
  });
  it('falls back to all states when no parameter names them', () => {
    expect(lifecycles(entity([]))).toEqual([{ title: 'States', states: ['open', 'done', 'trash'] }]);
  });
});
