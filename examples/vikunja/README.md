# Vikunja case study workspace

A Test Cartographer project for [Vikunja](https://vikunja.io) v2.8.0, scoped to projects and tasks under sharing permissions. The write-up is [docs/case-studies/vikunja.md](../../docs/case-studies/vikunja.md).

What's here:

| Path | What it is |
|---|---|
| `cartographer.yaml`, `sources.yaml` | roles with test accounts, the MCP server, the runtime, the agents; the sources and their priorities |
| `proposals/` | every agent proposal with its quotes, the decisions and the settled disagreements |
| `review/` | the person's side: `decide.py` (review policy), `wire.py` (readers, setup, library entries), `round2.py` (fixes after the first run), and the two review runs that couldn't read the model |
| `entities/` | the resulting model |
| `spec.md` | the specification exported from it |
| `actions/index.ts` | the action library: how each role performs an action in Vikunja's UI |
| `mcp/server.ts` | setup and read tools over Vikunja's REST API |

Not committed: Vikunja and its help pages (`.testbed/`, `sources/*.mdx`), evidence screenshots, runs and generated tests.

## Reproduce

You need Go, Node.js 24+ and pnpm.

```bash
cd examples/vikunja
./fetch-sources.sh          # clones Vikunja v2.8.0 and its docs, copies 5 help pages into sources/
(cd .testbed/vikunja/frontend && pnpm install && pnpm build)
(cd .testbed/vikunja && go build -o vikunja .)

# Start Vikunja on :3456 with SQLite and a high login rate limit
VIKUNJA_SERVICE_PUBLICURL=http://localhost:3456/ VIKUNJA_DATABASE_TYPE=sqlite \
VIKUNJA_DATABASE_PATH=$PWD/.testbed/vikunja.db VIKUNJA_SERVICE_JWTSECRET=case-study \
VIKUNJA_RATELIMIT_NOAUTHLIMIT=100000 .testbed/vikunja/vikunja web &

# The five test accounts
for u in owner admin writer reader outsider; do
  curl -s -X POST localhost:3456/api/v1/register -H 'content-type: application/json' \
    -d "{\"username\":\"$u\",\"email\":\"$u@example.test\",\"password\":\"$u-pass-123\"}"
done

cd ../..
pnpm tc run --ws examples/vikunja       # the 217 scenarios against the committed model
```

To run the loop from scratch, remove `proposals/` and `entities/`, then: `pnpm tc onboard onboarding --ws examples/vikunja`, `pnpm tc serve --ws examples/vikunja`, and `python3 review/decide.py`, `review/wire.py`, `review/round2.py` from this folder, with the review and the explorers started from the GUI in between. Agents run in your own Claude Code sign-in (`runtime` in `cartographer.yaml`); results will differ from run to run.
