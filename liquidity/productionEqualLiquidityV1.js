'use strict';

/**
 * Production EQ replacement V1.
 *
 * Each confirmed ordinary causal 2/2 is independently compared with every
 * prior, confirmed, same-side, 36H/432-bar, unviolated ATR50 ZigZag point.
 * A matching pivot emits one point-in-time EQH/EQL liquidity observation with
 * all matching partners. There is no persistent EQ identity, cluster, member
 * evolution, repricing, ranking, score, or primary partner.
 */
var atrIndicator = require('../indicators/atr');
var thresholds = require('../config/thresholds');
var atr50ZigZag = require('./atr50CausalZigZag');

var VERSION = 'ATR50_36H_UNVIOLATED_CROSS_SOURCE_V1';
var LOOKBACK_BARS = 432;
var LOOKBACK_TIME = '36H';
var FIVE_MINUTE_ATR_PERIOD = 14;

function createState(options) {
    var opts = options || {};
    return {
        version: VERSION,
        symbol: opts.symbol || 'UNKNOWN',
        timeframe: opts.timeframe || '5m',
        zigzag: atr50ZigZag.createState(opts),
        evaluatedPivotKeys: {},
        emittedEventIds: {},
        events: [],
        lastIndex: -1,
        fiveMinuteAtrSeedSum: 0,
        fiveMinuteAtrValue: null
    };
}

function updateFiveMinuteAtr(state, candle, previousCandle, index) {
    if (index > 0) {
        var tr = atrIndicator.trueRange(candle, previousCandle);
        if (index <= FIVE_MINUTE_ATR_PERIOD) state.fiveMinuteAtrSeedSum += tr;
        if (index === FIVE_MINUTE_ATR_PERIOD) {
            state.fiveMinuteAtrValue = state.fiveMinuteAtrSeedSum / FIVE_MINUTE_ATR_PERIOD;
        } else if (index > FIVE_MINUTE_ATR_PERIOD && state.fiveMinuteAtrValue !== null) {
            state.fiveMinuteAtrValue = (
                state.fiveMinuteAtrValue * (FIVE_MINUTE_ATR_PERIOD - 1) + tr
            ) / FIVE_MINUTE_ATR_PERIOD;
        }
    }
    return state.fiveMinuteAtrValue;
}

function pointSideOf(pivot) {
    return pivot && pivot.type === 'SWING_HIGH' ? 'HIGH'
        : pivot && pivot.type === 'SWING_LOW' ? 'LOW' : null;
}

function pivotOccurredAt(pivot) {
    return pivot.occurredAt !== undefined ? pivot.occurredAt : pivot.sourceOpenTime;
}

function pivotKey(pivot) {
    return [
        pivot.symbol, pointSideOf(pivot), pivotOccurredAt(pivot), pivot.confirmedAt
    ].join('|');
}

function currentTradesThrough(side, currentPrice, historicalPrice) {
    return side === 'HIGH' ? currentPrice > historicalPrice : currentPrice < historicalPrice;
}

/**
 * Point-in-time EQ anchor eligibility evaluated at the candidate ordinary 2/2
 * OCCURRENCE (candidate.occurredAt), not at its later confirmation
 * (candidate.confirmedAt).
 *
 * A historical ZigZag anchor may pair only if it was already causally confirmed,
 * still inside the frozen 432-bar lookback window measured at the candidate's
 * occurrence index, and unviolated as of the candidate's occurrence instant.
 *
 * This is a pure backward reconstruction from the anchor's own immutable fields.
 * It does NOT query the anchor's current survival status (status === 'ACTIVE'),
 * so a candidate's own trade-through at its occurrence bar can never retroactively
 * expel a prior anchor that was genuinely valid when the candidate appeared.
 *
 * Strict boundary on firstViolationOccurredAt (real field: violatedAt):
 *   violatedAt <  candidateOccurredAt  -> NOT eligible
 *   violatedAt == candidateOccurredAt  -> eligible
 *   violatedAt >  candidateOccurredAt  -> eligible
 */
