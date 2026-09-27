# Demo Shop — Product Overview

## What this is

Demo Shop is a small marketplace where independent sellers list physical and
digital goods and buyers browse and buy them directly. There is no shopping
cart: a buyer places one order per listing, pays for it, and the seller takes
it from there. The product is deliberately narrow — one item per order, one
seller per listing — so the whole purchase and fulfilment flow can be
understood end to end without a lot of moving parts.

## Roles

- **Guest** — anyone who opens the storefront without signing in. A guest can
  browse the published catalog but cannot place an order or see any order
  history; they are prompted to sign in the moment they try to buy something.
- **Buyer** — a signed-in shopper. Buyers place orders, pay for them, track
  their status, and (once delivered) leave a review of what they bought.
- **Seller** — a signed-in merchant with their own Marketplace account.
  Sellers create and manage their own listings and work incoming orders from
  acceptance through to shipping or key delivery.
- **Shop backend** — the system itself. It has no screens of its own; it acts
  on a schedule or in reaction to what buyers and sellers do; for example it
  expires unpaid orders and reacts when a sale empties a listing's stock.

Guests and buyers share the storefront; sellers work from a separate
Marketplace account. A seller cannot buy from their own storefront account and
a buyer cannot manage listings — they are different accounts entirely, even
if the same person happens to hold both.

## Listings

A listing is a single product a seller offers for sale. Listings come in two
kinds:

- **Physical** — a shippable good with a stock count. Once stock reaches
  zero the listing can no longer be bought.
- **Digital** — a key or file with no stock to track; it is always
  available for purchase once published.

A listing moves through a small lifecycle:

1. **Draft** — being set up; not visible to buyers.
2. **Published** — visible in the catalog and buyable.
3. **Out of stock** — a physical listing whose stock ran out (or was marked
   out of stock by the seller); not buyable, but still visible in the
   seller's own listing page.
4. **Archived** — retired for good. An archived listing never comes back;
   the seller creates a fresh listing if they want to sell the item again.

### Publishing and stock

A seller can only publish a physical listing once it has stock; publishing a
listing with nothing to sell doesn't make sense and the Marketplace refuses
it. A physical listing that sells its last unit is automatically moved to
out of stock — no action needed from the seller. The seller can also mark a
published listing out of stock by hand, for instance while doing inventory,
and restock it later to make it available again.

### Archiving a listing

Archiving is how a seller retires a listing for good, and it isn't limited to
tidy states. A seller can archive a listing in any state: draft, published,
or out of stock. A half-finished draft that never went anywhere, a published
listing being discontinued, or a listing that has been sitting out of stock
for months — all of them can be archived directly, without first moving them
back to draft or published. Once archived, a listing is done: it cannot be
published, restocked, or otherwise brought back to life.

## Orders

An order is created against exactly one listing and inherits its kind:

- **Standard** — a physical item. The seller ships it and the buyer
  confirms receipt once it arrives.
- **Digital** — a digital good. There is nothing to ship: as soon as the
  order is paid, the seller issues the key and the order is complete.
- **Pre-order** — a physical item the seller has agreed to fulfil before
  it is back in stock. The seller accepts the order into a waiting state and
  moves it forward once stock arrives, the same as any other standard order
  from there on.

### Order lifecycle

Every order starts out **Created** — placed but not yet paid — and, once
paid, follows one of these paths depending on its kind:

- Standard: Created → Paid → Accepted by seller → Shipped → Delivered.
- Digital: Created → Paid → Delivered (the key is issued the moment the
  seller accepts payment; there is no shipping step).
- Pre-order: Created → Paid → Awaiting stock → Accepted by seller →
  Shipped → Delivered. The order sits in Awaiting stock until the seller has
  enough of the item on hand to fulfil it, then proceeds exactly like a
  standard order.

An order can also end in **Cancelled**, either because the buyer or the
seller cancelled it, or because it expired unpaid (see below).

## Payment, refunds and stock

Paying for an order captures the buyer's payment and, for a standard or
pre-order item, takes one unit off the related listing's stock right away —
that unit is reserved for this buyer even before the seller has accepted the
order. If the seller later rejects a paid order, or the buyer cancels one,
the captured payment is refunded in full; there are no partial refunds and
no restocking fee.

## Cancellations

Cancellation rights depend on how far the order has progressed, and they
belong to different sides at different points:

A buyer can cancel an order only until it has been paid. Once payment has
been captured, only the seller can cancel the order, by rejecting it. This
protects a seller who has already started preparing a paid order from having
it pulled out from under them; if something has gone wrong on the seller's
side — out of stock, can't fulfil it — rejecting it is their call to make,
and the buyer is made whole with a refund either way.

A pre-order follows the same rule while it waits: the buyer can still cancel
it up to the point of payment, and after that only the seller can cancel it
by rejecting, whether the order is sitting in Paid or Awaiting stock.

## Unpaid order expiry

Buyers sometimes place an order and never go back to pay for it. Rather than
let those sit around forever, an order that has not been paid within 30
minutes of being placed is cancelled automatically by the shop backend; no
payment is ever taken for an order that expires this way, and the listing's
stock is never touched since payment is what reserves the unit, not placing
the order.

## Reviews

Once an order has been delivered, the buyer can leave a review of the
listing they bought: a star rating from one to five and a short comment.
Reviews appear on the listing page so future buyers can see how earlier
purchases went — a review is tied to the listing, not to the specific order,
since several buyers may review the same listing over time. Only a buyer who
actually completed a purchase can review it; there is no review form on a
listing a person hasn't bought.

The buyer can edit or remove their own review at any time; there is no
review window that closes it off. The seller may post a single public
response to each review — useful for thanking a happy customer or
addressing a complaint — but cannot edit or remove a buyer's review
themselves. If a buyer removes their review, any seller response goes with
it.

Reviews are meant to build trust in a seller's catalog over time, and the
team considers this feature complete and part of the current release: it
ships alongside the rest of the buyer experience, not as a future add-on.

## Roles and what they can do

| | Guest | Buyer | Seller |
|---|---|---|---|
| Browse published catalog | Yes | Yes | Yes (own listings) |
| Place and pay for an order | No | Yes | No |
| Cancel own order before payment | No | Yes | No |
| Cancel/reject a paid order | No | No | Yes |
| Manage own listings | No | No | Yes |
| Leave a review | No | Yes (after delivery) | No |
| Respond to a review | No | No | Yes |

## What's out of scope for now

A few things came up in discovery but are deliberately not part of this
release:

- Multi-item carts and combined checkout across sellers — every order stays
  tied to a single listing.
- Partial refunds, store credit, or restocking fees on a cancellation.
- Buyer-to-seller messaging outside of a review response.
- Star ratings feeding into any kind of seller reputation score — for now a
  review is just shown on the listing page as written.

These may come back once the current fulfilment flow has been live for a
while and we understand where buyers and sellers actually get stuck.
