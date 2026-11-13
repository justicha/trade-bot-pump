# AUDIT_SELL — how the graduation sniper sells after migration (Step 1)

Date: 2026-11-10. Commit: `85a6963`. Method: code read-only + an offline review of `data/txcache`
(no network, no keys read, no transactions sent, no code changed).

Line references are as of `85a6963`.

---

## 0. Short conclusions

1. **The venue is chosen in two independent places** — `bots/graduation-sniper/graduation.mjs` and
   `scripts/rescue-sell.mjs` — with the same logic but different refusal branches.
2. **STUCK is set in 6 places**, and in three of them it is not a sell error but a refusal to try.
   The main one: the `LIVE_CONFIRM_AMM` gate (`graduation.mjs:553`) calls `markStuck` with `attempts = 0`,
   so the position is deleted **before** `SELL_MAX_ATTEMPTS` is used — this is the silent STUCK.
3. **`ammSellIx` is 21 accounts, discriminator `33e685a4017f83ad`**. The discriminator is **verified offline**:
   `sha256("global:sell")[0..8]` matches byte-for-byte (see §3).
4. **The account layout is NOT confirmed** and, judging by real data, **incomplete**: the cache holds
   4 real `buy_exact_quote_in` AMM instructions, each with **30 accounts**, including
   `global_volume_accumulator`, `user_volume_accumulator`, `fee_config`, `fee_program` + 7 tail accounts.
   Our sell build has none of these accounts (exactly the BUG 13 warning).
5. **The duplication is total**: `canonicalPool`, `readI128`, `decodePool`, `decodeGlobalConfig`,
   `pickProtocolFeeRecipient`, `ammSellIx` and three PDA constants exist in two copies
   (`lib/pumpswap.mjs` and `scripts/rescue-sell.mjs`) and are **identical line by line**.
6. **A pre-send simulation already exists** on both paths (`simulateTx`), but the journal writes the result
   only on failure; there is no pre-send record of simulation passed, expecting X SOL.
7. **`readExecution` counts the rent of a closed WSOL-ATA as revenue** (+0.00203928 SOL to `solReceivedSol`),
   and the AMM branch creates and closes the WSOL-ATA in the same transaction → the AMM-sell PnL will be overstated,
   unless it is subtracted (related to BUG 09, which is deferred).
8. **There is no IDL file in the repository.** All by-the-official-pump-amm-IDL claims are comments;
   the bytes and account order cannot be verified from the repository (see §6, what is missing).

---
## 1. How the venue is chosen

### 1.1 The bot (`bots/graduation-sniper/graduation.mjs`)

The entry point is `checkExit()` (`:429`). It is called from `monitorPositions()` (`:710`) every
`POLL_MS = 3000` ms and from `finish()` on stop (`:763`).

| Curve condition (`getBondingCurveState`, `:437`) | What the bot does |
|---|---|
| `state` exists, `!state.complete` | computes `ratio = calcSellSol(tokens) / entryLamports` and decides TP / SL / timeout (`:457`, `:460`, `:463`) → `sellPosition()` |
| `!state` | `:438` → logs bonding curve gone (graduated?) — PumpSwap route → `sellPosition()` |
| `state.complete` | `:443` → logs *** GRADUATED! *** selling on PumpSwap → `sellPosition()` |

Then **inside** `sellPosition()` (`:489`) the venue is decided again, from the wallet data (`:524`):

```
state && !state.complete   -> venue = "curve"      (:527)
otherwise                  -> venue = "pumpswap"   (:551)
```

* **curve**: `planSellParts(state, total, { capRatio: 0.95, minPartRaw: 1_000_000n })` (`:529`).
  If `parts.length === 0` → STUCK (§2, item 1). Otherwise the **first part** is sold (`:534`), the rest
  stays in the position (`:545` only logs).
* **pumpswap**: the gate (`:553`) → `ammSellQuote(connection, mint, total)` (`:557`); `null` → STUCK (§2, item 3);
  otherwise `ammSellIx` + `computeBudgetIxs` + the idempotent WSOL-ATA + `closeAccount` (`:565-570`).

### 1.2 Rescue (`scripts/rescue-sell.mjs`)

`quoteVenue()` (`:163`) — the same fork, but with a different set of outcomes:

| Condition | Result |
|---|---|
| `state && !state.complete` | `venue: "curve"`, `sellable: parts.length > 0` (`:177`, `:180`) |
| no/broken pool (`!pi \|\| pi.data.length < 287`) | `venue: "none"`, `sellable: false` (`:189`) |
| pool exists, vaults unreadable | `venue: "pool"`, `sellable: false`, note `vaults unreadable` (`:196`) |
| pool exists, vaults readable | `venue: "pool"`, `sellable: true`, `expectedSol` (`:208-215`) |

### 1.3 curve/pool differences between the bot and rescue

| Aspect | Bot | Rescue |
|---|---|---|
| Pool exists, vaults unreadable | `ammSellQuote` → `null` → **STUCK `no venue`** | `venue: "pool"`, `sellable: false`, a separate text |
| How many curve parts are sold | **only the first** (`:534`), the rest waits for the next cycle | **all parts in order** (`:291-310`) |
| `getBondingCurveState` retries | 1 attempt | 3 attempts (`:165`) |
| `getAccountInfo(AMM_GLOBAL_CONFIG)` | `.catch(() => null)` (`pumpswap.mjs:133`) | **without `.catch`** (`:201`) → an exception will drop the loop |

---

## 2. STUCK conditions (all places)

