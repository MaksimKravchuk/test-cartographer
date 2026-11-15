import { defineConfig } from '@playwright/test';

const port = Number(process.env.TC_E2E_PORT ?? 4319);

export default defineConfig({
  testDir: '.',
  timeout: 60_000,
  // One engine and one demo shop are shared, and the run test changes state.
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: '../../playwright-report' }]] : 'list',
  outputDir: '../../test-results',
  use: { baseURL: `http://127.0.0.1:${port}`, trace: 'retain-on-failure' },
  webServer: {
    // The GUI must be built first (pnpm test:e2e does it): the engine serves apps/desktop/dist.
    command: 'node tests/e2e/serve.ts',
    cwd: '../..',
    url: `http://127.0.0.1:${port}/api/project`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
  },
});
