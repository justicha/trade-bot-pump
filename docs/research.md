# Research

The research tools answer one question: *is a rule better than doing nothing, on data I did not fit
it to?* They produce data; they do not produce results by themselves.

## Honesty rules used by the code

- A bootstrap confidence interval is computed only for **n ≥ 30** (`lib/gradstats.mjs`).
- A profitability conclusion is not drawn below **n = 200**; the analyzer prints a warning instead.
- Every paper fill must carry an execution model: delay, size slippage, pump fees (1% + 1%), priority
  fee and transaction fee (`lib/pessimistic.mjs`).
- Data that cannot be decoded is counted, not silently dropped (the `COVERAGE` line).
- Consequently, this repository publishes **no results**: no performance figures, no return, no
  "study" output that would be reproducible without the raw journals.

## Research lab — variants on one stream

`bots/research/lab.mjs` subscribes once and paper-trades several variants in parallel:

- entry rules: `LAB_MIN_HOLDERS`, `LAB_MIN_SLOTS`, `LAB_MIN_DELAY_MS`, `LAB_WAIT_SEC`;
- fill model: the first price at least `LAB_LATENCY_MS` after the decision (execution delay), with
  optional `LAB_LATENCY_GRID` to run every variant at several latencies;
- exits: each variant's own rules, optionally overridden by `LAB_TAKE_PROFIT`, `LAB_STOP_LOSS`,
  `LAB_TIMEOUT_SEC`, `LAB_TIME_STOP_SEC`;
- variants built by `lib/strategy.mjs`: `A`, `B`, `C`, `D`, `E`, `F40`, `F50`, `F60`;
- output: `data/research/variants/<variant>.jsonl`, one closed paper trade per line.

It refuses `--live` on purpose.

## Replay — train/test split

`bots/research/replay.mjs` reads the lab output and compares variants with:
`REPLAY_MIN_TRADES` (300) as a floor, `REPLAY_TEST_FRACTION` (0.7) for the split and
`REPLAY_RESAMPLES` (2000) for the bootstrap. If there are too few trades it refuses to draw a
conclusion.

## Raw capture and offline replay

- `npm run capture-raw` writes `data/raw/YYYY-MM-DD-HH.jsonl.gz` (one gzip file per hour) with the
  raw event, instruction path and payload. Flags: `--dir <path>`, `--programs <list>`.
- `npm run raw-stats` prints sizes/records per hour.
- `npm run replay-raw` replays captured events through the same parser offline (no network).
- `npm run lab-raw` replays raw data through the lab. `--freeze <variant>` locks the choice, the
  parameters and the cost scheme from that moment; `--control <variant>` adds a control variant that
  competes with the frozen one.
- `npm run coverage` reports how much of the captured data produced a usable price.

## Parser validation

`npm run validate-parser` samples live events (`SAMPLES`, default 250; `SECONDS`, default 240) and
writes `data/research/parser_validation.json`. It compares the price decoded from the event with the
price decoded from the curve account, so a layout regression shows up as a diff instead of a silent
wrong price.

## Curve consistency and Mayhem

`lib/consistency.mjs` checks the x·y=k invariant across consecutive curve snapshots; `lib/mayhem.mjs`
detects Mayhem-mode routes (a third-party program that CPIs into pump.fun). The analysis recorded in
`data/research/diag390.json` attributes the invariant violations to Mayhem CPI paths; per the file's
own counts, every violation it examined came from such a path. Treat that as a property of the data
file, not as a general law.

The practical consequence is in the bots, not in the report: **fill and price are computed from real
SOL reserves** (`gradFillPct`), and Mayhem curves — whose real reserves stay near zero — fall outside
the graduation fill band instead of producing nonsense prices.

## Graduation shadow lab

