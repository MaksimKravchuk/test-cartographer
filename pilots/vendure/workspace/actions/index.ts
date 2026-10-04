// Vendure pilot action library: how a role performs an order action through its
// interface. Neither UI has test ids, so everything goes by role and name, and
// by position where Vendure's forms leave inputs without a label.
//
// available() answers "does this role's UI offer the action here": visible and
// enabled. It is not "would the server allow it" — Vendure's admin offers
// support the same enabled buttons as the manager and refuses on the server,
// and the deny scenarios are meant to show that.
import type { Locator, Page } from '@playwright/test';
import { defineActions, type ActionContext, type ActionDef } from '@tc/engine/actions';

const ADMIN = 'admin-ui';
const SHOP = 'storefront';

// The deny matrix asks every role about every action: an action of the other
// interface simply isn't there.
function only(iface: string, def: ActionDef): ActionDef {
  return {
    ...def,
    async run(ctx) {
      if (ctx.iface.id !== iface) throw new Error(`${def.description}: only in the ${iface} interface, not in ${ctx.iface.id}`);
      return def.run(ctx);
    },
    async available(ctx) {
      return ctx.iface.id === iface && (def.available ? def.available(ctx) : false);
    },
  };
}

const offered = async (loc: Locator) => (await loc.count()) > 0 && (await loc.first().isVisible()) && (await loc.first().isEnabled());

// ── Admin ───────────────────────────────────────────────────────────────

// The order page has loaded once its code is the page heading — or, for an
// order being modified, which the admin redirects to /modify, "Modifying order".
// A role without ReadOrder never gets there.
const orderHeading = (ctx: ActionContext) =>
  ctx.page.getByRole('heading', { level: 1, name: new RegExp(`^(${String(ctx.entity.code)}|Modifying order)$`) });
async function openOrder(ctx: ActionContext) {
  await ctx.open(`/orders/${ctx.key}`);
  await orderHeading(ctx).waitFor({ timeout: 10_000 });
}
async function orderShown(ctx: ActionContext) {
  await ctx.open(`/orders/${ctx.key}`);
  return orderHeading(ctx).waitFor({ timeout: 6_000 }).then(() => true, () => false);
}

// The ⋮ menu next to "Fulfill order" is an icon-only button.
const menu = (page: Page) => page.locator('vdr-action-bar-dropdown-menu button').first();
async function menuItem(page: Page, name: string | RegExp) {
  await menu(page).click();
  return page.getByRole('button', { name });
}
// Vendure's own dropdown for a cancellation/refund reason.
async function pickReason(dialog: Locator, page: Page) {
  await dialog.getByRole('combobox').click();
  await page.getByRole('option').first().click();
}

// A button on the order page.
function orderButton(name: string | RegExp, description: string, after: (page: Page) => Promise<unknown>): ActionDef {
  return only(ADMIN, {
    description,
    async run(ctx) {
      await openOrder(ctx);
      await ctx.page.getByRole('button', { name }).click();
      await after(ctx.page);
    },
    async available(ctx) {
      if (!(await orderShown(ctx))) return false;
      return offered(ctx.page.getByRole('button', { name }));
    },
  });
}

// An entry of the ⋮ menu.
function orderMenu(name: string | RegExp, description: string, act: (ctx: ActionContext) => Promise<unknown>): ActionDef {
  return only(ADMIN, {
    description,
    async run(ctx) {
      await openOrder(ctx);
      await (await menuItem(ctx.page, name)).click();
      await act(ctx);
    },
    async available(ctx) {
      if (!(await orderShown(ctx))) return false;
      if (!(await offered(menu(ctx.page)))) return false;
      const item = await menuItem(ctx.page, name);
      const ok = await offered(item);
      await ctx.page.keyboard.press('Escape');
      return ok;
    },
  });
}

// The "Fulfill order" dialog, for every unfulfilled line: Method and Tracking
// code are its two unlabeled text inputs.
async function completeFulfillment(page: Page) {
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox').nth(0).fill('Courier');
  await dialog.getByRole('textbox').nth(1).fill('TC-TEST');
  await dialog.getByRole('button', { name: 'Create fulfillment' }).click();
  await page.getByRole('button', { name: 'Mark as Shipped' }).waitFor();
}

const settled = (page: Page) => page.getByRole('button', { name: 'Settle payment' }).waitFor({ state: 'detached' });

