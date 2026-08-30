# P4.1 Production Review V1

## 1. Review Scope

This was a pre-commit, read-only production review of the current P4.1 WATCH Narrative Identity & Lifecycle V1 implementation. No production code, algorithm, threshold, detector, eligibility rule, notification suppression, expiry, ranking, entry logic, commit, or push was performed during review. The only review-time write is this required report.

Reviewed production files:

- `stats/watchNarrativeLifecycleV1.js`
- `scripts/live.js`
- `notify/watchNotificationPresentationV1.js`

Reviewed tests and evidence include both dedicated lifecycle tests, WATCH notification tests, Sweep Context tests, Standard Causal Swing tests, the P4.1 sweep-association audit, and the ZEC/BTC production-equivalent forensic outputs.

## 2. Git Baseline

`git status --short --untracked-files=all` showed three tracked modifications and fourteen untracked files before this review report was created.

Tracked modifications:

- `notify/watchNotificationPresentationV1.js`
- `scripts/live.js`
- `test/watchNotificationPresentationV1.test.js`

Untracked baseline:

- `research/watch-narrative-lifecycle-v1/production-implementation-report.md`
- `research/watch-narrative-lifecycle-v1/production-implementation-review.md`
- `research/watch-narrative-sweep-association-audit-v1/BTCUSDT-forensic-replay.json`
- `research/watch-narrative-sweep-association-audit-v1/ZECUSDT-forensic-replay.json`
- `research/watch-narrative-sweep-association-audit-v1/fixtures/BTCUSDT-5m-futures.json`
- `research/watch-narrative-sweep-association-audit-v1/fixtures/BTCUSDT-5m-spot-mirror.json`
- `research/watch-narrative-sweep-association-audit-v1/fixtures/ZECUSDT-5m-futures.json`
- `research/watch-narrative-sweep-association-audit-v1/fixtures/ZECUSDT-5m-spot-mirror.json`
- `research/watch-narrative-sweep-association-audit-v1/report.md`
- `scripts/auditWatchNarrativeSweepAssociationV1.js`
- `stats/watchNarrativeLifecycleV1.js`
- `test/auditWatchNarrativeSweepAssociationV1.test.js`
- `test/watchNarrativeLifecycleIntegrationV1.test.js`
- `test/watchNarrativeLifecycleV1.test.js`

Tracked diff stat at baseline:

```text
notify/watchNotificationPresentationV1.js    | 22 ++++++++++++-
scripts/live.js                              | 47 ++++++++++++++++++++++++++--
test/watchNotificationPresentationV1.test.js |  5 +++
3 files changed, 71 insertions(+), 3 deletions(-)
```

`git diff --check`: PASS before and after the test rerun. Untracked files are not represented by `git diff --stat`; they were reviewed separately.

## 3. Production Diff Review

| Production file | Why changed | Contract requirement | Behavioral impact | Classification |
|---|---|---|---|---|
| `stats/watchNarrativeLifecycleV1.js` | Add pure identity/reducer/reconstruction module | Exact sweep identity; FIRST_TOUCH observations; ACTIVE/SUPERSEDED lifecycle | Adds isolated Narrative state and four additive WATCH metadata fields | EXPECTED |
| `scripts/live.js` | Call reducer after touched WATCH emission and reconstruct at startup | Live/replay/restart equivalence; classify before enqueue; no checkpoint | Classification precedes existing outbox; original notification key/dedup is retained | EXPECTED |
| `notify/watchNotificationPresentationV1.js` | Render immutable observation type | Distinguish NEW/CONTINUATION/REACTIVATION | Changes heading and adds one Narrative line only when metadata exists | EXPECTED |

No detector, WATCH builder, FVG touch detector, sweep/liquidity/MSS/displacement/Bias/EQ module, threshold, DingTalk client, or delivery-dedup implementation changed. Unrelated production changes: 0.

## 4. FIRST_TOUCH Registration Audit

Actual call graph:

```text
liveEngine displacement update
-> displacementWatch.createWatchStore().upsert(WATCH_WAIT_FVG)
-> watchStore.onPrice() or watchStore.onCandle()
-> state changes to FVG_TOUCHED and firstTouchAt is assigned
-> scripts/live.js::handleWatchTouches()
-> scripts/live.js::classifyNarrativeTouches()
-> watchNarrativeLifecycleV1.observeFirstTouch()
-> metadata presentation
-> unchanged notificationKey outbox
-> DingTalk delivery
```

