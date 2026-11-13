# Shadow lab — ACT report (S1…S5)

Date: 2026-11-10. Mode: ACT, autonomous (asked no questions, conservative decisions recorded in §6).
Repository: `trade-bot-pump`, branch `main`, HEAD `a7f1b8d`. **Nothing committed or pushed.**

## 0. Initial state and backup

| What | Value |
|---|---|
| `git status` (before edits) | empty (working tree clean) |
| `git diff --stat` (before edits) | empty |
| HEAD | `a7f1b8d docs: rewrite README for beginners, add security and verification pages, flow diagram` |
| Backup | `../backup-before-shadow-act/` — 281 files, no `.git` and `node_modules`; `shadow.mjs` matches by hash |

The edits were not reverted: all items reached green tests on the first or second attempt (see §1).

## 1. Status by item

| Item | Status | Files | Test |
|---|---|---|---|
| S1 — finish on SIGINT/SIGTERM/`SHADOW_MAX_SEC` | **done** | `bots/graduation-sniper/shadow.mjs` | `scripts/shadow-finish.test.mjs` |
| S2 — entry duplicates on `mintState` eviction | **done** | `bots/graduation-sniper/shadow.mjs` | `scripts/shadow-dedupe.test.mjs` |
| S3 step 1 — the double buy-slippage check | **done** (verdict **DOUBLE**) | — (code read-only) | `scripts/shadow-slip.test.mjs` (failed before the edit, green after) |
| S3 step 2 — remove the double count | **done** | `bots/graduation-sniper/shadow.mjs`, `lib/pessimistic.mjs` | `scripts/shadow-slip.test.mjs` |
| S4 — epoch separation in the analyzer | **done** | `scripts/analyze-graduation.mjs` | `scripts/graduation-analyze.test.mjs` |
| S5 — the sample and independent-observation output | **done** | `scripts/analyze-graduation.mjs` | `scripts/graduation-analyze.test.mjs` |

### S1 — what was done

* Position closing was extracted into `closeAllAtStop(stopReason)`, and the whole stop into an **idempotent**
  `finishShadow(reason)` (the `stopping` flag is set BEFORE any side effect).
* One function serves `SIGINT`, `SIGTERM` and `SHADOW_MAX_SEC`; the record reason:
  `manual stop` (SIGINT and the timer) and `shutdown` (SIGTERM).
* A position without a known price is no longer skipped: it is written with `unconfirmed: true` and the entry price
  as the exit (a missing trade is worse than an imprecise one).
* A stop summary is printed (`=== SHADOW STOP (reason) ===`, the closed/unconfirmed count, the journal path).
* Test: the WS_MOCK fixture drives a mint to 93% fill, eight variants open, `SHADOW_MAX_SEC`
  calls the same `finishShadow()` → the journal has **8 `gshadow_open` and 8 `gshadow_trade`**, all
  `manual stop`, no repeated `(variant, mint)` pair.

### S2 — what was done

* A session set `openedKeys` (`variant:mint`) was added: a pair opens at most once per
  run. This survives `mintState` eviction, which `entered` (living inside the state) cannot do.
* Eviction was rewritten: only a mint with **no open position** that is already
  opened by **all** pre-migration variants (`ACTIVE_VARIANTS`, variant I excluded — it does not trade).
  If the limit is still exceeded after pruning, memory grows and a line goes to the log (at most once a
  minute) — active records are not deleted.
* `SHADOW_MAX_MINTS` (default `20000`) — only so the test can reproduce eviction;
  the default matches the previous threshold.
* Test: a mint opens, closes on timeout, three filler mints overflow the cap, a real prune happens
  (`pruned 1 spent mint(s)`), then the same mint trades again → **there is no second
  `gshadow_open`** (8 openings instead of 16).

### S3 step 2 — what was done

* `entryPrice` now equals the curve's spot price; the `spot * (1 + slipBps/10000)` markup was removed.
  The single buy-slippage charge remains in `roundTripCosts` (visible in the per-component breakdown).
* `gshadow_open` and `gshadow_trade` carry `costsScheme` = `v3-single-slip: entry=curve spot, buy slip
  charged once in roundTripCosts` (the `SHADOW_COSTS_SCHEME` constant in `lib/pessimistic.mjs`).
