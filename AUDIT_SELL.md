# AUDIT_SELL — как graduation-sniper продаёт после миграции (Шаг 1)

Дата: 2026-11-10. Коммит: `85a6963`. Метод: только чтение кода + офлайн-разбор `data/txcache`
(сеть не использовалась, ключи не читались, транзакции не отправлялись, код не менялся).

Ссылки на строки — по состоянию на `85a6963`.

---

## 0. Краткие выводы

1. **Venue выбирается в двух независимых местах** — `bots/graduation-sniper/graduation.mjs` и
   `scripts/rescue-sell.mjs` — с одинаковой логикой, но разными ветками отказа.
2. **STUCK ставится в 6 местах**, и в трёх из них это не ошибка продажи, а отказ от попытки.
   Главный: гейт `LIVE_CONFIRM_AMM` (`graduation.mjs:553`) вызывает `markStuck` на `attempts = 0`,
   то есть позиция удаляется **до** использования `SELL_MAX_ATTEMPTS` — это и есть «тихий STUCK».
3. **`ammSellIx` — 21 аккаунт, дискриминатор `33e685a4017f83ad`**. Дискриминатор **проверен офлайн**:
   `sha256("global:sell")[0..8]` совпадает побайтово (см. §3).
4. **Раскладка аккаунтов НЕ подтверждена** и, судя по реальным данным, **неполная**: в кэше лежат
   4 настоящие AMM-инструкции `buy_exact_quote_in`, и у каждой **30 аккаунтов**, включая
   `global_volume_accumulator`, `user_volume_accumulator`, `fee_config`, `fee_program` + 7 хвостовых.
   В нашей sell-сборке этих аккаунтов нет (это ровно предупреждение BUG 13).
5. **Дублирование полное**: `canonicalPool`, `readI128`, `decodePool`, `decodeGlobalConfig`,
   `pickProtocolFeeRecipient`, `ammSellIx` и три PDA-константы существуют в двух копиях
   (`lib/pumpswap.mjs` и `scripts/rescue-sell.mjs`) и **идентичны построчно**.
6. **Симуляция перед отправкой уже есть** в обоих путях (`simulateTx`), но журнал пишет результат
   только при провале; записи «симуляция прошла, ожидаю X SOL» перед отправкой нет.
7. **`readExecution` считает аренду закрытого WSOL-ATA как выручку** (+0.00203928 SOL к `solReceivedSol`),
   а AMM-ветка создаёт и закрывает WSOL-ATA в той же транзакции → PnL по AMM-продаже будет завышен,
   если этого не вычесть (родственно BUG 09, который отложен).
8. **IDL-файла в репозитории нет.** Все утверждения «по официальному pump-amm IDL» — комментарии;
   проверить байты и порядок аккаунтов из репозитория нельзя (см. §6, чего не хватает).

---
## 1. Как выбирается venue

### 1.1 Бот (`bots/graduation-sniper/graduation.mjs`)

Точка входа — `checkExit()` (`:429`). Она вызывается из `monitorPositions()` (`:710`) каждые
`POLL_MS = 3000` мс и из `finish()` при остановке (`:763`).

| Условие на кривой (`getBondingCurveState`, `:437`) | Что делает бот |
|---|---|
| `state` есть, `!state.complete` | считает `ratio = calcSellSol(tokens) / entryLamports` и решает TP / SL / timeout (`:457`, `:460`, `:463`) → `sellPosition()` |
| `!state` | `:438` → лог «bonding curve gone (graduated?) — PumpSwap route» → `sellPosition()` |
| `state.complete` | `:443` → лог «*** GRADUATED! *** selling on PumpSwap» → `sellPosition()` |

Дальше **внутри** `sellPosition()` (`:489`) venue решается заново, уже по данным кошелька (`:524`):

```
state && !state.complete   -> venue = "curve"      (:527)
иначе                      -> venue = "pumpswap"   (:551)
```

* **curve**: `planSellParts(state, total, { capRatio: 0.95, minPartRaw: 1_000_000n })` (`:529`).
  Если `parts.length === 0` → STUCK (§2, п.1). Иначе продаётся **первая часть** (`:534`), остаток
  остаётся в позиции (`:545` только логирует).
* **pumpswap**: гейт (`:553`) → `ammSellQuote(connection, mint, total)` (`:557`); `null` → STUCK (§2, п.3);
  иначе `ammSellIx` + `computeBudgetIxs` + идемпотентный WSOL-ATA + `closeAccount` (`:565-570`).

### 1.2 Rescue (`scripts/rescue-sell.mjs`)

`quoteVenue()` (`:163`) — та же развилка, но с другим набором исходов:

| Условие | Результат |
|---|---|
| `state && !state.complete` | `venue: "curve"`, `sellable: parts.length > 0` (`:177`, `:180`) |
| нет/битый пул (`!pi \|\| pi.data.length < 287`) | `venue: "none"`, `sellable: false` (`:189`) |
| пул есть, vault не читаются | `venue: "pool"`, `sellable: false`, note `vaults unreadable` (`:196`) |
| пул есть, vault читаются | `venue: "pool"`, `sellable: true`, `expectedSol` (`:208-215`) |

### 1.3 Расхождения curve/pool между ботом и rescue

| Аспект | Бот | Rescue |
|---|---|---|
| Пул есть, но vault не читаются | `ammSellQuote` → `null` → **STUCK `no venue`** | `venue: "pool"`, `sellable: false`, отдельный текст |
| Сколько частей кривой продаётся | **только первая** (`:534`), остаток ждёт следующего цикла | **все части по порядку** (`:291-310`) |
| Ретраи `getBondingCurveState` | 1 попытка | 3 попытки (`:165`) |
| `getAccountInfo(AMM_GLOBAL_CONFIG)` | `.catch(() => null)` (`pumpswap.mjs:133`) | **без `.catch`** (`:201`) → исключение уронит цикл |

---

## 2. Условия STUCK (все места)

