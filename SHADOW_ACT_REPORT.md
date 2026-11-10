# Shadow lab — ACT report (S1…S5)

Дата: 2026-11-10. Режим: ACT, автономно (вопросов не задавал, консервативные решения записаны в §6).
Репозиторий: `trade-bot-pump`, ветка `main`, HEAD `a7f1b8d`. **Ничего не закоммичено и не запушено.**

## 0. Исходное состояние и бэкап

| Что | Значение |
|---|---|
| `git status` (до правок) | пусто (рабочее дерево чистое) |
| `git diff --stat` (до правок) | пусто |
| HEAD | `a7f1b8d docs: rewrite README for beginners, add security and verification pages, flow diagram` |
| Бэкап | `../backup-before-shadow-act/` — 281 файл, без `.git` и `node_modules`; `shadow.mjs` совпадает по хэшу |

Правки не откатывались: все пункты дошли до зелёных тестов с первой-второй попытки (см. §1).

## 1. Статус по пунктам

| Пункт | Статус | Файлы | Тест |
|---|---|---|---|
| S1 — завершение по SIGINT/SIGTERM/`SHADOW_MAX_SEC` | **done** | `bots/graduation-sniper/shadow.mjs` | `scripts/shadow-finish.test.mjs` |
| S2 — дубли входов при вытеснении `mintState` | **done** | `bots/graduation-sniper/shadow.mjs` | `scripts/shadow-dedupe.test.mjs` |
| S3 шаг 1 — проверка двойного buy-slippage | **done** (вердикт **DOUBLE**) | — (только чтение кода) | `scripts/shadow-slip.test.mjs` (падал до правки, зелёный после) |
| S3 шаг 2 — убрать двойной учёт | **done** | `bots/graduation-sniper/shadow.mjs`, `lib/pessimistic.mjs` | `scripts/shadow-slip.test.mjs` |
| S4 — разделение эпох в анализаторе | **done** | `scripts/analyze-graduation.mjs` | `scripts/graduation-analyze.test.mjs` |
| S5 — вывод выборки и независимых наблюдений | **done** | `scripts/analyze-graduation.mjs` | `scripts/graduation-analyze.test.mjs` |

### S1 — что сделано

* Закрытие позиций вынесено в `closeAllAtStop(stopReason)`, а вся остановка — в **идемпотентную**
  `finishShadow(reason)` (флаг `stopping` стоит ДО любого побочного эффекта).
* Одна и та же функция обслуживает `SIGINT`, `SIGTERM` и `SHADOW_MAX_SEC`; reason записи:
  `manual stop` (SIGINT и таймер) и `shutdown` (SIGTERM).
* Позиция без известной цены больше не пропускается: пишется с `unconfirmed: true` и входной ценой
  в качестве выхода (отсутствующая сделка хуже неточной).
* Печатается сводка останова (`=== SHADOW STOP (reason) ===`, число закрытых/unconfirmed, путь журнала).
* Тест: WS_MOCK-фикстура доводит mint до 93 % fill, восемь вариантов открываются, `SHADOW_MAX_SEC`
  вызывает тот же `finishShadow()` → в журнале **8 `gshadow_open` и 8 `gshadow_trade`**, все
  `manual stop`, ни одной повторной пары `(variant, mint)`.

### S2 — что сделано

* Добавлен сессионный набор `openedKeys` (`variant:mint`): пара открывается не более одного раза за
  прогон. Это переживает вытеснение `mintState`, чего не умеет `entered`, живущий внутри состояния.
* Вытеснение переписано: удаляется только mint, у которого **нет открытой позиции** и который уже
  открыт **всеми** pre-migration вариантами (`ACTIVE_VARIANTS`, вариант I исключён — он не торгует).
  Если после прунинга лимит всё ещё превышен, память растёт, а в лог уходит строка (не чаще раза в
  минуту) — активные записи не удаляются.
* `SHADOW_MAX_MINTS` (default `20000`) — только для того, чтобы тест мог воспроизвести вытеснение;
  значение по умолчанию совпадает с прежним порогом.
* Тест: mint открывается, закрывается по таймауту, три mint-«наполнителя» переполняют кэп, происходит
  реальный прунинг (`pruned 1 spent mint(s)`), затем тот же mint снова торгуется → **второго
  `gshadow_open` нет** (8 открытий вместо 16).

### S3 шаг 2 — что сделано

