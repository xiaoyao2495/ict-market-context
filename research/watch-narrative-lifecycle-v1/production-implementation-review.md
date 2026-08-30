# P4.1 WATCH Narrative Identity & Lifecycle V1 — Production Implementation Review

## 1. Existing Production Model

Production currently has stable identities for liquidity, sweep events, displacement legs, WATCHes, native FVGs, FIRST_TOUCH delivery keys, and EQ V3 clusters, but no identity spanning several WATCHes that reuse one exact sweep.

The relevant chain is:

```text
replay/replayState.js::incrementalEvents()
→ events/sweepEventAdapter.js::buildSweepEvent()
→ stats/liquidityProvenance.js::associateSweeps()
→ stats/displacementWatch.js::buildWatch()
→ stats/displacementWatch.js::createWatchStore().onPrice()/onCandle()
→ scripts/live.js::handleWatchTouches()/deliverWatchTouch()
→ notify/watchNotificationPresentationV1.js
```

Current identities and state boundaries:

- Sweep ID: `symbol:timeframe:SWEEP:liquidity.id` (`events/sweepEventAdapter.js::buildSweepEvent()`, lines 37-76).
- WATCH ID: symbol + direction + first displacement event ID (`stats/displacementWatch.js::buildWatch()`, lines 140-170).
- Notification key: WATCH ID + primary native FVG ID (same function, line 170).
- Delivered dedup: keyed by that notification key in `createWatchStore()` and persisted as `fvg-watch-delivered.json` (`scripts/live.js`, lines 321-352, 530-560).
- Restart: load persisted WATCH/delivery files, then replay closed 5m candles through `liveEngine.onBar()`; bootstrap updates the WATCH store but does not send historical notifications (`scripts/live.js`, lines 335-339, 478-520).

The sweep-to-leg association is a recent-direction projection, not ownership. `stats/liquidityProvenance.js::associateSweeps()` (lines 171-214) filters by side, confirmation time, eligible source type, and the existing 48-bar window, then selects the candidate closest to `leg.startIndex`. It has no consumed/claimed/narrative state.

## 2. Audit Evidence

The preceding production-source audit is frozen in `research/watch-narrative-sweep-association-audit-v1/report.md` and its USD-M Futures forensic JSON files.

| Fixture | Exact sweep result | Downstream result |
|---|---|---|
| ZEC 08:55 → 09:40 → 10:25 SHORT | Same exact BSL sweep, confirmed 07:05 | Three leg IDs, WATCH IDs, FVG IDs, and FIRST_TOUCHes |
| BTC 10:00 → 11:55 LONG | Same exact SSL sweep, confirmed 09:20 | Two distinct downstream observations |
| BTC 11:35 → 13:05 SHORT | Same exact BSL sweep, confirmed 08:20 | Two distinct downstream observations |
| BTC A→B→A→B | No opposite-side lifecycle effect | A and B each reuse their original exact sweep |

An additional design-relevant fact comes from the frozen replay: ZEC had same-sweep `WATCH_NO_FVG` formations at 07:05 and 07:55 before the 08:55 notified WATCH. Therefore a Narrative Observation must not be registered merely because `buildWatch()` returned an object. The observation boundary is the first `FIRST_TOUCH` transition of a notification-capable WATCH. Otherwise the required 08:55 `NEW` classification would be causally wrong.

## 3. Problem Definition

The problem is not event duplication. A new displacement leg, structure snapshot, native FVG, and FIRST_TOUCH remains a valid new observable event.

The missing product relation is:

```text
exact Sweep Event
  └─ Narrative
       ├─ FIRST_TOUCH Observation #1
       ├─ FIRST_TOUCH Observation #2
       └─ FIRST_TOUCH Observation #3
```

V1 adds ownership and presentation metadata only. It must not suppress an observation, change WATCH eligibility, reinterpret a detector, or claim a market reversal.

```text
EVENT DEDUP != NARRATIVE LIFECYCLE
NARRATIVE_SUPERSEDED != MARKET_REVERSAL_CONFIRMED
CONTINUATION != FOLLOW_THROUGH_CONFIRMED
```