| # | Line | Condition | Journal | Position |
|---|---|---|---|---|
| 1 | `:531` | the curve cannot pay a single part (`plan.parts.length === 0`) | `stuck` + `attempts` | deleted |
| 2 | `:554` | `LIVE && LIVE_CONFIRM_AMM !== "yes"` **and** the curve is complete | `stuck`, `attempts: 0` | deleted |
| 3 | `:559` | `ammSellQuote` returned `null` (no pool / vaults unreadable) | `stuck`, `attempts: 0` | deleted |
| 4 | `:597` | the simulation failed and `attempt >= SELL_MAX_ATTEMPTS` | `sell_attempt` + `stuck` | deleted |
| 5 | `:701` | the send failed and `attempt >= SELL_MAX_ATTEMPTS` | `sell_failed` + `stuck` | deleted |
| 6 | `:775` | the session stopped and the position was still open | `stuck` (`reason: "open at stop"`) | deleted |

Problems this creates:

* **items 2 and 3 are not attempts**: `pos.attempts` is not incremented, `pos.nextSellAt` is not
  set, `SELL_MAX_ATTEMPTS` does not apply. The position vanishes from `positions` on the very first
  migration detection (in a real journal: buy `16:52:45` → stuck `16:53:03`, `attempts: 0`).
* **the retries stopped wording is false** for items 2/3: there were no retries at all (`:485`).
* **accounting**: `markStuck` calls `session.drop()` (`:474`), `spentSol` stays, `receivedSol` does not,
  so in the report (`lib/session.mjs:138`) such a position looks like a full loss, although the tokens
  sit in the wallet and are worth something.
* **the reason is not in the journal as data**: `reason` is a string with no venue, no token amount,
  no simulation logs (only `tokens` and `attempts`).

---
## 3. What is passed into `ammSellIx` and from where

`lib/pumpswap.mjs:145`. Arguments: `(user, baseMint, pool, p, g, baseAmountIn, minQuoteOut)`.

### 3.1 Instruction data (24 bytes)

| Offset | Field | Source |
|---|---|---|
| `0..8` | discriminator `33e685a4017f83ad` | a constant in the code (`:175`) |
| `8..16` | `base_amount_in` (u64 LE) | `total` — the token balance from `getTokenAccountBalance` (`graduation.mjs:516-517`) |
| `16..24` | `min_quote_amount_out` (u64 LE) | `quote * (10000 - slip) / 10000`, `slip = min(SELL_MAX_SLIPPAGE, 500 * 2^(attempt-1))` (`:511`, `:563`) |

**Offline discriminator check (done in this audit, no network):**

```
sha256("global:sell")[0..8]               = 33e685a4017f83ad   <- matches the code
sha256("global:buy")[0..8]                = 66063d1201daebea
sha256("global:buy_exact_quote_in")[0..8] = c62e1552b4d9e870   <- matches the 4 real tx in data/txcache
```

The third line matters: it proves that (a) the cache holds real PumpSwap instructions,
(b) the Anchor-discriminator rule works here, so the first line is not invented from memory.

### 3.2 The 21 accounts

| # | Account | W/S | Value source |
|---|---|---|---|
| 0 | `pool` | w | `canonicalPool(mint)` — PDA `["pool", u16(0), pool_authority, mint, WSOL]` (`:58`) |
| 1 | `user` | sw | `wallet.publicKey` |
| 2 | `global_config` | r | PDA `["global_config"]` (`:48`) |
| 3 | `base_mint` | r | an argument |
| 4 | `quote_mint` | r | `p.quoteMint` — `decodePool` @75 |
| 5 | `user_base_token_account` | w | ATA(baseMint, user, Token-2022) |
| 6 | `user_quote_token_account` | w | ATA(quoteMint, user, SPL Token) |
| 7 | `pool_base_token_account` | w | `p.baseVault` @139 |
| 8 | `pool_quote_token_account` | w | `p.quoteVault` @171 |
| 9 | `protocol_fee_recipient` | w | **`pickProtocolFeeRecipient(g, p.isMayhem)` — a random one from the list** (`:108`) |
| 10 | `protocol_fee_recipient_token_account` | w | ATA(quoteMint, feeRecipient, SPL Token) |
| 11 | `base_token_program` | r | `TOKEN_2022_PROGRAM` |
| 12 | `quote_token_program` | r | `TOKEN_PROGRAM` (WSOL) |
| 13 | `system_program` | r | a constant |
| 14 | `associated_token_program` | r | a constant |
| 15 | `event_authority` | r | PDA `["__event_authority"]` (`:49`) |
| 16 | `program` | r | `PUMPSWAP_PROGRAM` |
| 17 | `coin_creator_vault_ata` | w | ATA(quoteMint, creatorAuth, **allowOwnerOffCurve = true**) |
| 18 | `coin_creator_vault_authority` | r | PDA `["creator_vault", p.coinCreator]` (`:147`) |
| 19 | `fee_config` | r | PDA `["fee_config", PUMPSWAP_PROGRAM]` in the `pfee…` program (`:50`) |
| 20 | `fee_program` | r | `pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ` |

`p` sources (PoolState, `decodePool` `:71`): `baseMint@43`, `quoteMint@75`, `baseVault@139`,
`quoteVault@171`, `coinCreator@211`, `isMayhem@243`, `isCashback@244`, `virtualQuoteReserves@245` (i128),
`creatorFeeBps@261`. `g` sources (GlobalConfig, `decodeGlobalConfig` `:92`): `lpFeeBps@40`,
`protocolFeeBps@48`, `protocolFeeRecipients[8]@57`, `coinCreatorFeeBps@313`, `reservedFeeRecipient@385`,
`reservedFeeRecipients[8]@418`, `buybackFeeRecipients[8]@675`.

### 3.3 The quote (`ammSellQuote`, `:117`)

```
gross  = quoteVaultBalance + virtualQuoteReserves            (:129)
out    = gross * raw / (baseVaultBalance + raw)              (:130)
feeBps = lpFee + protocolFee + (pool.creatorFeeBps ?? coinCreatorFeeBps)   (:136)
net    = out * (10000 - feeBps) / 10000                      (:137)
```

