# Where to start

A step-by-step guide for someone who has **never run bots before**.
We go from an empty computer to a running virtual (dry-run) bot,
which buys and spends nothing.

> Everything below is checked against this repository's code. The output blocks are **examples** with
> placeholders (`MINT_EXAMPLE`, `0.00`), not a recording of a real session.

---

## 0. What this bot is and what it does NOT do

**What it does**

- watches the Solana blockchain and notices new pump.fun tokens the moment they appear;
- decides by given rules whether to buy or skip (the size of the token author's first buy,
  the number of distinct holders, the amount limits);
- exits by one of three rules: take profit, stop loss or timeout;
- records every decision in a journal — the `data/journal/YYYY-MM-DD.jsonl` file;
- runs in **dry-run** mode by default: counts and records, but does not sign
  or send transactions.

**What it does NOT do**

- **is not a financial advisor**: it does not know what the price will do next;
- **guarantees no profit** and promises no yield — not in the docs, not in the logs;
- does not earn by itself: without your commands it does nothing;
- does not withdraw to a card, pay taxes or answer for the legality of your actions;
- cannot cancel an already-sent transaction: the blockchain is irreversible.

Meme coins are a very risky market: the price can drop 99% in a minute, and some
tokens **cannot be sold at all**. Assume the money you put in can be
lost entirely.

---

## 1. What to install

### 1.1 Node.js 22 or newer

The bot is written in Node.js (a JavaScript runtime). `package.json` declares the
`>=22` requirement.

1. Open <https://nodejs.org> and download the **LTS version** (branch 22 or newer).
2. Install with the default settings (click Next to the end).
3. Open a terminal (see 1.3) and check:

```powershell
node -v
npm -v
```

The expected result looks like:

```
v22.11.0
10.9.0
```

If instead of a version you see command not found (`not recognized`,
`command not found`) — Node.js did not install, or the terminal was opened before the install.
Close the terminal, reopen it and repeat.

### 1.2 Code editor

Any text editor works, but **VS Code** (free) is the most convenient:
<https://code.visualstudio.com>. You need it to open and edit the `.env` file
(settings); a plain Notepad works too.

### 1.3 Terminal

- **Windows:** PowerShell (find it in the Start menu). All commands below are for
  PowerShell. Do not use the Command Prompt (`cmd`) — its commands differ.
- **macOS:** the Terminal app or iTerm.
- **Linux:** any terminal, the `bash` shell.

To check you are in the right folder: `pwd` (macOS/Linux) or `Get-Location` (Windows)
prints the current path. All commands in this document run **from the project
folder** — the one containing `package.json`.

### 1.4 Git (optional)

Git is needed to download the code with `git clone`. Without Git, download a ZIP archive
from the repository page and unzip it — the result is the same.

```powershell
git --version
```

---

## 2. Installation

### 2.1 Windows (PowerShell)

```powershell
# 1. Download the code. Replace <REPO-URL> with the address you got the project from
#    (for example, https://github.com/your-login/pump-bot.git).
git clone <REPO-URL> pump-bot

# 2. Go into the project folder
cd pump-bot

# 3. Install the libraries exactly the versions recorded in package-lock.json
npm ci --ignore-scripts

# 4. Create your own config file from the template
Copy-Item .env.example .env
```

### 2.2 macOS / Linux (bash)

```bash
# 1. Download the code
git clone <REPO-URL> pump-bot

# 2. Go into the project folder
cd pump-bot

# 3. Install the libraries
npm ci --ignore-scripts

# 4. Create your own config file from the template
cp .env.example .env
```

### 2.3 What these commands mean

| Command | What it does |
|---|---|
| `git clone <URL>` | copies the project to your computer |
| `cd pump-bot` | goes into the project folder |
| `npm ci --ignore-scripts` | installs the 4 libraries from `package-lock.json` and does **not** run the dependencies' helper scripts. Use `npm ci`, not `npm install`: that way the versions match the tested ones |
| `Copy-Item .env.example .env` | creates your personal `.env` config file (it does not go into git) |