| # | Строка | Условие | Журнал | Позиция |
|---|---|---|---|---|
| 1 | `:531` | кривая не может выплатить ни одной части (`plan.parts.length === 0`) | `stuck` + `attempts` | удаляется |
| 2 | `:554` | `LIVE && LIVE_CONFIRM_AMM !== "yes"` **и** кривая complete | `stuck`, `attempts: 0` | удаляется |
| 3 | `:559` | `ammSellQuote` вернул `null` (нет пула / vault не читаются) | `stuck`, `attempts: 0` | удаляется |
| 4 | `:597` | симуляция провалилась и `attempt >= SELL_MAX_ATTEMPTS` | `sell_attempt` + `stuck` | удаляется |
| 5 | `:701` | отправка провалилась и `attempt >= SELL_MAX_ATTEMPTS` | `sell_failed` + `stuck` | удаляется |
| 6 | `:775` | остановка сессии, позиция осталась открытой | `stuck` (`reason: "open at stop"`) | удаляется |

Проблемы, которые это создаёт:

* **п.2 и п.3 не являются «попытками»**: `pos.attempts` не инкрементируется, `pos.nextSellAt` не
  ставится, `SELL_MAX_ATTEMPTS` не применяется. Позиция исчезает из `positions` на первом же
  обнаружении миграции (в реальном журнале: buy `16:52:45` → stuck `16:53:03`, `attempts: 0`).
* **формулировка «retries stopped» ложна** для п.2/п.3: повторов не было вообще (`:485`).
* **учёт**: `markStuck` вызывает `session.drop()` (`:474`), `spentSol` остаётся, `receivedSol` — нет,
  поэтому в отчёте (`lib/session.mjs:138`) такая позиция выглядит как полный минус, хотя токены
  лежат в кошельке и чего-то стоят.
* **причина не в журнале как данные**: `reason` — строка, в ней нет ни venue, ни суммы токенов,
  ни логов симуляции (только `tokens` и `attempts`).

---
## 3. Что передаётся в `ammSellIx` и откуда

`lib/pumpswap.mjs:145`. Аргументы: `(user, baseMint, pool, p, g, baseAmountIn, minQuoteOut)`.

### 3.1 Данные инструкции (24 байта)

| Смещение | Поле | Источник |
|---|---|---|
| `0..8` | дискриминатор `33e685a4017f83ad` | константа в коде (`:175`) |
| `8..16` | `base_amount_in` (u64 LE) | `total` — баланс токенов из `getTokenAccountBalance` (`graduation.mjs:516-517`) |
| `16..24` | `min_quote_amount_out` (u64 LE) | `quote * (10000 - slip) / 10000`, `slip = min(SELL_MAX_SLIPPAGE, 500 * 2^(attempt-1))` (`:511`, `:563`) |

**Офлайн-проверка дискриминатора (выполнена в этом аудите, без сети):**

```
sha256("global:sell")[0..8]               = 33e685a4017f83ad   <- совпадает с кодом
sha256("global:buy")[0..8]                = 66063d1201daebea
sha256("global:buy_exact_quote_in")[0..8] = c62e1552b4d9e870   <- совпадает с 4 реальными tx в data/txcache
```

Третья строка важна: она доказывает, что (а) кэш содержит настоящие инструкции PumpSwap,
(б) правило Anchor-дискриминатора здесь работает, значит и первая строка не «выдумана по памяти».

### 3.2 21 аккаунт

| # | Аккаунт | W/S | Источник значения |
|---|---|---|---|
| 0 | `pool` | w | `canonicalPool(mint)` — PDA `["pool", u16(0), pool_authority, mint, WSOL]` (`:58`) |
| 1 | `user` | sw | `wallet.publicKey` |
| 2 | `global_config` | r | PDA `["global_config"]` (`:48`) |
| 3 | `base_mint` | r | аргумент |
| 4 | `quote_mint` | r | `p.quoteMint` — `decodePool` @75 |
| 5 | `user_base_token_account` | w | ATA(baseMint, user, Token-2022) |
| 6 | `user_quote_token_account` | w | ATA(quoteMint, user, SPL Token) |
| 7 | `pool_base_token_account` | w | `p.baseVault` @139 |
| 8 | `pool_quote_token_account` | w | `p.quoteVault` @171 |
| 9 | `protocol_fee_recipient` | w | **`pickProtocolFeeRecipient(g, p.isMayhem)` — случайный из списка** (`:108`) |
| 10 | `protocol_fee_recipient_token_account` | w | ATA(quoteMint, feeRecipient, SPL Token) |
| 11 | `base_token_program` | r | `TOKEN_2022_PROGRAM` |
| 12 | `quote_token_program` | r | `TOKEN_PROGRAM` (WSOL) |
| 13 | `system_program` | r | константа |
| 14 | `associated_token_program` | r | константа |
| 15 | `event_authority` | r | PDA `["__event_authority"]` (`:49`) |
| 16 | `program` | r | `PUMPSWAP_PROGRAM` |
| 17 | `coin_creator_vault_ata` | w | ATA(quoteMint, creatorAuth, **allowOwnerOffCurve = true**) |
| 18 | `coin_creator_vault_authority` | r | PDA `["creator_vault", p.coinCreator]` (`:147`) |
| 19 | `fee_config` | r | PDA `["fee_config", PUMPSWAP_PROGRAM]` в программе `pfee…` (`:50`) |
| 20 | `fee_program` | r | `pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ` |

Источники `p` (PoolState, `decodePool` `:71`): `baseMint@43`, `quoteMint@75`, `baseVault@139`,
`quoteVault@171`, `coinCreator@211`, `isMayhem@243`, `isCashback@244`, `virtualQuoteReserves@245` (i128),
`creatorFeeBps@261`. Источники `g` (GlobalConfig, `decodeGlobalConfig` `:92`): `lpFeeBps@40`,
`protocolFeeBps@48`, `protocolFeeRecipients[8]@57`, `coinCreatorFeeBps@313`, `reservedFeeRecipient@385`,
`reservedFeeRecipients[8]@418`, `buybackFeeRecipients[8]@675`.

### 3.3 Котировка (`ammSellQuote`, `:117`)

```
gross  = quoteVaultBalance + virtualQuoteReserves            (:129)
out    = gross * raw / (baseVaultBalance + raw)              (:130)
feeBps = lpFee + protocolFee + (pool.creatorFeeBps ?? coinCreatorFeeBps)   (:136)
net    = out * (10000 - feeBps) / 10000                      (:137)
```

