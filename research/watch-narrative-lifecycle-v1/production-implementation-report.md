# P4.1 WATCH Narrative Identity & Lifecycle V1 Production Implementation Report

## Implementation Summary

Implemented the frozen V1 contract as a classification/ownership layer at the existing FIRST_TOUCH boundary. The implementation creates deterministic Narrative and Observation identities, maintains the two-state lifecycle, reconstructs state from touched WATCH records, and attaches presentation metadata before the existing DingTalk enqueue/delivery path.

No detector, eligibility rule, event population, notification eligibility, delivery dedup, threshold, expiry, score, ranking, or entry behavior was changed. No Narrative checkpoint was added.

## Files Changed

Production touchpoints, exactly matching the frozen Review MUST MODIFY set:

- `stats/watchNarrativeLifecycleV1.js` — new pure identity/lifecycle reducer, causal validation, deterministic reconstruction, append-only observations/transitions, and four-field WATCH metadata adapter.
- `scripts/live.js` — reconstructs from persisted touched WATCH records and classifies emitted FIRST_TOUCH records before the existing outbox enqueue.
- `notify/watchNotificationPresentationV1.js` — adds minimal NEW / CONTINUATION / REACTIVATION presentation semantics while retaining the DingTalk keyword and existing content.

Tests/report:

- `test/watchNarrativeLifecycleV1.test.js`
- `test/watchNarrativeLifecycleIntegrationV1.test.js`
- `test/watchNotificationPresentationV1.test.js`
- `research/watch-narrative-lifecycle-v1/production-implementation-report.md`

Pre-existing untracked audit/research artifacts were preserved. No unplanned production file was modified.

## Narrative ID Contract

Logical schema:

```text
[V1, symbol, timeframe, direction, exactSweepEventId]
```

Canonical form:

```text
WATCH_NARRATIVE:V1:<encoded symbol>:<encoded timeframe>:<direction>:<encoded exactSweepEventId>
```

Every variable component uses `encodeURIComponent`. The ID has no UUID, clock, random value, process-local counter, Bias, structure, displacement, FVG, or notification timestamp. Same exact sweep produces the same ID; a distinct exact sweep produces a distinct ID even for the same EQ V3 cluster, direction, or reference price.

## Observation ID Contract

Logical schema:

```text
[V1, narrativeId, watchId, primaryNativeFvgId]
```

Canonical form:

```text
WATCH_OBSERVATION:V1:<encoded narrativeId>:<encoded watchId>:<encoded primaryNativeFvgId>
```

Registration occurs only for an existing qualifying FIRST_TOUCH terminal WATCH. Duplicate Observation IDs are idempotent and create neither an observation nor a lifecycle transition.

## Lifecycle Implementation

- First-ever exact sweep observation: `NEW`, Narrative becomes `ACTIVE`.
- Same exact sweep while active: `CONTINUATION`, Narrative remains `ACTIVE`.
- Different exact sweep, same or opposite direction: new Narrative is `NEW`; current active Narrative becomes `SUPERSEDED`.
- Previously superseded exact sweep returns: `REACTIVATION`; current active Narrative becomes `SUPERSEDED`, returning Narrative becomes `ACTIVE`.
- Scope: at most one active Narrative per `symbol + timeframe`.
- History: observations and transition ledgers are append-only. Bias, structure, displacement, and FVG snapshots remain frozen per observation.
- Expiry: none.

The reducer records `OBSERVATION_APPENDED`, `NARRATIVE_ACTIVATED`, `NARRATIVE_SUPERSEDED`, and `NARRATIVE_REACTIVATED`. It never deletes superseded Narratives.

## Notification Integration

The four additive WATCH fields are:

```text
narrativeId
observationId
observationType
narrativeStateSnapshot
```

Presentation adds one Narrative line and minimal heading semantics:

- `Narrative：新观察（NEW）`
- `Narrative：延续观察（CONTINUATION）`
- `Narrative：重新激活（REACTIVATION）`