This is **not verified** against the program's real math (there is no sell-tx to compare).
If the formula overstates `net`, the transaction will drop on simulation on `min_quote_amount_out` (safe,
but the sale will not go through). `TODO(verify)`.

### 3.4 Offline comparison against real transactions (`data/txcache`, 4 files)

The real `buy_exact_quote_in` instruction (discriminator `c62e1552b4d9e870`), 30 accounts, one shared frame:

| Index | What | Comment |
|---|---|---|
| 0 | pool | matches across two tx with the same base mint |
| 1 | user (signer) | |
| 2 | `global_config` | **our PDA confirmed** |
| 3 | WSOL (quote mint) | |
| 4 | base mint | in all 4 cases **not a pump-mint** (two `…bonk`) |
| 11 | SPL TOKEN | |
| 12 | Token-2022 | the order is **reversed** vs our sell build (ours has 11 = 2022) |
| 13 | SYSTEM | |
| 14 | ATA program | |
| 15 | `event_authority` | **our PDA confirmed** |
| 16 | PumpSwap program | |
| 19 | **`global_volume_accumulator`** | PDA `["global_volume_accumulator"]` — **matched** |
| 20 | **`user_volume_accumulator`** | PDA `["user_volume_accumulator", user]` — **matched** for all 4 |
| 21 | `fee_config` | **our PDA confirmed** |
| 22 | `fee_program` | |
| 23..29 | 7 tail accounts | absent in our build |

Conclusions that can and cannot be drawn:

* **Can**: the sell discriminator is correct; the `global_config`, `event_authority`, `fee_config` PDAs are correct;
  the PDA rule for the volume-accumulator is confirmed on real data.
* **Can**: in the deployed program the v1 instruction carries volume-accumulator accounts that
  our 21-account build lacks → a high chance that `sell` without them will not go through
  (that is BUG 13, but now with facts, not a hypothesis).
* **Cannot**: claim that the 11/12 order for sell is the same as for `buy_exact_quote_in` — these
  are different instructions. The cache has **not a single** sell transaction.
* **Cannot** use these 4 pools to check `canonicalPool`: the base mints are not pump, they look
  like pools with their own `pool_authority` → `canonicalPool()` gives 0/4 matches, but that is **not**
  proof of a bug. Checking `canonicalPool` needs one query for a known
  graduated pump-mint (`TODO(verify)`).

---
## 4. `lib/pumpswap.mjs` vs `scripts/rescue-sell.mjs` — what matches and what diverges

| Function / constant | lib | rescue | Identity |
|---|---|---|---|
| `canonicalPool` | `:58` | `:109` | **identical** |
| `readI128` | `:66` | `:117` | **identical** |
| `decodePool` | `:71` | `:124` | **identical** (all offsets) |
| `decodeGlobalConfig` | `:92` | `:142` | **identical** |
| `pickProtocolFeeRecipient` | `:108` | `:156` | **identical** |
| `ammSellIx` | `:145` | `:219` | **identical**: the same 21 accounts in the same order, the same 24 bytes; the only difference is cosmetic (in rescue `creatorVaultAta` is extracted into a variable `:225`) |
| `AMM_GLOBAL_CONFIG` / `AMM_EVENT_AUTH` / `AMM_FEE_CONFIG` / `AMM_FEE_PROGRAM` | `:47-53` | `:46-52` | **identical** |
| `TOKEN_PROGRAM` | exported (`:55`) | declared locally (`:54`) | a duplicate |
| Pool quote | `ammSellQuote` (`:117`) | inlined in `quoteVenue` (`:191-206`) | the formula is the same; rescue does **not** wrap `getAccountInfo(AMM_GLOBAL_CONFIG)` in `.catch` |
| The pool-exists-vault-missing error | `null` → `no venue` | `sellable:false` + a text | different behaviour |
| SOL→lamports conversion for `min_out` | `BigInt(quote)` from `solOut` | `BigInt(Math.floor(expectedSol * 1e9))` (`:313`) | rescue loses precision on the float |

Total: **~150 lines are duplicated line by line**. Any layout change must be made in two
places — that is the reason for Step 2.

---

## 5. What already exists for a verifiable sale and what does not

| Step 3/4 requirement | State |
|---|---|
| Pre-send simulation | **exists** in the bot (`:575` for curve and pool) and in rescue (`:303`, `:323`) |
| Do not send on a simulation error | **exists**: `if (!sim.ok) { ... return; }` |
| The simulation error in full into the journal | **partially**: it writes `error: describeTxError(sim.err)` (`:593`), but it does **not** write `sim.logs` (that is where the cause is: `Program log: …`) nor `unitsConsumed` |
| The expected output into the journal **before** the send | **no**: `quoteOut` only lands in the post-send record (`trade`) or the failure record (`sell_attempt`) |
| `DRY_SELL=yes` (simulate, write, do not send) | **no** |
| Do not delete the position until attempts run out | **no** for items 2/3 (§2) |
| A clear status instead of retries stopped | **no**: the text is static (`:485`) |
| Accounting for the closed WSOL-ATA rent | **no**: `solReceivedSol = solDelta / 1e9` (`exec.mjs:38`), and the AMM branch creates+closes the ATA in one tx → `+0.00203928 SOL` to revenue |

---

## 6. What is missing (not inventing)

1. **There is no IDL file in the repository.** Neither `pump_amm.json` nor `pump.json`. All the 21-accounts-by-IDL —
   are comments. Independently verifying the `sell` account list/order from the repository is **impossible**.
   Options for a human: (a) put `pump_amm.json` (the official `@pump-fun/pump-sdk/idl/`) into
   `data/idl/` and enable an IDL test parser; (b) one **read-only** simulation on a real mint
   (not a send) and send the logs.