`bots/graduation-sniper/shadow.mjs` is the graduation counterpart of the lab. Fourteen variants
(`A` baseline, `B` holders 7, `C` holders 15, `D` max fill 95, `E` max fill 97, `F` exit check,
`G` B+E+F, `H` TP 1.3, `I` enter after migration, `J` the live config, `K` late entry, `L` momentum, `M` J with SL 0.5, `N` exit on migration) share one candidate stream and one virtual wallet
each.

`scripts/analyze-graduation.mjs` prints, per variant: `n`, win %, mean/median net %, profit factor,
max drawdown, the TP/SL/timeout/STUCK mix and a 95% bootstrap CI (only for n ≥ 30). Each variant's
series is split in half by time: the first half is the fit window, the second is the hold-out.
Acceptance rule: the lower CI bound on the **second** half must be above zero, in the pessimistic
model. Variant `I` is a stub, not a bug: the stream has no AMM entry price and the repo has no
PumpSwap buy quote, so `I` trades nothing.

Revision 5 adds four variants: `K` late entry (fill 88-95, holders >= 20), `L` momentum (fill 75-90,
holders >= 5, and the fill grew by >= `SHADOW_MOMENTUM_PP` percentage points over `SHADOW_MOMENTUM_SEC`
seconds), `M` (`J` with SL 0.5) and `N` (`J`, but a migrated position exits at the first pool quote
with reason `migration-exit`). `K` and `L` exit at TP 1.5 / SL 0.7 / 300 s. Because `L` uses fill 75,
the candidate threshold is now 75% (more `gshadow_candidate` rows); the entries of `A`-`J` are
unchanged.

### Variant J — the live config

`J` paper-trades the live graduation entry band, reading the same `GRAD_*` variables the real bot
uses via a short-name chain: `MIN_FILL ‖ GRAD_MIN_FILL_PCT`, `MAX_FILL ‖ GRAD_MAX_FILL_PCT`,
`MIN_HOLDERS ‖ GRAD_MIN_HOLDERS`, plus `GRAD_TAKE_PROFIT`, `GRAD_STOP_LOSS` and `GRAD_TIMEOUT_SEC`
(defaults 92/97/7 and 1.5/0.7/300). The shadow stake is set separately with `SHADOW_BUY_SOL`
(default `0.02`).

Pitfalls:
- The short names `MIN_FILL` / `MAX_FILL` / `MIN_HOLDERS` are read BEFORE the `GRAD_*` names, and
  `MIN_FILL` also moves variants `A`-`I`, so changing it for `J` changes the others too.
- `J` does not reuse `GRAD_BUY_SOL`: if the stake in `.env` is not `0.02`, set `SHADOW_BUY_SOL`
  manually.
- `J` does not model `MAX_POSITIONS`, cooldown, the Mayhem/Token-2022 filters, the exit-ratio gate
  or the pre-buy simulation of the live bot, so `J` is an upper bound on the number of entries.

```powershell
$env:SHADOW_MAX_SEC = "21600"   # 6 hours; without the variable — until Ctrl+C
node bots/graduation-sniper/shadow.mjs
node scripts/analyze-graduation.mjs
```

The startup prints two lines after "Listening for candidates...": `variants <ACTIVE> | candidate
threshold <MIN_FILL>% | J live config: fill <min>-<max>%, holders>=<n>, TP <tp>, SL <sl>, hold <sec>s`
and `clock guards <LATE>s (stall / late timeout / stale events) | L momentum +<pp>pp / <sec>s | do not
select text in this window: a paused console freezes the lab`. With the defaults the first line is
`variants ABCDEFGHJKLMN | candidate threshold 75% | J live config: fill 80-90%, holders>=5, TP 1.5,
SL 0.7, hold 300s`; if `J` shows `92-97 / 7`, the `GRAD_*` variables were not read.

### Clock guards (shadow rev 5)