Это **не проверено** против реальной математики программы (нет sell-tx для сверки).
Если формула завышает `net`, транзакция отвалится на симуляции по `min_quote_amount_out` (безопасно,
но продажа не пройдёт). `TODO(verify)`.

### 3.4 Офлайн-сверка с реальными транзакциями (`data/txcache`, 4 файла)

Реальная инструкция `buy_exact_quote_in` (диск `c62e1552b4d9e870`), 30 аккаунтов, один и тот же каркас:

| Индекс | Что | Комментарий |
|---|---|---|
| 0 | pool | совпадает у двух tx с одинаковым базовым mint |
| 1 | user (signer) | |
| 2 | `global_config` | **наш PDA подтверждён** |
| 3 | WSOL (quote mint) | |
| 4 | base mint | во всех 4 случаях **не pump-mint** (два `…bonk`) |
| 11 | SPL TOKEN | |
| 12 | Token-2022 | порядок **обратный** нашей sell-сборке (у нас 11 = 2022) |
| 13 | SYSTEM | |
| 14 | ATA program | |
| 15 | `event_authority` | **наш PDA подтверждён** |
| 16 | PumpSwap program | |
| 19 | **`global_volume_accumulator`** | PDA `["global_volume_accumulator"]` — **совпал** |
| 20 | **`user_volume_accumulator`** | PDA `["user_volume_accumulator", user]` — **совпал** для всех 4 |
| 21 | `fee_config` | **наш PDA подтверждён** |
| 22 | `fee_program` | |
| 23..29 | 7 хвостовых аккаунтов | в нашей сборке отсутствуют |

Выводы, которые можно и нельзя делать:

* **Можно**: дискриминатор sell верен; PDA `global_config`, `event_authority`, `fee_config` верны;
  правило PDA для volume-accumulator подтверждено на реальных данных.
* **Можно**: у развёрнутой программы v1-инструкция несёт volume-accumulator аккаунты, которых в
  нашей 21-аккаунтной сборке нет → высокая вероятность, что `sell` без них не пройдёт
  (это и есть BUG 13, но теперь с фактами, а не с гипотезой).
* **Нельзя**: утверждать, что порядок 11/12 у sell такой же, как у `buy_exact_quote_in` — это
  разные инструкции. Для sell в кэше **нет ни одной транзакции**.
* **Нельзя** использовать эти 4 пула для проверки `canonicalPool`: базовые mint'ы не pump, похоже
  на пулы с собственным `pool_authority` → `canonicalPool()` даёт 0/4 совпадений, но это **не**
  доказательство ошибки. Проверка `canonicalPool` требует одного запроса по известному
  выпустившемуся pump-mint (`TODO(verify)`).

---
## 4. `lib/pumpswap.mjs` vs `scripts/rescue-sell.mjs` — что совпадает и что расходится

| Функция / константа | lib | rescue | Идентичность |
|---|---|---|---|
| `canonicalPool` | `:58` | `:109` | **идентична** |
| `readI128` | `:66` | `:117` | **идентична** |
| `decodePool` | `:71` | `:124` | **идентична** (все смещения) |
| `decodeGlobalConfig` | `:92` | `:142` | **идентична** |
| `pickProtocolFeeRecipient` | `:108` | `:156` | **идентична** |
| `ammSellIx` | `:145` | `:219` | **идентична**: те же 21 аккаунт в том же порядке, те же 24 байта; отличие только косметическое (в rescue `creatorVaultAta` вынесен в переменную `:225`) |
| `AMM_GLOBAL_CONFIG` / `AMM_EVENT_AUTH` / `AMM_FEE_CONFIG` / `AMM_FEE_PROGRAM` | `:47-53` | `:46-52` | **идентичны** |
| `TOKEN_PROGRAM` | экспортируется (`:55`) | объявлен локально (`:54`) | дубль |
| Котировка пула | `ammSellQuote` (`:117`) | инлайн в `quoteVenue` (`:191-206`) | формула одинаковая; rescue **не** оборачивает `getAccountInfo(AMM_GLOBAL_CONFIG)` в `.catch` |
| Ошибка «пул есть, vault нет» | `null` → `no venue` | `sellable:false` + текст | разное поведение |
| Перевод SOL→lamports для `min_out` | `BigInt(quote)` из `solOut` | `BigInt(Math.floor(expectedSol * 1e9))` (`:313`) | rescue теряет точность на float |

Итого: **~150 строк продублированы построчно**. Любая правка раскладки должна делаться в двух
местах — это и есть причина Шага 2.

---

## 5. Что уже есть для «проверяемой продажи» и чего нет

| Требование Шага 3/4 | Состояние |
|---|---|
| Симуляция перед отправкой | **есть** в боте (`:575` для curve и pool) и в rescue (`:303`, `:323`) |
| Не отправлять при ошибке симуляции | **есть**: `if (!sim.ok) { ... return; }` |
| Ошибка симуляции в журнал целиком | **частично**: пишется `error: describeTxError(sim.err)` (`:593`), но **не** пишутся `sim.logs` (а именно там причина: `Program log: …`) и `unitsConsumed` |
| Ожидаемый выход в журнал **до** отправки | **нет**: `quoteOut` попадает только в запись после отправки (`trade`) или в запись провала (`sell_attempt`) |
| `DRY_SELL=yes` (симулировать, писать, не отправлять) | **нет** |
| Не удалять позицию до исчерпания попыток | **нет** для п.2/п.3 (§2) |
| Понятный статус вместо «retries stopped» | **нет**: текст статический (`:485`) |
| Учёт аренды закрытого WSOL-ATA | **нет**: `solReceivedSol = solDelta / 1e9` (`exec.mjs:38`), а AMM-ветка создаёт+закрывает ATA в одной tx → `+0.00203928 SOL` к «выручке» |

---

## 6. Чего не хватает (не выдумываю)

1. **Нет IDL-файла в репозитории.** Ни `pump_amm.json`, ни `pump.json`. Все «21 аккаунт по IDL» —
   комментарии. Независимо проверить список/порядок аккаунтов `sell` из репозитория **невозможно**.
   Варианты для человека: (а) положить `pump_amm.json` (официальный `@pump-fun/pump-sdk/idl/`) в
   `data/idl/` и разрешить тест-парсер IDL; (б) одна **read-only** симуляция на реальном mint
   (не отправка) и прислать логи.