Bootstrap calls the same classifier only on the array returned by `watchStore.onCandle()`. The reducer additionally rejects any record that is not `FVG_TOUCHED`/`NOTIFIED`, lacks `firstTouchAt`, or was not causally available by FIRST_TOUCH. No call originates from WATCH creation, FVG formation, displacement formation, or `buildWatch()`.

```text
NARRATIVE_REGISTRATION_CALLSITE = scripts/live.js::classifyNarrativeTouches(), called from handleWatchTouches() and bootstrap onCandle touched output
NARRATIVE_REGISTRATION_OCCURS_AT_FIRST_TOUCH = true
PRE_FIRST_TOUCH_REGISTRATION_PATHS = 0
```

Classification occurs before outbox enqueue and before `dingTalk.sendText()`. Delivery failure leaves the already-classified observation/state and original outbox retry intact. Narrative history does not depend on DingTalk success.

## 5. Narrative Identity Audit

Actual anchor path:

```text
watch.liquidityTaken.primary.id
-> identityForWatch().exactSweepEventId
-> buildNarrativeId()
```

Canonical ID:

```text
WATCH_NARRATIVE:V1:<encoded symbol>:<encoded timeframe>:<direction>:<encoded exact sweep event ID>
```

There is no fallback from missing `sweep.id` to liquidity ID, EQ cluster, price, confirmed time, WATCH, leg, or FVG. `anchor.liquidityId` is copied as non-identity provenance only. Missing exact sweep identity is rejected with `EXACT_SWEEP_ID_MISSING`.

No Narrative ID input uses `Date.now`, `Math.random`, UUID, delivery time, insertion counter, or object identity. Same exact sweep is stable; same liquidity cluster with a different exact sweep produces a different Narrative ID.

## 6. Observation Identity Audit

Actual fields:

```text
[V1, narrativeId, watch.id, watch.nativeFvg.id]
```

Canonical ID:

```text
WATCH_OBSERVATION:V1:<encoded narrativeId>:<encoded watchId>:<encoded primaryNativeFvgId>
```

No nondeterministic input is present. `observationsById` rejects a duplicate ID before appending observations or transitions.

ZEC forensic identity evidence:

- Narrative ID SHA-256 prefix for all three observations: `7151571a73d62335`.
- Observation ID SHA-256 prefixes: `e3b6aa6fe88acaf9`, `02cf67f2f0db6a9e`, `0e1507a4d433851b`.
- Unique Narrative IDs: 1.
- Unique Observation IDs: 3.

The hashes summarize the full deterministic canonical strings; the integration fixture derives them from the full exact production sweep, WATCH, and FVG IDs.

## 7. Lifecycle Transition Audit

All lookup/transition decisions depend only on exact identity, prior lifecycle state, scope owner, and a new qualifying FIRST_TOUCH:

- Unknown Narrative: `NEW` and `ACTIVE`.
- Known active exact Narrative: `CONTINUATION`, still `ACTIVE`.
- Different exact Narrative, same or opposite direction: old active becomes `SUPERSEDED`; new Narrative is `NEW` and active.
- Known superseded exact Narrative: `REACTIVATION`; current owner becomes `SUPERSEDED`; returning Narrative becomes active.

No Bias, MSS, structure role, displacement strength, FVG mitigation outcome, price follow-through, time passage, or delivery result participates. `CONTINUATION_EXTRA_GATES = []`.

Cardinality is enforced by `activeByScope[encoded symbol:encoded timeframe]`, superseding the prior owner before assigning the new owner. Frozen fixture violations: 0. The reducer also performs a diagnostic active-count scan after each accepted observation.

Observations are append-only clones of Bias, structure, displacement, and FVG snapshots. Later lifecycle transitions update Narrative state and append transition evidence; they do not relabel prior Observation types or replace prior snapshots.

## 8. ZEC Forensic Review

Production-equivalent USD-M Futures sequence:

```text
08:55 -> exact sweep Z -> NEW
09:40 -> exact sweep Z -> CONTINUATION
10:25 -> exact sweep Z -> CONTINUATION
```

Final projection: one Narrative, three Observations, one active owner, zero cardinality violations. The three full Narrative IDs are identical and the three full Observation IDs are distinct.

## 9. BTC Forensic Review

The reducer was inspected and rerun against the production-equivalent fixture:

