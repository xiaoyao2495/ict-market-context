# Production EQ: ATR50 36H unviolated cross-source V1

The production EQH/EQL definition is a point-in-time observation created when
a newly confirmed ordinary causal 2/2 pivot matches at least one prior causal
ATR50 ZigZag point on the same side.

The historical endpoint must have occurred before the current pivot, be
confirmed by the current pivot's confirmation time, fall inside the inclusive
preceding 432 5m bars (36H), and remain unviolated strictly before the current
pivot candle. A HIGH is violated only by `high > historicalPrice`; a LOW only
by `low < historicalPrice`. Equality is a touch, not a violation. A trade-through
on the current pivot candle is recorded on the pair but does not invalidate that
pair retroactively.

ATR50 uses `0.50 ×` the latest causally available completed 4H Wilder ATR(14).
Its ZigZag state is incremental, time-varying, warmed before the relationship
window, and is never reset at the 36H boundary.

Pairwise equality reuses the frozen production tolerance: current 5m Wilder
ATR(14) multiplied by `0.7`. Every matching historical partner is retained;
there is no ranking or primary partner. One current 2/2 emits at most one EQ
liquidity item, whose price is the current 2/2 price.

The EQ item is registered as Narrative Liquidity and continues through the
existing Liquidity Taken and Sweep consumers without changing either consumer's
semantics. Provenance reports:

```text
current=ORDINARY_CAUSAL_2X2
historical=CAUSAL_ATR50_ZIGZAG
lookback=36H
partners=N
unviolated=true
```

The former V2/V3 `2/2 ↔ 2/2` producer and V3 persistent cluster model are
deprecated for production. Production does not create or update persistent EQ
identity, cluster membership, mean price, member evolution, or cluster lifecycle.
The historical modules and audit artifacts may remain in the repository, but
the live and replay runtime do not import them.

```ini
PRODUCTION_EQ_MODEL=CURRENT_2X2_VS_PRIOR_36H_UNVIOLATED_ATR50_ZIGZAG
DEPRECATED_EQ_V3_FOR_PRODUCTION=true
EQ_EVENT_IS_POINT_IN_TIME_OBSERVATION=true
EQ_PERSISTENT_IDENTITY=false
```
