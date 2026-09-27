import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  ListingStore,
  Store,
  StoreError,
  listingStatusTitles,
  listingVariantTitles,
  statusTitles,
  variantTitles,
  type Listing,
  type ListingStatus,
  type ListingVariant,
  type Order,
  type Side,
  type Status,
  type Variant,
} from './domain.ts';

const PORT = Number(process.env.SHOP_PORT ?? 4400);
const TEST_TOKEN = process.env.SHOP_TEST_TOKEN ?? 'demo-test-token';
const listings = new ListingStore();
const store = new Store(listings);

// Run the "unpaid orders expire" job on real time; unref() so the timer
// alone doesn't keep the process alive (matters for tests/tools that spawn
// this server and expect it to exit when its owner does).
setInterval(() => store.expireUnpaidOrders(), 60_000).unref();

// Demo test accounts. Buyers must sign in to see orders and to buy from the
// catalog; sellers must sign in to use the Marketplace at all. Guests can
// browse the catalog.
const accounts: Record<Side, Record<string, string>> = {
  client: { buyer: 'buyer-pass' },
  seller: { seller: 'seller-pass' },
};
const cookieName = (side: Side) => `shop_${side}`;
const session = new AsyncLocalStorage<{ user: string | null }>();
const currentUser = () => session.getStore()?.user ?? null;

function userFrom(req: IncomingMessage, side: Side): string | null {
  const cookies = Object.fromEntries((req.headers.cookie ?? '').split(';').map((c) => c.trim().split('=').map(decodeURIComponent)));
  const user = cookies[cookieName(side)];
  return user && accounts[side][user] ? user : null;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const money = (n: number) => `$${n.toLocaleString('en-US')}`;

const sides = {
  client: { base: '/client', title: 'Shop — Buyer', accent: '#2563eb' },
  seller: { base: '/marketplace', title: 'Marketplace — Seller account', accent: '#0f766e' },
} as const;

function page(side: Side, title: string, body: string): string {
  const s = sides[side];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)} — ${s.title}</title>
