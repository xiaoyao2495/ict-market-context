# Descriptive Population Sanity

These counts are descriptive only. They were not used to tune `k`, compression, alternation, EQ thresholds or any production behavior.

## Fixed real replay

```text
symbol/timeframe: BTCUSDT 5m
closed candles: 2316
window UTC: 2026-08-21 08:10:00 -> 2026-08-29 09:09:59.999
raw 2L/2R pivots: 630
Qualified Swings: 326
Qualified HIGH: 163
Qualified LOW: 163
retention ratio: 326 / 630 = 0.5174603175
EQH clusters: 29
EQL clusters: 27
V3 decision-ledger entries: 82
```

The equal HIGH/LOW counts arise from the frozen strictly alternating sequence in this bounded window. No target count or desired retention ratio was defined.

## Formation-only Qualified Swing examples

### HIGH 1

- Price: `79555.5`
- Raw pivot: `BTCUSDT:5m:SWING_HIGH:1787302500000`
- Occurred: `2026-08-21T08:55:00.000Z`
- Raw 2R confirmed: `2026-08-21T09:09:59.999Z`
- Qualified confirmed: `2026-08-21T09:24:59.999Z`

### HIGH 2

- Price: `78366.1`
- Raw pivot: `BTCUSDT:5m:SWING_HIGH:1787305500000`
- Occurred: `2026-08-21T09:45:00.000Z`
- Raw 2R confirmed: `2026-08-21T09:59:59.999Z`
- Qualified confirmed: `2026-08-21T10:04:59.999Z`

### LOW 1

- Price: `77255.0`
- Raw pivot: `BTCUSDT:5m:SWING_LOW:1787303100000`
- Occurred: `2026-08-21T09:05:00.000Z`
- Raw 2R confirmed: `2026-08-21T09:19:59.999Z`
- Qualified confirmed: `2026-08-21T09:34:59.999Z`

### LOW 2

- Price: `77550.0`
- Raw pivot: `BTCUSDT:5m:SWING_LOW:1787306100000`
- Occurred: `2026-08-21T09:55:00.000Z`
- Raw 2R confirmed: `2026-08-21T10:09:59.999Z`
- Qualified confirmed: `2026-08-21T10:14:59.999Z`

## Formation-only EQ examples

### EQH pair

- Cluster confirmed: `2026-08-21T17:49:59.999Z`
- Reference price: `77676.25`
- Member 1: `77711.1`, occurred `17:05`, Qualified confirmed `17:24:59.999Z`
- Member 2: `77641.4`, occurred `17:30`, Qualified confirmed `17:49:59.999Z`

### EQL pair

- Cluster confirmed: `2026-08-21T10:14:59.999Z`
- Reference price: `77402.5`
- Member 1: `77255.0`, occurred `09:05`, Qualified confirmed `09:34:59.999Z`
- Member 2: `77550.0`, occurred `09:55`, Qualified confirmed `10:14:59.999Z`

All timestamps above are UTC and stop at the relevant formation confirmation. No later Sweep, WATCH, reaction or outcome was consulted.
