# Configuration

Every variable below was checked in the code (`grep` for `process.env`). "Code default" is the value
used when the variable is absent; "`.env.example`" is what the sample file ships.

## RPC and network

| Variable | Code default | `.env.example` | Meaning | Read by |
|---|---|---|---|---|
| `RPC_URL` | **required** | `https://mainnet.helius-rpc.com/?api-key=YOUR_HELIUS_API_KEY` | HTTP endpoint for every RPC call. Must start with `http://` or `https://`, otherwise the process exits at startup. `WS_URL` is derived from it. | `lib/config.mjs` and every module that imports it |
| `RPC_URLS` | unset | not shipped (add a line by hand, placeholder keys) | **Research processes only** (shadow lab, mint census). Comma list of endpoints, order = priority. Each item is `http_url` (websocket derived: `https`→`wss`) or `http_url|ws_url` when the provider's websocket has another path / host (Ankr, Chainstack), e.g. `https://mainnet.helius-rpc.com/?api-key=KEY_A,https://rpc.ankr.com/solana/KEY_B|wss://rpc.ankr.com/solana/ws/KEY_B`. The http part must be `http(s)://`, the websocket part `ws(s)://`; duplicates are judged by the http part; the printed host is the http part's. When set, it replaces `RPC_URL` in those two processes (which say so at the start) and enables endpoint failover: an exhausted key moves the stream and the HTTP RPC to the next endpoint (`lib/rpc-failover.mjs`). A bad list (bad scheme, empty item, duplicate) stops the process at the start. **Multi-line form (KODING #22)**, one key per line — `RPC_URLS=[` on its own line, then one item per line (`http_url` or `http_url|ws_url`; a trailing comma is optional; blank lines and `#` lines are skipped; an inline ` # comment` is cut), then a line `]`. The loader joins the items into the same comma list, so the same checks apply; item `#n` in an error = the n-th key line of the array. A missing `]` stops the shadow lab and the census at the start ("RPC_URLS=[ at line N of .env has no closing \"]\" line"); every other process warns once and does not set `RPC_URLS`. A URL line without `NAME=` outside the array (a key continued on a new line, silently lost before #22) stops them too ("line N of .env looks like a URL without NAME="); other processes warn once. Messages carry line numbers only. Ignored — with one stderr warning — by every other bot and by any `--live` run: they keep the single `RPC_URL`. `RPC_URL` itself stays required. Endpoints are printed as `#n host` only, never the URL. | `scripts/mint-census.mjs`, `bots/graduation-sniper/shadow.mjs` (warning: `lib/config.mjs`) |
| `RPC_FAILOVER_AFTER` | `3` | — | `1..100`. Exhaustion signals in a row on the current endpoint before switching: websocket handshake or HTTP status 401 / 402 / 403 / 429 (402 Payment Required = credits used up, #22), or a JSON-RPC error with a documented provider limit code (429 = Alchemy over WebSocket, -32429 Helius, -32007 / -32008 / -32029 QuickNode) or a message saying limit / credits / capacity / quota / "max usage" / "too many requests" (Helius -32005 "Too many requests", Alchemy "compute units per second capacity" / "Monthly capacity limit exceeded"). Provider-neutral: plain 401 / 402 / 403 / 429 and generic limit wording work for any provider. Not by code: -32005 and -32011 (standard Solana "node unhealthy" / "transaction history not available"). A healthy answer resets the run. Independently, 60 s without a healthy websocket (re)connect (subscription confirmed) also switches. Stream silence alone never does. | `lib/rpc-failover.mjs` |
| `RPC_FAILOVER_COOLDOWN_MIN` | `60` | — | `0..10080`. An exhausted endpoint is eligible again only after this many minutes (a key may refill). When no endpoint is eligible ("all exhausted"), the least-recently-failed one is retried every 60 s, a loud line is logged once per 10 min, and the process never exits by itself. | `lib/rpc-failover.mjs` |
| `HELIUS_API_KEY` | `""` | `YOUR_HELIUS_API_KEY` | Declared and exported by `lib/config.mjs`. **No other module reads it** — it is unused. | `lib/config.mjs` only |
| `SOL_PRICE_SOURCE` | on | commented out | `off` disables the dexscreener/coinbase lookups in `lib/solprice.mjs`; only `SOL_USD` is used. | `lib/solprice.mjs` |
| `SOL_USD` | unset | commented out | Fixed SOL/USD rate for display when the network sources are disabled or unreachable. | `lib/solprice.mjs` |

## Execution and safety limits

| Variable | Code default | Range | Meaning |
|---|---|---|---|
| `SLIPPAGE_BPS` | `500` | `0–1500` | Slippage tolerance in basis points (500 = 5%). Used for buy/sell minimums and as the default `BUY_SLIPPAGE_BPS`. |
| `CU_PRICE` | `1500000` | `≥ 0` | Priority fee price, micro-lamports per compute unit. |
| `CU_LIMIT` | `300000` | `≥ 0` | Compute unit limit. **The priority fee is charged on this limit**, so raising it raises the fee of every transaction. `CU_PRICE × CU_LIMIT / 1e6` must stay ≤ 0.002 SOL or the process exits at startup. `.env.example` ships `120000`. |
| `AMM_SELL_CU_LIMIT` | `160000` | `≥ 0` | Compute-unit limit of the PumpSwap (AMM) sell transaction only; the same priority-fee cap check as `CU_LIMIT` (`CU_PRICE × limit / 1e6` ≤ 2 000 000 lamports); `CU_LIMIT` stays for every other tx |
| `STALL_GUARD_SEC` | `30` | `≥ 0` | Stall guard of graduation / sniper / copy-trader (process stall, stale stream events); `0` = off |
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
| `LAB_BUY_SOL` / `LAB_MIN_HOLDERS` / `LAB_MIN_SLOTS` / `LAB_MIN_DELAY_MS` / `LAB_WAIT_SEC` | `0.02` / `4` / `2` / `2500` / `45` | Paper lab entry and sampling (full table in [bots.md](bots.md#lab--paper-trading-with-variants)) |
| `LAB_SAMPLES` | `30,60,120,300` | Price sample offsets, seconds |
| `LAB_LATENCY_MS` / `LAB_LATENCY_GRID` / `LAB_TARGET_TRADES` | `600` / unset / `1000` | Execution delay, latency grid, ETA target |
| `LAB_TAKE_PROFIT` / `LAB_STOP_LOSS` / `LAB_TIMEOUT_SEC` / `LAB_TIME_STOP_SEC` | unset | Exit overrides on top of every variant |
| `SHADOW_BUY_SOL` / `SHADOW_SL` / `SHADOW_HOLD_SEC` / `SHADOW_MAX_SEC` | `0.02` / `0.7` / `300` / unset | Graduation shadow lab |
| `SHADOW_MAX_MINTS` | `20000` | Shadow lab memory bound; only fully spent mints are ever evicted |
| `SHADOW_STALE_SEC` | `15` | Seconds of silence on a mint with an open position before re-checking whether its curve finished |
| `SHADOW_AMM_POLL_MS` | `5000` | Minimum interval between pool quotes for a migrated position |
| `SHADOW_LATE_SEC` | `30` | Threshold of the three clock guards (process stall, late timeout, stale stream events); `0` = off |
| `SHADOW_ENTRY_MAX_LAG_SEC` | `5` | A stream event older than this still updates fill / price (exits) but opens no position and is not a momentum sample for L; counted as `entrySkipped` in `gshadow_stale_events`; `0` = off |
| `SHADOW_MOMENTUM_PP` | `5` | Variant L: minimum fill growth, percentage points |
| `SHADOW_MOMENTUM_SEC` | `60` | Variant L: window, seconds |
| `SHADOW_VARIANTS` | `AFJKLMNOPQR` | Which variants trade, letters, e.g. `ABCDEFGHJ`. Since shadowRev 8 B C D E G H are off unless named here |
| `SHADOW_HOURS_UTC` | `19-23` | Variants O / P: UTC hour window of the entry event's on-chain time, `S <= hour < E`; `S > E` wraps (`22-02`). Invalid = the lab does not start |
| `SHADOW_SERIAL_LAUNCHES` | `3` | Variants P / Q: a launcher (create-event signer) with this many creates in 24 h (incl. this one) is serial and skipped; integer >= 2, invalid = the lab does not start |
| `CENSUS_MILESTONES` | `25,50,75,85,92,97,100` | Mint census: fill milestones (% of the 85 SOL real reserve; rev 3: from the token side for mayhem curves and curves quoted in another mint), strictly increasing, each in (0, 100]. Invalid = the census does not start |
| `CENSUS_IDLE_SEC` | `1800` | Mint census: a mint with no event for this many seconds of stream time gets its row (`final: "idle"`); integer >= 1 |
| `CENSUS_FULL_MIN_FILL` | `25` | Mint census: a mint whose max fill is below this gets a compact row (no milestone snapshots); 0–100 |
| `CENSUS_MAX_SEC` | `0` | Mint census: stop after this many seconds (`0` = until Ctrl+C) |
| `CENSUS_MEM_ROW_SEC` | `600` | Mint census: interval of `census_mem` rows; `0` = only at the stop |
| `CENSUS_DIR` | `data/census` | Mint census output folder (also holds `.census.lock`) |
| `CENSUS_POOL` | `1` | Mint census rev 2: `0` = no PumpSwap pool watch after migrations (no pool subscription, no `census_pool` rows); `1` = on. Anything else = the census does not start |
| `CENSUS_POOL_WATCH_SEC` | `3600` | Mint census: how long (on-chain seconds from the first pool event) a migrated mint's pool is watched before its `census_pool` row; integer 1–86400. A pool with no event for `CENSUS_IDLE_SEC` ends earlier |
| `CENSUS_POOL_PRESUB_FILL` | `92` | Mint census: subscribe a mint's (future) PumpSwap pool when its fill first reaches this %, so the migration and the first pool trades are caught; `100` = only at the completion (#21 behaviour); 50–100. A mint that ends without completing drops the subscription (no row); rev 3: a pending pool that shows its own event is activated without the completion (`completeSeen: false`) |
| `CENSUS_POOL_MODE` | `a` | Mint census pool stream: `a` = one subscription per watched pool (light); `b` = one subscription on the whole PumpSwap program (~0.5 MB/s). A rejected pool subscription switches `a` → `b` by itself (loud log, `census_pool_mode` row) |
| `CENSUS_POOL_LOGS_SEC` | `900` | Mint census rev 3.1 (#21e): a pool's logs subscription (phase 1) ends this many seconds after its first pool trade (stream clock); then its price follows the two vaults + the pool account (phase 2). Integer 1–86400 |
| `CENSUS_POOL_LOGS_MB` | `40` | Mint census rev 3.1: phase 1 also ends when the pool's log bytes pass this many MB (0.001–100000) |
| `CENSUS_POOL_VAULTS` | `1` | Mint census rev 3.1: `0` = no phase 2, logs for the whole watch (rev 3 behaviour); `1` = on |
| `CENSUS_POOL_VAULT_CHECK` | `0` | Mint census rev 3.1, measurement: `1` = subscribe the vaults already at the first pool trade and compare the vault price with the trade events (phase-2 price error in `census_mem`) |
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