<style>
body{font:15px/1.5 -apple-system,system-ui,sans-serif;margin:0;background:#f6f7f9;color:#111}
header{background:${s.accent};color:#fff;padding:12px 24px;display:flex;gap:24px;align-items:center}
header a{color:#fff}
main{max-width:760px;margin:24px auto;padding:0 16px}
.card{background:#fff;border:1px solid #e3e5e8;border-radius:8px;padding:16px 20px;margin-bottom:16px}
table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:6px 8px;border-bottom:1px solid #eee}
.badge{display:inline-block;padding:2px 8px;border-radius:99px;background:#eef;font-size:13px}
.actions{display:flex;gap:8px;flex-wrap:wrap}button{font:inherit;padding:6px 14px;border-radius:6px;border:1px solid #ccc;background:#fff;cursor:pointer}
button.primary{background:${s.accent};color:#fff;border-color:${s.accent}}
.error{background:#fee;border-color:#fbb}
</style></head><body>
<header><strong>${s.title}</strong><nav style="display:flex;gap:16px"><a href="${s.base}/">Orders</a><a href="${s.base}/listings">Listings</a></nav>
<span style="margin-left:auto">${currentUser() ? `Signed in as <b data-testid="current-user">${esc(currentUser()!)}</b> <form method="post" action="${s.base}/logout" style="display:inline"><button>Sign out</button></form>` : `<a href="${s.base}/login" data-testid="sign-in-link">Sign in</a>`}</span></header>
<main>${body}</main></body></html>`;
}

function loginPage(side: Side, error?: string): string {
  const base = sides[side].base;
  return page(
    side,
    'Sign in',
    `${error ? `<div class="card error" data-testid="error">${esc(error)}</div>` : ''}
<div class="card"><h2>Sign in</h2><form method="post" action="${base}/login" style="display:grid;gap:10px;max-width:320px">
<label>Username <input name="username" autocomplete="username"></label>
<label>Password <input name="password" type="password" autocomplete="current-password"></label>
<button class="primary">Sign in</button></form></div>`,
  );
}

function listPage(side: Side, tag: string | null): string {
  const base = sides[side].base;
  if (side === 'client' && !currentUser())
    return page(side, 'Orders', `<div class="card" data-testid="sign-in-required"><h2>Your orders</h2><p><a href="${base}/login">Sign in</a> to see your orders.</p></div>`);
  const rows = store
    .list(tag)
    .map(
      (o) => `<tr><td><a href="${base}/orders/${o.id}" data-testid="order-link">${o.number}</a></td>
<td>${esc(o.item)}</td><td>${variantTitles[o.variant]}</td><td><span class="badge">${statusTitles[o.status]}</span></td></tr>`,
    )
    .join('');
  const hint =
    side === 'client'
      ? `<div class="card" data-testid="catalog-hint"><a href="${base}/listings" data-testid="catalog-link">Browse the catalog</a> to place an order.</div>`
      : '';
  return page(
    side,
    'Orders',
    `${hint}<div class="card"><h2>${side === 'client' ? 'My orders' : 'Incoming orders'}</h2>
<table><tr><th>Number</th><th>Item</th><th>Type</th><th>Status</th></tr>${rows || '<tr><td colspan=4>No orders yet</td></tr>'}</table></div>`,
  );
}

function orderPage(side: Side, o: Order, error?: string): string {
  const base = sides[side].base;
  const buttons = store
    .available(o, side)
    .map(
      (a, i) => `<form method="post" action="${base}/orders/${o.id}/${a.id}">
<button class="${i === 0 ? 'primary' : ''}" data-testid="action-${a.id}">${a.label}</button></form>`,
    )
    .join('');
  const history = o.history
    .map((h) => `<tr><td>${new Date(h.at).toLocaleTimeString('en-US')}</td><td>${h.by}</td><td>${h.action}</td><td>${h.from ?? '—'} → ${h.to}</td></tr>`)
    .join('');
  const payment = side === 'seller' ? `<p>Payment: <span data-testid="order-payment">${o.payment}</span></p>` : '';
  const linked = o.listingId ? listings.get(o.listingId) : undefined;
  const listing = !o.listingId
    ? ''
    : linked
      ? `<p data-testid="order-listing" data-listing-id="${esc(linked.id)}">Listing: <a href="${base}/listings/${linked.id}">${linked.sku} ${esc(linked.title)}</a></p>`
      : `<p data-testid="order-listing" data-listing-id="${esc(o.listingId)}">Listing: ${esc(o.listingId)} (not found)</p>`;
  return page(
    side,
    `Order ${o.number}`,
    `${error ? `<div class="card error" data-testid="error">${esc(error)}</div>` : ''}
<div class="card"><h2>Order <span data-testid="order-number">${o.number}</span></h2>
<p>${esc(o.item)} · ${money(o.total)} · ${variantTitles[o.variant]}</p>
${listing}
<p>Status: <span class="badge" data-testid="order-status" data-status="${o.status}">${statusTitles[o.status]}</span></p>
${payment}
<div class="actions">${buttons || '<em data-testid="no-actions">No actions available</em>'}</div></div>
<div class="card"><h3>History</h3><table>${history}</table></div>`,
  );
}

function listingsPage(side: Side, tag: string | null): string {
  const base = sides[side].base;
  const shown = side === 'seller' ? listings.list({ tag }) : listings.list({ tag, status: 'published' });
  const rows = shown
    .map(
      (l) => `<tr><td><a href="${base}/listings/${l.id}" data-testid="listing-link">${l.sku}</a></td>
<td>${esc(l.title)}</td><td>${listingVariantTitles[l.variant]}</td><td>${money(l.price)}</td>
<td><span class="badge">${listingStatusTitles[l.status]}</span></td></tr>`,
    )
    .join('');
  const create =
    side === 'seller'
      ? `<div class="card"><h3>New listing</h3><form method="post" action="${base}/listings" class="actions">
<input name="title" placeholder="Title" data-testid="new-listing-title">
<select name="variant" data-testid="new-listing-variant">${Object.entries(listingVariantTitles).map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}</select>
<button class="primary" data-testid="new-listing-submit">Create draft</button></form></div>`
      : '';
  return page(
    side,
    'Listings',
    `${create}<div class="card"><h2>${side === 'client' ? 'Catalog' : 'My listings'}</h2>
<table><tr><th>SKU</th><th>Title</th><th>Type</th><th>Price</th><th>Status</th></tr>${rows || '<tr><td colspan=5>No listings yet</td></tr>'}</table></div>`,
  );
}

function listingPage(side: Side, l: Listing, error?: string): string {
  const base = sides[side].base;
  const buttons = listings
    .available(l, side)
    .map(
      (a, i) => `<form method="post" action="${base}/listings/${l.id}/${a.id}">
<button class="${i === 0 ? 'primary' : ''}" data-testid="action-${a.id}">${a.label}</button></form>`,
    )
    .join('');
  const stock = l.stock === null ? 'n/a (digital)' : String(l.stock);
  const seller =
    side === 'seller'
      ? `<p>Stock: <span data-testid="listing-stock">${stock}</span></p>
<div class="actions">${buttons || '<em data-testid="no-actions">No actions available</em>'}</div>`
      : '';
  const buy =
    side !== 'client'
      ? ''
      : !currentUser()
        ? `<p><a href="${base}/login" data-testid="sign-in-to-buy">Sign in to buy</a></p>`
        : listings.buyable(l)
          ? `<form method="post" action="${base}/listings/${l.id}/buy"><button class="primary" data-testid="action-buy">Buy now</button></form>`
          : '';
  const history =
    side === 'seller'
      ? `<div class="card"><h3>History</h3><table>${l.history
          .map((h) => `<tr><td>${new Date(h.at).toLocaleTimeString('en-US')}</td><td>${h.by}</td><td>${h.action}</td><td>${h.from ?? '—'} → ${h.to}</td></tr>`)
          .join('')}</table></div>`
      : '';
  return page(
    side,
    `Listing ${l.sku}`,
    `${error ? `<div class="card error" data-testid="error">${esc(error)}</div>` : ''}
<div class="card"><h2>${esc(l.title)} <small data-testid="listing-sku">${l.sku}</small></h2>
<p>${money(l.price)} · ${listingVariantTitles[l.variant]}</p>
<p>Status: <span class="badge" data-testid="listing-status" data-status="${l.status}">${listingStatusTitles[l.status]}</span></p>
${seller}${buy}</div>
${history}`,
  );
}

async function body(req: IncomingMessage): Promise<string> {
  let data = '';
  for await (const chunk of req) data += chunk;
  return data;
}

function send(res: ServerResponse, status: number, type: string, payload: string) {
  res.writeHead(status, { 'content-type': `${type}; charset=utf-8` });
  res.end(payload);
}

const json = (res: ServerResponse, status: number, v: unknown) => send(res, status, 'application/json', JSON.stringify(v));
const redirect = (res: ServerResponse, to: string) => {
  res.writeHead(303, { location: to });
  res.end();
};

// Public contract: what agents can read without the UI.
const openapi = {
  openapi: '3.1.0',
  info: { title: 'Demo Shop', version: '1.0.0' },
  paths: {
    '/api/orders/{id}': { get: { summary: 'Read an order', responses: { 200: { description: 'Order' } } } },
    '/test/orders': {
      post: { summary: 'Test API: create an order in a given state (X-Test-Token). Body: {variant, status, tag, listingId?}' },
    },
    '/api/listings/{id}': { get: { summary: 'Read a listing', responses: { 200: { description: 'Listing' } } } },
    '/test/listings': {
      post: { summary: 'Test API: create a listing in a given state (X-Test-Token). Body: {variant, status, tag, stock?}' },
    },
    '/test/jobs': {
      post: {
        summary:
          'Test API: run background jobs now (X-Test-Token). Body: {only?, advanceMinutes?}. ' +
          'Runs as if advanceMinutes (default 0) had passed since now, only for order "only" when given. Returns {processed: [...ids]}',
      },
    },
  },
  components: {
    schemas: {
      Order: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          number: { type: 'string' },
          variant: { enum: ['standard', 'digital', 'preorder'] },
          status: { enum: Object.keys(statusTitles) },
          payment: { enum: ['none', 'captured', 'refunded'] },
          item: { type: 'string' },
          total: { type: 'number' },
          listingId: { type: ['string', 'null'], description: 'Listing the order was placed from; null if none' },
          createdAt: { type: 'string', description: 'ISO timestamp; unpaid orders older than 30 minutes expire automatically' },
        },
      },
      Listing: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          sku: { type: 'string' },
          title: { type: 'string' },
          price: { type: 'number' },
          variant: { enum: Object.keys(listingVariantTitles) },
          status: { enum: Object.keys(listingStatusTitles) },
          stock: { type: ['number', 'null'], description: 'Physical listings only; null for digital' },
        },
      },
    },
  },
};

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const parts = url.pathname.split('/').filter(Boolean);
  const method = req.method ?? 'GET';

  if (url.pathname === '/') return redirect(res, '/client/');
  if (url.pathname === '/api/openapi.json') return json(res, 200, openapi);

  if (parts[0] === 'api' && parts[1] === 'orders' && parts[2] && method === 'GET') {
    const o = store.get(parts[2]);
    return o ? json(res, 200, o) : json(res, 404, { error: 'not found' });
  }

  if (parts[0] === 'api' && parts[1] === 'listings' && parts[2] && method === 'GET') {
    const l = listings.get(parts[2]);
    return l ? json(res, 200, l) : json(res, 404, { error: 'not found' });
  }

  if (url.pathname === '/test/listings' && method === 'POST') {
    if (req.headers['x-test-token'] !== TEST_TOKEN) return json(res, 403, { error: 'bad test token' });
    const input = JSON.parse((await body(req)) || '{}');
    const stock = input.stock === undefined || input.stock === null ? undefined : Number(input.stock);
    const l = listings.prepare(input.variant as ListingVariant, (input.status ?? 'draft') as ListingStatus, input.tag ?? null, stock);
    return json(res, 201, l);
  }

  if (url.pathname === '/test/orders' && method === 'POST') {
    if (req.headers['x-test-token'] !== TEST_TOKEN) return json(res, 403, { error: 'bad test token' });
    const input = JSON.parse((await body(req)) || '{}');
    const listingId = typeof input.listingId === 'string' && input.listingId ? input.listingId : null;
    const o = store.prepare(input.variant as Variant, (input.status ?? 'created') as Status, input.tag ?? null, listingId);
    return json(res, 201, o);
  }

  if (url.pathname === '/test/jobs' && method === 'POST') {
    if (req.headers['x-test-token'] !== TEST_TOKEN) return json(res, 403, { error: 'bad test token' });
    const input = JSON.parse((await body(req)) || '{}');
    const only = typeof input.only === 'string' && input.only ? input.only : undefined;
    const advanceMinutes = input.advanceMinutes === undefined ? undefined : Number(input.advanceMinutes);
    const processed = store.expireUnpaidOrders({ only, advanceMinutes });
    return json(res, 200, { processed });
  }

  const side: Side | null = parts[0] === 'client' ? 'client' : parts[0] === 'marketplace' ? 'seller' : null;
  if (!side) return send(res, 404, 'text/plain', 'not found');
  const base = sides[side].base;
  const tag = url.searchParams.get('tag');
  const user = userFrom(req, side);
  return session.run({ user }, () => routeSide(req, res, { parts, method, side, base, tag, user }));
}

type Route = { parts: string[]; method: string; side: Side; base: string; tag: string | null; user: string | null };

async function routeSide(req: IncomingMessage, res: ServerResponse, { parts, method, side, base, tag, user }: Route) {
  if (parts[1] === 'login') {
    if (method === 'GET') return send(res, 200, 'text/html', loginPage(side));
    const form = new URLSearchParams(await body(req));
    const name = form.get('username') ?? '';
    if (accounts[side][name] !== form.get('password')) return send(res, 401, 'text/html', loginPage(side, 'Wrong username or password'));
    res.writeHead(303, { 'set-cookie': `${cookieName(side)}=${encodeURIComponent(name)}; Path=/; HttpOnly; SameSite=Lax`, location: `${base}/` });
    return res.end();
  }
  if (parts[1] === 'logout' && method === 'POST') {
    res.writeHead(303, { 'set-cookie': `${cookieName(side)}=; Path=/; Max-Age=0`, location: `${base}/` });
    return res.end();
  }
  // Guests may browse the buyer catalog and the buyer's order list page (which
  // asks them to sign in). Everything else needs a signed-in account.
  const publicPage = side === 'client' && (parts.length === 1 || parts[1] === 'listings');
  if (!user && !publicPage) {
    if (method === 'POST') return send(res, 401, 'text/html', loginPage(side, 'Sign in to continue'));
    return redirect(res, `${base}/login`);
  }

  if (parts.length === 1) return send(res, 200, 'text/html', listPage(side, tag));

  if (parts[1] === 'listings') {
    if (parts.length === 2 && method === 'GET') return send(res, 200, 'text/html', listingsPage(side, tag));
    if (parts.length === 2 && method === 'POST' && side === 'seller') {
      const form = new URLSearchParams(await body(req));
      const l = listings.create((form.get('variant') ?? 'physical') as ListingVariant, 'seller', { title: form.get('title') ?? undefined });
      return redirect(res, `${base}/listings/${l.id}`);
    }
    const l = parts[2] ? listings.get(parts[2]) : undefined;
    // The buyer only sees published listings.
    if (!l || (side === 'client' && l.status !== 'published'))
      return send(res, 404, 'text/html', page(side, 'Not found', '<div class="card error">Listing not found</div>'));
    if (parts.length === 3 && method === 'GET') return send(res, 200, 'text/html', listingPage(side, l));
    if (parts.length === 4 && method === 'POST' && side === 'client' && parts[3] === 'buy') {
      if (!user) return send(res, 401, 'text/html', loginPage(side, 'Sign in to buy'));
      try {
        const o = store.buy(l.id, side);
        return redirect(res, `${base}/orders/${o.id}`);
      } catch (e) {
        const status = e instanceof StoreError ? e.status : 500;
        return send(res, status, 'text/html', listingPage(side, l, (e as Error).message));
      }
    }
    if (parts.length === 4 && method === 'POST') {
      try {
        listings.perform(l.id, side, parts[3]);
        return redirect(res, `${base}/listings/${l.id}`);
      } catch (e) {
        const status = e instanceof StoreError ? e.status : 500;
        return send(res, status, 'text/html', listingPage(side, l, (e as Error).message));
      }
    }
  }

  if (parts[1] === 'orders' && parts[2]) {
    const o = store.get(parts[2]);
    if (!o) return send(res, 404, 'text/html', page(side, 'Not found', '<div class="card error">Order not found</div>'));
    if (parts.length === 3 && method === 'GET') return send(res, 200, 'text/html', orderPage(side, o));
    if (parts.length === 4 && method === 'POST') {
      try {
        store.perform(o.id, side, parts[3]);
        return redirect(res, `${base}/orders/${o.id}`);
      } catch (e) {
        const status = e instanceof StoreError ? e.status : 500;
        return send(res, status, 'text/html', orderPage(side, o, (e as Error).message));
      }
    }
  }
  send(res, 404, 'text/plain', 'not found');
}

createServer((req, res) => {
  handle(req, res).catch((e) => {
    const status = e instanceof StoreError ? e.status : 500;
    json(res, status, { error: (e as Error).message });
  });
}).listen(PORT, () => console.log(`demo shop: http://localhost:${PORT}/client/  ·  http://localhost:${PORT}/marketplace/`));