* `entryPrice` теперь равен спотовой цене кривой; наценка `spot * (1 + slipBps/10000)` удалена.
  Единственное списание buy-slippage осталось в `roundTripCosts` (видно в разбивке по компонентам).
* `gshadow_open` и `gshadow_trade` несут `costsScheme` = `v3-single-slip: entry=curve spot, buy slip
  charged once in roundTripCosts` (константа `SHADOW_COSTS_SCHEME` в `lib/pessimistic.mjs`).
* Тест фиксирует точное число: плоский round trip (цена не двигалась) → `ratio === 1`,
  `netPct === -7.63`, `slipBps === 54`, `costsScheme` начинается с `v3-single-slip`.

### S4 / S5 — что сделано

* `gshadow_trade` группируются по `costsScheme`; записи без поля попадают в группу
  `legacy (no costsScheme)`. На каждую группу — своя таблица; при >1 группе печатается явное
  предупреждение, что версии смешаны и **общая таблица не выводится**.
* В шапке каждой группы: `samples: unique mints N | candidates M | per variant: A=9 B=8 …`.
* Если уникальных mint меньше 30: строка `WARNING: уникальных mints N < 30 — наблюдения сильно
  коррелированы, вердикт не делать` и вердикт группы помечается `withheld`.
* Тест: синтетический журнал с двумя схемами → ровно две таблицы, обе метки схем, предупреждение,
  строки выборки, `withheld`.


## 2. S3 шаг 1 — результат с числами: **DOUBLE**

Проверка по коду (до правок): `enter()` писал `entryPrice = spot * (1 + slipBps/10000)` (shadow.mjs:77,
`slipBps = 50 + sizeSlippageBps(0.02) = 50 + 4 = 54`), а `closePos()` → `pessimisticRoundTrip()`
(`lib/pessimistic.mjs:26-31`) → `roundTripCosts()` (`lib/fees.mjs:36-65`) снова вычитал `buySlip` =
`slippageBps` от `buySol`. То есть 54 bps списывались дважды: один раз как сдвиг цены входа, второй — как
компонента издержек.

Измерение на **реальном пути исполнения** (фикстура «flat»: после входа цена не меняется, поэтому
`exitPrice === spot`), `buySol=0.02`, pump 100+100 bps, tx = 2 × 455 000 lamports:

| Схема | entryPrice | ratio | netPct |
|---|---|---|---|
| v2 (двойной учёт, как было) | `spot × 1.0054` = 1.0217974836905872e-7 | **0.994629** | **−8.16 %** |
| v3-single-slip (как стало) | `spot` = 1.016309412861137e-7 | **1.000000** | **−7.63 %** |

Разница **0.53 п.п.** — ровно 54 bps ноционала на buy-ноге. Побочно виден сам дефект: цена не двигалась,
а `entryPrice ≠ exitPrice` (наценка сидела в цене входа).

Перекрёстная проверка на старом реальном журнале (`data/journal/2026-11-10.jsonl`, сделка по `4E481AX…`):
`entryPrice 3.6983235292992076e-7`, `exitPrice 3.678459846130105e-7`, `ratio 0.994629`, `netPct −5.46`
(другие CU-настройки того прогона) — цена вернулась к споту, а ratio всё равно 0.9946.

**Итог:** DOUBLE → выполнен шаг 2 (см. §1): убран сдвиг `entryPrice`, учёт оставлен в `roundTripCosts`,
в журнал добавлен `costsScheme`. Числа будущих прогонов сдвинутся на +0.53 п.п.; старые строки навсегда
остаются `legacy` и в общую таблицу с новыми не попадут.

## 3. Изменённые файлы

`git diff --stat` (отслеживаемые файлы):

```
 bots/graduation-sniper/shadow.mjs   | 115 ++++++++++++++++++++++++------
 docs/architecture.md                |   5 +-
 docs/bots.md                        |  15 +++-
 docs/configuration.md               |   1 +
 lib/pessimistic.mjs                 |   8 +++
 package.json                        |   2 +-
 scripts/analyze-graduation.mjs      | 136 ++++++++++++++++++++++++------------
 scripts/graduation-analyze.test.mjs |  51 ++++++++++++++
 8 files changed, 264 insertions(+), 69 deletions(-)
```

Новые файлы (untracked):

