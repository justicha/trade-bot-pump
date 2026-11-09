# Bots

Every bot lives under `bots/`. Three of them trade (dry-run by default), the rest only read.
Parameters below are the **code defaults** (`Number(process.env.X || default)`), with the
`.env.example` value in brackets where it differs. Live mode always needs `--live` **and**
`LIVE_CONFIRM=yes`.

---

## monitor — read-only token/trade stream

**Purpose.** Shows what is happening on pump.fun right now: new tokens, buys and sells, with the
creator and the dev buy. It is the fastest way to see whether your RPC delivers events at all.

**How it works.**
1. Connects to `WS_URL` and subscribes to `logsSubscribe` with the pump.fun program as the filter.
2. Parses `Instruction:` names from the logs to tell creates from buys and sells.
3. Prints `NEW TOKEN #n`, the creator and the dev buy; `--filter-dev-buy` hides tokens whose dev buy
   is smaller than the given SOL amount.

**How to activate.**

```powershell
npm run monitor
node bots/monitor/stream.mjs --filter-dev-buy 0.5
```

No wallet is needed; the bot never signs anything.

**Parameters.**

| Variable / flag | Meaning | Default | Effect |
|---|---|---|---|
| `--filter-dev-buy <SOL>` | Minimum dev buy to print a new token | off | Fewer, larger launches |

**Output and files.** Console only. No journal, no lock, no cache.

**How to stop.** Ctrl+C closes the socket and exits 0.

**Limitations and risks.** Read-only; it does not detect whether a token is a copy of another. A
public RPC may throttle `logsSubscribe` so that nothing appears — see
[errors-and-troubleshooting.md](errors-and-troubleshooting.md).

**Status.** UNVERIFIED (no automated test, no recorded run in the git history).

---

## sniper — new-token sniping

**Purpose.** Buys a brand-new token as soon as it passes configurable filters (dev buy size, distinct
holder count, organic crowd), then exits on take-profit, stop-loss or timeout.

<p align="center"><img src="img/sniper-flow.svg" alt="Sniper flow: dev buy filter, holder gate, organic crowd, cooldown, buy, then TP, SL or timeout" width="100%"></p>

**How it works.**
1. Detects `Create` / `CreateV2` in the pump.fun logs.
2. Applies `SNIPER_MIN_DEV_BUY` (0 = off).
3. Waits for `SNIPER_MIN_HOLDERS` **distinct** wallets to buy within `SNIPER_HOLDER_WAIT_SEC`; the
   token is dropped if the count is not reached.
4. Applies the organic-crowd gate: `SNIPER_MIN_SLOTS` distinct buy slots and `SNIPER_MIN_DELAY_MS`
   after the create.
5. Checks `SNIPER_COOLDOWN_SEC` since the last buy and `SNIPER_MAX_POSITIONS`.
6. Passes the risk guard (`MAX_TRADE_SOL`, `MAX_SESSION_SOL`) and buys `SNIPER_BUY_SOL`.
7. Monitors the position every `POLL_MS` (3000 ms in the code) and sells when the price ratio reaches
   `SNIPER_TAKE_PROFIT`, falls to `SNIPER_STOP_LOSS`, or after `SNIPER_TIMEOUT_SEC`.
8. Records the result; `MAX_CONSEC_LOSSES` losing trades in a row end the session.
9. After a sell it keeps sampling the price for `SNIPER_POST_EXIT_SEC` to measure whether the exit was
   early (`journal.postExit`).

**How to activate.**

```powershell
npm run sniper                     # dry-run
$env:LIVE_CONFIRM="yes"; npm run sniper -- --live
```

**Parameters.**

