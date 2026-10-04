// Test data for Vendure orders: put an order into a given state the way the shop
// itself would — a customer checks out through the Shop API, staff move it on
// through the Admin API. No database writes, no test-only endpoints: a real
// project rarely has those, so this is what a QA team would have to write.
import { mkdir, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { admin, ok, Session } from './gql.ts';

export const ORDER_STATES = [
  'AddingItems', 'ArrangingPayment', 'PaymentAuthorized', 'PaymentSettled',
  'PartiallyShipped', 'Shipped', 'PartiallyDelivered', 'Delivered', 'Cancelled', 'Draft',
] as const;
export type OrderState = (typeof ORDER_STATES)[number];
export const PAYMENT_METHODS = ['standard-payment', 'prepaid'] as const;

const BUYER = { email: process.env.BUYER_EMAIL ?? 'buyer@shop.test', password: process.env.BUYER_PASSWORD ?? 'buyer-pass' };
const ADDRESS = { fullName: 'Test Buyer', streetLine1: '1 Test Street', city: 'Berlin', postalCode: '10115', countryCode: 'DE' };

const ORDER_FIELDS = `id code state active orderPlacedAt totalWithTax
  customer { emailAddress }
  lines { id quantity productVariant { id name } }
  payments { id method state amount }
  fulfillments { id state method lines { orderLineId quantity } }`;

// What the read tool returns, flattened so `state.match` can name plain fields.
export function summarize(o: any) {
  return {
    id: o.id,
    code: o.code,
    state: o.state,
    active: o.active,
    placed: !!o.orderPlacedAt,
    customer: o.customer?.emailAddress ?? null,
    paymentMethod: o.payments?.[0]?.method ?? null,
    paymentState: o.payments?.[0]?.state ?? null,
    fulfillmentStates: (o.fulfillments ?? []).map((f: any) => f.state),
    lines: (o.lines ?? []).map((l: any) => ({ id: l.id, variant: l.productVariant.name, quantity: l.quantity })),
    totalWithTax: o.totalWithTax,
  };
}

export async function readOrder(id: string) {
  const s = await admin();
  const { order } = await s.q(`query($id: ID!){ order(id:$id){ ${ORDER_FIELDS} } }`, { id });
  if (!order) throw new Error(`No order with id ${id}`);
  return summarize(order);
}

// Placed orders go through checkout as a signed-in buyer or as a guest.
async function checkout(opts: { guest: boolean; lines: number; payment?: string; stopAt: 'AddingItems' | 'ArrangingPayment' | 'paid'; tag?: string }) {
  const shop = new Session('shop-api');
  if (!opts.guest) {
    ok((await shop.q(`mutation($u:String!,$p:String!){ login(username:$u,password:$p){ ... on CurrentUser { id } ... on ErrorResult { errorCode message } } }`, { u: BUYER.email, p: BUYER.password })).login, 'buyer login');
    // The buyer account has one cart across sessions, and an earlier run may have
    // left it mid-checkout: bring it back to AddingItems and empty it.
    const { activeOrder } = await shop.q(`{ activeOrder { id state lines { id } } }`);
    if (activeOrder && activeOrder.state !== 'AddingItems') {
      ok((await shop.q(`mutation{ transitionOrderToState(state:"AddingItems"){ ... on Order { id } ... on ErrorResult { errorCode message } } }`)).transitionOrderToState, 'back to AddingItems');
    }
    for (const l of activeOrder?.lines ?? []) await shop.q(`mutation($id: ID!){ removeOrderLine(orderLineId:$id){ __typename } }`, { id: l.id });
  }
  // Two cheap, always-in-stock variants: a mouse and a tablet.
  const variants = ['7', '5'].slice(0, opts.lines);
  for (const v of variants) {
    ok((await shop.q(`mutation($v: ID!){ addItemToOrder(productVariantId:$v, quantity:1){ ... on Order { id } ... on ErrorResult { errorCode message } } }`, { v })).addItemToOrder, 'addItemToOrder');
  }
  if (opts.guest) {
    const email = `guest+${opts.tag ?? Date.now()}@shop.test`.replace(/[^a-z0-9+@.-]/gi, '-');
    ok((await shop.q(`mutation($i: CreateCustomerInput!){ setCustomerForOrder(input:$i){ ... on Order { id } ... on ErrorResult { errorCode message } } }`, { i: { emailAddress: email, firstName: 'Guest', lastName: 'Buyer' } })).setCustomerForOrder, 'setCustomerForOrder');
  }
  const { activeOrder } = await shop.q(`{ activeOrder { id } }`);
  if (opts.stopAt === 'AddingItems') return { shop, id: activeOrder.id as string };

  ok((await shop.q(`mutation($a: CreateAddressInput!){ setOrderShippingAddress(input:$a){ ... on Order { id } ... on ErrorResult { errorCode message } } }`, { a: ADDRESS })).setOrderShippingAddress, 'setOrderShippingAddress');
  const { eligibleShippingMethods } = await shop.q(`{ eligibleShippingMethods { id } }`);
  ok((await shop.q(`mutation($id: [ID!]!){ setOrderShippingMethod(shippingMethodId:$id){ ... on Order { id } ... on ErrorResult { errorCode message } } }`, { id: [eligibleShippingMethods[0].id] })).setOrderShippingMethod, 'setOrderShippingMethod');
  ok((await shop.q(`mutation{ transitionOrderToState(state:"ArrangingPayment"){ ... on Order { id } ... on ErrorResult { errorCode message } } }`)).transitionOrderToState, 'to ArrangingPayment');
  if (opts.stopAt === 'ArrangingPayment') return { shop, id: activeOrder.id as string };

  ok((await shop.q(`mutation($m: String!){ addPaymentToOrder(input:{ method:$m, metadata:{} }){ ... on Order { id } ... on ErrorResult { errorCode message } } }`, { m: opts.payment ?? 'standard-payment' })).addPaymentToOrder, 'addPaymentToOrder');
  return { shop, id: activeOrder.id as string };
}

export type CreateOrderInput = {
  state: OrderState;
  payment?: (typeof PAYMENT_METHODS)[number];
  // buyer: the order belongs to the test buyer account, so the buyer sees it in the
  // storefront; guest: a new guest customer every time.
  owner?: 'buyer' | 'guest';
  /** @deprecated use owner */
  guest?: boolean;
  tag?: string;
};

// The buyer account has a single cart. Generated tests run in parallel workers,
// each with its own MCP server process, so cart work for the buyer is serialized
// across processes with a lock directory.
const LOCK = join(tmpdir(), 'vendure-pilot-buyer-cart.lock');
async function withBuyerCart<T>(fn: () => Promise<T>): Promise<T> {
  const started = Date.now();
  for (;;) {
    try {
      await mkdir(LOCK);
      break;
    } catch {
      if (Date.now() - started > 60_000) await rmdir(LOCK).catch(() => {}); // a crashed holder
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  try {
    return await fn();
  } finally {
    await rmdir(LOCK).catch(() => {});
  }
}

async function buyerCustomerId(staff: Session) {
  const { customers } = await staff.q(`query($e: String!){ customers(options:{ filter:{ emailAddress:{ eq:$e } } }){ items { id } } }`, { e: BUYER.email });
  if (!customers.items[0]) throw new Error(`No customer ${BUYER.email}`);
  return customers.items[0].id as string;
}

// Every placed order allocates stock, and a test run places hundreds: keep the
// two variants the setup buys (and the storefront tests add to the cart) stocked.
const TEST_VARIANTS = ['7', '5'];
let stocked: Promise<unknown> | undefined;
const restock = (staff: Session) =>
  staff.q(`mutation($input: [UpdateProductVariantInput!]!){ updateProductVariants(input:$input){ id } }`, {
    input: TEST_VARIANTS.map((id) => ({ id, stockOnHand: 1_000_000 })),
  });

export async function createOrder({ state, payment = 'standard-payment', owner, guest, tag }: CreateOrderInput) {
  if (!ORDER_STATES.includes(state)) throw new Error(`Unknown state ${state}. One of: ${ORDER_STATES.join(', ')}`);
  const forBuyer = (owner ?? (guest === false ? 'buyer' : 'guest')) === 'buyer';
  const staff = await admin();
  await (stocked ??= restock(staff));

  if (state === 'Draft') {
    const { createDraftOrder } = await staff.q(`mutation{ createDraftOrder{ id } }`);
    ok((await staff.q(`mutation($o: ID!){ addItemToDraftOrder(orderId:$o, input:{ productVariantId:"7", quantity:1 }){ ... on Order { id } ... on ErrorResult { errorCode message } } }`, { o: createDraftOrder.id })).addItemToDraftOrder, 'addItemToDraftOrder');
    return readOrder(createDraftOrder.id);
  }

  // A cart can't change hands: the buyer's own cart is filled in the buyer's session.
  if (state === 'AddingItems' || state === 'ArrangingPayment') {
    const run = () => checkout({ guest: !forBuyer, lines: 1, stopAt: state, tag });
    const { id } = forBuyer ? await withBuyerCart(run) : await run();
    return readOrder(id);
  }

  // Partial shipping/delivery needs a second line to leave unfulfilled.
  const partial = state === 'PartiallyShipped' || state === 'PartiallyDelivered';
  const settled = !['PaymentAuthorized', 'Cancelled'].includes(state);
  // A placed order is checked out by a guest and then handed to the buyer, the
  // way staff reassign one in the admin — the buyer's cart stays out of it.
  const { id } = await checkout({ guest: true, lines: partial ? 2 : 1, payment, stopAt: 'paid', tag });
  if (forBuyer) {
    await staff.q(`mutation($i: SetOrderCustomerInput!){ setOrderCustomer(input:$i){ id } }`, { i: { orderId: id, customerId: await buyerCustomerId(staff), note: 'test setup' } });
  }
  let order = await readOrder(id);

  if (state === 'PaymentAuthorized') {
    if (order.state !== 'PaymentAuthorized') throw new Error(`Payment method ${payment} settles at checkout; use standard-payment for PaymentAuthorized`);
    return order;
  }
  if (state === 'Cancelled') {
    ok((await staff.q(`mutation($id: ID!){ cancelOrder(input:{ orderId:$id, reason:"test setup", cancelShipping:true }){ ... on Order { id } ... on ErrorResult { errorCode message } } }`, { id })).cancelOrder, 'cancelOrder');
    return readOrder(id);
  }
  if (settled && order.state === 'PaymentAuthorized') {
    const { order: full } = await staff.q(`query($id: ID!){ order(id:$id){ payments { id } } }`, { id });
    ok((await staff.q(`mutation($p: ID!){ settlePayment(id:$p){ ... on Payment { id } ... on ErrorResult { errorCode message } } }`, { p: full.payments[0].id })).settlePayment, 'settlePayment');
    order = await readOrder(id);
  }
  if (state === 'PaymentSettled') return order;

  const line = order.lines[0];
  const { addFulfillmentToOrder: f } = await staff.q(
    `mutation($i: FulfillOrderInput!){ addFulfillmentToOrder(input:$i){ ... on Fulfillment { id } ... on ErrorResult { errorCode message } } }`,
    { i: { lines: [{ orderLineId: line.id, quantity: line.quantity }], handler: { code: 'manual-fulfillment', arguments: [{ name: 'method', value: 'Courier' }, { name: 'trackingCode', value: tag ?? 'TEST' }] } } },
  );
  ok(f, 'addFulfillmentToOrder');
  const move = async (to: string) =>
    ok((await staff.q(`mutation($id: ID!, $s: String!){ transitionFulfillmentToState(id:$id, state:$s){ ... on Fulfillment { id } ... on ErrorResult { errorCode message } } }`, { id: f.id, s: to })).transitionFulfillmentToState, `fulfillment → ${to}`);
  await move('Shipped');
  if (state === 'Delivered' || state === 'PartiallyDelivered') await move('Delivered');
  order = await readOrder(id);
  if (order.state !== state) throw new Error(`Setup ended in ${order.state}, not ${state}`);
  return order;
}