2. **Нет ни одной реальной sell-транзакции** ни в `data/txcache`, ни в журналах — только `buy_exact_quote_in`.
3. **Нет подтверждения `canonicalPool`** на pump-mint (см. §3.4).
4. **Неизвестно назначение 7 хвостовых аккаунтов** реальной инструкции и не сопоставлены `[17]`/`[18]`
   с `coin_creator_vault_*`.
5. **Неизвестна математика выхода AMM** (формула §3.3 не сверена).

Всё перечисленное — `TODO(verify)` и не блокирует шаги 2, 4, 5; **блокирует** обещание «бот сам
продаст после миграции» (шаг 3 без п.1/п.2 из этого списка даст только честный отказ симуляции).

---

## 7. План следующих шагов (ничего ещё не сделано)

| Шаг | Файлы | Суть | Риск |
|---|---|---|---|
| 2 | `lib/pumpswap.mjs`, `scripts/rescue-sell.mjs` | rescue импортирует `canonicalPool`, `decodePool`, `decodeGlobalConfig`, `pickProtocolFeeRecipient`, `ammSellIx`, `TOKEN_PROGRAM` из `lib/pumpswap.mjs`; локальные копии удаляются. Раскладка не меняется. | низкий: поведение идентично, покрывается новым тестом на равенство |
| 3 | `graduation.mjs` | перед `sendTxWithRetry` для venue `pumpswap`: журнал `sell_sim` с `ok`, `quoteOut`, `unitsConsumed`, `logs` — **до** отправки; при `!ok` полный дамп и `return`. Флаг `DRY_SELL=yes`: только в LIVE-режиме, симуляция + журнал, отправки нет. | средний: затрагивает live-путь → закрывается тестом с мок-RPC |
| 4 | `graduation.mjs` | гейт/нет пула больше не удаляют позицию: инкремент `attempts`, бэкофф `nextSellAt`, `stuck` только при `attempt >= SELL_MAX_ATTEMPTS`; в `reason` — venue, токены, причина; текст ALERT без «retries stopped» для п.2/п.3. | средний: меняет поведение монитора (позиция «висит» дольше) |
| 5 | `scripts/pumpswap-ix.test.mjs` (новый) | байтовое сравнение `ammSellIx` на фиксированных `g`/`p`, список и порядок 21 аккаунта; тест выбора venue с мок-`connection`. | низкий |
| 6 | `AUDIT_SELL.md` | инструкция для человека: как прогнать `DRY_SELL=yes`, что включить для live, какие `TODO(verify)` закрыть. | — |

---

## 8. TODO(verify) — только то, что нельзя проверить без человека/сети

| # | Что | Как проверить |
|---|---|---|
| V1 | Раскладка `sell` (21 аккаунт) соответствует развёрнутой программе | ~~Одна `simulateTransaction`~~ — **начала проходить**: симуляция `HbZM3fVa…pump` дошла до последней проверки программы (см. §12), все CPI до неё прошли |
| V2 | Нужны ли `global_volume_accumulator` + `user_volume_accumulator` в `sell` (BUG 13) | Пока **нет**: программа не пожаловалась на их отсутствие (падение позже, на `pool_v2`). Требуется успешная симуляция целиком |
| V3 | `canonicalPool()` даёт верный адрес для pump-mint | **Подтверждено** симуляцией: `canonicalPool(HbZM3fVa…pump) = 86rSR66f…xqS7`, аккаунт существует и раскодировался (§12) |
| V4 | Формула `ammSellQuote` совпадает с программой (fee split, virtual reserves) | Сравнить `net` с логами успешной sell-симуляции / реальной sell-tx |
| V5 | `createCloseAccount` не завышает PnL (аренда ATA) | Вычесть аренду из `solReceivedSol` и подтвердить арифметику на реальной tx |
| V6 | Порядок 11/12 (`base_token_program`, `quote_token_program`) у `sell` | **Подтверждено**: `TransferChecked` Token-2022 (аккаунт 11) и SPL Token (12) прошли в симуляции |
| V7 | `pool_v2` — какой аккаунт и по каким сидам | **Сиды подтверждены официальным SDK** `@pump-fun/pump-sdk@4.3.1`: `PDA(["pool-v2", baseMint])`, передаётся как remaining account продажи (см. §13). Осталось подтвердить симуляцией |


---

## 9. Что изменено (шаги 2–7) — сверка с §2 и §5

| # | Было | Стало |
|---|---|---|
| 2 | `canonicalPool`, `decodePool`, `decodeGlobalConfig`, `pickProtocolFeeRecipient`, `ammSellIx` + PDA-константы дублировались в `lib/pumpswap.mjs` и `scripts/rescue-sell.mjs` | один модуль `lib/pumpswap-sell.mjs`; `lib/pumpswap.mjs` реэкспортирует, `scripts/rescue-sell.mjs` импортирует. Раскладка аккаунтов и байты **не менялись** |
| 2 | в rescue локальный `TOKEN_PROGRAM`, `getAccountInfo(AMM_GLOBAL_CONFIG)` без `.catch`, `min_out` через `Math.floor(expectedSol*1e9)` | общий `TOKEN_PROGRAM`, `.catch(() => null)`, `min_out` из BigInt-лампортов (`expectedLamports`) |
| 3 | журнал писал только текст ошибки симуляции, без логов; при удачной симуляции — ничего | новый `lib/amm-sell.mjs`: перед отправкой пишутся `sell_sim` (ожидаемый SOL, `min_out`, CU, логи) или `sell_attempt` (ошибка + **все** логи + `unitsConsumed` + сырой `err`) |
| 3 | флага не было | `DRY_SELL=yes` — сборка + симуляция + журнал (`sell_dry`), `sendTransaction` не вызывается ни при каких условиях |
| 4 | гейт `LIVE_CONFIRM_AMM` и «нет пула» вызывали `markStuck` на `attempts = 0` → позиция исчезала | `deferSell()`: `attempts += 1`, бэкофф `2s·2^(n-1)`, позиция **остаётся**; `stuck` только при `attempt >= SELL_MAX_ATTEMPTS`. Гейт по-прежнему запрещает отправку при `LIVE_CONFIRM_AMM !== "yes"` |
| 4 | `ALERT … retries stopped` без причины и счётчика | `STUCK (venue=… attempts=N/3): причина — retries stopped after N/3 attempts`; фраза только когда попытки реально кончились |
| 4 | `solReceivedSol = solDelta` (аренда WSOL-ATA попадала в выручку) | аренда вычитается, если WSOL-счёт существовал **до** tx и закрыт в нём: `rentReturnedSol` в результате, `solReceivedSol` — только выручка |
| 5 | тестов на sell-инструкцию не было | `scripts/pumpswap-sell.test.mjs` (24 байта, `33e685a4017f83ad`, 21 аккаунт, порядок/флаги, PDA) и `scripts/amm-sell.test.mjs` (гейт, нет пула, логи симуляции, `sell_sim` до отправки, `DRY_SELL` не отправляет) — сеть и `sendTransaction` замоканы |

