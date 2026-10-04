// Reaches every state once and prints what get_order reads back.
import { createOrder, ORDER_STATES } from './orders.ts';
for (const state of ORDER_STATES) {
  for (const payment of ['standard-payment', 'prepaid'] as const) {
    if (payment === 'prepaid' && ['Draft', 'AddingItems', 'ArrangingPayment', 'PaymentAuthorized'].includes(state)) continue;
    try {
      const o = await createOrder({ state, payment, tag: 'check' });
      console.log(state.padEnd(20), payment.padEnd(17), '→', o.state, o.paymentState, JSON.stringify(o.fulfillmentStates));
    } catch (e) {
      console.log(state.padEnd(20), payment.padEnd(17), '✖', (e as Error).message);
    }
  }
}
