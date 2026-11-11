# ACT REPORT — deep-audit fix implementation

Execution mode: ACT (autonomous). All tests hermetic (temp `ROOT`/`KEYS_DIR`, `RPC_MOCK`/`WS_MOCK`,
no mainnet, no `--live`). `C6-APPLY` and `M6` were **not** performed (see "Awaiting human").

## 1. Status table

| ID | Status | Files | Test |
|----|--------|-------|------|
| C1 | done | lib/events.mjs, bots/sniper/sniper.mjs, scripts/mocks/ws-mock.mjs | scripts/log-events.test.mjs (+ smoke.test.mjs) |
| C2 | done | lib/rpc.mjs, bots/sniper/sniper.mjs, bots/graduation-sniper/graduation.mjs, bots/copy-trader/watcher.mjs | scripts/tx-confirm-loss.test.mjs |
| C3 | done | scripts/rescue-sell.mjs | scripts/rescue-gate.test.mjs |
| C4 | done | lib/events.mjs, bots/sniper/sniper.mjs, bots/copy-trader/watcher.mjs, bots/graduation-sniper/graduation.mjs, bots/analytics/server.mjs | scripts/log-events.test.mjs |
| C5 | done | bots/sniper/sniper.mjs, bots/copy-trader/watcher.mjs | scripts/exec.test.mjs (live paths: code review) |
| C6 | skipped (verify script created, not run) | scripts/verify-buy-semantics.mjs (new) | awaiting-human |
| H1 | done | bots/copy-trader/watcher.mjs | scripts/copy-filter.test.mjs |
| H2 | done | bots/graduation-sniper/graduation.mjs | scripts/graduation-events.test.mjs |
| H3 | done | lib/entry-gate.mjs (new), bots/graduation-sniper/graduation.mjs | scripts/graduation-open.test.mjs |
| H4 | done | lib/session.mjs, bots/graduation-sniper/graduation.mjs, bots/copy-trader/watcher.mjs | scripts/partial-sell.test.mjs |
| H5 | done | bots/basic-trader/trade.mjs, lib/pumpfun.mjs | scripts/curve-model.test.mjs (extended) |
| H6 | done | lib/analytics-stats.mjs (new), bots/analytics/server.mjs | scripts/analytics-events.test.mjs |
| H7 | done | bots/copy-trader/watcher.mjs, bots/sniper/sniper.mjs, scripts/rescue-sell.mjs, lib/fees.mjs, lib/strategy.mjs | scripts/env-num.test.mjs |
| H8 | done | lib/ws.mjs | scripts/ws-dedup.test.mjs |
| H9 | done | lib/session.mjs, bots/copy-trader/watcher.mjs (graduation already correct) | scripts/session.test.mjs (extended) |
| M1 | done | lib/pumpfun.mjs, bots/graduation-sniper/graduation.mjs | scripts/buyix-layout.test.mjs (extended) |
| M2 | done | bots/sniper/sniper.mjs | scripts/shutdown.test.mjs (still green; counts only actual closes) |
| M3 | done (comment only) | lib/curve.mjs | scripts/curve-model.test.mjs (pins vSolMin unchanged) |
| M4 | done | bots/basic-trader/trade.mjs | scripts/basic-trader-cli.test.mjs |
| M5 | done | scripts/rescue-sell.mjs | scripts/sell-plan.test.mjs (extended) |
| M6 | skipped (awaiting approval) | — | — |
| M7 | done | lib/time.mjs | scripts/tz-boundary.test.mjs (extended) |

## 2. Changed files

23 modified + 18 new (517 insertions, 329 deletions per `git diff --stat`).

- Modified: BUGS_VERIFICATION.md, bots/{analytics/server, basic-trader/trade, copy-trader/watcher, graduation-sniper/graduation, sniper/sniper}.mjs, lib/{curve, events, fees, pumpfun, rpc, session, strategy, time, ws}.mjs, package.json, scripts/{buyix-layout, curve-model, sell-plan, session, tz-boundary}.test.mjs, scripts/mocks/ws-mock.mjs, scripts/rescue-sell.mjs.
- New: lib/analytics-stats.mjs, lib/entry-gate.mjs, scripts/{analytics-events, basic-trader-cli, copy-filter, env-num, exec, graduation-events, graduation-open, log-events, partial-sell, rescue-gate, tx-confirm-loss, ws-dedup}.test.mjs, scripts/mocks/{confirm-fail, copy-ws-mock, exec, grad-ws-mock, rescue-rpc-mock}.mjs, scripts/verify-buy-semantics.mjs.

## 3. Test results

- `npm test` → **exit 0, 47 PASS, 0 FAIL** (was 35; +12 new tests).
- `node --check` on every changed/new `.mjs` → **0 syntax failures**.
- Only stderr noise is the pre-existing harmless `bigint: Failed to load bindings, pure JS will be used` warning.

## 4. Not verified

- LIVE transaction paths (sniper/watcher/graduation buy/sell reconcile + C5 chain-meta accounting): exercised only against `RPC_MOCK`; the live branches are code-reviewed, not run (no `--live`, per rules).
- C6-VERIFY (pump.fun `buy(amount, max_sol_cost)` semantics): `scripts/verify-buy-semantics.mjs` was created but **not run** — it needs a real mainnet RPC (read-only `simulateTransaction`) and there is no local RPC mock that simulates the pump program; running it would hit the network, which the rules forbid.
- readExecution ATA-rent edge (BUG 09): left as-is (only a note), not deducted.

## 5. Awaiting human

1. **M6** — bounded sell retries for sniper/copy-trader + STUCK marking: NOT implemented (explicitly deferred).
2. **C6-APPLY** — after the human runs `scripts/verify-buy-semantics.mjs` with their RPC_URL and confirms case (B) returns Custom 6002: then update the `buyIx` comment / caller `maxSolCost` padding / BUGS_VERIFICATION #08. The buy-instruction bytes were left frozen.
3. **BUG 09** (ATA rent in readExecution SOL deltas) — only documented, no deduction.

## 6. Decisions taken without confirmation (all conservative)

1. **C6-VERIFY skipped at runtime** — no local RPC mock can produce a meaningful mainnet `simulateTransaction`; running it would send network reads to mainnet. Created the script instead and recorded it as "not run".
2. **`ws-dedup.test.mjs` as a new file** instead of extending `ws-shutdown.test.mjs` — avoids swapping `WS_MOCK` mid-test (it is read once at import).
3. **Extracted pure helpers** for testability: `lib/entry-gate.mjs` (`canEnterMint`, H3) and `lib/analytics-stats.mjs` (`applyEvent`, H6). Minimal, directly in service of the plan's tests.
4. **`ws-mock.mjs` fixture updated** — the "create" notification now emits a real CreateV2 payload (previously a trade payload), because C1 changed create detection to the CreateV2 payload. This is a fixture update required by the planned behavior change, not a weakened assert; `smoke.test.mjs` still passes with the same assertions.
5. **lib/events.mjs now imports `BUY_INSTRUCTIONS`/`SELL_INSTRUCTIONS`** from `lib/constants.mjs` (it was dependency-free before). No circular import.
6. **C2 sell reconciliation** — graduation uses the same proportional-entry split as H4; sniper and copy-trader close the position when the chain shows the tokens left (conservative, avoids re-selling).
7. **M1** — `buyIx` default `maxSolCost` now uses `solToLamports` (round); graduation's padded cap also switched to `solToLamports`. No change to instruction bytes.
