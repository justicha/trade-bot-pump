# Configuration

Every variable below was checked in the code (`grep` for `process.env`). "Code default" is the value
used when the variable is absent; "`.env.example`" is what the sample file ships.

## RPC and network

| Variable | Code default | `.env.example` | Meaning | Read by |
|---|---|---|---|---|
| `RPC_URL` | **required** | `https://mainnet.helius-rpc.com/?api-key=YOUR_HELIUS_API_KEY` | HTTP endpoint for every RPC call. Must start with `http://` or `https://`, otherwise the process exits at startup. `WS_URL` is derived from it. | `lib/config.mjs` and every module that imports it |
| `HELIUS_API_KEY` | `""` | `YOUR_HELIUS_API_KEY` | Declared and exported by `lib/config.mjs`. **No other module reads it** — it is unused. | `lib/config.mjs` only |
| `SOL_PRICE_SOURCE` | on | commented out | `off` disables the dexscreener/coinbase lookups in `lib/solprice.mjs`; only `SOL_USD` is used. | `lib/solprice.mjs` |
| `SOL_USD` | unset | commented out | Fixed SOL/USD rate for display when the network sources are disabled or unreachable. | `lib/solprice.mjs` |

## Execution and safety limits

| Variable | Code default | Range | Meaning |
|---|---|---|---|
| `SLIPPAGE_BPS` | `500` | `0–1500` | Slippage tolerance in basis points (500 = 5%). Used for buy/sell minimums and as the default `BUY_SLIPPAGE_BPS`. |
| `CU_PRICE` | `1500000` | `≥ 0` | Priority fee price, micro-lamports per compute unit. |
| `CU_LIMIT` | `300000` | `≥ 0` | Compute unit limit. **The priority fee is charged on this limit**, so raising it raises the fee of every transaction. `CU_PRICE × CU_LIMIT / 1e6` must stay ≤ 0.002 SOL or the process exits at startup. `.env.example` ships `120000`. |
| `MAX_TRADE_SOL` | `0.05` | `≥ 0` | Per-trade cap. A trade above it is skipped; the bot keeps running. `0` blocks every trade. |
| `MAX_SESSION_SOL` | `0.2` | `≥ 0` | Total SOL a session may put into buys. Exhausted → the session ends. `0` = no cap. `.env.example` ships `0.1`. |
| `MAX_CONSEC_LOSSES` | `3` | `≥ 0` | Consecutive losing trades that end a session. `0` = no limit. |
| `CURVE_CACHE_MS` | `0` | `≥ 0` | Bonding-curve state cache TTL. `0` disables caching. |
| `RPC_TIMEOUT_MS` | `15000` | `1000..120000` | Hard deadline for every HTTP RPC call. A throttled endpoint can accept the connection and never answer; without a deadline the promise never settles, the entry slot stays busy and the bot silently stops trading while the process looks alive. A timeout is retried like a 429. |
| `LOG_LEVEL` | `info` | `debug\|info\|warn\|error` | Console verbosity. Logs are masked for secrets regardless. |
| `LIVE_CONFIRM` | unset | — (deliberately) | Second switch for live mode. Without it `--live` exits before connecting. Not in `.env.example` so it cannot persist by accident. |

## Sniper (`bots/sniper/sniper.mjs`)

| Variable | Code default | `.env.example` | Meaning |
|---|---|---|---|
| `SNIPER_BUY_SOL` | `0.1` | `0.1` | Buy size, SOL |
| `SNIPER_TAKE_PROFIT` | `2.0` | `2.0` | Take-profit multiple |
| `SNIPER_STOP_LOSS` | `0.5` | `0.5` | Stop-loss multiple |
| `SNIPER_TIMEOUT_SEC` | `120` | `120` | Max hold time |
| `SNIPER_MAX_POSITIONS` | `3` | `3` | Concurrent positions |
| `SNIPER_MIN_DEV_BUY` | `0` | `0.5` | Minimum dev buy, SOL. **The sample file enables a filter the code leaves off.** |
| `SNIPER_COOLDOWN_SEC` | `10` | `10` | Pause between buys |
| `SNIPER_MIN_HOLDERS` | `4` | `4` | Distinct holders required; `0` = buy at create |
| `SNIPER_HOLDER_WAIT_SEC` | `45` | `45` | Holder-count window |
| `SNIPER_MIN_SLOTS` | `1` | `1` | Distinct buy slots (organic crowd) |
| `SNIPER_MIN_DELAY_MS` | `0` | `0` | Delay after create |
| `SNIPER_POST_EXIT_SEC` | `300` | `300` | Post-exit price sampling |
| `SNIPER_MAX_SEC` | unset | commented | Auto-stop after N seconds (bounded runs, tests) |
| `SNIPER_DRAIN_MAX_SEC` | `10` | — (code only) | Tick-drain budget at stop |
| `SNIPER_STALE_MS` | `2000` | — (code only) | Stream staleness fallback before an on-chain check |
| `TICKS` | on | — (code only) | `TICKS=0` disables the tick log |

