// The add-project form says what will happen before anyone presses a button.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { FolderInfo } from '../../src/api.ts';

vi.mock('../../src/api.ts', async (actual) => ({
  ...(await actual<typeof import('../../src/api.ts')>()),
  api: { folder: vi.fn(), runtimes: vi.fn(), createProject: vi.fn(), openProject: vi.fn() },
}));
const { api } = await import('../../src/api.ts');
const { AddProject } = await import('../../src/views/AddProject.tsx');

const info = (path: string, over: Partial<FolderInfo> = {}): FolderInfo => ({ path, exists: true, dir: true, empty: false, parent: '/home/max', parentExists: true, home: '/home/max', children: [], ...over });
const folders: Record<string, FolderInfo> = {
  '~': info('/home/max'),
  '/home/max/Test Cartographer/Shop': info('/home/max/Test Cartographer/Shop', { exists: false, dir: false }),
  '/home/max/shop': info('/home/max/shop', { project: 'Shop' }),
};

afterEach(cleanup);

describe('AddProject', () => {
  vi.mocked(api.folder).mockImplementation(async (p) => folders[p] ?? info(p, { exists: false, dir: false, parentExists: false }));
  vi.mocked(api.runtimes).mockResolvedValue([{ provider: 'claude', ready: true, models: [] }]);

  it('suggests a folder from the name and creates the project with the app address and agent', async () => {
    const onSubmit = vi.fn((fn: () => Promise<unknown>) => void fn());
    render(<AddProject disabled={false} busy={false} onSubmit={onSubmit} />);
    expect(await screen.findByRole('button', { name: 'Create project' })).toBeDisabled();
    expect(screen.getByText('Name the project.')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Name'), 'Shop');
    expect(await screen.findByText('A new folder will be created.')).toBeInTheDocument();
    expect(screen.getByLabelText('Folder')).toHaveValue('/home/max/Test Cartographer/Shop');
    expect(screen.getByLabelText('Agent')).toHaveValue('claude');
    await userEvent.click(screen.getByRole('button', { name: 'Create project' }));
    expect(api.createProject).toHaveBeenCalledWith('/home/max/Test Cartographer/Shop', 'Shop', { baseUrl: 'http://localhost:3000', code: undefined, provider: 'claude' });
  });

  it('won’t create a project over another one and offers to open it', async () => {
    render(<AddProject disabled={false} busy={false} onSubmit={vi.fn()} />);
    await userEvent.type(screen.getByLabelText('Name'), 'Shop');
    const folder = screen.getByLabelText('Folder');
    await userEvent.clear(folder);
    await userEvent.type(folder, '/home/max/shop');
    expect(await screen.findByText(/Already a project, “Shop”/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create project' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Open it instead' }));
    expect(await screen.findByText('Test Cartographer project “Shop”.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open project' })).toBeEnabled();
  });
});

describe('AddProject while a path is being checked', () => {
  it('doesn’t keep the last folder’s answer for a new path', async () => {
    render(<AddProject disabled={false} busy={false} onSubmit={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Open existing' }));
    const folder = screen.getByLabelText('Folder');
    await userEvent.type(folder, '/home/max/shop');
    expect(await screen.findByText('Test Cartographer project “Shop”.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open project' })).toBeEnabled();
    await userEvent.type(folder, '-old');
    expect(screen.getByRole('button', { name: 'Open project' })).toBeDisabled();
    expect(screen.getByText('Checking…')).toBeInTheDocument();
  });
});