// ── Storefront ──────────────────────────────────────────────────────────

const PRODUCT = '/products/cordless-mouse';

// The storefront never shows an order id; its own data route for the cart does.
async function activeOrderId(ctx: ActionContext): Promise<string | undefined> {
  const res = await ctx.page.request.get(`${ctx.iface.baseUrl}/api/active-order?_data=routes%2Fapi.active-order`);
  return (await res.json()).activeOrder?.id;
}
// Cart actions act on the buyer's current cart, not on any order: they're
// offered for this order only while it is that cart.
async function isCurrentCart(ctx: ActionContext) {
  await ctx.open('/');
  return (await activeOrderId(ctx)) === ctx.key;
}
async function cartTray(page: Page) {
  await page.getByRole('button', { name: 'Open cart tray' }).click();
  return page.getByRole('dialog', { name: 'Shopping cart' });
}

export default defineActions({
  // Vendure's admin login form has no <label>s, only placeholders.
  'admin.login': {
    description: 'Sign in to the back office',
    async run({ page, open, args }) {
      await open('/login');
      await page.getByPlaceholder('Username').fill(args.username);
      await page.getByPlaceholder('Password').fill(args.password);
      await page.getByRole('button', { name: 'Log in' }).click();
      await page.waitForURL(/\/admin\/?$/);
    },
  },
  'shop.login': {
    description: 'Sign in to the storefront',
    async run({ page, open, args }) {
      await open('/sign-in');
      await page.getByLabel('Email address').fill(args.email);
      await page.getByLabel('Password').fill(args.password);
      await page.getByRole('button', { name: 'Sign In' }).click();
      await page.waitForURL(/\/account/);
    },
  },

  'admin.settle_payment': orderButton('Settle payment', 'Settle the authorized payment', settled),
  'admin.create_fulfillment': orderButton('Fulfill order', 'Create a fulfillment for every unfulfilled line', completeFulfillment),
  // In the admin, shipping is two steps: fulfil, then mark the fulfillment
  // shipped. The model has one transition, so a missing fulfillment is created first.
  'admin.mark_fulfillment_shipped': only(ADMIN, {
    description: 'Mark the fulfillment shipped (creating it first if there is none)',
    async run(ctx) {
      await openOrder(ctx);
      const mark = ctx.page.getByRole('button', { name: 'Mark as Shipped' });
      if (!(await mark.count())) {
        await ctx.page.getByRole('button', { name: 'Fulfill order' }).click();
        await completeFulfillment(ctx.page);
      }
      await mark.click();
      await ctx.page.getByRole('button', { name: 'Mark as Delivered' }).waitFor();
    },
    async available(ctx) {
      if (!(await orderShown(ctx))) return false;
      return (await offered(ctx.page.getByRole('button', { name: 'Mark as Shipped' }))) || offered(ctx.page.getByRole('button', { name: 'Fulfill order' }));
    },
  }),
  'admin.mark_fulfillment_delivered': orderButton('Mark as Delivered', 'Mark the shipped fulfillment delivered', (page) =>
    page.getByRole('button', { name: 'Mark as Delivered' }).waitFor({ state: 'detached' }),
  ),
  'admin.cancel_order': orderMenu('Cancel order or items', 'Cancel the whole order', async ({ page }) => {
    const dialog = page.getByRole('dialog');
    await pickReason(dialog, page);
    await dialog.getByRole('button', { name: 'Cancel selected items' }).click();
    await dialog.waitFor({ state: 'detached' });
  }),
  'admin.refund_and_cancel_order': orderMenu('Refund & cancel order', 'Refund every line and shipping, and cancel the order', async ({ page }) => {
    const dialog = page.getByRole('dialog');
    const lines = dialog.getByRole('row').filter({ has: page.getByRole('spinbutton') });
    for (let i = 0; i < (await lines.count()); i++) {
      const qty = (await lines.nth(i).getByRole('cell').nth(4).innerText()).trim();
      await lines.nth(i).getByRole('spinbutton').fill(qty);
    }
    await dialog.getByRole('checkbox', { name: /Refund shipping/ }).check();
    await pickReason(dialog, page);
    await dialog.getByRole('button', { name: /^Refund / }).click();
    await dialog.waitFor({ state: 'detached' });
  }),
  'admin.transition_order_to_modifying': orderMenu('Manually transition to state...', 'Manually move the order to Modifying', async ({ page }) => {
    const dialog = page.getByRole('dialog');
    await dialog.locator('select').selectOption('Modifying');
    await dialog.getByRole('button', { name: /^Transition to/ }).click();
    await dialog.waitFor({ state: 'detached' });
  }),
  'admin.cancel_order_modification': orderButton(/Cancel modification/i, 'Leave the modification without changes', (page) =>
    page.getByRole('button', { name: /Cancel modification/i }).waitFor({ state: 'detached' }),
  ),

  // Read: the back office's order page, or the buyer's own order confirmation page.
  'admin.view_order': {
    description: 'Open the order (back office order page, or the storefront confirmation page of an own order)',
    async run(ctx) {
      if (ctx.iface.id === ADMIN) return void (await openOrder(ctx));
      await ctx.open(`/checkout/confirmation/${ctx.entity.code}`);
      await ctx.page.getByText(String(ctx.entity.code)).first().waitFor({ timeout: 10_000 });
    },
    async available(ctx) {
      if (ctx.iface.id === ADMIN) return orderShown(ctx);
      await ctx.open(`/checkout/confirmation/${ctx.entity.code}`);
      return ctx.page.getByText(String(ctx.entity.code)).first().waitFor({ timeout: 6_000 }).then(() => true, () => false);
    },
  },

  'shop.add-to-cart': only(SHOP, {
    description: 'Add a product to the cart from its page; returns the cart (order) id',
    async run(ctx) {
      await ctx.open(PRODUCT);
      await ctx.page.getByRole('button', { name: /Add to cart/i }).click();
      await ctx.page.waitForLoadState('networkidle');
      const id = await activeOrderId(ctx);
      if (!id) throw new Error('No active order after adding to cart');
      return id;
    },
    async available(ctx) {
      // Starting a cart is possible from any product page; adding to this order only while it is the cart.
      if (ctx.key && !(await isCurrentCart(ctx))) return false;
      await ctx.open(PRODUCT);
      return offered(ctx.page.getByRole('button', { name: /Add to cart/i }));
    },
  }),
  'shop.change-line-quantity': only(SHOP, {
    description: 'Change the quantity of the first cart line to 2',
    async run(ctx) {
      await ctx.open('/');
      const tray = await cartTray(ctx.page);
      await tray.getByRole('combobox', { name: 'Quantity' }).first().selectOption('2');
      await ctx.page.waitForLoadState('networkidle');
    },
    async available(ctx) {
      if (!(await isCurrentCart(ctx))) return false;
      return offered((await cartTray(ctx.page)).getByRole('combobox', { name: 'Quantity' }));
    },
  }),
  'shop.remove-cart-line': only(SHOP, {
    description: 'Remove the first cart line',
    async run(ctx) {
      await ctx.open('/');
      const tray = await cartTray(ctx.page);
      await tray.getByRole('button', { name: 'Remove' }).first().click();
      await ctx.page.waitForLoadState('networkidle');
    },
    async available(ctx) {
      if (!(await isCurrentCart(ctx))) return false;
      return offered((await cartTray(ctx.page)).getByRole('button', { name: 'Remove' }));
    },
  }),
  // The checkout's shipping step should take the buyer on to payment.
  'shop.proceed-to-payment': only(SHOP, {
    description: 'Fill in shipping in the checkout and go on to payment',
    async run(ctx) {
      await ctx.open('/checkout');
      await ctx.page.getByRole('button', { name: /proceed to payment/i }).click({ timeout: 10_000 });
      await ctx.page.waitForURL(/\/checkout\/payment/);
    },
    async available(ctx) {
      if (!(await isCurrentCart(ctx))) return false;
      await ctx.open('/checkout');
      return offered(ctx.page.getByRole('button', { name: /proceed to payment/i }));
    },
  }),
  'shop.pay-order': only(SHOP, {
    description: 'Pay with Standard Payment on the checkout payment step',
    async run(ctx) {
      await ctx.open('/checkout/payment');
      await ctx.page.getByRole('button', { name: 'Pay with Standard Payment' }).click();
      await ctx.page.waitForURL(/\/checkout\/confirmation\//);
    },
    async available(ctx) {
      if (!(await isCurrentCart(ctx))) return false;
      await ctx.open('/checkout/payment');
      return offered(ctx.page.getByRole('button', { name: 'Pay with Standard Payment' }));
    },
  }),
});