```
scripts/mocks/ws-mock-shadow.mjs      # фикстура 405-байтных trade-v3 событий с realSolReserves
scripts/shadow-finish.test.mjs        # S1
scripts/shadow-dedupe.test.mjs        # S2
scripts/shadow-slip.test.mjs          # S3 (шаг 1 и шаг 2)
SHADOW_ACT_REPORT.md                  # этот отчёт
```

Существующие тесты не ослаблялись. `scripts/graduation-analyze.test.mjs` **расширен** (старые assert'ы на
`gradstats` не тронуты), в `package.json` добавлены три новых теста в цепочку `npm test`.


## 4. Полный вывод проверок

### 4.1 `node --check` по изменённым/новым файлам

```
OK   bots/graduation-sniper/shadow.mjs
OK   scripts/analyze-graduation.mjs
OK   lib/pessimistic.mjs
OK   scripts/mocks/ws-mock-shadow.mjs
OK   scripts/shadow-finish.test.mjs
OK   scripts/shadow-dedupe.test.mjs
OK   scripts/shadow-slip.test.mjs
OK   scripts/graduation-analyze.test.mjs
```

### 4.2 `npm test` (полный вывод)

```

> memecoin-trading-bot@1.0.0 test
> node scripts/retry.test.mjs && node scripts/env-inline.test.mjs && node scripts/wallet-gen.test.mjs && node scripts/expired-tx.test.mjs && node scripts/paramshash.test.mjs && node scripts/ws-shutdown.test.mjs && node scripts/lab-prune.test.mjs && node scripts/tz-boundary.test.mjs && node scripts/buyix-layout.test.mjs && node scripts/rpc-timeout.test.mjs && node scripts/pumpswap.test.mjs && node scripts/fetchtx.integration.test.mjs && node scripts/session.test.mjs && node scripts/holders.test.mjs && node scripts/journal.test.mjs && node scripts/solprice.test.mjs && node scripts/research.test.mjs && node scripts/strategy.test.mjs && node scripts/replay.test.mjs && node scripts/events-latency.test.mjs && node scripts/rawcap.test.mjs && node scripts/mayhem.test.mjs && node scripts/smoke.test.mjs && node scripts/ticks.test.mjs && node scripts/curve-model.test.mjs && node scripts/ratelimit.test.mjs && node scripts/shadow.test.mjs && node scripts/shadow-finish.test.mjs && node scripts/shadow-dedupe.test.mjs && node scripts/shadow-slip.test.mjs && node scripts/shutdown.test.mjs && node scripts/instance-lock.test.mjs && node scripts/dedupe.test.mjs && node scripts/pessimistic.test.mjs && node scripts/pump-errors.test.mjs && node scripts/sell-plan.test.mjs && node scripts/fill.test.mjs && node scripts/graduation-analyze.test.mjs && node scripts/rescue-gate.test.mjs && node scripts/env-num.test.mjs && node scripts/basic-trader-cli.test.mjs && node scripts/tx-confirm-loss.test.mjs && node scripts/partial-sell.test.mjs && node scripts/exec.test.mjs && node scripts/log-events.test.mjs && node scripts/graduation-open.test.mjs && node scripts/analytics-events.test.mjs && node scripts/ws-dedup.test.mjs && node scripts/copy-filter.test.mjs && node scripts/graduation-events.test.mjs

{"forms":3,"permanentRetryable":false,"res":"ok","calls":3,"retries":2,"sleeps":[11,28]}
PASS: 3 real 429 shapes retryable, 3 timeout shapes retryable, 5xx/network retryable, 4xx permanent, retried 2x -> success
{"parserCases":9,"integration":"ok"}
PASS: inline comments stripped, quoted values and '#'-in-value preserved
Keypair saved: C:\Users\HUAWEI\AppData\Local\Temp\wallet-gen-9vPNLk\alpha.json
Public key: MegDaWFW1q2QdLnDzX2bCv4cJ41RP8ybZJ32hfRGgRZ
Keypair saved: C:\Users\HUAWEI\AppData\Local\Temp\wallet-gen-9vPNLk\alpha.json
Public key: 2KGTRU4rd6Ux6o1qYC7pVbjHNQLdyFpbbUfafmhkrgN8
{"created":true,"overwriteRefused":true,"forceOk":true,"namesRejected":7}
PASS: wallet generation is safe (no overwrite, no path escape, atomic write)
{"classes":2,"legacy":1,"negatives":3}
PASS: expired-tx classification matches web3.js 1.99 error classes
{"distinct":true}
PASS: paramsHash distinguishes every graduation filter
[2026-11-10 14:46:10 MSK] [INFO] [ws] connected
[2026-11-10 14:46:10 MSK] [WARN] [ws] disconnected, reconnecting in 14ms (attempt 1)
[2026-11-10 14:46:10 MSK] [INFO] [ws] connected
[2026-11-10 14:46:10 MSK] [WARN] [ws] disconnected, reconnecting in 17ms (attempt 1)
[2026-11-10 14:46:10 MSK] [INFO] [ws] connected
[2026-11-10 14:46:10 MSK] [WARN] [ws] disconnected, reconnecting in 12ms (attempt 1)
[2026-11-10 14:46:10 MSK] [INFO] [ws] connected
[2026-11-10 14:46:10 MSK] [WARN] [ws] disconnected, reconnecting in 13ms (attempt 1)
{"reconnectedTo":5,"closedAt":4}
PASS: ws reconnects on drop, close() cancels pending reconnects (no zombie sockets)
{"stayedOpen":true,"exitedOnReturn":true}
PASS: lab positions survive a missing price and exit when it returns
{"rollover":"ok"}
PASS: MSK day/hour/weekday keys are zone-correct across midnight
node.exe : bigint: Failed to load bindings, pure JS will be used (try npm run rebuild?)
строка:1 знак:1
+ & "C:\Program Files\nodejs/node.exe" "C:\Users\HUAWEI\AppData\Roaming ...
+ ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
    + CategoryInfo          : NotSpecified: (bigint: Failed ...m run rebuild?):String) [], RemoteException
    + FullyQualifiedErrorId : NativeCommandError
 
{"dataLen":26,"keys":17,"discriminator":"66063d1201daebea"}
PASS: buy instruction byte layout pinned (no transaction built or sent)
PASS: hung RPC cut after 4005ms, 2 retr(y/ies) counted, Error
bigint: Failed to load bindings, pure JS will be used (try npm run rebuild?)
{"groups":["US517G5965aydkZ46HS38QLi7UQiSojurfbQfKCELFx:MINT_A","cGfHiC6Kgg3FpFZvgwGcswsCRtp4aBP2fzuXRQPizuN:MINT_A","cGfHiC6Kgg3FpFZvgwGcswsCRtp4aBP2fzuXRQPizuN:MINT_B"],"unresolvedNull":true,"globalConfigOk":true}
PASS: multihop grouped by user+mint (not mixed); unresolved -> null; global config + fee recipient per IDL
bigint: Failed to load bindings, pure JS will be used (try npm run rebuild?)
{"trades":4,"groups":["4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi:k7FaK87WHGVXzkaoHb7CdVPgkKDQhZ29VLDeBVbDfYn","4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi:p2Yicb86aZig616Eav2VWG9vuXR5mEqhtzshZYBxzsV","8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR:k7FaK87WHGVXzkaoHb7CdVPgkKDQhZ29VLDeBVbDfYn","4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi:null"],"pswapUnresolved":1}
PASS: multihop events grouped by user+mint (not mixed); unresolved counted
[2026-11-10 14:46:18 MSK] [INFO] ================================================================
[2026-11-10 14:46:18 MSK] [INFO] SESSION SUMMARY тАФ TEST
[2026-11-10 14:46:18 MSK] [INFO] ================================================================
[2026-11-10 14:46:18 MSK] [INFO]   mode             : LIVE
[2026-11-10 14:46:18 MSK] [INFO]   stopped          : MAX_CONSEC_LOSSES hit
[2026-11-10 14:46:18 MSK] [INFO]   duration         : 0s
[2026-11-10 14:46:18 MSK] [INFO]   buys / sells     : 2 / 2
[2026-11-10 14:46:18 MSK] [INFO]   spent            : 0.100000 SOL
[2026-11-10 14:46:18 MSK] [INFO]   received         : 0.090000 SOL
[2026-11-10 14:46:18 MSK] [INFO]   NET result       : -0.010000 SOL  (-10.00% of spent)
[2026-11-10 14:46:18 MSK] [INFO]   costs            : 0.000000 SOL  (pump 1%+1%, slippage, priority fee)
[2026-11-10 14:46:18 MSK] [INFO]   NET after costs  : -0.010000 SOL
[2026-11-10 14:46:18 MSK] [INFO]   closed trades    : 1W / 1L   best +0.010000 SOL  worst -0.020000 SOL
[2026-11-10 14:46:18 MSK] [INFO]   open at stop     : 1 position(s)
[2026-11-10 14:46:18 MSK] [INFO]   no exit recorded : 1: mint: no tokens in wallet
[2026-11-10 14:46:18 MSK] [INFO]   wallet           : 1.000000 -> 0.990000 SOL  (delta -0.010000 SOL)
[2026-11-10 14:46:18 MSK] [INFO]   note             : spent/received are gross тАФ network + priority fees not deducted
[2026-11-10 14:46:18 MSK] [INFO] ================================================================
[2026-11-10 14:46:18 MSK] [INFO] ================================================================
[2026-11-10 14:46:18 MSK] [INFO] SESSION SUMMARY тАФ TEST2
[2026-11-10 14:46:18 MSK] [INFO] ================================================================
[2026-11-10 14:46:18 MSK] [INFO]   mode              : DRY RUN (simulated, nothing was sent on-chain)
[2026-11-10 14:46:18 MSK] [INFO]   stopped           : stopped
[2026-11-10 14:46:18 MSK] [INFO]   duration          : 0s
[2026-11-10 14:46:18 MSK] [INFO]   buys / sells      : 2 / 1
[2026-11-10 14:46:18 MSK] [INFO]   spent             : 0.040000 SOL
[2026-11-10 14:46:18 MSK] [INFO]   in open positions : 0.020000 SOL (1 pos, excluded from NET)
[2026-11-10 14:46:18 MSK] [INFO]   received          : 0.021000 SOL
[2026-11-10 14:46:18 MSK] [INFO]   NET result        : +0.001000 SOL  (+5.00% of spent)
[2026-11-10 14:46:18 MSK] [INFO]   costs             : 0.000000 SOL  (pump 1%+1%, slippage, priority fee)
[2026-11-10 14:46:18 MSK] [INFO]   NET after costs   : +0.001000 SOL
[2026-11-10 14:46:18 MSK] [INFO]   closed trades     : 1W / 0L   best +0.001000 SOL  worst 0.000000 SOL
[2026-11-10 14:46:18 MSK] [INFO]   open at stop      : 1 position(s)
[2026-11-10 14:46:18 MSK] [INFO]   worst case        : -0.019000 SOL  (if the 1 open position(s) end at 0)
[2026-11-10 14:46:18 MSK] [INFO]   wallet            : unchanged (dry run)
[2026-11-10 14:46:18 MSK] [INFO]   note              : spent/received are gross тАФ network + priority fees not deducted
[2026-11-10 14:46:18 MSK] [INFO] ================================================================
[2026-11-10 14:46:18 MSK] [INFO] ================================================================
[2026-11-10 14:46:18 MSK] [INFO] SESSION SUMMARY тАФ COSTS
[2026-11-10 14:46:18 MSK] [INFO] ================================================================
[2026-11-10 14:46:18 MSK] [INFO]   mode            : LIVE
[2026-11-10 14:46:18 MSK] [INFO]   stopped         : test
[2026-11-10 14:46:18 MSK] [INFO]   duration        : 0s
[2026-11-10 14:46:18 MSK] [INFO]   buys / sells    : 1 / 1
[2026-11-10 14:46:18 MSK] [INFO]   spent           : 0.050000 SOL
[2026-11-10 14:46:18 MSK] [INFO]   received        : 0.055000 SOL
[2026-11-10 14:46:18 MSK] [INFO]   NET result      : +0.005000 SOL  (+10.00% of spent)
[2026-11-10 14:46:18 MSK] [INFO]   costs           : 0.001700 SOL  (pump 1%+1%, slippage, priority fee)
[2026-11-10 14:46:18 MSK] [INFO]   NET after costs : +0.003300 SOL
[2026-11-10 14:46:18 MSK] [INFO]   closed trades   : 1W / 0L   best +0.005000 SOL  worst 0.000000 SOL
[2026-11-10 14:46:18 MSK] [INFO]   open at stop    : 0 position(s)
[2026-11-10 14:46:18 MSK] [INFO]   wallet          : 1.000000 -> 1.003300 SOL  (delta +0.003300 SOL)
[2026-11-10 14:46:18 MSK] [INFO]   note            : spent/received are gross тАФ network + priority fees not deducted
[2026-11-10 14:46:18 MSK] [INFO] ================================================================
[2026-11-10 14:46:18 MSK] [INFO] ================================================================
[2026-11-10 14:46:18 MSK] [INFO] SESSION SUMMARY тАФ PARTIAL
[2026-11-10 14:46:18 MSK] [INFO] ================================================================
[2026-11-10 14:46:18 MSK] [INFO]   mode              : LIVE
[2026-11-10 14:46:18 MSK] [INFO]   stopped           : stopped
[2026-11-10 14:46:18 MSK] [INFO]   duration          : 0s
[2026-11-10 14:46:18 MSK] [INFO]   buys / sells      : 1 / 1
[2026-11-10 14:46:18 MSK] [INFO]   spent             : 0.100000 SOL
[2026-11-10 14:46:18 MSK] [INFO]   in open positions : 0.050000 SOL (1 pos, excluded from NET)
[2026-11-10 14:46:18 MSK] [INFO]   received          : 0.050000 SOL
[2026-11-10 14:46:18 MSK] [INFO]   NET result        : 0.000000 SOL  (+0.00% of spent)
[2026-11-10 14:46:18 MSK] [INFO]   costs             : 0.000000 SOL  (pump 1%+1%, slippage, priority fee)
[2026-11-10 14:46:18 MSK] [INFO]   NET after costs   : 0.000000 SOL
[2026-11-10 14:46:18 MSK] [INFO]   closed trades     : 0W / 0L
[2026-11-10 14:46:18 MSK] [INFO]   open at stop      : 1 position(s)
[2026-11-10 14:46:18 MSK] [INFO]   worst case        : -0.050000 SOL  (if the 1 open position(s) end at 0)
[2026-11-10 14:46:18 MSK] [INFO]   note              : spent/received are gross тАФ network + priority fees not deducted
[2026-11-10 14:46:18 MSK] [INFO] ================================================================
{"netSol":-0.01,"spent":0.1,"received":0.09}
PASS: limits are terminal (bot exits + prints totals); oversized trade is not; ledger net is exact
{"dropped":[{"mint":"MINT_SLOW","holders":1,"holdersAtReady":null,"maxHolders":1,"ready":false,"blocked":null,"waitedMs":2500,"features":{"mint":"MINT_SLOW","creator":null,"createSlot":null,"createTs":1000,"holders":1,"maxHolders":1,"buySlots":1,"uniqueBuyers":1,"msToReady":null,"holdersAtReady":null,"blocked":null,"topHolderShare":1}}],"size":0}
PASS: holder gate counts distinct positive wallets, ignores same-wallet repeats, expires slow mints
{"netSol":0.008,"tooEarly":1,"missed":6}
PASS: journal writes/reads, summary flags early exits (missed 6x) and ignores broken lines
{"cases":8,"sample":"$0.00532"}
PASS: dollar formatting keeps micro-cap digits and converts SOL/token -> USD
{"tokensForBuy":707712909480}
PASS: holder drop bug fixed (ready+blocked reported), bundles rejected, curve anomalies refused, costs applied
{"variants":["A","B","C","D","E","F40","F50","F60"]}
PASS: A-E variants behave (bundle rejected, time-stop, partial+trailing, creator-sell, SL priority)
PASS: bootstrap CI, 70/30 split, strict verdict (edge only with >=300 hold-out trades and CI>0), CLI runs
PASS: parser layout verified on fixtures, latency defers fills, slippage monotone, freeze judges only post-freeze trades
[2026-11-10 14:46:20 MSK] [INFO] [raw] rotated 2026-11-08-10.jsonl.gz (0.0 KB) -> 2026-11-08-11.jsonl.gz
[2026-11-10 14:46:20 MSK] [INFO] [raw] resuming 2026-11-08-11.jsonl.gz (0.00 MB on disk) тАФ appending
{"files":2,"records":3}
PASS: raw capture rotates hourly and replays offline; curve identity accepts a snapshot without neighbours
[2026-11-10 14:46:21 MSK] [INFO] [raw] rotated 2026-11-08-10.jsonl.gz (0.0 KB) -> 2026-11-08-11.jsonl.gz
[2026-11-10 14:46:21 MSK] [INFO] [raw] rotated 2026-11-08-11.jsonl.gz (0.0 KB) -> 2026-11-08-12.jsonl.gz
[2026-11-10 14:46:21 MSK] [INFO] [raw] pruned 2026-11-08-10.jsonl.gz (0.0 MB) to stay under the 0.00 GB cap
[2026-11-10 14:46:21 MSK] [INFO] [raw] pruned 2026-11-08-11.jsonl.gz (0.0 MB) to stay under the 0.00 GB cap
[2026-11-10 14:46:21 MSK] [INFO] [raw] pruned 2026-11-08-12.jsonl.gz (0.0 MB) to stay under the 0.00 GB cap
{"mayhemProgram":"MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e","flagOffset":81}
PASS: Mayhem flags (trade + account), create-v2 parser, curve rebuild and capture pruning behave
{"exitCode":0,"journalTrades":2,"rejects":0,"summaryBuys":2,"summaryClosed":2,"openAtStop":0}
PASS: real sniper handler survived a synthetic create/buy/sell stream (incl. Mayhem CPI), opened and closed positions, journal == summary
{"sessionId":"sniper-2026-11-10T11-46-44-714-71f071","paramsHash":"015abd7f5cc5"}
PASS: run metadata (sessionId/paramsHash/gitSha) and the tick log (write, rotate, drain) behave
bigint: Failed to load bindings, pure JS will be used (try npm run rebuild?)
PASS: launch price, checkCurve floors/ceilings, TP/SL triggers, costs, slippage and premium behave
{"calls":10,"retries429":9,"degraded":true}
PASS: rate limiter orders by priority, 429s are counted, degraded sessions are excluded
PASS: shadow V0-V7 entry filters + V4/V5 tick replay + skip/no-data stats
{"exit":0,"opens":8,"trades":8,"reasons":["manual stop"]}
PASS: the shadow stop journals every open position exactly once (no trade lost at Ctrl+C)
{"exit":0,"opens":8,"trades":8,"capLine":"mintState cap 2: pruned 1 spent mint(s), 2 held"}
PASS: an evicted mint cannot be opened a second time (session-wide variant+mint dedupe)
{"ratio":1,"entryPrice":1.016309412861137e-7,"exitPrice":1.016309412861137e-7,"netPct":-7.63,"slipBps":54,"costsScheme":"v3-single-slip: entry=curve spot, buy slip charged once in roundTripCosts"}
PASS: buy slippage is charged once (ratio 1 on a flat round trip, netPct -7.63%)
{"code":0,"elapsedMs":6468,"manualCloses":3}
PASS: stop closes open positions, prints summary before drain, writes session_summary (idempotent)
PASS: instance lock refuses a second live instance, ignores stale locks, replaces garbage
PASS: dedupeTrades removes cross-process/legacy duplicates and reports per-gitSha counts
PASS: pessimistic model (delay, size slippage, two modes) behaves
bigint: Failed to load bindings, pure JS will be used (try npm run rebuild?)
{"ratio":0.9801,"drainedOut":0.050912215,"drainedRSol":0.000786439}
PASS: pump error codes are human-readable, survive wrapper layers, and rSol<out is detected before sending
bigint: Failed to load bindings, pure JS will be used (try npm run rebuild?)
{"fullNetSol":0.050912215,"rSol":0.000786439,"parts":3,"firstPartTokens":3456.717057,"restTokens":232010.496955}
PASS: full-balance sells are split so every part fits realSolReserves (6024 guard)
{"rSolSol":41.717,"realFill":49.1,"oldFill":84.4}
PASS: fill is computed from real reserves; the virtual formula is provably wrong
{"pf":1,"maxDD":15,"ciSeed7":{"lo":-0.35,"hi":0.3}}
PASS: shadow stats (PF, maxDD, bootstrap CI, summarize) behave
PASS: rescue-sell gate тАФ --dry-run never sends, --live requires LIVE_CONFIRM
PASS: numeric env validated loudly (watcher COPY_MAX_POSITIONS, rescue SELL_SLIPPAGE_BPS)
PASS: basic-trader rejects invalid sell percentages before any RPC
tx sent: 5111111111111111111111111111111111111111111111111111111111111111111111111111111111111111
PASS: confirm-failure carries the signature and readExecution resolves the landed fill
PASS: splitEntryForSell returns the sold share and the remaining entry
PASS: readExecution resolves fills from tx meta and reports found:false on meta lag
PASS: parseLogEvents reads direction from the byte and emits create events from the payload creator
PASS: canEnterMint refuses in-flight and attempted mints (duplicate-buy guard)
PASS: topBuyers counts buys only (sells do not inflate buy volume)
[2026-11-10 14:47:42 MSK] [INFO] [ws] connected
[2026-11-10 14:47:42 MSK] [INFO] [ws] connected
PASS: WS dedup is per-subscription (replays dropped, cross-sub preserved)
{"copyBuyCount":1}
PASS: copy-trader filters out foreign wallets' trades in a tx mentioning the target
{"sawFill95":true}
PASS: graduation processes every buy event in a tx (no early break on the first)
```

