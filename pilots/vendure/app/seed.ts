// What a QA team usually gets on a staging stand: staff accounts with different
// roles, a test customer, and the payment methods production has. Run against a
// freshly populated server (npm run populate, npm start).
import { admin, ok } from '../mcp/gql.ts';

const s = await admin();

const { roles } = await s.q(`{ roles { items { id code } } }`);
const roleId = (code: string) => roles.items.find((r: any) => r.code === code)?.id;

if (!roleId('support')) {
  await s.q(`mutation($input: CreateRoleInput!){ createRole(input:$input){ id } }`, {
    input: { code: 'support', description: 'Support (read-only)', permissions: ['ReadOrder', 'ReadCustomer', 'ReadCatalog', 'ReadPaymentMethod', 'ReadShippingMethod'] },
  });
}
const { roles: after } = await s.q(`{ roles { items { id code } } }`);
const rid = (code: string) => after.items.find((r: any) => r.code === code).id;

const staff = [
  { email: 'manager@shop.test', password: 'manager-pass', first: 'Olga', last: 'Manager', role: 'order-manager' },
  { email: 'catalog@shop.test', password: 'catalog-pass', first: 'Igor', last: 'Catalog', role: 'inventory-manager' },
  { email: 'support@shop.test', password: 'support-pass', first: 'Sveta', last: 'Support', role: 'support' },
];
for (const a of staff) {
  await s.q(`mutation($input: CreateAdministratorInput!){ createAdministrator(input:$input){ id } }`, {
    input: { firstName: a.first, lastName: a.last, emailAddress: a.email, password: a.password, roleIds: [rid(a.role)] },
  });
}

ok((await s.q(`mutation($input: CreateCustomerInput!, $password: String){ createCustomer(input:$input, password:$password){ ... on Customer { id } ... on ErrorResult { errorCode message } } }`, {
  input: { firstName: 'Anna', lastName: 'Buyer', emailAddress: 'buyer@shop.test' },
  password: 'buyer-pass',
})).createCustomer, 'createCustomer');

await s.q(`mutation($input: CreatePaymentMethodInput!){ createPaymentMethod(input:$input){ id } }`, {
  input: {
    code: 'prepaid',
    enabled: true,
    handler: { code: 'dummy-payment-handler', arguments: [{ name: 'automaticSettle', value: 'true' }] },
    translations: [{ languageCode: 'en', name: 'Prepaid card', description: 'Charged at checkout' }],
  },
});
console.log('seeded: staff', staff.map((a) => a.email).join(', '), '+ buyer@shop.test + prepaid payment method');
