import { describe, expect, it } from 'vitest';
import { rowKeys } from '../../src/views/ObjectParts.tsx';

describe('rowKeys', () => {
  it('gives a proposal its future id unless the model or an earlier proposal holds it', () => {
    const items = [{ id: 'share', own: 'p1-0' }, { id: 'share', own: 'p2-0' }, { id: 'publish', own: 'p1-1' }, { id: '', own: 'p1-2' }];
    const keys = rowKeys(items, (x) => x.id, (x) => x.own, ['publish']);
    expect(items.map((x) => keys.get(x))).toEqual(['share', 'p2-0', 'p1-1', 'p1-2']);
  });
});
