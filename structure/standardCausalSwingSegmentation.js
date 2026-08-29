/**
 * Standard Causal Swing Segmentation V1.
 *
 * A Qualified Swing is an engineering, scale-dependent, causally confirmed
 * alternating swing eligible for EQ V3 comparison. It is not claimed to be a
 * unique true, structural, or independent market swing.
 *
 * Frozen pipeline:
 * confirmed raw 2L/2R pivot -> provisional same-side extreme compression ->
 * close-based 1.0 ATR directional-change confirmation -> immutable alternating
 * Qualified Swing.
 */
'use strict';

var atrIndicator = require('../indicators/atr');

var VERSION = 'STANDARD_CAUSAL_SWING_SEGMENTATION_V1';
var DC_K = 1.0;
var ATR_PERIOD = 14;

function sideOf(rawSwing) {
    return rawSwing.type === 'SWING_HIGH' ? 'HIGH' : 'LOW';
}

function createState(options) {
    var opts = options || {};
    return {
        version: VERSION,
        symbol: opts.symbol || 'UNKNOWN',
        timeframe: opts.timeframe || '5m',
        dcK: DC_K,
        atrPeriod: ATR_PERIOD,
        lastIndex: -1,
        atrSeedSum: 0,
        atrValue: null,
        candidate: null,
        opposite: null,
        requiredNextSide: null,
        resetIndex: null,
        emitted: [],
        emittedById: {},
        qualifiedHighPool: [],
        qualifiedLowPool: [],
        replacementLedger: []
    };
}

/** Compatibility seed for legacy diagnostic replays that intentionally begin
 * at a non-zero startIndex without full state warmup. Production/live bootstrap
 * and equivalence audits start at zero and do not use this path. */
function initializeAtIndex(state, candles, index) {
    if (state.lastIndex !== -1 || index <= 0) return;
    state.lastIndex = index - 1;
    if (index <= ATR_PERIOD) {
        for (var i = 1; i < index; i++) state.atrSeedSum += atrIndicator.trueRange(candles[i], candles[i - 1]);
        return;
    }
    state.atrValue = atrIndicator.atr(candles, ATR_PERIOD, index - 1);
}

function rawRecord(rawSwing) {
    return {
        id: rawSwing.id,
        side: sideOf(rawSwing),
        type: rawSwing.type,
        price: rawSwing.price,
        occurredAt: rawSwing.sourceOpenTime,
        sourceOpenTime: rawSwing.sourceOpenTime,
        sourceCloseTime: rawSwing.sourceCloseTime,
        pivotConfirmedAt: rawSwing.confirmedAt,
        index: rawSwing.metadata && rawSwing.metadata.index,
        rawSource: rawSwing.metadata && rawSwing.metadata.source || null
    };
}

function envelope(rawSwing) {
    return { raw: rawRecord(rawSwing), candidateStartedAt: rawSwing.confirmedAt, replacementCount: 0 };
}

function moreExtreme(side, next, current) {
    return side === 'HIGH' ? next.price > current.price : next.price < current.price;
}

function ingest(state, rawSwing, index) {
    var next = rawRecord(rawSwing);
    if (!state.candidate) {
        if (state.requiredNextSide && next.side !== state.requiredNextSide) return;
        state.candidate = envelope(rawSwing);
        state.requiredNextSide = null;
        state.resetIndex = index;
        return;
    }
    if (next.side === state.candidate.raw.side) {
        if (moreExtreme(next.side, next, state.candidate.raw)) {
            state.replacementLedger.push({
                replacedRawPivotId: state.candidate.raw.id,
                replacementRawPivotId: next.id,
                effectiveAt: next.pivotConfirmedAt,
                side: next.side
            });
            state.candidate = {
                raw: next,
                candidateStartedAt: state.candidate.candidateStartedAt,
                replacementCount: state.candidate.replacementCount + 1
            };
            state.opposite = null;
            state.resetIndex = index;
        }
        // Equal price retains the earlier canonical raw pivot deterministically.
        return;
    }
    if (!state.opposite) {
        state.opposite = envelope(rawSwing);
    } else if (moreExtreme(next.side, next, state.opposite.raw)) {
        state.opposite = {
            raw: next,
            candidateStartedAt: state.opposite.candidateStartedAt,
            replacementCount: state.opposite.replacementCount + 1
        };
    }
}