## 4. Narrative Identity Contract

### Decision

```text
IS_EXACT_SWEEP_THE_CORRECT_V1_NARRATIVE_ANCHOR = YES
```

An exact sweep is the smallest currently stable production fact shared by all target observations. Liquidity price is presentation only; liquidity/cluster identity alone cannot distinguish separate sweep events; direction alone merges unrelated events; leg/FVG identity is downstream and intentionally changes per observation.

### Schema

Logical fields:

```text
NARRATIVE_ID_SCHEMA = [schemaVersion="V1", symbol, timeframe, direction, exactSweepEventId]
```

Canonical string contract:

```text
WATCH_NARRATIVE:V1:
  encodeURIComponent(symbol) + ":" +
  encodeURIComponent(timeframe) + ":" +
  direction + ":" +
  encodeURIComponent(exactSweepEventId)
```

The source sweep must satisfy all existing association guards. `exactSweepEventId` is `liquidityTaken.primary.id`, while `liquidityId`, `occurredAt`, and `confirmedAt` are stored as anchor provenance but do not independently define the ID.

```text
NARRATIVE_ID_DETERMINISTIC = true
NARRATIVE_ID_RESTART_STABLE = true
NARRATIVE_ID_REPLAY_STABLE = true
NARRATIVE_ID_FUTURE_FREE = true
BIAS_PART_OF_NARRATIVE_ID = false
STRUCTURE_PART_OF_NARRATIVE_ID = false
DISPLACEMENT_PART_OF_NARRATIVE_ID = false
FVG_PART_OF_NARRATIVE_ID = false
```

The explicit symbol/timeframe/direction fields make validation and partitioning fail-closed even though the present sweep ID also embeds symbol/timeframe. A mismatch between those fields and the sweep must reject narrative enrichment without changing the WATCH.

### Minimal Narrative record

```js
{
  id,
  schemaVersion: 'V1',
  symbol,
  timeframe,
  direction,
  anchor: {
    sweepEventId,
    liquidityId,
    occurredAt,
    confirmedAt
  },
  state,                    // ACTIVE | SUPERSEDED
  createdAt,               // first qualifying FIRST_TOUCH observation time
  lastObservedAt,
  observationCount,
  supersededAt: null,
  supersededByNarrativeId: null
}
```

Only anchor scalars are copied. The full liquidity, sweep, WATCH, structure, bias, displacement, and FVG objects remain authoritative in their existing owners.

## 5. Observation Identity Contract

### Qualifying boundary

A Narrative Observation is appended exactly once when a WATCH first transitions from `WATCH_WAIT_FVG` to `FVG_TOUCHED` through `createWatchStore().onPrice()` or `.onCandle()`. It is created before DingTalk enqueue/delivery and therefore does not depend on delivery success.

- `WATCH_NO_FVG` is not an observation.
- A WATCH waiting for an untouched FVG is not yet an observation.
- Delivery retry is not another observation.
- Reprocessing the same FIRST_TOUCH is idempotent.

### Schema

```text
OBSERVATION_ID_SCHEMA = [schemaVersion="V1", narrativeId, watchId, primaryNativeFvgId]
```

Canonical string uses the same `encodeURIComponent` rule:

```text
WATCH_OBSERVATION:V1:<encoded narrativeId>:<encoded watchId>:<encoded primaryNativeFvgId>
```

`watchId` already contains the first displacement event/leg identity. `displacementLegId` remains an explicit observation field for inspection, but duplicating it in the ID adds no uniqueness. Native FVG is included because current delivery semantics are one primary FVG per WATCH and the notification key is WATCH × FVG.

### Minimal Observation record

```js
{
  id,
  narrativeId,
  watchId,
  notificationKey,
  direction,
  displacementLegId,
  primaryNativeFvgId,
  observedAt,               // FIRST_TOUCH time
  type,                     // NEW | CONTINUATION | REACTIVATION
  narrativeState: 'ACTIVE',
  structureSnapshot,
  biasSnapshot
}
```

