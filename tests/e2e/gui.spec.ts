// Smoke paths through the GUI. The UI is being redesigned, so these stick to
// what any version must do: load the project, list objects, open one, navigate.
import { expect, test } from '@playwright/test';

type Page = import('@playwright/test').Page;
const place = (page: Page, name: string) => page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: new RegExp(`^${name}`) });
const view = (page: Page, name: string) => page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: new RegExp(`^${name}`) });

// The start screen is Model; the test overview is the first view under Tests.
async function openOverview(page: Page) {
  await page.goto('/');
  await place(page, 'Tests').click();
}

test('the overview shows the demo project and its entities', async ({ page }) => {
  await openOverview(page);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(/shop/i);
  await place(page, 'Model').click();
  await expect(view(page, 'Map')).toContainText('3');
});

test('the glossary is under Model and lists the project words', async ({ page }) => {
  await page.goto('/');
  await place(page, 'Model').click();
  await view(page, 'Glossary').click();
  await expect(page.getByRole('heading', { name: 'Glossary', level: 1 })).toBeVisible();
  await expect(page.getByLabel('Term').first()).toHaveValue('Order');
  await expect(page.getByLabel('Also called').first()).toHaveValue('purchase');
  if (process.env.TC_SHOT3) await page.screenshot({ path: process.env.TC_SHOT3, fullPage: true });
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
  const places: [string, string[]][] = [['Sources', []], ['Model', ['Map', 'Model']], ['Inbox', ['By source', 'Queue']], ['Spec', []], ['Tests', ['Backlog', 'Export', 'Overview']], ['Agent', []]];
  for (const [name, views] of places) {
    await place(page, name).click();
    await expect(place(page, name)).toHaveAttribute('aria-current', 'page');
    for (const v of views) {
      await view(page, v).click();
      await expect(view(page, v)).toHaveAttribute('aria-current', 'page');
    }
  }
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  for (const v of ['Agents', 'Projects', 'Project']) {
    await view(page, `${v}$`).click();
    await expect(view(page, `${v}$`)).toHaveAttribute('aria-current', 'page');
  }
  expect(errors).toEqual([]);
});

test('export writes Markdown through the GUI', async ({ page }) => {
  await page.goto('/');
  await place(page, 'Tests').click();
  await view(page, 'Export').click();
  await page.getByRole('button', { name: 'Export to Markdown' }).click();
  await expect(page.locator('pre.md').first()).toContainText('#');
});

test('a review shows by source which one contradicts the model', async ({ page }) => {
  // The button picks a live agent when one is installed; the test needs the scripted review.
  expect((await page.request.post('/api/onboarding/run', { data: { provider: 'scripted', mode: 'review' } })).ok()).toBe(true);
  // The scripted review runs as a job; reopen the page until its findings land.
  await expect(async () => {
    await page.goto('/');
    await place(page, 'Inbox').click();
    await view(page, 'By source').click();
    await expect(page.getByRole('table', { name: 'Review by source' }).getByText('✕').first()).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  // A confirmation fills its row too: the overview and the code agree on the expiry.
  await expect(page.getByRole('table', { name: 'Review by source' }).getByRole('row', { name: /Action: Expire/ })).toContainText('✓');
  if (process.env.TC_SHOT) await page.screenshot({ path: process.env.TC_SHOT, fullPage: true });

  // The Inbox queue opens on the contradiction, with each source's quote and the verdicts.
  await view(page, 'Queue').click();
  const finding = page.getByRole('article', { name: 'Finding' });
  await expect(finding).toContainText('contradiction');
  await expect(finding.getByRole('button', { name: /Bug in the product/ })).toBeEnabled();

  // The model screen lists the same contradiction in its "what to do next" queue, and its link opens the action.
  await place(page, 'Model').click();
  const next = page.getByRole('region', { name: 'What to do next' });
  await expect(next).toContainText(/contradictions between sources/);
  await next.getByRole('link', { name: /Requirements \(priority 1\)/ }).click();
  await expect(page.getByRole('heading', { name: /→ Cancel/ })).toBeVisible();
  // The agent's rule sits on the action itself, with its quote and the verdicts in words.
  const rules = page.getByRole('region', { name: 'Rules' });
  await expect(rules.getByText('proposed').first()).toBeVisible();
  await expect(rules.getByRole('button', { name: 'Accept as requirement' }).first()).toBeEnabled();
  if (process.env.TC_SHOT2) await page.screenshot({ path: process.env.TC_SHOT2, fullPage: true });
});

test('the Agent tab runs a task and lists what it hands in as it goes', async ({ page }) => {
  await page.goto('/');
  await place(page, 'Agent').click();
  await page.getByRole('radio', { name: /Research from scratch/ }).check();
  // No provider: the scripted onboarding, which records the backlog before it finishes.
  await page.getByLabel('Provider').selectOption('');
  await page.getByRole('button', { name: 'Start research from scratch' }).click();
  await expect(page.getByRole('heading', { name: /Last run — done/ })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('button', { name: 'Review in Inbox' })).toHaveCount(3);
  if (process.env.TC_SHOT3) await page.screenshot({ path: process.env.TC_SHOT3, fullPage: true });
});