All types still pass through the same FIRST_TOUCH outbox and delivery dedup. `检测`, liquidity/sweep/displacement/structure/FVG/Bias content, `WAIT FOR MANUAL CONFIRMATION`, and the WATCH-not-entry disclaimer remain present. Missing or legacy Narrative metadata retains the prior title format.

## ZEC Fixture Result

Production-equivalent USD-M Futures forensic fixture:

```text
08:55 SHORT -> NEW
09:40 SHORT -> CONTINUATION
10:25 SHORT -> CONTINUATION
```

Result: one exact-sweep Narrative, three distinct Observations, one final active Narrative, zero cardinality violations.

## BTC Fixture Result

Production-equivalent USD-M Futures forensic fixture:

```text
10:00 LONG A  -> NEW
11:35 SHORT B -> NEW; A SUPERSEDED
11:55 LONG A  -> REACTIVATION; B SUPERSEDED
13:05 SHORT B -> REACTIVATION; A SUPERSEDED
```

Result: final active Narrative `B`, active count 1, zero cardinality violations.

## Replay/Restart Result

The same reducer is used for incremental/live-style processing and reconstruction. Reconstruction selects touched/notified WATCH records, sorts by `firstTouchAt` then lexical Observation ID, and starts from empty state. It uses no network delivery result, wall clock, process-local history, or P7 checkpoint.

- Historical replay vs incremental projection: exact equality.
- Repeated reconstruction: exact equality.
- Restart reconstruction retains `CONTINUATION` and `REACTIVATION`; it does not reclassify them as `NEW`.
- Duplicate FIRST_TOUCH processing: no state, owner, count, observation, or transition change.

## Count Invariants

For the combined seven-row ZEC/BTC migration fixture, before/after classification counts were identical:

| Population | Before | After | Changed |
|---|---:|---:|---|
| Raw Sweep events | 3 | 3 | false |
| Liquidity events | 3 | 3 | false |
| Displacement legs | 7 | 7 | false |
| MSS events | 6 | 6 | false |
| FVGs | 7 | 7 | false |
| WATCHes | 7 | 7 | false |
| FIRST_TOUCHes | 7 | 7 | false |

Only lifecycle metadata was added.

## Causality/Determinism

Causal guards require the exact primary sweep to be confirmed no later than FIRST_TOUCH, the WATCH evaluation/update time to be no later than FIRST_TOUCH, and the native FVG to be confirmed no later than FIRST_TOUCH when its confirmation time is present. Narrative registration is rejected before FIRST_TOUCH.

Repeated full replays and replay prefixes produce identical Narrative IDs, Observation IDs, transition sequences, and prefix observations. Later Bias/structure events do not mutate prior snapshots. Determinism violations: 0. Bias snapshot prefix mutations: 0. Structure snapshot prefix mutations: 0.

## Regression

- Dedicated Narrative tests: 30/30 PASS (`22/22` unit + `8/8` frozen integration).
- MSS notification tests: 75/75 PASS.
- Sweep Context notification tests: 38/38 PASS.
- Standard Causal Swing V1 tests: 50/50 PASS.
- P4.1 audit tests: 7/7 PASS.
- Full regression: PASS (`npm test`, exit code 0, final result `ALL TESTS PASSED`).
- `git diff --check`: PASS.

## Known V1 Limitations

- V1 has no Narrative expiry and creates no expiry threshold.
- V1 derives state by replay and has no P7 checkpoint.
- Lifecycle state represents radar ownership only; it is not market direction, setup strength, acceptance/follow-through, trade quality, entry readiness, or outcome.
- V1 does not suppress repeated qualifying FIRST_TOUCH notifications.
- Intrabar FIRST_TOUCH milliseconds remain existing WATCH facts; IDs do not depend on notification time or network response.

## Acceptance Matrix

