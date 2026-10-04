#!/usr/bin/env bash
# Starts Vendure (:3000) and the storefront (:4500), then seeds staff, the test
# buyer and the prepaid payment method into a fresh database.
# Logs go to ./logs; stop both with: kill $(cat logs/*.pid)
set -euo pipefail
cd "$(dirname "$0")"
root=$PWD
mkdir -p logs

cd "$root/app"
npm run populate >/dev/null
nohup node server.ts > "$root/logs/vendure.log" 2>&1 < /dev/null &
echo $! > "$root/logs/vendure.pid"
until curl -sf -o /dev/null http://localhost:3000/admin/; do sleep 1; done
npm run seed

cd "$root/storefront"
PORT=4500 VENDURE_API_URL=http://localhost:3000/shop-api NODE_ENV=production \
  nohup npx remix-serve build/index.js > "$root/logs/storefront.log" 2>&1 < /dev/null &
echo $! > "$root/logs/storefront.pid"
until curl -sf -o /dev/null http://localhost:4500/; do sleep 1; done
echo "Admin http://localhost:3000/admin · Storefront http://localhost:4500"
