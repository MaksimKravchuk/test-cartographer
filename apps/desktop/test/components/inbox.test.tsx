// Each kind of finding gets the answers that fit it, not one triad for all.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Disagreement } from '@tc/model';

vi.mock('../../src/api.ts', async (actual) => ({
  ...(await actual<typeof import('../../src/api.ts')>()),
  api: { report: vi.fn(), resolve: vi.fn(), supplyData: vi.fn() },
}));
const { api } = await import('../../src/api.ts');
const { InboxView } = await import('../../src/views/InboxView.tsx');

const finding = (index: number, f: Partial<Disagreement['finding']>): Disagreement =>
  ({ proposal: 'p1', index, finding: { kind: 'question', note: '', refs: [], evidence: [], ...f }, quotes: [], createdAt: '2026-11-15T00:00:00Z' }) as Disagreement;

afterEach(cleanup);

describe('InboxView', () => {
  vi.mocked(api.resolve).mockResolvedValue({ ok: true } as never);
  vi.mocked(api.report).mockResolvedValue({
    disagreements: [
      finding(0, { kind: 'source', note: 'rust/crates returned no files' }),
      finding(1, { kind: 'question', note: 'Is Location the same as Place?', synonym: { term: 'Location', synonym: 'Place' } }),
      finding(2, { kind: 'question', note: 'Who can delete a tag?' }),
      finding(3, { kind: 'contradiction', note: 'Docs and code disagree' }),
      finding(4, { kind: 'question', note: 'Who may archive a project?', options: ['Only the owner', 'Any member'] }),
      finding(5, { kind: 'gap', note: 'Checkout needs a test card', need: { owner: 'roles', id: 'buyer', field: 'card', secret: true } }),
    ],
    lint: [], sources: [], usePriority: false,
  } as never);
  const props = {
    project: { project: { agents: [] } } as never, proposals: [], entities: [], dirty: false, running: false, clarifying: false, reloadToken: 0,
    onDecided: vi.fn(), onChanged: vi.fn(), onError: vi.fn(), onClarify: vi.fn(), onRerun: vi.fn(),
  };

  it('a source problem is fixed or left out, not a product bug', async () => {
    render(<InboxView {...props} />);
    expect(await screen.findByText('Source problems')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Fixed, read it again next run/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Bug in the product/ })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /Left out on purpose/ }));
    expect(api.resolve).toHaveBeenCalledWith('p1', 0, 'excluded', undefined);
  });

  it('a synonym question is answered yes or no, a question also in words; a contradiction keeps the triad', async () => {
    render(<InboxView {...props} />);
    await userEvent.click(await screen.findByRole('button', { name: /Is Location the same as Place/ }));
    expect(screen.getByText(/adds “Place” to the glossary/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Yes, the same thing/ }));
    expect(api.resolve).toHaveBeenCalledWith('p1', 1, 'yes', undefined);

    await userEvent.click(screen.getByRole('button', { name: /Who can delete a tag/ }));
    await userEvent.type(screen.getByLabelText('Your answer'), 'Only the owner{Enter}');
    expect(api.resolve).toHaveBeenCalledWith('p1', 2, 'answered', 'Only the owner');

    await userEvent.click(screen.getByRole('button', { name: /Docs and code disagree/ }));
    expect(screen.getByRole('button', { name: /Bug in the product/ })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Who may archive a project/ }));
    expect(screen.queryByRole('button', { name: /^Yes/ })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /Any member/ }));
    expect(api.resolve).toHaveBeenCalledWith('p1', 4, 'answered', 'Any member');
  });

  it('Need more context asks an agent to dig into the finding, and says so while it works', async () => {
    const { rerender } = render(<InboxView {...props} />);
    await userEvent.click(await screen.findByRole('button', { name: /Who can delete a tag/ }));
    await userEvent.click(screen.getByRole('button', { name: /Need more context/ }));
    expect(props.onClarify).toHaveBeenCalledWith({ proposal: 'p1', index: 2 });
    rerender(<InboxView {...props} running clarifying />);
    expect(screen.getByRole('status')).toHaveTextContent(/looking into this/);
    expect(screen.getByRole('button', { name: /Need more context/ })).toBeDisabled();
  });

  it('a gap that lacks data asks for the value, masked for a secret', async () => {
    vi.mocked(api.supplyData).mockResolvedValue({ ok: true } as never);
    render(<InboxView {...props} />);
    await userEvent.click(await screen.findByRole('button', { name: /Checkout needs a test card/ }));
    expect(screen.queryByRole('button', { name: /Bug in the product/ })).toBeNull();
    const input = screen.getByLabelText('{{roles.buyer.card}}');
    expect(input).toHaveAttribute('type', 'password');
    await userEvent.type(input, '4242{Enter}');
    expect(api.supplyData).toHaveBeenCalledWith('p1', 5, '4242');
  });
});