| Variable | Meaning | Default | Range / notes |
|---|---|---|---|
| `SNIPER_BUY_SOL` | Buy size, SOL | `0.1` | Must be ≤ `MAX_TRADE_SOL` |
| `SNIPER_TAKE_PROFIT` | Take-profit multiple | `2.0` | Ratio vs entry |
| `SNIPER_STOP_LOSS` | Stop-loss multiple | `0.5` | Ratio vs entry |
| `SNIPER_TIMEOUT_SEC` | Max hold time | `120` | Seconds |
| `SNIPER_MAX_POSITIONS` | Concurrent positions | `3` | — |
| `SNIPER_MIN_DEV_BUY` | Minimum dev buy, SOL | `0` | `.env.example` uses `0.5` |
| `SNIPER_COOLDOWN_SEC` | Pause between buys | `10` | Seconds |
| `SNIPER_MIN_HOLDERS` | Distinct holders required | `4` | `0` = buy at create |
| `SNIPER_HOLDER_WAIT_SEC` | Holder-count window | `45` | Seconds |
| `SNIPER_MIN_SLOTS` | Distinct buy slots | `1` | Organic-crowd gate |
| `SNIPER_MIN_DELAY_MS` | Delay after create | `0` | ms |
| `SNIPER_POST_EXIT_SEC` | Post-exit sampling window | `300` | `0` = off |
| `SNIPER_STALE_MS` | Stream staleness fallback | `2000` | ms |
| `SNIPER_MAX_SEC` | Auto-stop after N s | unset | Used by tests and bounded runs |
| `SNIPER_DRAIN_MAX_SEC` | Tick drain budget at stop | `10` | Seconds |
| `TICKS` | Tick log on/off | on | `TICKS=0` disables |

**Output and files.**
- Console: `SNIPING:`, `[DRY RUN] would buy/sell`, `skip: <reason>`, `W/L`, `SESSION SUMMARY`.
- `data/journal/YYYY-MM-DD.jsonl` — trades, skips, session, shadow variants.
- `data/journal/ticks-*.jsonl` — per-second ticks per position (rotating).
- `data/journal/holders-*.jsonl` — holder milestones and price samples.
- `data/journal/.sniper.lock` — single-instance lock (PID).
- `data/journal/.sniper.lock` also stores the creator registry (`data/creators.json`).

**How to stop.** Ctrl+C: stops scanning, closes open positions (simulated in dry-run) with
`manual stop` as the exit reason, prints `SESSION SUMMARY` **before** draining the tick log, then
drains for up to `SNIPER_DRAIN_MAX_SEC`. A second Ctrl+C exits immediately. The lock is released.

**Limitations and risks.**
- A new token can be a scam, a copy or a bundle; the filters reduce but do not remove that risk.
- The holder gate needs several distinct buyers; fast tokens may graduate or die inside the window.
- The stream can be stale (`SNIPER_STALE_MS` fallback) and the RPC can rate-limit.
- In LIVE the sell can fail (slippage, drained curve); the bot retries a bounded number of times and
  reports what it could not close.

**Status.** Dry-run **Tested** (`scripts/smoke.test.mjs`, `shutdown.test.mjs`,
`instance-lock.test.mjs`, `dedupe.test.mjs`). Live **observed** in the git history; failures with pump
errors 6002/6024 were fixed afterwards.

## graduation-sniper — entry near migration

**Purpose.** Enters a bonding curve that is close to graduation (migration to PumpSwap), where the
strategy assumes liquidity and attention arrive, and exits on take-profit, stop-loss or timeout. The
current implementation is deliberately conservative about *how* it enters and *how* it exits.

<p align="center"><img src="img/graduation-flow.svg" alt="Graduation flow: real fill band, holder gate, exit preview, simulate-then-buy, partial sells bounded by real reserves, bounded retries" width="100%"></p>

**How it works.**
1. Reads pump.fun trade events and computes the **real fill**: `realSolReserves / 85 SOL × 100`.
   (Virtual reserves are ~30 SOL higher, so a virtual-based fill overstates by ~35%.)
2. Keeps the token only if `MIN_FILL ≤ fill ≤ MAX_FILL` (default 92–97) and the stream has seen at
   least `MIN_HOLDERS` distinct buyers (default 7; a **lower bound**, counted from first sighting).
3. Runs an **exit preview** on the curve math: simulate buy → sell immediately; skip unless the round
   trip returns at least `EXIT_MIN_RATIO` of the buy (default 0.9) and the curve can pay it.
4. Checks the guard, simulates the buy, sends it, and reads the **actual** entry from the transaction
   meta (SOL spent / tokens received).
