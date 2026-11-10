<p align="center"><img src="docs/img/banner.svg" alt="pump-bot: deep navy banner with a teal curve and the words pump-bot" width="100%"></p>

<h1 align="center">pump-bot</h1>

<p align="center">Small bots that watch pump.fun on Solana and can buy and sell memecoins for you — on paper first, with real money only if you insist.</p>

## Read this first

> **You can lose every cent you put in.** Memecoin prices can fall 99% in a minute, and some tokens
> cannot be sold at all. This is **not financial advice**, nothing here promises a profit, and the
> code is a research tool that may still contain bugs.
>
> Start in **dry-run** (no money moves at all). If you ever go live, use a **new throwaway wallet**
> holding only an amount you can afford to lose completely.

<p align="center"><img src="docs/img/flow.svg" alt="Five steps: watch new tokens, check filters and limits, dry-run or live buy, take profit or stop loss or timeout, journal and summary" width="100%"></p>

## What it does

- Watches the Solana blockchain for brand-new tokens on pump.fun, as they appear.
- Buys and sells by simple rules: take profit, stop loss, or a timeout.
- Can copy another wallet's trades, or enter just before a token "graduates".
- Runs in **dry-run by default**: it records what it *would* have done and never signs a transaction.
- Also includes read-only tools: a live feed of new tokens, a local dashboard, and research scripts.

## Quick start (dry-run, no money)

1. Install **Node.js 22 or newer** from <https://nodejs.org>. Check it with `node -v`.
2. Clone the repository and install the libraries:
   ```powershell
   git clone https://github.com/<you>/pump-bot.git
   cd pump-bot
   npm ci --ignore-scripts
   ```
3. Create your settings file:
   ```powershell
   Copy-Item .env.example .env
   ```
4. Open `.env` in any editor and set `RPC_URL` to your own Solana RPC endpoint. A free public one
   will be throttled and the bot will look idle.
5. Create an empty wallet. This only writes `keys/default.json`; it costs nothing and holds no money:
   ```powershell
   node lib/wallet.mjs generate
   ```
6. Start the sniper in dry-run:
   ```powershell
   npm run sniper
   ```

It prints the tokens it would buy and the exits it would take. Nothing is signed, nothing is sent.
Stop it with `Ctrl+C`.

A harmless `bigint: Failed to load bindings` warning may appear. It is safe.
(Step-by-step with more detail: [docs/getting-started.md](docs/getting-started.md).)

## Dry-run vs live

| Mode | What happens | Money at risk |
|---|---|---|
| **Dry-run** (default) | Decisions are made, a simulated fill is recorded, the journal is written. No transaction is ever signed or sent. | None |
| **Live** | Real transactions are signed with the wallet in `keys/` and sent to the network. | All of it |

Live mode needs **two** switches at the same time: the `--live` flag **and** `LIVE_CONFIRM=yes` set
in the same shell. Either one alone stops the bot at startup. A `--dry-run` flag also cancels
`--live`.

## Which bot should I look at?

| Command | What it does | Risk |
|---|---|---|
| `npm run monitor` | Prints new tokens and trades as they happen. | Read-only |
| `npm run sniper` | Buys new tokens that pass filters; exits on take profit, stop loss or timeout. | Trades |
| `npm run graduation` | Enters a token just before its bonding curve finishes. | Trades |
| `npm run copy` | Mirrors the wallets listed in `COPY_TARGETS`. | Trades |
| `npm run trade` | Manual buy / sell / price / balance from the command line. | Trades |
| `npm run analytics` | Local web dashboard of what the bot sees. | Read-only |
| `npm run lab` · `npm run replay` | Paper trading and train/test research. | None |

"Trades" always means "dry-run unless you add `--live`". Full flags for every bot:
[docs/bots.md](docs/bots.md) · every command: [docs/commands.md](docs/commands.md).

## Safety limits

Three hard limits stop a bad day from becoming a disaster. These are the defaults shipped in
`.env.example`:

- **Per trade — 0.05 SOL** (`MAX_TRADE_SOL`). A larger trade is skipped; the bot keeps running.
- **Per session — 0.1 SOL** spent on buys (`MAX_SESSION_SOL`). When it runs out, the bot stops
  listening, closes what it can (live only), prints a summary and exits.
- **Losing streak — 3 in a row** (`MAX_CONSEC_LOSSES`). The session ends instead of revenge trading.

`MAX_SESSION_SOL` and `MAX_CONSEC_LOSSES` accept `0` for "no limit". For `MAX_TRADE_SOL`, `0` means
"block every trade" (on purpose: a missing value must never mean "unlimited").

## Is it proven?

**No.** There are no published results: no backtest, no track record, no claim that any strategy
here makes money. What the repository does have is a test suite of **47 test files** (`npm test`)
that runs offline, and an audit with a verdict for each reported issue. Tests show that the code
does what it says; they say nothing about profit. Read
[docs/verification-status.md](docs/verification-status.md) before trusting any number that appears
in a log.

## Security, in four lines

- **Never share `keys/`.** It holds the private key in plain text. Treat it like cash.
- **Never commit `.env`.** It holds your RPC URL, often with a paid API key.
- **Read the signing code** before running live: `lib/wallet.mjs`, `lib/tx.mjs`, `lib/send.mjs`.
- **Use a private RPC.** A throttled or hostile endpoint can hide or delay what the bot sees.

More: [docs/security.md](docs/security.md) · wallet and keys: [docs/wallet-and-keys.md](docs/wallet-and-keys.md) ·
settings: [docs/configuration.md](docs/configuration.md) · errors: [docs/errors-and-troubleshooting.md](docs/errors-and-troubleshooting.md).

## License

**Not specified.** The upstream repository carried no license, so no license is granted here and none
should be assumed. If you plan to redistribute this code, ask the original author first.

The software is provided as-is, without warranty of any kind. Trading memecoins can result in the
total loss of the funds involved, and nothing in this repository is financial advice. You are
responsible for your keys, your money and the laws that apply to you.
