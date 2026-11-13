# Errors and what to do

Below are the real messages from this repository's code (texts copied from
the sources, not paraphrased). If your error is not in the list, start with the
"How to read an error" section at the end.

## Quick checklist

1. `node -v` — version 22 or newer?
2. Does the `.env` file exist and is `RPC_URL` set in it?
3. Is a wallet created (`keys/default.json`)?
4. Is a second instance of the same bot already running?
5. Is the RPC working: does `npm run monitor` see new tokens?

---

## Startup errors

### `[config] ERROR: RPC_URL is required (must start with http:// or https://)...`

```
[config] ERROR: RPC_URL is required (must start with http:// or https://). Copy .env.example to .env and set RPC_URL to your own endpoint, e.g. https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
```

**Cause:** there is no `.env` file, or `RPC_URL` is empty or does not start with `http://` /
`https://`. There is deliberately no default public address in the code — so the bot does not
"pretend to work" on a placeholder.

**What to do:**

```powershell
Copy-Item .env.example .env
notepad .env      # enter your RPC_URL
```

### `[config] ERROR: --live requires LIVE_CONFIRM=yes...`

```
[config] ERROR: --live requires LIVE_CONFIRM=yes. Set it for this run only, e.g. $env:LIVE_CONFIRM="yes"; node bots/graduation-sniper/graduation.mjs --live
```

**Cause:** the `--live` flag is set, but the second switch is not. This guards against
accidentally starting real trading (for example, if the command was copied from a chat).

**What to do:**

```powershell
$env:LIVE_CONFIRM="yes"; npm run sniper -- --live     # Windows PowerShell
```

```bash
LIVE_CONFIRM=yes npm run sniper -- --live             # macOS / Linux
```

The variable lives only in the current terminal window: after it closes you need an explicit
`LIVE_CONFIRM` again.

### `Keypair not found: ...\keys\default.json`

```
Keypair not found: C:\...\keys\default.json
Generate with: node lib/wallet.mjs generate [name]
```

**Cause:** the wallet is not created yet (or `keys/default.json` was deleted).

**What to do:**

```powershell
node lib/wallet.mjs generate
node lib/wallet.mjs show
```

Reminder: if the file is lost and the wallet had money, access cannot be recovered.
Back it up in advance.

### `FATAL: another sniper instance is already running`

```
FATAL: another sniper instance is already running (PID 1234, lock data\journal\.sniper.lock). Refusing to start to avoid duplicate trades.
```

**Cause:** there can be only one bot per journal folder. The lock prevents two
instances from writing to one journal and mixing up the accounting.

**What to do:** close the first instance (Ctrl+C). If the process is already gone (for example,
after a reboot), delete `data/journal/.sniper.lock` manually — but only
after making sure the PID in the message is really not running.

### `lab.mjs is dry-run only: it never sends transactions. Remove --live.`

**Cause:** you passed `--live` to the lab. It deliberately never trades.

**What to do:** remove the flag.

### `bigint: Failed to load bindings, pure JS will be used`

**Cause:** one of the libraries has no native build for your system, and it
fell back to pure JavaScript.

**Is it dangerous:** no. This is a warning, not an error: the bot works the same, only
slightly slower on computations. Nothing to do.

### Mojibake in the console instead of readable letters

**Cause:** the Windows console codepage.

**What to do:** run `chcp 65001` before starting (switches the console to UTF-8).
This is cosmetic: it does not affect the bot.

---

## RPC: limits, delays and a silent bot

### The bot started, but nothing happens in the console

The most common cause is **RPC limits**, not a broken bot. Check in this order:

1. `npm run monitor` — are any new tokens visible at all?
2. If not — check `RPC_URL`: public endpoints usually do not serve `logsSubscribe`.
3. Check the quota in the provider's dashboard.
4. Check that a second bot is not running on the same key: two consumers on one
   key exhaust the limit quickly.

The sniper has a guard against a silent death: once a minute it prints
`HEARTBEAT: watchlist=… positions=… opening=…`. If it is there — the process is alive and just
finds no candidates. If it is not there — the problem is the network, not the logic.

### `429 Too Many Requests` / `max usage reached`

**Cause:** the quota or request rate of your plan is exhausted.

**What to do:** wait for the limit reset, upgrade the plan, change the endpoint, or
stop other programs and bots that use the same key.

### `[ws] error: ... 429`, then `reconnecting…`

**Cause:** the server rejected the WebSocket connection — the same limit.

**What to do:** this is not a crash: the client reconnects on its own with a growing pause. If
it happens constantly — change the plan or the provider.

### `Signature ... has expired: block height exceeded`

**Cause:** the node returned a stale transaction validity bound (happens on public
and overloaded nodes).

**What to do:** the code recomputes the deadline from the current block height; if the error
repeats — the RPC is lagging, change it.

### `ProgramFailedToComplete` / `exceeded CUs meter at BPF instruction`

**Cause:** too few compute units for the transaction.

**What to do:** do not lower `CU_LIMIT` below roughly 100000; `.env.example` ships a
working value. Note: the priority fee is charged on the limit, not on the actual usage,
so a huge limit "just in case" costs money.

### `[fee-state]` or errors reading the fee parameters

**Cause:** the pump.fun helper account could not be read (a temporary network error
or an RPC limit).

**What to do:** wait or change the RPC. The code retries such a request and re-checks
the parameters before a real buy.