```text
PHASE =
WATCH_NARRATIVE_IDENTITY_LIFECYCLE_V1

MODE =
PRODUCTION_IMPLEMENTATION

NARRATIVE_ANCHOR =
EXACT_STABLE_SWEEP_EVENT_ID

OBSERVATION_REGISTRATION_POINT =
FIRST_TOUCH

LIFECYCLE_STATES =
ACTIVE | SUPERSEDED

OBSERVATION_TYPES =
NEW | CONTINUATION | REACTIVATION

ACTIVE_NARRATIVE_CARDINALITY =
ONE_PER_SYMBOL_TIMEFRAME

NARRATIVE_ID_DETERMINISTIC =
true

OBSERVATION_ID_DETERMINISTIC =
true

REPLAY_RECONSTRUCTABLE =
true

RESTART_DETERMINISTIC =
true

PREFIX_STABLE =
true

IDEMPOTENT_FIRST_TOUCH =
true

ACTIVE_NARRATIVE_CARDINALITY_VIOLATIONS =
0

ZEC_SEQUENCE =
NEW → CONTINUATION → CONTINUATION

ZEC_NARRATIVE_COUNT =
1

ZEC_OBSERVATION_COUNT =
3

BTC_SEQUENCE =
NEW(A) → NEW(B) → REACTIVATION(A) → REACTIVATION(B)

BTC_FINAL_ACTIVE =
B

BTC_ACTIVE_COUNT =
1

SAME_LIQUIDITY_NEW_EXACT_SWEEP_IS_NEW_NARRATIVE =
true

SAME_DIRECTION_NEW_EXACT_SWEEP_SUPERSEDES =
true

OPPOSITE_NEW_EXACT_SWEEP_SUPERSEDES =
true

BIAS_PART_OF_NARRATIVE_ID =
false

STRUCTURE_PART_OF_NARRATIVE_ID =
false

DISPLACEMENT_PART_OF_NARRATIVE_ID =
false

FVG_PART_OF_NARRATIVE_ID =
false

BIAS_SNAPSHOT_PREFIX_MUTATIONS =
0

STRUCTURE_SNAPSHOT_PREFIX_MUTATIONS =
0

NARRATIVE_EXPIRY_IMPLEMENTED =
false

NEW_EXPIRY_THRESHOLD_CREATED =
false

CONTINUATION_NOTIFICATION_SUPPRESSED =
false

WATCH_ELIGIBILITY_CHANGED =
false

WATCH_COUNT_CHANGED =
false

WATCH_TIMING_CHANGED =
false

WATCH_DIRECTION_CHANGED =
false

SWEEP_ALGORITHM_CHANGED =
false

LIQUIDITY_ALGORITHM_CHANGED =
false

DISPLACEMENT_CHANGED =
false

MSS_CHANGED =
false

FVG_CHANGED =
false

BIAS_CHANGED =
false

EQ_V3_CHANGED =
false

STANDARD_CAUSAL_SWING_V1_CHANGED =
false

P6_FOLLOW_THROUGH_CHANGED =
false

MARKET_RISK_CHANGED =
false

FIRST_TOUCH_TRIGGER_CHANGED =
false

DINGTALK_DELIVERY_ELIGIBILITY_CHANGED =
false

RAW_SWEEP_EVENT_COUNT_CHANGED =
false

LIQUIDITY_EVENT_COUNT_CHANGED =
false

DISPLACEMENT_LEG_COUNT_CHANGED =
false

MSS_EVENT_COUNT_CHANGED =
false

FVG_COUNT_CHANGED =
false

FIRST_TOUCH_COUNT_CHANGED =
false

DEDICATED_NARRATIVE_TESTS =
30/30 PASS

MSS_NOTIFICATION_TESTS =
75/75 PASS

SWEEP_CONTEXT_NOTIFICATION_TESTS =
38/38 PASS

STANDARD_CAUSAL_SWING_TESTS =
50/50 PASS

P4_1_AUDIT_TESTS =
7/7 PASS

LIVE_REPLAY_NARRATIVE_EQUIVALENCE =
PASS

FULL_REGRESSION =
PASS

UNPLANNED_PRODUCTION_TOUCHPOINT =
NONE

PRODUCTION_IMPLEMENTATION_STATUS =
SUCCESS

READY_FOR_PRODUCTION_REVIEW =
YES

COMMIT_CREATED =
false

PUSHED =
false

HARD_STOP_REACHED =
true
```
