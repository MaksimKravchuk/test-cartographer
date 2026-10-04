// Vendure as a stand-in for "a real shop": stock 3.7 with the prebuilt Admin UI,
// SQLite instead of Postgres so it runs anywhere without Docker.
import { DefaultJobQueuePlugin, DefaultSchedulerPlugin, DefaultSearchPlugin, dummyPaymentHandler, type VendureConfig } from '@vendure/core';
import { AdminUiPlugin } from '@vendure/admin-ui-plugin';
import { AssetServerPlugin } from '@vendure/asset-server-plugin';
import path from 'node:path';

// No phoning home from a test bench.
process.env.VENDURE_DISABLE_TELEMETRY ??= "true";

const here = import.meta.dirname;
export const PORT = Number(process.env.PORT ?? 3000);

export const config: VendureConfig = {
  apiOptions: {
    port: PORT,
    adminApiPath: 'admin-api',
    shopApiPath: 'shop-api',
    cors: { origin: true, credentials: true },
  },
  authOptions: {
    tokenMethod: ['bearer', 'cookie'],
    superadminCredentials: { identifier: 'superadmin', password: process.env.SUPERADMIN_PASSWORD ?? 'superadmin' },
    cookieOptions: { secret: 'pilot-cookie-secret' },
    requireVerification: false,
  },
  dbConnectionOptions: {
    type: 'better-sqlite3',
    synchronize: true,
    logging: false,
    database: path.join(here, 'data/vendure.sqlite'),
  },
  paymentOptions: { paymentMethodHandlers: [dummyPaymentHandler] },
  importExportOptions: { importAssetsDir: path.join(here, 'node_modules/@vendure/create/assets/images') },
  plugins: [
    AssetServerPlugin.init({ route: 'assets', assetUploadDir: path.join(here, 'data/assets') }),
    DefaultSchedulerPlugin.init(),
    DefaultJobQueuePlugin.init({ useDatabaseForBuffer: true }),
    DefaultSearchPlugin.init({ bufferUpdates: false, indexStockStatus: true }),
    AdminUiPlugin.init({ route: 'admin', port: PORT + 2 }),
  ],
};