## 5. Что не проверено и почему

1. **Ветка `unconfirmed: true` при остановке** не воспроизводится интеграционно: позиция всегда имеет
   известную цену, а mint с открытой позицией по построению (S2) не вытесняется, поэтому «цены нет»
   на практике недостижимо. Ветка защитная, проверена только чтением кода.
2. **Доставка SIGINT/SIGTERM самому процессу** не тестируется: на Windows `child.kill()` убивает процесс,
   не вызывая обработчик (та же причина, что и в `scripts/shutdown.test.mjs`). Тест гоняет **ту же**
   `finishShadow()` через `SHADOW_MAX_SEC`; обработчики сигналов — однострочные вызовы.
3. **Повторный сигнал во время закрытия сокета** end-to-end не воспроизведён (см. п.2). Гарантия — порядок
   операций в `finishShadow` (флаг `stopping` до любых записей) + инвариант «одна запись на пару
   (variant, mint)».
4. **Новая выборка 30+ независимых mints на вариант** недостижима в герметичном тесте: нужен длинный
   живой прогон. Тесты проверяют учёт и арифметику, а не стратегию.
5. **Цифры прибыльности после правки S3** не получены (и не должны были): старый журнал остаётся в схеме
   `legacy`, новый прогон — отдельная эпоха. Пересчитать старые 66 сделок под v3 можно частично (в
   `gshadow_open` сохранён `spot`), но это отдельная задача и в scope не входила.

