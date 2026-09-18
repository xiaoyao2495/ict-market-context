# PRODUCTION_ENTRY_LOGIC_AUDIT_V1

**Type:** read-only semantic / code audit of the production Entry path.
**Baseline:** `0bb830d1fc0ef4f8614efb554b914287a6ae0d7a` (`main`).
**Nothing was modified:** no Production logic, threshold, EQ, 2L/2R, Dynamic-D, WATCH, FVG, Entry, SL, TP, RR, HTF gate or execution code was changed. No order was placed. No Two-Bar logic was integrated.

---

## A. One-sentence main chain

A **newly confirmed ordinary 2/2 pivot** becomes the *Current Point*; if it sits within **5m-ATR14 × 0.7** of a still-**ACTIVE same-side Causal Dynamic-D historical extreme** (432 bars) it publishes an **EQH/EQL**, which **immediately opens a WATCH**; the WATCH counts **raw 3-candle FVGs** and on its **first same-direction FVG** (ordinal 1) the event is handed to the execution service, which builds an entry plan (**4H bias gate → nearest ACTIVE opposite-side Dynamic-D target → size → RR ≥ 1.0**) and, only if everything passes, places a **LIMIT at the FVG midpoint** with **SL = the Current Point wick** and **TP = the Dynamic-D target** attached after the fill.

---

## B. `scripts/live.js` → Entry : complete call chain

| # | file | function | role |
|---|---|---|---|
| 1 | `scripts/live.js` | `doTick` → `pollNew5m` → `processCandles` | poll newly closed 5m candles, futures-only + continuity gated |
| 2 | `live/liveEngine.js` | `onBar(candle, index)` | per closed bar: liquidity → EQ step → snapshot → displacement → AMD → FVG |
| 3 | `replay/replayState.js` | `incrementalLiquidity` | confirm the pivot at `index-2`, wrap it as swing liquidity, run the EQ step with the newly confirmed swings |
| 4 | `structure/pivotDetector.js` | `detectPivotHigh/Low` | the 2-left / 2-right local pivot test |
| 5 | `liquidity/swingLiquidity.js` | `buildSwingLiquidity` | wrap a pivot into a `SWING_HIGH`/`SWING_LOW` object with `confirmedAt` = confirming candle close |
| 6 | `liquidity/productionEqualLiquidityV1.js` | `step` → `evaluatePivot` | ordinary 2/2 vs ACTIVE Dynamic-D anchors → EQH/EQL |
| 7 | `liquidity/causalDynamicDHistoricalExtremes.js` | `step`, `strictCrosses`, `isAgeExpired` | historical anchor lifecycle, expiry, invalidation, localized wick extreme |
| 8 | `live/liveEngine.js` | `eqFvgCountStepHandler` branch (lines 83-97) | emit the per-bar step `{evaluationTime, newEqualLiquidity, newConfirmedSwings, rawFvg}` |
| 9 | `scripts/live.js` | `handleEqFvgCountStep` | feed the step into the WATCH state machine; queue ordinal-1 notifications |
| 10 | `live/eqFvgCountWatchV1.js` | `step`, `buildWatch`, `consume` | one WATCH per new EQ; count raw 3-candle FVGs |
| 11 | `live/eqFvgCountWatchV1.js` | `rawFvgAt` | the production FVG definition |
| 12 | `live/eqFvgAssociationSemanticV1.js` | `evaluate` → `finalize` | semantic gate; sets `executionAllowed` |
| 13 | `scripts/live.js` | `processPendingSemanticEvents` | if allowed, hand the enriched event to execution |
| 14 | `execution/realOrderExecutionV1.js` | `onFirstMatchingFvg` → `consumeSignal` | admission, one-shot EQ consumption, slot check, plan, order |
| 15 | `execution/executionRulesV1.js` | `buildEntryPlan` | the entry-plan contract |
| 16 | `execution/executionRulesV1.js` | `biasGate` | 4H bias gate |
| 17 | `execution/executionRulesV1.js` | `selectTarget` | nearest un-violated ACTIVE opposite-side Dynamic-D target |
| 18 | `execution/executionRulesV1.js` | `sizeOrder`, `geometry` | tick normalisation, quantity, RR |
| 19 | `execution/binanceExecutionClientV1.js` | `submitEntry`, `submitProtection` | LIMIT entry; STOP_MARKET + TAKE_PROFIT_MARKET protection |
| 20 | `execution/realOrderExecutionV1.js` | `reconcile` → `submitProtection` | protection only after a fill |

---

## C. The 2L/2R detector

`structure/pivotDetector.js`

- **leftBars = 2, rightBars = 2** (`detectPivots` defaults; `replay/replayState.js` passes `RIGHT`).
- **HIGH pivot at K0 requires:** `high[K0] > high[K-2]` and `> high[K-1]` (strict on the left), and **`high[K0] >= high[K+1]`, `>= high[K+2]`** — the right side is *non-strict* (`if (high < candles[index+i].high) return false`), so a tie on the right does **not** disqualify.
- **LOW pivot at K0 requires:** `low[K0] < low[K-2]`, `< low[K-1]` and **`low[K0] <= low[K+1]`, `<= low[K+2]`**.
- **occurredAt** = the pivot candle's `openTime`.
- **confirmedAt** = `candles[K0 + 2].closeTime`.
- **First legal knowledge of K0 being a pivot = the close of K+2** — a **fixed 2-bar (10 minute) confirmation delay**.

