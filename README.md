<p align="center"><img src="docs/img/banner.svg" alt="pump-bot: deep navy banner with a teal bonding-curve line and the text pump-bot" width="100%"></p>

<h1 align="center">pump-bot</h1>

<p align="center">pump.fun on-chain bots and analytics for Solana. Dry-run first.</p>

**Research tool. Dry-run by default. No profit guarantees.**

---

## Table of contents

- [Risk notice](#risk-notice)
- [What this is / what it is not](#what-this-is--what-it-is-not)
- [Requirements and installation](#requirements-and-installation)
- [Wallet in short](#wallet-in-short)
- [Modes: DRY RUN and LIVE](#modes-dry-run-and-live)
- [Bots overview](#bots-overview)
- [Command reference](#command-reference)
- [Verification status](#verification-status)
- [Error codes quick table](#error-codes-quick-table)
- [Results and honesty](#results-and-honesty)
- [Screenshots](#screenshots)
- [Security notes](#security-notes)
- [Project structure](#project-structure)
- [Credits, license, disclaimer](#credits-license-disclaimer)

## Risk notice

- **Not financial advice.** This is source code for experiments, not a product and not a signal service.
- **Memecoin trading can lose all the funds you put in.** Prices move in seconds, liquidity can
  vanish, tokens can be unsellable and transactions can fail while still costing a fee.
- **The code may contain bugs.** Read it, test it in dry-run, and keep the limits small.
- **You are responsible** for your keys, your wallet, your local laws and any tax consequences.
- Start with **dry-run** and a **throwaway wallet** funded with an amount you can afford to lose
  completely.

## What this is / what it is not

**What it is**

- A Node.js (ESM) toolkit that talks to pump.fun on Solana: a read-only monitor and analytics
  server, several trading bots, a research lab and a set of diagnostic scripts.
- Built around one shared `lib/` layer: RPC and WebSocket clients, event parsing, curve and fee
  math, risk guards, a masking logger and a JSONL journal.
- Dry-run first: the default mode never signs or sends a transaction. Live trading needs both
  `--live` and `LIVE_CONFIRM=yes` (see [Modes](#modes-dry-run-and-live)).
- Honest about its own state: every bot and command in this repository carries a verification status.

**What it is not**

- Not a strategy with a proven edge, not a signal service, not a turnkey money machine. There are no
  published results (see [Results and honesty](#results-and-honesty)).
- Not a custody service: keys live in a local file that you create, and nothing is uploaded.
- Not a market maker, not a MEV bundle builder; it sends no Jito tips, only a priority fee.
- Not audited. There has been no third-party security review.
- Not a substitute for reading the code before you point it at real SOL.

> If a tutorial, screenshot or chat promises returns, it is not from this repository.

---

## Requirements and installation

- **Node.js `>=22`** (from `engines` in `package.json`).
- git, and a terminal (PowerShell on Windows, any POSIX shell on Linux/macOS).
- Your own Solana RPC endpoint with WebSocket support. A private endpoint is strongly recommended:
  every bot subscribes to `logsSubscribe` and a public/free endpoint will throttle or drop it.

```bash
git clone https://github.com/<you>/pump-bot.git
cd pump-bot
npm ci --ignore-scripts
cp .env.example .env      # Windows PowerShell: Copy-Item .env.example .env
```

**Why `--ignore-scripts`.** It stops npm from running lifecycle scripts of dependencies at install
time. Those scripts run arbitrary code with your user rights before you have read anything. The three
dependencies here (`@solana/web3.js`, `@solana/spl-token`, `bs58`) do not need a build step, so the
flag costs nothing. `npm ci` needs `package-lock.json` (present in the repository) and installs the
exact locked versions.

**A harmless startup warning.** With `--ignore-scripts` a transitive dependency's optional native
addon is not compiled, so on first use it prints
`bigint: Failed to load bindings, pure JS will be used (try npm run rebuild?)`. This is expected and
safe: the library falls back to pure JavaScript, which is correct and only marginally slower. The
`npm run rebuild` in that message does **not** mean this repository's `rebuild` script (which rebuilds
the curve-reconstruction research report) — it refers to npm's built-in `npm rebuild`, and you do not
need to run it.

**The one mandatory variable is `RPC_URL`.** `lib/config.mjs` validates it at startup and exits if it
is missing or does not start with `http://` / `https://`:

```
[config] ERROR: RPC_URL is required (must start with http:// or https://).
```

`WS_URL` is derived from it by replacing `https://` with `wss://`. There is no public-cluster
fallback on purpose: an accidental fallback would silently change both latency and rate limits.

## Wallet in short

```bash
node lib/wallet.mjs generate          # creates keys/default.json and prints the public address
node lib/wallet.mjs show              # prints the public address of keys/default.json
node lib/wallet.mjs generate main     # optional second wallet → keys/main.json
```

- The key file is `keys/<name>.json` (default name `default`); it is a JSON array of 64 bytes.
- `keys/` and `.env` are in `.gitignore`. Check with `git ls-files`: neither may appear.
- **Never share that file, never paste it into a website or a chat.** Anyone holding it controls the
  wallet. Details, backup and import into Phantom/Solflare: [docs/wallet-and-keys.md](docs/wallet-and-keys.md).

## Modes: DRY RUN and LIVE

<p align="center"><img src="docs/img/modes.svg" alt="Two lanes: DRY RUN never signs or sends; LIVE adds simulation, signing, send and confirmation" width="100%"></p>

| Mode | How it is activated | What happens |
|---|---|---|
| **DRY RUN** (default) | no flag, or `--dry-run` | The bot reads the chain, applies filters and risk guards, computes prices, fees and the simulated result, and writes the journal. **It never builds a signed transaction and never spends SOL.** |
| **LIVE** | `--live` **and** `LIVE_CONFIRM=yes` | Same signal path, plus: simulate the transaction, sign with `keys/<name>.json`, send, confirm, read the actual fill from the transaction meta. |

Verified in `lib/config.mjs`:

```js
export const LIVE = argv.includes("--live") && !argv.includes("--dry-run");
if (LIVE && process.env.LIVE_CONFIRM !== "yes") { /* exit with a clear message */ }
```

So `--dry-run` wins over `--live`, and `--live` alone is refused before any network connection.

### Safety limits (verified in `lib/guards.mjs`)

| Limit | Code default | `.env.example` | Behaviour |
|---|---|---|---|
| `MAX_TRADE_SOL` | `0.05` | `0.05` | A trade above it is skipped, the bot keeps running. `0` blocks every trade (fail-safe). |
| `MAX_SESSION_SOL` | `0.2` | `0.1` | Total SOL the session may put into buys. Exhausted → the session **ends** (positions closed, summary printed). `0` = no session cap. |
| `MAX_CONSEC_LOSSES` | `3` | `3` | N losing trades in a row → the session **ends**. `0` = no loss limit. |

`MAX_SESSION_SOL` and `MAX_CONSEC_LOSSES` are terminal by design: the bot stops scanning instead of
logging "halted" forever. Only `MAX_TRADE_SOL` is a per-trade refusal.

### Pre-LIVE checklist

1. `npm test` passes on your machine.
2. You ran the same bot in dry-run and read the log line by line.
3. `keys/<name>.json` holds a **throwaway** wallet with only the amount you accept losing.
4. `MAX_TRADE_SOL` and `MAX_SESSION_SOL` are small; `MAX_CONSEC_LOSSES` is set.
5. You know where the journal is and how to read it (`npm run journal`).
6. You are ready to stop with Ctrl+C and to check the summary (spent / received / NET, wallet delta,
   failed-transaction fees, STUCK positions).

---

## Bots overview

| Bot | Purpose | Reads only or trades | Dry-run command | Live command |
|---|---|---|---|---|
| `monitor` | Live stream of new tokens and trades | Reads only | `npm run monitor` | — (never trades) |
| `sniper` | Buys brand-new tokens after a holder gate, exits on TP/SL/timeout | Trades | `npm run sniper` | `npm run sniper -- --live` |
| `graduation-sniper` | Enters a curve that is close to migration, exits on TP/SL/timeout | Trades | `npm run graduation` | `npm run graduation -- --live` |
| `copy-trader` | Mirrors buys/sells of wallets in `COPY_TARGETS` | Trades | `npm run copy` | `npm run copy -- --live` |
| `basic-trader` | Manual `buy` / `sell` / `price` / `balance` / `wallet` CLI | Trades | `npm run trade -- price <mint>` | `npm run trade -- buy <mint> 0.02 --live` |
| `analytics` | Local dashboard + `/api/stats` on `ANALYTICS_PORT` | Reads only | `npm run analytics` | — |
| `volume-analyzer` | History of one wallet or one token, with a coverage report | Reads only | `npm run analyze -- wallet <WALLET_ADDRESS>` | — |
| `research lab` | Paper-trades several strategy variants on one stream | Reads only (refuses `--live`) | `npm run lab` | — (refused) |
| `replay` | Compares variants from lab output with a train/test split | Reads only | `npm run replay` | — |
| `graduation shadow` | Paper lab for 9 graduation variants (A–I) | Reads only | `node bots/graduation-sniper/shadow.mjs` | — (refuses `--live`) |
| `rescue-sell` | Inventories unsold tokens and plans/sends a sale | Trades (gated) | `npm run rescue` | `$env:LIVE_CONFIRM="yes"; npm run rescue -- --live --mint <MINT>` |

Every trading bot is **dry-run by default**. Live needs the flag **and** `LIVE_CONFIRM=yes`.
Per-bot parameters, output, stop behaviour and limitations: [docs/bots.md](docs/bots.md).

## Command reference

Summary only; the full table with "reads network / writes files / can trade" is in
[docs/commands.md](docs/commands.md).

```bash
npm run monitor          # watch new tokens and trades (read-only)
npm run sniper           # sniper, dry-run
npm run graduation       # graduation sniper, dry-run
npm run copy             # copy trader, dry-run (fill COPY_TARGETS first)
npm run trade -- wallet  # manual CLI: wallet / price / balance / buy / sell
npm run analytics        # local dashboard on http://localhost:3000
npm run analyze -- wallet <WALLET_ADDRESS>
npm run journal          # read data/journal and summarise
npm run rescue           # list unsold tokens + expected exit (dry-run)
npm run lab              # research lab (paper only)
npm run replay           # replay/compare lab variants
npm test                 # the offline test chain
```

**Before running a bot.** Copy `.env.example` to `.env` and set `RPC_URL`; create a wallet key with
`node lib/wallet.mjs generate` — trading bots load `keys/default.json` at startup. `monitor`,
`analytics`, `journal` and `replay` are read-only and need no key. `npm test` needs neither `.env`
nor a key: every test boots a throwaway keypair in a temp dir and a dummy `RPC_URL`.

**Going live.** The commands above run in dry-run by default. Trading real SOL requires `--live`
**and** `LIVE_CONFIRM=yes` (a second, independent switch). cmd.exe:
`set LIVE_CONFIRM=yes && npm run sniper -- --live` · PowerShell:
`$env:LIVE_CONFIRM="yes"; npm run sniper -- --live`. Without `LIVE_CONFIRM=yes` the process exits
before connecting.

## Verification status

Statuses come from the test files, the code itself and the git history — never from assumption.

| Bot / command / feature | Status | Evidence |
|---|---|---|
| `sniper` (dry-run) | **Tested** | `scripts/smoke.test.mjs` runs the real handler on a synthetic stream; `shutdown.test.mjs`, `instance-lock.test.mjs`, `dedupe.test.mjs` |
| `sniper` (live) | **Live observed** | git log: live iterations in this repository’s history; failures with pump errors 6002/6024 were recorded and fixed in code (commits `259082d`, `43cdfa8`, `36e5994`) |
| `graduation-sniper` (dry-run) | **Dry-run verified** | starts, journals candidates, prints a summary; there is no automated test for this bot |
| `graduation-sniper` (live) | **Live observed** | live sessions in the git history; after them the entry/sell logic was rewritten (partial sells, exit preview, bounded retries) |
| `copy-trader` | **UNVERIFIED** | no test, no recorded run in the git history |
| `basic-trader` | **UNVERIFIED** | no test, no recorded run in the git history |
| `monitor` | **UNVERIFIED** | no test, no recorded run in the git history |
| `analytics` | **UNVERIFIED** | serves `127.0.0.1:ANALYTICS_PORT`; no test |
| `volume-analyzer` parsing | **Tested (parsing only)** | `scripts/fetchtx.integration.test.mjs` exercises the fetch/decode layer with cached fixtures |
| `research lab` / `replay` | **Tested** | `scripts/research.test.mjs`, `replay.test.mjs`, `strategy.test.mjs` |
| `graduation shadow` statistics | **Tested** | `scripts/graduation-analyze.test.mjs`, `gradstats.mjs` |
| `rescue-sell` planner | **Dry-run verified** | `scripts/sell-plan.test.mjs` covers the planner; the script itself is not covered by a test |
| PumpSwap (AMM) sell | **UNVERIFIED** | the code says so; live use is gated behind `LIVE_CONFIRM_AMM=yes` |
| PumpSwap event parsing | **Tested** | `scripts/pumpswap.test.mjs` |
| `npm test` | **Tested** | 27 test scripts chained in `package.json` (hermetic: no `.env`, no `keys/`) |

---

## Error codes quick table

Codes are copied from the official pump.fun IDL into `lib/pump-errors.mjs` (111 entries there).
The full table with "what to do" is in
[docs/errors-and-troubleshooting.md](docs/errors-and-troubleshooting.md).

| Code | Name | Meaning (short) |
|---|---|---|
| 6002 | `TooMuchSolRequired` | Slippage: buying the requested tokens would cost more SOL than the cap. |
| 6003 | `TooLittleSolReceived` | Slippage: selling would return less SOL than the minimum. |
| 6005 | `BondingCurveComplete` | The curve completed and liquidity migrated. |
| 6024 | `Overflow` | Arithmetic overflow, typical when the curve cannot pay the requested sell. |
| 6042 | `BuySlippageBelowMinTokensOut` | The buy would return fewer tokens than `min_tokens_out`. |
| 6081 | `BondingCurveAlreadyMigrated` | The curve already migrated. |
| 6094 | `CashbackCoinNotSupported` | v3 trades do not support cashback coins; the v2 instructions are needed. |

## Results and honesty

**No published results yet.** This repository ships no strategy result and no performance figures,
because a number is only meaningful with a known sample size and a fixed execution model.

How to produce your own, honestly:

1. Run a bot in **dry-run** for a long period (or run the research lab / shadow harness). Every trade
   and every candidate is written to `data/journal/*.jsonl`.
2. Read it with `npm run journal` (trading journal) or
   `node scripts/analyze-graduation.mjs` (graduation shadow trades).
3. Apply the repository's own sample-size rules: a bootstrap confidence interval is only computed for
   **n ≥ 30** (`lib/gradstats.mjs`), and a profitability conclusion is not drawn below **n = 200**
   (the analyzer prints a warning). Smaller samples are screening data, not evidence.
4. Report the execution model with the numbers: delay, slippage, pump fees (1% in + 1% out), priority
   fee, transaction fee and the cost of failed attempts (`lib/pessimistic.mjs`).

Until you have done that, treat every strategy here as unproven.

## Screenshots

No screenshots are published yet. Placeholders live in
[`docs/img/screenshots/`](docs/img/screenshots/README.md) — the folder explains exactly what to
capture (dry-run banner, dashboard, session summary) and what to redact first.

> Before publishing any screenshot: **blur the `RPC_URL`** (it can contain `?api-key=YOUR_KEY`),
> remove your wallet address if you do not want it public, and never capture `keys/` or `.env`.

## Security notes

- **Keys.** `keys/<name>.json` holds the secret key as a plain JSON array. Treat it like cash. The bot
  loads it once at startup and uses it only to sign; `lib/logger.mjs` masks anything that looks like
  key material (byte arrays of 60+ integers, `secretKey=...` blobs, base58 runs of 80–90 chars).
- **`.env`.** It holds `RPC_URL` (often with an API key) and, if you set it, `HELIUS_API_KEY`. Both
  `keys/` and `.env` are gitignored — verify with `git ls-files`.
- **Forks.** Do not run a fork you have not read. The signing path is `lib/wallet.mjs` +
  `lib/tx.mjs` + `lib/send.mjs`; read those three first.
- **Dependencies.** Three runtime dependencies, pinned exactly in `package.json`; install with
  `npm ci --ignore-scripts` so the lock file is authoritative.
- **Logs.** Console output is masked, but your terminal scrollback and journal files are not
  encrypted. Do not paste raw logs into public channels without checking them.
- **RPC provider.** A malicious or compromised RPC can withhold or reorder information. Prefer a
  provider you trust and keep an eye on `rpcStats` in the session summary (429 share, errors, latency).

---

## Project structure

```
pump-bot/
├── package.json            scripts, engines, 3 pinned dependencies
├── package-lock.json       exact dependency tree (used by npm ci)
├── .env.example            every supported variable, with comments
├── bots/
│   ├── monitor/stream.mjs          read-only token/trade stream
│   ├── sniper/sniper.mjs           new-token sniper (dry-run by default)
│   ├── graduation-sniper/
│   │   ├── graduation.mjs          curve-near-migration sniper
│   │   └── shadow.mjs              paper lab, variants A–I, never trades
│   ├── copy-trader/watcher.mjs     mirrors wallets from COPY_TARGETS
│   ├── basic-trader/trade.mjs      manual buy/sell/price/balance/wallet CLI
│   ├── analytics/                  local dashboard (server.mjs + dashboard.html)
│   ├── volume-analyzer/analyzer.mjs  wallet/token history + coverage
│   └── research/                   lab.mjs (paper variants), replay.mjs (train/test)
├── lib/
│   ├── config.mjs                  .env loader, validation, LIVE gate, limits
│   ├── wallet.mjs                  keypair generate/show/load (keys/)
│   ├── rpc.mjs / ws.mjs            HTTP rate limiter, WebSocket with backoff
│   ├── events.mjs / mayhem.mjs     payload parsing, Mayhem detection
│   ├── pumpfun.mjs / pumpswap.mjs  instructions, curve state, AMM helpers
│   ├── curve.mjs / fees.mjs        pricing, graduation fill, cost model
│   ├── exec.mjs / send.mjs         read actual fills, simulate-then-send
│   ├── sell-plan.mjs               splits a sell so the curve can pay it
│   ├── pump-errors.mjs             IDL error code table + classifiers
│   ├── guards.mjs / session.mjs    exposure limits, session ledger/report
│   ├── journal.mjs / ticks.mjs     JSONL journal, tick log
│   ├── logger.mjs                  leveled logger with secret masking
│   ├── pessimistic.mjs / gradstats.mjs  execution model, shadow statistics
│   └── holders / holderticks / strategy / research / ratelimit / retry /
│       runmeta / shadow / solprice / status / time / consistency / creators /
│       rebuild / rawcap / analyzer-core
├── scripts/                tests + diagnostics + analysis (see docs/commands.md)
├── docs/                   this documentation + local SVG images
└── data/                   journals, raw captures, caches — gitignored, never commit
```

## Credits, license, disclaimer

**Credits.** The code originates from the public repository
[zostaff/pumpfunbots-reverse](https://github.com/zostaff/pumpfunbots-reverse), which had no license.
This documentation and the diagrams in `docs/img/` are original work for this repository. pump.fun,
Solana, Helius, Phantom and Solflare are names of their respective owners; there is no affiliation.

**License: not specified yet.** The upstream repository carried no license, so no license is granted
here and none should be assumed. If you plan to redistribute, ask the original author first.

**Disclaimer.** This software is provided as-is, without warranty of any kind. Trading memecoins can
result in the total loss of the funds involved. Nothing in this repository is financial advice. You
are solely responsible for how you use it, for your keys, and for complying with the laws that apply
to you.