function wasEligibleAtCandidateOccurrence(anchor, candidateOccurredAt, candidateOccurredBarIndex) {
    if (candidateOccurredAt == null || candidateOccurredBarIndex == null) return false;
    if (typeof anchor.occurredAt !== 'number' || typeof anchor.confirmedAt !== 'number') return false;
    var barsBetween = candidateOccurredBarIndex - anchor.occurredBarIndex;
    return (
        anchor.confirmedAt <= candidateOccurredAt &&
        anchor.occurredAt < candidateOccurredAt &&
        barsBetween >= 1 && barsBetween <= LOOKBACK_BARS &&
        (anchor.violatedAt == null || anchor.violatedAt >= candidateOccurredAt)
    );
}

function eligibleHistoricalPoints(state, pivot) {
    var side = pointSideOf(pivot);
    var occurredAt = pivotOccurredAt(pivot);
    var sourceIndex = pivot.metadata && pivot.metadata.index;
    if (!side || typeof occurredAt !== 'number' || typeof pivot.confirmedAt !== 'number' ||
            typeof sourceIndex !== 'number') return [];
    return state.zigzag.recentSurvivalPoints.filter(function (point) {
        return point.pointSide === side &&
            wasEligibleAtCandidateOccurrence(point, occurredAt, sourceIndex);
    });
}

function buildEvent(state, pivot, partners, tolerance) {
    var side = pointSideOf(pivot);
    var type = side === 'HIGH' ? 'EQH' : 'EQL';
    var occurredAt = pivotOccurredAt(pivot);
    var key = pivotKey(pivot);
    var historicalPartners = partners.map(function (point) {
        var barsBetween = pivot.metadata.index - point.occurredBarIndex;
        return {
            id: point.id,
            source: 'CAUSAL_ATR50_ZIGZAG',
            side: point.pointSide,
            price: point.price,
            occurredAt: point.occurredAt,
            confirmedAt: point.confirmedAt,
            occurredBarIndex: point.occurredBarIndex,
            barsBetween: barsBetween,
            hoursBetween: barsBetween * 5 / 60,
            unviolated: true,
            priceDifference: Math.abs(pivot.price - point.price),
            eqTolerance: tolerance,
            currentTradesThroughHistorical: currentTradesThrough(side, pivot.price, point.price)
        };
    });
    return {
        id: ['EQX1', state.symbol, state.timeframe, type, '[' + key + ']'].join(':'),
        symbol: state.symbol,
        timeframe: state.timeframe,
        type: type,
        liquidityType: type,
        side: side === 'HIGH' ? 'BSL' : 'SSL',
        price: pivot.price,
        sourceOpenTime: occurredAt,
        sourceCloseTime: pivot.sourceCloseTime,
        occurredAt: occurredAt,
        createdAt: pivot.confirmedAt,
        confirmedAt: pivot.confirmedAt,
        status: 'ACTIVE',
        touchedAt: null,
        sweptAt: null,
        brokenAt: null,
        metadata: {
            eqModelVersion: VERSION,
            pointInTimeObservation: true,
            persistentIdentity: false,
            clusterLifecycle: false,
            memberEvolution: false,
            currentPivot: {
                id: pivot.id,
                source: 'ORDINARY_CAUSAL_2X2',
                side: side,
                price: pivot.price,
                occurredAt: occurredAt,
                confirmedAt: pivot.confirmedAt,
                sourceIndex: pivot.metadata.index
            },
            historicalSource: 'CAUSAL_ATR50_ZIGZAG',
            historicalLookbackBars: LOOKBACK_BARS,
            historicalLookbackTime: LOOKBACK_TIME,
            historicalZigzagMustRemainUnviolated: true,
            strictInequalityForViolation: true,
            touchCountsAsViolation: false,
            pairwiseToleranceAtrPeriod: FIVE_MINUTE_ATR_PERIOD,
            pairwiseToleranceAtrMultiplier: thresholds.equalLiquidity.priceStrongMaxATR,
            historicalPartners: historicalPartners,
            partnerCount: historicalPartners.length,
            primaryPartnerSelection: false
        }
    };
}