Structure and bias are the compact snapshots already carried by the WATCH at its terminal touch transition. They are never backfilled from later observations.

## 6. Lifecycle State Machine

V1 freezes two lifecycle states and three observation types:

```text
LIFECYCLE_STATES = ACTIVE | SUPERSEDED
OBSERVATION_TYPES = NEW | CONTINUATION | REACTIVATION
```

`EXPIRED` is rejected for V1 because production exposes no causal expiry event. Adding a state without an existing transition source would either be dead schema or require a new arbitrary threshold.

State and observation type are separate dimensions. `ACTIVE` describes current radar ownership; `CONTINUATION` describes the immutable type of one observation.

### Frozen transition table

| Current active | Qualifying FIRST_TOUCH event | Result | Observation type |
|---|---|---|---|
| NONE | first-ever Narrative A | A ACTIVE | NEW |
| A ACTIVE | new Observation of exact A | A remains ACTIVE | CONTINUATION |
| A ACTIVE | first-ever opposite Narrative B | A SUPERSEDED; B ACTIVE | NEW |
| B ACTIVE; A SUPERSEDED | exact A returns | B SUPERSEDED; A ACTIVE | REACTIVATION |
| A ACTIVE | first-ever same-direction distinct exact sweep C | A SUPERSEDED; C ACTIVE | NEW |
| C ACTIVE; A SUPERSEDED | exact A returns | C SUPERSEDED; A ACTIVE | REACTIVATION |
| A ACTIVE | duplicate Observation ID | no state/count change | no new observation |

Every accepted new observation is append-only. A transition may update its Narrative record and append a transition event, but it never edits an earlier Observation.

## 7. Opposite-Side Semantics

V1 selects **OPTION A: supersede immediately at the opposite Narrative's qualifying FIRST_TOUCH**.

The scope is one radar ownership slot per `symbol + timeframe`. The takeover timestamp is the new observation's `observedAt`; `supersededByNarrativeId` points to the takeover Narrative.

```text
ACTIVE_NARRATIVE_CARDINALITY = at most one per symbol + timeframe
OPPOSITE_SIDE_TAKEOVER = prior ACTIVE → SUPERSEDED; new/returning Narrative → ACTIVE
```

Reasons:

- It gives A→B→A→B one unambiguous deterministic history.
- Concurrent opposite narratives would make `REACTIVATION` undefined and preserve the current presentation ambiguity.
- `INTERRUPTED` adds a third state with no distinct V1 transition behavior.
- One slot also resolves same-direction distinct sweeps without a complex portfolio of active narratives.

This is radar ownership only. It does not assert a reversal, invalidate a trade thesis, alter HTF bias, or imply Structural MSS.

## 8. Reactivation Semantics

```text
REACTIVATION = an already-known SUPERSEDED Narrative receives a new, previously unseen qualifying FIRST_TOUCH Observation and retakes the symbol/timeframe ACTIVE slot
```

The definition intentionally covers takeover by any different exact-sweep Narrative, not only the opposite side. Opposite A→B→A is the required case; same-direction A→C→A follows the same minimal state machine.

Frozen fixture expectations:

```text
ZEC: NEW → CONTINUATION → CONTINUATION

BTC:
10:00 A LONG  = NEW
11:35 B SHORT = NEW;          A → SUPERSEDED
11:55 A LONG  = REACTIVATION; B → SUPERSEDED
13:05 B SHORT = REACTIVATION; A → SUPERSEDED
```

## 9. Causality / Prefix Contract

Reducer input consists only of the touched WATCH's frozen fields and prior reducer state.

Required guards:

1. The sweep candidate already passed existing production association eligibility.
2. `sweep.confirmedAt <= watch.updatedAt <= firstTouchAt`.
3. Native FVG and notification key must exist.
4. Observation ID must be unseen.
5. Events process in ascending `observedAt`, then lexical Observation ID for exact timestamp ties.

The reducer emits append-only records:

```text
OBSERVATION_APPENDED
NARRATIVE_ACTIVATED
NARRATIVE_SUPERSEDED
NARRATIVE_REACTIVATED
```

Prefix stability contract:

