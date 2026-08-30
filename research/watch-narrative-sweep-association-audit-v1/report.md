# P4.1 WATCH Narrative / Sweep Association Audit V1

## Executive finding

All seven requested FIRST_TOUCH sequences were reproduced with Binance USD-M Futures 5m data and the production live engine.

- ZEC 08:55 / 09:40 / 10:25 used the **same EQH cluster and the same exact BSL sweep event**, but three different displacement legs, WATCHes, and native FVGs.
- BTC 10:00 / 11:55 LONG used the **same EQL cluster and the same exact SSL sweep event**.
- BTC 11:35 / 13:05 SHORT used the **same EQH cluster and the same exact BSL sweep event**.
- The intervening opposite-side WATCH has no code path that consumes, resets, supersedes, expires, or invalidates the prior side's sweep association.
- The detector/event facts are internally consistent. The product gap is that independent WATCH/FVG events have no narrative identity/ownership, while the notification presents each FIRST_TOUCH as a fresh opportunity.

No production runtime file or algorithm was changed.

## Evidence and replay contract

`BASELINE_WORKTREE_STATUS = CLEAN` (`git status --short` returned no rows before audit files were created).

The audit harness is `scripts/auditWatchNarrativeSweepAssociationV1.js`. It calls `live/liveEngine.js::createLiveEngine()` and `stats/displacementWatch.js::createWatchStore()` without modifying or monkey-patching production code. It replayed 9,289 closed 5m candles per symbol, from 2026-07-29 00:00 UTC through 2026-08-30 05:59:59.999 UTC. Binance USD-M Futures was reached through the local 7890 proxy; both forensic outputs record `dataSource = futures` and `productionEquivalent = true`.

- ZEC fixture SHA-256: `51836e0ef48c8dadefcc05ff5d130b9a81929a1699ccb36b38c16a429e54b828`
- BTC fixture SHA-256: `7accf46e3dac86f21e13b01d1dda3c11f23e697ab22ebb911a7f46b15bf673f4`
- All human-readable times below are Asia/Shanghai (UTC+8). Production comparisons use epoch milliseconds.
- The replay observes the production closed-candle FIRST_TOUCH fallback. The real-time `aggTrade` route can provide a more precise within-candle timestamp, but does not change any liquidity, sweep, leg, WATCH, FVG, or notification-key identity.

## PRODUCTION_CALL_GRAPH

```text
scripts/live.js::processCandles()                         [616-668]
↓ live/liveEngine.js::onBar()                            [186-284]
↓ replay/replayState.js::incrementalLiquidity()          [123-234]
↓ liquidity/liquidityLifecycle.js::evaluateLiquidity()   [52-125]
↓ replay/replayState.js::incrementalEvents()             [241-298]
↓ events/sweepEventAdapter.js::buildSweepEvent()         [37-76]
↓ structure/structuralProvenance5m.js::step()             [390+]
↓ events/displacementDetector.js::detectDisplacement()   [29-143]
↓ stats/displacementLeg.js::createWindowedLegBuilder()   [268-337]
↓ live/liveEngine.js::emitDisplacementWatch()            [135-179]
↓ stats/displacementWatch.js::buildWatch()               [110-185]
↓ stats/liquidityProvenance.js::associateSweeps()        [171-214]
↓ stats/displacementWatch.js::nativeFvgForDisplacement() [48-74]
↓ scripts/live.js::applyWatchUpdates()                   [579-588]
↓ stats/displacementWatch.js::createWatchStore().onCandle() [246-267]
↓ scripts/live.js::handleWatchTouches()                  [554-560]
↓ scripts/live.js::deliverWatchTouch()                   [530-551]
↓ notify/watchNotificationPresentationV1.js             [296-365]
↓ notify/dingTalk.js::sendText()                         [28+]
```

The parallel real-time touch route is `live/futuresPriceStream.js` → `scripts/live.js::onRealtimePrice()` [590-595] → `createWatchStore().onPrice()` [219-244] → the same `handleWatchTouches()` / `deliverWatchTouch()` delivery chain.

## Association owner and exact selection logic

```text
ASSOCIATION_OWNER_FILE = stats/liquidityProvenance.js
ASSOCIATION_OWNER_FUNCTION = associateSweeps
```

`stats/displacementWatch.js::buildWatch()` [110-124] invokes this owner with `direction = leg.direction`, `availableAt = evaluationTime`, all registered `LIQUIDITY_SWEEP` events, `maxLookbackBars = null`, and structural primitives excluded. Null means use `thresholds.events.sweepProvenance.maxLookbackBars`, currently 48 (`config/thresholds.js` [267-273]).