function evaluatePivot(state, pivot) {
    var key = pivotKey(pivot);
    if (state.evaluatedPivotKeys[key]) return null;
    state.evaluatedPivotKeys[key] = true;
    if (!(state.fiveMinuteAtrValue > 0)) return null;
    var tolerance = state.fiveMinuteAtrValue * thresholds.equalLiquidity.priceStrongMaxATR;
    var matching = eligibleHistoricalPoints(state, pivot).filter(function (point) {
        return Math.abs(pivot.price - point.price) <= tolerance;
    });
    if (matching.length === 0) return null;
    var event = buildEvent(state, pivot, matching, tolerance);
    if (state.emittedEventIds[event.id]) return null;
    state.emittedEventIds[event.id] = true;
    state.events.push(event);
    return event;
}

function warmupBeforeIndex(state, fiveMinuteCandles, index) {
    if (state.lastIndex !== -1 || index <= 0) return;
    for (var i = 0; i < index; i++) {
        var candle = fiveMinuteCandles[i];
        if (!candle || candle.closed === false) {
            throw new Error(VERSION + ' warmup requires continuous completed 5m candles');
        }
        state.lastIndex = i;
        updateFiveMinuteAtr(state, candle, i > 0 ? fiveMinuteCandles[i - 1] : null, i);
        atr50ZigZag.pruneSurvivalBeforeBar(state.zigzag, i - LOOKBACK_BARS - 2);
        atr50ZigZag.step(state.zigzag, candle, i, fiveMinuteCandles);
    }
}

function step(state, candle, index, fiveMinuteCandles, confirmedOrdinaryPivots) {
    if (!candle || candle.closed === false) return { zigzagPoints: [], equalLiquidity: [] };
    warmupBeforeIndex(state, fiveMinuteCandles, index);
    if (index !== state.lastIndex + 1) {
        throw new Error(VERSION + ' requires continuous incremental 5m indexes');
    }
    state.lastIndex = index;
    updateFiveMinuteAtr(state, candle, index > 0 ? fiveMinuteCandles[index - 1] : null, index);
    // A 2/2 confirmed on index i occurred on i-2. Retain the inclusive
    // 432-bar boundary only; expired anchors never re-enter eligibility.
    atr50ZigZag.pruneSurvivalBeforeBar(state.zigzag, index - LOOKBACK_BARS - 2);
    var zigzagPoints = atr50ZigZag.step(state.zigzag, candle, index, fiveMinuteCandles);
    var equal = [];
    (confirmedOrdinaryPivots || []).forEach(function (pivot) {
        var event = evaluatePivot(state, pivot);
        if (event) equal.push(event);
    });
    return { zigzagPoints: zigzagPoints, equalLiquidity: equal };
}

module.exports = {
    VERSION: VERSION,
    LOOKBACK_BARS: LOOKBACK_BARS,
    LOOKBACK_TIME: LOOKBACK_TIME,
    FIVE_MINUTE_ATR_PERIOD: FIVE_MINUTE_ATR_PERIOD,
    createState: createState,
    updateFiveMinuteAtr: updateFiveMinuteAtr,
    pivotKey: pivotKey,
    wasEligibleAtCandidateOccurrence: wasEligibleAtCandidateOccurrence,
    currentTradesThrough: currentTradesThrough,
    eligibleHistoricalPoints: eligibleHistoricalPoints,
    evaluatePivot: evaluatePivot,
    warmupBeforeIndex: warmupBeforeIndex,
    step: step
};
