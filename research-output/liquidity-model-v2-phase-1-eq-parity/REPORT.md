# LIQUIDITY_MODEL_V2_PHASE_1_EQ_PARITY

Phase 1 of Liquidity Model V2: express the EXISTING Production EQ as a
generic `LiquidityLocationCandidateV2` in a `LiquidityLocationRegistryV2`,
and prove in SHADOW mode that the new representation is behaviourally
identical to current Production EQ.

Frozen semantics: `Location != Liquidity`, `Liquidity Location != Liquidity
Interaction`, `Interaction != Response`. An EQ can only ever mean a
**potential liquidity location**; nothing in this package claims that
liquidity exists, was swept, rejected or taken.

## Repository state

| item | value |
|---|---|
| baseline commit | `158f813fcb59fecd5de819aed167080c36403175` |
| HEAD commit | `158f813fcb59fecd5de819aed167080c36403175` |
| baseline == HEAD | yes |
| modified tracked files vs baseline | 0 |
| untracked additions | 3 V2 modules, 1 test, this research package |

## Data

| item | value |
|---|---|
| cache | `BTCUSDT_5m_20636_20697.json` |
| candles | 17580 |
| non-futures candles | 0 |
| window | 2026-07-02T23:00:00.000Z → 2026-09-01T23:59:59.999Z |

Source purity: every candle is `source: futures` (Binance USDⓈ-M). No
spot-mirror bar enters this population.

## Parity

| metric | value |
|---|---|
| OLD_EQ_COUNT | 281 |
| V2_LOCATION_COUNT | 281 |
| MAPPING_RATE | 100.0000% |
| MISSING | 0 |
| EXTRA | 0 |
| DUPLICATES | 0 |
| REJECTIONS | 0 |

Side cross table (`EQ type / location side`):

- `EQH/BUY_SIDE`: 149
- `EQL/SELL_SIDE`: 132

`BUY_SIDE != LONG` and `SELL_SIDE != SHORT`: a location side describes which
side of the market is suspected of holding resting orders, not a trade
direction. No trade-direction mapping exists in the V2 contract.

## Price band

`priceBand` is a **lossless re-projection** of the tolerance Production EQ
already applied: `5m Wilder ATR14 x thresholds.equalLiquidity.priceStrongMaxATR`
(0.7), recorded per partner as
`eqTolerance`. Band = `[price - eqTolerance, price + eqTolerance]`.

| item | value |
|---|---|
| derivation | `PRODUCTION_EQ_TOLERANCE_LOSSLESS_PROJECTION` |
| with band | 281 |
| without band | 0 |
| band mismatches | 0 |

`NO_THRESHOLD_RETUNING`: the adapter reads no `config/` module at all and
introduces no numeric tolerance. Where a source carried no single positive
tolerance the band is `null` rather than invented.

## Causality

| check | value |
|---|---|
| candidate violations | 0 |
| provenance violations | 0 |
| not-yet-confirmed | 0 |
| PREFIX_PARITY | PASS |
| FUTURE_LEAK | false |

Every candidate satisfies `occurredAt <= confirmedAt <= evaluationTime` at the
bar the EQ was actually emitted on, and every frozen provenance entry
(`currentPoint` + all `historicalPartners`) satisfies the same bound. Truncating
history to 10548 bars reproduces the identical
ordered observation set and the identical candidate set, and appending 300
synthetic FUTURE candles changes no candidate.

### Why the raw production EQ cannot be byte-compared across runs

A production EQ object is a long-lived **mutable** lifecycle object: later bars
mutate `status` / `touchedAt` / `sweptAt` / `brokenAt` on that very object via
`liquidityRegistry.applyLifecycleEvent`. Those fields are future-dependent by
design, so they legitimately differ between a truncated and a full replay:

| run pair | observations with divergent mutable state |
|---|---|
| prefix vs full (171 shared observations) | 7 |
| full+future vs full (281 shared observations) | 0 |