The engine does not rescan: `incrementalLiquidity` sets `mid = index - RIGHT` and only accepts the pivot that lands exactly on `mid`, so each pivot is confirmed exactly once, on the bar that closes 2 bars after it.

---

## D. 2L/2R → Current Point

A pivot does **not** become the Current Point by itself. The path is:

```
pivot {type,index,price,occurredAt,confirmedAt}
  → swingLiquidity.buildSwingLiquidity  → SWING_HIGH / SWING_LOW object (registry entry)
  → productionEqualLiquidityV1.evaluatePivot(pivot)
  → EQ event with metadata.currentPivot  =  THE CURRENT POINT
```

`CURRENT_POINT_SOURCE_NOW = 'ORDINARY_CAUSAL_2X2'` — that literal string is written by `buildEvent` into `metadata.currentPivot.source`. It is the only Current Point provider in the production EQ path.

Current Point schema (real field names, `productionEqualLiquidityV1.js:209-217`):

```json
{
  "id": "BTCUSDT:5m:SWING_HIGH:<openTime>",
  "source": "ORDINARY_CAUSAL_2X2",
  "side": "HIGH" | "LOW",
  "price": 76570,          // the pivot candle wick (high for HIGH, low for LOW)
  "occurredAt": 1789487700000,
  "confirmedAt": 1789488599999,
  "sourceIndex": 360
}
```

Fields that exist on the enclosing EQ event rather than on the Current Point: `symbol`, `timeframe`, `type` (`EQH`/`EQL`), `liquidityType`, `side` (`BSL`/`SSL`), `createdAt`, `status`, `touchedAt/sweptAt/brokenAt`, `metadata.historicalPartners`.

There is **no** separate registry/source-selection/filter step between pivot and Current Point beyond `pointSideOf` (type → side) and the `evaluatedPivotKeys` dedupe.

---

## E. Current Point → EQ

`liquidity/productionEqualLiquidityV1.js` (`VERSION = 'DYNAMIC_D_36H_CROSS_SOURCE_V1'`)

- **LOW Current Point → EQL**, **HIGH Current Point → EQH** (`type = side === 'HIGH' ? 'EQH' : 'EQL'`).
- **Historical partner source:** `state.dynamicD.recentSurvivalPoints` filtered to the same side — i.e. **Causal Dynamic-D historical extremes**, not pivots and not the swing registry.
- **Partner must satisfy** (`wasEligibleAtCandidateOccurrence`): `point.state === 'ACTIVE'`, `point.confirmedAt <= pivot.occurredAt`, `point.occurredAt < pivot.occurredAt`, and `1 <= barsBetween <= 432` (36H).
- **Partner price field:** `point.price` — the **localized wick extreme** (`SAME_PROCESS_WICK_V1`); the partner record also carries `selectorPrice`, `selectorWickPrice`, `localizedExtremePrice`, `localizationMode`.
- **Current price used for comparison:** `pivot.price` = the pivot candle's **wick** (`low` for LOW, `high` for HIGH).
- **Comparison domain: WICK_TO_WICK.**
- **Distance:** `Math.abs(pivot.price - anchor.price)`.
- **Tolerance:** `fiveMinuteAtrValue * thresholds.equalLiquidity.priceStrongMaxATR` = **5m Wilder ATR14 × 0.7** (verified in `config/thresholds.js:15-18` and `evaluatePivot` line 239).
- Before pairing: an **aged** anchor (5 calendar days past confirmation) is marked INACTIVE and skipped; a **strict cross** (wick-to-wick, strict inequality) marks the anchor INACTIVE and precludes pairing.
- An EQ event is emitted only if at least one partner matched, and it carries **all** matching partners (`primaryPartnerSelection: false`).

---

## F. Historical Dynamic-D partner

`liquidity/causalDynamicDHistoricalExtremes.js`, referenced as `dynamicD.VERSION` and `dynamicD.HISTORICAL_EXTREME_LOCALIZATION` in the EQ event metadata. Anchors are **close-detected** Dynamic-D processes whose extreme is then localized to a wick via `SAME_PROCESS_WICK_V1`. `LOOKBACK_BARS = 432`, `LOOKBACK_TIME = '36H'`.

This is the **only** historical-partner provider for EQ. The legacy ATR50 ZigZag is explicitly described in the module header as fully replaced.

---

## G. Dynamic-D's real roles (they are different roles, keep them apart)

| role | where | what it provides |
|---|---|---|
| **Historical Partner for EQ** | `productionEqualLiquidityV1.eligibleHistoricalPoints` | same-side ACTIVE anchor whose wick price is within 5m-ATR14 × 0.7 |
| **TP target for the entry plan** | `executionRulesV1.selectTarget(context.dynamicDPoints, …)` | the nearest ACTIVE **opposite-side** point not yet traded through |
| **Entry-cancel trigger (indirect)** | `realOrderExecutionV1.onConfirmedSwings` | a newly confirmed SWING_* after `decisionTime` cancels a resting entry |

