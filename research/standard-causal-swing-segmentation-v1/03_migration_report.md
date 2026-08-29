# Migration Report

## Result

`STANDARD_CAUSAL_SWING_SEGMENTATION_V1` is implemented as the default, incremental EQ V3 Swing source. Migration status is `SUCCESS`.

## Production changes

1. `structure/standardCausalSwingSegmentation.js`
   - Implements the frozen Algorithm B semantics incrementally.
   - Owns provisional replacement, strict alternation, causal confirmation, immutable IDs and as-of projection.
2. `config/eqSwingSource.js`
   - Selects exactly one source.
   - Defaults to `STANDARD_CAUSAL_V1`.
   - Provides `RAW_LEGACY` rollback and rejects any combined/unknown value.
3. `replay/replayState.js`
   - Retains raw Swing creation and the main raw liquidity registry.
   - Advances a separate Qualified Swing pool.
   - Routes only the selected pool into Persistent EQ V3.
4. `liquidity/persistentEqualLiquidityV3.js`
   - Accepts an explicit candidate pool and ID resolver.
   - Falls back to the existing main registry for `RAW_LEGACY` and direct fixtures.
   - Does not change classification, grouping, identity, ambiguity, append, lifecycle or reference-price semantics.
5. `liquidity/equalLiquidity.js`
   - Resolves an explicitly proven Qualified Swing confirmation candle index.
   - Does not change Price Gate, Formation Gate or any threshold.

## Preserved paths

- Raw 2L/2R detector: unchanged.
- Existing research Algorithm B implementation: unchanged and not imported by production.
- Raw Swing main registry: retained.
- Structural provenance / MSS: unchanged.
- Raw Sweep and AMD/context: unchanged.
- EQ V3 algorithm and thresholds: unchanged; only the input adapter changed.
- Displacement, FVG, WATCH, Bias, OB and DingTalk presentation: unchanged.
- Narrative Liquidity eligible types remain `EQH/EQL/PDH/PDL/PWH/PWL/PMH/PML`.

## Rollback

Set:

```text
EQ_SWING_SOURCE=RAW_LEGACY
```

The rollback path was exercised on the fixed real replay population. It produced EQ objects whose member IDs were exclusively raw Swing IDs. Standard mode produced EQ objects whose member IDs were exclusively `QS:` IDs. Invalid combined source values are rejected.

```ini
ROLLBACK_AVAILABLE = true
DUAL_SOURCE_MIXING = false
DUAL_SOURCE_MIXING_VIOLATIONS = 0
```

## Semantic equivalence

On the fixed BTCUSDT 5m cache, production Standard segmentation exactly matched the existing Algorithm B tuples:

```text
(side, price, occurredAt, pivotConfirmedAt, qualifiedConfirmedAt)
```

All 326 outputs matched in order with no mismatch. This proves direct reuse of frozen B semantics without label-based tuning or a new Swing threshold.

## Validation

- Dedicated semantic checks: `50/50 PASS`.
- Full repository regression: `PASS`.
- Live-style growing-array feed vs full-array incremental replay: `PASS`.
- Repeated deterministic replay: `PASS`.
- Prefix Qualified Swing projection at four checkpoints: `PASS`.
- Prefix EQ projection at four checkpoints: `PASS`.
