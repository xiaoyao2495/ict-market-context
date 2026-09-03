'use strict';

/**
 * Causal Dynamic D Historical Extremes V1 (CC arm) — PRODUCTION module.
 *
 * Replaces the legacy ATR50 ZigZag as the historical-anchor source for the
 * Production Equal-Liquidity pipeline. Per spec
 * PRODUCTION_HISTORICAL_EXTREME_CC_DYNAMIC_D_V1:
 *
 *   FULL_REPLACEMENT=true; BACKWARD_COMPATIBILITY=false; FEATURE_FLAG=false;
 *   DUAL_PATH=false; FALLBACK_TO_ZIGZAG=false;
 *   LEGACY_ZIGZAG_OUTPUT_COMPATIBILITY=false.
 *
 * Detection (CC = CLOSE EXTREME + CLOSE REVERSAL), ported from the already
 * benchmarked research implementation (lib_dynamicD_controlled.js CC arm). All
 * Dynamic D parameters are FROZEN byte-for-byte:
 *   - r_t = ln(close_t / close_{t-1})  (close-to-close, causal)
 *   - sigma5m_t = SAMPLE stddev (ddof=1) of trailing 288 completed 5m returns
 *   - sigma1h_t = sigma5m_t * sqrt(12); K = 1.0; THETA_FLOOR = 0.003 (0.30%)
 *   - theta_t = max(THETA_FLOOR, sigma1h_t * K)
 *   - EXTREME_TIME_SNAPSHOT: thetaAtExtreme snapshotted at the extreme candle
 *     and FROZEN until a NEW extreme forms.
 *   - SAME-CANDLE RULE: a candle forming a new extreme never also confirms a
 *     reversal on that same candle (no future-lookahead ambiguity).
 *   - NEW_RUN_INITIALIZATION_SOURCE = 'CONFIRMATION_CANDLE_CLOSE': after a HIGH
 *     confirmed at candle C, the new DOWN_RUN extreme is initialized from
 *     C.close; after a LOW confirmed, the new UP_RUN extreme is C.close.
 *
 * CRITICAL INVARIANT (selectorPrice != businessPrice):
 *   - The detection SELECTOR is candle CLOSE (extreme is chosen by close).
 *   - After confirmation, the stored business PRICE is the REAL WICK of the
 *     selected candle: HIGH -> candle.high, LOW -> candle.low.
 *   - selectorPrice (close) is stored but MUST NEVER be used for EQ comparison
 *     or invalidation. Only price (wick) is ever compared.
 *
 * Lifecycle (ACTIVE -> INACTIVE, terminal):
 *   - Anchors start ACTIVE on confirmation.
 *   - INVALIDATION comes from an ordinary causal 2/2 strict cross
 *     (wick-to-wick), NOT from a raw candle trade-through and NOT from
 *     LIQUIDITY_TAKEN. STRICT_INVALIDATION takes priority over EQ tolerance.
 *   - AGE_EXPIRY: an anchor expires 5 calendar days after confirmedAt
 *     (AGE_START = confirmedAt). Age expiry PRECEDES EQ pairing.
 *   - NO RETROACTIVE REWRITE: once INACTIVE it never revives.
 *
 * Comparison domains:
 *   - EQ_COMPARISON = WICK_TO_WICK
 *   - INVALIDATION  = WICK_TO_WICK
 *
 * Forbidden (unchanged from research): ATR, 4H ATR, high-low range volatility,
 * Parkinson, Rogers-Satchell, EWMA, GARCH, HAR, CWT, Prominence, Persistent
 * Homology, and any parameter tuning. Purity of data source is preserved;
 * production logic uses Binance USDⓈ-M Futures 5m only.
 */

var VERSION = 'CAUSAL_DYNAMIC_D_V1';

var LOOKBACK = 288;            // 24h of 5m close-to-close returns (FROZEN)
var K = 1.0;                   // FROZEN
var THETA_FLOOR = 0.003;      // 0.30% (FROZEN)
var BARS_PER_1H = 12;
var SQRT12 = Math.sqrt(BARS_PER_1H);
var FIVE_DAYS_MS = 5 * 24 * 60 * 60 * 1000; // 432000000
// Historical anchor eligibility window (36H / 432 bars). Single source of truth:
// productionEqualLiquidityV1 imports this rather than redefining it. FROZEN.
var LOOKBACK_BARS = 432;

function round8(x) {
    if (x === null || x === undefined) return x;
    return Math.round(x * 1e8) / 1e8;
}

function numeric(value) { return Number(value); }

