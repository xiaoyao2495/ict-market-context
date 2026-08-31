# Liquidity Taken Event Production Cutover V1

Status: `PRODUCTION_CUTOVER_COMPLETE`

The Liquidity domain now emits `LIQUIDITY_TAKEN` directly from the first strict trade-through of a causally pre-bar-available Narrative Liquidity V1 identity. Existing `LIQUIDITY_SWEEP`, lifecycle, and all downstream consumers remain unchanged.

Implementation shape:

```text
existing per-candle liquidity pass
  -> pre-mutation strict Taken snapshot -> unified Event Registry
  -> unchanged lifecycle evaluation -> unchanged Sweep emission
```

Eligible types are exactly EQH, EQL, PDH, PDL, PWH, PWL, PMH, and PML. Raw Swing liquidity is excluded by a positive allowlist. No score, primary, grouping, new engine, new lifecycle state, or downstream association was added.

The deterministic audit fixture emitted 8 Taken events: 4 shared the same interaction with an existing eligible Sweep and 4 were objective strict crossings without Sweep. This is a semantic fixture only, not an outcome or optimization population.
