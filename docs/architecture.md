# Architecture

<p align="center"><img src="img/architecture.svg" alt="Module map: RPC/WebSocket into parser, bots, transaction builder, send, journal; guards, logger and journal at the side" width="100%"></p>

## Modules (`lib/`)

| Module | Responsibility |
|---|---|
| `config.mjs` | Loads `.env` (without overriding real env vars), validates numbers, requires `RPC_URL`, derives `WS_URL`, computes `LIVE`/`DRY_RUN`, enforces `LIVE_CONFIRM=yes`, caps the priority fee |
| `wallet.mjs` | The only module that reads `keys/<name>.json` (`Keypair.fromSecretKey`) |
| `rpc.mjs` | Shared `Connection` (built-in 429 retry disabled, `RPC_TIMEOUT_MS` hard deadline on every HTTP call), rate-limited `rpcCall`, `sendTxWithRetry`, RPC stats (calls, 429s, errors, failed-tx fees) |
| `ratelimit.mjs` | Priority queue (0 = exit, 1 = entry, 2 = ticks, 3 = rest) with 429 counting and a `degraded` flag |
| `retry.mjs` | `withBackoff`, `isRetryable` |
| `ws.mjs` | `SolanaWs`: `logsSubscribe`/`accountSubscribe`, re-subscribe on reconnect, dedup per subscription+signature, exponential backoff, never rejects on a handshake error |
| `events.mjs` | Payload parsing helpers, base58-safe conversion |
| `mayhem.mjs` | Mayhem-mode detection (program id, curve flag, event route) |
| `pumpfun.mjs` | Curve state, buy/sell instructions, fee/buyback recipients from the on-chain `global` account, `calcBuyTokens`/`calcSellSol`/`calcSellQuote` |
| `pumpswap.mjs` | PumpSwap event parsing, canonical pool PDA, `PoolState`/`GlobalConfig` decoding, `ammSellIx` (UNVERIFIED on-chain) |
| `curve.mjs` | Price/impact math, plausible-band checks, `gradFillPct` (real-reserve fill) |
| `fees.mjs` | Cost model: pump 1% in + 1% out, priority fee, base tx fee, assumed slippage |
| `exec.mjs` | `readExecution` (actual SOL/tokens from tx meta), `previewExit` (round-trip gate), `simulateTx` |
| `send.mjs` | `simulateThenSend`: simulate first, then broadcast with `skipPreflight` |
| `sell-plan.mjs` | Splits a sale so every part's payout fits `0.95 × realSolReserves`; steps the curve between parts |
| `pump-errors.mjs` | IDL error table (111 codes) + `describeTxError` + classifiers |
| `guards.mjs` | `TradeGuard`: per-trade cap, session cap, consecutive-loss halt |
| `session.mjs` | Session ledger and the one-shot summary (spent / received / NET, costs, wallet delta, failed-tx fees, STUCK) |
| `journal.mjs` | JSONL writer/reader, `costsScheme` stamping, dedupe, summaries |
| `ticks.mjs` | Rotating tick log with `ageMs` and `stale` flags |
| `logger.mjs` | Leveled logger with secret masking (JSON byte arrays, `secretKey=` blobs, 80–90 char base58) |
| `pessimistic.mjs` | Pessimistic execution model: 200–800 ms delay, size slippage, full costs |
| `gradstats.mjs` | Mean/median, profit factor, max drawdown, seeded bootstrap CI (n ≥ 30) |
| `shadow.mjs`, `strategy.mjs`, `research.mjs` | Variant definitions and paper-trading logic |
| `holders.mjs`, `holderticks.mjs` | Holder counting and trajectory sampling |
| `runmeta.mjs` | `sessionId`, `paramsHash`, `gitSha` |
| `solprice.mjs` | Optional SOL/USD display price (`SOL_PRICE_SOURCE=off` disables the hosts) |
| `status.mjs`, `time.mjs`, `consistency.mjs`, `creators.mjs`, `rebuild.mjs`, `rawcap.mjs`, `analyzer-core.mjs` | Status line, Moscow timestamps, curve consistency, creator registry, report rebuild, raw capture, transaction analyzer core |

## Data flow

1. **Ingest.** `lib/ws.mjs` subscribes to `logsSubscribe` for the pump.fun program (and for copy
   targets). A reconnect re-subscribes every stored subscription and clears stale handler ids.
