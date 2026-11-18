// A change to an entity that isn't in the model yet offers to add it, instead of a dead end.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../src/api.ts', async (actual) => ({
  ...(await actual<typeof import('../../src/api.ts')>()),
  api: { sources: vi.fn().mockResolvedValue({ sources: [] }), entity: vi.fn().mockRejectedValue(new Error('none')), backlog: vi.fn(), decide: vi.fn().mockResolvedValue({}) },
}));
const { api } = await import('../../src/api.ts');
const { ProposalsView } = await import('../../src/views/ProposalsView.tsx');

afterEach(cleanup);

const proposal = {
  id: 'p1', entity: 'auth', agent: 'onboarding', createdAt: '', baseRevision: 'new', rationale: '', evidence: [], findings: [],
  ops: [{ op: 'add', kind: 'action', value: { id: 'signup', title: 'Sign up with invite' }, evidence: [] }],
  status: 'pending', decisions: [], resolutions: [], stale: false,
  conflicts: [{ op: 0, message: "Entity “auth” doesn't exist yet — accept it in the project proposal first" }],
};
const props = {
  project: { project: { agents: [], roles: [] } } as never, proposals: [proposal] as never, entities: [], dirty: false, running: false,
  selected: 'p1', onDecided: vi.fn(), onError: vi.fn(),
};

describe('ProposalsView', () => {
  it('adds the missing entity together with the change, or leaves both out', async () => {
    render(<ProposalsView {...props} />);
    expect(screen.queryByText(/can only be rejected/)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Add “auth” and this action' }));
    expect(api.decide).toHaveBeenCalledWith('p1', [{ op: 0, verdict: 'accept' }], true);
    await userEvent.click(screen.getByRole('button', { name: "Don't add" }));
    expect(api.decide).toHaveBeenLastCalledWith('p1', [{ op: 0, verdict: 'reject' }], undefined);
  });

  it('names what each way of accepting means', () => {
    render(<ProposalsView {...props} entities={[{ id: 'auth', title: 'Auth' }] as never} />);
    expect(screen.getByRole('button', { name: 'Accept as requirement' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Observed only' })).toHaveAccessibleDescription(/no source requires it/);
    expect(screen.getByRole('button', { name: 'Not built yet' })).toBeInTheDocument();
  });
});
