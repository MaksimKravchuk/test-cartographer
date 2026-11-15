// Vikunja action library: how a role performs an entity action through the
// Vikunja web UI (v2.8.0). Locators come from aria snapshots (roles and labels;
// Vikunja has no test ids). Every available() returns false instead of throwing
// when the role lacks the permission, gets "Not found", or is sent to /login.
import { defineActions, type ActionContext, type ActionDef } from '@tc/engine/actions';
import type { Locator, Page } from '@playwright/test';

const TIMEOUT = 10_000;

// Wait until the page settled into one of the states it can end in; never throws.
async function settle(page: Page, ...ready: Locator[]) {
  const login = page.getByRole('button', { name: 'Login', exact: true });
  const notFound = page.getByRole('heading', { name: 'Not found' });
  const trashed = page.getByText(/is in the trash\./);
  const error = page.getByRole('status').filter({ hasText: /^Error/ });
  await ready
    .reduce((a, b) => a.or(b), login.or(notFound).or(trashed).or(error))
    .first()
    .waitFor({ timeout: TIMEOUT })
    .catch(() => {});
}

const visible = async (l: Locator) => (await l.count()) > 0 && (await l.first().isVisible());

// ---- tasks: /tasks/{id}, sidebar buttons ----

// The "Not found" page also has a level-1 heading, so exclude it.
const taskTitle = (page: Page) =>
  page.locator('main').getByRole('heading', { level: 1 }).filter({ hasNotText: /^Not found$/ });

async function openTask({ page, open, key }: ActionContext) {
  await open(`/tasks/${key}`);
  await settle(page, taskTitle(page));
}

function taskButton(name: string, after: string, description: string): ActionDef {
  const button = (page: Page) => page.locator('main').getByRole('button', { name, exact: true });
  return {
    description,
    async run(ctx) {
      await openTask(ctx);
      await button(ctx.page).click();
      await ctx.page.locator('main').getByRole('button', { name: after, exact: true }).waitFor();
    },
    async available(ctx) {
      await openTask(ctx);
      return visible(button(ctx.page));
    },
  };
}

// ---- projects: header three-dot menu ----
// The sidebar repeats "Open project settings menu" for every project, so the
// header (banner) one is the menu of the open project. Readers don't get it.

async function openProjectMenu({ page, open, key }: ActionContext): Promise<Locator | null> {
  await open(`/projects/${key}`);
  const menu = page.getByRole('banner').getByRole('button', { name: 'Open project settings menu' });
  await settle(page, menu, page.locator('main').getByRole('link', { name: 'List', exact: true }));
  if (!(await visible(menu))) return null;
  await menu.click();
  return page.getByRole('banner');
}

async function menuLink(ctx: ActionContext, name: string): Promise<Locator | null> {
  const banner = await openProjectMenu(ctx);
  if (!banner) return null;
  const link = banner.getByRole('link', { name, exact: true });
  await link.waitFor({ timeout: 2_000 }).catch(() => {});
  return (await visible(link)) ? link : null;
}

// A menu entry that opens a confirm dialog ("Do it!") and ends with a success toast.
function projectConfirm(entry: string, done: RegExp, description: string): ActionDef {
  return {
    description,
    async run(ctx) {
      const link = await menuLink(ctx, entry);
      if (!link) throw new Error(`"${entry}" is not in the project menu`);
      await link.click();
      await ctx.page.getByRole('dialog').getByRole('button', { name: 'Do it!' }).click();
      await ctx.page.getByRole('status').filter({ hasText: done }).first().waitFor();
    },
    async available(ctx) {
      return (await menuLink(ctx, entry)) !== null;
    },
  };
}

const PERMISSION = { read: 'Read only', write: 'Read & write', admin: 'Admin' } as const;
const shareSearch = (page: Page) =>
  page.getByRole('dialog').getByRole('combobox', { name: 'Search for a user to share this project with' });

// Restore from the "is in the trash" notice that a trashed task/project page shows.
function restoreFromNotice(path: (key: string) => string, description: string): ActionDef {
  const button = (page: Page) => page.locator('main').getByRole('button', { name: 'Restore', exact: true });
  const open = async ({ page, open, key }: ActionContext) => {
    await open(path(key));
    await settle(page, taskTitle(page), page.locator('main').getByRole('link', { name: 'List', exact: true }));
  };
  return {
    description,
    async run(ctx) {
      await open(ctx);
      await button(ctx.page).click();
      await ctx.page.getByText(/is in the trash\./).waitFor({ state: 'detached' });
    },
    async available(ctx) {
      await open(ctx);
      return visible(button(ctx.page));
    },
  };
}