Three times the whole lab froze for 22-39 min, each within ~1.3 s after a fill >= 100% event. The most
likely cause is a paused Windows console (QuickEdit / text selection — clicking or selecting text in a
classic PowerShell or cmd window blocks `console.log` and freezes the event loop); **not proven**.
Revision 5 adds three guards (`SHADOW_LATE_SEC`, default 30, `0` = off):

- a process stall is journaled (`gshadow_stall`), and the positions that lived through it are marked
  with `stallSec`;
- a timeout noticed later than `SHADOW_LATE_SEC` after its deadline is journaled WITHOUT a result
  (`late: true`, `netSol null`) instead of a wrong backdated price;
- stream events older than `SHADOW_LATE_SEC` are dropped (a `gshadow_stale_events` summary row),
  instead of opening positions on stale data.

Run the lab in Windows Terminal or the VS Code terminal, and do not select text in the bot window.

Reading old exports: rows without `shadowRev` are pre-rev-5 and can contain freeze artifacts — for the
2026-11-12/13 exports exclude rows with `holdSec > 330` (not the whole mint). Rows with `stallSec` are
positions that lived through a stall; rows without a result (`netSol null`) stay outside the averages.
`costsScheme` is still `v4-amm-exit`.

shadowRev 7 changed no decision (rev 6 and rev 7 rows of the same costsScheme are comparable); it only
adds `feat` to `gshadow_open` (lib/gshadow-features.mjs). Read it with care: a null means "not seen"
(e.g. `ageSec` / `name` null = the create happened before the lab was watching; `firstSeenFill` says
how much of the mint's life the lab saw), and `creatorLaunches24h` / `sameNameRecent` are lower
bounds until `watchSec` exceeds 24 h / 30 min. The trade-event creator fallback (`creatorSource:
"trade"`) is decoded from the IDL layout; check it against `creatorSource: "create"` rows first.

shadowRev 8 (same costsScheme) keeps A F J K L M N byte-for-byte (rev 7 and rev 8 rows of those
variants are comparable) and takes B C D E G H off the default set. New paper variants, all N
(fill 92–97, SL 0.7, timeout 300 s, exit on migration) with `minHolders` 0:

| variant | rule |
|---|---|
| O | entry event's on-chain time inside `SHADOW_HOURS_UTC` (default 19:00 <= t < 23:00 UTC) |
| P | O, and the launcher is known, not serial, not launcher-mode |
| Q | launcher filter only, all hours |
| R | no extra rule (N without the holder minimum) |

Compare O vs R for the hour rule, Q vs R for the launcher filter, R vs N for the holder minimum.
The launcher is the create event's signer (`user`), not its `creator`. Serial = at least
`SHADOW_SERIAL_LAUNCHES` (3) creates by that signer in 24 h including this one; launcher-mode =
`user != creator`; a mint whose create the lab did not see (restart, older than the process, older
than 24 h) is unknown and P / Q skip it. The 24 h count is a lower bound until `feat.watchSec`
exceeds 24 h. `gshadow_mem` carries cumulative skips per (variant, mint): `outsideHours`,
`launcherUnknown`, `launcherMode`, `serialLauncher`, plus the index size (`launchMints`,
`launchers`). `feat` gains `deployer`, `deployerIsCreator`, `deployerLaunches24h` (null when the
create was not seen), `inUsHours` and `hourUtc` (of the opening event).

## Mint census

`node scripts/mint-census.mjs` (`lib/mint-census.mjs`, censusRev 3) records EVERY pump.fun launch the
stream shows — base rates and early predictors for a new strategy, where the shadow lab sees only
mints at fill >= 92 % and journals features only when a variant opens. Read-only: the pump program's
log stream and nothing else (zero RPC calls, no keypair, `--live` refused). Its own instance lock
(`data/census/.census.lock`), so it can run on the PC while the shadow lab runs on the phone.

One `census_mint` row per mint, written when the mint finishes:

| `final` | When | `migrated` |
|---|---|---|
| `complete` | an event with fill >= 100 % (`completeSec` = its on-chain time) | `true` |
| `idle` | no event for `CENSUS_IDLE_SEC` (1800) of STREAM time (newest event time seen) | `false` |
| `shutdown` | Ctrl+C / SIGTERM / `CENSUS_MAX_SEC`; `partial: true` | `null` |

A mint that trades again after its idle row continues and later writes a new row with
`resumed: true` (milestones and counters carried over; the flow features of the resumed part start
from zero). **Analysis takes the last row per mint**; one unique mint = one observation; never pool
different `censusRev` (rev 2 = rev 1 + `census_pool`; its `census_mint` rows are unchanged except
`censusRev`, so rev-1 and rev-2 mint rows may be compared, pool rows exist only in rev 2). **Rev 3
changes `census_mint` semantics** (the fill of mayhem and other-quote curves, below): rev-3 mint rows
must not be pooled with rev 1 / 2 without a note; for normal SOL curves the numbers are the same.

Row fields: `mint`, `createSec` (on-chain), `createSeen`, `launcher` (= create `user`, the signer),
`isCreator` (`user == creator`), `launches24h` (launcher's creates in 24 h incl. this one, lower
bound for the first 24 h of a run), `devBuySol` (launcher's / creator's buys in the create slot or
the first 10 s), `hourUtc` (of `createSec`, else of the first event), `maxFill`, `trades`,
`uniqueTraders`, `lastSec`, `final`, `maxLagSec` (local clock − on-chain time, max over the mint's
events), flags `partial` / `stall` / `resumed`, and `unpricedTrades` (when > 0: trade events
whose payload carries a zero SOL side — rev 3: these are curves quoted in another mint, see below;
before rev 3 such a mint had `maxFill: null`). Rev 3 adds `tokenFillEvents` (events whose fill came
from the token side), `mayhem: true` (the TradeEvent's `mayhem_mode`), `quoteMint` (the curve's quote
mint when it is not SOL) and `completeSeen: false` (completed by its pool's own event, see the pool
section). Rows with `unpricedTrades` also carry
`unpricedLens` (sorted distinct payload lengths of those events, at most 4), and the raw bytes of the
mint's FIRST such event: `unpricedSample` (bytes 8..24, right after the discriminator — for trade-v3
that is the first half of the mint key) and `unpricedTail` (bytes 89..129: timestamp and the four
reserve fields), hex, undecoded. A mint whose create was not seen has
`createSeen: false` and `launcher`, `isCreator`, `launches24h`, `devBuySol`, `createSec` null (never
guessed). Rows with `maxFill < CENSUS_FULL_MIN_FILL` (25) stop there (compact). Full rows add
`name`, `symbol`, `creator`, `creatorSource`, `firstSec`, `firstSeenFill`, `maxFillSec`,
`migrated`, `completeSec` and `milestones`:

`milestones["25"|"50"|…]` — taken at the FIRST event whose fill reaches the milestone (a jump
20 → 60 % records 25 and 50 at that event): `sec`, `secFromCreate`, `fill`, `fillSource` (rev 3:
`"price"` = realSol / 85 SOL, `"token"` = the token side), `price` (curve spot, SOL per token; null on
an event without the SOL side), `lagSec`, `holders` (wallets with a buy), `launcherBuySol`, `launcherSellSol`,
`launcherSold`, `feat` (the rev-7 `feat` names from `lib/gshadow-features.mjs buildFeatures`:
`ageSec`, `creatorBuySol`, `creatorSellSol`, `creatorTrades`, `creatorLaunches24h`, `sameNameRecent`,
`trades`, `uniqueTraders`, `topWalletTradeShare`, `topWalletVolShare`, `top5NetSol`, `top5NetShare`,
`buySol60`, `sellSol60`, `buys60`, `sells60`, `maxSell60Sol`, `priceRel`; per-mint constants live
on the row), and after it: `minFillAfter` / `minSecAfter` (deepest fill before the mint ends),
`ratioMinAfter` (curve price there / price at the milestone — the stop-loss question), `secTo100`
(null if it never completed). Milestones are recorded only for crossings the census saw: a mint
first seen at 30 % (create not seen) has no `25`. Use `createSeen: true` mints for base rates.