- Replay through 10:05 fixes BTC 10:00 as `NEW` forever.
- The 11:35 event appends A's `SUPERSEDED` transition; it does not relabel 10:00.
- Bias/structure/FVG outcomes after an observation cannot change its type or snapshots.

```text
PREFIX_STABLE = true
NO_FUTURE_CONFIRMED_AT = enforced
NO_RETROACTIVE_OBSERVATION_MUTATION = enforced
```

## 10. Replay / Restart Contract

The pure lifecycle reducer processes a canonical sequence of existing touched WATCH records. Reconstruction input is:

```text
state=empty
→ select WATCHes with firstTouchAt + notificationKey + exact primary sweep provenance
→ sort by firstTouchAt, then Observation ID
→ reduce
```

Live uses the identical reducer before enqueuing a newly touched WATCH. Restart first reconstructs from the already-persisted `displacement-watches.json` records, which preserve real-time `firstTouchAt`; bootstrap candle replay can then verify/complete missing closed-candle fallback records without duplicating Observation IDs.

A clean historical replay with no prior `.live-state` reconstructs deterministically from closed-candle FIRST_TOUCH fallback. Exact intrabar delivery milliseconds are not identity fields; the stable tie-breaker prevents process-order identity drift.

```text
REPLAY_RECONSTRUCTABLE = true
RESTART_DETERMINISTIC = true
```

No database transaction or process-local counter is required.

## 11. Persistence Contract

V1 selects **A: derive/reconstruct; do not add a separate Narrative checkpoint**.

- Authoritative replay inputs remain persisted WATCH records plus the existing candle history.
- Observation identity/type and narrative transition history may be serialized as additive metadata on touched WATCH records for inspection, but the reducer must reproduce and verify them from canonical inputs.
- `fvg-watch-delivered.json` remains delivery dedup only; it must never become narrative state.
- `pushed.json`, `fvg-watch-outbox.json`, and notification keys remain unchanged.
- P7 Restart Checkpoint remains out of scope.

This avoids two competing sources of truth. If persisted additive metadata disagrees with replay, startup must report a narrative-reconstruction mismatch and retain existing notification safety; it must not silently rewrite a delivered event.

## 12. Notification Contract

Future presentation reads the immutable Observation type:

| Type | Proposed heading | Meaning |
|---|---|---|
| NEW | `🔔 新观察 · SYMBOL · 做多/做空` | First qualifying FIRST_TOUCH for this exact sweep Narrative |
| CONTINUATION | `🔄 观察更新 · SYMBOL · 做多/做空` | Another qualifying FIRST_TOUCH while the same Narrative remained ACTIVE |
| REACTIVATION | `🔁 观察重新激活 · SYMBOL · 做多/做空` | A SUPERSEDED exact-sweep Narrative retook radar ownership |

All remain WATCH observations, not ENTRY confirmations. Existing displacement, structure, bias, FVG, and risk context remains per observation.

```text
CONTINUATION_NOTIFICATION_SUPPRESSION = OUT_OF_SCOPE
CONTINUATION_EQUALS_FOLLOW_THROUGH = false
```

No type changes DingTalk eligibility, retry behavior, or delivery dedup.

## 13. Migration Plan

### Phase A — Pure core and frozen fixtures

Add deterministic ID helpers and an append-only reducer. Lock all 24 edge cases, especially ZEC and BTC A→B→A→B. No production call site yet.

### Phase B — Additive WATCH integration

At FIRST_TOUCH, derive the Narrative/Observation, run the reducer, and attach only:

```text
narrativeId
observationId
observationType
narrativeStateSnapshot
```

Reconstruct the reducer from persisted touched WATCHes during bootstrap. Assert unchanged WATCH/FVG/FIRST_TOUCH populations and timing.

### Phase C — Presentation

Render NEW / CONTINUATION / REACTIVATION without changing notification trigger/dedup. Preserve WATCH-not-entry wording.

### Phase D — Live/replay/restart equivalence

Run production-source fixtures, prefix replays, duplicate-bar processing, failed-delivery retry, and restart reconstruction. Gate rollout on every invariant in Section 15.

