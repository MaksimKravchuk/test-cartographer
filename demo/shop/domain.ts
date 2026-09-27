// Demo shop: the target for exploration and tests. It deliberately contains
// behaviors that agents should discover and a person should judge:
//   • digital orders have no shipping: the seller issues a key right away;
//   • a pre-order waits for stock after it is accepted;
//   • a buyer can cancel a standard order the seller has already accepted
//     (a bug or a rule? a person decides).
// Orders are placed from published listings and keep a reference to them;
// paying for an order from a physical listing takes one item off its stock.

export type Variant = 'standard' | 'digital' | 'preorder';
export type Status =
  | 'created' | 'paid' | 'accepted' | 'awaiting_stock' | 'shipped' | 'delivered' | 'cancelled';
export type Payment = 'none' | 'captured' | 'refunded';
export type Side = 'client' | 'seller';

export type Order = {
  id: string;
  number: string;
  variant: Variant;
  status: Status;
  payment: Payment;
  total: number;
  item: string;
  listingId: string | null;
  tag: string | null;
  history: { at: string; by: Side | 'test-api'; action: string; from: Status | null; to: Status }[];
};

type Action = {
  id: string;
  label: string;
  side: Side;
  from: Status[];
  to: Status;
  variants: Variant[];
  payment?: Payment;
};

export const actions: Action[] = [
  { id: 'pay', label: 'Pay', side: 'client', from: ['created'], to: 'paid', variants: ['standard', 'digital', 'preorder'], payment: 'captured' },
  { id: 'cancel', label: 'Cancel order', side: 'client', from: ['created'], to: 'cancelled', variants: ['standard', 'digital', 'preorder'] },
  { id: 'cancel', label: 'Cancel order', side: 'client', from: ['paid', 'accepted'], to: 'cancelled', variants: ['standard'], payment: 'refunded' },
  { id: 'cancel', label: 'Cancel order', side: 'client', from: ['paid', 'awaiting_stock'], to: 'cancelled', variants: ['preorder'], payment: 'refunded' },
  { id: 'accept', label: 'Accept order', side: 'seller', from: ['paid'], to: 'accepted', variants: ['standard'] },
  { id: 'accept', label: 'Accept pre-order', side: 'seller', from: ['paid'], to: 'awaiting_stock', variants: ['preorder'] },
  { id: 'stock', label: 'Stock arrived', side: 'seller', from: ['awaiting_stock'], to: 'accepted', variants: ['preorder'] },
  { id: 'reject', label: 'Reject', side: 'seller', from: ['paid'], to: 'cancelled', variants: ['standard', 'preorder'], payment: 'refunded' },
  { id: 'ship', label: 'Ship', side: 'seller', from: ['accepted'], to: 'shipped', variants: ['standard', 'preorder'] },
  { id: 'deliver-key', label: 'Issue key', side: 'seller', from: ['paid'], to: 'delivered', variants: ['digital'] },
  { id: 'confirm', label: 'Confirm receipt', side: 'client', from: ['shipped'], to: 'delivered', variants: ['standard', 'preorder'] },
];

export const variantTitles: Record<Variant, string> = {
  standard: 'Standard',
  digital: 'Digital',
  preorder: 'Pre-order',
};

export const statusTitles: Record<Status, string> = {
  created: 'Created',
  paid: 'Paid',
  accepted: 'Accepted by seller',
  awaiting_stock: 'Awaiting stock',
  shipped: 'Shipped',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
};

// States the test API can put an order into directly.
const preparable: Record<Variant, Status[]> = {
  standard: ['created', 'paid', 'accepted', 'shipped', 'delivered', 'cancelled'],
  digital: ['created', 'paid', 'delivered', 'cancelled'],
  preorder: ['created', 'paid', 'awaiting_stock', 'accepted', 'shipped', 'delivered', 'cancelled'],
};

const items: Record<Variant, [string, number]> = {
  standard: ['Manual coffee grinder', 49],
  digital: ['Atlas Pro activation key', 29],
  preorder: ['Nova headphones (pre-order)', 199],
};

export class Store {
  private orders = new Map<string, Order>();
  private seq = 1000;
  private listings: ListingStore;

  constructor(listings: ListingStore) {
    this.listings = listings;
  }

  list(tag?: string | null): Order[] {
    return [...this.orders.values()].filter((o) => !tag || o.tag === tag).reverse();
  }

  get(id: string): Order | undefined {
    return this.orders.get(id);
  }

  available(order: Order, side: Side): Action[] {
    return actions.filter((a) => a.side === side && a.variants.includes(order.variant) && a.from.includes(order.status));
  }