Other rows: `census_stall` (the process clock jumped > 30 s; live mints and mints that start in
the next 60 s carry `stall: true`), `census_gap` (see below), `census_mem` (every
`CENSUS_MEM_ROW_SEC` and at the stop: rss, heap, live / idle-remembered mints, store sizes, row
counts, `gaps`, `gapSecTotal`, `wsReconnects`, `unpricedByLen` {payload length: events}). Memory is bounded: a mint's state is
dropped with its row, the launcher / creator / name indexes are trimmed by on-chain age, idle mints
are remembered 24 h (for `resumed`).

**Fill from the token side (rev 3, KODING #21c).** The pump `TradeEvent` (IDL 2026-11) carries
`quote_mint`, `virtual_quote_reserves`, `real_quote_reserves` and `mayhem_mode` after `ix_name`.
Measured on 66 872 live events (2026-11-17, 15 min) plus a 14-min raw sample:
- the "unpriced" events (zero SOL side, ~17 % of trade events) are ALL curves quoted in another mint
  (USDC, other pump tokens, ...; none SOL-quoted). Their token side is the standard curve
  (virtual − real tokens = 279.9e12 in every event), and the SOL-equivalent fill from it,
  `tokenFill = (30 / 85) × (1.073e15 / vTok − 1) × 100` (the constant product: vSol = 30 SOL × 1.073e15 /
  vTok), equals their quote-side fill (real quote / (initial virtual quote × 85 / 30)) to
  p50 7e-7 pp / max 0.027 pp (10 748 events of non-mayhem other-quote curves). NOT `1 − realTok / 793.1e12`:
  that is the share of tokens sold (50 % sold = 20.7 % fill);
- mayhem curves (~60 % of creates) have the standard token side but their virtual SOL is cut on the
  fly (k / k0 from 0.004 to 9): they COMPLETE (real tokens 0) with ~0.1–1 SOL raised, i.e. a SOL fill of
  0.1–1 %. Rev 2 never saw these completions: 7 of 12 curve completions in the 14-min sample (6 mayhem,
  1 other-quote) were invisible to it;
- on normal SOL curves the token-side fill equals realSol / 85 to < 0.0001 pp (26 461 events).
So rev 3 takes the fill from the token side for an event without the SOL side and for every mayhem
event (when the token side is standard; a non-standard one — 5 mints at 211.8e12 in the sample —
keeps the old rule), and the SOL fill otherwise. The completion is `fill >= 100` on that fill
(= real tokens 0), for every curve; on a standard token side the fill is capped at 99.99 while real
tokens remain (a rounded 99.996 is not a completion). A fill > 200 % is not a curve state (two
non-pump "mints" with one event at 1.8e9 % were seen live): the event counts as a trade without a
fill (`badFill` in `census_mem`). Prices stay SOL-only (no derived price). Curves quoted in another
mint get no pool watch (their pool is not the WSOL canonical pool; `poolSkipped`). `census_mem` adds
`tokenFill` (events) and `logTruncated` (pump notifications whose logs the validator cut: events after
the cut are lost).

**Stream gaps.** `lib/ws.mjs` reconnects silently, and during a drop the census misses events (a
milestone is then recorded at the next event; a mint created meanwhile is `createSeen: false`). No
create / trade event for `CENSUS_GAP_SEC` (default 10 s; the normal rate is ~45 events/s) opens a
gap; the next event closes it and writes `census_gap` {`startedAt` (the last event before the
silence), `endedAt`, `gapSec`, `liveMints`} (`openAtStop: true` when the stop comes first). Every
mint live at the gap start, every mint first seen within 60 s after it closes, and every milestone
snapshot taken in that window carry `gap: true`. A process stall usually produces a gap row too (the
timer and the socket resume together). `wsReconnects` in `census_mem` counts the socket's reconnects
(an optional `onOpen` observer of `SolanaWs`, unused by every other bot). Exclude or show apart
`gap` rows the same way as `stall` rows.

**PumpSwap pool path (rev 2, `lib/census-pool.mjs`).** When the census sees a curve complete
(`census_mint` with `final: "complete"`), it watches that mint's canonical PumpSwap pool (a pure PDA,
`lib/pumpswap-stream.mjs canonicalPool`, no RPC) and writes ONE `census_pool` row per mint. Mints first
seen already in the pool are out of scope (their pool events count as `unknownPool`).
**Pre-subscription (#21b):** the pool is subscribed when the mint's fill first reaches
`CENSUS_POOL_PRESUB_FILL` (92; `100` = at the completion), before the pool exists, so the migration
transaction (its `CreatePoolEvent` = the pool's opening reserves) and the first pool trades are caught
(subscribing at the completion missed them: the first SEEN trade was 4–10 s late, vault 59–77 SOL instead
of the open vault). Until the curve completes the watch is pending (events kept, no window, no row); a
mint that ends without completing (idle / shutdown row) drops it: no `census_pool` row,
`poolPresubDropped` in `census_mem`. **Rev 3 (#21c):** a pending watch whose pool shows its own
`CreatePoolEvent` or a trade while the mint's completion was not seen is activated (the curve did
complete): the mint row is written as `final: "complete"`, `migrated: true`, `completeSeen: false`
(`completeSec` = the `CreatePoolEvent` second if that was the event, else null), and the pool row
carries `completeSeen: false` (`poolActivatedNoComplete` in `census_mem`). If the curve's completing
event arrives after that (the pump and pool subscriptions are separate streams), the watch takes its
second and price (`lateComplete: true`, `poolLateComplete`). Prices come
from the pool's own Buy/SellEvents: before the trade = (quote vault + `virtual_quote_reserves`) /
base vault, after the trade = the same after the trade's amounts — SOL per token, the unit of the
curve prices (a fixture test shows the first pool price at 0.997 of the curve's last price; without
the virtual quote reserves it would be 0.79). Time 0 = the FIRST pool trade (on-chain seconds); the
watch ends `CENSUS_POOL_WATCH_SEC` (3600) later, earlier after `CENSUS_IDLE_SEC` without a pool event
(`final: "idle"`), or at the stop (`final: "shutdown"`, `partial: true`).

Row fields: `mint`, `pool`, `mode` (subscription mode, see below), `final`, `completeSec` (curve),
`completeSeen` (rev 3), `curveEndPrice` and `curveEndSource` (rev 3: `"price"` = the curve price at the
completing event; `"standard"` = the constant 4.1088e-7 of a normal SOL curve whose completion was not
seen or had no SOL side; `"lastPrice"` = a mayhem curve without a seen completion: its last SOL price,
with that event's fill in `curveEndFill`), `firstPoolSec`, `poolDelaySec` (first pool event
− completion; null when `completeSec` is null), `firstPoolPrice` (before the first trade), `ratioOpen` (= `firstPoolPrice /
curveEndPrice`), `quoteReserveSolAtFirst` (real SOL in the vault before the first trade);
the open (#21b, when the `CreatePoolEvent` was seen): `t0` (`"create"` = the open was seen, `"trade"`
= it was not; t = 0 of every checkpoint stays the first pool TRADE either way), `poolOpenSec`,
`poolOpenPrice` (= `pool_quote_amount / pool_base_amount`: on a pump migration the open quote is the
whole effective quote — right after the create a part of the vault becomes the virtual quote reserves;
a real migration opened at 0.9998 of the standard curve end), `openRatio` (= `poolOpenPrice /
curveEndPrice`), `quoteReserveSolAtOpen` (vault + virtual at the open), `poolMayhem` (the event's
`is_mayhem_mode`: mayhem pools open far below the curve end), `firstTradeAfterOpenSec`,
`firstTradeAtOpen` (the first trade seen started from the open reserves = no trade was missed);
`ratio10s`, `ratio30s`, `ratio1m`, `ratio3m`, `ratio5m`, `ratio15m`, `ratio30m`, `ratio60m` = the
last pool price at or before t / `curveEndPrice` (`null` when the watch did not reach t — idle end,
stop, or t > `CENSUS_POOL_WATCH_SEC`); `minRatio*` / `minSec*` / `maxRatio*` / `maxSec*` for `1m`,
`5m` and `All` (the opening price and the price after every trade; seconds from t = 0; `1m` / `5m`
null when not reached); `flow1m`, `flow5m`, `flowAll` {`trades`, `buys`, `sells`, `buySol` (paid
with fees), `sellSol` (received), `uniqueTraders`}; `launcherSellSol5m` / `creatorSellSol5m` (pool
sells by the census row's launcher / creator in the first 5 m; null when unknown or not reached);
`largestSellSol3m`, `largestSellWallet3m`, `largestSellSec3m`; `quoteReserveSolEnd`, `lastPoolSec`,
`observedSec`, `events`, `unpricedEvents` (events without the virtual-reserve tail), traffic (#21b):
`notes`, `failedNotes`, `logKB` (mode a: every notification of the pool's subscription; mode b:
successful transactions holding the pool's events) and `traffic` {`pre`, `m0_5`, `m5_15`, `m15_60`}
(the same per window, seconds from the first trade by the stream clock); flags
`partial` / `stall` / `gap`; rev 3: `logTruncatedNotes` (notifications of this pool whose logs were
cut) and `poolOdd: true` with `poolOddReasons` — `"openJump"` (first seen price >= 1.5 × the curve end)
and / or `"openLogTruncated"` (logs cut before the first pool trade or within 10 s of it; later cuts
are routine in busy pools and only counted). The six rev-2 outliers (`ratioOpen` 1.8–4 090) were checked on chain
(KODING_REPORT_21c): the data is real — buys in the pool's opening slot (one of 5 390 SOL), some of
them inside the migration transaction itself, whose logs end with `Log truncated` so the stream never
shows them; the census saw the pool only after them. `virtual_quote_reserves` is signed and goes
negative after such a buy (−34.4 SOL there); rev 3 uses it signed (rev 2 clamped it to 0: a price
error of ~0.6 % in those pools only). Join to `census_mint` by `mint`. Precision: a price "after" a trade is
exact for the base side; in ~20 % of consecutive trades some pools keep the coin-creator + buyback
fees in the quote vault, so the next event's reserves are higher by those fees (< 0.1 % of the price);
checkpoints therefore use the next event's own reserves whenever one exists.

Subscription (`CENSUS_POOL_MODE`): `a` (default) = one `logsSubscribe` per watched pool, made at the
pre-subscription fill (or the completion) and dropped at the watch end or the drop (`lib/ws.mjs unsubscribe`: an ended pool is not resubscribed
after a reconnect or an RPC failover switch; ~360 migrations a day ≈ 15 subscriptions at a time). If
the server rejects a pool subscription (e.g. a per-connection limit) the census switches LOUDLY to
`b` and writes `census_pool_mode` {`mode`, `reason`, `watchedPools`}; such a rejection is not an RPC
exhaustion signal (no failover switch). `b` = one subscription on the whole PumpSwap program, filtered
in-process — measured 2026-11-16 on the public endpoint: ~140 notifications/s, ~0.5 MB/s of log text
(≈ 40 GB/day, 2/3 failed transactions), so `a` is the default. `CENSUS_POOL=0` turns the pool part off.
`census_mem` adds `poolMode`, `poolLive`, `poolSubs`, `poolWatched`, `poolRows`, `poolEvents`,
`unknownPool`, `poolUnpriced`, `poolAfterEnd`, `poolDup` (a transaction delivered by two pool
subscriptions, processed once), `poolFailedTx`, `poolNotes`, `poolLogMB`, and (#21b) `poolPending`
(pre-subscribed pools waiting for their completion), `poolPresubs`, `poolPresubDropped`,
`poolPresubDroppedTraded` (dropped although pool trades had arrived: the completion was missed),
`poolOpens`, and (rev 3) `poolActivatedNoComplete`, `poolLateComplete`, `poolLogTruncated`,
`poolSkipped`.

```powershell
node scripts/mint-census.mjs                                  # until Ctrl+C
Copy-Item data\census\census-2026-11-*.jsonl agents\          # export for PROMPT
```

## RPC endpoint failover (shadow lab and mint census)

With `RPC_URLS` set (see [configuration.md](configuration.md)), the shadow lab and the census switch
to the next endpoint when a key runs out, instead of running on a dead stream for hours. The start
line lists the endpoints as `#1 host, #2 host` (never a URL: keys live in it).

Every switch writes one `rpc_switch` row — in the shadow journal (`data/journal/<date>.jsonl`) and
in the census file:

```json
{"type":"rpc_switch","fromIdx":1,"toIdx":2,"host":"mainnet.helius-rpc.com","reason":"ws:ws-handshake-429","failures":3,"at":"2026-11-16T12:00:03.120Z"}
```

- `fromIdx` / `toIdx`: 1-based positions in `RPC_URLS`; `host`: the host of the NEW endpoint.
- `reason`: `<channel>:<signal>`. Channel `ws` (the stream) or `http` (the lab's RPC calls for open
  positions). Signals: `ws-handshake-429|401|403` (handshake rejected), `http-429|401|403 [rpc-error
  <code> <message>]`, `rpc-error <code> <message>` (a JSON-RPC error such as Helius -32429 "max usage
  reached" / -32005 "Too many requests", Alchemy 429 "compute units per second capacity" / -32600
  "Monthly capacity limit exceeded", QuickNode -32007 / -32008 / -32029), `no-connect-60s` (no healthy websocket connect for 60 s).
  Prefix `all-exhausted` = every endpoint was exhausted and this is the 60 s retry of the
  least-recently-failed one (expect one such row per minute until a key answers).
- `failures`: signals in a row on the old endpoint (`RPC_FAILOVER_AFTER`, default 3).

`gshadow_mem` / `census_mem` carry `rpcIdx` (endpoint in use) and `rpcSwitches` (switches so far).
These are journal-only fields: decisions are unchanged (no SHADOW_REV / censusRev bump). Rows written
around a switch carry the existing flags — the census `census_gap` / `gap: true` (the socket is down
for a few seconds), the shadow `gshadow_stale_events` / `late` / stall flags — handle them as usual.
Open shadow positions keep being managed across a switch: their RPC calls go to the new endpoint.

The PROMPT export greps `"type":"gshadow_` — add `rpc_switch` to see the switches themselves:
`grep -hE '"type":"(gshadow_|rpc_switch)' data/journal/2026-11-1*.jsonl > gshadow-export-N.jsonl`.

## How to run a real study

```powershell
# 1) capture for a long period (days), or let the shadow lab run
$env:SHADOW_MAX_SEC='86400'; node bots/graduation-sniper/shadow.mjs

# 2) analyse
node scripts/analyze-graduation.mjs

# 3) for the sniper family: a long dry-run, then the journal analyzer
$env:SNIPER_MAX_SEC='86400'; npm run sniper
npm run journal
```

Nothing here is a result until you have a labelled sample size and the execution model attached to it.
If the analyzer prints "no positive expectancy in any variant", that is a valid and useful outcome.
