// The macOS shell: Electron opens a window over the engine's GUI. On Linux CI
// it runs under xvfb-run; without a display it is skipped.
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import { repo } from '../fixtures.ts';

test.skip(process.platform === 'linux' && !process.env.DISPLAY, 'needs a display (run under xvfb-run)');

test('the desktop app opens a window with the project', async ({ baseURL }) => {
  const executablePath = createRequire(join(repo, 'apps/desktop/package.json'))('electron') as unknown as string;
  const app = await electron.launch({
    executablePath,
    args: [join(repo, 'apps/desktop'), ...(process.platform === 'linux' ? ['--no-sandbox'] : [])],
    env: { ...process.env, TC_UI_URL: baseURL! },
  });
  try {
    const win = await app.firstWindow();
    await expect(win.locator('.brand')).toHaveText('Test Cartographer');
    await expect(win.getByRole('heading', { level: 1 })).toContainText(/shop/i);
  } finally {
    await app.close();
  }
});
