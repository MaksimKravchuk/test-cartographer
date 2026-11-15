import { describe, expect, it } from 'vitest';
import { autoLayout, NODE_H, NODE_W, nextId, objectCardHeight, objectsLayout, applies } from '../../src/graph.ts';

describe('nextId', () => {
  it('slugifies a title into an id', () => expect(nextId('Awaiting Stock!', [])).toBe('awaiting-stock'));
  it('prefixes ids that would not start with a letter', () => expect(nextId('42 items', [])).toBe('x-42-items'));
  it('falls back to "item" for an empty slug', () => expect(nextId('!!!', [])).toBe('item'));
  it('adds the first free numeric suffix', () => expect(nextId('paid', ['paid', 'paid-2'])).toBe('paid-3'));
});

describe('applies', () => {
  it('applies when no variant is selected or the element has no variants', () => {
    expect(applies({ variants: ['digital'] }, null)).toBe(true);
    expect(applies({}, 'digital')).toBe(true);
  });
  it('filters by the selected variant', () => {
    expect(applies({ variants: ['digital'] }, 'digital')).toBe(true);
    expect(applies({ variants: ['digital'] }, 'preorder')).toBe(false);
  });
});

const overlap = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.abs(a.x - b.x) < NODE_W && Math.abs(a.y - b.y) < NODE_H;

describe('autoLayout', () => {
  const states = [{ id: 'new' }, { id: 'paid' }, { id: 'shipped' }];
  const edges = [
    { id: 'pay', from: 'new', to: 'paid', title: 'Pay' },
    { id: 'ship', from: 'paid', to: 'shipped', title: 'Ship' },
  ];

  it('lays a lifecycle out top-down without overlaps', () => {
    const p = autoLayout(states, edges, {});
    expect(p.new.y).toBeLessThan(p.paid.y);
    expect(p.paid.y).toBeLessThan(p.shipped.y);
    expect(overlap(p.new, p.paid) || overlap(p.paid, p.shipped)).toBe(false);
  });

  it('keeps saved positions and places new nodes next to them without overlap', () => {
    const saved = { new: { x: 500, y: 500 }, paid: { x: 500, y: 700 } };
    const p = autoLayout(states, edges, saved);
    expect(p.new).toEqual(saved.new);
    expect(p.paid).toEqual(saved.paid);
    expect(Object.values(saved).some((q) => overlap(q, p.shipped))).toBe(false);
  });
});

describe('objects map layout', () => {
  it('estimates taller cards for more states and roles', () => {
    expect(objectCardHeight(6, 2, true)).toBeGreaterThan(objectCardHeight(1, 0, false));
  });

  // A part's position is relative to its parent frame (React Flow sub-flows).
  it('nests a part inside its parent frame', () => {
    const box = { width: 260, height: 120 };
    const { position, size } = objectsLayout({ order: box, 'line-item': box, listing: box }, { order: null, 'line-item': 'order', listing: null }, [
      { from: 'line-item', to: 'listing', label: 'needs' },
    ]);
    const li = position['line-item'];
    expect(li.x).toBeGreaterThan(0);
    expect(li.y).toBeGreaterThan(box.height); // below the parent's own card
    expect(li.x + size['line-item'].width).toBeLessThanOrEqual(size.order.width);
    expect(li.y + size['line-item'].height).toBeLessThanOrEqual(size.order.height);
    expect(size.order.height).toBeGreaterThan(box.height);
  });
});