* The test pins the exact numbers: a flat round trip (price did not move) → `ratio === 1`,
  `netPct === -7.63`, `slipBps === 54`, `costsScheme` starts with `v3-single-slip`.

### S4 / S5 — what was done

* `gshadow_trade` rows group by `costsScheme`; rows without the field land in the
  `legacy (no costsScheme)` group. Each group gets its own table; with >1 group an explicit
  warning is printed that the versions are mixed and **no combined table is shown**.
* In each group's header: `samples: unique mints N | candidates M | per variant: A=9 B=8 …`.
* If there are fewer than 30 unique mints: the line `WARNING: unique mints N < 30 — observations are strongly
  correlated, do not conclude` and the group verdict is marked `withheld`.
* Test: a synthetic journal with two schemes → exactly two tables, both scheme labels, the warning,
  the sample lines, `withheld`.


## 2. S3 step 1 — the numeric result: **DOUBLE**

The code check (before edits): `enter()` wrote `entryPrice = spot * (1 + slipBps/10000)` (shadow.mjs:77,
`slipBps = 50 + sizeSlippageBps(0.02) = 50 + 4 = 54`), and `closePos()` → `pessimisticRoundTrip()`
(`lib/pessimistic.mjs:26-31`) → `roundTripCosts()` (`lib/fees.mjs:36-65`) subtracted `buySlip` =
`slippageBps` from `buySol` again. So 54 bps were charged twice: once as an entry-price shift, and again as
a cost component.

A measurement on the **real execution path** (the flat fixture: the price does not move after entry, so
`exitPrice === spot`), `buySol=0.02`, pump 100+100 bps, tx = 2 × 455 000 lamports:

| Scheme | entryPrice | ratio | netPct |
|---|---|---|---|
| v2 (double count, as it was) | `spot × 1.0054` = 1.0217974836905872e-7 | **0.994629** | **−8.16 %** |
| v3-single-slip (as it became) | `spot` = 1.016309412861137e-7 | **1.000000** | **−7.63 %** |

The difference is **0.53 pp** — exactly 54 bps of notional on the buy leg. The defect itself is visible as a side effect: the price did not move,
but `entryPrice ≠ exitPrice` (the markup sat in the entry price).