```text
T1 10:00: A ACTIVE; type(A)=NEW
T2 11:35: A SUPERSEDED; B ACTIVE; type(B)=NEW
T3 11:55: B SUPERSEDED; A ACTIVE; type(A)=REACTIVATION
T4 13:05: A SUPERSEDED; B ACTIVE; type(B)=REACTIVATION
```

Canonical Narrative SHA-256 prefixes: A=`f97d0fe61d50aadd`, B=`c2f6830216f055c2`. Final active owner is B; active count is 1. Prior types remain `NEW`, `NEW`, `REACTIVATION`, `REACTIVATION` and are not rewritten.

## 10. Restart / Replay Review

Startup reconstructs from existing touched/notified WATCH records using the same reducer, sorted by `firstTouchAt` then Observation ID. It does not persist a separate lifecycle checkpoint.

Read-only staged simulations during review produced:

```text
restart after ZEC first NEW + next observation = CONTINUATION
restart after BTC A NEW / B NEW + next A observation = REACTIVATION
duplicate observation accepted = false
duplicate flag = true
projection before/after duplicate = identical
```

Historical reconstruction and incremental/live-style tests compare full `projection()` output: Narrative IDs and records, Observation IDs/types/snapshots, `activeByScope`, complete transition order, and cardinality violation count. They do not compare counts alone.

Restart duplicate observations: 0. Restart duplicate transitions: 0.

## 11. Notification Review

Presentation distinguishes:

- NEW: `Narrative：新观察（NEW）`.
- CONTINUATION: `Narrative：延续观察（CONTINUATION）` and update heading.
- REACTIVATION: `Narrative：重新激活（REACTIVATION）` and reactivation heading.

All headings preserve the configured DingTalk keyword (`检测` by default). All retain `WAIT FOR MANUAL CONFIRMATION` and `这是 WATCH 观察事件，不是入场确认。`.

Observation type is consumed only by the presentation adapter. It does not enter priority, quality, confidence, ranking, entry, WATCH eligibility, FIRST_TOUCH recognition, or notification dedup. The existing `notificationKey` remains WATCH × FVG and is the outbox/delivered key. Narrative ID is not used for dedup, so ZEC continuation notifications are not suppressed.

LOCAL/INTERNAL with `protectedBreak=false` remains a conservative structure break and is not upgraded to Structural MSS. No Narrative wording claims trend recovery, follow-through confirmation, acceptance, entry, or increased setup quality.

## 12. Event Population Invariants

The integration test performs an automated before/after comparison on the combined seven-observation production-equivalent ZEC/BTC migration fixture. It attaches lifecycle metadata and re-counts exact sweep, liquidity, displacement leg, MSS, FVG, WATCH, and FIRST_TOUCH populations.

| Population | Before | After | Changed |
|---|---:|---:|---|
| Raw sweep events | 3 | 3 | false |
| Liquidity events | 3 | 3 | false |
| Displacement legs | 7 | 7 | false |
| MSS events | 6 | 6 | false |
| FVGs | 7 | 7 | false |
| WATCHes | 7 | 7 | false |
| FIRST_TOUCHes | 7 | 7 | false |

Static call-graph review independently confirms the lifecycle layer receives touched WATCHes after detection and has no dependency path back into detectors or eligibility.

## 13. Failure Modes

Missing exact sweep ID or required provenance follows fail-open validation behavior:

1. reducer returns an unresolved reason such as `EXACT_SWEEP_ID_MISSING`;
2. `classifyNarrativeTouches()` logs `WATCH_NARRATIVE_V1_UNRESOLVED`;
3. the original touched WATCH continues through the existing `notificationKey` enqueue and DingTalk path;
4. presentation without `observationType` safely uses the legacy heading.

Therefore missing Narrative metadata does not crash delivery and no fallback identity is invented.

Non-blocking error-isolation note: `classifyNarrativeTouches()` does not wrap an unexpected thrown exception from the lifecycle module. Contract-validation failures are fail-open and production WATCH data is JSON-safe, so no concrete triggering input was found; nevertheless, the comment's “fail-open” guarantee is narrower than arbitrary internal exceptions. This is classified MINOR, not a frozen-contract blocker.

## 14. Performance / Memory Notes

- Primary Narrative and Observation lookups are O(1) map operations.
- Each accepted observation additionally calls `activeCount()`, which scans the Narrative registry: O(N) in total registered Narratives.
- Reconstruction is O(W log W + W·N worst case) because WATCHes are sorted and the diagnostic active scan is repeated.
- V1 has no expiry, so the Narrative/Observation/transition registry grows with unique sweeps and touches for the process lifetime.