The deterministic selection in `associateSweeps()` [175-213] is:

1. Direction side: BULLISH wants SSL; BEARISH wants BSL.
2. Require `confirmedAt <= availableAt`; a missing `confirmedAt` fails closed.
3. Exclude `SWING_HIGH` / `SWING_LOW` for Narrative Liquidity V1 WATCH candidates.
4. Require numeric `candleIndex`, `candleIndex <= leg.endIndex`, and `candleIndex >= leg.startIndex - 48`.
5. Preserve `allCandidates` ordered by ascending `confirmedAt`.
6. Choose primary (`immediateSweep`) by minimum `abs(leg.startIndex - sweep.candleIndex)`; ties use the greater `confirmedAt`. No liquidity strength, type priority, price distance, or BEFORE/INSIDE preference participates (`pickImmediate()` [136-152]).

```text
PRIMARY_SWEEP_RANKING = min(abs(leg.startIndex - sweep.candleIndex)), then max(confirmedAt); stable input order if both tie
CONFIRMED_AT_LEG_END_GUARD = false (no direct timestamp comparison)
CONFIRMED_AT_EVALUATION_GUARD = true
OCCURRED_AT_GUARD = none
MAX_SWEEP_TO_LEG_DISTANCE = 48 historical 5m bars before leg.startIndex; inside-leg candidates allowed through leg.endIndex
```

The index upper bound normally implies a time-local event is no later than the leg end, but it is not an explicit `sweep.confirmedAt <= leg.lastConfirmedAt` guard.

## BEFORE_LEG / INSIDE_LEG

`classifySweepLegRelation()` is in `stats/liquidityProvenance.js` [57-74]. It uses timestamps first and indexes only as fallback.

```text
BEFORE_LEG_DEFINITION = sweep.confirmedAt < leg.firstConfirmedAt; fallback sweep.candleIndex < leg.startIndex
INSIDE_LEG_DEFINITION = leg.firstConfirmedAt <= sweep.confirmedAt <= leg.lastConfirmedAt; fallback leg.startIndex <= sweep.candleIndex <= leg.endIndex
ASSOCIATION_WINDOW = [leg.startIndex - 48, leg.endIndex], inclusive
BARS_FROM_LEG_START = leg.startIndex - sweep.candleIndex; positive=before, 0=leg K1, negative=later inside leg
```

## Identity models

### Sweep

`events/sweepEventAdapter.js::buildSweepEvent()` [37-76] constructs:

```text
SWEEP_IDENTITY_FIELDS = [id, symbol, timeframe, liquidityId, occurredAt, confirmedAt, candleIndex, side, direction, price]
SWEEP_HAS_STABLE_ID = true
SWEEP_ID = symbol + ':' + timeframe + ':SWEEP:' + liquidity.id
```

The liquidity lifecycle is monotonic (`ACTIVE → TOUCHED → SWEPT → BROKEN`) and only ACTIVE/TOUCHED objects are re-evaluated (`liquidity/liquidityLifecycle.js::evaluateLiquidity()` [52-125], `replay/replayState.js::incrementalEvents()` [245-269]). Therefore one liquidity object produces at most one registered sweep event. `events/eventRegistry.js::add()` [24-34] also deduplicates by event ID.

### EQ V3 liquidity

`liquidity/persistentEqualLiquidityV3.js::clusterId()` [19-22] derives a stable cluster ID from symbol, timeframe, side, and the first two qualified swing IDs. `buildCluster()` [86-123] stores it as the liquidity object ID. `sweepEventAdapter` copies that ID into `event.liquidityId` and freezes member provenance as of the sweep [19-27, 43-72]. `liquidityProvenance.buildCandidate()` copies it to `sourceId` [107-128], and `buildWatch()` preserves the candidate under `liquidityTaken` [158-162].

```text
EQ_V3_CLUSTER_ID_AVAILABLE_AT_SOURCE = true
EQ_V3_CLUSTER_ID_PRESERVED_IN_SWEEP = true
EQ_V3_CLUSTER_ID_PRESERVED_IN_WATCH = true
```

### WATCH

`stats/displacementWatch.js::buildWatch()` [140-170]:

```text
WATCH_ID_FIELDS = [symbol, direction, first displacement event ID]
WATCH_ID_INCLUDES_LIQUIDITY_ID = false
WATCH_ID_INCLUDES_SWEEP_ID = false
WATCH_ID_INCLUDES_DISPLACEMENT_LEG_ID = true (the first displacement event defines LEG identity)
WATCH_ID_INCLUDES_DIRECTION = true
WATCH_ID_INCLUDES_TIME = true indirectly (the displacement event ID contains candle.openTime)
```

A new displacement leg therefore creates a new WATCH even when the selected liquidity and exact sweep are unchanged. There is no narrative ID in the WATCH. `watchFingerprint()` [187-195] tracks changing formation contents for one WATCH ID; it is not cross-WATCH narrative deduplication.

### Notification dedup

`buildWatch()` sets `notificationKey = watch.id + ':' + primaryFvg.id` [163-170]. `createWatchStore()` checks that key before touch [219-267] and writes it to `delivered` only in `markNotified()` [270-275]. `scripts/live.js` persists the map to `fvg-watch-delivered.json` [321-338, 349-352] after DingTalk returns `errcode=0` [530-547].

```text
NOTIFICATION_DEDUP_KEY_FIELDS = [WATCH ID, primary native FVG ID]
DEDUP_SCOPE = WATCH_X_FVG
```

ZEC's three notifications have three WATCH IDs and three FVG IDs, so all three keys are distinct and all may be delivered. Liquidity/sweep identity is intentionally absent from this dedup key.

## Sweep reuse, ownership, and opposite side

No production WATCH association path reads or writes `consumedRefs`, `usedSweepIds`, `claimedByLeg`, `claimedByWatch`, `activeNarrative`, or equivalent ownership state. The `consumedRefs` found in MSS code belongs to MSS reference consumption, not liquidity sweep-to-WATCH association.

```text
SWEEP_CONSUMPTION_EXISTS = false
SWEEP_OWNERSHIP_EXISTS = false
NARRATIVE_OWNERSHIP_EXISTS = false
SWEEP_CAN_ASSOCIATE_MULTIPLE_LEGS = true
```

The limits are only: same side/direction, confirmed by evaluation time, eligible liquidity type, and inside the 48-bar/index window. There is no quantity limit.

The watch store iterates each WATCH independently and terminalizes only on that WATCH's own FVG touch/penetration (`stats/displacementWatch.js` [206-275]). It has no opposite-side transition.

```text
OPPOSITE_SIDE_EFFECT_ON_PRIOR_SWEEP = NONE
```

## Forensic identities

The following exact-ID aliases keep the comparison tables readable:

- `L-Z` = `EQV3:ZECUSDT:5m:EQH:[QS:ZECUSDT:5m:HIGH:[ZECUSDT:5m:SWING_HIGH:1788021900000]]:[QS:ZECUSDT:5m:HIGH:[ZECUSDT:5m:SWING_HIGH:1788028800000]]`
- `S-Z` = `ZECUSDT:5m:SWEEP:` + `L-Z`
- `L-BTC-L` = `EQV3:BTCUSDT:5m:EQL:[QS:BTCUSDT:5m:LOW:[BTCUSDT:5m:SWING_LOW:1788027300000]]:[QS:BTCUSDT:5m:LOW:[BTCUSDT:5m:SWING_LOW:1788037200000]]`
- `S-BTC-L` = `BTCUSDT:5m:SWEEP:` + `L-BTC-L`
- `L-BTC-S` = `EQV3:BTCUSDT:5m:EQH:[QS:BTCUSDT:5m:HIGH:[BTCUSDT:5m:SWING_HIGH:1788030900000]]:[QS:BTCUSDT:5m:HIGH:[BTCUSDT:5m:SWING_HIGH:1788033600000]]`
- `S-BTC-S` = `BTCUSDT:5m:SWEEP:` + `L-BTC-S`