## Copy trader (`bots/copy-trader/watcher.mjs`)

| Variable | Code default | `.env.example` | Meaning |
|---|---|---|---|
| `COPY_TARGETS` | empty | `wallet1,wallet2` (placeholders) | Wallets to mirror; with placeholders nothing happens |
| `COPY_BUY_SOL` | `0.05` | `0.05` | Buy size per copied trade |
| `COPY_SELL_PCT` | `100` | `100` | Percentage sold when the target sells |
| `COPY_MAX_POSITIONS` | `5` | `5` | Concurrent positions |
| `COPY_MAX_HOLD_SEC` | `1800` | — | If the target has not sold within N seconds of our buy, the bot sells the whole remainder itself; `0` = off; a safety net, not a strategy exit (no TP/SL); works in DRY RUN too |

## Graduation sniper (`bots/graduation-sniper/graduation.mjs`)

| Variable | Code default | `.env.example` | Meaning |
|---|---|---|---|
| `GRAD_BUY_SOL` | `0.1` | `0.02` | Buy size, SOL |
| `GRAD_TAKE_PROFIT` | `1.5` | `1.5` | TP multiple from the sell quote |
| `GRAD_STOP_LOSS` | `0.7` | `0.7` | SL multiple |
| `GRAD_TIMEOUT_SEC` | `300` | `300` | Max hold time |
| `GRAD_MAX_POSITIONS` | `3` | `3` | Concurrent positions |
| `GRAD_COOLDOWN_SEC` | `30` | `30` | Pause between buys |
| `OPENING_STALE_SEC` | `120` | — | Watchdog for one entry: if its RPC call has not settled for this long, the slot is released with an `ALERT:` line, so a single stuck call cannot block every later candidate |
| `GRAD_MIN_FILL_PCT` | `92` | `92` | Minimum **real** fill (rSol / 85 SOL); `MIN_FILL` overrides it |
| `MIN_FILL` | — | — | Alias for `GRAD_MIN_FILL_PCT`; wins when both are set |
| `MAX_FILL` | `97` | commented | Maximum real fill. Above it the bot prints `ABOVE BAND: …` and does **not** enter: the last 3% before migration is refused by design |
| `MIN_HOLDERS` / `GRAD_MIN_HOLDERS` | `7` | commented | Distinct buyers since first sighting (lower bound) |
| `MAX_TOP10_SHARE` | `0` (off) | commented | Not verifiable from the stream; enabling it skips every candidate |
| `EXIT_MIN_RATIO` | `0.9` | — | Skip an entry whose immediate round trip returns less |
| `SELL_MAX_ATTEMPTS` | `3` | — | Sell attempts before a position is marked STUCK (an assumed loss for the limits). Applies to graduation-sniper, sniper and copy-trader; backoff 2 s, 4 s, ... between attempts |
| `SELL_MAX_SLIPPAGE` | `2000` | — | Slippage cap (bps) for the growing sell slippage |
| `BUY_SLIPPAGE_BPS` | `SLIPPAGE_BPS` | — | Headroom on `max_sol_cost` |
| `LIVE_CONFIRM_AMM` | unset | — | `yes` allows the **UNVERIFIED** PumpSwap sell in live mode |

## Token ATA closing (live)

| Variable | Code default | Range | Meaning |
|---|---|---|---|
| `ATA_CLOSE` | on | — | `no`/`0`/`false`/`off` disables closing the empty token ATA after a full live sale |
| `CLOSE_ATA_CU_LIMIT` | `10000` | `≥ 0` | Compute-unit limit of the close transaction (per `closeAccount`) |
| `CLOSE_ATA_BATCH` | `8` | `1–12` | `closeAccount` instructions per transaction in `scripts/close-empty-atas.mjs` |

## Research, shadow, replay