The unbounded registry and linear diagnostic scan are known V1 operational risks, not review blockers. No expiry or threshold should be added in P4.1.

## 15. Test Quality Review

Rerun results:

- Dedicated Narrative: 30/30 PASS (`22/22` unit plus `8/8` integration).
- MSS/WATCH notification: 75/75 PASS.
- Sweep Context notification: 38/38 PASS.
- Standard Causal Swing: 50/50 PASS.
- P4.1 audit: 7/7 PASS.
- Full `npm test`: PASS, final `ALL TESTS PASSED`.
- Final `git diff --check`: PASS.

Strong automated coverage exists for exact identity, continuation, same-liquidity/different-sweep, same-direction and opposite-direction supersede, reactivation, A→B→A→B, cardinality, append-only history, Bias/structure snapshots, causality, deterministic replay, duplicate reducer processing, ZEC/BTC fixtures, presentation, and event-population invariants.

### Critical coverage gap

`test/watchNarrativeLifecycleV1.test.js` does not exercise missing `liquidityTaken.primary.id`/missing exact sweep provenance, and no integration test proves that this unresolved result still reaches the production outbox/delivery path. Static review shows the current code behaves correctly, but Review §41 explicitly requires missing provenance coverage and the decision rule requires critical contract tests before commit.

This is one MAJOR pre-commit test-gate finding:

```text
CRITICAL_TEST_COVERAGE_GAPS = [MISSING_EXACT_SWEEP_PROVENANCE_FAIL_OPEN_DELIVERY]
```

No production code fix is authorized or recommended by this review. A subsequent explicitly authorized test-only change can close the gate.

## 16. Commit Scope

Recommended include set after the MAJOR test gap is resolved:

- Production: `stats/watchNarrativeLifecycleV1.js`, `scripts/live.js`, `notify/watchNotificationPresentationV1.js`.
- Tests: `test/watchNarrativeLifecycleV1.test.js`, `test/watchNarrativeLifecycleIntegrationV1.test.js`, `test/watchNotificationPresentationV1.test.js`, `test/auditWatchNarrativeSweepAssociationV1.test.js`.
- Audit harness/evidence: `scripts/auditWatchNarrativeSweepAssociationV1.js`, `research/watch-narrative-sweep-association-audit-v1/report.md`, both production-equivalent forensic replay JSON files, and both USD-M Futures fixture JSON files.
- Contract/reports: `production-implementation-review.md`, `production-implementation-report.md`, and this `production-review-v1.md`.

Recommended exclude set from the P4.1 production commit:

- `research/watch-narrative-sweep-association-audit-v1/fixtures/BTCUSDT-5m-spot-mirror.json`
- `research/watch-narrative-sweep-association-audit-v1/fixtures/ZECUSDT-5m-spot-mirror.json`

Those two files are fallback research evidence, are not production-equivalent, and are not needed by the frozen tests. No unrelated or unknown untracked file was found.

Untracked classification:

- P4_1_REQUIRED: lifecycle core, lifecycle tests, audit harness/test/report, production-equivalent forensic outputs and Futures fixtures, implementation review/report, production review report.
- RESEARCH_ONLY: two spot-mirror raw fixtures.
- UNRELATED: none.
- UNKNOWN: none.

Do not use `git add .`; the include/exclude list should be applied explicitly after the gate is resolved.

## 17. Blocking Findings

None. `BLOCKING_DEFECT_FOUND = false`; blocker count is 0.

## 18. Non-Blocking Findings

- MAJOR: required missing-provenance fail-open delivery path lacks automated coverage. This blocks commit under the supplied decision rule even though static behavior is correct.
- MINOR: unexpected lifecycle exceptions are not generically isolated around classification; known validation failures are isolated and logged.
- INFO: registry memory is unbounded by design in V1.
- INFO: post-acceptance cardinality diagnostics scan the full Narrative registry.

## 19. Final GO / NO-GO

Production behavior review found no blocking contract defect: FIRST_TOUCH registration, exact sweep identity, lifecycle transitions, ZEC/BTC behavior, replay/restart semantics, notification semantics, population invariants, and regressions are correct.