export default defineActions({
  'auth.login': {
    description: 'Sign in with the role’s test account',
    async run({ page, open, args }) {
      await open('/login');
      await page.getByRole('textbox', { name: 'Username Or Email Address' }).fill(args.username);
      await page.getByRole('textbox', { name: 'Password' }).fill(args.password);
      await page.getByRole('button', { name: 'Login', exact: true }).click();
      await page.getByRole('banner').getByRole('button', { name: args.username, exact: true }).waitFor();
    },
  },

  'project.view': {
    description: 'Open the project (its first view)',
    async run({ page, open, key }) {
      await open(`/projects/${key}`);
      await page.locator('main').getByRole('link', { name: 'List', exact: true }).waitFor();
    },
    // An outsider gets an empty page and an error toast, a trashed project a notice.
    async available({ page, open, key }) {
      await open(`/projects/${key}`);
      const list = page.locator('main').getByRole('link', { name: 'List', exact: true });
      await settle(page, list);
      return visible(list);
    },
  },
  'project.archive': projectConfirm('Archive', /successfully archived/, 'Archive the project from its menu'),
  // The same dialog toggles; its toast says "archived" either way.
  'project.unarchive': projectConfirm('Un-Archive', /successfully archived/, 'Un-archive the project from its menu'),
  'project.delete': projectConfirm('Delete', /moved to the trash/, 'Move the project to the trash from its menu'),
  'project.restore': restoreFromNotice((key) => `/projects/${key}`, 'Restore the trashed project from its notice'),
  'project.share': {
    description: 'Share the project with args.username at args.permission (read|write|admin)',
    async run(ctx) {
      const { page, args } = ctx;
      const link = await menuLink(ctx, 'Share');
      if (!link) throw new Error('"Share" is not in the project menu');
      await link.click();
      await shareSearch(page).pressSequentially(args.username);
      await page.getByRole('option', { name: new RegExp(`^${args.username}\\b`) }).click();
      // The first "Share" button belongs to the users block (the second to teams).
      await page.getByRole('dialog').getByRole('button', { name: 'Share', exact: true }).first().click();
      const perm = page.getByRole('combobox', { name: `Permission for ${args.username}` });
      const label = PERMISSION[args.permission as keyof typeof PERMISSION];
      if (!label) throw new Error(`unknown permission ${args.permission}`);
      if ((await perm.inputValue().catch(() => '')) !== label) {
        const saved = page.waitForResponse((r) => r.request().method() !== 'GET' && /\/projects\/\d+\/users\//.test(r.url()));
        await perm.selectOption({ label });
        await saved;
      }
      await page.getByRole('row', { name: new RegExp(`^${args.username} .*${label}`) }).first().waitFor();
    },
    // A writer sees "Share" in the menu, but the dialog is a read-only list without the user search.
    async available(ctx) {
      const link = await menuLink(ctx, 'Share');
      if (!link) return false;
      await link.click();
      await settle(ctx.page, shareSearch(ctx.page), ctx.page.getByRole('dialog').getByRole('table'));
      return visible(shareSearch(ctx.page));
    },
  },
  'project.edit': {
    description: 'Rename the project (args.title) through Edit in its menu',
    async run(ctx) {
      const link = await menuLink(ctx, 'Edit');
      if (!link) throw new Error('"Edit" is not in the project menu');
      await link.click();
      const dialog = ctx.page.getByRole('dialog');
      await dialog.getByRole('textbox', { name: 'Title' }).fill(ctx.args.title ?? `renamed ${Date.now()}`);
      await dialog.getByRole('button', { name: 'Save', exact: true }).click();
      await ctx.page.getByRole('status').filter({ hasText: /successfully saved|updated/i }).first().waitFor();
    },
    async available(ctx) {
      return (await menuLink(ctx, 'Edit')) !== null;
    },
  },

  'task.create': {
    description: 'Add a task (args.title) in the List view of related.project / args.project',
    async run({ page, open, related, args }) {
      await open(`/projects/${related.project ?? args.project}`);
      const input = page.getByRole('textbox', { name: 'Add a task…' });
      await input.fill(args.title ?? `task ${Date.now()}`);
      // The UI posts to /api/v2/projects/{id}/tasks/bulk and gets { tasks: [...] } back.
      const created = page.waitForResponse((r) => r.request().method() !== 'GET' && /\/projects\/\d+\/tasks(\/bulk)?$/.test(r.url()));
      await input.press('Enter');
      const res = await created;
      if (!res.ok()) throw new Error(`creating the task failed: HTTP ${res.status()}`);
      const body = await res.json();
      const task = body.tasks?.[0] ?? body;
      await page.locator('main').getByRole('link', { name: task.title }).first().waitFor();
      return String(task.id);
    },
    async available({ page, open, related, args }) {
      await open(`/projects/${related.project ?? args.project}`);
      const input = page.getByRole('textbox', { name: 'Add a task…' });
      await settle(page, input, page.locator('main').getByRole('link', { name: 'List', exact: true }));
      return visible(input);
    },
  },
  'task.view': {
    description: 'Open the task page',
    async run(ctx) {
      await ctx.open(`/tasks/${ctx.key}`);
      await taskTitle(ctx.page).waitFor();
    },
    async available(ctx) {
      await openTask(ctx);
      return visible(taskTitle(ctx.page));
    },
  },
  'task.done': taskButton('Mark task done!', 'Mark as undone', 'Mark the task done'),
  'task.undone': taskButton('Mark as undone', 'Mark task done!', 'Mark the task not done again'),
  'task.delete': {
    description: 'Move the task to the trash (no confirmation; goes back to the project)',
    async run(ctx) {
      await openTask(ctx);
      await ctx.page.locator('main').getByRole('button', { name: 'Delete', exact: true }).click();
      await ctx.page.getByRole('status').filter({ hasText: /moved to the trash/ }).first().waitFor();
    },
    async available(ctx) {
      await openTask(ctx);
      return visible(ctx.page.locator('main').getByRole('button', { name: 'Delete', exact: true }));
    },
  },
  'task.restore': restoreFromNotice((key) => `/tasks/${key}`, 'Restore the trashed task from its notice'),
  'task.edit': {
    description: 'Change the task title (args.title) in place',
    async run(ctx) {
      await openTask(ctx);
      const title = ctx.args.title ?? `edited ${Date.now()}`;
      const saved = ctx.page.waitForResponse((r) => /\/tasks\/\d+$/.test(r.url()) && ['PATCH', 'POST'].includes(r.request().method()));
      await ctx.page.getByRole('heading', { name: 'Title', level: 1 }).click();
      await ctx.page.keyboard.press('ControlOrMeta+a');
      await ctx.page.keyboard.type(title);
      await ctx.page.keyboard.press('Enter');
      const res = await saved;
      if (!res.ok()) throw new Error(`saving the title failed: HTTP ${res.status()}`);
      await ctx.page.getByRole('heading', { name: 'Title', level: 1 }).filter({ hasText: title }).waitFor();
    },
    // Only an editable title (contenteditable, labelled "Title") offers renaming; a reader gets plain text.
    async available(ctx) {
      await openTask(ctx);
      return visible(ctx.page.getByRole('heading', { name: 'Title', level: 1 }));
    },
  },
  'task.comment': {
    description: 'Add a comment (args.comment) to the task',
    async run(ctx) {
      await openTask(ctx);
      const text = ctx.args.comment ?? `comment ${Date.now()}`;
      await ctx.page.getByLabel(/^Add your comment/).click();
      await ctx.page.keyboard.type(text);
      const saved = ctx.page.waitForResponse((r) => r.request().method() !== 'GET' && /\/tasks\/\d+\/comments$/.test(r.url()));
      await ctx.page.getByRole('button', { name: 'Comment', exact: true }).click();
      // The typed text stays in the editor on failure, so the API answer is what tells success.
      const res = await saved;
      if (!res.ok()) throw new Error(`adding the comment failed: HTTP ${res.status()}`);
      await ctx.page.locator('main').getByRole('paragraph').filter({ hasText: text }).first().waitFor();
    },
    async available(ctx) {
      await openTask(ctx);
      // The comment editor renders after the comments load, later than the title.
      const editor = ctx.page.getByLabel(/^Add your comment/);
      await editor.waitFor({ timeout: 3_000 }).catch(() => {});
      return visible(editor);
    },
  },
});