2. **There is not a single real sell transaction** in `data/txcache` or the journals — only `buy_exact_quote_in`.
3. **No `canonicalPool` confirmation** on a pump-mint (see §3.4).
4. **The purpose of the 7 tail accounts** of the real instruction is unknown, and `[17]`/`[18]`
   to `coin_creator_vault_*`.
5. **The AMM exit math is unknown** (the §3.3 formula is unverified).

All of the above is `TODO(verify)` and does not block steps 2, 4, 5; it **blocks** the promise the bot will sell
after migration (step 3 without items 1/2 from this list yields only an honest simulation refusal).

---

## 7. The plan for the next steps (nothing done yet)

| Step | Files | Essence | Risk |
|---|---|---|---|
| 2 | `lib/pumpswap.mjs`, `scripts/rescue-sell.mjs` | rescue imports `canonicalPool`, `decodePool`, `decodeGlobalConfig`, `pickProtocolFeeRecipient`, `ammSellIx`, `TOKEN_PROGRAM` from `lib/pumpswap.mjs`; the local copies are deleted. The layout does not change. | low: behaviour is identical, covered by a new equality test |
| 3 | `graduation.mjs` | before `sendTxWithRetry` for venue `pumpswap`: journal `sell_sim` with `ok`, `quoteOut`, `unitsConsumed`, `logs` — **before** the send; on `!ok` a full dump and `return`. The `DRY_SELL=yes` flag: only in LIVE mode, simulation + journal, no send. | medium: touches the live path → covered by a test with a mock RPC |
| 4 | `graduation.mjs` | the gate/no-pool no longer delete the position: `attempts` increments, `nextSellAt` backoff, `stuck` only when `attempt >= SELL_MAX_ATTEMPTS`; `reason` holds venue, tokens, cause; the ALERT text without retries stopped for items 2/3. | medium: changes the monitor behaviour (the position hangs longer) |
| 5 | `scripts/pumpswap-ix.test.mjs` (new) | a byte comparison of `ammSellIx` on fixed `g`/`p`, the list and order of the 21 accounts; a venue-selection test with a mock `connection`. | low |
| 6 | `AUDIT_SELL.md` | instructions for a human: how to run `DRY_SELL=yes`, what to enable for live, which `TODO(verify)` to close. | — |

---

## 8. TODO(verify) — only what cannot be verified without a human/network

| # | What | How to verify |
|---|---|---|
| V1 | The `sell` layout (21 accounts) matches the deployed program | ~~One `simulateTransaction`~~ — **started passing**: the `HbZM3fVa…pump` simulation reached the program's last check (see §12), all CPIs before it passed |
| V2 | Whether `global_volume_accumulator` + `user_volume_accumulator` are needed in `sell` (BUG 13) | So far **no**: the program did not complain about their absence (it falls later, on `pool_v2`). A fully successful simulation is needed |
| V3 | `canonicalPool()` gives the right address for a pump-mint | **Confirmed** by simulation: `canonicalPool(HbZM3fVa…pump) = 86rSR66f…xqS7`, the account exists and decoded (§12) |
| V4 | The `ammSellQuote` formula matches the program (fee split, virtual reserves) | Compare `net` against the logs of a successful sell simulation / a real sell-tx |
| V5 | `createCloseAccount` does not overstate PnL (the ATA rent) | Subtract the rent from `solReceivedSol` and confirm the arithmetic on a real tx |
| V6 | The 11/12 order (`base_token_program`, `quote_token_program`) for `sell` | **Confirmed**: `TransferChecked` Token-2022 (account 11) and SPL Token (12) passed in the simulation |
| V7 | `pool_v2` — which account and by which seeds | **The seeds are confirmed by the official SDK** `@pump-fun/pump-sdk@4.3.1`: `PDA(["pool-v2", baseMint])`, passed as a remaining account of the sell (see §13). Still to be confirmed by simulation |


---

## 9. What changed (steps 2–7) — cross-checked against §2 and §5

| # | Was | Became |
|---|---|---|
| 2 | `canonicalPool`, `decodePool`, `decodeGlobalConfig`, `pickProtocolFeeRecipient`, `ammSellIx` + the PDA constants were duplicated in `lib/pumpswap.mjs` and `scripts/rescue-sell.mjs` | one module `lib/pumpswap-sell.mjs`; `lib/pumpswap.mjs` re-exports, `scripts/rescue-sell.mjs` imports. The account layout and bytes **did not change** |
| 2 | in rescue a local `TOKEN_PROGRAM`, `getAccountInfo(AMM_GLOBAL_CONFIG)` without `.catch`, `min_out` via `Math.floor(expectedSol*1e9)` | a shared `TOKEN_PROGRAM`, `.catch(() => null)`, `min_out` from BigInt lamports (`expectedLamports`) |
| 3 | the journal wrote only the simulation error text, no logs; on a successful simulation — nothing | a new `lib/amm-sell.mjs`: before the send it writes `sell_sim` (expected SOL, `min_out`, CU, logs) or `sell_attempt` (the error + **all** logs + `unitsConsumed` + the raw `err`) |
| 3 | there was no flag | `DRY_SELL=yes` — build + simulation + journal (`sell_dry`), `sendTransaction` is never called under any condition |
| 4 | the `LIVE_CONFIRM_AMM` gate and no pool called `markStuck` at `attempts = 0` → the position vanished | `deferSell()`: `attempts += 1`, backoff `2s·2^(n-1)`, the position **stays**; `stuck` only when `attempt >= SELL_MAX_ATTEMPTS`. The gate still forbids sending when `LIVE_CONFIRM_AMM !== "yes"` |
| 4 | `ALERT … retries stopped` without a reason and a counter | `STUCK (venue=… attempts=N/3): cause — retries stopped after N/3 attempts`; the phrase only when the attempts really ran out |
| 4 | `solReceivedSol = solDelta` (the WSOL-ATA rent landed in revenue) | the rent is subtracted if the WSOL account existed **before** the tx and is closed in it: `rentReturnedSol` in the result, `solReceivedSol` is revenue only |
| 5 | there were no tests for the sell instruction | `scripts/pumpswap-sell.test.mjs` (24 bytes, `33e685a4017f83ad`, 21 accounts, order/flags, PDA) and `scripts/amm-sell.test.mjs` (the gate, no pool, simulation logs, `sell_sim` before the send, `DRY_SELL` does not send) — the network and `sendTransaction` are mocked |

