# BUGS_VERIFICATION — deep audit report (trade-bot-pump)

Verification performed against the actual source code (not assumptions). Line numbers refer to the
state of the code at the time of the audit. Statuses are updated as fixes land; a problem is marked
FIXED only when a confirming test exists (or, for removals, a repository-wide reference check).

## Verdicts for the 29 reported issues

| # | Issue | Verdict | Final status |
|---|-------|---------|--------------|
| 01 | `.env` inline comments become part of values (`KEY=92 # c` → NaN) | CONFIRMED | FIXED — `lib/config.mjs` strips inline comments (quoted values preserved); bots validate numeric env via `numOr` (loud error with the variable name). Test: `scripts/env-inline.test.mjs` |
| 02 | `InstructionError` structure lost when wrapping tx errors | CONFIRMED | FIXED — wrappers keep the raw payload (`e.err`); `parseInstructionError` decodes stringified payloads from messages. Test: `scripts/pump-errors.test.mjs` |
| 03 | `--live --dry-run` conflict in rescue-sell | CONFIRMED (was wrongly "FALSE POSITIVE") | FIXED — rescue-sell now reads LIVE/DRY_RUN from lib/config.mjs (no local `args.includes("--live")`), so `--live --dry-run` never sends and the banner says DRY RUN. Test: `scripts/rescue-gate.test.mjs` |
| 04 | Position recorded as sold at stop without a confirmed sale (sniper) | PARTIALLY CONFIRMED | FIXED — in LIVE the unconfirmed branch now writes `type:"stuck"` + `session.drop` instead of fake PnL. DRY-RUN branch unchanged (covered by `shutdown.test.mjs`); the LIVE branch is code-reviewed (cannot be automated without a live environment) |
| 05 | Partial sell double-counts the full entry cost in PnL (graduation) | CONFIRMED | DEFERRED — out of the approved ACT scope |
| 06 | Positions deleted before the final report (`openPositions` always 0) | PARTIALLY CONFIRMED | FIXED — both bots snapshot `openAtStop` before deletion and report real counts/spend. Test: `scripts/shutdown.test.mjs` |
| 07 | `wallet.mjs generate` overwrites keys without asking; name escapes `keys/` | CONFIRMED | FIXED — refuses to overwrite without `--force`, name alphabet `[A-Za-z0-9_-]+`, atomic temp+rename write. Test: `scripts/wallet-gen.test.mjs` |
| 08 | `buyIx` writes a token count into the SOL `amount` field | NEEDS VERIFICATION | awaiting C6-VERIFY — the official IDL says `amount` = token amount (not SOL), which would make the current layout correct and the old "inert slippage guard" conclusion wrong. Re-verify with `scripts/verify-buy-semantics.mjs` (read-only simulations) before any instruction change. Layout still pinned by `scripts/buyix-layout.test.mjs` |
| 09 | ATA rent mixed into `readExecution` SOL deltas | CONFIRMED | DEFERRED — out of the approved ACT scope |
| 10 | Sniper retries a failing sell every 2 s forever; copy-trader never retries | CONFIRMED | DEFERRED — out of the approved ACT scope |
| 11 | Copy-trader copies foreign trades from any tx mentioning the target | CONFIRMED | DEFERRED — out of the approved ACT scope |
| 12 | `logger` (an object) called as a function in trade.mjs | CONFIRMED | FIXED — `logger.warn(...)`; verified by grep (no `logger(` function-calls remain) |
| 13 | PumpSwap cashback pools: v1 `sell` has no buyback accounts | NEEDS TEST | DOCUMENTED — `lib/pumpswap.mjs` + `docs/bots.md`; instruction code frozen; still gated behind `LIVE_CONFIRM_AMM=yes` |
| 14 | Research lab: pruned mint strands an open paper position | CONFIRMED | FIXED — mint kept while `lab.openMints()` is non-empty; timers cleared on exit. Test: `scripts/lab-prune.test.mjs` |
| 15 | Direct `ws` import without a declared dependency | CONFIRMED | FIXED — `ws@7.5.13` added to `dependencies` (package.json + lock). Check: `npm ls ws` + import smoke |
| 16 | retry.mjs comment promises 5xx/network, implementation lacks them | CONFIRMED | FIXED — `isRetryable` handles HTTP 5xx + network failures (bounded tries unchanged). Test: `scripts/retry.test.mjs` |
| 17 | `e?.expired` never matches web3's expiry error classes | CONFIRMED | FIXED — `isExpiredTxError` checks the web3 1.99 `.name` classes (+ legacy `.expired`). Test: `scripts/expired-tx.test.mjs` |
| 18 | paramsHash missing MAX_FILL_PCT / MIN_HOLDERS / MAX_TOP10_SHARE | CONFIRMED | FIXED — all three added. Test: `scripts/paramshash.test.mjs` |
| 19 | Floating-point drift in guard session cap | NOT CONFIRMED | not changed |
| 20 | rescue-sell uses virtual-reserve fill + duplicates AMM helpers | CONFIRMED | DEFERRED — out of the approved ACT scope |
| 21 | Analytics `topBuyers` includes sells | CONFIRMED (was wrongly "FALSE POSITIVE") | FIXED — the topBuyers block now sits inside `if (ev.isBuy)`. Test: `scripts/analytics-events.test.mjs` |
| 22 | Lab variants E and F50 are identical | CONFIRMED (cosmetic) | DOCUMENTED — comment added in `lib/strategy.mjs` (no parameter changes) |
| 23 | `delayMs` documented as affecting PnL but it does not | PARTIALLY CONFIRMED | FIXED — comment corrected in `lib/pessimistic.mjs` (no PnL changes) |
| 24 | buyHour/buyWeekday in Brussels + UTC journal name in log | CONFIRMED | FIXED — both are MSK now (`MSK_TZ`, `mskDateKey`). Test: `scripts/tz-boundary.test.mjs` |
| 25 | dedupeTrades drops a legit re-buy of the same mint in another session | CONFIRMED | DEFERRED — out of the approved ACT scope |
| 26 | WS: reconnect after close(), no ping/pong heartbeat, no SIGTERM | CONFIRMED | FIXED — `closedByUser` guard in `attempt()`, reconnect timer cleared on close, 30 s ping/pong watchdog with terminate, SIGTERM handlers in graduation/copy-trader (sniper already had one). Test: `scripts/ws-shutdown.test.mjs` |
| 27 | Defaults conflict (BUY_SOL 0.1 > MAX_TRADE_SOL 0.05 without .env) | NOT CONFIRMED | not changed (documented fail-safe) |
| 28 | CU_LIMIT 120000 sample vs 300000 code default | NOT CONFIRMED | not changed (documented, intentional) |
| 29 | `getCurveMeta` dead code | CONFIRMED | FIXED — removed (+ its private cache); verified by grep (0 references) |

