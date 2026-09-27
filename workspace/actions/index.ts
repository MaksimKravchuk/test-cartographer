// Demo shop action library: how a role performs a transition through its interface.
// Generated tests refer to actions by name (`transition.action` in the model).
import { defineActions, type ActionContext, type ActionDef } from '@tc/engine/actions';

// A button on an entity page in the role's interface. `path` builds the page path
// (relative to the role's interface baseUrl) from the entity key, `statusTestId`
// is the element that tells the page has loaded. Both interfaces use the same
// test ids, so available() also works for checking forbidden actions.
function pageButton(
  path: (key: string) => string,
  statusTestId: string,
  testId: string,
  description: string,
): ActionDef {
  const open = (ctx: ActionContext) => ctx.open(path(ctx.key));
  return {
    description,
    async run(ctx) {
      await open(ctx);
      await ctx.page.getByTestId(`action-${testId}`).click();
      await ctx.page.getByTestId(statusTestId).waitFor();
    },
    // A guest may land on the sign-in page instead; then the action isn't available either.
    async available(ctx) {
      await open(ctx);
      await ctx.page.waitForLoadState('domcontentloaded');
      return (await ctx.page.getByTestId(`action-${testId}`).count()) > 0;
    },
  };
}

const orderButton = (testId: string, description: string) =>
  pageButton((key) => `/orders/${key}`, 'order-status', testId, description);

// The buyer's catalog page shows a published listing without any buttons.
const listingButton = (testId: string, description: string) =>
  pageButton((key) => `/listings/${key}`, 'listing-status', testId, description);

export default defineActions({
  'auth.login': {
    description: 'Sign in with the role’s test account',
    async run({ page, open, args }) {
      await open('/login');
      await page.getByLabel('Username').fill(args.username);
      await page.getByLabel('Password').fill(args.password);
      await page.getByRole('button', { name: 'Sign in' }).click();
      await page.getByTestId('current-user').waitFor();
    },
  },
  'order.place': {
    description: 'Buyer buys the related listing from the catalog',
    async run({ page, open, related }) {
      await open(`/listings/${related.listing}`);
      await page.getByTestId('action-buy').click();
      await page.waitForURL(/\/orders\/[^/]+$/);
      return page.url().split('/').pop()!;
    },
    // Unavailable for a guest (“Sign in to buy”) and for a listing the buyer can't see or buy.
    async available({ page, open, related }) {
      await open(`/listings/${related.listing}`);
      await page.waitForLoadState('domcontentloaded');
      return (await page.getByTestId('action-buy').count()) > 0;
    },
  },
  'order.pay': orderButton('pay', 'Buyer pays for the order'),
  'order.cancel': orderButton('cancel', 'Buyer cancels the order'),
  'order.confirm': orderButton('confirm', 'Buyer confirms receipt'),
  'order.accept': orderButton('accept', 'Seller accepts the order'),
  'order.reject': orderButton('reject', 'Seller rejects the order'),
  'order.ship': orderButton('ship', 'Seller ships the order'),
  'order.stock': orderButton('stock', 'Seller marks stock as arrived'),
  'order.deliver-key': orderButton('deliver-key', 'Seller issues the digital key'),

  'listing.publish': listingButton('publish', 'Seller publishes the listing'),
  'listing.unpublish': listingButton('unpublish', 'Seller moves the listing back to draft'),
  'listing.archive': listingButton('archive', 'Seller archives the listing'),
  'listing.restock': listingButton('restock', 'Seller restocks the listing'),
  'listing.sell-out': listingButton('set-out-of-stock', 'Stock runs out (seller marks the listing out of stock)'),
});