New journal record types: `sell_sim`, `sell_dry`, `sell_deferred` (plus the previous
`sell_attempt`, `sell_failed`, `stuck`, `trade`).

---

## 10. How to verify

### 10.1 DRY_SELL without `--live` (safe, spends no money)

In DRY RUN the bot buys nothing for real, but with `DRY_SELL=yes` for every position whose
bonding curve completed, it **builds and simulates a real PumpSwap sell** and writes
the result into the journal.

```
$env:DRY_SELL="yes"; npm run graduation
```

`LIVE_CONFIRM` and `LIVE_CONFIRM_AMM` are not needed in this mode: there is nothing to send, the gate is checked
only on the live path.

What to look for in `data/journal/<date>.jsonl`:

| `type` | When it appears | Key fields |
|---|---|---|
| `sell_sim` | the simulation passed | `mint`, `expectedSol`, `minOut`, `unitsConsumed`, `logs` |
| `sell_attempt` | the simulation failed | `error`, `logs` (full), `unitsConsumed`, `errorRaw` |
| `sell_dry` | the send is forbidden by the flag | `reason: "DRY_SELL=yes"` |

A quick filter for the mints you need:

```
Select-String -Path data\journal\*.jsonl -Pattern '"type":"sell_(sim|attempt|dry)"' |
  ForEach-Object { $_.Line } | Select-String -Pattern '322es1iMfE|48e5Btne|HbZM3fVa'
```

The mints from the STUCK journal where this makes sense:
`322es1iMfEghyuqi6Hby3eLkMsbfAKBCacmiZqG8pump`,
`48e5BtneVunFTZDo96TvEPsG3YquCSizMoowUaTZpump`,
`HbZM3fVa7XWGbLPzvdZykDX1mtjPJw9UUE8fVg3Wpump`.

### 10.2 Probing one simulation (V1/V2/V3/V4)

```
node scripts/probe-sell-sim.mjs --mint 322es1iMfEghyuqi6Hby3eLkMsbfAKBCacmiZqG8pump
```

The key is needed only to read the balance and ATA; the transaction is **not sent**, the script has no `--live`
flag. It prints `err`, `describeTxError`, `unitsConsumed` and all the logs, and also writes
`data/probe/sell-sim-<mint>-<ts>.json` (the 21-account layout, reserves, the quote).
The sent file closes V1/V2/V4: `err: null` means the layout was accepted by the program.
If the wallet has no tokens of this mint: `--tokens <raw>` substitutes the amount.

### 10.3 DRY_SELL on the live path (simulation, no send)

```
$env:LIVE_CONFIRM="yes"; $env:LIVE_CONFIRM_AMM="yes"; $env:DRY_SELL="yes"; npm run graduation -- --live
```

Note: `DRY_SELL` disables only the **PumpSwap sell**. LIVE buys stay
real. The run is needed to see `sell_sim` for a real position.

### 10.4 What a human does to enable a real post-migration sell

1. Put the IDL in place: `data/idl/pump_amm.json` (the official `@pump-fun/pump-sdk/idl/`).
   Without it the account layout stays copied rather than verified (V1/V2/V6).
2. Run 10.2 on one or two mints and send the JSON. `err: null` → the layout is correct;
   `InstructionError` + `Custom` in the logs → an account is missing (for example a v2 instruction with
   a volume accumulator) or the quote diverges.
3. If the simulation is `Ok` but `expectedSol` clearly differs from the real output — that is V4
   (the `ammSellQuote` formula), fixed separately.
4. Run 10.3 on a cheap position and confirm the journal has `sell_sim` and no `trade`.
5. Only after that — a live exit of one position:
   `$env:LIVE_CONFIRM="yes"; $env:LIVE_CONFIRM_AMM="yes"; npm run graduation -- --live`,
   then look in the journal for `trade` with `venue: "pumpswap"`.
6. Compare `solReceived` with `quoteOut` and `rentReturnedSol` (V5): a ≈0.00204 SOL gap means
   the rent is still counted as revenue.
7. Keeping `LIVE_CONFIRM_AMM=yes` in `.env` permanently is a human's decision, not a code default.

`scripts/rescue-sell.mjs` uses the same module and the same gate: without `LIVE_CONFIRM_AMM=yes` it
does not send an AMM sell, but now shows the price and does not crash on an unreadable global config.

---

## 11. What needs to be put into the project

| File | Why |
|---|---|
| `data/idl/pump_amm.json` | the only way to verify V1/V2/V6 without a real transaction; once present, an IDL test parser can be added to check the layout automatically |
| result `data/probe/sell-sim-*.json` | closes V1/V2/V4 with the actual simulation logs |

Until these files exist, all claims about the `sell` layout stay `TODO(verify)`, and in the code
they are marked exactly so: `lib/pumpswap-sell.mjs`, `lib/amm-sell.mjs`, `lib/exec.mjs`.

---

## 12. The 23–29 account tail in the cache and `pool_v2` (Custom 6062)

Trigger: the sell simulation fell with `Custom 6062` —
`AnchorError … sell.rs:520. Error Code: InvalidPoolV2. Error Message: pool_v2 remaining account is missing or invalid.`
Below is an offline review of `data/txcache` (no network used).

### 12.1 What is in the cache

