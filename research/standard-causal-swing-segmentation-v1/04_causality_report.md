# Causality and Determinism Report

## Evaluated population

- Symbol/timeframe: BTCUSDT 5m.
- Closed candles: 2,316.
- Window: `2026-08-21T08:10:00.000Z` through `2026-08-29T09:09:59.999Z`.
- Execution: one candle / one incremental update.

## Formation-time discipline

For every emitted Qualified Swing:

```text
occurredAt <= pivotConfirmedAt <= qualifiedConfirmedAt
```

The segmentation state consumes only raw pivots already confirmed on the current closed candle and the current/past candle path. Visibility begins exactly at `qualifiedConfirmedAt`; projection one millisecond earlier excludes the Swing. A confirmed Qualified Swing is never replaced or repainted by a later same-side extreme.

## Prefix checks

Independent prefix replays were compared against the corresponding as-of projection of the full incremental replay at candle indexes:

```text
500, 1000, 1500, 2315
```

Both layers matched at every checkpoint:

- Qualified Swing identity/order/timestamps/source: 0 violations.
- EQ V3 cluster identity and visible member IDs: 0 violations.

No second production source was introduced at any checkpoint.

## Determinism and live equivalence

- Two repeated full incremental replays produced identical Qualified Swing projections and EQ projections.
- A live-style feed where the visible candle array grows one closed candle at a time matched the replay supplied with the complete array.
- Equal-price provisional ties retain the earlier raw pivot deterministically.
- Canonical Qualified Swing IDs derive only from symbol, timeframe, side and immutable raw pivot ID.

## Results

```ini
PREFIX_CHECKPOINTS = 4
QUALIFIED_SWING_PREFIX_VIOLATIONS = 0
EQ_PREFIX_VIOLATIONS = 0
TEMPORAL_ORDER_VIOLATIONS = 0
FUTURE_VISIBILITY_VIOLATIONS = 0
CONFIRMED_IDENTITY_MUTATION_VIOLATIONS = 0
QUALIFIED_SWING_ALTERNATION_VIOLATIONS = 0
DETERMINISM_VIOLATIONS = 0
DUAL_SOURCE_MIXING_VIOLATIONS = 0
LIVE_REPLAY_EQUIVALENCE = PASS
OUTCOME_USED = false
FUTURE_REACTION_USED = false
```