However, the supplied review contract states that a critical contract test gap makes `READY_FOR_COMMIT = NO`. The missing-provenance fail-open delivery path is explicitly required and is not automated. Therefore:

```text
READY_FOR_COMMIT = NO
READY_FOR_LIVE_OBSERVATION = NO
```

This is a test-gate NO-GO, not a production-algorithm defect. No files were fixed during review.

## 20. Acceptance Matrix

```text
PHASE =
P4_1_PRODUCTION_REVIEW_V1

MODE =
PRE_COMMIT_PRODUCTION_REVIEW

PRODUCTION_IMPLEMENTATION_STATUS =
SUCCESS

PRODUCTION_CODE_MODIFIED_DURING_REVIEW =
false

BASELINE_WORKTREE_STATUS =
3 TRACKED MODIFIED; 14 UNTRACKED FILES (before review report)

DIFF_CHECK =
PASS

UNRELATED_PRODUCTION_CHANGES =
0

NARRATIVE_REGISTRATION_OCCURS_AT_FIRST_TOUCH =
true

PRE_FIRST_TOUCH_REGISTRATION_PATHS =
0

NARRATIVE_DEPENDS_ON_DINGTALK_SUCCESS =
false

NARRATIVE_ANCHOR =
EXACT_STABLE_SWEEP_EVENT_ID

EXACT_SWEEP_ID_PRESERVED =
true

FALLBACK_IDENTITY_EXISTS =
false

BLOCKING_IDENTITY_AMBIGUITY =
false

NARRATIVE_ID_DETERMINISTIC =
true

OBSERVATION_ID_DETERMINISTIC =
true

NARRATIVE_ID_NONDETERMINISTIC_INPUTS =
[]

OBSERVATION_ID_NONDETERMINISTIC_INPUTS =
[]

ACTIVE_NARRATIVE_CARDINALITY_VIOLATIONS =
0

CONTINUATION_EXTRA_GATES =
[]

OBSERVATION_TYPE_PREFIX_MUTATIONS =
0

BIAS_SNAPSHOT_PREFIX_MUTATIONS =
0

STRUCTURE_SNAPSHOT_PREFIX_MUTATIONS =
0

ZEC_SEQUENCE =
NEW → CONTINUATION → CONTINUATION

ZEC_UNIQUE_NARRATIVE_IDS =
1

ZEC_UNIQUE_OBSERVATION_IDS =
3

BTC_SEQUENCE =
NEW(A) → NEW(B) → REACTIVATION(A) → REACTIVATION(B)

BTC_FINAL_ACTIVE =
B

BTC_ACTIVE_COUNT =
1

RESTART_AFTER_NEW_THEN_CONTINUATION =
PASS

RESTART_AFTER_SUPERSEDE_THEN_REACTIVATION =
PASS

RESTART_DUPLICATE_OBSERVATIONS =
0

RESTART_DUPLICATE_TRANSITIONS =
0

LIVE_REPLAY_NARRATIVE_EQUIVALENCE =
PASS

NARRATIVE_EXPIRY_IMPLEMENTED =
false

IMPLICIT_EXPIRY_FOUND =
false

CONTINUATION_NOTIFICATION_SUPPRESSED =
false

REACTIVATION_NOTIFICATION_SUPPRESSED =
false

NOTIFICATION_DEDUP_KEY_CHANGED =
false

NARRATIVE_ID_USED_AS_NOTIFICATION_DEDUP_KEY =
false

NARRATIVE_LAYER_FEEDS_BACK_INTO_WATCH_DETECTION =
false

NARRATIVE_LAYER_FEEDS_BACK_INTO_FIRST_TOUCH =
false

DINGTALK_REQUIRED_KEYWORD_PRESERVED =
true

OBSERVATION_TYPE_USED_FOR_RANKING =
false

OBSERVATION_TYPE_USED_FOR_ENTRY =
false

OBSERVATION_TYPE_USED_FOR_WATCH_ELIGIBILITY =
false

P1_MSS_PRESENTATION_REGRESSION =
PASS

P6_SEMANTICS_LEAKED_INTO_P4_1 =
false

P2_MARKET_RISK_CHANGE_FOUND =
false

P7_CHECKPOINT_CHANGE_FOUND =
false

MODULE_IMPORT_SIDE_EFFECTS =
false

UNEXPECTED_UPSTREAM_OBJECT_MUTATION =
false

UNBOUNDED_NARRATIVE_REGISTRY_RISK =
true

LIFECYCLE_LOOKUP_COMPLEXITY =
O(1) primary map lookups; O(N) post-acceptance activeCount diagnostic

MISSING_SWEEP_ID_BEHAVIOR =
FAIL_OPEN: no Narrative metadata; log EXACT_SWEEP_ID_MISSING; original WATCH notification path continues

WATCH_DELIVERY_CAN_CRASH_ON_MISSING_NARRATIVE_METADATA =
false

CRITICAL_TEST_COVERAGE_GAPS =
[MISSING_EXACT_SWEEP_PROVENANCE_FAIL_OPEN_DELIVERY]

FIXTURE_HARDCODING_FOUND =
false

WATCH_COUNT_CHANGED =
false

FIRST_TOUCH_COUNT_CHANGED =
false

RAW_SWEEP_EVENT_COUNT_CHANGED =
false

FVG_COUNT_CHANGED =
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

FULL_REGRESSION =
PASS

BLOCKER_COUNT =
0

MAJOR_COUNT =
1

MINOR_COUNT =
1

INFO_COUNT =
2

BLOCKING_DEFECT_FOUND =
false

EVENT_POPULATION_AUTOMATED_PROOF =
true

INCLUDE_FILES =
[stats/watchNarrativeLifecycleV1.js, scripts/live.js, notify/watchNotificationPresentationV1.js, test/watchNarrativeLifecycleV1.test.js, test/watchNarrativeLifecycleIntegrationV1.test.js, test/watchNotificationPresentationV1.test.js, test/auditWatchNarrativeSweepAssociationV1.test.js, scripts/auditWatchNarrativeSweepAssociationV1.js, research/watch-narrative-lifecycle-v1/*.md, research/watch-narrative-sweep-association-audit-v1/report.md, research/watch-narrative-sweep-association-audit-v1/*-forensic-replay.json, research/watch-narrative-sweep-association-audit-v1/fixtures/*-5m-futures.json]

EXCLUDE_FILES =
[research/watch-narrative-sweep-association-audit-v1/fixtures/BTCUSDT-5m-spot-mirror.json, research/watch-narrative-sweep-association-audit-v1/fixtures/ZECUSDT-5m-spot-mirror.json]

READY_FOR_COMMIT =
NO

READY_FOR_LIVE_OBSERVATION =
NO

COMMIT_CREATED =
false

PUSHED =
false

HARD_STOP_REACHED =
true
```