5. Exits when the **sell quote** (net of the 1% fee) reaches `GRAD_TAKE_PROFIT` of the actual entry,
   falls to `GRAD_STOP_LOSS`, or after `GRAD_TIMEOUT_SEC`.
6. Before selling it splits the position so each part's payout fits `0.95 × realSolReserves`
   (`lib/sell-plan.mjs`). If the whole balance does not fit, it sells one part per cycle and re-reads
   the curve; a partially sold position keeps the remainder.
7. Simulates every sell; a failed simulation is **not** broadcast. Up to `SELL_MAX_ATTEMPTS` attempts
   with exponential backoff and growing slippage (500 → 1000 → 2000 bps, capped by
   `SELL_MAX_SLIPPAGE`), then the position is marked **STUCK** with an alert in the summary.
8. If the curve completed, it routes the sale to PumpSwap — gated behind `LIVE_CONFIRM_AMM=yes`
   because that instruction layout is **UNVERIFIED** on-chain.

**How to activate.**

```powershell
npm run graduation                     # dry-run
$env:LIVE_CONFIRM="yes"; npm run graduation -- --live
```

**Parameters.**

| Variable | Meaning | Default | Notes |
|---|---|---|---|
| `GRAD_BUY_SOL` | Buy size, SOL | `0.1` | `.env.example` ships `0.02` |
| `GRAD_TAKE_PROFIT` | TP multiple (from the sell quote) | `1.5` | — |
| `GRAD_STOP_LOSS` | SL multiple | `0.7` | — |
| `GRAD_TIMEOUT_SEC` | Max hold time | `300` | Seconds |
| `GRAD_MAX_POSITIONS` | Concurrent positions | `3` | — |
| `GRAD_COOLDOWN_SEC` | Pause between buys | `30` | Seconds |
| `GRAD_MIN_FILL_PCT` / `MIN_FILL` | Minimum real fill, % | `92` | `MIN_FILL` wins when both are set |
| `MAX_FILL` | Maximum real fill, % | `97` | Do not enter the last % before migration |
| `MIN_HOLDERS` / `GRAD_MIN_HOLDERS` | Distinct buyers from the stream | `7` | Lower bound, see limitations |
| `MAX_TOP10_SHARE` | Top-10 holder share cap | `0` (off) | Not verifiable from the stream: enabling it skips every candidate |
| `EXIT_MIN_RATIO` | Minimum round-trip ratio to enter | `0.9` | — |
| `SELL_MAX_ATTEMPTS` | Sell attempts before STUCK | `3` | — |
| `SELL_MAX_SLIPPAGE` | Sell slippage cap, bps | `2000` | Grows 500 → 1000 → 2000 |
| `BUY_SLIPPAGE_BPS` | Headroom on `max_sol_cost` | `SLIPPAGE_BPS` (500) | Without it any tick up = error 6002 |
| `LIVE_CONFIRM_AMM` | Allow the UNVERIFIED PumpSwap sell | off | `yes` to try it in live |

**Output and files.**
- Console: `WATCHLIST: <mint> fill=..% rSol=.. holders=..`, `ABOVE BAND: <mint> fill=..% > MAX_FILL=97%`,
  `skip: no free slot (…)`, `skip: entry already in flight for …`, `*** PRE-GRADUATION BUY ***`, `bought!`,
  `sold on curve|pumpswap`, `sell attempt n/3 failed`, `ALERT: … STUCK`, `SESSION SUMMARY`.
- `data/journal/YYYY-MM-DD.jsonl` — `candidate` (fill, fillBasis, holders, holdersSource, top10Share,
  spot, exitRatio, action, reason), `buy`, `buy_attempt`, `sell`, `sell_attempt`, `sell_failed`,
  `stuck`, `session` records with `sessionId`, `paramsHash`, `gitSha`.
- `data/journal/graduation-blacklist.json` — mints whose curve was already complete (never bought again).
- `data/journal/.graduation.lock` — single-instance lock.

**How to stop.** Ctrl+C closes open positions with a short bounded drain (8 s), prints the summary
(spent / received / NET, wallet before → after, estimated fees of failed transactions, STUCK list) and
releases the lock. A second Ctrl+C exits immediately.