Новые типы записей в журнале: `sell_sim`, `sell_dry`, `sell_deferred` (плюс прежние
`sell_attempt`, `sell_failed`, `stuck`, `trade`).

---

## 10. Как проверить

### 10.1 DRY_SELL без `--live` (безопасно, денег не тратит)

Бот в DRY RUN ничего не покупает по-настоящему, но при `DRY_SELL=yes` для каждой позиции, чья
bonding curve завершилась, он **соберёт и симулирует настоящую PumpSwap-продажу** и запишет
результат в журнал.

```
$env:DRY_SELL="yes"; npm run graduation
```

`LIVE_CONFIRM` и `LIVE_CONFIRM_AMM` в этом режиме не нужны: отправлять нечего, гейт проверяется
только на боевом пути.

Что смотреть в `data/journal/<дата>.jsonl`:

| `type` | Когда появляется | Ключевые поля |
|---|---|---|
| `sell_sim` | симуляция прошла | `mint`, `expectedSol`, `minOut`, `unitsConsumed`, `logs` |
| `sell_attempt` | симуляция не прошла | `error`, `logs` (полные), `unitsConsumed`, `errorRaw` |
| `sell_dry` | отправка запрещена флагом | `reason: "DRY_SELL=yes"` |

Быстрый фильтр по нужным mint:

```
Select-String -Path data\journal\*.jsonl -Pattern '"type":"sell_(sim|attempt|dry)"' |
  ForEach-Object { $_.Line } | Select-String -Pattern '322es1iMfE|48e5Btne|HbZM3fVa'
```

Минты из журнала STUCK, на которых это имеет смысл:
`322es1iMfEghyuqi6Hby3eLkMsbfAKBCacmiZqG8pump`,
`48e5BtneVunFTZDo96TvEPsG3YquCSizMoowUaTZpump`,
`HbZM3fVa7XWGbLPzvdZykDX1mtjPJw9UUE8fVg3Wpump`.

### 10.2 Проба одной симуляции (V1/V2/V3/V4)

```
node scripts/probe-sell-sim.mjs --mint 322es1iMfEghyuqi6Hby3eLkMsbfAKBCacmiZqG8pump
```

Ключ нужен только для чтения баланса и ATA; транзакция **не отправляется**, флага `--live` у
скрипта нет. Он печатает `err`, `describeTxError`, `unitsConsumed` и все логи, а также пишет
`data/probe/sell-sim-<mint>-<ts>.json` (раскладка 21 аккаунта, резервы, котировка).
Присланный файл закрывает V1/V2/V4: `err: null` означает, что раскладка принята программой.
Если токенов этого mint в кошельке нет: `--tokens <raw>` подставит количество.

### 10.3 DRY_SELL на боевом пути (симуляция есть, отправки нет)

```
$env:LIVE_CONFIRM="yes"; $env:LIVE_CONFIRM_AMM="yes"; $env:DRY_SELL="yes"; npm run graduation -- --live
```

Внимание: `DRY_SELL` отключает только **продажу через PumpSwap**. Покупки в LIVE остаются
настоящими. Запуск нужен, чтобы увидеть `sell_sim` для реальной позиции.

### 10.4 Что делает человек, чтобы включить реальную продажу после миграции

1. Положить IDL: `data/idl/pump_amm.json` (официальный `@pump-fun/pump-sdk/idl/`).
   Без него раскладка аккаунтов остаётся «списанной», а не проверенной (V1/V2/V6).
2. Прогнать 10.2 по одному-двум mint'ам и прислать JSON. `err: null` → раскладка верна;
   `InstructionError` + `Custom` в логах → не хватает аккаунта (например v2-инструкция с
   volume accumulator) либо расходится котировка.
3. Если симуляция `Ok`, но `expectedSol` заметно отличается от реального вывода — это V4
   (формула `ammSellQuote`), правится отдельно.
4. Прогнать 10.3 на дешёвой позиции и убедиться, что в журнале есть `sell_sim` и нет `trade`.
5. Только после этого — живой выход одной позиции:
   `$env:LIVE_CONFIRM="yes"; $env:LIVE_CONFIRM_AMM="yes"; npm run graduation -- --live`,
   затем смотреть в журнале `trade` с `venue: "pumpswap"`.
6. Сверить `solReceived` c `quoteOut` и `rentReturnedSol` (V5): расхождение ≈0.00204 SOL значит,
   что аренда всё ещё считается выручкой.
7. Держать `LIVE_CONFIRM_AMM=yes` в `.env` постоянно — решение человека, не дефолт кода.

`scripts/rescue-sell.mjs` использует тот же модуль и тот же гейт: без `LIVE_CONFIRM_AMM=yes` он
не отправляет AMM-продажу, но теперь показывает цену и не падает на нечитаемом global config.

---

## 11. Что нужно положить в проект

| Файл | Зачем |
|---|---|
| `data/idl/pump_amm.json` | единственный способ проверить V1/V2/V6 без реальной транзакции; после появления можно добавить тест-парсер IDL и сверять раскладку автоматически |
| результат `data/probe/sell-sim-*.json` | закрывает V1/V2/V4 фактическими логами симуляции |