| Symbol | Time | Dir | Liquidity ID | Sweep ID | Sweep confirmedAt | Leg ID | Watch ID | FVG ID | Opposite Event Since Prior? |
|---|---:|---|---|---|---:|---|---|---|---|
| ZECUSDT | 08:55 | SHORT | `L-Z` | `S-Z` | 07:05 | `LEG:...:1788050400000` | `WATCH:...:1788050400000` | `NATIVE_FVG:...:1788050400000` | No |
| ZECUSDT | 09:40 | SHORT | `L-Z` | `S-Z` | 07:05 | `LEG:...:1788053100000` | `WATCH:...:1788053100000` | `NATIVE_FVG:...:1788053100000` | No |
| ZECUSDT | 10:25 | SHORT | `L-Z` | `S-Z` | 07:05 | `LEG:...:1788055800000` | `WATCH:...:1788055800000` | `NATIVE_FVG:...:1788055800000` | No |
| BTCUSDT | 10:00 | LONG | `L-BTC-L` | `S-BTC-L` | 09:20 | `LEG:...:1788053700000` | `WATCH:...:1788053700000` | `NATIVE_FVG:...:1788053700000` | No |
| BTCUSDT | 11:35 | SHORT | `L-BTC-S` | `S-BTC-S` | 08:20 | `LEG:...:1788051300000` | `WATCH:...:1788051300000` | `NATIVE_FVG:...:1788051300000` | Yes (10:00 LONG) |
| BTCUSDT | 11:55 | LONG | `L-BTC-L` | `S-BTC-L` | 09:20 | `LEG:...:1788060300000` | `WATCH:...:1788060300000` | `NATIVE_FVG:...:1788060300000` | Yes (11:35 SHORT) |
| BTCUSDT | 13:05 | SHORT | `L-BTC-S` | `S-BTC-S` | 08:20 | `LEG:...:1788062700000` | `WATCH:...:1788062700000` | `NATIVE_FVG:...:1788063600000` | Yes (11:55 LONG) |

## ZEC forensic replay

The EQH reference is 842.996666..., with three frozen V3 members: 00:45 @ 843.60, 02:40 @ 842.69, and 05:15 @ 842.70. The exact sweep occurred on the 07:00 candle and confirmed at 07:05.

| WATCH_TIME | Leg start/end | Strength / bars | MSS (role, protected) | FVG formed / FIRST_TOUCH | Timing / bars from start |
|---:|---|---|---|---|---|
| 08:55 | 08:45 / 08:45 | NORMAL / 1 | yes (INTERNAL, false) | 08:50 / 08:55 | BEFORE_LEG / 20 |
| 09:40 | 09:30 / 09:30 | NORMAL / 1 | yes (INTERNAL, false) | 09:35 / 09:40 | BEFORE_LEG / 29 |
| 10:25 | 10:15 / 10:15 | NORMAL / 1 | yes (INTERNAL, false) | 10:20 / 10:25 | BEFORE_LEG / 38 |

```text
ZEC_SAME_LIQUIDITY_ID = true
ZEC_SAME_EQ_CLUSTER_ID = true
ZEC_SAME_EXACT_SWEEP_ID = true
ZEC_SAME_SWEEP_CONFIRMED_AT = true
ZEC_DIFFERENT_LEG_IDS = true
ZEC_DIFFERENT_WATCH_IDS = true
ZEC_DIFFERENT_FVG_IDS = true
```

## BTC forensic replay

The EQL reference is 78002.4 with members 02:15 @ 77988.8 and 05:00 @ 78016.0; its exact SSL sweep occurred on the 09:15 candle and confirmed at 09:20. The EQH reference is 78295.1 with members 03:15 @ 78314.9 and 04:00 @ 78275.3; its exact BSL sweep occurred on the 08:15 candle and confirmed at 08:20.

| WATCH_TIME | Dir | Leg start/end | Strength / bars | MSS (role, protected) | FVG formed / FIRST_TOUCH | Timing / bars from start |
|---:|---|---|---|---|---|---|
| 10:00 | LONG | 09:40 / 09:50 | STRONG / 2 | no | 09:45 / 10:00 | BEFORE_LEG / 4 |
| 11:35 | SHORT | 09:00 / 09:10 | STRONG / 2 | yes (INTERNAL, false) | 09:05 / 11:35 | BEFORE_LEG / 8 |
| 11:55 | LONG | 11:30 / 11:35 | EXPLOSIVE / 2 | yes (LOCAL, false) | 11:35 / 11:55 | BEFORE_LEG / 26 |
| 13:05 | SHORT | 12:10 / 12:40 | EXPLOSIVE / 3 | yes (INTERNAL, false) | 12:30 / 13:05 | BEFORE_LEG / 46 |

```text
BTC_LONG_1000_VS_1155:
SAME_LIQUIDITY_ID = true
SAME_EQ_CLUSTER_ID = true
SAME_EXACT_SWEEP_ID = true
SAME_SWEEP_CONFIRMED_AT = true
BTC_1155_LONG_ASSOCIATION = REUSED_EXACT_SWEEP

BTC_SHORT_1135_VS_1305:
SAME_LIQUIDITY_ID = true
SAME_EQ_CLUSTER_ID = true
SAME_EXACT_SWEEP_ID = true
SAME_SWEEP_CONFIRMED_AT = true
BTC_1305_SHORT_ASSOCIATION = REUSED_EXACT_SWEEP
```

