# Standard Causal Swing Segmentation V1 — Production Definition

## Semantic scope

A **Qualified Swing is an engineering, scale-dependent causal swing definition** used to supply Persistent EQ V3 with a stable alternating comparison population. It is **not** claimed to be the unique “true”, “independent”, hierarchical, or structural market swing.

The frozen production pipeline is:

```text
confirmed raw 2L/2R pivot
-> provisional same-side extreme compression
-> existing close-based Algorithm B directional-change confirmation (ATR 14, k=1.0)
-> immutable alternating Qualified Swing
-> Persistent EQ V3
```

No human KEEP/DROP label, outcome, future reaction, prominence, departure efficiency, nested DC, hierarchy, role maturation, or composite score participates in this definition.

## Inputs and confirmation

- Input is the existing closed-candle raw 2L/2R pivot stream.
- Raw pivot detection and its `left=2/right=2` confirmation remain unchanged.
- Algorithm B retains Wilder ATR(14), close-based reversal distance, and `k=1.0`.
- A provisional HIGH confirms only after a closed candle is at least `1.0 * ATR(14)` below its price.
- A provisional LOW confirms symmetrically after a closed candle is at least `1.0 * ATR(14)` above its price.
- The reversal is confirmation evidence only; no post-confirmation outcome is used.

## Provisional compression and immutable identity

- Before qualification, a later same-side HIGH replaces the candidate only if its price is strictly higher.
- Before qualification, a later same-side LOW replaces the candidate only if its price is strictly lower.
- Equal-price candidates retain the earlier raw pivot deterministically.
- Replacement is allowed only while the candidate is provisional.
- After qualification, ID, price, source raw pivot and all confirmation timestamps are immutable.
- Qualified output is strictly alternating HIGH/LOW. Same-side raw pivots may continue to exist in the raw registry but cannot bypass the alternating EQ source.

## Temporal contract

Every Qualified Swing preserves three distinct times:

```text
occurredAt <= pivotConfirmedAt <= qualifiedConfirmedAt
```

- `occurredAt`: raw pivot candle open time.
- `pivotConfirmedAt`: existing 2R confirmation close time.
- `qualifiedConfirmedAt`: directional-change confirmation candle close time.
- `confirmedAt` and `createdAt`: equal to `qualifiedConfirmedAt` for downstream as-of compatibility.
- No Qualified Swing is visible to EQ V3 before `qualifiedConfirmedAt`.

## Identity and fields

Canonical Qualified Swing ID:

```text
QS:<symbol>:<timeframe>:<HIGH|LOW>:[<sourceRawPivotId>]
```

Allowed semantics are side/type, price, temporal provenance, raw source provenance, confirmation reason/state and the frozen Algorithm B parameters. Advanced importance, independence, hierarchy, structural or departure scores/classes are intentionally absent.

## Registry and consumer boundary

Qualified Swings live in a separate EQ-only pool and are not inserted as standalone liquidity into the main registry. This prevents duplicate raw Sweep, lifecycle, AMD, MSS or WATCH effects.

Persistent EQ V3 receives exactly one source selected by `EQ_SWING_SOURCE`:

- `STANDARD_CAUSAL_V1` — default production source.
- `RAW_LEGACY` — explicit short-term rollback.

The two pools are never combined. EQ clusters continue to be stored in the existing production liquidity registry and retain their existing Price Gate, Formation Gate, grouping, identity, ambiguity, lifecycle, Sweep, WATCH and notification semantics.

## Non-target production paths

Raw 2L/2R pivots and legacy Swing liquidity remain available without change to structural provenance, MSS, raw Sweep, AMD/context and inspection consumers. Displacement, FVG, WATCH, Bias, OB and notification presentation are outside this migration and unchanged.
