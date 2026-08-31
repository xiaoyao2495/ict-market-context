# Liquidity Sweep Confirmation Semantics V1

Research-only, Liquidity-domain-only diagnostic. No production detector or runtime state is added.

## Frozen hypothesis

`TAKEN_FAILED_ACCEPTANCE_V1`: start from the production `LIQUIDITY_TAKEN` event and observe the immutable Taken price for bars 0..12. For BSL, the first closed candle with `close < frozenLiquidityPrice` is the research-only candidate confirmation. For SSL, it is the first closed candle with `close > frozenLiquidityPrice`. Twelve bars is only the fixed observation horizon, not a proposed production threshold.

The prior negative findings remain frozen: same-bar reclaim, delayed reclaim, penetration, and reclaim alone were not sufficient. This round does not rerun or tune them; its unit is the production Taken event followed through one causal sequence.

## Frozen data and sample

The exact prior seven-day BTCUSDT/ZECUSDT futures 5m fixtures are reused. Each symbol has 2,016 continuous candles. Population: 123 mature production Taken events; blind review: 40 cases, deterministically split 20 candidate-confirmed and 20 unconfirmed controls using seed `LIQUIDITY_SWEEP_CONFIRMATION_SEMANTICS_V1|TAKEN_FAILED_ACCEPTANCE_V1|b4d4222`.

## Human review

The blind package contains no mechanical classification or confirmation timing. Human labels are limited to `GOOD_SWEEP`, `BORDERLINE`, `TAKEN_ONLY`, and `NOT_SWEEP`. Human labels must be frozen before the separately packaged answer key is decoded.

## Frozen post-review decision rule

After human labels are frozen and the answer key is decoded, compare candidateConfirmed=true with candidateConfirmed=false across the four labels. A production Sweep semantic may proceed only if the confirmed group clearly concentrates GOOD_SWEEP; the unconfirmed group contains materially more TAKEN_ONLY/NOT_SWEEP; the relationship is not obviously driven by one symbol, side, or liquidity type; obvious counterexamples are uncommon; and the semantic remains simple and explainable. Mixed or ambiguous results mean `SWEEP_SEMANTICS_NOT_JUSTIFIED` and a hard stop. No numeric pass threshold, parameter tuning, or replacement hypothesis is permitted in this round.

Pre-review verdict: `READY_FOR_STRICT_BLIND_HUMAN_REVIEW`.