/** r_t = ln(close_t / close_{t-1}) — close-to-close, causal. */
function logReturn(closeT, closePrev) {
    return Math.log(closeT / closePrev);
}

/** Sample standard deviation (ddof=1) of an array. */
function sampleStd(arr) {
    var n = arr.length;
    if (n < 2) return null;
    var sum = 0;
    var i;
    for (i = 0; i < n; i++) sum += arr[i];
    var mean = sum / n;
    var sq = 0;
    for (i = 0; i < n; i++) {
        var d = arr[i] - mean;
        sq += d * d;
    }
    return Math.sqrt(sq / (n - 1));
}

/** theta from sigma5m (sqrt(12) scaling, K, floor applied). */
function thetaFor(sigma5m) {
    if (sigma5m === null || sigma5m === undefined) return null;
    var sigma1h = sigma5m * SQRT12;
    return Math.max(THETA_FLOOR, sigma1h * K);
}

function floorActiveFor(sigma1h) {
    if (sigma1h === null || sigma1h === undefined) return null;
    return sigma1h <= THETA_FLOOR + 1e-12;
}

function snapshotExtreme(ex, st) {
    if (st.volatilityReady) {
        ex.sigma5mAtExtreme = round8(st.sigma5m);
        ex.sigma1hAtExtreme = round8(st.sigma1h);
        ex.thetaAtExtreme = round8(st.theta);
        ex.floorActive = floorActiveFor(st.sigma1h);
    }
}

function makeExtreme(price, candle, index, st) {
    var ex = {
        price: price,                       // SELECTOR = close
        occurredAt: candle.openTime,
        occurredIndex: index,
        candle: candle,                    // retained only to extract REAL WICK
        sigma5mAtExtreme: null,
        sigma1hAtExtreme: null,
        thetaAtExtreme: null,
        floorActive: null
    };
    snapshotExtreme(ex, st);
    return ex;
}

function createState(options) {
    var opts = options || {};
    return {
        version: VERSION,
        symbol: opts.symbol || 'UNKNOWN',
        timeframe: opts.timeframe || '5m',
        // ---- Dynamic D detection state ----
        initialized: false,
        direction: null,                   // 'UP_RUN' | 'DOWN_RUN' | null
        extreme: null,
        returns: [],
        prevClose: null,
        volatilityReady: false,
        sigma5m: null,
        sigma1h: null,
        theta: null,
        lastIndex: -1,
        newExtremeCount: 0,
        reversalConfirmCount: 0,
        sameCandlePotentialReversalCount: 0,
        // ---- Anchor lifecycle / output ----
        confirmedPoints: [],
        recentSurvivalPoints: [],          // ACTIVE + INACTIVE within bar window
        confirmedPointById: {}
    };
}

/**
 * Internal detection step (CC arm). Returns [] or [confirmedExtreme].
 * Continuity is enforced: indexes must be strictly sequential.
 */