## Root-cause classification

| Code | Result | Evidence |
|---|---|---|
| RC1 SAME_EXACT_SWEEP_REUSED_ACROSS_MULTIPLE_LEGS | TRUE | Exact sweep IDs and confirmedAt values match within all three comparison groups; `associateSweeps()` has no consumption/claim state. |
| RC2 SAME_LIQUIDITY_CLUSTER_HAS_MULTIPLE_DISTINCT_SWEEPS | FALSE | Target sequences use one event per cluster; monotonic lifecycle permits one SWEPT transition/event per liquidity ID. |
| RC3 WATCH_HAS_NO_NARRATIVE_IDENTITY | TRUE | WATCH ID is symbol + direction + first displacement ID; no liquidity/sweep/narrative identity is included. |
| RC4 OPPOSITE_SIDE_WATCH_DOES_NOT_AFFECT_PRIOR_NARRATIVE | TRUE | Watch store and association code contain no cross-side transition; BTC A→B→A→B is reproduced. |
| RC5 NOTIFICATION_PRESENTS_CONTINUATION_AS_NEW_OPPORTUNITY | TRUE | Formatter title is `做多/做空机会观察` [145-148, 306-311] for every WATCH and has no continuation/reactivation concept. |
| RC6 IDENTITY_PROVENANCE_LOST_BEFORE_WATCH | FALSE | EQ cluster ID survives as sweep `liquidityId`, candidate `sourceId`, `eqObjectId`, and WATCH `liquidityTaken`. |
| RC7 NOTIFICATION_DEDUP_IS_CORRECTLY_EVENT_SCOPED | TRUE | Key is WATCH × primary FVG; all seven new WATCH/FVG FIRST_TOUCH events are distinct and valid for this scope. |
| RC8 OTHER | FALSE | No additional mechanism is needed to explain the observations. |

## Event correctness vs product semantics

For these seven observations:

```text
EVENT_CORRECT = true
```

Each notification belongs to a distinct displacement leg, WATCH, native FVG, and FIRST_TOUCH. No detector duplication is required to explain the output.

```text
NEW_INDEPENDENT_NARRATIVE = false under liquidity/sweep ownership semantics
```

That second statement is a product-semantic classification: all same-side repetitions reuse an exact already-swept liquidity event. Production currently has no narrative object with which to encode or enforce that distinction.

Ranked diagnosis:

1. Lifecycle Gap — no narrative ownership and no opposite-side narrative transition.
2. Presentation Gap — every new WATCH/FVG FIRST_TOUCH is presented as a new opportunity, with no continuation identity.
3. Normal Event Semantics — distinct legs/FVGs/FIRST_TOUCHes correctly produce distinct event-scoped notifications.
4. Association Bug — not demonstrated; the current 48-bar recent-direction association heuristic behaves exactly as coded, though it is not a causal narrative selector.
5. Detector Bug — not demonstrated.

## Required eight answers

1. **Q1 — ZEC same exact sweep?** Yes. All three use `S-Z`, confirmed 07:05.
2. **Q2 — Why can it create three WATCHes?** WATCH identity is displacement-leg based and contains neither liquidity ID nor sweep ID; association has no sweep consumption/ownership. Three legs therefore create three WATCH/FVG identities and three notification keys.
3. **Q3 — BTC 10:00 vs 11:55 LONG?** Same exact SSL sweep `S-BTC-L`, confirmed 09:20.
4. **Q4 — BTC 11:35 vs 13:05 SHORT?** Same exact BSL sweep `S-BTC-S`, confirmed 08:20.
5. **Q5 — Does the opposite-side WATCH terminate the old narrative?** No. Effect is `NONE`.
6. **Q6 — Is there Narrative Identity / Ownership?** No. Production has event, liquidity, sweep, leg, WATCH, FVG, and delivery identities, but no cross-WATCH narrative identity or owner.
7. **Q7 — Problem category?** Lifecycle Gap first, Presentation Gap second, Normal Event Semantics third. No evidence of Detector Bug; no evidence that the current documented heuristic malfunctioned as an Association Bug.
8. **Q8 — Enough evidence to enter P4.1 implementation?** **YES.** Exact production-source replay and static code converge on the same cause. This is evidence to begin an explicitly reviewed product-semantics implementation, not evidence for any particular unreviewed expiry, consumption, reset, or dedup rule.

