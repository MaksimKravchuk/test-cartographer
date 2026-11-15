// Page-level views that render engine data: driven by props, or by a mocked engine API.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { EntitySummary, ProjectState } from '../../src/api.ts';
import { OverviewView } from '../../src/views/OverviewView.tsx';
import { ExportView } from '../../src/views/ExportView.tsx';

vi.mock('../../src/api.ts', () => ({ api: { exportMarkdown: vi.fn() } }));
const { api } = await import('../../src/api.ts');

afterEach(() => {
  cleanup();
  vi.mocked(api.exportMarkdown).mockReset();
});

const project = { project: { name: 'Demo shop' } } as ProjectState;
const totals = { scenarios: 10, passed: 7, failed: 2, blocked: 1, skipped: 0, 'not-run': 0 };
const entity = (over: Partial<EntitySummary>): EntitySummary => ({
  id: 'order',
  title: 'Order',
  description: '',
  counts: { variants: 2, states: 5, actions: 4, transitions: 6, permits: 3, rules: 1, journeys: 1, observations: 0 },
  totals,
  relations: [],
  parent: null,
  states: [],
  roles: [],
  fields: [],
  pendingProposals: 0,
  errors: 0,
  ...over,
});

describe('OverviewView', () => {
  const noop = () => {};

  it('sums scenarios across entities and opens one on click', async () => {
    const onOpen = vi.fn();
    const entities = [
      entity({ pendingProposals: 2 }),
      entity({ id: 'listing', title: 'Listing', relations: [{ id: 'r', entity: 'order', title: 'Order', requires: null, kind: 'reference' }] }),
    ];
    render(<OverviewView project={project} entities={entities} onOpen={onOpen} onOpenOnboarding={noop} onOpenObjects={noop} />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Demo shop');
    expect(screen.getByText(/2 entities, 20 scenarios: 14 passed/)).toBeInTheDocument();
    expect(screen.getByText('2 proposals to review')).toBeInTheDocument();
    expect(screen.getByText('Used by Listing')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /^Listing/ }));
    expect(onOpen).toHaveBeenCalledWith('listing');
  });

  it('sends an empty project to onboarding', async () => {
    const onOpenOnboarding = vi.fn();
    render(<OverviewView project={project} entities={[]} onOpen={noop} onOpenOnboarding={onOpenOnboarding} onOpenObjects={noop} />);
    await userEvent.click(screen.getByRole('button', { name: 'Go to Onboarding' }));
    expect(onOpenOnboarding).toHaveBeenCalled();
  });
});

describe('ExportView', () => {
  it('shows the exported files', async () => {
    vi.mocked(api.exportMarkdown).mockResolvedValue({ files: [{ path: 'export/order.md', content: '# Order scenarios' }] });
    render(<ExportView onError={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Export to Markdown' }));
    expect(await screen.findByText('export/order.md')).toBeInTheDocument();
    expect(screen.getByText('# Order scenarios')).toBeInTheDocument();
  });

  it('reports an engine error and lets the user retry', async () => {
    vi.mocked(api.exportMarkdown).mockRejectedValue(new Error('engine is down'));
    const onError = vi.fn();
    render(<ExportView onError={onError} />);
    const button = screen.getByRole('button', { name: 'Export to Markdown' });
    await userEvent.click(button);
    expect(onError).toHaveBeenCalledWith('engine is down');
    expect(button).toBeEnabled();
  });
});