function detectStep(state, candle, index) {
    if (!candle || candle.closed === false) return [];
    if (index !== state.lastIndex + 1) {
        throw new Error(VERSION + ' requires continuous incremental 5m indexes');
    }
    state.lastIndex = index;
    var events = [];
    var close = numeric(candle.close);

    // ---- volatility: close-to-close returns (causal) ----
    if (state.prevClose !== null) {
        state.returns.push(logReturn(close, state.prevClose));
        if (state.returns.length > LOOKBACK) {
            state.returns = state.returns.slice(-LOOKBACK);
        }
    }
    state.prevClose = close;

    if (state.returns.length >= LOOKBACK) {
        state.sigma5m = sampleStd(state.returns);
        state.sigma1h = state.sigma5m * SQRT12;
        state.theta = Math.max(THETA_FLOOR, state.sigma1h * K);
        state.volatilityReady = true;
    } else {
        state.volatilityReady = false;
    }

    if (!state.initialized) {
        // seed reference = first candle close (neutral, deterministic start)
        state.extreme = makeExtreme(close, candle, index, state);
        state.initialized = true;
        return events;
    }

    // If volatility just became ready and the current extreme was not snapshotted,
    // snapshot it now (causal: only completed returns; legacy warmup behaviour).
    if (state.volatilityReady && state.extreme.sigma5mAtExtreme === null) {
        snapshotExtreme(state.extreme, state);
    }

    if (state.direction === null) {
        // pre-run direction determination using CLOSE (CC extreme source)
        if (close > state.extreme.price) {
            state.direction = 'UP_RUN';
            state.extreme = makeExtreme(close, candle, index, state);
        } else if (close < state.extreme.price) {
            state.direction = 'DOWN_RUN';
            state.extreme = makeExtreme(close, candle, index, state);
        } else {
            // flat pre-run: advance seed reference (close), keep direction null
            state.extreme.price = close;
            state.extreme.occurredAt = candle.openTime;
            state.extreme.occurredIndex = index;
            state.extreme.candle = candle;
            snapshotExtreme(state.extreme, state);
            return events;
        }
        return events;
    }

    var theta = state.extreme.thetaAtExtreme;

    if (state.direction === 'UP_RUN') {
        // NEW extreme uses CLOSE (CC extreme source)
        if (close > state.extreme.price) {
            state.extreme = makeExtreme(close, candle, index, state);
            state.newExtremeCount++;
            // same-candle potential reversal check (counted, never confirmed)
            if (state.extreme.thetaAtExtreme !== null) {
                var potUp = (state.extreme.price - close) / state.extreme.price >= state.extreme.thetaAtExtreme;
                if (potUp) state.sameCandlePotentialReversalCount++;
            }
        } else {
            // reversal observation uses CLOSE (CC reversal source)
            if (theta !== null && (state.extreme.price - close) / state.extreme.price >= theta) {
                events.push(makeConfirmed(state, candle, index, 'HIGH'));
                state.reversalConfirmCount++;
                state.direction = 'DOWN_RUN';
                // NEW_RUN_INITIALIZATION_SOURCE = CONFIRMATION_CANDLE_CLOSE
                state.extreme = makeExtreme(close, candle, index, state);
            }
        }
    } else { // DOWN_RUN
        if (close < state.extreme.price) {
            state.extreme = makeExtreme(close, candle, index, state);
            state.newExtremeCount++;
            if (state.extreme.thetaAtExtreme !== null) {
                var potDn = (close - state.extreme.price) / state.extreme.price >= state.extreme.thetaAtExtreme;
                if (potDn) state.sameCandlePotentialReversalCount++;
            }
        } else {
            if (theta !== null && (close - state.extreme.price) / state.extreme.price >= theta) {
                events.push(makeConfirmed(state, candle, index, 'LOW'));
                state.reversalConfirmCount++;
                state.direction = 'UP_RUN';
                state.extreme = makeExtreme(close, candle, index, state);
            }
        }
    }
    return events;
}

function makeConfirmed(state, candle, index, side) {
    return {
        pointSide: side,
        extremeCandle: state.extreme.candle,
        occurrenceIndex: state.extreme.occurredIndex,
        occurredAt: state.extreme.occurredAt,
        selectorPrice: state.extreme.price,   // close at extreme (SELECTOR)
        thetaAtExtreme: state.extreme.thetaAtExtreme,
        sigma5mAtExtreme: state.extreme.sigma5mAtExtreme,
        sigma1hAtExtreme: state.extreme.sigma1hAtExtreme,
        floorActive: state.extreme.floorActive,
        confirmationCandle: candle,
        confirmationIndex: index,
        confirmationCloseTime: candle.closeTime
    };
}

function pointId(state, side, det) {
    return ['DYND', state.symbol, state.timeframe, side, det.occurredAt, det.confirmationCloseTime].join(':');
}

/**
 * Build an anchor point from a confirmed extreme detection.
 * selectorPrice = close; price (business) = REAL WICK of the extreme candle.
 */
function buildPoint(state, det) {
    var side = det.pointSide;
    var wick = side === 'HIGH' ? numeric(det.extremeCandle.high) : numeric(det.extremeCandle.low);
    return {
        id: pointId(state, side, det),
        source: VERSION,
        symbol: state.symbol,
        timeframe: state.timeframe,
        pointSide: side,
        type: side === 'HIGH' ? 'DYNAMIC_D_HIGH' : 'DYNAMIC_D_LOW',
        selectorPrice: det.selectorPrice,      // close (selector) — NEVER for EQ
        price: wick,                          // REAL WICK (business price)
        priceSource: 'CLOSE_SELECTOR_WICK_BUSINESS',
        occurredAt: det.occurredAt,
        confirmedAt: det.confirmationCloseTime,
        occurredBarIndex: det.occurrenceIndex,
        confirmationBarIndex: det.confirmationIndex,
        thetaAtExtreme: det.thetaAtExtreme,
        sigma5mAtExtreme: det.sigma5mAtExtreme,
        sigma1hAtExtreme: det.sigma1hAtExtreme,
        floorActive: det.floorActive,
        state: 'ACTIVE',
        inactivatedAt: null,
        inactivatedBy: null
    };
}

function registerPoint(state, point) {
    if (state.confirmedPointById[point.id]) return null;
    state.confirmedPointById[point.id] = point;
    state.confirmedPoints.push(point);
    state.recentSurvivalPoints.push(point);
    return point;
}