45 files, **8** pump-amm instructions: 4 top-level `buy_exact_quote_in`
(`c62e1552b4d9e870`) and 4 inner with `e445a52e51cb9a1d`. **Not a single `sell`** (`33e685a4017f83ad`).

Four buy transactions (30 accounts each), the 23–29 tail:

| # | `2J7G…` mint `CsXAT9bd…bonk` | `w3wr…` the same mint | `4g5e…` mint `BWRfm9hQ…BAGS` | `XYqs…` the same mint |
|---|---|---|---|---|
| 23 | `A7hAgCzFw14fejgCp387JUJRMNyz4j89JKnhtKU8piqW` | `A7hAgCzFw14fejgCp387JUJRMNyz4j89JKnhtKU8piqW` | `A7hAgCzFw14fejgCp387JUJRMNyz4j89JKnhtKU8piqW` | `A7hAgCzFw14fejgCp387JUJRMNyz4j89JKnhtKU8piqW` |
| 24 | `4Kj7f6xDK7fY5FTRg54Fv54Fbr8kU6WopqbPpbyTBNaG` | `4Kj7f6xDK7fY5FTRg54Fv54Fbr8kU6WopqbPpbyTBNaG` | `2fvib34wVq9o9r7Lh2859qMXQN8J7F1csu4fKNwESVe4` | `2fvib34wVq9o9r7Lh2859qMXQN8J7F1csu4fKNwESVe4` |
| 25 | `DGKJQb7jFBW2LyoMkXeiP3sTwtPdk1v12EPo2Chn8rLC` | `2F7TtCdYFWf2byGcmWtHxiGTQB16UtB8QEcrH8y68Xxm` | `4Kt1FyUddPhUnDQ8jPMB36Wh6QMdkiRYvBRp1gMLe6SA` | `2h48vurxfTuQJenpmu2NQTtqxRDGza3q5DiRfz14nxSG` |
| 26 | `QSSe7JvehvPVHpXM5qcCoRAKKLFXXzYDoWYBfX2XDwe` | `4rVk3JEomWFbcHCBj8NAjPRiPvsyY17cJ5QZSQfpAiBP` | `4X23ff48xTc4ndGfwAbaUnRNbUMmidee9f2F9VNF5KQg` | `ANGGw4Gpjyw1tjEkv9ppw8zsqbbMR6akzqqsFjeDYhDz` |
| 27 | `2F7TtCdYFWf2byGcmWtHxiGTQB16UtB8QEcrH8y68Xxm` | `QSSe7JvehvPVHpXM5qcCoRAKKLFXXzYDoWYBfX2XDwe` | `AS8UtAqa2GupxGtSxq1qoXZzpUtj2Xf2FSPpHthKdUYY` | `2F7TtCdYFWf2byGcmWtHxiGTQB16UtB8QEcrH8y68Xxm` |
| 28 | `AS8UtAqa2GupxGtSxq1qoXZzpUtj2Xf2FSPpHthKdUYY` | `Dmk8Tjf7xbELmeg4j3v8sCmx7tYNLeNwCxbeBqfia4Py` | `CuTAMm6heSx6SmEJxfxGbRdtkBQmHgYXjDtyQWQQUT9Z` | `DGKJQb7jFBW2LyoMkXeiP3sTwtPdk1v12EPo2Chn8rLC` |
| 29 | `CuPNrTwAqj3iew3LwWDNxp6GdJcQcQSDjTDf7ZqkYGeJ` | `HbPR3bpDR8WxsqgBu6QUAZcEXhUJrdChvBt7UWyz8M82` | `2F7TtCdYFWf2byGcmWtHxiGTQB16UtB8QEcrH8y68Xxm` | `8DQ7vtN8frGsv7jpH2sUsrdUfXJLTnKcPabjiURhUsYC` |

### 12.2 Checking against `PDA["pool-v2", baseMint]`

| mint | PDA `["pool-v2", baseMint]` (the `pAMM…` program) | In the tx? |
|---|---|---|
| `CsXAT9bdaopT4o6SwJXm195LxGGwS1x8JhBht5WVbonk` | `5qLmRndbmBL8P2N3BJy4tarzoyuq34gjvk1KrL8YyVtv` | **no** (neither in `2J7G…` nor in `w3wr…`) |
| `BWRfm9hQQdqi3TNM3CoyNTWANd375qcrDduEW9cGBAGS` | `4CgJNST7r2cKWiFv7zcozWkvAFqhCahLY1zfbTxnBmLi` | **no** (neither in `4g5e…` nor in `XYqs…`) |

Additional seed variants were checked — no address appears among the 30 accounts:
`["pool_v2", mint]`, `["pool-v2", pool]`, `["pool-v2", mint, WSOL]`,
`["pool-v2", poolAuthority, mint, WSOL]`, `["pool-v2", u16(0), poolAuthority, mint, WSOL]`,
`["pool-v2", pool, mint]` — in the `pAMM…` and `6EF8…` programs.

**Result: no match.** `pool_v2` is not added to `ammSellIx`: substituting an unconfirmed
address is not allowed (it would be an invented account).

### 12.3 Why this tail cannot be a reference at all

* Two transactions with the **same** mint (`CsXAT9bd…`) match only at [23] and [24];
  [25]–[29] are different addresses and a different set, not a permutation. The program layout cannot
  behave that way.
* `A7hAgCzF…` appears in **9 of 45** cache files, `2F7TtCdY…` in **17 of 45**: these are common
  (router) accounts of the caller, not per-pool.
* Conclusion: 23–29 are `remaining_accounts` passed by the caller; the v1
  `buy_exact_quote_in` instruction does not validate them. For `sell` (the v2 path) the program reads and requires
  `pool_v2` — but buys do not have it at all, so the cache can confirm neither the address nor the seeds.

### 12.4 What is nevertheless explained from the tail (the §3.4 question)