Phases may be separate commits/releases. Phase C must not precede Phase B equivalence.

## 14. File Touchpoint Matrix

### MUST MODIFY in a future implementation

| File | Bounded reason |
|---|---|
| `stats/watchNarrativeLifecycleV1.js` (new) | Pure canonical ID builders, reducer, reconstruction, validation, and transition serialization. No detector imports. |
| `scripts/live.js` | Owns persisted WATCH store, bootstrap reconstruction, FIRST_TOUCH collection, outbox, and delivery boundary. Invoke the reducer once before enqueue and attach additive metadata. |
| `notify/watchNotificationPresentationV1.js` | Presentation-only mapping of immutable observation type to NEW/CONTINUATION/REACTIVATION wording. |
| `test/watchNarrativeLifecycleV1.test.js` (new) | Unit contract for IDs, state transitions, cardinality, idempotency, prefix stability, and edge cases. |
| `test/watchNarrativeLifecycleIntegrationV1.test.js` (new) | Frozen ZEC/BTC fixtures plus live/replay/restart population invariants. |

### MAY MODIFY

| File | Strict limit |
|---|---|
| `stats/displacementWatch.js` | Additive metadata preservation/normalization only; do not change build eligibility, native FVG choice, touch detection, invalidation, notification key, or delivery state. |
| `live/liveEngine.js` | Optional shadow diagnostics/export only; lifecycle ownership should remain at the touched-WATCH boundary, not displacement detection. |
| `live/persistence.js` | No semantic change expected; only a generic validation helper if unavoidable. |
| `notify/sweepContextPresentationV1.js` | Only if layout composition needs the already-computed type; no source/identity selection changes. |

### MUST NOT MODIFY for P4.1

```text
events/sweepEventAdapter.js
events/displacementDetector.js
events/mssSignalDetector.js
liquidity/*
structure/*
fvg/*
bias/*
entry/*
draw/*
amd/*
config/thresholds.js
config/eqProductionVersion.js
live/futuresPriceStream.js
notify/dingTalk.js
```

Also forbidden: WATCH association/eligibility rules, notification key construction, delivered/outbox semantics, and any P7 checkpoint work.

## 15. Test Matrix

| # | Case | Frozen assertion |
|---:|---|---|
| 1 | First observation of sweep | Narrative created ACTIVE; Observation NEW |
| 2 | Same sweep second observation | Same Narrative ID; CONTINUATION |
| 3 | Same sweep third observation | Same Narrative ID; CONTINUATION; count=3 |
| 4 | Opposite new Narrative | Prior SUPERSEDED; opposite NEW+ACTIVE |
| 5 | Prior Narrative returns | REACTIVATION; current owner superseded |
| 6 | A→B→A→B | NEW, NEW, REACTIVATION, REACTIVATION |
| 7 | Same cluster, new exact sweep | Different Narrative ID; NEW |
| 8 | Different cluster, same direction | Different Narrative ID; NEW |
| 9 | Two same-direction Narratives | Never concurrent ACTIVE; later NEW supersedes prior |
| 10 | Same sweep, different leg | Same Narrative; different Observation IDs |
| 11 | Same sweep, different FVG | Same Narrative; different Observation IDs |
| 12 | Structure NONE→LOCAL | Identity stable; snapshots differ only per observation |
| 13 | Structure LOCAL→INTERNAL | Identity stable; no prior snapshot rewrite |
| 14 | Bias UNKNOWN→MATCH | Identity stable; second snapshot MATCH |
| 15 | Bias MATCH→OPPOSITE | Identity stable; no lifecycle inference from bias |
| 16 | Restart reconstruction | Same Narratives, states, counts, types, transitions |
| 17 | Prefix replay | Earlier Observation bytes remain unchanged |
| 18 | Deterministic IDs | Live/restart/replay IDs byte-equal |
| 19 | Duplicate processing same bar | Observation ID idempotent; counts unchanged |
| 20 | Repeated FIRST_TOUCH delivery/restart | One Observation; delivery retry key unchanged |
| 21 | Missing optional provenance | Fail enrichment closed; WATCH/delivery unchanged |
| 22 | Stale/ineligible sweep | Existing association rejects; no new Narrative behavior |
| 23 | Future confirmedAt | Reject enrichment; no state mutation |
| 24 | No retroactive mutation | Later takeover appends transition only |

