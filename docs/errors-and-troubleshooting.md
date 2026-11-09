# Errors and troubleshooting

## pump.fun program error codes

Codes and names are copied from the official pump.fun IDL into `lib/pump-errors.mjs` (111 entries
there; the table lists the ones a trader will actually meet). `describeTxError()` turns a raw
`{InstructionError:[ix,{Custom:n}]}` into `instruction <ix>: <code> <name>` in the logs and the journal.

| Code | Name | Meaning | What to do |
|---|---|---|---|
| 6000 | `NotAuthorized` | Account not allowed to run the instruction | Check the instruction layout / accounts |
| 6002 | `TooMuchSolRequired` | Buying the requested tokens needs more SOL than `max_sol_cost` | Price moved up. Increase `BUY_SLIPPAGE_BPS` (headroom on `max_sol_cost`) or retry later |
| 6003 | `TooLittleSolReceived` | Selling would return less than `min_quote_amount_out` | Price moved down. Raise the sell slippage (`SELL_MAX_SLIPPAGE`) |
| 6005 | `BondingCurveComplete` | The curve completed and liquidity migrated | Not tradable on the curve any more. PumpSwap route (UNVERIFIED) or skip the mint |
| 6006 | `BondingCurveNotComplete` | The curve is not complete | A pool-only action was attempted too early |
| 6020 / 6021 | `BuyZeroAmount` / `NotEnoughTokensToBuy` | Buy amount is zero or too small | Increase the buy size |
| 6022 / 6023 | `SellZeroAmount` / `NotEnoughTokensToSell` | Sell amount is zero or above the balance | Re-read the raw token balance; sell a part |
| 6024 | `Overflow` | Arithmetic overflow — typical when the curve cannot pay the requested sell | The payout exceeds the curve's real SOL reserves; sell a smaller part (see below) |
| 6029 | `UnsortedNotUniqueFeeRecipients` | Fee recipients list is invalid | Use an address from the on-chain config, not a stale hardcoded one |
| 6042 | `BuySlippageBelowMinTokensOut` | The buy would return fewer tokens than `min_tokens_out` | Raise the slippage tolerance or the token amount |
| 6081 | `BondingCurveAlreadyMigrated` | The curve already migrated | Skip the mint (the graduation bot blacklists it) |
| 6094 | `CashbackCoinNotSupported` | v3 trades do not support cashback coins | The v2 instructions are needed — not implemented here |
| 6099–6107 | quote-chain errors | Nested quote-mint curves | The repository assumes SOL-quoted curves; skip these mints |

## RPC and runtime problems

| Symptom | Likely cause | What to do |
|---|---|---|
| `429 Too Many Requests`, `max usage reached` | The RPC plan's quota or rate limit is exhausted (free tiers are small) | Wait for the reset window, use a private endpoint, or stop other consumers — a dry-run bot and a live bot on one key collide |
| `[ws] error: Unexpected server response: 429` then `reconnecting in …` | The WebSocket handshake was rejected for the same reason | The client retries with exponential backoff and does **not** crash; fix the RPC quota |
| Subscription acknowledged but no events arrive | Public endpoints often throttle `logsSubscribe` | Use a private endpoint; verify with `npm run monitor` |
| `Signature … has expired: block height exceeded` | The node returned a stale `lastValidBlockHeight` (public nodes can report a value millions of blocks behind) | The code recomputes the expiry from `getBlockHeight() + 150`; if it persists the RPC is lagging — change it |
| `ProgramFailedToComplete` / `ComputationalBudgetExceeded` / `exceeded CUs meter at BPF instruction` | The compute-unit limit was too low for a pump buy with Token-2022 `TransferChecked` + `track_volume` | `CU_LIMIT` default is `300000`; measured buys need ~70k–78k CU. Do not go below ~100k. The priority fee is charged on the **limit** |
| Sell fails with `6024 Overflow` **when selling the whole balance** | The quote (0.05 SOL in the recorded case) exceeded the curve's real SOL reserves (0.000786 SOL); the program overflows instead of failing cleanly | **Observed, cause confirmed, fixed in code** (commit `43cdfa8`): `lib/sell-plan.mjs` splits the sale so each part fits `0.95 × realSolReserves`; the bot sells one part per cycle. If a part still cannot be paid, the position is marked STUCK and `npm run rescue` reports it |
| `buy failed: … 6002` on every attempt | `max_sol_cost` equalled the intended amount, leaving no room for the curve to move | Fixed: `buyIx` accepts `maxSolCost` and the bots pass `BUY_SLIPPAGE_BPS` headroom |
| PnL looks insane (−99% in one second, or prices 10× apart at the same fill) | The price came from a **virtual** reserve ratio, and Mayhem-mode curves do not follow the normal invariant | Fixed: fill is computed from real reserves (`gradFillPct`), entry price comes from the transaction meta, TP/SL use the sell quote |
| `Custom 6005` / `6081` and the same mint keeps reappearing | The bot retried a curve that is already complete | The graduation bot blacklists such mints in `data/journal/graduation-blacklist.json` |
| `[config] ERROR: RPC_URL is required` | No `.env`, or an empty/invalid `RPC_URL` | Copy `.env.example` to `.env` and set a valid URL |
| `--live requires LIVE_CONFIRM=yes` | Live mode was requested without the second switch | `$env:LIVE_CONFIRM="yes"` for that command only |
| `Keypair not found: …\keys\default.json` | No wallet has been generated | `node lib/wallet.mjs generate` |
| `FATAL: another sniper instance is already running` | The single-instance lock is held by a live PID | Stop the other process, or remove a stale lock file if the PID is dead |
| `WATCHLIST` stops at ~97% fill and nothing else is printed | Not a crash: entries above `MAX_FILL` (default `97`) are refused by design — the last 3% before migration has no room left | Expected. The current build prints `ABOVE BAND: <mint> fill=…% > MAX_FILL=97%` once per mint, so the silence is explained |
| The process is alive but enters nothing and prints nothing | A single RPC call hung forever (a throttled endpoint with no HTTP deadline); the entry was never released, and with `GRAD_MAX_POSITIONS=1` every later candidate was dropped without a log line or a journal record | Fixed: `RPC_TIMEOUT_MS` (15 s, retried like a 429), the `OPENING_STALE_SEC` watchdog (`ALERT: entry … did not settle`) and a `HEARTBEAT` line with slot/RPC counters every 60 s |
| `[fee-state] pump global account unavailable/short` | The `global` account read failed (transient RPC error or throttling) | The read is now throttled and retried like any other RPC call, and every live buy re-checks it (`ensureGlobalFeeState`) before building the transaction. If it still fails, buys fall back to the hardcoded fee recipient and the program may reject them — check `RPC_URL` / quota |
| `bigint: Failed to load bindings, pure JS will be used` | A transitive dependency has no native binding | Harmless warning; the pure-JS path is used |
| Garbled characters like `вЂ”` in the console | Windows code page | `chcp 65001` before running |

## Reading a failure

1. The console line names the step: `buy failed:`, `sell attempt 1/3 failed`, `sell simulation failed`.
2. The reason is decoded by `describeTxError`, e.g.
   `instruction 2: 6024 Overflow (arithmetic overflow …)`.
3. The journal has the same event with structured fields (`amountRaw`, `balanceRaw`, `quoteOut`,
   `realSolReserves`, `venue`, `simulationResult`, `error`). Use it to see whether the curve could pay.
4. A position that cannot be sold is marked **STUCK** and listed in the session summary. Do not retry it
   in a loop; use `npm run rescue` and, if the curve is empty, wait for liquidity or migration.

