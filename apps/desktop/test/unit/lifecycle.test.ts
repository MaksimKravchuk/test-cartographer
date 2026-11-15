import { describe, expect, it } from 'vitest';
import { lifecycleOrder, lifecycleRows, type LifecycleItem } from '../../src/views/LifecycleView.tsx';

const t = (from: string, to: string, action: string, status = 'confirmed') =>
  ({ transition: { id: `${from}-${action}-${to}`, from, to, action, status, by: ['user'], guards: [], effects: [], title: '' } }) as unknown as LifecycleItem;

describe('lifecycleOrder', () => {
  it('orders states the way an instance goes through them, final states last', () => {
    const states = [{ id: 'cancelled', terminal: true }, { id: 'paid' }, { id: '@new' }, { id: 'open' }, { id: 'orphan' }];
    const edges = [{ from: '@new', to: 'open' }, { from: 'open', to: 'cancelled' }, { from: 'open', to: 'paid' }];
    expect(lifecycleOrder(states, edges)).toEqual(['@new', 'open', 'paid', 'orphan', 'cancelled']);
  });
});

describe('lifecycleRows', () => {
  it('makes one row of one action from several states, and one per lone transition', () => {
    const rows = lifecycleRows([t('a', 'x', 'cancel'), t('b', 'x', 'cancel'), t('x', 'a', 'reopen'), t('x', 'b', 'reopen'), t('a', 'b', 'go')]);
    expect(rows.map((r) => `${r.from.join(',')}>${r.to.join(',')}`)).toEqual(['a,b>x', 'x>a,b', 'a>b']);
  });
  it('keeps proposals and confirmed transitions in separate rows', () => {
    expect(lifecycleRows([t('a', 'x', 'cancel'), t('b', 'x', 'cancel', 'proposed')])).toHaveLength(2);
  });
});
