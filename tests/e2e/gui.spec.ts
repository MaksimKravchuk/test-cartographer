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
  await expect(page.getByRole('complementary', { name: 'Model outline' }).getByRole('button', { name: /^Order/ })).toBeVisible();
});

test('the glossary is under Model and lists the project words', async ({ page }) => {
  await page.goto('/');
  await place(page, 'Model').click();
  await page.getByRole('complementary', { name: 'Model outline' }).getByRole('button', { name: /^Glossary/ }).click();
  await expect(page.getByRole('heading', { name: 'Glossary', level: 1 })).toBeVisible();
  await expect(page.getByLabel('Term').first()).toHaveValue('Order');
  await expect(page.getByLabel('Also called').first()).toHaveValue('purchase');
  if (process.env.TC_SHOT3) await page.screenshot({ path: process.env.TC_SHOT3, fullPage: true });
});

test('an object lists its actions with who does them and what they change', async ({ page }) => {
  await page.goto('/');
  await place(page, 'Model').click();
  await page.getByRole('complementary', { name: 'Model outline' }).getByRole('button', { name: /^Order/ }).click();
  const actions = page.getByRole('region', { name: 'Actions' });
  await expect(actions.getByRole('row', { name: /^Pay Buyer Created → Paid/ })).toBeVisible();
  await actions.getByRole('button', { name: /^Cancel/ }).click();
  const action = page.getByRole('region', { name: 'Rules' });
  await expect(action.getByRole('checkbox', { name: 'Buyer' })).toBeChecked();
  await expect(action.getByRole('group', { name: 'What it changes' })).toContainText('Created → Cancelled');
  if (process.env.TC_SHOT4) await page.screenshot({ path: process.env.TC_SHOT4, fullPage: true });
});

test('who performs an action and what it changes are edited on the action', async ({ page }) => {
  await page.goto('/');
  await place(page, 'Model').click();
  await page.getByRole('complementary', { name: 'Model outline' }).getByRole('button', { name: /^Order/ }).click();
  const actions = page.getByRole('region', { name: 'Actions' });
  await actions.getByRole('button', { name: /^Pay/ }).click();
  const action = page.getByRole('region', { name: 'Rules' });
  // A subject ticked on the action performs every change it makes; unticked, none of them.
  await action.getByRole('checkbox', { name: 'Seller' }).click();
  await expect(actions.getByRole('row', { name: /^Pay Buyer, Seller/ })).toBeVisible();
  await action.getByRole('checkbox', { name: 'Seller' }).click();
  await expect(actions.getByRole('row', { name: /^Pay Buyer Created → Paid/ })).toBeVisible();
  // A change is added from one state to another and removed again.
  const changes = action.getByRole('group', { name: 'What it changes' });
  await changes.getByLabel('From state').selectOption({ label: 'Created' });
  await changes.getByLabel('To state').selectOption({ label: 'Shipped' });
  await changes.getByRole('button', { name: 'Add change' }).click();
  await expect(actions.getByRole('row', { name: /^Pay/ })).toContainText('Created → Shipped');
  await changes.getByRole('button', { name: /Remove Pay: Created → Shipped/ }).click();
  await expect(actions.getByRole('row', { name: /^Pay/ })).not.toContainText('Shipped');
});

test('an unsaved technical edit does not undo a change made on the page meanwhile', async ({ page }) => {
  await page.goto('/');
  await place(page, 'Model').click();
  await page.getByRole('complementary', { name: 'Model outline' }).getByRole('button', { name: /^Order/ }).click();
  await page.getByText('How tests connect to the app').click();
  await page.getByLabel(/^Correlation key/).fill('orderId');
  // A state added above saves at once; saving the older technical draft must not drop it.
  await page.getByLabel('New state').fill('On hold');
  await page.getByRole('button', { name: 'Add state' }).click();
  const states = page.getByRole('region', { name: 'States' });
  await expect(states).toContainText('On hold');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Notifications' })).toContainText('has changed');
  await expect(states).toContainText('On hold');
  await page.getByRole('button', { name: 'Discard', exact: true }).click();
  await states.getByRole('button', { name: 'Delete state On hold' }).click();
  await expect(states).not.toContainText('On hold');
});

