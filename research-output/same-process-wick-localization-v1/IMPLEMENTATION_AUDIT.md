# SAME_PROCESS_WICK_LOCALIZATION_V1 Implementation Audit

## Pre-change production chain

`replay/replayState.js` advances `liquidity/productionEqualLiquidityV1.js`, which advances `liquidity/causalDynamicDHistoricalExtremes.js`. The detector stores the close-selected extreme in its candidate state, freezes theta at that selector candle, and confirms the turn using the existing close reversal. Before this change, `buildPoint` used the selector candle's high/low as canonical `price` and the selector open time as canonical `occurredAt`.

The canonical Dynamic-D point is held in `confirmedPoints`, `recentSurvivalPoints`, and `confirmedPointById`. Its `price`, `occurredAt`, and `occurredBarIndex` are consumed by 36-hour eligibility, pruning, strict-cross invalidation, EQ matching, EQ partner provenance, notification source context, and opposite-side execution target selection. Current Point remains the ordinary causal 2L/2R pivot and is independent.

## Identity and migration

The old point ID embedded selector time and confirmation time. Canonical localization can change both price and occurred time, so new point IDs are explicitly versioned as `DYNDW:SAME_PROCESS_WICK_V1:...`. A separate stable `processId` retains close-process identity and selector provenance is preserved on every point.

The Dynamic-D registry is in-memory and deterministically rebuilt during bootstrap. Persisted EQ-FVG WATCH records retain their frozen `eqSourceContext`; restoration does not rewrite it. Real execution state is stored separately in `real-order-execution-v1.json`, where Entry/SL/TP plans are frozen. No execution state, order, WATCH policy, or runtime state file was changed or cleared.

## Production change

The close detector, 288-return sample standard deviation, square-root-of-12 scale, 0.3% floor, candidate state, theta snapshot, reversal, direction, process count, and confirmation time are unchanged. At confirmation only, the canonical anchor is localized to the most extreme wick in the exact inclusive process segment. Equal wick ties retain the earliest candle, matching the previously validated research implementation.

Research Method B now delegates to the Production localization helper, leaving one implementation as the source of truth.