| Variable | Default | Meaning |
|---|---|---|
| `LAB_BUY_SOL` / `LAB_MIN_HOLDERS` / `LAB_MIN_SLOTS` / `LAB_MIN_DELAY_MS` / `LAB_WAIT_SEC` | `0.02` / `4` / `2` / `2500` / `45` | Paper lab entry and sampling (full table in [bots.md](bots.md#research-lab--paper-variants-on-one-stream)) |
| `LAB_SAMPLES` | `30,60,120,300` | Price sample offsets, seconds |
| `LAB_LATENCY_MS` / `LAB_LATENCY_GRID` / `LAB_TARGET_TRADES` | `600` / unset / `1000` | Execution delay, latency grid, ETA target |
| `LAB_TAKE_PROFIT` / `LAB_STOP_LOSS` / `LAB_TIMEOUT_SEC` / `LAB_TIME_STOP_SEC` | unset | Exit overrides on top of every variant |
| `SHADOW_BUY_SOL` / `SHADOW_SL` / `SHADOW_HOLD_SEC` / `SHADOW_MAX_SEC` | `0.02` / `0.7` / `300` / unset | Graduation shadow lab |
| `SHADOW_MAX_MINTS` | `20000` | Shadow lab memory bound; only fully spent mints are ever evicted |
| `SHADOW_STALE_SEC` | `15` | Seconds of silence on a mint with an open position before re-checking whether its curve finished |
| `SHADOW_AMM_POLL_MS` | `5000` | Minimum interval between pool quotes for a migrated position |
| `SHADOW_LATE_SEC` | `30` | Threshold of the three clock guards (process stall, late timeout, stale stream events); `0` = off |
| `SHADOW_MOMENTUM_PP` | `5` | Variant L: minimum fill growth, percentage points |
| `SHADOW_MOMENTUM_SEC` | `60` | Variant L: window, seconds |
| `SHADOW_VARIANTS` | all | Which variants trade, letters, e.g. `ABCDEFGHJ` |
| `REPLAY_MIN_TRADES` / `REPLAY_TEST_FRACTION` / `REPLAY_RESAMPLES` | `300` / `0.7` / `2000` | Replay strictness |
| `SLIPPAGE_ASSUMED_BPS` | `50` | Extra slippage assumed by the cost model (`lib/fees.mjs`, `lib/pessimistic.mjs`) |

## Analytics, misc and test fixtures

| Variable | Default | Meaning |
|---|---|---|
| `ANALYTICS_PORT` | `3000` | Dashboard/API port (the server binds `127.0.0.1`) |
| `CONCURRENCY` | `3` | Parallel transaction fetches in the volume analyzer |
| `JOURNAL_DIR` | `data/journal` | Journal directory override (tests use a temp dir) |
| `SELL_SLIPPAGE_BPS` | `1000` | Slippage for `scripts/rescue-sell.mjs` |
| `WS_MOCK` / `RPC_MOCK` | unset | Test fixtures; both **refuse** to run with `--live` |

## Minimal safe `.env`

```dotenv
# Required
RPC_URL=https://<your-rpc-host>/?api-key=YOUR_KEY

# Fees and limits (conservative)
SLIPPAGE_BPS=500
CU_PRICE=1500000
CU_LIMIT=120000
MAX_TRADE_SOL=0.02
MAX_SESSION_SOL=0.05
MAX_CONSEC_LOSSES=2

# Sniper: keep the sample filters
SNIPER_BUY_SOL=0.02
SNIPER_MIN_HOLDERS=4
SNIPER_MIN_DEV_BUY=0.5

# Graduation entry: real fill, not virtual
GRAD_BUY_SOL=0.02
GRAD_MIN_FILL_PCT=92
MAX_FILL=97
MIN_HOLDERS=7

# Logging
LOG_LEVEL=info
```

## Discrepancies worth knowing

- `HELIUS_API_KEY` is read by `lib/config.mjs` and exported, but **no module uses it**.
- `SNIPER_MIN_DEV_BUY` is `0` in code and `0.5` in `.env.example`, so a copy of the sample behaves
  differently from an empty `.env`.
- `MAX_SESSION_SOL` (code `0.2` vs sample `0.1`), `GRAD_BUY_SOL` (code `0.1` vs sample `0.02`),
  `CU_LIMIT` (code `300000` vs sample `120000`).
- Code-only variables (not in `.env.example`): `MIN_FILL`, `MAX_FILL`, `MIN_HOLDERS`,
  `MAX_TOP10_SHARE`, `EXIT_MIN_RATIO`, `SELL_MAX_ATTEMPTS`, `SELL_MAX_SLIPPAGE`, `BUY_SLIPPAGE_BPS`,
  `LIVE_CONFIRM`, `LIVE_CONFIRM_AMM`, `SNIPER_STALE_MS`, `SNIPER_DRAIN_MAX_SEC`, `TICKS`, `SHADOW_*`,
  `SELL_SLIPPAGE_BPS`.
- `LIVE_CONFIRM` is intentionally absent from `.env.example`: a persistent `yes` would defeat the
  second switch. Set it per command.