| # | Value | What it is (verified by PDA derivation) |
|---|---|---|
| 15 | `GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR` | `PDA["__event_authority"]` in `pAMM…` — matched |
| 19 | `C2aFPdENg4A2HQsmrd5rTw5TaYBX5Ku887cWjbFKtZpw` | `PDA["global_volume_accumulator"]` **in `pAMM…`** (not in pump.fun!) — matched |
| 20 | `3AK4sQmR…` / `8SyMEec…` / `8zfC5PV…` / `BnSd4t8L…` | `PDA["user_volume_accumulator", user]` in `pAMM…` — its own in each tx, matched |
| 21 | `5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx` | `PDA["fee_config", pAMM…]` in the `pfee…` program — matched |
| 23 | `A7hAgCzFw14…` | no checked seed yields this address; 9/45 files → a common caller account |
| 24 | `4Kj7f6xDK7…` / `2fvib34wVq…` | stable for one mint (two tx) → mint-scoped, but **not** `pool_v2` under any seed variant |
| 25–29 | … | differ between two tx of one mint → not part of the program layout |

A clarification to §3.4: it said earlier that `global_volume_accumulator` and `user_volume_accumulator`
matched — now it is clear they are derived **under the `pAMM…` program**, not under `6EF8…`.

### 12.5 What the simulation itself gave (`data/probe/sell-sim-HbZM3fVa-…json`)

| Field | Value |
|---|---|
| mint | `HbZM3fVa7XWGbLPzvdZykDX1mtjPJw9UUE8fVg3Wpump` |
| pool (`canonicalPool`) | `86rSR66fVQX8K6pqWuPLXjvUNWFXfdyEiA5LzyUpxqS7` — the account exists, `PoolState` decoded |
| creator | `xgzHcG76hChWvMungAAjMS41t5AvN1ktVtJghB8C8yp`, `creatorFeeBps=0`, `isMayhem=false`, `isCashback=false` |
| result | `InstructionError[3, Custom 6062]`, 68 929 CU |
| passed successfully | `pfee GetFeesWithQuoteMint`, `Token-2022 TransferChecked` (the base mint), two SPL Token calls |

The log order matters: the program managed to debit the tokens via our accounts and **only at the very end**
(`sell.rs:520`) required `pool_v2`. So:

* **V1/V3/V6 are closed positively** — the 21 accounts and their order (including 11 = Token-2022,
  12 = SPL Token) are accepted, the pool was found correctly;
* **V2 so far leans to not needed** — the program did not complain about the missing volume-accumulator;
* **V7** remains: `pool_v2` as a remaining account.

### 12.6 What is needed to close V7 (without guessing)

1. `data/idl/pump_amm.json` → the `PoolV2` type/structure and its seeds. This is the only offline path.
2. Or one **read-only** check of candidate addresses: `getAccountInfo` for
   `PDA(["pool-v2", mint])` and related variants on a real pool — the account existing
   with owner `pAMM…` would confirm the seeds (network, but no transaction sent).
3. Or one real `sell` transaction from the network: the cache has **none**, so there is nothing to compare.

Until then `pool_v2` is **not added** to `ammSellIx`: the layout stays 21 accounts, and the 6062 error
is honestly journaled (`sell_attempt` with full logs), the position is not lost thanks to `deferSell`.

A test that `pool_v2` matches the tail (task item 4) was not added — it would be checking
a knowingly false claim: there is no match. Instead the facts are recorded here and in §8 (V7).

---

## 13. The official SDK: sell / pool_v2

Source — `@pump-fun/pump-sdk@4.3.1`, installed **outside the repository**
(`<folder-outside-repo>/pump-sdk-ref`, `npm ls @pump-fun/pump-sdk` → `4.3.1`). The bot code
did not change: this is a reference, not a patch.

### 13.1 What the searches found

| Query | Where | What |
|---|---|---|
| `pool-v2` | `src/swap/pda.ts:191` | the PDA seed |
| `poolV2` | `src/swap/pda.ts`, `src/swap/offlinePumpAmm.ts:797`, `:1047` | the `poolV2Pda` function and two places where it lands in remaining accounts |
| `pool_v2` | `src/idl/pump_amm.json` | the `InvalidPoolV2` error in the IDL error table |
| `remainingAccounts` | `src/swap/offlinePumpAmm.ts` (buy/sell/multi-hop), `src/swap/*.ts` | 37 occurrences: all trade instructions build them explicitly |

### 13.2 The `pool_v2` seeds

```ts
// src/swap/pda.ts:191
export function poolV2Pda(baseMint: PublicKey): PublicKey {
  return pumpAmmPda([Buffer.from("pool-v2"), baseMint.toBuffer()]);
}
```

That is `PDA(["pool-v2", baseMint], pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA)` — **exactly what
was derived in §12.2** (`5qLmRndb…` for `CsXAT9bd…bonk`, `4CgJNST7…` for `BWRfm9hQ…BAGS`).
There is no divergence; buys did not have it because it is a **sell remaining account**, not a
buy one — §12.3 still holds, the cache could not confirm it.

### 13.3 The `sell` accounts (21) — the IDL, `src/idl/pump_amm.json`

The IDL discriminator: bytes `[51,230,133,164,1,127,131,173]` = `33e685a4017f83ad` — matches ours.

