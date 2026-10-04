#!/usr/bin/env bash
# One-time setup of the pilot stand: Vendure (npm, SQLite) and the community
# Remix storefront, pinned to the commit the pilot ran against.
set -euo pipefail
cd "$(dirname "$0")"

(cd app && npm install --no-fund --no-audit && npm run populate)

if [ ! -d storefront ]; then
  git clone https://github.com/vendure-ecommerce/storefront-remix-starter storefront
  git -C storefront checkout 6ab0d09b2769006d61041ca785cd4e7fc136ced9
fi
(cd storefront && npm install --ignore-scripts --legacy-peer-deps --no-fund --no-audit && npx remix build)
echo "Stand ready: ./start.sh"
