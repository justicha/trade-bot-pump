<p align="center"><img src="docs/img/banner.svg" alt="pump-bot — research bots for pump.fun on Solana. Animated: bonding curve, configurable entry band, graduation to PumpSwap, exit. Dry-run by default; not financial advice." width="100%"></p>

<p align="center"><b>Bots for pump.fun (Solana) · dry-run by default · a research tool, not a way to make money.</b></p>

<h1 align="center">pump-bot</h1>

<p align="center">Small bots that watch pump.fun on Solana and can buy and sell meme coins for you — on paper first, for real money only if you want it yourself.</p>

## Contents

- [Read this first](#read-this-first)
- [What the project does](#what-the-project-does)
- [A token's life on pump.fun](#a-tokens-life-on-pumpfun)
- [What's new](#whats-new)
- [Quick start: dry-run without money](#quick-start-dry-run-without-money)
- [Dry-run and live](#dry-run-and-live)
- [Which bot do I need](#which-bot-do-i-need)
- [Safety limits](#safety-limits)
- [Sell everything](#sell-everything)
- [Is it verified?](#is-it-verified)
- [Safety in four lines](#safety-in-four-lines)
- [Documentation](#documentation)
- [License](#license)

## Read this first

> ⚠️ **You can lose everything you put on the wallet.** A meme coin price drops 99% in a minute,
> and some tokens do not sell at all. This is **not investment advice**: no one promises profit here,
> and the code is a research tool that may contain bugs.
>
> Start with **dry-run** — in this mode no money moves. If you ever switch to live,
> use a **new throwaway wallet** and only an amount you can afford to lose entirely.

<p align="center"><img src="docs/img/flow.svg" alt="Five steps: watch for new tokens, filters and limits, buy in dry-run or live, exit on take-profit, stop-loss or timeout, journal and summary" width="100%"></p>

## What the project does

- Watches the Solana blockchain and sees new pump.fun tokens the moment they appear.
- Buys and sells by simple rules: take-profit, stop-loss or timeout.
- Can copy another wallet's trades and enter one step before a token's graduation.
- Runs in **dry-run** by default: records what it would do and signs no transaction.
- Provides read-only tools: a stream of new tokens, a local dashboard, research
  scripts and a shadow lab that compares strategy variants on paper.
- The key lives in a file on your computer; only an already-signed transaction ever leaves it.

## A token's life on pump.fun

```text
 creation ──► bonding curve ───────────────────► graduation ──► PumpSwap pool
              price rises with each buy                  100%,        a regular AMM pool,
              0% ············ 75–90% ······· 100%     ≈ 85 SOL      its own price and fees
                              ▲
                              the graduation bot enters here (band set in .env)
```

While a token is on the **curve**, it can only be bought and sold through it. When the curve is full
(**graduation**), trading moves to the **PumpSwap** pool, and the price there is its own. The sniper buys
tokens right after creation; the graduation bot — shortly before graduation.

## What's new

- **Honest about the PumpSwap fee.** The sell quote now uses the pool's real fee (~1.2%, not 0.3%) — shadow is more honest, old results were ~1% more optimistic. The AMM sell has its own compute limit (`AMM_SELL_CU_LIMIT=160000`). If a sale failed but actually landed later — the bot finds and records it. Live bots notice a console stall.
- **Shadow: a process stall was found.** Most likely because of a paused Windows console (clicking / selecting text in the window — QuickEdit), the bot stopped seeing trades and 5 tokens in a run showed -95%. Now shadow notices it and does not record such trades as a result; variants K/L/M/N were added. Tip: run bots in Windows Terminal or the VS Code terminal and do not select text in the bot window.
- **Sell retries and a stuck-position safety net.** sniper no longer retries a failed sell forever, and copy-trader no longer drops it: up to `SELL_MAX_ATTEMPTS` attempts (default 3) with 2 s, 4 s, ... pauses, then the position is marked STUCK. copy-trader sells the whole position itself if the target has not sold for 30 minutes (`COPY_MAX_HOLD_SEC=1800`, `0` = off).
- **Getting the token-account rent back.** After a full sale the bot closes the emptied token account and returns ~0.002 SOL of rent (≈10% of a 0.02 stake). The sale does not depend on it — the close runs as a separate background transaction. Turn off: `ATA_CLOSE=no`. Old empty accounts: `node scripts/close-empty-atas.mjs` (without flags it only shows, sends nothing).
- **Pre-buy exit check (graduation bot).** Before buying, the bot asks the network to
  *simulate* buy-then-sell in one transaction. The simulation sends nothing and
  spends nothing. In live the bot does not buy if the simulated sell fails. In dry-run the result is only
  journaled (`preBuySim`); the paper buy is not blocked.
- **The shadow lab** — `node bots/graduation-sniper/shadow.mjs`. Read-only: on one stream
  of trades it paper-runs several strategy variants at once and journals every entry and exit.
  Variant **J** is your own `GRAD_*` settings from `.env`, i.e. the answer to
  how my config would trade. The lab does not run with `--live`. Report:
  `node scripts/analyze-graduation.mjs`. More details — [docs/research.md](docs/research.md).
- **An honest price after graduation.** When a token moved to PumpSwap, the curve goes silent and its last
  price is the highest of the token's life. Paper positions used to close at this frozen
  price, and the result looked better than reality. Now the exit uses the PumpSwap pool quote. If
  there is no quote, the trade is journaled **without a result** and is not averaged in.
- **Status: profitability not proven.** Data is only being collected. We draw profit conclusions no earlier than
  **200 or more distinct tokens**; before that any journal numbers are noise.

## Quick start: dry-run without money

You need **Node.js 22 or newer** (check: `node -v`). Everything else is the five steps below.
Commands for Windows are for PowerShell, for macOS and Linux — for bash; they differ only in
copying the config file.

**1. Download the code and install the libraries**

```powershell
# Windows (PowerShell)
git clone <URL-of-your-fork>
cd pump-bot
npm ci --ignore-scripts
```

```bash
# macOS / Linux (bash)
git clone <URL-of-your-fork>
cd pump-bot
npm ci --ignore-scripts
```

**2. Create the config file from the template**

```powershell
Copy-Item .env.example .env
```

```bash
cp .env.example .env
```

**3. Open `.env` in any editor and set `RPC_URL`** — the address of your Solana RPC. A free
public endpoint will constantly hit limits, and the bot will look asleep. If
`RPC_URL` is not set, the bot stops immediately with `RPC_URL is required`.

**4. Create an empty wallet**

```powershell
node lib/wallet.mjs generate
```

The command only writes `keys/default.json` into the project folder: it spends nothing and does not
go to the network. What is inside the file and why `--force` exists is in [docs/wallet-and-keys.md](docs/wallet-and-keys.md).

**5. Run the sniper in dry-run**

```powershell
npm run sniper
```

The bot prints the tokens it would buy and the exits it would make. Nothing is signed and
nothing is sent. Stop with `Ctrl+C`.

![Example dry-run output: journal lines, addresses and amounts replaced with placeholders](docs/img/dryrun-terminal.svg)

Sometimes a harmless `bigint: Failed to load bindings` warning appears — it is normal and does not
affect anything.

A step-by-step walkthrough: [docs/getting-started.md](docs/getting-started.md).

## Dry-run and live

| Mode | What happens | What you risk |
|---|---|---|
| **dry-run** (default) | Decisions are made, the trade is counted virtually, the journal is written. No transaction is signed or sent. | Nothing |
| **live** | Real transactions are signed with the key from `keys/` and sent to the network. | Everything on the wallet |

For live you need **both** switches at once: the `--live` flag **and** the
`LIVE_CONFIRM=yes` variable in the same shell. Each alone is not enough — the bot stops before
connecting to the network. The `--dry-run` flag cancels `--live`.

```powershell
# Windows (PowerShell): the variable lives only inside this process
$env:LIVE_CONFIRM="yes"; npm run sniper -- --live
```

```bash
# macOS / Linux
LIVE_CONFIRM=yes npm run sniper -- --live
```

The separate `LIVE_CONFIRM_AMM=yes` switch is about selling a token that already moved to
PumpSwap: this path is **not verified on a real transaction**, and without explicit consent the bot
skips such a token.

## Which bot do I need

| Command | What it does | Risk | Good for a beginner? |
|---|---|---|---|
| `npm run monitor` | Prints new tokens and trades as they appear. | Read-only | ✅ Yes, start with it |
| `npm run analytics` | A local web dashboard: what the bot sees right now. | Read-only | ✅ Yes |
| `npm run lab` · `npm run replay` | Paper trading and a train/test study on history. | No money | ✅ Yes |
| `node bots/graduation-sniper/shadow.mjs` | The shadow lab: graduation strategy variants (including your config — variant J) on paper. | Read-only | ✅ Yes |
| `npm run sniper` | Buys new tokens that pass the filters; exits on TP, SL or timeout. | Trades | 🟡 Only in dry-run |
| `npm run graduation` | Enters one step before the token's curve completes. | Trades | 🟡 Only in dry-run |
| `npm run trade` | Manual buy / sell / price / balance from the command line. | Trades | 🟡 If you know what you are doing |
| `npm run copy` | Repeats the trades of the `COPY_TARGETS` wallets. | Trades | ❌ Not for the first run |

«Trades» always means counts on paper until `--live` is added. All the flags of each
bot: [docs/bots.md](docs/bots.md) · all npm commands: [docs/commands.md](docs/commands.md).

## Safety limits

Three hard limits keep one bad day from becoming a disaster. These are the defaults
from `.env.example`:

- **Per trade — 0.05 SOL** (`MAX_TRADE_SOL`). A trade above the limit is skipped, the bot keeps running.
- **Per session — 0.1 SOL** for buys (`MAX_SESSION_SOL`). When the limit is exhausted, the bot stops listening,
  closes what it can (only in live), prints a summary and exits.
- **A losing streak — 3 in a row** (`MAX_CONSEC_LOSSES`). The session ends instead of chasing.

For `MAX_SESSION_SOL` and `MAX_CONSEC_LOSSES`, `0` means no limit. For `MAX_TRADE_SOL`
`0` means block every trade — on purpose: a missing value must not mean no
limits. The full list of settings: [docs/configuration.md](docs/configuration.md).

## Sell everything

`scripts/sell-all.mjs` shows all tokens still on the wallet, and with `--live` sells them
one by one. This is a rescue tool, not a strategy: it never buys and never opens positions.

```powershell
node scripts/sell-all.mjs
```

The default run is **plan only**. It prints a table (mint, balance, venue, expected SOL,
status), nothing is sent or signed.

To actually sell:

```powershell
$env:LIVE_CONFIRM="yes"; node scripts/sell-all.mjs --live
```

Without `LIVE_CONFIRM=yes` the script exits before creating an RPC client.

Tokens on the curve are sold through the curve. Tokens that already moved to PumpSwap take another path
and need separate consent `LIVE_CONFIRM_AMM=yes`: the PumpSwap sell layout is **not verified
on-chain yet** (the program answers `Custom 6062`). Without this flag the token is skipped with
`PumpSwap sell unverified`, and nothing is sent.

Every sale is simulated first. A failed simulation prints the program logs, the token
is skipped, and work continues with the next. Sends go one by one, there are no automatic retries.
Every decision lands in `data/journal` as `sell_all_plan`, `sell_all_sent`,
`sell_all_skipped` or `sell_all_failed`.

**For PumpSwap tokens it is wiser to sell manually via Jupiter or Photon**, until the
PumpSwap exit is confirmed on a real transaction.

## Is it verified?

**No.** There are no published results: no backtest, no trade history, no claim that
any strategy here makes money. What exists is a test suite (`npm test`, 71 files) that
runs offline, and an audit with a verdict per reported problem. The tests prove the code does
what it claims; about profit they say nothing. Before trusting the numbers in the logs, read
[docs/verification-status.md](docs/verification-status.md).

Data is being collected in dry-run and the shadow lab. Each token counts as one observation,
no matter how many trades it has. A profitability conclusion is only valid from **200 distinct tokens**,
and only after all costs: pump.fun and PumpSwap fees, slippage, network fees.
The PumpSwap exit has not been verified on a real transaction yet.

The development reports live in [docs/dev-reports/](docs/dev-reports/). These are not trading results.

## Safety in four lines

- **Never show `keys/` to anyone.** The private key is there in plain text. Treat it like cash.
- **Never commit `.env`.** Your RPC address is there, often with a paid API key.
- **Read the signing code** before going live: `lib/wallet.mjs`, `lib/tx.mjs`, `lib/send.mjs`.
- **Use your own RPC.** A third-party or overloaded endpoint can hide or delay data.

Keep a backup of the key on an offline medium. And most importantly: **do not run this from your main
wallet** and do not keep savings at this address — only an amount you can afford to lose entirely.

More: [docs/security.md](docs/security.md) · wallet and keys:
[docs/wallet-and-keys.md](docs/wallet-and-keys.md) · settings: [docs/configuration.md](docs/configuration.md) ·
errors: [docs/errors-and-troubleshooting.md](docs/errors-and-troubleshooting.md).

## Documentation

| Document | About |
|---|---|
| [docs/getting-started.md](docs/getting-started.md) | From scratch: Node.js, `.env`, a wallet, the first dry-run, a glossary |
| [docs/bots.md](docs/bots.md) | All eight bots: flags, variables, what they write to the journal |
| [docs/commands.md](docs/commands.md) | Full tables of `npm run …` commands and helper scripts |
| [docs/configuration.md](docs/configuration.md) | Every `.env` variable: meaning and defaults |
| [docs/wallet-and-keys.md](docs/wallet-and-keys.md) | Wallet generation, where the key lives, backup |
| [docs/architecture.md](docs/architecture.md) | How it works inside: RPC, parser, calculations, sending |
| [docs/errors-and-troubleshooting.md](docs/errors-and-troubleshooting.md) | Error texts and what to do about them |
| [docs/verification-status.md](docs/verification-status.md) | What is verified, what is not, and why |
| [docs/security.md](docs/security.md) | Threats and key-handling rules |
| [docs/research.md](docs/research.md) | The lab, the graduation shadow lab, replays, research reports |
| [docs/dev-reports/](docs/dev-reports/) | Development reports (not trading results) |

## License

**Not specified.** The original repository had no license, so none is granted here and
none should be assumed. If you plan to distribute the code, ask the original author.

The program is provided "as is", without any warranties. Trading meme coins can lead to
a total loss of the funds; nothing in this repository is investment advice.
Responsibility for keys, money and compliance with your country's laws is yours.