**Limitations and risks.**
- **Mayhem-mode curves**: their real reserves stay at ~0 while virtual reserves are high, so the real
  fill is ~0 and such tokens are effectively excluded. That is a consequence of the correct fill
  formula, not a separately tested rule.
- The holder count is a lower bound: it only counts buyers seen since the first sighting.
- A drained curve cannot pay a sale; the bot detects this (`payout > realSolReserves`) and marks the
  position STUCK instead of retrying forever.
- PumpSwap sell is UNVERIFIED; the AMM price source is also missing from the shadow lab (variant I
  reports "no data").
- Slippage and priority fees are real costs; failed-but-landed transactions still pay their fee.

**Status.** Dry-run **verified** by hand (starts, journals, prints a summary); no automated test for the
bot itself. Live **observed** in the git history; entry/exit logic was rewritten afterwards. The
PumpSwap route is **UNVERIFIED**.

## copy-trader — mirror wallets

**Purpose.** Watches a list of wallets and repeats their pump.fun trades: buy when the target buys,
sell a configured percentage when the target sells.

**How it works.**
1. Subscribes to logs for every address in `COPY_TARGETS`.
2. On a target buy it opens a position of `COPY_BUY_SOL` if the position cap and the guard allow it.
3. On a target sell it sells `COPY_SELL_PCT` of the copied position.
4. Records each result; the guard can end the session after `MAX_CONSEC_LOSSES` losses or when
   `MAX_SESSION_SOL` is exhausted.

**How to activate.**

```powershell
npm run copy                     # dry-run
$env:LIVE_CONFIRM="yes"; npm run copy -- --live
```

**Parameters.**

| Variable | Meaning | Default |
|---|---|---|
| `COPY_TARGETS` | Comma-separated wallet addresses | empty (`.env.example` has the placeholders `wallet1,wallet2`) |
| `COPY_BUY_SOL` | Buy size per copied trade | `0.05` |
| `COPY_SELL_PCT` | Percentage to sell when the target sells | `100` |
| `COPY_MAX_POSITIONS` | Concurrent positions | `5` |

**Output and files.** Console: `COPY BUY from …`, exit lines with PnL. Journal: trades and session
records (bot name `copy-trader`).

**How to stop.** Ctrl+C: stops accepting events, closes positions in LIVE, prints the summary.

**Limitations and risks.** With the placeholder `COPY_TARGETS` nothing happens — that is intended.
Copying is fragile: the target may be faster, may sell in the same slot, or may be a bundle wallet.
There is no guarantee that the copy fills at a similar price.

**Status.** **UNVERIFIED** (no test, no recorded run in the git history).

---

## basic-trader — manual CLI

**Purpose.** A small manual CLI to inspect one token and to buy or sell it, with the same instruction
builder the bots use.

**How it works / usage (exact syntax from the source).**

```bash
node bots/basic-trader/trade.mjs buy     <mint> <sol_amount>
node bots/basic-trader/trade.mjs sell    <mint> <percent|all>
node bots/basic-trader/trade.mjs price   <mint>
node bots/basic-trader/trade.mjs balance <mint>
node bots/basic-trader/trade.mjs wallet            # address and SOL balance
```

(The CLI prints the same help with a short file name because it expects to be run from its own folder;
the paths above work from the repository root.)

Add `--live` to `buy` / `sell` to actually send; without it the command prints
`[DRY RUN] would buy …` / `[DRY RUN] would sell …` with the expected amounts.

**Parameters.** `SLIPPAGE_BPS` (500, 0–1500) and `MAX_TRADE_SOL` only. The CLI prints this itself:

```
[CLI] Limits: only MAX_TRADE_SOL (X SOL) applies here; MAX_SESSION_SOL and MAX_CONSEC_LOSSES do NOT apply to the CLI bot.
```

**Output and files.** Console only; it does not write a journal.

**How to stop.** It is one-shot: it exits when the command finishes.

**Limitations and risks.** One trade at a time, no position tracking, no automatic exits. Because
`MAX_SESSION_SOL` does not apply here, a typo in the amount is bounded only by `MAX_TRADE_SOL`.

**Status.** **UNVERIFIED** (no test, no recorded run in the git history).

## analytics — local dashboard

