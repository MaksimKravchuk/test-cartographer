#!/usr/bin/env bash
# Starts Vendure (:3000) and the storefront (:4500), then seeds staff, the test
# buyer and the prepaid payment method into a fresh database.
# Logs go to ./logs; stop both with: kill $(cat logs/*.pid)
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p logs

(cd app && npm run populate >/dev/null)
(cd app && nohup node server.ts > ../logs/vendure.log 2>&1 & echo $! > ../logs/vendure.pid)
until curl -sf -o /dev/null http://localhost:3000/admin/; do sleep 1; done
(cd app && npm run seed)

(cd storefront && PORT=4500 VENDURE_API_URL=http://localhost:3000/shop-api NODE_ENV=production \
  nohup npx remix-serve build/index.js > ../logs/storefront.log 2>&1 & echo $! > ../logs/storefront.pid)
until curl -sf -o /dev/null http://localhost:4500/; do sleep 1; done
echo "Admin http://localhost:3000/admin · Storefront http://localhost:4500"