## Final Required Questions

**Q1. Narrative observation 是否真的只在 FIRST_TOUCH 注册？**  是。生产调用点只接收 `onPrice()`/`onCandle()` 已触及输出，且 reducer 再次验证 terminal state 和 `firstTouchAt`。

**Q2. Narrative ID 是否真正锚定 exact stable sweep ID，且无危险 fallback？**  是。锚点严格是 `watch.liquidityTaken.primary.id`；没有 identity fallback。

**Q3. 同 exact sweep 的第二/第三个 FIRST_TOUCH 是否稳定成为 CONTINUATION？**  是。ZEC 为 NEW → CONTINUATION → CONTINUATION，Narrative ID 唯一。

**Q4. BTC A→B→A→B 是否稳定得到 NEW → NEW → REACTIVATION → REACTIVATION？**  是。

**Q5. Restart 后是否可能把 CONTINUATION / REACTIVATION 错误重置成 NEW？**  当前 reducer/reconstruction 和定向只读模拟均显示不会；两个 restart 场景均 PASS。

**Q6. P4.1 是否改变 WATCH/FIRST_TOUCH/event population？**  否。静态调用图与自动化七行迁移夹具均显示未改变。

**Q7. Narrative type 是否被用于 ranking / entry / eligibility？**  否。生产消费仅限通知呈现。

**Q8. Notification 是否清楚表达三种类型，同时保持 WATCH != ENTRY？**  是。三种标题/行语义清楚，人工确认与非入场声明保留。

**Q9. 当前是否存在任何 BLOCKER / MAJOR？**  BLOCKER=0；MAJOR=1，为缺失 exact sweep provenance 的 fail-open delivery 自动化测试缺口，不是已发现的生产算法缺陷。

**Q10. 最终 READY_FOR_COMMIT / READY_FOR_LIVE_OBSERVATION？**  `READY_FOR_COMMIT = NO`；`READY_FOR_LIVE_OBSERVATION = NO`，原因是明确的 pre-commit test gate 尚未关闭。