test('an object opens under Tests with its scenarios and coverage', async ({ page }) => {
  await openOverview(page);
  await page.getByRole('button', { name: /^Order/ }).first().click();
  await expect(page.locator('.crumbs')).toContainText('Order');
  await expect(page.getByRole('tab', { name: /Scenarios/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab', { name: /Scenarios/ })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: /Coverage/ }).click();
  await expect(page.getByRole('tab', { name: /Coverage/ })).toHaveAttribute('aria-selected', 'true');
});

test('every section opens without an error', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  const places: [string, string[]][] = [['Sources', []], ['Model', []], ['Inbox', []], ['Spec', []], ['Tests', ['All objects']]];
  for (const [name, views] of places) {
    await place(page, name).click();
    await expect(place(page, name)).toHaveAttribute('aria-current', 'page');
    for (const v of views) {
      await view(page, v).click();
      await expect(view(page, v)).toHaveAttribute('aria-current', 'page');
    }
  }
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  for (const v of ['Agents', 'Project']) {
    await view(page, `${v}$`).click();
    await expect(view(page, `${v}$`)).toHaveAttribute('aria-current', 'page');
  }
  expect(errors).toEqual([]);
});

test('export writes Markdown through the GUI', async ({ page }) => {
  await page.goto('/');
  await place(page, 'Tests').click();
  await page.getByRole('button', { name: 'Export to Markdown' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Export to Markdown' }).click();
  await expect(page.getByRole('dialog').locator('pre.md').first()).toContainText('#');
});

test('a review lands in the Inbox and on the action it is about', async ({ page }) => {
  // The button picks a live agent when one is installed; the test needs the scripted review.
  expect((await page.request.post('/api/onboarding/run', { data: { provider: 'scripted', mode: 'review' } })).ok()).toBe(true);
  // The scripted review runs as a job; reopen the page until its findings land.
  const finding = page.getByRole('article', { name: 'Finding' });
  await expect(async () => {
    await page.goto('/');
    await place(page, 'Inbox').click();
    await expect(finding).toContainText('contradiction', { timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  // The Inbox queue opens on the contradiction, with each source's quote and the verdicts.
  await expect(finding.getByRole('button', { name: /Bug in the product/ })).toBeEnabled();
  // The source menu narrows the queue to what one source says.
  await page.getByLabel('Source').selectOption({ label: 'Shop code' });
  await expect(finding).toBeVisible();
  if (process.env.TC_SHOT) await page.screenshot({ path: process.env.TC_SHOT, fullPage: true });

  // On the model, the agent's rule sits on the action itself, dashed, and links back to the Inbox.
  await place(page, 'Model').click();
  await page.getByRole('region', { name: 'Actions' }).getByRole('button', { name: /^Cancel/ }).click();
  const rules = page.getByRole('region', { name: 'Rules' });
  await expect(rules.getByText('sources disagree').first()).toBeVisible();
  await expect(rules.getByText('proposed').first()).toBeVisible();
  await rules.getByRole('button', { name: 'Review in Inbox' }).first().click();
  await expect(place(page, 'Inbox')).toHaveAttribute('aria-current', 'page');
  if (process.env.TC_SHOT2) await page.screenshot({ path: process.env.TC_SHOT2, fullPage: true });
});

test('Ask agent runs a task in a dialog and lists what it hands in as it goes', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Ask agent' }).click();
  await page.getByRole('menuitem', { name: /Choose how it runs/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Ask agent' });
  await dialog.getByRole('radio', { name: /Research from scratch/ }).check();
  // No provider: the scripted onboarding, which records the backlog before it finishes.
  await dialog.getByLabel('Provider').selectOption('');
  await dialog.getByRole('button', { name: 'Start research from scratch' }).click();
  await expect(dialog.getByRole('heading', { name: /Last run — done/ })).toBeVisible({ timeout: 60_000 });
  await expect(dialog.getByRole('button', { name: 'Review in Inbox' })).toHaveCount(3);
  if (process.env.TC_SHOT3) await page.screenshot({ path: process.env.TC_SHOT3, fullPage: true });
});