## Additional findings (audit beyond the 29)

| # | Finding | Status |
|---|---------|--------|
| A1 | `openPositions/openSpentSol` always 0 in the summary (covered by B11) | FIXED |
| A2 | copy-trader: a failed `copySell` is never retried and never marked STUCK | deferred |
| A3 | watcher `recentTxs` LRU can re-copy an old tx after eviction | verified only, not changed |
| A4 | graduation `buyFailUntil` is dead logic (redundant with `attempted`) | FIXED (C5, removed) |
| A5 | sniper lacks the exit-preview gate (parity question, strategy-neutral) | deferred |
| A6 | instance-lock TOCTOU on simultaneous starts | FIXED (atomic capture + re-read check) |
| A7 | `readExecution` gives up after 4×400 ms under load | deferred (documented fallback) |
| A8 | lab status/tick timers not cleared on exit | FIXED |

## Scope decisions (approved ACT)

- Not changed: BUG 03, 19, 21, 27, 28 (FALSE POSITIVE / NOT CONFIRMED).
- Deferred (not in the approved fix list): BUG 05, 09, 10, 11, 20, 25, A2, A5, A7.
- Frozen instruction code: `buyIx`/`sellIx`/AMM (BUG 08, 13) — only documentation and an isolated
  byte-layout test, no changes to transaction building.

## Test evidence (all run locally, no wallets, no transactions)

- Full suite: `npm test` → exit 0, **35 PASS**, 0 FAIL.
- Syntax: `node --check` over **123** `.mjs` files → 0 failures.
- `package.json` / `package-lock.json` parse as valid JSON.
- `npm ls ws` → `ws@7.5.13` (now a direct dependency, deduped with the transitive copy).
- Hermetic: every test boots a temp `ROOT`/`KEYS_DIR` (no `.env`, no `keys/` required).

| Fix | Confirming test(s) |
|-----|--------------------|
| A1 / BUG 01 | `scripts/env-inline.test.mjs` |
| A2 / BUG 02 | `scripts/pump-errors.test.mjs` (extended) |
| A7 / BUG 07 | `scripts/wallet-gen.test.mjs` |
| B1 / BUG 12 | grep: no `logger(` function-call remains |
| B2 / BUG 15 | `npm ls ws` + import smoke |
| B3 / BUG 16 | `scripts/retry.test.mjs` (extended) |
| B4 / BUG 17 | `scripts/expired-tx.test.mjs` |
| B5 / BUG 18 | `scripts/paramshash.test.mjs` |
| B8 / BUG 26 | `scripts/ws-shutdown.test.mjs` |
| B9 / BUG 14 | `scripts/lab-prune.test.mjs` |
| B10+B11 / BUG 04+06 | `scripts/shutdown.test.mjs` (extended) |
| C1 / BUG 24 | `scripts/tz-boundary.test.mjs` |
| C4 / BUG 29 | grep `getCurveMeta` → no references |
| C5 / A4 | grep `buyFailUntil` / `BUY_REJECT_COOLDOWN_MS` → no references |
| A6 | `scripts/instance-lock.test.mjs` (extended with a garbage-lock case) |
| BUG 08 | `scripts/buyix-layout.test.mjs` (bytes only, no tx) |