Пока этих файлов нет, все утверждения о раскладке `sell` остаются `TODO(verify)` и в коде
помечены именно так: `lib/pumpswap-sell.mjs`, `lib/amm-sell.mjs`, `lib/exec.mjs`.

---

## 12. Хвост аккаунтов 23–29 в кэше и `pool_v2` (Custom 6062)

Повод: симуляция продажи упала с `Custom 6062` —
`AnchorError … sell.rs:520. Error Code: InvalidPoolV2. Error Message: pool_v2 remaining account is missing or invalid.`
Ниже — офлайн-разбор `data/txcache` (сеть не использовалась).

### 12.1 Что есть в кэше

45 файлов, **8** инструкций pump-amm: 4 top-level `buy_exact_quote_in`
(`c62e1552b4d9e870`) и 4 inner с `e445a52e51cb9a1d`. **Ни одной `sell`** (`33e685a4017f83ad`).

Четыре транзакции покупки (по 30 аккаунтов), хвост 23–29:

| # | `2J7G…` mint `CsXAT9bd…bonk` | `w3wr…` тот же mint | `4g5e…` mint `BWRfm9hQ…BAGS` | `XYqs…` тот же mint |
|---|---|---|---|---|
| 23 | `A7hAgCzFw14fejgCp387JUJRMNyz4j89JKnhtKU8piqW` | `A7hAgCzFw14fejgCp387JUJRMNyz4j89JKnhtKU8piqW` | `A7hAgCzFw14fejgCp387JUJRMNyz4j89JKnhtKU8piqW` | `A7hAgCzFw14fejgCp387JUJRMNyz4j89JKnhtKU8piqW` |
| 24 | `4Kj7f6xDK7fY5FTRg54Fv54Fbr8kU6WopqbPpbyTBNaG` | `4Kj7f6xDK7fY5FTRg54Fv54Fbr8kU6WopqbPpbyTBNaG` | `2fvib34wVq9o9r7Lh2859qMXQN8J7F1csu4fKNwESVe4` | `2fvib34wVq9o9r7Lh2859qMXQN8J7F1csu4fKNwESVe4` |
| 25 | `DGKJQb7jFBW2LyoMkXeiP3sTwtPdk1v12EPo2Chn8rLC` | `2F7TtCdYFWf2byGcmWtHxiGTQB16UtB8QEcrH8y68Xxm` | `4Kt1FyUddPhUnDQ8jPMB36Wh6QMdkiRYvBRp1gMLe6SA` | `2h48vurxfTuQJenpmu2NQTtqxRDGza3q5DiRfz14nxSG` |
| 26 | `QSSe7JvehvPVHpXM5qcCoRAKKLFXXzYDoWYBfX2XDwe` | `4rVk3JEomWFbcHCBj8NAjPRiPvsyY17cJ5QZSQfpAiBP` | `4X23ff48xTc4ndGfwAbaUnRNbUMmidee9f2F9VNF5KQg` | `ANGGw4Gpjyw1tjEkv9ppw8zsqbbMR6akzqqsFjeDYhDz` |
| 27 | `2F7TtCdYFWf2byGcmWtHxiGTQB16UtB8QEcrH8y68Xxm` | `QSSe7JvehvPVHpXM5qcCoRAKKLFXXzYDoWYBfX2XDwe` | `AS8UtAqa2GupxGtSxq1qoXZzpUtj2Xf2FSPpHthKdUYY` | `2F7TtCdYFWf2byGcmWtHxiGTQB16UtB8QEcrH8y68Xxm` |
| 28 | `AS8UtAqa2GupxGtSxq1qoXZzpUtj2Xf2FSPpHthKdUYY` | `Dmk8Tjf7xbELmeg4j3v8sCmx7tYNLeNwCxbeBqfia4Py` | `CuTAMm6heSx6SmEJxfxGbRdtkBQmHgYXjDtyQWQQUT9Z` | `DGKJQb7jFBW2LyoMkXeiP3sTwtPdk1v12EPo2Chn8rLC` |
| 29 | `CuPNrTwAqj3iew3LwWDNxp6GdJcQcQSDjTDf7ZqkYGeJ` | `HbPR3bpDR8WxsqgBu6QUAZcEXhUJrdChvBt7UWyz8M82` | `2F7TtCdYFWf2byGcmWtHxiGTQB16UtB8QEcrH8y68Xxm` | `8DQ7vtN8frGsv7jpH2sUsrdUfXJLTnKcPabjiURhUsYC` |

### 12.2 Сверка с `PDA["pool-v2", baseMint]`

| mint | PDA `["pool-v2", baseMint]` (программа `pAMM…`) | Есть в tx? |
|---|---|---|
| `CsXAT9bdaopT4o6SwJXm195LxGGwS1x8JhBht5WVbonk` | `5qLmRndbmBL8P2N3BJy4tarzoyuq34gjvk1KrL8YyVtv` | **нет** (ни в `2J7G…`, ни в `w3wr…`) |
| `BWRfm9hQQdqi3TNM3CoyNTWANd375qcrDduEW9cGBAGS` | `4CgJNST7r2cKWiFv7zcozWkvAFqhCahLY1zfbTxnBmLi` | **нет** (ни в `4g5e…`, ни в `XYqs…`) |

Дополнительно проверены варианты сидов — ни один адрес не встречается среди 30 аккаунтов:
`["pool_v2", mint]`, `["pool-v2", pool]`, `["pool-v2", mint, WSOL]`,
`["pool-v2", poolAuthority, mint, WSOL]`, `["pool-v2", u16(0), poolAuthority, mint, WSOL]`,
`["pool-v2", pool, mint]` — в программах `pAMM…` и `6EF8…`.

**Результат: не совпало.** `pool_v2` в `ammSellIx` не добавлен: подставлять неподтверждённый
адрес нельзя (это был бы выдуманный аккаунт).

### 12.3 Почему этот хвост в принципе не может быть эталоном

* Две транзакции с **одним и тем же** mint (`CsXAT9bd…`) совпадают только в [23] и [24];
  [25]–[29] — разные адреса и разный набор, а не перестановка. Раскладка программы так себя
  вести не может.
