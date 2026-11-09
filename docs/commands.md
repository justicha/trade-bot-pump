# Commands

Every entry was checked against `package.json` or the file on disk. "Trades?" answers whether the
command can ever sign a transaction (live mode always also needs `LIVE_CONFIRM=yes`).

## npm scripts — trading bots

| Command | What it does | Reads network | Writes files | Trades? | Status |
|---|---|---|---|---|---|
| `npm run sniper` | New-token sniper (dry-run by default) | Yes | `data/journal/*`, `.sniper.lock` | Only `--live` | **Tested** (smoke, shutdown, instance-lock, dedupe) |
| `npm run graduation` | Curve-near-migration sniper | Yes | `data/journal/*`, `graduation-blacklist.json`, `.graduation.lock` | Only `--live` | Dry-run verified; live observed; AMM route UNVERIFIED |
| `npm run copy` | Copy trader | Yes | `data/journal/*` | Only `--live` | **UNVERIFIED** |
| `npm run trade` | Manual CLI: `buy`, `sell`, `price`, `balance`, `wallet` | Yes | — | Only `--live` | **UNVERIFIED** |
| `npm run rescue` | Inventory unsold tokens, plan/sell a part | Yes | — | Only `--live --mint` | Planner **Tested**; script **Dry-run verified** |

## npm scripts — read-only analytics

| Command | What it does | Reads network | Writes files | Trades? | Status |
|---|---|---|---|---|---|
| `npm run monitor` | Live token/trade stream | Yes | — | No | **UNVERIFIED** |
| `npm run analytics` | Dashboard + `/api/stats` on `ANALYTICS_PORT` | Yes | — | No | **UNVERIFIED** |
| `npm run analyze` | `wallet <addr>` or `token <mint>` history + coverage | Yes | `data/txcache/*.json` | No | Parsing **Tested**; CLI **UNVERIFIED** |
| `npm run journal` | Reads `data/journal`, prints slices and a summary | No | — | No | **Tested** (journal library tests) |
| `npm run status` | Progress/ETA helper for long runs | No | — | No | **UNVERIFIED** |
| `npm run raw-stats` | Size/records per hourly raw-capture file | No | — | No | **UNVERIFIED** |
| `npm run coverage` | Coverage report over captured raw data | No | — | No | **UNVERIFIED** |

## npm scripts — research and diagnostics

| Command | What it does | Reads network | Writes files | Status |
|---|---|---|---|---|
| `npm run lab` | Paper variants on one stream (refuses `--live`) | Yes | `data/research/variants/*.jsonl` | **Tested** |
| `npm run replay` | Train/test comparison of lab variants | No | — | **Tested** |
| `npm run capture-raw` | Raw event capture, gz per hour | Yes | `data/raw/*.jsonl.gz` | **Tested** (rawcap tests) |
| `npm run validate-parser` | Sample the stream and validate the parser | Yes | `data/research/*` | **Diagnostic** |
| `npm run probe-layout` | Scan payload layouts for a limited time | Yes | — | **Diagnostic** |
| `npm run dump-layout` | Look for exact reserve offsets | Yes | — | **Diagnostic** |
| `npm run diag-curve` | Curve/price diagnostics | Yes | — | **Diagnostic** |
| `npm run diag-390` | Diagnostics for the 390-event anomaly | Yes | — | **Diagnostic** |
| `npm run verify-invariants` | Check the bonding-curve invariant on live events | Yes | — | **Diagnostic** |
| `npm run recheck-baseline` | Re-check a stored baseline | Local data | — | **Diagnostic** |
| `npm run replay-raw` | Replay captured raw data offline | No | — | **Diagnostic** |
| `npm run replay-cycle` | Replay one cycle with the bot logic | Optional | — | **Diagnostic** |
| `npm run mayhem` | Mayhem mode report | Local data | — | **Tested** (library) |
| `npm run mayhem-impact` | Mayhem impact on curve consistency | Local data | — | **Tested** (library) |
| `npm run mayhem-sol` | Mayhem SOL accounting | Local data | — | **Tested** (library) |
| `npm run lab-raw` | Lab over captured raw data, freeze/control variants | No | — | **Diagnostic** |
| `npm run rebuild` | Rebuild a report from stored artifacts | No | — | **Diagnostic** |
| `npm run audit-data` | Data-integrity audit of local files | No | — | **UNVERIFIED** |
| `npm run audit-scripts` | Script-run audit (uses mocks where needed) | No | — | **UNVERIFIED** |

## npm scripts — tests

| Command | What it does | Status |
|---|---|---|
| `npm test` | Runs the full chain of 26 test scripts (offline; mocks for RPC/WS) | **Tested, passes** |
| `npm run smoke` | Single smoke test of the sniper handler on a synthetic stream | **Tested** |

## Direct commands (exist on disk, not in `package.json`)

| Command | What it does | Status |
|---|---|---|
| `node lib/wallet.mjs generate [name]` | Create `keys/<name>.json`, print the address | **UNVERIFIED** (no test; verified by reading the code) |
| `node lib/wallet.mjs show [name]` | Print the public address | **UNVERIFIED** (same) |
| `node bots/monitor/stream.mjs --filter-dev-buy <SOL>` | Monitor with a minimum dev buy | **UNVERIFIED** |
| `node bots/graduation-sniper/shadow.mjs` | Graduation paper lab, variants A–I | Statistics **Tested**; harness dry-run verified |
| `node scripts/analyze-graduation.mjs [journal.jsonl]` | Report for the shadow lab | **Tested** (stats) |
| `node scripts/session-total.mjs [journal.jsonl]` | Sum a journal's session totals | **UNVERIFIED** |
| `node scripts/export-compact.mjs [sessionId]` | Compact export of a session | **UNVERIFIED** |
| `node scripts/dump-tx.mjs <SIGNATURE>` | Decode one transaction | **Diagnostic** |
| `node scripts/probe.mjs isbuy <wallet> [n] \| cusurvey <mint> [n] \| pswap [n] \| who <sigPrefix>` | Probes for instruction/account questions | **Diagnostic** |
| `node scripts/verify-live-tx.mjs [mint]` | Builds and simulates a buy (no send) | **Diagnostic** |
| `node scripts/capture-create.mjs` | Capture one token creation | **Diagnostic** |
| `node scripts/final-report.mjs` | Two-half report over journal data | **Diagnostic** |

## Removed from older docs

The previous README/GUIDE described badges, "666 wallets", a "+88.2% in 3 seconds" example and a
"7 bots were inside" claim. None of that exists in the code or in any journal, so it was removed. No
command was removed for being non-existent: every `npm run …` above is defined in `package.json`. The
old research sections were rewritten as [research.md](research.md).

