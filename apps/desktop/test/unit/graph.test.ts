import { describe, expect, it } from 'vitest';
import { nextId } from '../../src/graph.ts';

describe('nextId', () => {
  it('slugifies a title into an id', () => expect(nextId('Awaiting Stock!', [])).toBe('awaiting-stock'));
  it('prefixes ids that would not start with a letter', () => expect(nextId('42 items', [])).toBe('x-42-items'));
  it('falls back to "item" for an empty slug', () => expect(nextId('!!!', [])).toBe('item'));
  it('adds the first free numeric suffix', () => expect(nextId('paid', ['paid', 'paid-2'])).toBe('paid-3'));
});
