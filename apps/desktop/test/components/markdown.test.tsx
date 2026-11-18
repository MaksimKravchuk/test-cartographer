import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { renderMarkdown } from '../../src/markdown.tsx';

describe('renderMarkdown', () => {
  const md = '# Shop\n\n## Order\n\nStates: **Paid** · `x`\n\n### Buyer → Cancel\n\n- Moves order from Created to Cancelled — tests: `a/b`, `c/d`\n- A _plain_ rule\n';
  it('collects headings for the table of contents', () => {
    expect(renderMarkdown(md).headings.map((h) => [h.level, h.text])).toEqual([[1, 'Shop'], [2, 'Order'], [3, 'Buyer → Cancel']]);
  });
  it('renders lists, inline marks and a test count instead of the test list', () => {
    const { container } = render(<div>{renderMarkdown(md).nodes}</div>);
    expect(container.querySelectorAll('li')).toHaveLength(2);
    expect(container.querySelector('p b')?.textContent).toBe('Paid');
    expect(container.querySelector('.tests')?.textContent).toBe('2 tests');
    expect(container.querySelector('.tests + .tip')?.textContent).toBe('a/b\nc/d');
    expect(container.querySelector('li i')?.textContent).toBe('plain');
  });
});