> **Important:** `.env` is a personal file. It will hold the RPC address with your key.
> Do not send it to a chat, do not put it in screenshots and do not commit it to git.

---

## 3. RPC_URL: what it is and where to get it

### 3.1 The plain-words explanation

**RPC** (Remote Procedure Call) is a window into the blockchain. The bot does not keep a copy of the whole
Solana on your disk: it asks the RPC server for data (how much SOL is on the wallet?,
what events are in new blocks?).

**RPC_URL** is the address of such a server, which you put into `.env`.

### 3.2 Why you cannot use a free public address

Public addresses (`https://api.mainnet-beta.solana.com`) are fine for checking the balance once,
but not for a bot:

- they have hard request limits — the bot will get `429 Too Many Requests`;
- the event subscription (`logsSubscribe`, i.e. send me all new tokens)
  usually lags or does not work at all on public addresses;
- as a result the bot looks dead: the process is alive, but the console is silent.

That is exactly why `lib/config.mjs` **requires** an explicit `RPC_URL` and does not substitute
a public address by default.

### 3.3 How to get your own address

1. Pick an RPC provider: for example Helius (<https://helius.dev>), QuickNode,
   Triton or any other — the principle is the same.
2. Sign up and create a project/app in the provider's dashboard.
3. Copy the issued **HTTPS address**. It usually looks like this:

   ```
   https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
   ```

   Some providers pass the key as a separate header — then take
   the full URL from the dashboard, if it is there.

4. Helius has a free plan, but limits and terms change — **check
   the provider's current terms** before counting on a free plan.

> The key in the address is your paid (or quota-limited) access. It does not grant
> access to money, but it lets someone spend your quota. Do not publish it.

### 3.4 Where to put it

Open `.env` in an editor (Windows: `notepad .env`) and replace the line

```dotenv
RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_HELIUS_API_KEY
```

with your own:

```dotenv
RPC_URL=https://your-provider-address/?api-key=YOUR_KEY
```

Rules the code checks:

- the address must start with `http://` or `https://`, otherwise the bot will not start and
  will print `[config] ERROR: RPC_URL is required (must start with http:// or https://)...`;
- **you do not need to set WS_URL**: the WebSocket address (the persistent connection for events)
  is derived by the bot itself by replacing `https://` with `wss://`;
- `HELIUS_API_KEY` in the template is a separate optional variable; `RPC_URL`
  is enough to run.

### 3.5 How to check the address works

The fastest way is the monitor (it only reads, buys nothing):

```powershell
npm run monitor
```

If `NEW TOKEN #1 ...` lines appear within a minute, everything works.
If it is silent — see the Bot is silent section in
[errors-and-troubleshooting.md](errors-and-troubleshooting.md).

Stop the monitor: **Ctrl+C**.

---

## 4. The wallet

### 4.1 What a private key and a public address are

- **The public address** (public key) is like a bank account number. You can
  show it to everyone: it reveals the balance and history, but cannot spend money.
  In the examples below it is shown as `WALLET_EXAMPLE`.
- **The private key** (secret key) is like the signature that allows spending. Whoever
  got the key controls all the money at the address. Never show it
  to anyone.

In this project the private key lives **as a file on disk**. There is no password, no encryption,
no hardware wallet: read the file and you have the key.

### 4.2 Creating the wallet

`.env` must exist first (steps 2.1/2.2): `lib/wallet.mjs` reads the settings
from the same place and will not start without `RPC_URL`.

```powershell
node lib/wallet.mjs generate      # create a wallet with the default name
node lib/wallet.mjs show          # show the public address (offline)
```

The output will look roughly like this:

```
Generated keys/default.json
Public address: WALLET_EXAMPLE
```

Useful details (verified in the code):

- the wallet name is the file name: only Latin letters, digits, `_` and `-` are allowed;
- a repeated `generate` will **not overwrite** an existing file until you add
  `--force`. This guards against accidentally losing an already-funded wallet;
- on macOS/Linux the file gets `600` permissions (only your user reads it).
  **On Windows this restriction barely applies** — protect your account
  and do not sync the `keys/` folder to shared clouds.

### 4.3 Where exactly the key lives

```
keys/default.json
```

This is **not a seed phrase** (not 12 words). Inside there is an array of 64 numbers:

```json
[12, 34, 56, "... 61 more numbers ..."]
```

That array is the private key in the format Solana understands.

- the `keys/` folder is listed in `.gitignore` — git does not see it;
- to check: `git ls-files keys` must print **nothing**;
- **losing this file = losing the wallet.** It cannot be recovered: there is no support,
  no password reset. The money stays at the address, but you will not be able to use it.

### 4.4 If you need to show generation in a tutorial video or article

Do not create `keys/` inside the repository. Point to a temporary folder via the
`KEYS_DIR` environment variable — the code supports it:

```bash
# macOS / Linux
KEYS_DIR=/tmp/demo-keys node lib/wallet.mjs generate demo
```

```powershell
# Windows PowerShell
$env:KEYS_DIR="C:\Temp\demo-keys"; node lib/wallet.mjs generate demo
```

Just delete the temporary folder afterwards: no keys or junk remain in the repository.

### 4.5 Key-handling rules

1. **Never send** `keys/` to anyone — not to a chat, not in DMs, not to support.
2. **Never** paste the file contents into websites, forms or AI tools.
3. **Never** take a screenshot with the key file or `.env` open.
4. Make a **backup** of the file onto an offline medium (an encrypted USB stick,
   a password manager). Not the cloud and not email.
5. If the key did leak — treat the wallet as lost: create a new one and move
   the remainder there. A private key cannot be revoked.
6. Showing the public address is fine — it is safe.
7. **Do not use your main wallet.** Only a separate, throwaway one, with
   an amount you can afford to lose entirely.

---

## 5. A virtual run (dry-run): no money

### 5.1 What dry-run is and why it is safe

**Dry-run** (a virtual run) is a mode where the bot does everything
except the last step: it reads the blockchain, computes the price, makes decisions, writes
the journal — but **signs and sends no transaction**.

How it works in the code (`lib/config.mjs`):

```js
export const LIVE = argv.includes("--live") && !argv.includes("--dry-run");
export const DRY_RUN = !LIVE;
```

That is: until you add the `--live` flag, the bot runs in dry-run. This is the **default
mode**, and it needs neither money on the wallet nor a key with a balance.

### 5.2 Run 1: the monitor (read-only)

```powershell
npm run monitor
```

Example output (placeholders instead of real values):

```
[INFO] Monitoring pump.fun V3 for new tokens...
[INFO]   Press Ctrl+C to stop
[INFO] NEW TOKEN #1 MINT_EXAMPLE creator=WALLET_EXAMPLE dev buy 0.42 SOL
```

What it means: the bot saw a new token and shows who created it and how much SOL
the author bought first. Nothing is bought.

### 5.3 Run 2: the sniper in dry-run

```powershell
npm run sniper
```

What happens:

1. the bot subscribes to pump.fun events and catches new token creations;
2. it checks the filters (`SNIPER_MIN_DEV_BUY`, `SNIPER_MIN_HOLDERS` and others);
3. if the token passed — it buys virtually and tracks the position;
4. it exits on take profit, stop loss or timeout — also virtually.

Key lines in the output:

| Line | What it means |
|---|---|
| `skip: <reason>` | the token or trade was dropped; the reason is printed next to it. It costs no money |
| `buying 0.02 SOL -> ~123456 tokens` | the bot is about to buy; the token count is computed from the curve |
| `[DRY RUN] would buy — position tracked` | a **virtual** buy: the position is recorded, no transaction sent |
| `[DRY RUN] would sell: +12.3% net of costs (...)` | a **virtual** sale with the result after costs |
| `session: 3 trades, 2W/1L` | this session's trade counter |

> would buy means the bot would buy. It did not buy. If you see this line,
> the dry-run mode really is working.

![Example bot dry-run output: journal lines, addresses, amounts and percentages replaced with placeholders](img/dryrun-terminal.svg)

*This is an illustration, not a real log: `MINT_EXAMPLE`, `WALLET_EXAMPLE` and `0.00` stand in for
real values. Your output will differ, but the lines are recognizable.*

### 5.4 How to stop and what SESSION SUMMARY is

Press **Ctrl+C** once. The bot:

1. stops accepting new signals;
2. closes open positions (in dry-run — virtually, recording the reason `manual stop`);
3. prints the `SESSION SUMMARY` and exits.

Example summary (values are placeholders):

```
[INFO] SESSION SUMMARY — SNIPER
[INFO] ================================================================
[INFO]   mode            : DRY RUN
[INFO]   stopped         : manual stop (Ctrl+C)
[INFO]   duration        : 12m 3s
[INFO]   buys / sells    : 1 / 1
[INFO]   spent           : 0.020000 SOL
[INFO]   received        : 0.021000 SOL
[INFO]   NET result      : 0.001000 SOL
[INFO]   costs           : 0.000900 SOL  (pump 1%+1%, slippage, priority fee)
[INFO]   NET after costs : 0.000100 SOL
[INFO]   closed trades   : 1W / 0L
[INFO]   open at stop    : 0 position(s)
[INFO]   note            : spent/received are gross — network + priority fees not deducted
```

How to read it:

- **spent / received** — how much was given / how much came back (before network
  fees);
- **NET result** — received minus spent;
- **costs** — the fee estimate: 1% on entry, 1% on exit, slippage,
  the priority fee. This is the main reason why a plus on paper can
  turn into a minus in practice;
- **NET after costs** — the honest total with those fees included;
- in live mode it additionally prints the real wallet-balance difference and the list
  of **STUCK** positions (those that could not be sold).

A second Ctrl+C during the stop ends the process immediately — for the case when
something hangs.

### 5.5 Run 3: the lab (paper trading of variants)

```powershell
npm run lab
```

The lab subscribes to the same event stream and runs **several rule sets
at once**, each with its own virtual wallet. No money is spent,
no wallet is needed: it does not even load a key.

- it **refuses** the `--live` flag on purpose, with the message
  `lab.mjs is dry-run only: it never sends transactions. Remove --live.`;
- results are written to `data/research/variants/*.jsonl`, one file per variant;
- `npm run replay` can compare the variants against each other.

Important: one lab session proves nothing. It is data collection, not
proof that some setting is profitable.

### 5.6 Where the bot writes files

| Path | Who writes | What is inside |
|---|---|---|
| `data/journal/YYYY-MM-DD.jsonl` | sniper, graduation sniper, copy trader | one JSON line per decision and trade |
| `data/journal/ticks-*.jsonl` | sniper | the position's prices once a second (files rotate by size) |
| `data/journal/holders-*.jsonl` | sniper | how the holder count grew |
| `data/journal/.sniper.lock`, `.graduation.lock` | the bots | a PID lock: stops two identical bots from running on one folder |
| `data/journal/graduation-blacklist.json` | graduation sniper | tokens whose curve is already complete: we no longer buy them |
| `data/research/variants/*.jsonl` | the lab | one file per rule variant |
| `data/raw/*.jsonl.gz` | `npm run capture-raw` | raw events, compressed hourly |

The `data/` folder does not go into git (it is in `.gitignore`). Do not publish it to a public
repository: your addresses, amounts and results are there.

You can read the journal with:

```powershell
npm run journal
```

---

## 6. Money and live mode: why not to rush

<p align="center"><img src="img/modes.svg" alt="Modes diagram: top dry-run (signal, limits, exit calculation, journal, zero transactions), bottom live (plus simulation, signature and block confirmation)" width="100%"></p>


### 6.1 In the dry-run phase you need no money at all

- the wallet does not have to have a balance;
- transactions are not signed, so no fees are charged;
- all that is spent is time and RPC traffic.

The only thing you need is a working `RPC_URL`.

### 6.2 Why live is not for beginners

**Live** is the mode where the bot signs real transactions with the key from `keys/` and
sends them to the network. Real risks appear here:

- the price can drop between the decision and the send — you get fewer tokens;
- the sale may fail: the curve may not have the SOL to buy your tokens back;
- every failed-but-landed transaction **still** charges a fee;
- the key sits as a file on disk — leaking the file means losing all funds.

So the order is:

1. read [security.md](security.md) — it describes where the key lives, what
   the code does when signing and what must not be published;
2. run dry-run for more than an hour and look at the journal;
3. create a **separate** wallet and fund it with an amount you can afford
   to lose entirely;
4. start live only with the two switches (see 6.3).

### 6.3 Two switches (a guard, not a formality)

Live turns on **only** if two conditions hold at once:

1. the `--live` flag is on the command line;
2. the `LIVE_CONFIRM=yes` variable is set in the same shell.

Example for PowerShell:

```powershell
$env:LIVE_CONFIRM="yes"; npm run sniper -- --live
```

If you forget the second switch, the bot stops **before** connecting to the network:

```
[config] ERROR: --live requires LIVE_CONFIRM=yes. Set it for this run only, e.g. ...
```

The `--dry-run` flag cancels `--live`, even if both are given.

Why: a command copied from a chat with `--live` will not start spending money until
you deliberately set the variable in the current terminal session.

There is also an extra third switch for selling on AMM (after migration):
`LIVE_CONFIRM_AMM=yes`. Without it the bot does not send a PumpSwap sale — that
path is marked **unverified** on a real transaction in the code.

---

## 7. Glossary

| Term | What it means in plain words |
|---|---|
| **SOL** | the main coin of the Solana blockchain; the bot pays buys and fees in it |
| **lamport** | the smallest SOL unit: 1 SOL = 1,000,000,000 lamports. Internally amounts are counted in lamports to avoid losing precision |
| **dry-run** | a dry run: the bot counts and records everything but signs and sends no transaction |
| **live** | the live mode: transactions are signed with the real key and go to the network |
| **bonding curve** | the bonding curve: pump.fun's price formula — the more tokens are bought, the pricier the next one. It is not an order book |
| **graduation** (migration) | the moment the curve is full and the liquidity moves to the PumpSwap pool; after it, trading no longer goes through the curve |
| **slippage** | the difference between the expected and actual trade price; given in bps, where 500 bps = 5% |
| **take profit** (TP) | the rule sell when the price rose to a set multiple (for example 2.0×) |
| **stop loss** (SL) | the rule sell when the price fell to a set multiple (for example 0.5×), to cap the loss |
| **timeout** | the rule sell by time: if nothing happened for N seconds, the position closes |
| **RPC** | a relay server through which the bot reads the blockchain and sends transactions (see section 3) |
| **journal** | the `data/journal/*.jsonl` file where the bot writes every decision; one JSON record per line |

---

## 8. Common errors

The full list with explanations is in
[errors-and-troubleshooting.md](errors-and-troubleshooting.md). The most common:

| Symptom | What to do |
|---|---|
| `[config] ERROR: RPC_URL is required` | there is no `.env` file or `RPC_URL` is empty in it. Copy `.env.example` to `.env` and enter the address |
| `--live requires LIVE_CONFIRM=yes` | set `$env:LIVE_CONFIRM="yes"` (PowerShell) in this same session |
| `Keypair not found: ...\keys\default.json` | the wallet is not created: `node lib/wallet.mjs generate` |
| `FATAL: another sniper instance is already running` | a second sniper is already running. Close it with Ctrl+C: two bots on one journal folder will corrupt the accounting |
| `bigint: Failed to load bindings, pure JS will be used` | a **safe** library warning, nothing to do |
| The bot started, but the console is silent | most often you hit the RPC limit (429) or the public address does not serve events |
| `429 Too Many Requests` | the RPC quota is exhausted: wait, change the plan or the endpoint |

---

## 9. What next

- all parameters and defaults: [configuration.md](configuration.md);
- what each bot does and its risk: [bots.md](bots.md);
- all commands: [commands.md](commands.md);
- keys and the wallet in detail: [wallet-and-keys.md](wallet-and-keys.md);
- security: [security.md](security.md);
- what is verified and what is not: [verification-status.md](verification-status.md).

The order that removes most problems: **monitor → the sniper in dry-run →
the journal → and only then the live talk**.
