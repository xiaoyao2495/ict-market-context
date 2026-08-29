# Dependency Audit

Audit completed before production edits. The migration boundary is only the input adapter between confirmed raw Swing liquidity and Persistent EQ V3.

## Current production chain

1. **Raw pivot producer** — `structure/pivotDetector.js`
   - Incrementally called by `replay/replayState.js::incrementalLiquidity` with fixed `left=2`, `right=2`.
   - Produces local HIGH/LOW pivots with `occurredAt` and 2R `confirmedAt`.
2. **Raw Swing wrapper** — `liquidity/swingLiquidity.js`
   - Converts each confirmed local pivot to legacy `SWING_HIGH` / `SWING_LOW` liquidity.
   - These objects enter the main `liquidityRegistry` and remain shared by raw Sweep, structural provenance, AMD/context, inspection, and scoring consumers.
3. **Current EQ candidate adapter** — `replay/replayState.js::incrementalLiquidity`
   - On V3, directly passes newly added raw Swing liquidity to `persistentEqualLiquidityV3.processCandidates`.
4. **EQ cluster builder** — `liquidity/persistentEqualLiquidityV3.js`
   - Reuses frozen V2 Price/Formation classification.
   - Maintains immutable formation anchor, append ledger, ambiguity handling, active-only append, stable ID, arithmetic reference price, and as-of member projection.
5. **EQ / liquidity registry** — `liquidity/liquidityRegistry.js`
   - Main registry stores raw Swing liquidity and EQ objects with persistent lifecycle.
6. **EQ sweep consumer** — `replay/replayState.js::incrementalEvents` plus `events/sweepEventAdapter.js`
   - Evaluates existing registered liquidity and emits immutable Sweep provenance.
7. **Notification projector** — `notify/sweepContextPresentationV1.js` and `notify/watchNotificationPresentationV1.js`
   - Reads frozen EQ member provenance as-of Sweep; no formation decision ownership.
8. **MSS consumer** — `structure/structuralProvenance5m.js` and `events/mssSignalDetector.js`
   - Continues to consume newly confirmed raw 2L/2R Swing objects returned from `incrementalLiquidity`.
9. **AMD consumer** — `amd/amdState.js` and associated raw Sweep/context paths
   - Continues to observe the existing raw liquidity/event registry.
10. **WATCH consumer** — `stats/displacementWatch.js` via replay/live engines
    - Continues to consume Narrative Liquidity Sweep events and displacement legs; no Swing-source selection logic moves here.

## Migration boundary

```text
UNCHANGED raw path:
Raw 2L/2R -> legacy raw Swing registry -> Structural/MSS/AMD/raw Sweep/context

NEW EQ-only path:
Raw 2L/2R -> Standard Causal Swing Segmentation V1
           -> separate Qualified Swing pool
           -> Persistent EQ V3 candidate adapter
           -> existing EQ registry/lifecycle/Sweep/WATCH/notification
```

Qualified Swings must not be inserted into the main liquidity registry as standalone Swing liquidity. Doing so would create duplicate Sweep/lifecycle/WATCH behavior. Persistent EQ V3 therefore receives an explicit, single-source candidate pool/resolver while EQ objects continue to live in the existing registry.

## Files allowed to change

- New production state machine under `structure/`.
- New source-selection config under `config/`.
- `replay/replayState.js` for state ownership and the EQ-only adapter.
- `liquidity/persistentEqualLiquidityV3.js` only to accept the explicit candidate pool/resolver; cluster semantics remain unchanged.
- Dedicated tests and required research documentation.

## Explicit non-targets

Raw pivot detection, legacy raw Swing registry, structural provenance/MSS, liquidity lifecycle, Sweep adapter, AMD, displacement, FVG, WATCH, Bias, OB, and notification presentation remain unchanged.
