# Displacement MSS Direction Linkage Fix V1

Status: **PASS**

## Fixed scope

- Same-candle MSS provenance now links only an MSS whose direction equals the displacement direction.
- Detection scoring still uses the frozen any-same-bar-MSS bonus; displacement existence is unchanged.
- Notification summary now derives MSS wording from raw `watch.mss.direction`.

## Bounded acceptance

- BTCUSDT 5m closed candles: 8640
- Window: 2026-07-27T09:20:00.000Z → 2026-08-26T09:19:59.999Z
- Runtime: before 29.878s / after 29.640s

## Population before → after

- TOTAL_WATCH: 1377 → 1377
- WATCH_WITH_MSS: 838 → 704
- MATCH: 694 → 704
- MISMATCH: 144 → 0
- LONG_WITH_BEARISH_MSS: 63 → 0
- SHORT_WITH_BULLISH_MSS: 81 → 0
- MSS exists=false: 539 → 673
- Opposite MSS → exists=false: 134
- Opposite MSS → same-direction MSS (mixed same-bar case): 10

## Behavior equivalence

- Displacements: 2337 → 2337; ID/direction/timing hash unchanged.
- WATCH: 1377 → 1377; IDs, timing, direction and transitions unchanged.
- Sweeps unchanged: true
- FVG IDs/geometry/lifecycle semantics unchanged: true
- Notification triggers unchanged: true

The raw FVG object hash changed only because it embeds displacement `mssEventId`; linkage-stripped FVG semantics and IDs are byte-identical.

## Target

- WATCH:BTCUSDT:BULLISH:LEG:BTCUSDT:5m:DISPLACEMENT:BULLISH:1787734800000
- Before: linked BEARISH MSS `BTCUSDT:5m:MSS:BEARISH:BTCUSDT:5m:SWING_LOW:1787731500000`.
- After: `mssEventId=null`, WATCH `mss.exists=false`.

## Tests

- Targeted acceptance: 20/20
- Relevant regression: PASS
- Full `npm test`: PASS
- FUTURE_LEAK_VIOLATIONS = 0

HARD STOP.
