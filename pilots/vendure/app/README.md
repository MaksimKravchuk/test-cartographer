# Vendure stand

Stock Vendure 3.7 on SQLite with the prebuilt Admin UI — no Docker, no Postgres.

```bash
npm install            # once
npm run populate       # fresh data/vendure.sqlite with the demo catalog (server must be stopped)
npm start              # http://localhost:3000/admin, /shop-api, /admin-api
npm run seed           # staff accounts, the test buyer, the "prepaid" payment method
```
