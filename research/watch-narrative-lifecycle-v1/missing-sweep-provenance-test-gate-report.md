# P4.1 Missing Sweep Provenance Fail-Open Test Gate Report

## 1. Original Review Gap

P4.1 Production Review V1 found no production blocker, but retained one MAJOR pre-commit test gap:

```text
MISSING_EXACT_SWEEP_PROVENANCE_FAIL_OPEN_DELIVERY
```

Static review had established the production behavior—no Narrative metadata, `EXACT_SWEEP_ID_MISSING` logging, and continued WATCH notification delivery—but no dedicated integration test exercised that entire production path.

## 2. Test Scope

Added one test-only file:

```text
test/watchNarrativeMissingSweepFailOpenV1.test.js
```

No production or runtime file was modified. The test contains:

- `MISSING_EXACT_SWEEP_PROVENANCE_FAIL_OPEN_DELIVERY` — primary production integration and delivery/dedup proof.
- `MISSING_EXACT_SWEEP_PROVENANCE_DOES_NOT_MUTATE_LIFECYCLE` — supporting reducer state-mutation proof.

## 3. Fixture Description

The primary fixture is a valid persisted `WATCH_WAIT_FVG` with:

- symbol/direction and stable WATCH ID;
- valid native FVG and confirmation time;
- valid displacement, MSS, structure, Bias, liquidity source, notification key, and causal timestamps;
- a real subsequent closed 5m candle overlapping the FVG and producing FIRST_TOUCH through `createWatchStore().onCandle()`;
- exactly one deliberately missing P4.1 field: `liquidityTaken.primary.id`, the exact stable sweep event identity.

It does not combine this case with DingTalk network failure. The mocked DingTalk response succeeds with `errcode=0`.

## 4. Production Path Exercised

The test calls the exported production `scripts/live.js::createRunner()` and exercises:

```text
persisted valid WATCH_WAIT_FVG
-> production runner bootstrap
-> production incremental closed candle
-> displacementWatch watchStore.onCandle()
-> real FVG_TOUCHED / firstTouchAt assignment
-> scripts/live.js::handleWatchTouches()
-> scripts/live.js::classifyNarrativeTouches()
-> watchNarrativeLifecycleV1.observeFirstTouch()
-> EXACT_SWEEP_ID_MISSING fail-open result
-> production notification formatter
-> production outbox/delivered-key logic
-> mocked dingTalk.sendText() success
-> WATCH marked NOTIFIED
```

Only external/data side effects were mocked: incremental market fetch, HTF fetch, and DingTalk network send. Narrative classification, FIRST_TOUCH detection, presentation, outbox, delivery dedup, and persistence boundaries were not mocked.

## 5. Assertions

The primary test proves:

- no throw;
- `EXACT_SWEEP_ID_MISSING` appears in captured production logging;
- no fallback/synthetic `narrativeId` or `observationId` is attached;
- Narrative count, Observation count, and active owner remain unchanged/empty;
- notification presentation is generated and DingTalk send is invoked once;
- message retains `检测`, liquidity, displacement, structure, FVG, Bias, `WAIT FOR MANUAL CONFIRMATION`, and WATCH-not-entry text;
- missing Narrative metadata does not invent NEW/CONTINUATION/REACTIVATION wording;
- the WATCH reaches `NOTIFIED` with the exact causal FIRST_TOUCH timestamp;
- delivered dedup continues to use the original `notificationKey`;
- a stale duplicate outbox entry after restart adds zero deliveries;
- production file content hashes are unchanged before/after the test runtime.

The supporting test proves the low-level failure result is `accepted=false`, reason `EXACT_SWEEP_ID_MISSING`, with a byte-identical lifecycle projection before and after.

## 6. Test Results

```text
WATCH Narrative Missing Sweep Fail-Open V1 2/2 PASS
```

Primary delivery count: 1. Duplicate/restart additional delivery count: 0.

## 7. Production Diff Guard

Production SHA-256 values before and after the gate task remained identical:

```text
stats/watchNarrativeLifecycleV1.js
390cb05fffbfaf35cb3694bda179f84663a4db193b3e52388a614399c91ee142

scripts/live.js
8d945f6c568ab3276cab392478f46718681d42288a978f02a5e892fa129b529a

notify/watchNotificationPresentationV1.js
2de63a07986dd5d4669a11e15541688721678cf39d54872b9d5cfdbc4cbd603e
```