## Possible design directions — NOT IMPLEMENTED

1. Introduce an explicit narrative identity/ownership projection above immutable event identities.
2. Classify new WATCHes under an existing narrative as continuation/reactivation/shift in a separate product-semantics layer.
3. Make notification presentation consume that classification while retaining event-scoped delivery identity.

No parameters or production behavior for these directions were designed or changed in this audit.

## Tests and final acceptance

Dedicated audit: `node test/auditWatchNarrativeSweepAssociationV1.test.js` → **7/7 PASS**.

Full regression: `npm test` → **ALL TESTS PASSED**.

```text
PHASE = WATCH_NARRATIVE_SWEEP_ASSOCIATION_AUDIT_V1
MODE = READ_ONLY_PRODUCTION_AUDIT
PRODUCTION_RUNTIME_CHANGED = false
WATCH_ALGORITHM_CHANGED = false
SWEEP_ALGORITHM_CHANGED = false
LIQUIDITY_LIFECYCLE_CHANGED = false
DISPLACEMENT_CHANGED = false
MSS_CHANGED = false
FVG_CHANGED = false
EQ_V3_CHANGED = false
STANDARD_CAUSAL_SWING_V1_CHANGED = false
BIAS_CHANGED = false
NOTIFICATION_CHANGED = false
WATCH_ELIGIBILITY_CHANGED = false
THRESHOLDS_CHANGED = false
PRODUCTION_CALL_GRAPH_TRACED = true
ASSOCIATION_OWNER_IDENTIFIED = true
SWEEP_IDENTITY_MODEL_IDENTIFIED = true
LIQUIDITY_IDENTITY_MODEL_IDENTIFIED = true
WATCH_IDENTITY_MODEL_IDENTIFIED = true
NOTIFICATION_DEDUP_MODEL_IDENTIFIED = true
SWEEP_CONSUMPTION_EXISTS = false
SWEEP_OWNERSHIP_EXISTS = false
NARRATIVE_OWNERSHIP_EXISTS = false
SWEEP_CAN_ASSOCIATE_MULTIPLE_LEGS = true
OPPOSITE_SIDE_EFFECT_ON_PRIOR_SWEEP = NONE
ZEC_0855_0940_1025_REPRODUCED = true
ZEC_SAME_LIQUIDITY_ID = true
ZEC_SAME_EXACT_SWEEP_ID = true
ZEC_DIFFERENT_LEG_IDS = true
ZEC_DIFFERENT_WATCH_IDS = true
BTC_1000_1135_1155_1305_REPRODUCED = true
BTC_1000_1155_SAME_LIQUIDITY_ID = true
BTC_1000_1155_SAME_EXACT_SWEEP_ID = true
BTC_1155_LONG_ASSOCIATION = REUSED_EXACT_SWEEP
BTC_1135_1305_SAME_LIQUIDITY_ID = true
BTC_1135_1305_SAME_EXACT_SWEEP_ID = true
BTC_1305_SHORT_ASSOCIATION = REUSED_EXACT_SWEEP
RC1_SAME_EXACT_SWEEP_REUSED = true
RC2_SAME_LIQUIDITY_MULTIPLE_SWEEPS = false
RC3_WATCH_NO_NARRATIVE_IDENTITY = true
RC4_OPPOSITE_SIDE_NO_LIFECYCLE_EFFECT = true
RC5_CONTINUATION_PRESENTED_AS_NEW = true
RC6_IDENTITY_PROVENANCE_LOST = false
RC7_EVENT_SCOPED_DEDUP = true
AUDIT_ONLY_FILES_CREATED = scripts/auditWatchNarrativeSweepAssociationV1.js; test/auditWatchNarrativeSweepAssociationV1.test.js; research/watch-narrative-sweep-association-audit-v1/report.md; research/watch-narrative-sweep-association-audit-v1/*-forensic-replay.json; research/watch-narrative-sweep-association-audit-v1/fixtures/*
PRODUCTION_FILES_CHANGED = 0
DEDICATED_AUDIT_TESTS = 7/7 PASS
FULL_REGRESSION = PASS
IMPLEMENTATION_RECOMMENDED = YES
IMPLEMENTATION_STARTED = false
HARD_STOP_REACHED = true
```