* `A7hAgCzF…` встречается в **9 из 45** файлов кэша, `2F7TtCdY…` — в **17 из 45**: это общие
  (роутерные) аккаунты вызывающей стороны, а не per-pool.
* Вывод: 23–29 — `remaining_accounts`, которые передаёт вызывающая сторона; v1-инструкция
  `buy_exact_quote_in` их не валидирует. Для `sell` (v2-путь) программа их читает и требует
  `pool_v2` — но в покупках его нет вообще, поэтому кэш не может подтвердить ни адрес, ни сиды.

### 12.4 Что из хвоста всё-таки объяснено (вопрос из §3.4)

| # | Значение | Что это (проверено выводом PDA) |
|---|---|---|
| 15 | `GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR` | `PDA["__event_authority"]` в `pAMM…` — совпало |
| 19 | `C2aFPdENg4A2HQsmrd5rTw5TaYBX5Ku887cWjbFKtZpw` | `PDA["global_volume_accumulator"]` **в `pAMM…`** (не в pump.fun!) — совпало |
| 20 | `3AK4sQmR…` / `8SyMEec…` / `8zfC5PV…` / `BnSd4t8L…` | `PDA["user_volume_accumulator", user]` в `pAMM…` — свой в каждой tx, совпало |
| 21 | `5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx` | `PDA["fee_config", pAMM…]` в программе `pfee…` — совпало |
| 23 | `A7hAgCzFw14…` | ни один проверенный сид не даёт этот адрес; 9/45 файлов → общий аккаунт вызывающей стороны |
| 24 | `4Kj7f6xDK7…` / `2fvib34wVq…` | стабилен для одного mint (две tx) → mint-scoped, но **не** `pool_v2` ни в одном варианте сидов |
| 25–29 | … | меняются между двумя tx одного mint → не часть раскладки программы |

Уточнение к §3.4: тогда было написано «`global_volume_accumulator` и `user_volume_accumulator`
совпали» — теперь видно, что они выводятся **под программой `pAMM…`**, а не под `6EF8…`.

### 12.5 Что дала сама симуляция (`data/probe/sell-sim-HbZM3fVa-…json`)

| Поле | Значение |
|---|---|
| mint | `HbZM3fVa7XWGbLPzvdZykDX1mtjPJw9UUE8fVg3Wpump` |
| pool (`canonicalPool`) | `86rSR66fVQX8K6pqWuPLXjvUNWFXfdyEiA5LzyUpxqS7` — аккаунт существует, `PoolState` раскодировался |
| creator | `xgzHcG76hChWvMungAAjMS41t5AvN1ktVtJghB8C8yp`, `creatorFeeBps=0`, `isMayhem=false`, `isCashback=false` |
| результат | `InstructionError[3, Custom 6062]`, 68 929 CU |
| прошли успешно | `pfee GetFeesWithQuoteMint`, `Token-2022 TransferChecked` (базовый mint), два вызова SPL Token |

Порядок логов важен: программа успела списать токены по нашим аккаунтам и **только в конце**
(`sell.rs:520`) потребовала `pool_v2`. Значит:

* **V1/V3/V6 закрыты положительно** — 21 аккаунт и их порядок (включая 11 = Token-2022,
  12 = SPL Token) приняты, пул найден верно;
* **V2 пока в пользу «не нужны»** — на отсутствие volume-accumulator программа не пожаловалась;
* остаётся **V7**: `pool_v2` как remaining account.

### 12.6 Что нужно, чтобы закрыть V7 (без гадания)

1. `data/idl/pump_amm.json` → тип/структура `PoolV2` и её seeds. Это единственный offline-путь.
2. Либо одна **read-only** проверка адресов-кандидатов: `getAccountInfo` для
   `PDA(["pool-v2", mint])` и родственных вариантов на реальном pool — существование аккаунта
   с owner `pAMM…` подтвердит сиды (сеть, но без отправки транзакций).
3. Либо одна реальная `sell`-транзакция из сети: в кэше их **нет**, поэтому сверить нечего.

До этого `pool_v2` в `ammSellIx` **не добавляется**: раскладка остаётся 21 аккаунт, а ошибка 6062
честно журналируется (`sell_attempt` с полными логами), позиция не теряется благодаря `deferSell`.

Тест на совпадение `pool_v2` с хвостом (пункт 4 задания) не добавлен — он был бы проверкой
заведомо ложного утверждения: совпадения нет. Вместо него факты зафиксированы здесь и в §8 (V7).

---

## 13. Официальный SDK: sell / pool_v2

Источник — `@pump-fun/pump-sdk@4.3.1`, установленный **вне репозитория**
(`C:\Users\HUAWEI\Downloads\pump-sdk-ref`, `npm ls @pump-fun/pump-sdk` → `4.3.1`). Код бота не
менялся: это справка, а не патч.

### 13.1 Что нашлось по запросам

| Запрос | Где | Что |
|---|---|---|
| `pool-v2` | `src/swap/pda.ts:191` | сид PDA |
| `poolV2` | `src/swap/pda.ts`, `src/swap/offlinePumpAmm.ts:797`, `:1047` | функция `poolV2Pda` и два места, где она попадает в remaining accounts |
| `pool_v2` | `src/idl/pump_amm.json` | ошибка `InvalidPoolV2` в таблице ошибок IDL |
| `remainingAccounts` | `src/swap/offlinePumpAmm.ts` (buy/sell/multi-hop), `src/swap/*.ts` | 37 вхождений: все trade-инструкции собирают их явно |

### 13.2 Сиды `pool_v2`

```ts
// src/swap/pda.ts:191
export function poolV2Pda(baseMint: PublicKey): PublicKey {
  return pumpAmmPda([Buffer.from("pool-v2"), baseMint.toBuffer()]);
}
```

То есть `PDA(["pool-v2", baseMint], pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA)` — **ровно то,
что было выведено в §12.2** (`5qLmRndb…` для `CsXAT9bd…bonk`, `4CgJNST7…` для `BWRfm9hQ…BAGS`).
Расхождения нет; в покупках его не было потому, что это **remaining account продажи**, а не
покупки — §12.3 остаётся в силе, кэш его подтвердить не мог.