function pruneSurvivalBeforeBar(state, minimumOccurredBarIndex) {
    state.recentSurvivalPoints = state.recentSurvivalPoints.filter(function (point) {
        return point.occurredBarIndex >= minimumOccurredBarIndex;
    });
}

// ---------------- Lifecycle helpers (pure unless noted) ----------------

/** Terminal transition. Once INACTIVE, never revives (NO RETROACTIVE REWRITE). */
function markInactive(point, reason, at) {
    if (point.state !== 'ACTIVE') return false;
    point.state = 'INACTIVE';
    point.inactivatedAt = at;
    point.inactivatedBy = reason;
    return true;
}

/** Anchor expired 5 calendar days after confirmedAt (AGE_START = confirmedAt). */
function isAgeExpired(anchor, asOf) {
    if (anchor.confirmedAt === null || anchor.confirmedAt === undefined) return false;
    return (asOf - anchor.confirmedAt) > FIVE_DAYS_MS;
}

/**
 * Ordinary causal 2/2 strict cross, wick-to-wick.
 * HIGH anchor invalidated if candidate high (wick) > anchor high.
 * LOW  anchor invalidated if candidate low  (wick) < anchor low.
 */
function strictCrosses(anchor, pivot) {
    if (anchor.pointSide === 'HIGH') return pivot.price > anchor.price;
    return pivot.price < anchor.price;
}

/**
 * Point-in-time anchor eligibility evaluated at candidate OCCURRENCE.
 * Pure: reads only the anchor's immutable status fields; never mutates.
 * (Age and strict-cross are applied later in evaluatePivot, not here.)
 */
function wasEligibleAtCandidateOccurrence(anchor, candidateOccurredAt, candidateOccurredBarIndex) {
    if (candidateOccurredAt == null || candidateOccurredBarIndex == null) return false;
    if (typeof anchor.occurredAt !== 'number' || typeof anchor.confirmedAt !== 'number') return false;
    if (anchor.state !== 'ACTIVE') return false;             // terminal lifecycle
    var barsBetween = candidateOccurredBarIndex - anchor.occurredBarIndex;
    return (
        anchor.confirmedAt <= candidateOccurredAt &&
        anchor.occurredAt < candidateOccurredAt &&
        barsBetween >= 1 && barsBetween <= LOOKBACK_BARS
    );
}

function eligibleHistoricalPoints(state, pivot) {
    var side = pivot.pointSide;
    var occurredAt = pivot.occurredAt;
    var sourceIndex = pivot.metadata && pivot.metadata.index;
    if (!side || typeof occurredAt !== 'number' || typeof sourceIndex !== 'number') return [];
    return state.recentSurvivalPoints.filter(function (point) {
        return point.pointSide === side &&
            wasEligibleAtCandidateOccurrence(point, occurredAt, sourceIndex);
    });
}

// ---------------- Public step ----------------

/**
 * Advance detection by one completed 5m candle.
 * @returns {Object} { dynamicDPoints: Array<anchor> }
 *   (EQ evaluation lives in productionEqualLiquidityV1.evaluatePivot, which
 *    applies age-expiry + strict-cross invalidation then tolerance pairing.)
 */
function step(state, candle, index, fiveMinuteCandles) {
    if (!candle || candle.closed === false) return { dynamicDPoints: [] };
    var detections = detectStep(state, candle, index);
    var dynamicDPoints = [];
    detections.forEach(function (det) {
        var point = buildPoint(state, det);
        if (registerPoint(state, point)) dynamicDPoints.push(point);
    });
    return { dynamicDPoints: dynamicDPoints };
}

module.exports = {
    VERSION: VERSION,
    LOOKBACK: LOOKBACK,
    K: K,
    THETA_FLOOR: THETA_FLOOR,
    SQRT12: SQRT12,
    FIVE_DAYS_MS: FIVE_DAYS_MS,
    LOOKBACK_BARS: LOOKBACK_BARS,
    round8: round8,
    logReturn: logReturn,
    sampleStd: sampleStd,
    thetaFor: thetaFor,
    floorActiveFor: floorActiveFor,
    createState: createState,
    detectStep: detectStep,
    pruneSurvivalBeforeBar: pruneSurvivalBeforeBar,
    markInactive: markInactive,
    isAgeExpired: isAgeExpired,
    strictCrosses: strictCrosses,
    wasEligibleAtCandidateOccurrence: wasEligibleAtCandidateOccurrence,
    eligibleHistoricalPoints: eligibleHistoricalPoints,
    step: step
};