A cross-check on the old real journal (`data/journal/2026-11-10.jsonl`, the trade on `4E481AX…`):
`entryPrice 3.6983235292992076e-7`, `exitPrice 3.678459846130105e-7`, `ratio 0.994629`, `netPct −5.46`
(that run's different CU settings) — the price returned to spot, but the ratio is still 0.9946.

**Result:** DOUBLE → step 2 was done (see §1): the `entryPrice` shift was removed, the accounting stayed in `roundTripCosts`,
and `costsScheme` was added to the journal. Future run numbers will shift by +0.53 pp; old rows stay
`legacy` forever and will not enter the combined table with new ones.

## 3. Changed files

`git diff --stat` (tracked files):

```
 bots/graduation-sniper/shadow.mjs   | 115 ++++++++++++++++++++++++------
 docs/architecture.md                |   5 +-
 docs/bots.md                        |  15 +++-
 docs/configuration.md               |   1 +
 lib/pessimistic.mjs                 |   8 +++
 package.json                        |   2 +-
 scripts/analyze-graduation.mjs      | 136 ++++++++++++++++++++++++------------
 scripts/graduation-analyze.test.mjs |  51 ++++++++++++++
 8 files changed, 264 insertions(+), 69 deletions(-)
```

New files (untracked):

```
scripts/mocks/ws-mock-shadow.mjs      # a fixture of 405-byte trade-v3 events with realSolReserves
scripts/shadow-finish.test.mjs        # S1
scripts/shadow-dedupe.test.mjs        # S2
scripts/shadow-slip.test.mjs          # S3 (step 1 and step 2)
SHADOW_ACT_REPORT.md                  # this report
```

Existing tests were not weakened. `scripts/graduation-analyze.test.mjs` was **extended** (the old asserts on
`gradstats` were not touched), and three new tests were added to the `npm test` chain in `package.json`.


## 4. Full check output

### 4.1 `node --check` on the changed/new files

```
OK   bots/graduation-sniper/shadow.mjs
OK   scripts/analyze-graduation.mjs
OK   lib/pessimistic.mjs
OK   scripts/mocks/ws-mock-shadow.mjs
OK   scripts/shadow-finish.test.mjs
OK   scripts/shadow-dedupe.test.mjs
OK   scripts/shadow-slip.test.mjs
OK   scripts/graduation-analyze.test.mjs
```

### 4.2 `npm test` (full output)

```

> memecoin-trading-bot@1.0.0 test
> node scripts/retry.test.mjs && node scripts/env-inline.test.mjs && node scripts/wallet-gen.test.mjs && node scripts/expired-tx.test.mjs && node scripts/paramshash.test.mjs && node scripts/ws-shutdown.test.mjs && node scripts/lab-prune.test.mjs && node scripts/tz-boundary.test.mjs && node scripts/buyix-layout.test.mjs && node scripts/rpc-timeout.test.mjs && node scripts/pumpswap.test.mjs && node scripts/fetchtx.integration.test.mjs && node scripts/session.test.mjs && node scripts/holders.test.mjs && node scripts/journal.test.mjs && node scripts/solprice.test.mjs && node scripts/research.test.mjs && node scripts/strategy.test.mjs && node scripts/replay.test.mjs && node scripts/events-latency.test.mjs && node scripts/rawcap.test.mjs && node scripts/mayhem.test.mjs && node scripts/smoke.test.mjs && node scripts/ticks.test.mjs && node scripts/curve-model.test.mjs && node scripts/ratelimit.test.mjs && node scripts/shadow.test.mjs && node scripts/shadow-finish.test.mjs && node scripts/shadow-dedupe.test.mjs && node scripts/shadow-slip.test.mjs && node scripts/shutdown.test.mjs && node scripts/instance-lock.test.mjs && node scripts/dedupe.test.mjs && node scripts/pessimistic.test.mjs && node scripts/pump-errors.test.mjs && node scripts/sell-plan.test.mjs && node scripts/fill.test.mjs && node scripts/graduation-analyze.test.mjs && node scripts/rescue-gate.test.mjs && node scripts/env-num.test.mjs && node scripts/basic-trader-cli.test.mjs && node scripts/tx-confirm-loss.test.mjs && node scripts/partial-sell.test.mjs && node scripts/exec.test.mjs && node scripts/log-events.test.mjs && node scripts/graduation-open.test.mjs && node scripts/analytics-events.test.mjs && node scripts/ws-dedup.test.mjs && node scripts/copy-filter.test.mjs && node scripts/graduation-events.test.mjs

{"forms":3,"permanentRetryable":false,"res":"ok","calls":3,"retries":2,"sleeps":[11,28]}
PASS: 3 real 429 shapes retryable, 3 timeout shapes retryable, 5xx/network retryable, 4xx permanent, retried 2x -> success
{"parserCases":9,"integration":"ok"}
PASS: inline comments stripped, quoted values and '#'-in-value preserved
Keypair saved: <TEMP>\wallet-gen-XXXX\alpha.json
Public key: MegDaWFW1q2QdLnDzX2bCv4cJ41RP8ybZJ32hfRGgRZ
Keypair saved: <TEMP>\wallet-gen-XXXX\alpha.json
Public key: 2KGTRU4rd6Ux6o1qYC7pVbjHNQLdyFpbbUfafmhkrgN8
{"created":true,"overwriteRefused":true,"forceOk":true,"namesRejected":7}
PASS: wallet generation is safe (no overwrite, no path escape, atomic write)
{"classes":2,"legacy":1,"negatives":3}
PASS: expired-tx classification matches web3.js 1.99 error classes
{"distinct":true}
PASS: paramsHash distinguishes every graduation filter
[2026-11-10 14:46:10 MSK] [INFO] [ws] connected
[2026-11-10 14:46:10 MSK] [WARN] [ws] disconnected, reconnecting in 14ms (attempt 1)
[2026-11-10 14:46:10 MSK] [INFO] [ws] connected
[2026-11-10 14:46:10 MSK] [WARN] [ws] disconnected, reconnecting in 17ms (attempt 1)
[2026-11-10 14:46:10 MSK] [INFO] [ws] connected
[2026-11-10 14:46:10 MSK] [WARN] [ws] disconnected, reconnecting in 12ms (attempt 1)
[2026-11-10 14:46:10 MSK] [INFO] [ws] connected
[2026-11-10 14:46:10 MSK] [WARN] [ws] disconnected, reconnecting in 13ms (attempt 1)
{"reconnectedTo":5,"closedAt":4}
PASS: ws reconnects on drop, close() cancels pending reconnects (no zombie sockets)
{"stayedOpen":true,"exitedOnReturn":true}
PASS: lab positions survive a missing price and exit when it returns
{"rollover":"ok"}
PASS: MSK day/hour/weekday keys are zone-correct across midnight
node.exe : bigint: Failed to load bindings, pure JS will be used (try npm run rebuild?)
line:1 char:1
+ & "<NODE_DIR>/node.exe" "<APPDATA> ...
+ ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
    + CategoryInfo          : NotSpecified: (bigint: Failed ...m run rebuild?):String) [], RemoteException
    + FullyQualifiedErrorId : NativeCommandError
 
{"dataLen":26,"keys":17,"discriminator":"66063d1201daebea"}
PASS: buy instruction byte layout pinned (no transaction built or sent)
PASS: hung RPC cut after 4005ms, 2 retr(y/ies) counted, Error
bigint: Failed to load bindings, pure JS will be used (try npm run rebuild?)
{"groups":["US517G5965aydkZ46HS38QLi7UQiSojurfbQfKCELFx:MINT_A","cGfHiC6Kgg3FpFZvgwGcswsCRtp4aBP2fzuXRQPizuN:MINT_A","cGfHiC6Kgg3FpFZvgwGcswsCRtp4aBP2fzuXRQPizuN:MINT_B"],"unresolvedNull":true,"globalConfigOk":true}
PASS: multihop grouped by user+mint (not mixed); unresolved -> null; global config + fee recipient per IDL
bigint: Failed to load bindings, pure JS will be used (try npm run rebuild?)
{"trades":4,"groups":["4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi:k7FaK87WHGVXzkaoHb7CdVPgkKDQhZ29VLDeBVbDfYn","4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi:p2Yicb86aZig616Eav2VWG9vuXR5mEqhtzshZYBxzsV","8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR:k7FaK87WHGVXzkaoHb7CdVPgkKDQhZ29VLDeBVbDfYn","4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi:null"],"pswapUnresolved":1}
PASS: multihop events grouped by user+mint (not mixed); unresolved counted
[2026-11-10 14:46:18 MSK] [INFO] ================================================================
[2026-11-10 14:46:18 MSK] [INFO] SESSION SUMMARY — TEST
[2026-11-10 14:46:18 MSK] [INFO] ================================================================
[2026-11-10 14:46:18 MSK] [INFO]   mode             : LIVE
[2026-11-10 14:46:18 MSK] [INFO]   stopped          : MAX_CONSEC_LOSSES hit
[2026-11-10 14:46:18 MSK] [INFO]   duration         : 0s
[2026-11-10 14:46:18 MSK] [INFO]   buys / sells     : 2 / 2
[2026-11-10 14:46:18 MSK] [INFO]   spent            : 0.100000 SOL
[2026-11-10 14:46:18 MSK] [INFO]   received         : 0.090000 SOL
[2026-11-10 14:46:18 MSK] [INFO]   NET result       : -0.010000 SOL  (-10.00% of spent)
[2026-11-10 14:46:18 MSK] [INFO]   costs            : 0.000000 SOL  (pump 1%+1%, slippage, priority fee)
[2026-11-10 14:46:18 MSK] [INFO]   NET after costs  : -0.010000 SOL
[2026-11-10 14:46:18 MSK] [INFO]   closed trades    : 1W / 1L   best +0.010000 SOL  worst -0.020000 SOL
[2026-11-10 14:46:18 MSK] [INFO]   open at stop     : 1 position(s)
[2026-11-10 14:46:18 MSK] [INFO]   no exit recorded : 1: mint: no tokens in wallet
[2026-11-10 14:46:18 MSK] [INFO]   wallet           : 1.000000 -> 0.990000 SOL  (delta -0.010000 SOL)
[2026-11-10 14:46:18 MSK] [INFO]   note             : spent/received are gross — network + priority fees not deducted
[2026-11-10 14:46:18 MSK] [INFO] ================================================================
[2026-11-10 14:46:18 MSK] [INFO] ================================================================
[2026-11-10 14:46:18 MSK] [INFO] SESSION SUMMARY — TEST2
[2026-11-10 14:46:18 MSK] [INFO] ================================================================
[2026-11-10 14:46:18 MSK] [INFO]   mode              : DRY RUN (simulated, nothing was sent on-chain)
[2026-11-10 14:46:18 MSK] [INFO]   stopped           : stopped
[2026-11-10 14:46:18 MSK] [INFO]   duration          : 0s
[2026-11-10 14:46:18 MSK] [INFO]   buys / sells      : 2 / 1
[2026-11-10 14:46:18 MSK] [INFO]   spent             : 0.040000 SOL
[2026-11-10 14:46:18 MSK] [INFO]   in open positions : 0.020000 SOL (1 pos, excluded from NET)
[2026-11-10 14:46:18 MSK] [INFO]   received          : 0.021000 SOL
[2026-11-10 14:46:18 MSK] [INFO]   NET result        : +0.001000 SOL  (+5.00% of spent)
[2026-11-10 14:46:18 MSK] [INFO]   costs             : 0.000000 SOL  (pump 1%+1%, slippage, priority fee)
[2026-11-10 14:46:18 MSK] [INFO]   NET after costs   : +0.001000 SOL
[2026-11-10 14:46:18 MSK] [INFO]   closed trades     : 1W / 0L   best +0.001000 SOL  worst 0.000000 SOL
[2026-11-10 14:46:18 MSK] [INFO]   open at stop      : 1 position(s)
[2026-11-10 14:46:18 MSK] [INFO]   worst case        : -0.019000 SOL  (if the 1 open position(s) end at 0)
[2026-11-10 14:46:18 MSK] [INFO]   wallet            : unchanged (dry run)
[2026-11-10 14:46:18 MSK] [INFO]   note              : spent/received are gross — network + priority fees not deducted
[2026-11-10 14:46:18 MSK] [INFO] ================================================================
[2026-11-10 14:46:18 MSK] [INFO] ================================================================
[2026-11-10 14:46:18 MSK] [INFO] SESSION SUMMARY — COSTS
[2026-11-10 14:46:18 MSK] [INFO] ================================================================
[2026-11-10 14:46:18 MSK] [INFO]   mode            : LIVE
[2026-11-10 14:46:18 MSK] [INFO]   stopped         : test
[2026-11-10 14:46:18 MSK] [INFO]   duration        : 0s
[2026-11-10 14:46:18 MSK] [INFO]   buys / sells    : 1 / 1
[2026-11-10 14:46:18 MSK] [INFO]   spent           : 0.050000 SOL
[2026-11-10 14:46:18 MSK] [INFO]   received        : 0.055000 SOL
[2026-11-10 14:46:18 MSK] [INFO]   NET result      : +0.005000 SOL  (+10.00% of spent)
[2026-11-10 14:46:18 MSK] [INFO]   costs           : 0.001700 SOL  (pump 1%+1%, slippage, priority fee)
[2026-11-10 14:46:18 MSK] [INFO]   NET after costs : +0.003300 SOL
[2026-11-10 14:46:18 MSK] [INFO]   closed trades   : 1W / 0L   best +0.005000 SOL  worst 0.000000 SOL
[2026-11-10 14:46:18 MSK] [INFO]   open at stop    : 0 position(s)
[2026-11-10 14:46:18 MSK] [INFO]   wallet          : 1.000000 -> 1.003300 SOL  (delta +0.003300 SOL)
[2026-11-10 14:46:18 MSK] [INFO]   note            : spent/received are gross — network + priority fees not deducted
[2026-11-10 14:46:18 MSK] [INFO] ================================================================
[2026-11-10 14:46:18 MSK] [INFO] ================================================================
[2026-11-10 14:46:18 MSK] [INFO] SESSION SUMMARY — PARTIAL
[2026-11-10 14:46:18 MSK] [INFO] ================================================================
[2026-11-10 14:46:18 MSK] [INFO]   mode              : LIVE
[2026-11-10 14:46:18 MSK] [INFO]   stopped           : stopped
[2026-11-10 14:46:18 MSK] [INFO]   duration          : 0s
[2026-11-10 14:46:18 MSK] [INFO]   buys / sells      : 1 / 1
[2026-11-10 14:46:18 MSK] [INFO]   spent             : 0.100000 SOL
[2026-11-10 14:46:18 MSK] [INFO]   in open positions : 0.050000 SOL (1 pos, excluded from NET)
[2026-11-10 14:46:18 MSK] [INFO]   received          : 0.050000 SOL
[2026-11-10 14:46:18 MSK] [INFO]   NET result        : 0.000000 SOL  (+0.00% of spent)
[2026-11-10 14:46:18 MSK] [INFO]   costs             : 0.000000 SOL  (pump 1%+1%, slippage, priority fee)
[2026-11-10 14:46:18 MSK] [INFO]   NET after costs   : 0.000000 SOL
[2026-11-10 14:46:18 MSK] [INFO]   closed trades     : 0W / 0L
[2026-11-10 14:46:18 MSK] [INFO]   open at stop      : 1 position(s)
[2026-11-10 14:46:18 MSK] [INFO]   worst case        : -0.050000 SOL  (if the 1 open position(s) end at 0)
[2026-11-10 14:46:18 MSK] [INFO]   note              : spent/received are gross — network + priority fees not deducted
[2026-11-10 14:46:18 MSK] [INFO] ================================================================
{"netSol":-0.01,"spent":0.1,"received":0.09}
PASS: limits are terminal (bot exits + prints totals); oversized trade is not; ledger net is exact
{"dropped":[{"mint":"MINT_SLOW","holders":1,"holdersAtReady":null,"maxHolders":1,"ready":false,"blocked":null,"waitedMs":2500,"features":{"mint":"MINT_SLOW","creator":null,"createSlot":null,"createTs":1000,"holders":1,"maxHolders":1,"buySlots":1,"uniqueBuyers":1,"msToReady":null,"holdersAtReady":null,"blocked":null,"topHolderShare":1}}],"size":0}
PASS: holder gate counts distinct positive wallets, ignores same-wallet repeats, expires slow mints
{"netSol":0.008,"tooEarly":1,"missed":6}
PASS: journal writes/reads, summary flags early exits (missed 6x) and ignores broken lines
{"cases":8,"sample":"$0.00532"}
PASS: dollar formatting keeps micro-cap digits and converts SOL/token -> USD
{"tokensForBuy":707712909480}
PASS: holder drop bug fixed (ready+blocked reported), bundles rejected, curve anomalies refused, costs applied
{"variants":["A","B","C","D","E","F40","F50","F60"]}
PASS: A-E variants behave (bundle rejected, time-stop, partial+trailing, creator-sell, SL priority)
PASS: bootstrap CI, 70/30 split, strict verdict (edge only with >=300 hold-out trades and CI>0), CLI runs
PASS: parser layout verified on fixtures, latency defers fills, slippage monotone, freeze judges only post-freeze trades
[2026-11-10 14:46:20 MSK] [INFO] [raw] rotated 2026-11-08-10.jsonl.gz (0.0 KB) -> 2026-11-08-11.jsonl.gz
[2026-11-10 14:46:20 MSK] [INFO] [raw] resuming 2026-11-08-11.jsonl.gz (0.00 MB on disk) — appending
{"files":2,"records":3}
PASS: raw capture rotates hourly and replays offline; curve identity accepts a snapshot without neighbours
[2026-11-10 14:46:21 MSK] [INFO] [raw] rotated 2026-11-08-10.jsonl.gz (0.0 KB) -> 2026-11-08-11.jsonl.gz
[2026-11-10 14:46:21 MSK] [INFO] [raw] rotated 2026-11-08-11.jsonl.gz (0.0 KB) -> 2026-11-08-12.jsonl.gz
[2026-11-10 14:46:21 MSK] [INFO] [raw] pruned 2026-11-08-10.jsonl.gz (0.0 MB) to stay under the 0.00 GB cap
[2026-11-10 14:46:21 MSK] [INFO] [raw] pruned 2026-11-08-11.jsonl.gz (0.0 MB) to stay under the 0.00 GB cap
[2026-11-10 14:46:21 MSK] [INFO] [raw] pruned 2026-11-08-12.jsonl.gz (0.0 MB) to stay under the 0.00 GB cap
{"mayhemProgram":"MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e","flagOffset":81}
PASS: Mayhem flags (trade + account), create-v2 parser, curve rebuild and capture pruning behave
{"exitCode":0,"journalTrades":2,"rejects":0,"summaryBuys":2,"summaryClosed":2,"openAtStop":0}
PASS: real sniper handler survived a synthetic create/buy/sell stream (incl. Mayhem CPI), opened and closed positions, journal == summary
{"sessionId":"sniper-2026-11-10T11-46-44-714-71f071","paramsHash":"015abd7f5cc5"}
PASS: run metadata (sessionId/paramsHash/gitSha) and the tick log (write, rotate, drain) behave
bigint: Failed to load bindings, pure JS will be used (try npm run rebuild?)
PASS: launch price, checkCurve floors/ceilings, TP/SL triggers, costs, slippage and premium behave
{"calls":10,"retries429":9,"degraded":true}
PASS: rate limiter orders by priority, 429s are counted, degraded sessions are excluded
PASS: shadow V0-V7 entry filters + V4/V5 tick replay + skip/no-data stats
{"exit":0,"opens":8,"trades":8,"reasons":["manual stop"]}
PASS: the shadow stop journals every open position exactly once (no trade lost at Ctrl+C)
{"exit":0,"opens":8,"trades":8,"capLine":"mintState cap 2: pruned 1 spent mint(s), 2 held"}
PASS: an evicted mint cannot be opened a second time (session-wide variant+mint dedupe)
{"ratio":1,"entryPrice":1.016309412861137e-7,"exitPrice":1.016309412861137e-7,"netPct":-7.63,"slipBps":54,"costsScheme":"v3-single-slip: entry=curve spot, buy slip charged once in roundTripCosts"}
PASS: buy slippage is charged once (ratio 1 on a flat round trip, netPct -7.63%)
{"code":0,"elapsedMs":6468,"manualCloses":3}
PASS: stop closes open positions, prints summary before drain, writes session_summary (idempotent)
PASS: instance lock refuses a second live instance, ignores stale locks, replaces garbage
PASS: dedupeTrades removes cross-process/legacy duplicates and reports per-gitSha counts
PASS: pessimistic model (delay, size slippage, two modes) behaves
bigint: Failed to load bindings, pure JS will be used (try npm run rebuild?)
{"ratio":0.9801,"drainedOut":0.050912215,"drainedRSol":0.000786439}
PASS: pump error codes are human-readable, survive wrapper layers, and rSol<out is detected before sending
bigint: Failed to load bindings, pure JS will be used (try npm run rebuild?)
{"fullNetSol":0.050912215,"rSol":0.000786439,"parts":3,"firstPartTokens":3456.717057,"restTokens":232010.496955}
PASS: full-balance sells are split so every part fits realSolReserves (6024 guard)
{"rSolSol":41.717,"realFill":49.1,"oldFill":84.4}
PASS: fill is computed from real reserves; the virtual formula is provably wrong
{"pf":1,"maxDD":15,"ciSeed7":{"lo":-0.35,"hi":0.3}}
PASS: shadow stats (PF, maxDD, bootstrap CI, summarize) behave
PASS: rescue-sell gate — --dry-run never sends, --live requires LIVE_CONFIRM
PASS: numeric env validated loudly (watcher COPY_MAX_POSITIONS, rescue SELL_SLIPPAGE_BPS)
PASS: basic-trader rejects invalid sell percentages before any RPC
tx sent: 5111111111111111111111111111111111111111111111111111111111111111111111111111111111111111
PASS: confirm-failure carries the signature and readExecution resolves the landed fill
PASS: splitEntryForSell returns the sold share and the remaining entry
PASS: readExecution resolves fills from tx meta and reports found:false on meta lag
PASS: parseLogEvents reads direction from the byte and emits create events from the payload creator
PASS: canEnterMint refuses in-flight and attempted mints (duplicate-buy guard)
PASS: topBuyers counts buys only (sells do not inflate buy volume)
[2026-11-10 14:47:42 MSK] [INFO] [ws] connected
[2026-11-10 14:47:42 MSK] [INFO] [ws] connected
PASS: WS dedup is per-subscription (replays dropped, cross-sub preserved)
{"copyBuyCount":1}
PASS: copy-trader filters out foreign wallets' trades in a tx mentioning the target
{"sawFill95":true}
PASS: graduation processes every buy event in a tx (no early break on the first)
```

## 5. What is not verified and why

1. **The `unconfirmed: true` branch on stop** is not reproduced in integration: a position always has
   a known price, and a mint with an open position is by construction (S2) not evicted, so no price
   is unreachable in practice. The branch is defensive, checked by code reading only.
2. **Delivery of SIGINT/SIGTERM to the process itself** is not tested: on Windows `child.kill()` kills the process,
   without invoking the handler (the same reason as in `scripts/shutdown.test.mjs`). The test drives the **same**
   `finishShadow()` via `SHADOW_MAX_SEC`; the signal handlers are one-line calls.
3. **A repeated signal during socket close** is not reproduced end-to-end (see item 2). The guarantee is the order
   of operations in `finishShadow` (the `stopping` flag before any writes) + the one-record-per
   (variant, mint)».
4. **A new sample of 30+ independent mints per variant** is unreachable in a hermetic test: you need a long
   live run. The tests check accounting and arithmetic, not the strategy.
5. **The profitability numbers after the S3 edit** were not obtained (and should not have been): the old journal stays in the
   `legacy` scheme, a new run is a separate epoch. Recomputing the old 66 trades under v3 is partly possible (in
   `gshadow_open` the `spot` is kept), but that is a separate task and was out of scope.

## 6. Decisions taken autonomously (conservative)

1. **`COSTS_SCHEME` in `lib/fees.mjs` was not bumped.** The file's own rule is to bump when the arithmetic below
   (fees/tx/slippage) changes, and it did not; meanwhile `splitByScheme()` and `scripts/analyze-journal.mjs`
   recognize the epoch by the `v2` prefix, so a global bump would reclassify the trades of **all
   other bots** into legacy. Instead a separate constant
   `SHADOW_COSTS_SCHEME = "v3-single-slip: …"` in `lib/pessimistic.mjs` (where the model lives) was introduced, and it is written
   only into `gshadow_*` rows. The epochs are separated, other bots untouched.
2. **`SHADOW_MAX_SEC` now closes positions as `manual stop`** (previously `timeout` / `no_data`) — a direct
   consequence of the requirement that SIGTERM and `SHADOW_MAX_SEC` behave the same. A side
   effect: in the reports of timer-stopped runs, such trades no longer land in the `timeout` share.
3. **A new env `SHADOW_MAX_MINTS` (default `20000`)** — otherwise eviction cannot be tested. The value
   defaults to the previous threshold, the default behaviour does not change.
4. **A new mock `scripts/mocks/ws-mock-shadow.mjs`** instead of `ws-mock.mjs`: the latter does not fill
   `realSolReserves` (offset 113), so fill is always 0 and no mint becomes a candidate.
5. **Nothing was committed or pushed** — as required.

## 7. What requires a human's decision

1. **TP before migration.** The 1.3/1.5 threshold is unreachable: from entry at fill≈92% to graduation (fill=100%) the price rises
   at most ~+12%. Across the old run's 66 trades the `tp` share is 0% for all variants. This is a parameter and/or
   exit logic — I did not change it per the task's terms.
2. **The 0.02 SOL stake size.** The fixed costs (2 × 0.000455 SOL priority+base) are ≈4.6% of notional,
   so a trade flat on price gives −7.63% net. Raising the stake, changing the cost model or
   accounting for tx differently is the owner's decision.
3. **Whether a new sample is needed.** The analyzer now explicitly requires ≥30 unique mints (otherwise the verdict
   is `withheld`). The old run: 66 trades = 8 mints. A long run is needed for independent observations.
4. **Recomputing the old trades under the v3 scheme** (from `gshadow_open.spot`) — whether to do it is the human's call;
   the analyzer will no longer allow mixing epochs.
