# EQH/EQL Persistent Cluster Identity Design V3

## Result

**PASS — design contract ready for a bounded shadow implementation, not ready for production implementation.**

The recommended architecture is:

```text
immutable two-member cluster identity
        +
append-only timestamped member ledger
        +
incremental current-state projector
        +
independent as-of projector for verification
```

This design changes no production file, threshold, detector, lifecycle, Sweep, WATCH, AMD, or notification behavior.

## Core contract

The first qualified pair creates one stable cluster. Its earliest initial Swing is the immutable `formationAnchor`; its `id`, `createdAt`, and `confirmedAt` never change.

For every later confirmed same-side Swing:

1. Project the existing cluster lifecycle through the candidate `confirmedAt` using closed candles.
2. Consider only `ACTIVE` clusters.
3. Test the candidate directly against each cluster's immutable formation anchor.
4. Apply the unchanged Price Gate and Formation Independence contract.
5. Exactly one compatible cluster means append once.
6. More than one compatible cluster means `AMBIGUOUS_UNASSIGNED`; do not append and do not create a third overlapping cluster.
7. No compatible active cluster means the unchanged two-member creation path may run on eligible, actively unassigned Swing primitives.

Every appended member must be directly valid against the immutable anchor. A valid `A-B` and `B-C` relationship cannot add C to an A-anchored cluster when `A-C` is invalid. Therefore chain expansion remains bounded without a new threshold.

## Frozen gates

```text
distanceATR = abs(anchorPrice - candidatePrice)
              / ATR14(candidate confirmedAt)

VALID_EQ:       distanceATR <= 0.7
BORDERLINE_EQ:  0.7 < distanceATR <= 1.1
REJECT_EQ:      distanceATR > 1.1

Formation:
departureATR >= 1.75
AND maxConsecutiveBarsOutsideZone_0_5ATR >= 1
```

`BORDERLINE_EQ` never appends. `barsApart` remains diagnostic only. No tick, percentage, score, MTF, volume, or time-decay feature is introduced.

## Identity and reference price

- Cluster id remains the current first-formation identity and is immutable after append.
- `confirmedAt` is the first time the cluster reaches two qualified members.
- `lastMemberConfirmedAt` records the newest visible member confirmation.
- `memberAddedAt` controls as-of visibility.
- `referencePrice` remains the arithmetic mean of members visible at the requested time.
- The moving mean is never used as the append gate; the immutable anchor prevents mean-driven eligibility drift.
- A changed mean becomes effective only at the new `memberAddedAt`. Past lifecycle and reference state are never recomputed.

## Lifecycle boundary

| State | Append | Contract |
|---|---:|---|
| `ACTIVE` | Yes | Candidate must pass every frozen gate |
| `TOUCHED` | No | Conservative V3 identity boundary |
| `SWEPT` | No | Never reopen the consumed cluster |
| `BROKEN` | No | Never append or reopen |

After a terminal cluster, two newly confirmed qualified Swings may form a new identity. The old cluster and its historical members remain intact. This is historical sequential recurrence, not simultaneous active overlap.

## Architecture comparison

- Mutable object: fastest to implement, but future members can leak through old object references.
- Immutable cluster plus member append ledger: strong identity, temporal safety, determinism, and incremental runtime compatibility. **Recommended.**
- Full as-of recomputation from ledger: correct as an independent verifier, but unnecessary as the primary per-bar runtime path.

No general-purpose event-sourcing redesign is required. The minimum is one immutable base record, immutable member append records, an active-membership index, and a projector.

## Direct answers

### Q1. EQ Cluster V3 最小 schema 是什么？

Stable identity fields; immutable formation anchor, `createdAt`, and `confirmedAt`; timestamped append-only members; derived `referencePrice`, `memberCount`, `lastMemberConfirmedAt`; and the unchanged lifecycle state.

### Q2. 如何从 2-member 演进为 3/4/5-member？