Population invariants for integration/replay:

```text
RAW_SWEEP_EVENT_COUNT_CHANGED = false
LIQUIDITY_EVENT_COUNT_CHANGED = false
DISPLACEMENT_LEG_COUNT_CHANGED = false
MSS_EVENT_COUNT_CHANGED = false
FVG_COUNT_CHANGED = false
WATCH_COUNT_CHANGED = false
WATCH_TIMING_CHANGED = false
WATCH_DIRECTION_CHANGED = false
FIRST_TOUCH_COUNT_CHANGED = false
BIAS_CHANGED = false
EQ_V3_CHANGED = false
STANDARD_CAUSAL_SWING_V1_CHANGED = false
```

## 16. Risks

1. **No causal expiry event.** A SWEPT liquidity/sweep is historical and production has no narrative expiry transition. The existing 48-bar association window bounds future qualifying observations, but it is an eligibility window, not a lifecycle state. V1 therefore leaves the last owner ACTIVE until another Narrative takes over; after the sweep falls outside eligibility it is operationally dormant but not explicitly EXPIRED.
2. **Alternation within the existing window.** A and B may reactivate repeatedly while each exact sweep remains association-eligible. V1 intentionally adds no observation-count/time threshold. This is bounded by existing eligibility but can still generate several valid observations.
3. **Intrabar replay precision.** Persisted real-time touched WATCHes retain `firstTouchAt`; clean candle-only replay uses closed-candle fallback. Ordering must be `observedAt` plus stable ID tie-break, and tests must cover same-timestamp events. Narrative identity itself never depends on the timestamp.
4. **Missing legacy provenance.** A persisted legacy WATCH without exact sweep ID cannot safely receive a guessed Narrative ID. It must remain `NARRATIVE_UNRESOLVED` for enrichment while existing delivery behavior continues.
5. **Primary candidate mutation before touch.** A nonterminal WATCH can be rebuilt as its leg evolves. Narrative/Observation classification must use the terminal WATCH snapshot at FIRST_TOUCH, not an earlier formation candidate.
6. **Semantic overreach.** SUPERSEDED is radar ownership only. Presentation and analytics must not translate it to market reversal, invalidation, failure, or winner/loser.

```text
EXISTING_CAUSAL_EXPIRY_AVAILABLE = false
NEW_EXPIRY_THRESHOLD_CREATED = false
```

## 17. Frozen Decisions

| Decision | Frozen V1 result |
|---|---|
| D1 Narrative anchor | Exact stable sweep event ID: accepted |
| D2 Narrative ID | V1 + symbol + timeframe + direction + exactSweepEventId |
| D3 Observation ID | V1 + narrativeId + watchId + primaryNativeFvgId |
| D4 Lifecycle states | ACTIVE, SUPERSEDED |
| D5 Observation types | NEW, CONTINUATION, REACTIVATION |
| D6 Opposite takeover | New/returning observed Narrative supersedes current owner immediately at FIRST_TOUCH |
| D7 Reactivation | Previously SUPERSEDED exact-sweep Narrative retakes ownership with a new Observation |
| D8 Expiry | No V1 EXPIRED state; no new threshold; existing association eligibility only |
| D9 Persistence/replay | Pure reducer reconstructed from existing touched WATCH persistence/candle replay; no separate checkpoint |
| D10 Notification | Type-specific wording; all types remain WATCH and retain existing trigger/dedup |
| D11 Continuation suppression | OUT_OF_SCOPE; continuation remains notify-eligible |
| D12 HTF Bias | Per-observation snapshot; not identity/lifecycle input |
| D13 Structure | Per-observation snapshot; not identity/lifecycle input |
| D14 P6 Follow-through | Separate frozen concept; continuation does not confirm acceptance/follow-through |
| Same-direction new exact sweep | NEW Narrative; supersedes current single radar owner |
| Active cardinality | Maximum one ACTIVE Narrative per symbol/timeframe |

