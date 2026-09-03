# PRODUCTION_HISTORICAL_EXTREME_CC_DYNAMIC_D_V1 — Implementation Summary

**Task:** Replace the Production EQ historical anchor's ATR50 Causal ZigZag V2
with the CLOSE-based Dynamic D lifecycle (CC arm: **CLOSE extreme + CLOSE
reversal**) as the historical-anchor source for the Production Equal-Liquidity
pipeline.

**Commit:** `feat: replace ZigZag anchors with causal Dynamic D lifecycle`
**Branch:** `main` → `origin/main`
**Date:** 2026-09-03

---

## 0. Governance (spec-mandated, frozen)

| Gate | Value |
|---|---|
| `FULL_REPLACEMENT` | `true` |
| `BACKWARD_COMPATIBILITY` | `false` |
| `FEATURE_FLAG` | `false` |
| `DUAL_PATH` | `false` |
| `FALLBACK_TO_ZIGZAG` | `false` |
| `LEGACY_ZIGZAG_OUTPUT_COMPATIBILITY` | `false` |

The legacy module `liquidity/atr50CausalZigZag.js` and its test
`test/atr50CausalZigZagHighLowV2.test.js` were **physically deleted** (`git rm`).
No dual path, no feature flag, no fallback.

---

## 1. What changed (production)

| File | Change |
|---|---|
| `liquidity/causalDynamicDHistoricalExtremes.js` | **NEW** — CC CLOSE-based Dynamic D detector + anchor lifecycle. Pure 5m close-to-close log returns. Zero external `require`s. |
| `liquidity/productionEqualLiquidityV1.js` | Rewired to consume `state.dynamicD.recentSurvivalPoints`; `evaluatePivot` applies **age-expiry → strict-cross → tolerance** in that order; EQ comparison uses `point.price` (wick), never `selectorPrice` (close). |
| `liquidity/productionEqProvenance.js` | `MODEL = 'DYNAMIC_D_36H_CROSS_SOURCE_V1'`; `HISTORICAL_SOURCE = 'CAUSAL_DYNAMIC_D_V1'`. |
| `notify/watchNotificationPresentationV1.js` | `EQ_PARTNER_SOURCE_LABEL` now maps `CAUSAL_DYNAMIC_D_V1` → `'Dynamic D 历史配对'`; old `CAUSAL_ATR50_ZIGZAG` label removed. |

### Deleted
- `liquidity/atr50CausalZigZag.js`
- `test/atr50CausalZigZagHighLowV2.test.js`

---

## 2. Design invariants (carried from research, frozen)

- **Detection selector = CLOSE.** Extreme and reversal are both decided by
  `candle.close` (CC arm).
- **Business price = WICK.** After confirmation, the stored `price` is the REAL
  wick of the selected candle (`HIGH → candle.high`, `LOW → candle.low`).
  `selectorPrice` (close) is stored but **never** used for EQ comparison or
  invalidation.
- **Volatility-adaptive theta:** `θ_t = max(THETA_FLOOR, σ1h_t · K)`,
  `σ1h_t = σ5m_t · √12`, `σ5m_t` = sample stddev (ddof=1) of trailing 288
  completed 5m log-returns. `THETA_FLOOR = 0.003`.
- **SAME-CANDLE RULE:** a candle forming a new extreme never also confirms a
  reversal on that same candle (no look-ahead ambiguity).
- **Lifecycle ACTIVE → INACTIVE (terminal):** invalidation comes from an
  ordinary causal 2/2 strict cross (wick-to-wick), `AGE_EXPIRY` (5 calendar days
  after `confirmedAt`, which precedes EQ pairing), and **NO RETROACTIVE REWRITE**
  — once `INACTIVE`, never revives.
- **Frozen constants:** `LOOKBACK=288`, `K=1.0`, `THETA_FLOOR=0.003`,
  `SQRT12=√12`, `LOOKBACK_BARS=432`, `FIVE_DAYS_MS=432000000`.
- **Data-source purity:** production logic consumes Binance USDⓈ-M Futures 5m
  only; no 4H ATR, no HTF candle, no Parkinson/Rogers-Satchell/GARCH/CWT/
  Prominence (forbidden list preserved verbatim in the module header).

---

## 3. Test suite

- **New targeted suite:** `test/productionHistoricalExtremeDynamicDV1.test.js`
  — 63 tests covering §28–§32 (detection, volatility snapshot semantics,
  lifecycle, eligibility window, EQ integration, causality, determinism).
- **Rewritten / edited conflicting tests** to the new `ACTIVE`/`INACTIVE`
  contract (`state` / `inactivatedBy` / `inactivatedAt` instead of
  `status` / `violatedAt`):
  `productionEqualLiquidityV1.test.js`, `productionEqTemporalEligibilityV1.test.js`,
  `productionEqTakenNotificationChainAuditV1.test.js`,
  `eqV3ProductionMigrationV1.test.js`, `liquidityTakenEvent.test.js`,
  `eqMemberNotificationProvenanceV1.test.js`,
  `standardCausalSwingSegmentationV1.test.js`.
- **Full project suite:** `node test/run.js` → **123 files, 1204 passed,
  0 failed** (see `test-summary.json`).

