// Fresh database with the stock Vendure demo catalog (the one `@vendure/create` ships).
import { bootstrap } from '@vendure/core';
import { AdminUiPlugin } from '@vendure/admin-ui-plugin';
import { populate } from '@vendure/core/cli/index.js';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { config } from './vendure-config.ts';

const here = import.meta.dirname;
const assets = path.join(here, 'node_modules/@vendure/create/assets');
rmSync(path.join(here, 'data'), { recursive: true, force: true });
mkdirSync(path.join(here, 'data'));

const app = await populate(
  () => bootstrap({
    ...config,
    apiOptions: { ...config.apiOptions, port: 3099 },
    plugins: config.plugins!.filter((p) => p !== AdminUiPlugin),
  }),
  path.join(assets, 'initial-data.json'),
  path.join(assets, 'products.csv'),
);
await app.close();
console.log('populated');