2. **Parse.** Logs are scanned for `Instruction: …` names and for `Program data:` payloads with the
   trade-event prefix. The parser reads fixed offsets (below).
3. **Decide.** Each bot applies its own filters, then the shared `TradeGuard`.
4. **Price.** Curve math in `lib/curve.mjs`/`lib/pumpfun.mjs`; costs in `lib/fees.mjs`.
5. **Act.** Dry-run writes a simulated record. Live builds a versioned transaction (`lib/tx.mjs`),
   simulates it (`lib/exec.mjs`), signs with the local key and broadcasts (`lib/send.mjs`).
6. **Record.** `lib/journal.mjs` appends one JSON line per event; `lib/session.mjs` prints the summary
   at stop.

## Event and account layouts (as implemented)

**V3 trade event** (`lib/events.mjs`, `bots/graduation-sniper/graduation.mjs`), little-endian:

| Offset | Size | Field |
|---|---|---|
| 0 | 8 | discriminator `bddb7fd34ee661ee` |
| 8 | 32 | mint |
| 40 | 8 | sol amount (lamports) |
| 48 | 8 | token amount (raw units) |
| 56 | 1 | is_buy |
| 57 | 32 | user |
| 89 | 8 | timestamp |
| 97 | 8 | virtual SOL reserves |
| 105 | 8 | virtual token reserves |
| 113 | 8 | real SOL reserves |
| 121 | 8 | real token reserves |

**Bonding-curve account** (166 bytes): `8` discriminator, `8` virtual token reserves, `16` virtual SOL
reserves, `24` real token reserves, `32` real SOL reserves, `40` token total supply, `48` complete,
`49..81` creator, `81` is_mayhem_mode.

**PumpSwap pool** (`lib/pumpswap.mjs`): `43` base mint, `75` quote mint, `139` base vault, `171` quote
vault, `211` coin creator, `243` is_mayhem_mode, `244` is_cashback_coin, `245` virtual quote reserves
(i128), `261` creator fee bps. The canonical pool is
`PDA(["pool", u16(0), ["pool-authority", mint], mint, WSOL])`.

## Cost model

- Pump fee: **1% on the buy and 1% on the sell** (`lib/fees.mjs`).
- Priority fee: `CU_PRICE × CU_LIMIT / 1e6` lamports — **charged on the requested limit** — plus the
  5000-lamport base fee. `lib/rpc.mjs` estimates the fee of a landed-but-failed transaction this way.
- Curve impact is computed from the reserves, not assumed.
- `SLIPPAGE_ASSUMED_BPS` (default 50) is added on top in the dry-run cost model.
- `lib/pessimistic.mjs` adds a 200–800 ms execution delay and size-dependent slippage for paper modes.

## Guards

`TradeGuard.checkOpen()` returns `{ok}`, `{ok:false,terminal:false}` (skip this trade) or
`{ok:false,terminal:true}` (end the session). `MAX_TRADE_SOL=0` blocks every trade;
`MAX_SESSION_SOL=0` and `MAX_CONSEC_LOSSES=0` disable their checks. `reserve()` is called synchronously
right after the check to close the concurrent-event race, and `release()` rolls it back when a send
fails.

## Journal format

One JSON object per line in `data/journal/YYYY-MM-DD.jsonl`. Every line has `ts` (UTC), `tsMsk`
(Moscow), `bot` and `type`. Trades additionally carry `costsScheme` and the fields written by the bot
(entry/exit price, `solSpent`/`solReceived`, `tokens`, `pnlSol`, `priceSource`, `venue`, attempts,
slippage). Session records add `sessionId`, `paramsHash`, `gitSha` and the RPC snapshot. Tick lines add
`ageMs` and `stale`. The graduation shadow lab writes `gshadow_candidate`, `gshadow_open` and
`gshadow_trade` (with `netPct`, `reason`, `holdSec`, `slipBps`, `delayMs`, `costsScheme`). The
`costsScheme` stamp separates accounting epochs: `v3-single-slip` charges the buy slippage once,
while lines without the field are the older model that charged it twice, so the analyzer reports
them as separate tables.

Rotation: ticks rotate by size and are drained at stop (`SNIPER_DRAIN_MAX_SEC`); raw captures rotate
hourly by local hour (`data/raw/YYYY-MM-DD-HH.jsonl.gz`).

