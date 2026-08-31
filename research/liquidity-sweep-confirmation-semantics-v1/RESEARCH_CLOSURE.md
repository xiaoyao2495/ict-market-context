# Liquidity Sweep Research Closure V1

This research line is closed. It does not authorize a production Sweep detector.

- Hypothesis: `TAKEN_FAILED_ACCEPTANCE_V1`
- Dataset: BTCUSDT and ZECUSDT USD-M Futures, 5m, 2026-08-23T06:05:00.000Z through 2026-08-30T06:04:59.999Z; 2,016 continuous candles per symbol
- Review: 40-case strict blind human review; labels were frozen before the answer key was opened

## Frozen human review matrix

| Cohort | GOOD_SWEEP | BORDERLINE | TAKEN_ONLY | NOT_SWEEP |
|---|---:|---:|---:|---:|
| candidate confirmed | 9 | 2 | 7 | 2 |
| candidate not confirmed | 0 | 0 | 9 | 11 |

## Closure decision

`SWEEP_SEMANTICS_NOT_JUSTIFIED`

Failed-acceptance confirmation showed potential exclusion value, but it was not sufficient as a positive Sweep semantic. It may be described only as a `potential exclusion signal`; it is not an approved production Sweep definition.

- `Production LIQUIDITY_TAKEN = SUCCESS`
- `Production binary LIQUIDITY_SWEEP = NOT_JUSTIFIED`
- `NEXT_SWEEP_HYPOTHESIS=NONE`
- `PARAMETER_OPTIMIZATION=false`
- `PRODUCTION_SWEEP_CREATED=false`

No observation-window tuning, penetration, rejection, approach, dwell, score, combined condition, or second Sweep hypothesis is authorized by this research.
