# EQH/EQL V3 Production Migration + EQ Member Notification Provenance V1

## Decision

Production now selects exactly one EQ producer. `EQ_PRODUCTION_VERSION` defaults to `V3`; `V2` remains available only as an emergency rollback. No dual registration path exists.

The migration replaces EQ formation, grouping, membership, and identity only. Pivot 2/2, ATR14, Price/Formation thresholds, Liquidity Registry semantics, lifecycle, Sweep, AMD, Displacement, FVG, WATCH selection, and notification trigger behavior are unchanged. Structural Retirement remains disabled.

## Production chain

```text
confirmed 2/2 Swing
  -> Persistent EQH/EQL V3 producer
  -> existing Liquidity Registry
  -> existing lifecycle
  -> existing Sweep adapter
  -> existing liquidityTaken candidate
  -> existing WATCH
  -> existing FVG FIRST_TOUCH notification
```

The V3 object retains downstream type `EQH` / `EQL` and adds `metadata.eqModelVersion = "V3"`. Its public identity is formation-time immutable and collision-safe. Later members update only the member ledger, `lastMemberConfirmedAt`, and the arithmetic-mean current reference price.

## Temporal notification contract

`EQ_MEMBER_PRESENTATION_AS_OF` is the source EQ Sweep's `confirmedAt`. At Sweep creation, the adapter freezes both the visible member list and `referencePriceAsOfSweep` in `source.eqMemberProvenance`. `liquidityTaken` copies that immutable evidence into the WATCH candidate. The DingTalk formatter reads the candidate snapshot; it never queries the current Registry to reconstruct the historical EQ.

This prevents a member appended after a historical Sweep from appearing in a later FVG FIRST_TOUCH notification and prevents future reference-price updates from rewriting the historical Sweep level.

## Fixed local acceptance

- Symbol/timeframe: BTCUSDT 5m
- Input: existing local bounded dataset; no network access
- Warmup: 576 closed bars
- Validation: 8,640 closed bars (30D)
- V2 baseline and V3 candidate each used a single production-like replay

Counts are recorded in `summary.json`. V3 count changes are expected consequences of persistent identity/member grouping and are not treated as regression.

## Persistence and migration

Live does not deserialize a persisted Liquidity Registry. It deterministically rebuilds Registry state from persisted closed candles on every bootstrap. The cursor now records `eqProductionVersion`, and startup logs a version transition. Existing terminal WATCH objects remain frozen. A non-terminal WATCH is keyed by displacement leg identity, so a V3 bootstrap update replaces the same WATCH ID instead of creating a second V2/V3 WATCH.

No V2 EQ state is converted into V3. New Registry detection uses exactly one selected producer.

## Frozen human evidence

The accepted blind-ish comparison remains unchanged: V3 better 15, V2 better 2, equal 11, both bad 12. No new human review or parameter tuning was performed.

## Result

```ini
V3_REGISTRY_INTEGRATION = PASS
V3_LIFECYCLE_INTEGRATION = PASS
V3_SWEEP_INTEGRATION = PASS
V3_WATCH_INTEGRATION = PASS
V3_PERSISTENCE_RESTART = PASS
EQ_MEMBER_NOTIFICATION_PROVENANCE = PASS

PRODUCTION_EQ_VERSION = V3
V2_PRODUCTION_ACTIVE = false
V2_CODE_RETAINED_FOR_ROLLBACK = true
PRODUCTION_EQ_SOURCE_COUNT = 1

STRUCTURAL_RETIREMENT_ENABLED = false
SWEEP_SEMANTICS_CHANGED = false
WATCH_ALGORITHM_CHANGED = false
AMD_ALGORITHM_CHANGED = false
FVG_CHANGED = false
```