function updateAtr(state, candle, previousCandle, index) {
    if (index > 0) state.atrSeedSum += index <= ATR_PERIOD ? atrIndicator.trueRange(candle, previousCandle) : 0;
    if (index < ATR_PERIOD) return null;
    if (index === ATR_PERIOD) {
        state.atrValue = state.atrSeedSum / ATR_PERIOD;
        return state.atrValue;
    }
    state.atrValue = (state.atrValue * (ATR_PERIOD - 1) + atrIndicator.trueRange(candle, previousCandle)) / ATR_PERIOD;
    return state.atrValue;
}

function qualifiedId(state, raw) {
    return ['QS', state.symbol, state.timeframe, raw.side, '[' + raw.id + ']'].join(':');
}

function buildQualified(state, envelopeValue, candle, index, atrValue) {
    var raw = envelopeValue.raw;
    var id = qualifiedId(state, raw);
    return {
        id: id,
        symbol: state.symbol,
        timeframe: state.timeframe,
        type: raw.side === 'HIGH' ? 'SWING_HIGH' : 'SWING_LOW',
        side: raw.side === 'HIGH' ? 'BSL' : 'SSL',
        price: raw.price,
        occurredAt: raw.occurredAt,
        sourceOpenTime: raw.sourceOpenTime,
        sourceCloseTime: raw.sourceCloseTime,
        pivotConfirmedAt: raw.pivotConfirmedAt,
        qualifiedConfirmedAt: candle.closeTime,
        confirmedAt: candle.closeTime,
        createdAt: candle.closeTime,
        sourceRawPivotId: raw.id,
        source: VERSION,
        status: 'ACTIVE',
        touchedAt: null,
        sweptAt: null,
        brokenAt: null,
        metadata: {
            source: VERSION,
            rawSource: raw.rawSource,
            sourceRawPivotId: raw.id,
            pivotConfirmedAt: raw.pivotConfirmedAt,
            qualifiedConfirmedAt: candle.closeTime,
            index: raw.index,
            right: 2,
            dcK: DC_K,
            atrAtConfirmation: atrValue,
            confirmationCandleIndex: index,
            qualifiedConfirmationIndex: index,
            candidateStartedAt: envelopeValue.candidateStartedAt,
            provisionalReplacementCount: envelopeValue.replacementCount,
            confirmationReason: 'VOLATILITY_NORMALIZED_DIRECTIONAL_CHANGE'
        }
    };
}

function step(state, candle, index, newRawSwings, previousCandle) {
    if (!candle || candle.closed === false) return [];
    if (index !== state.lastIndex + 1) throw new Error(VERSION + ' requires continuous incremental indexes');
    state.lastIndex = index;
    var atrValue = updateAtr(state, candle, previousCandle, index);
    (newRawSwings || []).slice().sort(function (a, b) {
        return a.confirmedAt - b.confirmedAt || a.sourceOpenTime - b.sourceOpenTime || a.id.localeCompare(b.id);
    }).forEach(function (rawSwing) { ingest(state, rawSwing, index); });
    if (!state.candidate || state.resetIndex === index || atrValue == null || atrValue <= 0) return [];
    var raw = state.candidate.raw;
    var reversalDistance = raw.side === 'HIGH' ? raw.price - candle.close : candle.close - raw.price;
    if (reversalDistance / atrValue < DC_K) return [];
    var qualified = buildQualified(state, state.candidate, candle, index, atrValue);
    if (state.emittedById[qualified.id]) return [];
    state.emittedById[qualified.id] = true;
    state.emitted.push(qualified);
    (qualified.type === 'SWING_HIGH' ? state.qualifiedHighPool : state.qualifiedLowPool).push(qualified);
    var emittedSide = raw.side;
    state.candidate = state.opposite;
    state.opposite = null;
    state.requiredNextSide = state.candidate ? null : (emittedSide === 'HIGH' ? 'LOW' : 'HIGH');
    state.resetIndex = index;
    return [qualified];
}

function projectAsOf(state, evaluationTime) {
    var visible = state.emitted.filter(function (swing) { return swing.qualifiedConfirmedAt <= evaluationTime; });
    return {
        qualifiedSwings: visible.slice(),
        qualifiedHighPool: visible.filter(function (swing) { return swing.type === 'SWING_HIGH'; }),
        qualifiedLowPool: visible.filter(function (swing) { return swing.type === 'SWING_LOW'; })
    };
}

module.exports = {
    VERSION: VERSION,
    DC_K: DC_K,
    ATR_PERIOD: ATR_PERIOD,
    createState: createState,
    initializeAtIndex: initializeAtIndex,
    step: step,
    projectAsOf: projectAsOf,
    qualifiedId: qualifiedId
};