Nowhere is Dynamic-D the Current Point provider. `state.dynamicD` and `state.productionEq.events` are separate stores; the entry plan reads `context.dynamicDPoints` (from `engine.getState().productionEq.dynamicD.*`) for the target, and reads `event.eqSourceContext.currentPivot` for the stop.

---

## H. EQ confirmedAt / availableAt

Using your example — historical partner already exists, the Current Point extreme occurred at 10:00, the 2/2 confirms at 10:10:

| field | value |
|---|---|
| `EQ.occurredAt` | **10:00** (the pivot candle openTime) |
| `EQ.createdAt` | **10:10** (the confirming candle's closeTime) |
| `EQ.confirmedAt` | **10:10** |
| `EQ.availableAt` | **10:10** — the same `onBar` step publishes it |

So the **earliest an EQ can exist is 10:10**, not 10:00. The 2-bar confirmation delay is therefore embedded in `confirmedAt`, `createdAt` and in everything downstream (WATCH `openedAt`, the FVG counting floor, and the earliest possible entry `decisionTime`).

---

## I. EQ → downstream opportunity chain

There is **no "liquidity taken / swept" step** in this path. The chain is:

```
EQ event (newEqualLiquidity)
  → eqAlerts.onStep({evaluationTime, newEqualLiquidity, rawFvg})
  → buildWatch(liquidity)   [immediate, no other precondition]
```

The EQ object does carry `touchedAt`, `sweptAt`, `brokenAt` fields, but they are initialised to `null` and **no production code in the entry path ever sets or reads them**. The names `LIQUIDITY_TAKEN` / `LIQUIDITY_SWEEP` do not appear in the WATCH or entry path.

---

## J. WATCH creation

`live/eqFvgCountWatchV1.js` `buildWatch`:

- created for **every** new `EQL`/`EQH` event, with `watchId = 'EQ_FVG_COUNT_WATCH_V1:' + liquidity.id`;
- `expectedDirection = type === 'EQL' ? 'BULLISH' : 'BEARISH'`;
- `openedAt = liquidity.confirmedAt` (i.e. the EQ confirmation, never `occurredAt`);
- `eqSourceContext` frozen at open (current point + historical partners);
- counters `bullFvgCount` / `bearFvgCount` start at 0.

**Gate chain: `EQ → WATCH`. Nothing else.** There is **no** displacement gate, no direction-match gate, no time-window gate, no scenario/AMD/structure gate, and **no HTF gate** at WATCH creation. (The earlier WATCH research-era V2 context field is deliberately deleted on restore.)

---

## K. Time windows in the current entry path

| RULE | VALUE | FILE | FUNCTION |
|---|---|---|---|
| pivot right-side confirmation | 2 bars | `structure/pivotDetector.js` | `detectPivots` |
| EQ historical lookback | 432 bars (36H) | `liquidity/productionEqualLiquidityV1.js` | `wasEligibleAtCandidateOccurrence` |
| EQ anchor age expiry | 5 calendar days | `liquidity/causalDynamicDHistoricalExtremes.js` | `isAgeExpired` |
| EQ tolerance ATR period | 5m Wilder ATR14 | `liquidity/productionEqualLiquidityV1.js` | `updateFiveMinuteAtr` |
| EQ tolerance multiplier | × 0.7 | `config/thresholds.js` | `equalLiquidity.priceStrongMaxATR` |
| FVG gap lookback | 2 bars (k1 = index-2, k3 = index) | `live/eqFvgCountWatchV1.js` | `rawFvgAt` |
| WATCH FVG counting window | `confirmedAt >= watch.openedAt`, no upper bound | `live/eqFvgCountWatchV1.js` | `consume` |
| WATCH lifetime | closes when the **2nd** same-direction FVG arrives (matching or opposite) | `live/eqFvgCountWatchV1.js` | `consume` |
| displacement→FVG association window | `thresholds.fvg.maxDisplacementBars = 2` | `config/thresholds.js` / `live/liveEngine.js` | `onBar` step 6 |
| snapshot cadence | every 12 bars | `live/liveEngine.js` | `onBar` |
| entry LIMIT lifetime | rests until filled **or** cancelled by a new opposite-side confirmed swing after `decisionTime` | `execution/realOrderExecutionV1.js` | `onConfirmedSwings` |
| legacy simulator wait (NOT used by real orders) | `thresholds.trade.simulator.maxEntryWaitBars = 12` | `config/thresholds.js` | backtest simulator only |

---

## L. FVG production semantics

`live/eqFvgCountWatchV1.js` `rawFvgAt(candles, index, symbol)` — this is what the production entry actually consumes:

- **3-candle gap using k1 = `candles[index-2]` and k3 = `candles[index]`** (k2 is the middle, only used implicitly).
- **Bullish FVG:** `k3.low > k1.high` → zone `[k1.high, k3.low]`.
- **Bearish FVG:** `k3.high < k1.low` → zone `[k3.high, k1.low]`.
- **confirmedAt = `k3.closeTime`** (the same bar being processed).
- FVGs are computed on **every completed 5m bar**, regardless of any WATCH; a WATCH then consumes those whose `confirmedAt >= openedAt`.
- **Matching direction** = `rawFvg.direction === watch.expectedDirection`.
- A WATCH can consume **many** raw FVGs; only the **1st and 2nd** same-direction ones produce notifications, and the **2nd** closes the WATCH.
- **Invalidation:** there is no FVG-invalidation test in this path. The only "expiry" is the 2nd same-direction FVG closing the WATCH.

**The production entry uses FVG *creation*, not first touch.** The entry event is `ordinal === 1` of the matching-direction counter, i.e. the bar on which the matching 3-candle gap closes.

Note the two different FVG notions in the codebase: the raw 3-candle FVG above (used by the WATCH/entry path) and the richer displacement-associated FVG registry (`replayState.incrementalFvg` + `thresholds.fvg.*`) used by the legacy opportunity/scenario statistics. The entry consumes the **raw** one.

---

## M. FIRST_TOUCH

**There is no FIRST_TOUCH concept anywhere in the production entry path.** No wick/trade/aggTrade/close touch of the FVG is computed, no primary/fallback touch source exists, and no touch timestamp feeds the entry. The entry decision time is the FVG's own `confirmedAt`. (The word appears in the repository only in research/audit material, e.g. a replay-impact fixture note, never in `scripts/live.js`, `live/*`, or `execution/*`.)

---

## N. ENTRY_PLAN_CREATION_CONTRACT

`execution/realOrderExecutionV1.js` `onFirstMatchingFvg` → `consumeSignal` → `executionRulesV1.buildEntryPlan`.

**Preconditions (in order):**

1. `event.ordinal === 1` (the first **matching-direction** FVG of an open WATCH; ordinal 2 is ignored).
2. `getNewTradeAdmission()` admits: `scanAdmitted` (symbol in the runtime universe), `analysisReady` (≥ 723 closed 5m and ≥ 120 closed 4H), `dataSource.executionRulesReady(symbolRules)`.
3. The EQ is not already consumed (`repository.consumeEq`) — **one trade per EQ id**, consumed synchronously at the WATCH boundary.
4. The symbol slot is free (`slotFree()`), i.e. no other active trade lifecycle.
5. Semantic gate (production wiring): `eqFvgAssociationSemantic` `executionAllowed` (only enforced when `liveGateEnabled === true`).

**Then `buildEntryPlan` requires, in this exact order:**

1. derive `direction` (`EQL → LONG`, `EQH → SHORT`) and `decisionTime = event.rawFvg.confirmedAt`;
2. `rawEntry = (rawFvg.low + rawFvg.high) / 2`;
3. `eqPrice` must be finite, i.e. `eqSourceContext.currentPivot.price` must exist → else `INVALID_STOP_GEOMETRY`;
4. **HTF bias gate** → else `HTF_UNAVAILABLE` / `HTF_NOT_ALIGNED` / `HTF_NOT_STRONG` / `HTF_NOT_HIGH_CONFIDENCE`;
5. TP target must resolve → else `NO_VALID_DYNAMIC_D_TARGET`;
6. sizing → else `INVALID_SYMBOL_RULES` / `INVALID_QTY` / `ORDER_NOTIONAL_INVALID`;
7. geometry/RR → else `INVALID_STOP_GEOMETRY` / `INVALID_TARGET_GEOMETRY` / `TRADE_SPACE_INSUFFICIENT`.

Only if all seven pass is the plan `ok === true` and an entry order submitted. (Then, separately, `live === true` and `accountReady` are required for a real mutation; otherwise the trade becomes a `SHADOW_ORDER`.)

---

## N2. EQ/FVG semantic gate (the second gate, default ON and fail-closed)

Between the first matching FVG and the entry plan there is a second, model-based gate that is easy to miss:

`config/eqFvgSemanticV1.js` returns, by default, **`enabled: true`, `liveGateEnabled: true`, `failClosed: true`, `requiredConfidence: 'HIGH'`** (the loader throws outright if confidence is not HIGH or if fail-closed is disabled).

Flow in `live/eqFvgAssociationSemanticV1.js`:

- `buildFacts` → decision-store identity → frozen decision or one model call;
- `semantic/eqFvgAssociationSemanticV1.evaluateGate(decision)` produces `PASS`/`BLOCK`;
- `result.executionAllowed = (config.liveGateEnabled !== true) || result.gateResult === 'PASS'`;
- every failure path (unavailable, archive error, notification error, schema error) sets `status='UNAVAILABLE'`, `gateResult='BLOCK'`, `gateReason='EQ_FVG_SEMANTIC_UNAVAILABLE'`.

`scripts/live.js` `processPendingSemanticEvents` calls `execution.onFirstMatchingFvg(enriched)` **only** when `result.executionAllowed` is true. So with the shipped defaults, an entry can only be planned when the frozen EQ-FVG association decision is `PASS` at HIGH confidence — otherwise the signal never reaches the execution service at all.

This gate is **independent of 2L/2R**: its inputs are the EQ event, the raw FVG and the engine state.

---

## O. Entry price

`entENTRY = matching FVG midpoint`, then tick-normalised:

```
rawEntry = (event.rawFvg.low + event.rawFvg.high) / 2          // FVG boundaries, not candles
entry    = legalize(rawEntry, tickSize, direction === 'LONG' ? 'DOWN' : 'UP')
```

Both FVG boundaries are used (the zone is `[lower, upper]`), and the midpoint is the average. Because of the rounding mode the LONG limit lands at or just **below** the raw midpoint and the SHORT limit at or just **above** it. Normalisation happens inside `sizeOrder` (`legalize`), i.e. **after** target selection but **before** the RR check — the RR check uses the normalised prices. `thresholds.trade.entry.mode = 'MIDPOINT'` records the same intent for the legacy planner.

---

## P. Entry decision window

- `entryDecisionTime = event.rawFvg.confirmedAt` (the FVG's k3 close) — **not** the WATCH open, **not** the EQ, **not** a touch.
- There is **no fixed expiry window** for the entry: the LIMIT order rests until it fills or is cancelled.
- The only cancellation rule is structural: a **new confirmed SWING_LOW (for LONG) / SWING_HIGH (for SHORT) with `confirmedAt > plan.decisionTime`** cancels the resting entry (`realOrderExecutionV1.onConfirmedSwings`).
- Expiry-style reasons you may remember (`maxEntryWaitBars = 12`, `ENTRY_MISSED`) belong to the **legacy simulator/trade plan** (`config/thresholds.js` `trade.simulator`, `trade/*`), which the real-order path does not use.

---

## Q. Initial SL

**Yes: the SL is the Current Point wick.**

```
buildEntryPlan: sizeOrder(direction, rawEntry, base.eqPrice, target.price, symbolRules)
base.eqPrice = Number(event.eqSourceContext.currentPivot.price)
currentPivot.price = pivot.price = the pivot candle's low (LOW) / high (HIGH)
stop = legalize(eqPrice, tickSize, 'NEAREST')
```

So for a bullish setup (EQL) the stop is the **original EQL Current Point wick low**; for a bearish setup (EQH) it is the **original EQH Current Point wick high**. It is **not** the historical partner, **not** a taken/swept price, **not** the FVG boundary, and **not** a structural swing low/high from the provenance engine.

---

## R. Initial TP

`selectTarget(direction, rawEntry, context.dynamicDPoints, context.candles, decisionTime, anchorEligibility)`:

- **LONG** → looks for a **HIGH-side** point above the entry; **SHORT** → a **LOW-side** point below the entry.
- candidate must be `state === 'ACTIVE'`, correct `pointSide`, finite price/confirmedAt, `confirmedAt <= decisionTime`, strictly on the profitable side of the entry, passing the optional anchor-eligibility filter, and **not already traded through** between its `confirmedAt` and `decisionTime`.
- **nearest** = smallest `|price − entry|`, ties broken by earlier `confirmedAt`, then by id.
- **ACTIVE** = the Causal Dynamic-D lifecycle state (terminated only by age expiry or a strict cross).
- Causality: candidates are `confirmedAt <= decisionTime` and are additionally rejected if price has since traded through them, so the target is anchored on information available at the decision time.

No fallback target is manufactured — if nothing qualifies, the plan fails with `NO_VALID_DYNAMIC_D_TARGET`.

---

## S. initialRR

`executionRulesV1.geometry`:

```
LONG : risk = entry − stop        reward = target − entry
SHORT: risk = stop − entry        reward = entry − target
rr   = reward / risk
reject when rr + 1e-12 < MIN_INITIAL_RR      → reasonCode 'TRADE_SPACE_INSUFFICIENT'
```

- **`MIN_INITIAL_RR = 1.0`** — a module constant in `execution/executionRulesV1.js:4`, i.e. the real-order path requires **RR ≥ 1.0**.
- `thresholds.trade.rr.minRR = 1.5` exists but is read **only** by the legacy `trade/rrCalculator.js` (backtest planner) — it does **not** gate real orders.
- Non-positive risk → `INVALID_STOP_GEOMETRY`; non-positive reward → `INVALID_TARGET_GEOMETRY`.

---

## T. 4H Bias gate

`executionRulesV1.biasGate(direction, bias, expectedClosedAt)`:

- `bias.status === 'AVAILABLE'` and `bias.semantic` present;
- `bias.closedAt === expected4hClosedAt` (exact equality on the newest fully closed native 4H close);
- `bias.semantic.direction === (LONG ? 'BULLISH' : 'BEARISH')`;
- `bias.semantic.strength === 'STRONG'`;
- `bias.semantic.confidence === 'HIGH'`.

**Position in the pipeline:** it runs **inside** `buildEntryPlan`, after the EQ/price sanity check and **before** target resolution, sizing and RR. There is no separate `ENTRY_CANDIDATE` / `PRE_HTF_PLAN` state object — the code builds one `base` plan object that already contains the EQ/FVG provenance, and returns it as `plan` together with `ok:false` and a reason code.

**Data causality:** the bias is computed only from fully closed native 4H candles (see the 4H bias audit), and the gate demands the bias be for exactly the expected closed candle. If the bias is unavailable/PARTIAL, `biasGate` returns `HTF_UNAVAILABLE` and the entry is simply `NO_TRADE` — the 5m pipeline is **not** paused by a bias failure (only by an HTF **data** failure, per the earlier audit).

---

## U. Exchange filters / position sizing

`sizeOrder` (after the bias gate and target selection):

1. `validateRules`: `source === 'futures'`, positive `tickSize`/`stepSize`/`minQty`, `maxQty >= minQty`, `minNotional >= 0` — else `INVALID_SYMBOL_RULES`.
2. price legalisation to `tickSize` (entry direction-aware, stop/target nearest).
3. `minPrice` / `maxPrice` bounds check.
4. `targetNotional = Math.max(20, rules.minNotional)`.
5. `qty = legalize(targetNotional / entry, stepSize, 'UP')`, raised to `minQty` if needed; must be `<= maxQty` → else `INVALID_QTY`.
6. `qty * entry >= targetNotional` → else `ORDER_NOTIONAL_INVALID`.

Then, **after** the plan, in `realOrderExecutionV1`: admission (already checked), `EQ_ALREADY_CONSUMED`, `SYMBOL_SLOT_BUSY`, `live` flag, `accountReady` (position mode ONE_WAY + CROSSED + leverage 10), and reconciliation safeguards (`RECONCILIATION_CONFLICT`, `ORPHAN_ORDER_FOUND`).

---

## V. 20 USDT notional

`MIN_TARGET_NOTIONAL = 20` in `execution/executionRulesV1.js:5`, used as:

```
targetNotional = Math.max(20, rules.minNotional)
qty            = ceil(targetNotional / entry / stepSize) * stepSize
```

So the notional rule is **`max(20 USDT, exchange minNotional)`**, rounded **up** to a legal quantity. It is a **notional target, not a risk cap**: the actual risk is `|entry − stop| × qty`, which is unbounded by this rule and is only indirectly shaped by the RR and stop-geometry checks.

---

## W. Order types and protection sequencing

- **Entry:** `LIMIT`, price = tick-normalised FVG midpoint, quantity = requested qty (`binanceExecutionClientV1.submitEntry`).
- **SL:** `STOP_MARKET`, **TP:** `TAKE_PROFIT_MARKET`, both with `workingType: 'MARK_PRICE'` and `closePosition: 'true'` (algo/conditional endpoints).
- **Sequence:** the entry is submitted first; **SL/TP are only submitted after a fill** — `reconcile()` calls `submitProtection(trade)` only when `qty > 0`, with **SL first and TP second** (SL failure escalates to `UNPROTECTED_POSITION` + emergency market close; TP failure only emits `PROTECTION_FAILED`).
- Partial fills: the position qty is read from the exchange each reconcile; protection is (re)ensured whenever `qty > 0` and an order is missing.
- Reconciliation is driven by the **user data stream** (`ORDER_TRADE_UPDATE` / `ACCOUNT_UPDATE`) plus a **5-second REST poll**.
- `LIVE_TRADING_ENABLED` must be the literal string `'true'`; otherwise the trade is a `SHADOW_ORDER` and no exchange call is made.

---

## X. PRODUCTION_ENTRY_STATE_MACHINE (as the code actually is)

```
5m candle CLOSED
  → incrementalLiquidity: pivot at index-2 CONFIRMED (confirmedAt = this candle close)
  → swing liquidity object (SWING_HIGH / SWING_LOW) registered
  → productionEqualLiquidityV1.evaluatePivot
        ├─ anchor age expiry / strict cross  → anchor INACTIVE (no pair)
        └─ |pivot.price − anchor.price| <= 5m ATR14 × 0.7  → EQH / EQL event
  → WATCH created (openedAt = EQ.confirmedAt, expectedDirection from EQ type)
  → on every completed bar: raw 3-candle FVG (k1=index-2, k3=index)
        └─ consumed by open WATCHes with confirmedAt >= openedAt
  → FIRST matching-direction FVG (ordinal 1)
  → [semantic gate: executionAllowed]        (eqFvgAssociationSemanticV1)
  → admission + one-shot EQ consumption + slot check
  → ENTRY PLAN
        ├─ eqPrice = Current Point wick        (else INVALID_STOP_GEOMETRY)
        ├─ 4H bias gate                        (else HTF_*)
        ├─ nearest ACTIVE opposite Dynamic-D   (else NO_VALID_DYNAMIC_D_TARGET)
        ├─ tick/qty/notional sizing            (else INVALID_*)
        └─ RR >= 1.0                           (else TRADE_SPACE_INSUFFICIENT)
  → LIMIT @ FVG midpoint
  → FILL (or cancel on a new opposite confirmed swing)
  → SL STOP_MARKET @ Current Point wick, then TP TAKE_PROFIT_MARKET @ Dynamic-D target
```

There is no liquidity-taken step, no MSS step, no displacement gate and no touch step in this chain. The steps that exist between EQ and Entry are exactly: **WATCH creation** and **raw-FVG counting (first matching FVG)**.

---

## Y. Dependency on 2L/2R

See `production-entry-dependency-map.json`. Summary:

**DIRECT (7):** Current Point; EQ identity/timing; EQ price level; Initial SL; entry-plan provenance fields (`eqOccurredAt`, `eqConfirmedAt`, `eqCurrentPoint`); the confirmed-swing entry-cancel rule; the swing registry used by structural provenance.

**INDIRECT (3):** WATCH (exists only because an EQ exists, and inherits `openedAt`); entry-trigger timing (the FVG counting floor is `openedAt`); trade/watch/semantic identity strings (they embed the EQ id).

**INDEPENDENT (9):** Entry price; FVG definition and counting; Initial TP; RR gate; 4H bias gate; sizing and exchange filters; order types and protection sequencing; the structural provenance state machine; the historical-anchor significance filter (partner-side only).

---

## Z. Potential future replacement boundary

**`POTENTIAL_REPLACEMENT_BOUNDARY`** — if the Current Point provider were ever swapped (e.g. for a Two-Bar reversal), the minimal theoretical change point is exactly:

```
OLD: 2L/2R pivot      → Current Point   (productionEqualLiquidityV1 metadata.currentPivot)
NEW: <other provider> → Current Point   (same schema)
```

- **SAFE_TO_REUSE** (consume the Current Point passively, no pivot assumptions): EQ matching logic itself (`evaluatePivot` compares only `price`/`occurredAt`/`confirmedAt`/`metadata.index`), WATCH engine, raw-FVG counter, entry price, TP selection, RR gate, 4H bias gate, sizing, order types, protection sequencing.
- **NEEDS_ADAPTER** (uses Current Point fields that a non-pivot provider must still supply): EQ `buildEvent` (`price`, `occurredAt`, `confirmedAt`, `sourceCloseTime`, `metadata.index`), `eqSourceContextV1.fromLiquidity` (causality checks read `currentPivot.occurredAt/confirmedAt`), entry-plan provenance, `pivotKey`/dedupe identity, and the swing objects fed to `state.registry` (structural provenance + the entry-cancel rule).
- **COUPLED_TO_2L2R** (currently assumes a 2/2 pivot): the `occurredAt/confirmedAt` 2-bar delay semantics baked into WATCH `openedAt` and the earliest entry `decisionTime`; `realOrderExecutionV1.onConfirmedSwings` (it waits for a 2/2-confirmed SWING_LOW/HIGH); the SL's "Current Point wick" semantics (a pivot's `price` is inherently a wick).
- **UNKNOWN**: whether a replacement provider can produce a *structurally meaningful* cancellation swing for the resting-entry rule without the pivot detector; and how the `metadata.index` field would be defined for a multi-bar provider.

This is a coupling statement only — no replacement is recommended or implemented.

---

## AA. Hard-coded pivot assumptions found

| location | assumption |
|---|---|
| `liquidity/productionEqualLiquidityV1.js:76-89` | `pointSideOf` maps `SWING_HIGH`/`SWING_LOW` to HIGH/LOW; `pivotKey` is built from pivot fields |
| `liquidity/productionEqualLiquidityV1.js:141-147` | `pivot.metadata.index` must be a number (the pivot's bar index) |
| `liquidity/productionEqualLiquidityV1.js:209-217` | `currentPivot.source` is the literal `'ORDINARY_CAUSAL_2X2'` |
| `replay/replayState.js:110-128` | the pivot is confirmed exactly at `index - RIGHT`, i.e. a hard-coded 2-bar delay |
| `liquidity/swingLiquidity.js:43-53` | `confirmedAt = candles[pivot.index + 2].closeTime` |
| `execution/executionRulesV1.js:183` | the stop is `base.eqPrice` = `currentPivot.price` (a single wick price) |
| `execution/realOrderExecutionV1.js:344-371` | entry cancellation requires a newly confirmed `SWING_LOW`/`SWING_HIGH` object |
| `scripts/live.js:1091-1092` | startup banner asserts `STRUCTURAL_SWING_MODE` = "confirmed 2L/2R pivots" |
| `scripts/live.js:634, 663` | `execution.onConfirmedSwings(step.newConfirmedSwings)` — the only swing feed into execution |

No `if (source !== LOCAL_SWING) return` style guard exists; the coupling is structural (fields and timing) rather than a source-name check.

---

## AB. Runtime trace result

`scripts/local/productionEntryLogicAuditV1.local.js` (read-only, execution service never constructed) replayed **899 real closed BTCUSDT 5m candles** + 149 4H candles through the production engines:

| item | value |
|---|---|
| EQ events | 14 |
| WATCHes | 14 |
| first/second matching FVG notifications | 23 |
| distinct Dynamic-D points available to the TP selector | 16 |
| bar-stepping errors | 0 |
| entry plans evaluated | 12 |
| plan outcomes | 7 × `HTF_NOT_STRONG`, 5 × `HTF_NOT_ALIGNED` |

The trace confirmed the static reading end to end: EQ events carry `currentPivot.source = 'ORDINARY_CAUSAL_2X2'` with both timestamps; WATCHes open immediately on the EQ; the FVG counter only consumes FVGs at/after the watch open; and the entry plan fails at the **HTF gate before** any target/sizing field is computed (`targetPrice`, `targetNotional`, `requestedQty` stay `null` on rejection), with `eqPrice` populated from the Current Point.

The trace reused a single 4H bias snapshot for the whole replay (bias was `BEARISH/MODERATE/MEDIUM`), which is a trace artefact — it is used to validate plumbing, not to reproduce historical gating. Two operational facts surfaced: (1) the production bias client reads **only** `process.env.DEEPSEEK_API_KEY`, and `.env` does **not** define it, so on this machine the 4H bias is `PARTIAL` and every entry would be blocked with `HTF_UNAVAILABLE`; (2) with a valid key the same code produced an `AVAILABLE` bias and the gate then blocked on strength/alignment instead.

---

## AC. Tests / no-mutation proof

- `scripts/local/productionEntryLogicAuditV1.local.js` **never requires** `execution/realOrderExecutionV1.js`, `execution/binanceExecutionClientV1.js` or `execution/executionRepositoryV1.js` (verified by static scan), so no order, cancel, leverage or position call can be emitted by it.
- It aborts with `REFUSING_TO_RUN_WITH_LIVE_TRADING_ENABLED` if `LIVE_TRADING_ENABLED === 'true'`, and forces it to `'false'` otherwise.
- The only external calls the trace makes are market-data reads (`/fapi/v1/klines`, `/fapi/v1/exchangeInfo`) plus, in the second run, the production 4H bias model call.
- `git diff --name-only` is empty; the audit changed no tracked file.

---

## Answers to the ten required questions

**Q1 — Is the production Current Point just the 2L/2R pivot?**
Yes. The Current Point is the ordinary causal 2/2 pivot (`source: 'ORDINARY_CAUSAL_2X2'`) wrapped with `price`, `occurredAt`, `confirmedAt` and `sourceIndex`; no other provider exists in the EQ path.

**Q2 — How many right-side bars before a 2/2 is confirmed?**
Exactly **2 bars** (10 minutes). `confirmedAt = candles[index + 2].closeTime`, and `incrementalLiquidity` only confirms the pivot at `index - 2`.

**Q3 — When can an EQ exist at the earliest?**
At the **close of the confirming bar**, i.e. 2 bars after the pivot candle's open. In the 10:00-pivot example: `occurredAt = 10:00`, `confirmedAt = createdAt = availableAt = 10:10`. The EQ can never exist at 10:00.

**Q4 — Is the SL directly the Current Point wick?**
Yes. `rawStop = base.eqPrice = eqSourceContext.currentPivot.price`, and a pivot's `price` **is** its candle wick (`low` for LOW/EQL, `high` for HIGH/EQH). Not the historical partner, not a taken price, not the FVG, not a structural swing.

**Q5 — Is the Entry price fully independent of 2L/2R?**
Yes. `rawEntry = (rawFvg.low + rawFvg.high)/2` — only the raw 3-candle FVG zone, then tick-normalised. 2L/2R influences *whether and when* an entry can exist, never *at what price*.

**Q6 — Is the TP fully independent of 2L/2R?**
Yes. The target is the nearest un-violated ACTIVE opposite-side **Causal Dynamic-D** point; it never reads a pivot.

**Q7 — If only the Current Point provider were replaced, could the downstream EQ engine be reused in theory?**
In principle yes — `evaluatePivot` consumes only `price`/`occurredAt`/`confirmedAt`/`metadata.index` — but the replacement must also (a) keep the same two-timestamp causality contract, (b) produce a registry-compatible swing object for the structural provenance and the entry-cancel rule, and (c) accept that WATCH timing and the earliest entry decision time inherit its confirmation delay.

**Q8 — Which downstream modules hard-code a LOCAL_SWING/pivot dependency?**
`productionEqualLiquidityV1` (`pointSideOf`, `pivotKey`, `metadata.index`, the literal `ORDINARY_CAUSAL_2X2`), `replayState.incrementalLiquidity` (the 2-bar confirmation index), `swingLiquidity` (`index + 2`), `executionRulesV1.buildEntryPlan` (stop = `eqPrice`), `realOrderExecutionV1.onConfirmedSwings` (SWING_LOW/HIGH cancellation) and the `scripts/live.js` wiring that feeds those swings.

**Q9 — Where does the 2L/2R delay propagate?**
Into `EQ.confirmedAt/createdAt` (+2 bars) → `WATCH.openedAt` → the FVG counting floor (`rawFvg.confirmedAt >= openedAt`) → the earliest possible `decisionTime` → the earliest possible LIMIT order; and, separately, the same 2-bar delay defines when a cancellation swing can exist.

**Q10 — Minimal safe change surface for a future Two-Bar experiment?**
`liquidity/productionEqualLiquidityV1.js` `eligibleHistoricalPoints`/`evaluatePivot`/`buildEvent` (accept a different Current Point producer) plus `replay/replayState.js` `incrementalLiquidity` and `structure/swingLiquidity.js` (swing/registry contract), and the `execution/executionRulesV1.js` stop-source line if the new provider's "wick" differs from its `price`. Everything from WATCH to order types is untouched — but the replacement must be a **read-only experiment**, since the SL semantics and the cancel rule are semantically tied to "a confirmed local extreme".

---

```
PRODUCTION_ENTRY_LOGIC_AUDIT_V1=true

PRODUCTION_MODIFIED=false

TWO_BAR_INTEGRATED=false
TWO_BAR_LLM_USED=false

CURRENT_POINT_REPLACED=false
ENTRY_RULES_CHANGED=false
EQ_RULES_CHANGED=false
SL_RULES_CHANGED=false
TP_RULES_CHANGED=false

ORDER_MUTATION=false
OUTCOME_USED=false
```
