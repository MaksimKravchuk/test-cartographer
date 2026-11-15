// Shared building blocks of the Inspector and the Backlog: small, stable, used everywhere.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { KeyValues, Lines, RoleMultiSelect, StatusField } from '../../src/views/InspectorElements.tsx';
import { ScenarioList, SegBar } from '../../src/views/BacklogElements.tsx';

afterEach(cleanup);

describe('StatusField', () => {
  it('reports the picked status', async () => {
    const onChange = vi.fn();
    render(<StatusField value="proposed" onChange={onChange} />);
    await userEvent.selectOptions(screen.getByLabelText('Status'), 'confirmed');
    expect(onChange).toHaveBeenCalledWith('confirmed');
  });
});

describe('RoleMultiSelect', () => {
  const roles: [string, string][] = [['client', 'Buyer'], ['seller', 'Seller']];

  it('adds a checked role', async () => {
    const onChange = vi.fn();
    render(<RoleMultiSelect label="By" roles={roles} value={['client']} onChange={onChange} />);
    await userEvent.click(screen.getByLabelText('Seller'));
    expect(onChange).toHaveBeenCalledWith(['client', 'seller']);
  });

  it('does not let the last role be unchecked', () => {
    render(<RoleMultiSelect label="By" roles={roles} value={['client']} onChange={() => {}} />);
    expect(screen.getByLabelText('Buyer')).toBeDisabled();
    expect(screen.getByLabelText('Seller')).not.toBeDisabled();
  });
});

describe('KeyValues', () => {
  it('parses JSON values on blur and keeps the rest as strings', () => {
    const onChange = vi.fn();
    render(<KeyValues label="Args" value={{}} onChange={onChange} />);
    const box = screen.getByLabelText('Args');
    fireEvent.change(box, { target: { value: 'count: 2\npaid: true\nnote: hello world\nno colon here' } });
    fireEvent.blur(box);
    expect(onChange).toHaveBeenCalledWith({ count: 2, paid: true, note: 'hello world' });
  });
});

describe('Lines', () => {
  it('trims lines and drops empty ones on blur', () => {
    const onChange = vi.fn();
    render(<Lines label="Steps" value={[]} onChange={onChange} />);
    const box = screen.getByLabelText('Steps');
    fireEvent.change(box, { target: { value: '  open the order \n\n click Pay' } });
    fireEvent.blur(box);
    expect(onChange).toHaveBeenCalledWith(['open the order', 'click Pay']);
  });
});

describe('ScenarioList', () => {
  it('shows titles from the index and falls back to the id', () => {
    render(<ScenarioList ids={['order/pay', 'order/ship']} index={{ 'order/pay': { title: 'Buyer pays', status: 'passed' } }} />);
    expect(screen.getByText('Buyer pays')).toBeInTheDocument();
    expect(screen.getByText('order/ship')).toBeInTheDocument();
  });

  it('says when there is nothing to show', () => {
    render(<ScenarioList ids={[]} index={{}} />);
    expect(screen.getByText('No scenarios.')).toBeInTheDocument();
  });
});

describe('SegBar', () => {
  it('draws one segment per non-zero status, sized by share', () => {
    const { container } = render(<SegBar totals={{ scenarios: 4, passed: 3, failed: 1, blocked: 0, skipped: 0, 'not-run': 0 }} />);
    const segs = container.querySelectorAll('.seg-bar i');
    expect([...segs].map((s) => [s.className, (s as HTMLElement).style.width])).toEqual([['passed', '75%'], ['failed', '25%']]);
  });
});