Prefix parity is therefore asserted on (a) the ordered observation identities,
(b) the **immutable detector-decided core** (type, side, price, `occurredAt`,
`confirmedAt`, `currentPivot`, all `historicalPartners`, tolerance metadata) and
(c) the V2 candidate list — and the mutable lifecycle divergence is reported
rather than hidden. This is precisely the property Phase 1 needs: the V2
candidate is an immutable point-in-time projection and deliberately carries no
lifecycle state, so it is invariant to history truncation and to appended
future data, while the production EQ object is not (and must not be).

Turning Significance is **not** consumed: it is an upstream eligibility FILTER
and is neither re-derived nor mapped onto a liquidity semantic. A `VALID` turning
point must never become `SIGNIFICANT` liquidity.

## Production untouched

| question | answer |
|---|---|
| production behavior changed? | no |
| production consumers migrated? | no |
| LLM calls made by this audit | 0 |
| new thresholds | 0 |
| production files byte-identical to baseline | 24 / 24 |
| shadow perturbation of production EQ | none (byte-identical) |

The three V2 modules are required by no production consumer. Production
continues to consume the existing EQ objects unchanged.

## Checks

| check | result | detail |
|---|---|---|
| EQ_TO_LOCATION_MAPPING_100_PERCENT | PASS | emitted=281 adapted=281 rejected=0 |
| MISSING_ZERO | PASS | missing=0 |
| EXTRA_ZERO | PASS | extra=0 |
| DUPLICATES_ZERO | PASS | duplicates=0 registryDuplicates=0 |
| IDENTITY_PARITY | PASS | idMismatch=0 provenanceMismatch=0 |
| SIDE_MAPPING_PARITY | PASS | sideMismatch=0 |
| REFERENCE_PRICE_PARITY | PASS | priceMismatch=0 |
| OCCURRED_AT_PARITY | PASS | occurredAtMismatch=0 |
| CONFIRMED_AT_PARITY | PASS | confirmedAtMismatch=0 |
| HISTORICAL_PARTNER_PARITY | PASS | partnerMismatch=0 |
| CURRENT_POINT_PARITY | PASS | currentPointMismatch=0 |
| PROVENANCE_PARITY | PASS | provenanceMismatch=0 |
| ORDERING_PARITY | PASS | orderingMismatch=0 |
| PRICE_BAND_LOSSLESS_PROJECTION | PASS | bandMismatch=0; derivation=PRODUCTION_EQ_TOLERANCE_LOSSLESS_PROJECTION |
| CAUSALITY_PASS | PASS | candidateViolations=0 provenanceViolations=0 |
| PREFIX_PARITY_PASS | PASS | identityOrder=true immutableCore=true candidatesByteIdentical=true prefixBars=10548 prefixEq=171 mutableLifecycleDivergence=7 (expected) |
| FUTURE_LEAK_FALSE | PASS | identityOrder=true immutableCore=true candidatesUnchanged=true appendedBars=300 mutableLifecycleDivergence=0 (expected) |
| OUTCOME_CONTAMINATION_FALSE | PASS | forbiddenKeys=0 |
| NEW_LLM_CALLS_ZERO | PASS | llmCalls=0 semanticModulesLoaded=0 |
| NEW_THRESHOLDS_ZERO | PASS | adapterConfigDependencies=0 |
| SHADOW_DOES_NOT_PERTURB_PRODUCTION | PASS | eqByteIdentical=true shadowRegistered=281 |
| SHADOW_INGEST_SUCCEEDED | PASS | {"considered":281,"adapted":281,"rejected":0,"registered":281,"duplicates":0,"failed":false} |
| PRODUCTION_BEHAVIOR_CHANGED_FALSE | PASS | modifiedTrackedFiles=0 |
| PRODUCTION_CONSUMERS_MIGRATED_FALSE | PASS | no production consumer requires any V2 module (verified below) |
| DATA_SOURCE_PURITY | PASS | nonFuturesCandles=0 candles=17580 |
| REGISTRY_RESTART_SAFE | PASS | toJSON/fromJSON round-trip preserves size, order and content |
| FROZEN_CONSTANTS_UNCHANGED | PASS | all match |

## Verdict

`AUDIT=PASS`

`READY_FOR_LIQUIDITY_INTERACTION_FACTS_V1=true`