## 6. Решения, принятые автономно (консервативные)

1. **`COSTS_SCHEME` в `lib/fees.mjs` не повышен.** Правило самого файла — бампать при изменении арифметики
   ниже (fees/tx/slippage), а она не менялась; при этом `splitByScheme()` и `scripts/analyze-journal.mjs`
   распознают эпоху по префиксу `v2`, так что глобальный бамп переклассифицировал бы трейды **всех
   остальных ботов** в legacy. Вместо этого введена отдельная константа
   `SHADOW_COSTS_SCHEME = "v3-single-slip: …"` в `lib/pessimistic.mjs` (там же, где модель), и она пишется
   только в `gshadow_*` строки. Эпохи разделены, другие боты не затронуты.
2. **`SHADOW_MAX_SEC` теперь закрывает позиции как `manual stop`** (раньше `timeout` / `no_data`) — прямое
   следствие требования «поведение по SIGTERM и по `SHADOW_MAX_SEC` должно быть тем же самым». Побочный
   эффект: в отчётах прогонов, остановленных таймером, такие сделки больше не попадают в долю `timeout`.
3. **Новый env `SHADOW_MAX_MINTS` (default `20000`)** — иначе вытеснение нельзя проверить тестом. Значение
   по умолчанию совпадает с прежним порогом, поведение по умолчанию не меняется.