No decision is TBD.

## 18. Implementation Recommendation

```text
READY_FOR_IMPLEMENTATION = YES
```

The production anchor is stable, the target sequences are reproduced from USD-M Futures data, the FIRST_TOUCH boundary resolves pre-notification WATCH formations, and the state machine is deterministic without new market thresholds. Implementation must remain additive and phased; Phase B equivalence must prove unchanged WATCH/FIRST_TOUCH/delivery populations before presentation is enabled.

## Final Acceptance Matrix

```text
PHASE = WATCH_NARRATIVE_IDENTITY_LIFECYCLE_V1
MODE = PRODUCTION_IMPLEMENTATION_REVIEW
IMPLEMENTATION_STARTED = false
PRODUCTION_RUNTIME_CHANGED = false
NARRATIVE_MODEL_DESIGNED = true
NARRATIVE_ANCHOR = exact stable sweep event ID
NARRATIVE_ID_SCHEMA = [V1, symbol, timeframe, direction, exactSweepEventId]
OBSERVATION_ID_SCHEMA = [V1, narrativeId, watchId, primaryNativeFvgId]
LIFECYCLE_STATES = ACTIVE | SUPERSEDED
OBSERVATION_TYPES = NEW | CONTINUATION | REACTIVATION
ACTIVE_NARRATIVE_CARDINALITY = max 1 ACTIVE per symbol + timeframe
OPPOSITE_SIDE_TAKEOVER = current ACTIVE → SUPERSEDED at opposite qualifying FIRST_TOUCH; new/returning Narrative → ACTIVE
REACTIVATION_SUPPORTED = true
REACTIVATION_DEFINITION = known SUPERSEDED exact-sweep Narrative receives a new unique FIRST_TOUCH Observation and retakes ownership
SAME_DIRECTION_NEW_EXACT_SWEEP = NEW Narrative; supersedes current ACTIVE owner
EXISTING_CAUSAL_EXPIRY_AVAILABLE = false
NEW_EXPIRY_THRESHOLD_CREATED = false
BIAS_PART_OF_NARRATIVE_ID = false
STRUCTURE_PART_OF_NARRATIVE_ID = false
DISPLACEMENT_PART_OF_NARRATIVE_ID = false
FVG_PART_OF_NARRATIVE_ID = false
BIAS_SNAPSHOT_PER_OBSERVATION = true
CONTINUATION_NOTIFICATION_SUPPRESSION = OUT_OF_SCOPE
CONTINUATION_EQUALS_FOLLOW_THROUGH = false
WATCH_ELIGIBILITY_CHANGE_PLANNED = false
WATCH_COUNT_CHANGE_PLANNED = false
SWEEP_ALGORITHM_CHANGE_PLANNED = false
LIQUIDITY_LIFECYCLE_CHANGE_PLANNED = false
DISPLACEMENT_CHANGE_PLANNED = false
MSS_CHANGE_PLANNED = false
FVG_CHANGE_PLANNED = false
EQ_V3_CHANGE_PLANNED = false
STANDARD_CAUSAL_SWING_CHANGE_PLANNED = false
REPLAY_RECONSTRUCTABLE = true
RESTART_DETERMINISTIC = true
PREFIX_STABLE = true
ZEC_EXPECTED_SEQUENCE = NEW → CONTINUATION → CONTINUATION
BTC_EXPECTED_SEQUENCE = NEW(A) → NEW(B; A SUPERSEDED) → REACTIVATION(A; B SUPERSEDED) → REACTIVATION(B; A SUPERSEDED)
PRODUCTION_FILES_CHANGED = 0
FULL_REGRESSION = PASS
READY_FOR_IMPLEMENTATION = YES
IMPLEMENTATION_SCOPE = pure narrative reducer + FIRST_TOUCH metadata attachment + replay/restart reconstruction + presentation mapping + invariant tests; no eligibility/detector/dedup changes
HARD_STOP_REACHED = true
```