---

## pump.fun program errors (codes)

The codes come from the official program description (IDL) and are embedded in
`lib/pump-errors.mjs`. In the log they look like: `instruction 2: 6024 Overflow (...)`.

| Code | Name | What it means | What to do |
|---|---|---|---|
| 6000 | `NotAuthorized` | the action is forbidden for the account | check which accounts are passed to the instruction |
| 6002 | `TooMuchSolRequired` | the price rose: more SOL than allowed (`max_sol_cost`) is needed | raise `BUY_SLIPPAGE_BPS` or wait |
| 6003 | `TooLittleSolReceived` | the sell returned less than the minimum | raise the sell slippage |
| 6005 | `BondingCurveComplete` | the curve is complete, liquidity moved to PumpSwap | trading on the curve is over; the PumpSwap path is **unverified** |
| 6006 | `BondingCurveNotComplete` | the curve is not complete yet | the pool action was called too early |
| 6020 / 6021 | `BuyZeroAmount` / `NotEnoughTokensToBuy` | the buy amount is zero or too small | raise the amount |
| 6022 / 6023 | `SellZeroAmount` / `NotEnoughTokensToSell` | selling zero or more than the balance | re-read the token balance |
| 6024 | `Overflow` | the curve cannot pay the requested amount | sell a smaller part (see below) |
| 6029 | `UnsortedNotUniqueFeeRecipients` | a wrong list of fee recipients | take the addresses from chain data, not from old code |
| 6042 | `BuySlippageBelowMinTokensOut` | the buy would return fewer tokens than the minimum | raise the slippage |
| 6081 | `BondingCurveAlreadyMigrated` | the curve already migrated | skip the token (the graduation bot blacklists it) |
| 6094 | `CashbackCoinNotSupported` | such coins are not supported by this code | skip the token |

### `6024 Overflow` when selling the whole balance

**Cause:** the payout exceeded the real SOL reserves on the curve. The program
overflows instead of refusing cleanly.

**What it means:** selling everything in one chunk is **physically** impossible — the curve does not hold
that much SOL. This is not a configuration error and not a reason to retry in a loop.

**What the code does:** it splits the sale into parts so each fits within 0.95 of
the real reserves, and sells one part per cycle. If even that is impossible, the position
is marked **STUCK** and lands in the session summary, and the log shows:

```
ALERT: <mint> STUCK (<venue>): <reason> — ..., use scripts/rescue-sell.mjs
```

**What a human should do:** do not hammer the sell. Check the leftovers (`npm run rescue`,
by default it only shows a plan) or wait until SOL appears on the curve.

---

## The sniper is silent although there are tokens

### The `ABOVE BAND: ... fill=98.0% > MAX_FILL=97%` line

**Cause:** the token is too close to migration — the bot deliberately does not enter the last
percent. The line is printed once per token so the silence is explained.

**What to do:** nothing. This is expected behaviour, not a failure.

### The `ALERT: entry for ... did not settle in Ns — slot released` line

**Cause:** the RPC request for a specific entry did not return in time. The slot
is released so one stuck token does not block all the following ones.

**What to do:** check the RPC (the timeout is set by `RPC_TIMEOUT_MS`, default
15 seconds). If it repeats — the node is overloaded or throttling.

### Nothing is bought and the journal only has `buy_skipped`

This is the filters working normally. The reasons vary: too few holders,
the curve is close to migration, not enough depth to exit, a token with Token-2022
extensions. Look at the `reason` field in the journal — it says which filter
fired.

---

## `npm test`: failures and a key leaking into the output

### The `env-inline` test fails and the error text shows the RPC address with `api-key`

**Cause:** the `RPC_URL` variable is exported in the shell. The test harness
(`scripts/lib/test-env.mjs`) substitutes its value only if the variable is not already set
(`process.env.RPC_URL ??= "https://example.invalid"`), so your working URL leaks
into the child process, and the check compares it with the expected `https://example.invalid`.
The error message prints the actual value in full — including the key.

**What to do:**

```powershell
Remove-Item Env:\RPC_URL   # Windows PowerShell, this session only
npm test
```

```bash
unset RPC_URL              # macOS / Linux
npm test
```

**Important:** such output is plain text. If it got into a file, a chat or a screenshot, consider
the key compromised and re-issue it in the provider's dashboard. Deleting the file does not revoke
the key.

**How to confirm everything is fine:** all 60 test files print a `PASS:` line, and the exit code of
`npm test` is `0`. The tests do not go to the network and do not require `keys/` or `.env` in the project folder.

---

## How to read an error

1. Look at the line prefix: `buy failed:`, `sell attempt 1/3 failed`,
   `sell simulation failed` — it says at which step it stopped.
2. The code number and name are decoded automatically (`6024 Overflow`), not
   shown as a raw `{Custom:6024}`.
3. The same events are in the journal (`data/journal/…jsonl`) with the structure: amount,
   balance, expected payout, real reserves, venue, error text.
4. If a position is marked STUCK — it will appear in the summary. Do not retry it
   endlessly.

## If you ask for help online

Publish **only**:

- the error text and 5–10 lines around it;
- the Node version (`node -v`) and the operating system;
- exactly what you ran (the command).

**Never** publish: `.env`, the full `RPC_URL`, `keys/`, a screenshot with the wallet
address (if you do not want to reveal it), full logs with amounts.