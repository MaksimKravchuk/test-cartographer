// The Agent tab starts a run with this run's settings and lists what it hands in as it goes.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ProjectState, ProposalState } from '../../src/api.ts';

vi.mock('../../src/api.ts', async (actual) => ({
  ...(await actual<typeof import('../../src/api.ts')>()),
  api: { runtimes: vi.fn(), runOnboarding: vi.fn(), explore: vi.fn(), cancel: vi.fn() },
}));
const { api } = await import('../../src/api.ts');
const { RunView } = await import('../../src/views/RunView.tsx');

afterEach(cleanup);

const project = {
  root: '/p',
  entities: [],
  jobs: [],
  usage: {},
  project: { name: 'Shop', interfaces: [], roles: [], mcp: {}, contracts: [], glossary: [], agents: [], runtime: { provider: 'claude', maxSteps: 60 } },
} as unknown as ProjectState;
const props = { project, proposals: [] as ProposalState[], job: null, startedAt: null, log: [], onOpenInbox: vi.fn(), onOpenSettings: vi.fn(), onError: vi.fn() };

describe('RunView', () => {
  vi.mocked(api.runtimes).mockResolvedValue([
    { provider: 'claude', ready: true, models: [{ id: 'opus', title: 'Opus' }] },
    { provider: 'cursor', ready: true, models: [] },
  ]);
  vi.mocked(api.runOnboarding).mockResolvedValue({ job: 'j' });

  it('starts the chosen task with this run’s model, effort and subagents', async () => {
    render(<RunView {...props} />);
    await screen.findByRole('option', { name: 'Opus' });
    await userEvent.selectOptions(screen.getByLabelText('Model'), 'opus');
    await userEvent.selectOptions(screen.getByLabelText('Effort'), 'high');
    await userEvent.click(screen.getByLabelText(/subagents/));
    await userEvent.click(screen.getByRole('button', { name: 'Start review the model' }));
    expect(api.runOnboarding).toHaveBeenCalledWith('live', 'review', expect.objectContaining({ provider: 'claude', model: 'opus', effort: 'high', subagents: true }));
  });

  it('offers no subagents on Cursor', async () => {
    render(<RunView {...props} />);
    await userEvent.selectOptions(screen.getByLabelText('Provider'), 'cursor');
    expect(screen.getByLabelText(/subagents/)).toBeDisabled();
  });

  it('lists what a running agent has handed in so far', () => {
    const proposals = [{ id: 'a', createdAt: new Date().toISOString(), ops: [{}, {}], findings: [{}] }] as unknown as ProposalState[];
    render(<RunView {...props} proposals={proposals} job={{ id: 'j', kind: 'onboard:review', state: 'running' }} startedAt={Date.now()} log={['💬 Checking orders']} />);
    expect(screen.getByText('1 proposal handed in', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('Checking orders')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Review in Inbox' })).toHaveLength(1);
  });

  it('tells what the task’s last run took before the next one starts', () => {
    const usage = { 'onboard:review': { at: '2026-11-21T09:00:00Z', model: 'claude-opus-5', input: 1, output: 1, costUsd: 1.95, seconds: 219 } };
    render(<RunView {...props} project={{ ...project, usage }} />);
    expect(document.querySelector('.field-hint')).toHaveTextContent('Its last run took 3:39 and ≈ $1.95 at API prices on claude-opus-5.');
  });

  it('shows the run’s tokens, context and cost from the latest usage report', () => {
    const usage = { model: 'claude-opus-5-5', input: 120_000, cacheRead: 80_000, output: 3_200, costUsd: 0.42, context: { used: 45_000, window: 1_000_000 }, seconds: 151 };
    render(<RunView {...props} job={{ id: 'j', kind: 'onboard:review', state: 'done' }} log={['📊 {"input":1,"output":1}', `📊 ${JSON.stringify(usage)}`]} />);
    const line = document.querySelector('.run-usage')!;
    expect(line).toHaveTextContent('2:31');
    expect(line).toHaveTextContent('120.0k in (80.0k cached) · 3.2k out');
    expect(line).toHaveTextContent('45.0k of 1.0M (5%)');
    expect(line).toHaveTextContent('≈ $0.42');
  });
});