  create(
    variant: Variant,
    by: Side | 'test-api',
    tag: string | null = null,
    listingId: string | null = null,
  ): Order {
    const n = ++this.seq;
    const listing = listingId ? this.listings.get(listingId) : undefined;
    const [item, total] = listing ? [listing.title, listing.price] : items[variant];
    const order: Order = {
      id: `ord_${n.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      number: `A-${n}`,
      variant,
      status: 'created',
      payment: 'none',
      total,
      item,
      listingId,
      tag,
      history: [{ at: new Date().toISOString(), by, action: 'create', from: null, to: 'created' }],
    };
    this.orders.set(order.id, order);
    return order;
  }

  // Test API: puts the order straight into the requested state with consistent fields.
  // A listingId is stored as is; when that listing exists, item and total come from it.
  prepare(variant: Variant, status: Status, tag: string | null, listingId: string | null = null): Order {
    if (!preparable[variant]) throw new StoreError(400, `Unknown variant "${variant}"`);
    if (!preparable[variant].includes(status))
      throw new StoreError(400, `Variant "${variant}" can't be in state "${status}"`);
    const order = this.create(variant, 'test-api', tag, listingId);
    order.status = status;
    order.payment = status === 'created' ? 'none' : status === 'cancelled' ? 'none' : 'captured';
    order.history.push({ at: new Date().toISOString(), by: 'test-api', action: 'prepare', from: 'created', to: status });
    return order;
  }

  perform(id: string, side: Side, actionId: string): Order {
    const order = this.orders.get(id);
    if (!order) throw new StoreError(404, 'Order not found');
    const action = this.available(order, side).find((a) => a.id === actionId);
    if (!action) throw new StoreError(409, `Action "${actionId}" isn't available in state "${order.status}"`);
    const from = order.status;
    order.status = action.to;
    if (action.payment) order.payment = action.payment;
    order.history.push({ at: new Date().toISOString(), by: side, action: actionId, from, to: action.to });
    if (actionId === 'pay' && order.listingId) this.listings.sell(order.listingId);
    return order;
  }

  // A buyer places an order from a listing: physical → standard, digital → digital.
  // The order inherits the listing's tag, so test data stays isolated.
  buy(listingId: string, by: Side): Order {
    const listing = this.listings.get(listingId);
    if (!listing) throw new StoreError(404, 'Listing not found');
    if (!this.listings.buyable(listing)) throw new StoreError(409, `Listing ${listing.sku} can't be bought right now`);
    return this.create(listing.variant === 'digital' ? 'digital' : 'standard', by, listing.tag, listing.id);
  }
}

export class StoreError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// ── Listings ────────────────────────────────────────────────────────────
// A seller's product listing. Only the seller changes it; the buyer sees
// published listings in a read-only catalog. Deliberately left out of the
// workspace model: a listing that is out of stock can also be archived.

export type ListingVariant = 'physical' | 'digital';
export type ListingStatus = 'draft' | 'published' | 'out_of_stock' | 'archived';

export type Listing = {
  id: string;
  sku: string;
  title: string;
  price: number;
  variant: ListingVariant;
  status: ListingStatus;
  stock: number | null;
  tag: string | null;
  history: { at: string; by: 'seller' | 'test-api' | 'system'; action: string; from: ListingStatus | null; to: ListingStatus }[];
};

type ListingAction = {
  id: string;
  label: string;
  from: ListingStatus[];
  to: ListingStatus;
  variants: ListingVariant[];
  stock?: number;
};

export const listingActions: ListingAction[] = [
  { id: 'publish', label: 'Publish', from: ['draft'], to: 'published', variants: ['physical', 'digital'] },
  { id: 'unpublish', label: 'Unpublish', from: ['published'], to: 'draft', variants: ['physical', 'digital'] },
  { id: 'set-out-of-stock', label: 'Mark out of stock', from: ['published'], to: 'out_of_stock', variants: ['physical'], stock: 0 },
  { id: 'restock', label: 'Restock', from: ['out_of_stock'], to: 'published', variants: ['physical'], stock: 10 },
  { id: 'archive', label: 'Archive', from: ['draft', 'published', 'out_of_stock'], to: 'archived', variants: ['physical', 'digital'] },
];

export const listingVariantTitles: Record<ListingVariant, string> = {
  physical: 'Physical',
  digital: 'Digital',
};

export const listingStatusTitles: Record<ListingStatus, string> = {
  draft: 'Draft',
  published: 'Published',
  out_of_stock: 'Out of stock',
  archived: 'Archived',
};

// States the test API can put a listing into directly.
const listingPreparable: Record<ListingVariant, ListingStatus[]> = {
  physical: ['draft', 'published', 'out_of_stock', 'archived'],
  digital: ['draft', 'published', 'archived'],
};

const listingDefaults: Record<ListingVariant, [string, number]> = {
  physical: ['Ceramic pour-over set', 39],
  digital: ['Brewing guide (e-book)', 12],
};

export class ListingStore {
  private listings = new Map<string, Listing>();
  private seq = 2000;