The initial qualified pair creates the cluster. Each new Swing appends only if it is confirmed, same-side, unassigned, the cluster is ACTIVE, and the anchor-to-candidate pair is `VALID_EQ` under the frozen Price and Formation gates.

### Q3. 如何保持 stable EQ ID？

Use the original formation id permanently. Append records reference that id; they never replace or rename it.

### Q4. 如何防止同一个 Swing 进入多个 active EQ？

Use an atomic `side + canonicalSwingId → activeClusterId` membership index. Both initial creation and append must reserve every member exactly once.

### Q5. 同时匹配多个 clusters 时采用什么 policy？

`AMBIGUOUS_UNASSIGNED`. Append to none and create no third cluster. This avoids inventing recency, distance, or importance ranking.

### Q6. 如何保留 bounded-anchor？

All appended members must directly pass against the immutable original formation anchor. Member-to-member transitive validity is irrelevant.

### Q7. reference mean 更新时如何避免 gate 漂移？

Continue using the arithmetic mean as the liquidity reference, but use immutable `formationAnchor.price` for every append gate.

### Q8. confirmedAt 如何保持 immutable？

It is frozen at initial two-member formation. Appends only advance `lastMemberConfirmedAt` and `memberAddedAt`.

### Q9. 如何防止过去查询看到未来 member？

As-of projection includes only members where both `confirmedAt` and `memberAddedAt` are at or before `evaluationTime`.

### Q10. 哪些 lifecycle state 允许 append？

Only `ACTIVE`. `TOUCHED`, `SWEPT`, and `BROKEN` do not append. Terminal identities never reopen.

### Q11. 如何区分 simultaneous overlap 与 sequential reuse？

Simultaneous overlap means two ACTIVE clusters share one canonical Swing at the same checkpoint. Sequential reuse means a new cluster formed from new Swing identities after an earlier cluster became terminal.

### Q12. 哪些 V2 逻辑保持不动？

Pivot 2/2, closed-candle and confirmedAt discipline, new-cluster lifecycle eligibility, ATR14 Price Gate, Formation Independence, bounded-anchor intent, arithmetic mean reference, lifecycle, Sweep, WATCH identity, AMD, and notification.

### Q13. 哪些问题推迟？

Member-extrema/partial-taken lifecycle, cluster-envelope Sweep, TOUCHED append policy research, merge/split, quality ranking, MTF, volume, OI, order book, and all threshold tuning.

## Shadow readiness

No incomplete population simulation was presented as evidence. The existing frozen event stream contains retained V2 objects, not the complete qualified anchor-to-new-member ledger required for an honest V3 projection. The next authorized step may implement this contract in bounded shadow and measure simultaneous active overlap; production remains blocked.

## Acceptance

```ini
EQH_EQL_PERSISTENT_CLUSTER_IDENTITY_DESIGN_V3 = PASS

PERSISTENT_CLUSTER_CONTRACT_READY = true
MEMBER_APPEND_CONTRACT_READY = true
ACTIVE_MEMBER_EXCLUSIVITY_READY = true
STABLE_CLUSTER_ID_READY = true
BOUNDED_ANCHOR_SEMANTICS_PRESERVED = true

REFERENCE_PRICE_FORMULA_CHANGED = false
PRICE_GATE_CHANGED = false
FORMATION_INDEPENDENCE_CHANGED = false
PIVOT_CHANGED = false
SWING_DETECTOR_CHANGED = false
LIFECYCLE_CHANGED = false
SWEEP_CHANGED = false
WATCH_CHANGED = false
AMD_CHANGED = false
NOTIFICATION_CHANGED = false

OUTCOME_USED = false
THRESHOLD_OPTIMIZATION_RUN = false
NETWORK_REQUESTS_RUN = false
PRODUCTION_CHANGED = false

READY_FOR_EQH_EQL_PERSISTENT_CLUSTER_SHADOW = true
READY_FOR_EQH_EQL_V3_PRODUCTION_IMPLEMENTATION = false
HARD_STOP_REACHED = true
```