4. **Новый мок `scripts/mocks/ws-mock-shadow.mjs`** вместо `ws-mock.mjs`: последний не заполняет
   `realSolReserves` (смещение 113), поэтому fill всегда 0 и ни один mint не становится кандидатом.
5. **Ничего не коммитил и не пушил** — как требовалось.

## 7. Что требует решения человека

1. **TP до миграции.** Порог 1.3/1.5 недостижим: от входа на fill≈92 % до выпуска (fill=100 %) цена растёт
   максимум ~+12 %. На 66 сделках старого прогона доля `tp` = 0 % у всех вариантов. Это параметр и/или
   логика выхода — по условиям задачи не менял.
2. **Размер ставки 0.02 SOL.** Фиксированные издержки (2 × 0.000455 SOL priority+base) — ≈4.6 % ноционала,
   поэтому сделка «в ноль» по цене даёт −7.63 % net. Увеличивать ставку, менять модель издержек или
   учитывать tx иначе — решение владельца.
3. **Нужна ли новая выборка.** Анализатор теперь явно требует ≥30 уникальных mints (иначе вердикт
   `withheld`). Старый прогон: 66 сделок = 8 mints. Нужен длинный прогон для независимых наблюдений.
4. **Пересчёт старых сделок под схему v3** (из `gshadow_open.spot`) — делать или нет, решает человек;
   смешивать эпохи анализатор больше не позволит.
