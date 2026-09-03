'use strict';

/**
 * Production EQ replacement V1.
 *
 * Each confirmed ordinary causal 2/2 is independently compared with every
 * prior, confirmed, same-side, 36H/432-bar, ACTIVE Causal Dynamic D historical
 * extreme. A matching pivot emits one point-in-time EQH/EQL liquidity
 * observation with all matching partners. There is no persistent EQ identity,
 * cluster, member evolution, repricing, ranking, score, or primary partner.
 *
 * The historical-anchor source is the CC CLOSE-based Dynamic D
 * (liquidity/causalDynamicDHistoricalExtremes.js), which fully replaces the
 * legacy ATR50 ZigZag. Anchor lifecycle is ACTIVE -> INACTIVE (terminal):
 * invalidation comes from an ordinary causal 2/2 strict cross (wick-to-wick),
 * not a raw candle trade-through and not LIQUIDITY_TAKEN; anchors also expire
 * 5 calendar days after confirmation (AGE_START = confirmedAt), which precedes
 * EQ pairing. Comparison domains are WICK_TO_WICK (EQ and invalidation).
 */
var atrIndicator = require('../indicators/atr');
var thresholds = require('../config/thresholds');
var dynamicD = require('./causalDynamicDHistoricalExtremes');

var VERSION = 'DYNAMIC_D_36H_CROSS_SOURCE_V1';
var LOOKBACK_BARS = dynamicD.LOOKBACK_BARS;
var LOOKBACK_TIME = '36H';
var FIVE_MINUTE_ATR_PERIOD = 14;

function createState(options) {
    var opts = options || {};
    return {
        version: VERSION,
        symbol: opts.symbol || 'UNKNOWN',
        timeframe: opts.timeframe || '5m',
        dynamicD: dynamicD.createState(opts),
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
 * A historical Causal Dynamic D anchor may pair only if it is currently ACTIVE,
 * already causally confirmed, and still inside the frozen 432-bar lookback window
 * measured at the candidate's occurrence index.
 *
 * This is a pure backward reconstruction from the anchor's own immutable fields.
 * It does NOT query the anchor's current lifecycle mutation; age expiry and
 * ordinary-2/2 strict-cross invalidation are applied later in evaluatePivot, so
 * this function stays mutation-free (and a candidate's own evaluation can never
 * retroactively expel a prior ACTIVE anchor it does not strict-cross).
 *
 * Strict boundary on anchor lifecycle (real field: state):
 *   state !== 'ACTIVE'  -> NOT eligible (terminal; INACTIVE never revives)
 */
function wasEligibleAtCandidateOccurrence(anchor, candidateOccurredAt, candidateOccurredBarIndex) {
    if (candidateOccurredAt == null || candidateOccurredBarIndex == null) return false;
    if (typeof anchor.occurredAt !== 'number' || typeof anchor.confirmedAt !== 'number') return false;
    if (anchor.state !== 'ACTIVE') return false;
    var barsBetween = candidateOccurredBarIndex - anchor.occurredBarIndex;
    return (
        anchor.confirmedAt <= candidateOccurredAt &&
        anchor.occurredAt < candidateOccurredAt &&
        barsBetween >= 1 && barsBetween <= LOOKBACK_BARS
    );
}

function eligibleHistoricalPoints(state, pivot) {
    var side = pointSideOf(pivot);
    var occurredAt = pivotOccurredAt(pivot);
    var sourceIndex = pivot.metadata && pivot.metadata.index;
    if (!side || typeof occurredAt !== 'number' || typeof pivot.confirmedAt !== 'number' ||
            typeof sourceIndex !== 'number') return [];
    return state.dynamicD.recentSurvivalPoints.filter(function (point) {
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
            source: point.source,
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
            historicalSource: dynamicD.VERSION,
            historicalLookbackBars: LOOKBACK_BARS,
            historicalLookbackTime: LOOKBACK_TIME,
            historicalAnchorMustRemainActive: true,
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
    var anchors = eligibleHistoricalPoints(state, pivot);
    var matching = [];
    anchors.forEach(function (anchor) {
        // AGE_EXPIRY_PRECEDES_EQ: an aged anchor is terminal and never a partner.
        if (dynamicD.isAgeExpired(anchor, pivot.occurredAt)) {
            dynamicD.markInactive(anchor, 'AGE_EXPIRY', pivot.occurredAt);
            return;
        }
        // STRICT_INVALIDATION priority over EQ tolerance: an ordinary causal 2/2
        // strict cross (wick-to-wick) invalidates the anchor and precludes pairing.
        if (dynamicD.strictCrosses(anchor, pivot)) {
            dynamicD.markInactive(anchor, 'STRICT_CROSS', pivot.confirmedAt);
            return;
        }
        if (Math.abs(pivot.price - anchor.price) <= tolerance) matching.push(anchor);
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
        dynamicD.pruneSurvivalBeforeBar(state.dynamicD, i - LOOKBACK_BARS - 2);
        dynamicD.step(state.dynamicD, candle, i, fiveMinuteCandles);
    }
}

function step(state, candle, index, fiveMinuteCandles, confirmedOrdinaryPivots) {
    if (!candle || candle.closed === false) return { dynamicDPoints: [], equalLiquidity: [] };
    warmupBeforeIndex(state, fiveMinuteCandles, index);
    if (index !== state.lastIndex + 1) {
        throw new Error(VERSION + ' requires continuous incremental 5m indexes');
    }
    state.lastIndex = index;
    updateFiveMinuteAtr(state, candle, index > 0 ? fiveMinuteCandles[index - 1] : null, index);
    // A 2/2 confirmed on index i occurred on i-2. Retain the inclusive
    // 432-bar boundary only; expired anchors never re-enter eligibility.
    dynamicD.pruneSurvivalBeforeBar(state.dynamicD, index - LOOKBACK_BARS - 2);
    var det = dynamicD.step(state.dynamicD, candle, index, fiveMinuteCandles);
    var equal = [];
    (confirmedOrdinaryPivots || []).forEach(function (pivot) {
        var event = evaluatePivot(state, pivot);
        if (event) equal.push(event);
    });
    return { dynamicDPoints: det.dynamicDPoints, equalLiquidity: equal };
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