  list(filter: { tag?: string | null; status?: ListingStatus } = {}): Listing[] {
    return [...this.listings.values()]
      .filter((l) => (!filter.tag || l.tag === filter.tag) && (!filter.status || l.status === filter.status))
      .reverse();
  }

  get(id: string): Listing | undefined {
    return this.listings.get(id);
  }

  // Listing actions belong to the seller; the buyer has none.
  available(listing: Listing, side: Side): ListingAction[] {
    if (side !== 'seller') return [];
    return listingActions.filter((a) => a.variants.includes(listing.variant) && a.from.includes(listing.status));
  }

  create(
    variant: ListingVariant,
    by: 'seller' | 'test-api',
    opts: { title?: string; stock?: number; tag?: string | null } = {},
  ): Listing {
    if (!listingDefaults[variant]) throw new StoreError(400, `Unknown variant "${variant}"`);
    const n = ++this.seq;
    const [title, price] = listingDefaults[variant];
    const listing: Listing = {
      id: `lst_${n.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      sku: `L-${n}`,
      title: opts.title?.trim() || title,
      price,
      variant,
      status: 'draft',
      stock: variant === 'physical' ? (opts.stock ?? 10) : null,
      tag: opts.tag ?? null,
      history: [{ at: new Date().toISOString(), by, action: 'create', from: null, to: 'draft' }],
    };
    this.listings.set(listing.id, listing);
    return listing;
  }

  // Test API: puts the listing straight into the requested state with consistent fields.
  prepare(variant: ListingVariant, status: ListingStatus, tag: string | null, stock?: number): Listing {
    if (!listingPreparable[variant]) throw new StoreError(400, `Unknown variant "${variant}"`);
    if (!listingPreparable[variant].includes(status))
      throw new StoreError(400, `Variant "${variant}" can't be in state "${status}"`);
    if (stock !== undefined && (variant === 'digital' || !Number.isInteger(stock) || stock < 0))
      throw new StoreError(400, `Invalid stock for variant "${variant}"`);
    if (variant === 'physical') {
      if (status === 'out_of_stock' && stock !== undefined && stock !== 0)
        throw new StoreError(400, 'An out-of-stock listing must have stock 0');
      if (status === 'published' && stock === 0) throw new StoreError(400, 'A published physical listing needs stock > 0');
    }
    const listing = this.create(variant, 'test-api', { tag, stock: status === 'out_of_stock' ? 0 : stock });
    if (status !== 'draft') {
      listing.status = status;
      listing.history.push({ at: new Date().toISOString(), by: 'test-api', action: 'prepare', from: 'draft', to: status });
    }
    return listing;
  }

  // Published, and for physical listings something left in stock.
  buyable(listing: Listing): boolean {
    return listing.status === 'published' && (listing.variant !== 'physical' || (listing.stock ?? 0) > 0);
  }

  // A paid order takes one item off a physical listing; the last one sells it out.
  sell(id: string): void {
    const listing = this.listings.get(id);
    if (!listing || listing.variant !== 'physical' || !listing.stock) return;
    listing.stock -= 1;
    if (listing.stock === 0 && listing.status === 'published') {
      listing.status = 'out_of_stock';
      listing.history.push({ at: new Date().toISOString(), by: 'system', action: 'sold-out', from: 'published', to: 'out_of_stock' });
    }
  }

  perform(id: string, side: Side, actionId: string): Listing {
    const listing = this.listings.get(id);
    if (!listing) throw new StoreError(404, 'Listing not found');
    const action = this.available(listing, side).find((a) => a.id === actionId);
    if (!action) throw new StoreError(409, `Action "${actionId}" isn't available in state "${listing.status}"`);
    if (actionId === 'publish' && listing.variant === 'physical' && !(listing.stock && listing.stock > 0))
      throw new StoreError(409, "Can't publish a physical listing with no stock");
    const from = listing.status;
    listing.status = action.to;
    if (action.stock !== undefined) listing.stock = action.stock;
    listing.history.push({ at: new Date().toISOString(), by: 'seller', action: actionId, from, to: action.to });
    return listing;
  }
}