**Purpose.** A local HTTP server plus a dashboard that summarises the live market and the journal.

**How it works.** Subscribes to the same pump.fun logs, aggregates counters, serves a dashboard and a
JSON endpoint. `bots/analytics/server.mjs` binds `127.0.0.1` only and reads `ANALYTICS_PORT`
(default `3000`):

```
[analytics] API: http://localhost:3000/api/stats
```

**How to activate.**

```powershell
npm run analytics        # then open http://localhost:3000
```

**Parameters.** `ANALYTICS_PORT` (default `3000`).

**Output and files.** Console lines plus the dashboard. It does not write a journal.

**How to stop.** Ctrl+C closes the WebSocket and the HTTP server.

**Limitations and risks.** Read-only. It needs the same WebSocket capacity as the bots, so running it
next to several bots on one endpoint can hit rate limits.

**Status.** **UNVERIFIED** (no test, no recorded run in the git history).

---

## volume-analyzer — wallet/token history

**Purpose.** Reconstructs the trading history of one wallet or one token from chain data, with a
coverage report that tells you how much of the data could actually be decoded.

**How it works.**
1. Fetches signatures for the address, then the transactions (`CONCURRENCY` workers).
2. Decodes pump.fun and PumpSwap events; failures are counted, not hidden.
3. Caches parsed transactions in `data/txcache/<signature>.json`.
4. Prints a report and a `COVERAGE` line (`fetched`, `cached`, `missing`, `errors`, `retries`,
   `pumpSwapTrades`, `pswapUnresolved`, `dupSuspect`).

**How to activate.**

```powershell
npm run analyze -- wallet <WALLET_ADDRESS>
npm run analyze -- token  <MINT>
```

**Parameters.** `CONCURRENCY` (default `3`).

**Output and files.** Console report; `data/txcache/*.json`.

**How to stop.** It exits when the analysis finishes.

**Limitations and risks.** Parsing is best-effort: unknown instruction layouts are counted as
unresolved, and a pruned RPC history limits how far back the analysis can go.

**Status.** Parsing layer **Tested** (`scripts/fetchtx.integration.test.mjs`); the CLI itself has no
test.

---

## research lab — paper variants on one stream

**Purpose.** Runs several entry/exit configurations on the **same** live event stream with paper money
and writes one file per variant, so variants can be compared without pretending a single session is
evidence.

**How it works.**
1. Subscribes once to pump.fun logs.
2. Applies the lab entry rules (`LAB_MIN_HOLDERS`, `LAB_MIN_SLOTS`, `LAB_MIN_DELAY_MS`, `LAB_WAIT_SEC`).
3. For every variant built by `lib/strategy.mjs` (`A`, `B`, `C`, `D`, `E`, `F40`, `F50`, `F60`), it
   opens a virtual position with `LAB_BUY_SOL` and applies that variant's exits.
4. Fills are priced at the first price at least `LAB_LATENCY_MS` after the decision (execution delay).
5. Samples the price at `LAB_SAMPLES` seconds after entry.
6. Writes one JSONL file per variant under `data/research/variants/`.

**How to activate.**

```powershell
npm run lab
```

It **refuses** `--live` on purpose.

**Parameters.**

| Variable | Default | Meaning |
|---|---|---|
| `LAB_BUY_SOL` | `0.02` | Paper size per trade |
| `LAB_MIN_HOLDERS` | `4` | Holders gate |
| `LAB_MIN_SLOTS` | `2` | Distinct buy slots |
| `LAB_MIN_DELAY_MS` | `2500` | Delay after create |
| `LAB_WAIT_SEC` | `45` | Holder window |
| `LAB_SAMPLES` | `30,60,120,300` | Price sampling offsets, seconds |
| `LAB_LATENCY_MS` | `600` | Execution delay |
| `LAB_LATENCY_GRID` | unset | Run every variant at several latencies |
| `LAB_TARGET_TRADES` | `1000` | ETA target in the status line |
| `LAB_TAKE_PROFIT` / `LAB_STOP_LOSS` / `LAB_TIMEOUT_SEC` / `LAB_TIME_STOP_SEC` | unset | Overrides on top of every variant |

**Output and files.** `data/research/variants/<name>.jsonl` (one closed paper trade per line),
console status lines.

