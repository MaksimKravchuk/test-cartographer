#!/usr/bin/env bash
# Test bed for the Vikunja case study: the app (AGPL-3.0) and its help pages
# (no license file) are fetched at pinned commits, never committed here.
set -euo pipefail
cd "$(dirname "$0")"
APP_REF=v2.8.0          # 6e788bf87cebe50e2b8d034b213fcf94ae5449ee
DOCS_REF=d5b7beddfd7ee12ded8e477905cea88dc1f695cd
mkdir -p .testbed sources
[ -d .testbed/vikunja ] || git clone -q --depth 1 --branch "$APP_REF" https://github.com/go-vikunja/vikunja .testbed/vikunja
if [ ! -d .testbed/website ]; then
  git clone -q https://github.com/go-vikunja/website .testbed/website
  git -C .testbed/website checkout -q "$DOCS_REF"
fi
for page in permissions sharing-and-teams projects tasks trash; do
  cp ".testbed/website/src/content/help/$page.mdx" "sources/$page.mdx"
done
echo "Sources ready. Build the app: (cd .testbed/vikunja/frontend && pnpm install && pnpm build) && (cd .testbed/vikunja && go build -o vikunja .)"
