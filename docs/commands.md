# Commands

List of all commands from `package.json`. The "Spends money?" column answers
whether a command can sign and send a transaction — and for that you still need
**both** switches (`--live` and `LIVE_CONFIRM=yes`).

Run commands **from the project folder** (where `package.json` is).

## Trading bots

| Command | What it does | Spends money? |
|---|---|---|
| `npm run sniper` | sniper: buys new tokens by filters, exits on take profit / stop loss / timeout | only with `--live` |
| `npm run graduation` | pre-migration sniper: enters at 92–97% curve fill | only with `--live` |
| `npm run copy` | copy trader: repeats the trades of the `COPY_TARGETS` addresses | only with `--live` |
| `npm run trade` | manual commands: `buy`, `sell`, `price`, `balance`, `wallet` | only with `--live` |
| `npm run rescue` | rescue sell of leftovers: plan only by default, sells with `--live --mint` | only with `--live --mint` |

## Monitoring and analytics (read-only)

| Command | What it does | Spends money? |
|---|---|---|
| `npm run monitor` | shows new tokens and trades in real time | no |
| `npm run analytics` | a local dashboard and the JSON `/api/stats` on `ANALYTICS_PORT` | no |
| `npm run analyze` | history of one wallet (`wallet <address>`) or token (`token <mint>`) + a coverage report | no |
| `npm run journal` | reads `data/journal`, prints slices and a summary | no |
| `npm run status` | progress: how much data is collected and how close to a conclusion | no |
| `npm run raw-stats` | sizes and record counts per hourly raw-data file | no |
| `npm run coverage` | what share of the stream can be priced and how fresh the price is | no |

## Research (paper trading)

| Command | What it does | Spends money? |
|---|---|---|
| `npm run lab` | runs several rule sets on one stream; `--live` is refused | no |
| `npm run replay` | compares the lab variants with a train/test split | no |
| `npm run capture-raw` | records all events into compressed `data/raw/*.jsonl.gz` files (hourly) | no |
| `npm run lab-raw` | the lab on recorded data: a latency and slippage grid | no |
| `npm run replay-raw` | an offline run of recorded data through the same parser and price math | no |
| `npm run replay-cycle` | a full offline cycle: the sniper entry/exit and the lab variants + accounting check | no |

## Diagnostics and code audit

These are utility scripts: they check the parser, data layout and
file integrity. They are not needed for trading.

| Command | What it does | Spends money? |
|---|---|---|
| `npm run validate-parser` | checks the parser on the live stream (read-only) | no |
| `npm run probe-layout` | finds where the reserves live in messages of different lengths | no |
| `npm run dump-layout` | finds the exact byte offsets of the reserves | no |
| `npm run verify-invariants` | checks the curve invariant on live events | no |
| `npm run recheck-baseline` | re-computes the old baseline run with the corrected price and costs | no |
| `npm run diag-curve` | curve and price diagnostics (read-only) | no |
| `npm run diag-390` | breaks down the class of messages that break the `x*y=k` invariant | no |
| `npm run mayhem` | a report on Mayhem mode: whether one owner is behind the violations | no |
| `npm run mayhem-impact` | what changes if Mayhem trades are excluded | no |
| `npm run mayhem-sol` | what actually moves the SOL reserve on the Mayhem route | no |
| `npm run rebuild` | whether the curve can be rebuilt from the anchor and trade sums | no |
| `npm run audit-data` | an integrity check of the local data files | no |
| `npm run audit-scripts` | runs the offline scripts with a timeout and prints exit codes | no |

## Tests

| Command | What it does | Spends money? |
|---|---|---|
| `npm test` | the full suite of **60** test files; runs offline, no wallet, no network | no |
| `npm run smoke` | smoke test: the real sniper in dry-run on fixture RPC/WebSocket | no |

`npm test` stops at the first failure and prints `FAIL:`. For debugging it is easier
to run one file: `node scripts/smoke.test.mjs`.

## Direct commands (on disk, but not in `package.json`)

| Command | What it does |
|---|---|
| `node lib/wallet.mjs generate [name] [--force]` | create a wallet in `keys/<name>.json` and print the address |
| `node lib/wallet.mjs show [name]` | print the public address (no network) |
| `node bots/graduation-sniper/shadow.mjs` | shadow (paper) run of the graduation variants |
| `node scripts/analyze-graduation.mjs [journal]` | report on the shadow run |
| `node scripts/sell-all.mjs` | list all tokens in the wallet; with `--live` — sell them one by one |
| `node scripts/close-empty-atas.mjs` | reclaim rent from empty token accounts: plan only by default (list and rent sum); sends only with `--live` + `LIVE_CONFIRM=yes`; never touches non-zero accounts or WSOL; writes `ata_sweep` |
| `node scripts/session-total.mjs [journal]` | sum the session totals from the journal |
| `node scripts/export-compact.mjs [sessionId]` | a compact export of one session |
| `node scripts/dump-tx.mjs <signature>` | decode one transaction |
| `node scripts/verify-live-tx.mjs [mint]` | build and simulate a buy without sending |
| `node scripts/final-report.mjs` | a report over the two halves of the journal data |

Each direct command prints its own exact syntax when run without
arguments: the files start with a "Usage" block.