**How to stop.** Ctrl+C flushes the candidates and exits.

**Limitations and risks.** Paper fills only. No result is meaningful without a long run; the lab
writes data, it does not prove anything by itself.

**Status.** **Tested** (`scripts/research.test.mjs`, `strategy.test.mjs`).

## replay — compare lab variants

**Purpose.** Replays the lab output with a train/test split and bootstrap resampling so a variant is
judged on data it was not fitted to.

**How to activate.**

```powershell
npm run replay
```

**Parameters.** `REPLAY_MIN_TRADES` (`300`), `REPLAY_TEST_FRACTION` (`0.7`), `REPLAY_RESAMPLES`
(`2000`).

**Output and files.** Console comparison. Reads `data/research/variants/*.jsonl`.

**Limitations and risks.** If there are fewer trades than `REPLAY_MIN_TRADES`, the script refuses to
draw conclusions instead of inventing them.

**Status.** **Tested** (`scripts/replay.test.mjs`).

---

## graduation shadow — paper lab for graduation variants

**Purpose.** The same idea as the research lab, specialised for the graduation strategy: one stream,
nine variants (`A` baseline, `B` holders 7, `C` holders 15, `D` max fill 95, `E` max fill 97,
`F` exit check, `G` B+E+F, `H` TP 1.3, `I` enter after migration), each with its own virtual wallet.

**How it works.** Enters when the real fill reaches `MIN_FILL`, applies the variant's filters, prices
the entry with the pessimistic model (200–800 ms delay, size slippage, 1%+1% pump fees, priority and
tx fee — `lib/pessimistic.mjs`), samples the price, and closes on TP/SL/timeout. Every open and close
is journaled as `gshadow_open` / `gshadow_trade`; candidates are journaled as `gshadow_candidate`.

**How to activate.**

```powershell
node bots/graduation-sniper/shadow.mjs
$env:SHADOW_MAX_SEC='3600'; node bots/graduation-sniper/shadow.mjs
node scripts/analyze-graduation.mjs
```

**Parameters.** `MIN_FILL` (`92`), `SHADOW_BUY_SOL` (`0.02`), `SHADOW_SL` (`0.7`),
`SHADOW_HOLD_SEC` (`300`), `SHADOW_MAX_SEC` (unset = until Ctrl+C).

**Output and files.** `data/journal/YYYY-MM-DD.jsonl` with the `gshadow_*` records.

**Limitations and risks.** Variant `I` needs an AMM price source the stream does not carry, so it
reports "no data". A run with no candidates produces "no data", which is not evidence of anything.

**Status.** Statistics **Tested** (`scripts/graduation-analyze.test.mjs`); the harness starts and stops
cleanly but has no long recorded run.

---

## rescue-sell — inventory and sale of leftovers

**Purpose.** Finds tokens the bot could not sell and quotes or executes a sale on the correct venue.

**How it works.**
1. Lists holdings (token-account query, or a recent-transaction scan if the RPC blocks that query).
2. For each token: reads the curve and plans the sale in parts so each payout fits
   `0.95 × realSolReserves`; if the curve is complete, looks up the canonical PumpSwap pool instead.
3. Dry-run prints the plan (parts, expected SOL, venue) and sends nothing.
4. Live sells one part per invocation, simulates first, and refuses the PumpSwap route unless
   `LIVE_CONFIRM_AMM=yes`.

**How to activate.**

```powershell
npm run rescue
npm run rescue -- --mint <MINT>
$env:LIVE_CONFIRM="yes"; npm run rescue -- --live --mint <MINT>
```

**Parameters.** `--mint` (required for live), `SELL_SLIPPAGE_BPS` (default `1000`),
`LIVE_CONFIRM=yes`, `LIVE_CONFIRM_AMM=yes`.

**Output and files.** Console plan/sale lines. No journal of its own.

**How to stop.** One-shot.

**Limitations and risks.** A token whose curve cannot pay the requested payout is reported as stuck; a
partially sold position needs another run. The PumpSwap sell is **UNVERIFIED**.

**Status.** Planner **Dry-run verified** (`scripts/sell-plan.test.mjs`); the script itself has no test.




