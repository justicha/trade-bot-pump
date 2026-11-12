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

`bots/graduation-sniper/shadow.mjs` is the graduation counterpart of the lab. Ten variants
(`A` baseline, `B` holders 7, `C` holders 15, `D` max fill 95, `E` max fill 97, `F` exit check,
`G` B+E+F, `H` TP 1.3, `I` enter after migration, `J` the live config) share one candidate stream and one virtual wallet
each.

`scripts/analyze-graduation.mjs` prints, per variant: `n`, win %, mean/median net %, profit factor,
max drawdown, the TP/SL/timeout/STUCK mix and a 95% bootstrap CI (only for n ≥ 30). Each variant's
series is split in half by time: the first half is the fit window, the second is the hold-out.
Acceptance rule: the lower CI bound on the **second** half must be above zero, in the pessimistic
model. Variant `I` reports "no data" because the trade stream carries no AMM price.

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

The startup line must read `candidate threshold 75% | J live config: fill 75-90%, holders>=5,
TP 1.5, SL 0.7, hold 300s`. If it shows `92-97 / 7`, the `GRAD_*` variables were not read.

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
If the analyzer prints "положительного ожидания нет ни в одном варианте" (no positive expectancy in any
variant), that is a valid and useful outcome.
