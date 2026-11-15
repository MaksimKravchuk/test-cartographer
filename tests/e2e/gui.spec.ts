// Smoke paths through the GUI. The UI is being redesigned, so these stick to
// what any version must do: load the project, list objects, open one, navigate.
import { expect, test } from '@playwright/test';

// The start screen is Model; the test overview is one click away.
async function openOverview(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: /^Overview/ }).click();
}

test('the overview shows the demo project and its entities', async ({ page }) => {
  await openOverview(page);
  await expect(page.locator('.brand')).toHaveText('Test Cartographer');
  await expect(page.getByRole('heading', { level: 1 })).toContainText(/shop/i);
  await expect(page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: /Objects/ })).toContainText('3');
});

test('an entity opens with its map, scenarios and coverage', async ({ page }) => {
  await openOverview(page);
  await page.getByRole('button', { name: /^Order/ }).first().click();
  await expect(page.locator('.crumbs')).toContainText('Order');
  await expect(page.getByRole('tab', { name: /Map/ })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: /Scenarios/ }).click();
  await expect(page.getByRole('tab', { name: /Scenarios/ })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: /Coverage/ }).click();
  await expect(page.getByRole('tab', { name: /Coverage/ })).toHaveAttribute('aria-selected', 'true');
});

test('every section opens without an error', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Sections' });
  for (const name of ['Sources', 'Disagreements', 'Specification', 'Overview', 'Objects', 'Proposals', 'Backlog', 'Export', 'Agents', 'Settings', 'Model']) {
    await nav.getByRole('button', { name: new RegExp(`^${name}`) }).click();
    await expect(nav.getByRole('button', { name: new RegExp(`^${name}`) })).toHaveAttribute('aria-current', 'page');
  }
  expect(errors).toEqual([]);
});

test('export writes Markdown through the GUI', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Export' }).click();
  await page.getByRole('button', { name: 'Export to Markdown' }).click();
  await expect(page.locator('pre.md').first()).toContainText('#');
});