| # | Account | writable | signer | In `lib/pumpswap-sell.mjs` |
|---|---|---|---|---|
| 0 | `pool` | yes | — | matches |
| 1 | `user` | yes | yes | matches |
| 2 | `global_config` | — | — | matches |
| 3 | `base_mint` | — | — | matches |
| 4 | `quote_mint` | — | — | matches |
| 5 | `user_base_token_account` | yes | — | matches |
| 6 | `user_quote_token_account` | yes | — | matches |
| 7 | `pool_base_token_account` | yes | — | matches |
| 8 | `pool_quote_token_account` | yes | — | matches |
| 9 | `protocol_fee_recipient` | **—** | — | **ours has `isWritable: true`** — a divergence |
| 10 | `protocol_fee_recipient_token_account` | yes | — | matches |
| 11 | `base_token_program` | — | — | matches (Token-2022) |
| 12 | `quote_token_program` | — | — | matches (SPL Token) |
| 13 | `system_program` | — | — | matches |
| 14 | `associated_token_program` | — | — | matches |
| 15 | `event_authority` | — | — | matches |
| 16 | `program` | — | — | matches |
| 17 | `coin_creator_vault_ata` | yes | — | matches |
| 18 | `coin_creator_vault_authority` | — | — | matches |
| 19 | `fee_config` | — | — | matches |
| 20 | `fee_program` | — | — | matches |

Total: **the order and composition of the 21 accounts are correct** (V1/V6 also confirmed by the IDL). The only
difference is the writable flag on `protocol_fee_recipient`; passing a read-only account as writable at runtime
is usually allowed, and the program's `isMut` here is `false`, so it is cosmetic, but it is recorded.

### 13.4 The `sell` remaining accounts — this is what was missing

`src/swap/offlinePumpAmm.ts`, `sellInstructionsNoPool()` (lines 1039-1104):

```ts
const poolV2PdaKey = poolV2Pda(pool.baseMint);
const remainingAccounts = [];
if (pool.isCashbackCoin) {
  remainingAccounts.push(
    { pubkey: ATA(quoteMint, userVolumeAccumulatorPda(user), true, quoteTokenProgram), isWritable: true, isSigner: false },
    { pubkey: userVolumeAccumulatorPda(user),                                       isWritable: true, isSigner: false },
  );
}
if (!pool.coinCreator.equals(PublicKey.default)) {
  remainingAccounts.push({ pubkey: poolV2PdaKey, isWritable: false, isSigner: false });
}
remainingAccounts.push(
  { pubkey: buybackFeeRecipient,             isWritable: false, isSigner: false },
  { pubkey: buybackFeeRecipientTokenAccount, isWritable: true,  isSigner: false },
);
```

| # | Account | When | writable |
|---|---|---|---|
| r0 | `ATA(quote_mint, user_volume_accumulator)` | only `pool.isCashbackCoin` | yes |
| r1 | `PDA(["user_volume_accumulator", user])` | only `pool.isCashbackCoin` | yes |
| r2 | `PDA(["pool-v2", base_mint])` | `pool.coin_creator != 0` | no |
| r3 | `buybackFeeRecipient` (a random one from `globalConfig.buybackFeeRecipients`, `src/swap/fees.ts:202`) | always | no |
| r4 | its ATA on `quote_mint` (`allowOwnerOffCurve = true`) | always | yes |

Our `ammSellIx` passes **not one** remaining account — hence `Custom 6062`
(`sell.rs:520 InvalidPoolV2`): the program looks for `pool_v2` among the remaining accounts, does not find it and
falls after it already debited the tokens. On the `HbZM3fVa…pump` probe `coinCreator = xgzHcG76…`
(not `default`), `isCashback = false`, so **r2, r3, r4** were needed.

### 13.5 `sell_v2` — the alternative the SDK uses behind a flag

| | `sell` | `sell_v2` |
|---|---|---|
| Discriminator | `33e685a4017f83ad` | `5df6823ce7e940b2` (= `sha256("global:sell_v2")[0..8]`) |
| Accounts | 21 | 17 |
| Differences | `protocol_fee_recipient`, its ATA, `coin_creator_vault_*`, `fee_program` | instead of them — `user_volume_accumulator` and `buyback_fee_recipient` (its ATA); no remaining accounts |
| When the SDK picks it | by default | `{ v2: true }` **and** `supportsTradeV2(pool)` |

`supportsTradeV2(pool) = !pool.isCashbackCoin` (`src/swap/util.ts:42`), i.e. for our pool
(`isCashback = false`) both variants are available. `sell_v2` does not require `pool_v2`, but requires
`user_volume_accumulator` (writable) and an **already existing** ATA of the buyback recipient.

### 13.6 Other SDK facts worth knowing

* Before a sell the SDK may insert `extend_account` if the pool account is shorter than
  `POOL_ACCOUNT_NEW_SIZE = 300` bytes (`offlinePumpAmm.ts:72`, `withFixPoolInstructions`). Our
  `decodePool` works with a 287 threshold; if the real pool is shorter than 300, the program may need
  `extend_account` before the sell (the probe did not need it — the error came later).
* The SDK always derives the fee recipients' ATA with `allowOwnerOffCurve = true` — matching our
  change via `ataFor()`.
* `getFeeRecipient` (`src/swap/fees.ts:186`) matching our logic: mayhem → the reserved list,
  otherwise the regular one, chosen randomly.

### 13.7 What this changes in TODO(verify)

| # | Was | Became |
|---|---|---|
| V7 | which account and by which seeds | **The seeds are confirmed by the official SDK**: `["pool-v2", baseMint]`. Still to be confirmed by simulation, but the what-account question is closed |
| — | — | New: `sell` also needs **buybackFeeRecipient + its quote-ATA** (always) and the cashback pair for cashback pools. This is not the BUG 13 volume-accumulator |
| V2 | whether the volume-accumulator is needed | For v1 `sell` — **no** (it is in neither the IDL nor the remaining accounts). For `sell_v2` — yes, as a named account |

**The code did not change** (the task is report-only). The next step, as a separate task: add to
`ammSellIx` remaining accounts `[pool_v2?, buybackFeeRecipient, buybackFeeRecipientAta]`
(+ the cashback pair when `isCashback`), then run `scripts/probe-sell-sim.mjs` and confirm that
6062 is gone.








