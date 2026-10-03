import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dataContext, dataValues, Entity, Project, redactFields, scrubSecrets, secretValues, template, toYaml, validateEntity, validateProject,
} from '../src/index.ts';

const project = Project.parse({
  name: 'Test',
  interfaces: [{ id: 'ui', title: 'UI', baseUrl: 'http://localhost/ui' }],
  roles: [
    { id: 'guest', title: 'Guest', interface: 'ui' },
    {
      id: 'seller',
      title: 'Seller',
      interface: 'ui',
      fields: [
        { id: 'login', value: 'seller' },
        { id: 'password', value: '{{env.SELLER_PASSWORD}}', secret: true, note: 'пароль продавца' },
      ],
      login: { action: 'auth.login', args: { username: '{{roles.seller.login}}', password: '{{roles.seller.password}}' } },
    },
  ],
});

const lineItem = Entity.parse({
  id: 'line-item',
  title: 'Line item',
  variants: [{ id: 'default', title: 'Default' }],
  fields: [{ id: 'sku', value: 'SKU-1' }],
});
const env = { SELLER_PASSWORD: 's3cret-pass' };

test('dataValues: real values by owner, env resolved; owners without fields are left out', () => {
  assert.deepEqual(dataValues(project.roles, [lineItem], env), {
    roles: { seller: { login: 'seller', password: 's3cret-pass' } },
    entities: { 'line-item': { sku: 'SKU-1' } },
  });
});

test('login args resolve through field references, ids with "-" included', () => {
  const vars = { env, ...dataValues(project.roles, [lineItem], env) };
  const seller = project.roles.find((r) => r.id === 'seller')!;
  assert.deepEqual(template(seller.login!.args, vars), { username: 'seller', password: 's3cret-pass' });
  assert.equal(template('{{entities.line-item.sku}}', vars), 'SKU-1');
});

test('redactFields: a secret becomes its reference, a plain value stays', () => {
  const [, seller] = redactFields('roles', project.roles, env);
  assert.deepEqual(seller.fields.map((f) => f.value), ['seller', '{{roles.seller.password}}']);
  assert.ok(!JSON.stringify(redactFields('roles', project.roles, env)).includes('s3cret-pass'));
});

test('dataContext: lists every owner with fields, marks the acting role, never the secret value', () => {
  const text = dataContext(project.roles, [lineItem], env, 'seller');
  assert.match(text, /Seller \(role seller, the role you act as\)/);
  assert.match(text, /password: \{\{roles\.seller\.password\}\} — secret — пароль продавца/);
  assert.match(text, /Line item \(entity line-item\):\n {2}- sku: SKU-1/);
  assert.ok(!text.includes('s3cret-pass'));
  assert.ok(!text.includes('Guest'));
  assert.equal(dataContext([project.roles[0]], [], env), '');
});

test('scrubSecrets: replaces a secret value echoed back in tool output', () => {
  const secrets = secretValues(project.roles, [lineItem], env);
  assert.equal(scrubSecrets('- textbox "Password": s3cret-pass', secrets), '- textbox "Password": {{roles.seller.password}}');
  // Values shorter than 4 characters would match ordinary text — left alone.
  assert.equal(scrubSecrets('a b c', [{ value: 'b', ref: '{{x}}' }]), 'a b c');
});

test('toYaml: a field keeps no `secret: false` and an owner no empty `fields`', () => {
  const yaml = toYaml(project.roles);
  assert.ok(!yaml.includes('secret: false'));
  assert.equal((yaml.match(/fields:/g) ?? []).length, 1);
});

test('validate: a duplicate field id is an error on a role and on an entity', () => {
  const dup = [{ id: 'login', value: 'a' }, { id: 'login', value: 'b' }];
  const p = Project.parse({ ...project, roles: [{ id: 'seller', title: 'Seller', interface: 'ui', fields: dup }] });
  assert.ok(validateProject(p).some((i) => i.level === 'error' && i.path === 'roles.seller.fields.login'));
  const e = Entity.parse({ ...lineItem, fields: dup });
  assert.ok(validateEntity(e, project).some((i) => i.level === 'error' && i.path === 'fields.login'));
});