### 13.3 Аккаунты `sell` (21) — IDL, `src/idl/pump_amm.json`

Дискриминатор IDL: байты `[51,230,133,164,1,127,131,173]` = `33e685a4017f83ad` — совпадает с нашим.

| # | Аккаунт | writable | signer | В `lib/pumpswap-sell.mjs` |
|---|---|---|---|---|
| 0 | `pool` | да | — | совпадает |
| 1 | `user` | да | да | совпадает |
| 2 | `global_config` | — | — | совпадает |
| 3 | `base_mint` | — | — | совпадает |
| 4 | `quote_mint` | — | — | совпадает |
| 5 | `user_base_token_account` | да | — | совпадает |
| 6 | `user_quote_token_account` | да | — | совпадает |
| 7 | `pool_base_token_account` | да | — | совпадает |
| 8 | `pool_quote_token_account` | да | — | совпадает |
| 9 | `protocol_fee_recipient` | **—** | — | **у нас `isWritable: true`** — расхождение |
| 10 | `protocol_fee_recipient_token_account` | да | — | совпадает |
| 11 | `base_token_program` | — | — | совпадает (Token-2022) |
| 12 | `quote_token_program` | — | — | совпадает (SPL Token) |
| 13 | `system_program` | — | — | совпадает |
| 14 | `associated_token_program` | — | — | совпадает |
| 15 | `event_authority` | — | — | совпадает |
| 16 | `program` | — | — | совпадает |
| 17 | `coin_creator_vault_ata` | да | — | совпадает |
| 18 | `coin_creator_vault_authority` | — | — | совпадает |
| 19 | `fee_config` | — | — | совпадает |
| 20 | `fee_program` | — | — | совпадает |

Итог: **порядок и состав 21 аккаунта верны** (V1/V6 подтверждены ещё и IDL). Единственное
отличие — флаг writable у `protocol_fee_recipient`; передать read-only аккаунт writable runtime
обычно разрешает, а `isMut` у программы здесь `false`, так что это косметика, но фиксируется.

### 13.4 Remaining accounts `sell` — вот чего не хватало

`src/swap/offlinePumpAmm.ts`, `sellInstructionsNoPool()` (строки 1039-1104):

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

| # | Аккаунт | Когда | writable |
|---|---|---|---|
| r0 | `ATA(quote_mint, user_volume_accumulator)` | только `pool.isCashbackCoin` | да |
| r1 | `PDA(["user_volume_accumulator", user])` | только `pool.isCashbackCoin` | да |
| r2 | `PDA(["pool-v2", base_mint])` | `pool.coin_creator != 0` | нет |
| r3 | `buybackFeeRecipient` (случайный из `globalConfig.buybackFeeRecipients`, `src/swap/fees.ts:202`) | всегда | нет |
| r4 | его ATA по `quote_mint` (`allowOwnerOffCurve = true`) | всегда | да |

Наш `ammSellIx` не передаёт **ни одного** remaining account — отсюда `Custom 6062`
(`sell.rs:520 InvalidPoolV2`): программа ищет `pool_v2` среди remaining accounts, не находит и
падает уже после того, как списала токены. На пробе `HbZM3fVa…pump` `coinCreator = xgzHcG76…`
(не `default`), `isCashback = false`, значит нужны были **r2, r3, r4**.

### 13.5 `sell_v2` — альтернатива, которую SDK использует по флагу

| | `sell` | `sell_v2` |
|---|---|---|
| Дискриминатор | `33e685a4017f83ad` | `5df6823ce7e940b2` (= `sha256("global:sell_v2")[0..8]`) |
| Аккаунтов | 21 | 17 |
| Отличия | `protocol_fee_recipient`, его ATA, `coin_creator_vault_*`, `fee_program` | вместо них — `user_volume_accumulator` и `buyback_fee_recipient` (его ATA); remaining accounts нет |
| Когда SDK выбирает | по умолчанию | `{ v2: true }` **и** `supportsTradeV2(pool)` |

`supportsTradeV2(pool) = !pool.isCashbackCoin` (`src/swap/util.ts:42`), т.е. для нашего пула
(`isCashback = false`) доступны оба варианта. `sell_v2` не требует `pool_v2`, но требует
`user_volume_accumulator` (writable) и **уже существующий** ATA получателя buyback.

### 13.6 Прочее из SDK, что стоит знать

* Перед sell SDK может вставить `extend_account`, если аккаунт пула короче
  `POOL_ACCOUNT_NEW_SIZE = 300` байт (`offlinePumpAmm.ts:72`, `withFixPoolInstructions`). Наш
  `decodePool` работает с порогом 287; если реальный пул короче 300, программе может понадобиться
  `extend_account` до sell (в пробе этого не потребовалось — ошибка была позже).
* ATA получателей комиссии SDK всегда выводит с `allowOwnerOffCurve = true` — совпадает с нашей
  правкой через `ataFor()`.
* `getFeeRecipient` (`src/swap/fees.ts:186`) совпадает с нашей логикой: mayhem → reserved-список,
  иначе обычный, выбор случайный.

### 13.7 Что это меняет в TODO(verify)

| # | Было | Стало |
|---|---|---|
| V7 | «какой аккаунт и по каким сидам» | **Сиды подтверждены официальным SDK**: `["pool-v2", baseMint]`. Осталось подтвердить симуляцией, но вопрос «что за аккаунт» закрыт |
| — | — | Новое: в `sell` нужны ещё **buybackFeeRecipient + его quote-ATA** (всегда) и cashback-пара для cashback-пулов. Это не volume-accumulator из BUG 13 |
| V2 | «нужен ли volume-accumulator» | Для v1 `sell` — **нет** (его нет ни в IDL, ни в remaining accounts). Для `sell_v2` — да, как именованный аккаунт |

**Код не менялся** (задача — только отчёт). Следующий шаг, отдельным заданием: добавить в
`ammSellIx` remaining accounts `[pool_v2?, buybackFeeRecipient, buybackFeeRecipientAta]`
(+ cashback-пара при `isCashback`), затем прогнать `scripts/probe-sell-sim.mjs` и убедиться, что
6062 ушёл.








