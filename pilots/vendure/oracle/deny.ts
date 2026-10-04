// Sorts the deny scenarios of the latest run against the oracle. A failed deny
// scenario means the role's UI offered the action; the oracle says whether the
// role may really do it there (the model is missing it), whether only the server
// refuses (the UI ignores permissions), or neither. A failure before the check
// is test data, not the app.
//
//   node deny.ts [workspace]   (default: ../workspace)
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildPlan, Workspace } from '@tc/model';

const ws = new Workspace(resolve(process.argv[2] ?? join(import.meta.dirname, '../workspace')));
const { entity } = await ws.entity('order');
const plan = buildPlan(entity, await ws.project(), await ws.catalog());
const runs = readdirSync(ws.path('runs')).filter((f) => /^\d.*\.json$/.test(f) && !f.includes('playwright')).sort();
const report = JSON.parse(readFileSync(ws.path('runs', runs.at(-1)!), 'utf8'));
const vendure = new Map(entity.states.map((s) => [s.id, String(s.match.state ?? s.id)]));

const PLACED = ['PaymentAuthorized', 'PaymentSettled', 'PartiallyShipped', 'Shipped', 'PartiallyDelivered', 'Delivered', 'Cancelled', 'Modifying'];
const ALL = [...PLACED, 'AddingItems', 'ArrangingPayment', 'Draft'];
// What the oracle (order.yaml) allows, per model action: role → Vendure states.
const allowed: Record<string, Record<string, string[]>> = {
  'settle-payment': { manager: ['PaymentAuthorized'] },
  'create-fulfillment': { manager: ['PaymentSettled', 'PartiallyShipped', 'PartiallyDelivered'] },
  'mark-shipped': { manager: ['PaymentSettled', 'PartiallyShipped', 'PartiallyDelivered'] },
  'mark-delivered': { manager: ['Shipped', 'PartiallyShipped'] },
  'refund-and-cancel': { manager: ['PaymentSettled', 'PartiallyShipped', 'Shipped', 'PartiallyDelivered', 'Delivered'] },
  'cancel-order': { manager: ['ArrangingPayment', 'PaymentAuthorized'] },
  'start-modification': { manager: ['PaymentAuthorized', 'PaymentSettled', 'PartiallyShipped', 'Shipped', 'PartiallyDelivered'] },
  'cancel-modification': { manager: ['Modifying'] },
  'view-order': { manager: ALL, support: ALL, buyer: PLACED, guest: PLACED },
  'add-to-cart': { buyer: ['AddingItems'] },
  'add-item': { buyer: ['AddingItems'] },
  'change-line-quantity': { buyer: ['AddingItems'] },
  'remove-cart-line': { buyer: ['AddingItems'] },
  'proceed-to-payment': { buyer: ['AddingItems'] },
  'pay-order': { buyer: ['ArrangingPayment'] },
};
// Order actions the admin shows support but the API refuses (support has ReadOrder only).
const ADMIN_WRITE = Object.keys(allowed).filter((a) => allowed[a].manager && a !== 'view-order');

const buckets = new Map<string, string[]>();
const add = (bucket: string, line: string) => buckets.set(bucket, [...(buckets.get(bucket) ?? []), line]);
let total = 0;
for (const s of plan.scenarios.filter((x) => x.kind === 'deny')) {
  const r = report.results[s.id];
  if (!r) continue;
  total++;
  const [action, stateId] = s.target.split('@');
  const state = vendure.get(stateId) ?? stateId;
  const really = allowed[action]?.[s.role]?.includes(state) ?? false;
  const line = `${s.role} · ${action} · ${state}`;
  if (r.status === 'passed') {
    add(really ? 'passed, but the oracle allows it (the check missed it)' : 'passed: denied in the app too', line);
    continue;
  }
  const error = String(r.error ?? '');
  if (!/sees action/.test(error)) {
    add(/expected .* read /.test(error) ? 'failed before the check: the shared buyer cart moved on (test data)' : 'failed before the check: other error', `${line} — ${error.split('\n')[0].slice(0, 120)}`);
    continue;
  }
  if (really) add('UI offers it and the role may do it: the model is missing it', line);
  else if (s.role === 'support' && ADMIN_WRITE.includes(action)) add('UI offers it, the server refuses: the admin ignores permissions', line);
  else add('UI offers it, the oracle does not allow it', line);
}

console.log(`${total} deny scenarios in run ${runs.at(-1)}\n`);
for (const [bucket, lines] of [...buckets].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`${String(lines.length).padStart(4)}  ${bucket}`);
  if (!bucket.startsWith('passed: denied')) for (const l of lines) console.log(`        ${l}`);
}