The only gate-task additions are the dedicated test and this report.

```text
PRODUCTION_FILES_CHANGED_BY_GATE_TASK = 0
PRODUCTION_BEHAVIOR_CHANGED = false
```

## 8. Regression

- Dedicated fail-open tests: 2/2 PASS.
- Dedicated Narrative tests: 30/30 PASS.
- MSS/WATCH notification tests: 75/75 PASS.
- Sweep Context notification tests: 38/38 PASS.
- Standard Causal Swing tests: 50/50 PASS.
- P4.1 audit tests: 7/7 PASS.
- Full `npm test`: PASS; new test was automatically discovered; final output `ALL TESTS PASSED`.
- `git diff --check`: PASS.

## 9. Remaining Findings

The original MAJOR test gap is closed. The new test did not expose a production defect, blocker, or new major finding.

The previous review's non-blocking V1 notes—unbounded no-expiry registry, O(N) diagnostic cardinality scan, and lack of generic isolation for an unexpected thrown lifecycle exception—remain unchanged and are outside this test-only gate.

```text
PRODUCTION_DEFECT_DISCOVERED = false
NEW_BLOCKER_COUNT = 0
NEW_MAJOR_COUNT = 0
```

## 10. Release Gate Decision

Every condition in the supplied release decision rule is satisfied. This gate closes the sole Production Review MAJOR without modifying production behavior.

```text
ORIGINAL_MAJOR_TEST_GAP_CLOSED = true
READY_FOR_COMMIT = YES
READY_FOR_LIVE_OBSERVATION = YES
```

## Acceptance Matrix

```text
PHASE =
P4_1_MISSING_SWEEP_PROVENANCE_TEST_GATE

MODE =
TEST_ONLY_RELEASE_GATE

PRODUCTION_BEHAVIOR_CHANGED =
false

PRODUCTION_FILES_CHANGED_BY_GATE_TASK =
0

PRIMARY_INTEGRATION_TEST_ADDED =
true

TEST_NAME =
MISSING_EXACT_SWEEP_PROVENANCE_FAIL_OPEN_DELIVERY

VALID_WATCH_FIXTURE =
true

VALID_FIRST_TOUCH_FIXTURE =
true

ONLY_MISSING_REQUIREMENT =
EXACT_STABLE_SWEEP_PROVENANCE

THROWS_ON_MISSING_SWEEP =
false

EXACT_SWEEP_ID_MISSING_LOGGED =
true

FALLBACK_NARRATIVE_ID_CREATED =
false

PARTIAL_NARRATIVE_CREATED =
false

PARTIAL_OBSERVATION_CREATED =
false

ACTIVE_OWNER_CHANGED =
false

WATCH_NOTIFICATION_PRESENTED =
true

DINGTALK_SEND_INVOKED =
true

FIRST_DELIVERY_COUNT =
1

DUPLICATE_FIRST_TOUCH_ADDITIONAL_DELIVERY_COUNT =
0

FAIL_OPEN_REMAINS_IDEMPOTENT =
true

WAIT_FOR_MANUAL_CONFIRMATION_PRESERVED =
true

WATCH_NOT_ENTRY_DISCLAIMER_PRESERVED =
true

DINGTALK_REQUIRED_KEYWORD_PRESERVED =
true

NOTIFICATION_DEDUP_CHANGED =
false

WATCH_ELIGIBILITY_CHANGED =
false

FIRST_TOUCH_ELIGIBILITY_CHANGED =
false

NARRATIVE_ALGORITHM_CHANGED =
false

ORIGINAL_MAJOR_TEST_GAP_CLOSED =
true

DEDICATED_FAIL_OPEN_TESTS =
2/2 PASS

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

FULL_REGRESSION =
PASS

DIFF_CHECK =
PASS

NEW_BLOCKER_COUNT =
0

NEW_MAJOR_COUNT =
0

READY_FOR_COMMIT =
YES

READY_FOR_LIVE_OBSERVATION =
YES

COMMIT_CREATED =
false

PUSHED =
false

HARD_STOP_REACHED =
true
```
