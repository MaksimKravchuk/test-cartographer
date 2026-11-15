import { describe, expect, it } from 'vitest';
import { lifecycleOrder } from '../../src/views/LifecycleView.tsx';

describe('lifecycleOrder', () => {
  it('orders states the way an instance goes through them, final states last', () => {
    const states = [{ id: 'cancelled', terminal: true }, { id: 'paid' }, { id: '@new' }, { id: 'open' }, { id: 'orphan' }];
    const edges = [{ from: '@new', to: 'open' }, { from: 'open', to: 'cancelled' }, { from: 'open', to: 'paid' }];
    expect(lifecycleOrder(states, edges)).toEqual(['@new', 'open', 'paid', 'orphan', 'cancelled']);
  });
});