> A fixture in `productionEqTakenNotificationChainAuditV1.test.js` originally
> placed a HIGH anchor at 99 with a candidate at 100. Under the new
> strict-cross lifecycle that anchor is correctly invalidated (candidate wick
> 100 > anchor 99), so it cannot pair. The fixture was updated to place the
> anchor at 100.5 (≥ candidate) — preserving the test's *multi-partner capture*
> intent while respecting the correct lifecycle. This is a test-fixture
> correction, **not** a production-semantics change.

---

## 4. Audit artifacts (this directory)

| File | Result |
|---|---|
| `dependency-audit.json` | **PASS** — 12/12 governance gates |
| `replay-summary.json` | **PASS** — frozen BTCUSDT 5m futures replay |
| `causality-audit.json` | **PASS** — all causality gates |
| `test-summary.json` | **PASS** — 123 files / 1204 passed / 0 failed |
| `implementation-summary.md` | this document |

### 4.1 Dependency / governance audit (`dependency_audit.js`)
12/12 checks PASS, including: old ZigZag module removed, no production reference
to `atr50CausalZigZag` / `ATR50_36H_UNVIOLATED` / `CAUSAL_ATR50_ZIGZAG` /
`productionEq.zigzag`, Dynamic D module has **zero** external requires, **no 4H
ATR / HTF / forbidden-volatility** residuals, `selectorPrice` never used in EQ,
`confirmedAt` = confirmation candle close-time, INACTIVE terminal, frozen
parameters byte-identical, notify label switched to Dynamic D, old ZigZag test
removed.

> **Known out-of-scope residual (documented, NOT a hard failure):** diagnostic
> tooling under `scripts/` (e.g. `warmup876ParityV1.js`, `zigzagConvergenceV1.js`,
> `seedFeasibilityRealV1.js`) still references the legacy
> `state.productionEq.zigzag` schema. These are standalone diagnostic scripts —
> not in the test runner and not in the live/replay pipeline — so they do not
> affect production runtime or the full test suite. They would need a separate
> migration if ever re-run; that is outside this task's scope.

### 4.2 Replay / causality audit (`replay_audit.js`, NETWORK=0)
Replays the frozen `data-cache/BTCUSDT_5m_20636_20697.json` (Binance USDⓈ-M
Futures 5m, `source:"futures"`, 17580 bars) through the production pipeline:

| Metric | Value |
|---|---|
| bars replayed | 17580 |
| Dynamic D anchors | 560 (HIGH 280 / LOW 280) |
| anchors with wick ≠ close | 523 (proves close-selector vs wick-business independently & correctly stored) |
| determinism (two independent replays byte-identical) | `true` |
| production wraps detection 1:1 (same anchor id set) | `true` |
| INACTIVE terminal (no resurrection) | `true` |
| candle continuity (strict 300000 ms spacing) | `true` |

**Causality gates (all PASS):**
- `CONFIRMED_AT_LE_EVALUATION_TIME`: every anchor `confirmedAt ===
  confirmationCandle.closeTime`; never a future candle.
- `NO_FUTURE_DATA`: `occurredBarIndex < confirmationBarIndex` and
  `occurredAt < confirmedAt` for all anchors; evaluation never reads beyond the
  current index.
- `SELECTOR_PRICE_CLOSE_BUSINESS_PRICE_WICK`: for every anchor, `price ===`
  extreme candle wick (HIGH→`high`, LOW→`low`) and `selectorPrice ===`
  extreme candle `close`.

---

## 5. Acceptance / gate decision

All HARD-FAILURE conditions are **clear**:

| Hard-failure condition | Status |
|---|---|
| future-data leak | ✅ none (causality audit PASS) |
| `selectorPrice` used for EQ | ✅ none (dependency audit PASS) |
| wick reverse-influences selection | ✅ none (selection uses close; wick only business price) |
| INACTIVE resurrection | ✅ none (terminal; replay + dependency PASS) |
| old ZigZag residual | ✅ none (module + test deleted; no production ref) |
| 4H ATR residual | ✅ none (no HTF/ATR consumption in detector) |
| downstream break | ✅ none (live/replay/notify use `state.dynamicD`; full suite 0 failed) |
| full suite failure | ✅ 1204 passed / 0 failed |

**Verdict: PROMOTE → commit + push `origin/main`.**

---

## 6. Commit scope (precise, no scope creep)

Staged for this task only:
- `liquidity/causalDynamicDHistoricalExtremes.js` (new)
- `liquidity/productionEqProvenance.js`, `liquidity/productionEqualLiquidityV1.js` (modified)
- `notify/watchNotificationPresentationV1.js` (modified)
- `test/productionHistoricalExtremeDynamicDV1.test.js` (new)
- `test/productionEqualLiquidityV1.test.js`, `test/productionEqTemporalEligibilityV1.test.js`,
  `test/productionEqTakenNotificationChainAuditV1.test.js`, `test/eqV3ProductionMigrationV1.test.js`,
  `test/liquidityTakenEvent.test.js`, `test/eqMemberNotificationProvenanceV1.test.js`,
  `test/standardCausalSwingSegmentationV1.test.js` (modified)
- `liquidity/atr50CausalZigZag.js`, `test/atr50CausalZigZagHighLowV2.test.js` (deleted)
- `artifacts/production/cc-dynamic-d-historical-extreme-v1-upgrade/` (audit scripts + 5 artifacts)

Other untracked Phase-11 work (`production-audits/*`, `research/*`, unrelated
`scripts/*` and `test/*`) was **intentionally left unstaged**.
