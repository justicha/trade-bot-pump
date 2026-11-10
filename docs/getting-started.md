# Getting started

This walkthrough takes you from a clean machine to a **dry-run** bot. Nothing here spends SOL.
Every command exists in this repository; flags and defaults were read from the source.

> Output blocks below are **illustrative**: they show the shape of the log with placeholders, not a
> recorded session.

## 1. Install Node.js

- **Required:** Node.js `>=22` (from `engines` in `package.json`).
- **Windows:** install from the official Node.js site, then open **PowerShell** and check:
  ```powershell
  node --version    # v22.x or newer
  npm --version
  ```
- **Linux/macOS:**
  ```bash
  node --version && npm --version
  ```

## 2. Get the code

```bash
git clone https://github.com/<you>/pump-bot.git
cd pump-bot
npm ci --ignore-scripts
```

`npm ci` installs the exact versions from `package-lock.json`. `--ignore-scripts` stops dependency
lifecycle scripts from running at install time; none of the three dependencies needs a build step.

## 3. Configure `.env`

**PowerShell**

```powershell
Copy-Item .env.example .env
notepad .env
```

**Linux/macOS**

```bash
cp .env.example .env
$EDITOR .env
```

Set at least:

```dotenv
RPC_URL=https://<your-rpc-host>/?api-key=YOUR_KEY
```

`lib/config.mjs` refuses to start without it:

```
[config] ERROR: RPC_URL is required (must start with http:// or https://).
```

Keep the safety limits conservative for a first run:

```dotenv
MAX_TRADE_SOL=0.02
MAX_SESSION_SOL=0.05
MAX_CONSEC_LOSSES=2
```

## 4. Create the wallet

```powershell
node lib/wallet.mjs generate      # → keys/default.json + printed public address
node lib/wallet.mjs show          # → prints the public address again
```

The key file is gitignored. Read [wallet-and-keys.md](wallet-and-keys.md) before you put any SOL in
it.

## 5. Watch the market (read-only, no wallet needed)

```powershell
npm run monitor
```

Illustrative output:

```
[..] [INFO] === MONITOR ===
[..] [INFO] NEW TOKEN #1 <MINT> creator=<WALLET_ADDRESS> dev buy 0.42 SOL
[..] [INFO]   buy  0.03 SOL  user=<WALLET_ADDRESS>
[..] [INFO]   sell 0.02 SOL  user=<WALLET_ADDRESS>
```

Stop with **Ctrl+C**. The monitor never signs anything.

Optional filter (minimum dev buy, in SOL):

```powershell
node bots/monitor/stream.mjs --filter-dev-buy 0.5
```

## 6. Run the sniper in dry-run

```powershell
npm run sniper
```

Illustrative output:

```
[..] [INFO] === SNIPER BOT (V3) ===
[..] [INFO] Wallet: <WALLET_ADDRESS>
[..] [INFO] Config: buy=0.02 SOL, TP=2x, SL=0.5x, timeout=120s
[..] [INFO] Max positions: 3, cooldown: 10s
[..] [INFO] MODE: DRY RUN (no real transactions) — pass --live to trade
[..] [INFO] Filter: dev buy >= 0.5 SOL
[..] [INFO] Filter: >= 4 holders within 45s (no instant buy at create)
[..] [INFO] WATCHING: <MINT>  creator: <WALLET_ADDRESS> | waiting for 4 holders (max 45s)
[..] [INFO] SNIPING: <MINT>
[..] [INFO]   4 holders reached (>= 4)
[..] [INFO]   buying 0.02 SOL -> ~<N> tokens
[..] [INFO]   [DRY RUN] would buy — position tracked
```

Reading the lines:

- `MODE: DRY RUN` — no transaction will be signed or sent.
- `WATCHING` / `waiting for N holders` — the holder gate (`SNIPER_MIN_HOLDERS`, `SNIPER_HOLDER_WAIT_SEC`).
- `SNIPING` — the filters passed; `[DRY RUN] would buy` is a simulated fill.
- A `skip:` line means a filter or a guard refused the trade; the reason is printed.

## 7. Stop it correctly

**Ctrl+C** starts a normal shutdown in the trading bots:

- the bot stops accepting new work, closes open positions (in dry-run the close is simulated),
- prints `SESSION SUMMARY` (spent / received / NET, and in LIVE the wallet delta plus the estimated
  fees of failed transactions and a separate STUCK list),
- the sniper then drains its tick log for up to `SNIPER_DRAIN_MAX_SEC` (default 10 s); a **second**
  Ctrl+C exits immediately. The graduation sniper uses a short bounded drain (8 s) and prints the
  summary first.

If a position cannot be sold (for example the curve cannot pay it), it is reported as **STUCK** and
listed in the summary instead of being silently dropped.

## 8. Where files are written

| Path | Written by | What |
|---|---|---|
| `data/journal/YYYY-MM-DD.jsonl` | sniper, graduation-sniper, copy-trader, shadow | trades, candidates, session records |
| `data/journal/ticks-*.jsonl` | sniper | per-second price ticks per position (rotating) |
| `data/journal/holders-*.jsonl` | sniper | holder milestones and price samples |
| `data/journal/.sniper.lock`, `.graduation.lock` | sniper, graduation-sniper | single-instance lock (PID) |
| `data/journal/graduation-blacklist.json` | graduation-sniper | mints whose curve was already complete |
| `data/raw/*.jsonl.gz` | `npm run capture-raw` | raw event capture, gzipped per hour |
| `data/txcache/*.json` | `npm run analyze` | parsed transaction cache |

`data/` is gitignored. Do not commit it.

## 9. Next steps

- All bot parameters and their defaults: [configuration.md](configuration.md).
- Per-bot behaviour, exits and limitations: [bots.md](bots.md).
- Errors you will meet (429, compute budget, 6002/6024): [errors-and-troubleshooting.md](errors-and-troubleshooting.md).
- Only after a long dry-run and a review of the code: [Modes](../README.md#dry-run-vs-live).
