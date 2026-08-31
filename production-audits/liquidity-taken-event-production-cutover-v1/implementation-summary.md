# Implementation Summary

## Production changes

- Added `events/liquidityTakenEventAdapter.js`: explicit eight-type allowlist, pre-bar availability check, strict trade-through predicate, interaction-time EQ projection, immutable unified event builder.
- Updated `replay/replayState.js::incrementalEvents`: register first Taken before applying the current candle's lifecycle mutation; return additive `taken` events; preserve the legacy lifecycle/Sweep block byte-for-byte in behavior.
- Updated the event registry documentation to list `LIQUIDITY_TAKEN`; registry behavior itself is unchanged.

## Test changes

- Added `test/liquidityTakenEvent.test.js` with strict BSL/SSL, equality, reclaim independence, same-bar backfill, first-event dedupe, same-price distinct identity, multi-level, EQ snapshot, restart, prefix, allowlist, raw Swing exclusion, minimum increment, closed-bar, ordering, and visibility coverage.

## Deterministic ordering

For one registry identity on one candle, `LIQUIDITY_TAKEN` is inserted before a possible legacy `LIQUIDITY_SWEEP`. Identities retain existing liquidity registry order. Eligibility is computed before lifecycle mutation, so ordering cannot change the factual Taken result.

## Restart

No new persistence subsystem exists. Live restart already rebuilds state by deterministic candle replay. The unified Event Registry is the first-Taken ledger; a runtime-only set is derived from it once and advanced with registered events so subsequent crossings are ignored without rescanning the full event stream each candle.
