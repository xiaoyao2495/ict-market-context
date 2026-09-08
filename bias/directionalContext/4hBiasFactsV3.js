'use strict';

var dailyBiasContext = require('../../ai/dailyBiasContext');
var leg = require('./4hDirectionalLegV1');
var metrics = require('./4hDirectionalMetrics');
var theilSen = require('./theilSen48');

var VERSION = '4H_BIAS_FACT_SET_V3';
var TIMEFRAME = '4h';
var FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
// Structure is the binding requirement: the causal 2L/2R builder needs 120.
var MIN_WARMUP = 120;

function visibleClosed(candles, evaluationTime) {
    return (candles || []).filter(function (c) {
        return c && c.closed === true && c.closeTime <= evaluationTime;
    }).slice().sort(function (a, b) { return a.openTime - b.openTime; });
}

function assertNative(candles) {
    candles.forEach(function (c, index) {
        if (c.source !== 'futures') throw new Error('NON_FUTURES_4H_DATA');
        if (c.closeTime !== c.openTime + FOUR_HOURS_MS - 1) throw new Error('NON_NATIVE_4H_CANDLE');
        if (index && c.openTime !== candles[index - 1].openTime + FOUR_HOURS_MS) {
            throw new Error('FOUR_HOUR_DATA_GAP');
        }
    });
}

function structureDirection(marketFacts, evaluationTime) {
    var events = marketFacts.structuralEvents || [];
    events.forEach(function (event) {
        var confirmed = typeof event.confirmedAt === 'number' ? event.confirmedAt : Date.parse(event.confirmedAt);
        if (event.confirmedAt != null && confirmed > evaluationTime) {
            throw new Error('STRUCTURE_FUTURE_CONFIRMATION');
        }
    });
    if (marketFacts.structuralState === 'BULLISH') return 'UP';
    if (marketFacts.structuralState === 'BEARISH') return 'DOWN';
    return 'NEUTRAL';
}

function build(candles, evaluationTime, options) {
    var opts = options || {};
    var visible = visibleClosed(candles, evaluationTime);
    if (visible.length < MIN_WARMUP) {
        var warmup = new Error('INSUFFICIENT_WARMUP expected>=' + MIN_WARMUP + ' actual=' + visible.length);
        warmup.code = 'INSUFFICIENT_WARMUP';
        throw warmup;
    }
    assertNative(visible);
    var latest = visible[visible.length - 1];
    var atr = leg.calculateAtrWilder(visible, 14);
    var delivery = metrics.priceDelivery(visible, atr, 24);
    var dmi = metrics.dmiAdx(visible, 14, 14);
    var index = visible.length - 1;
    var productionStructure = dailyBiasContext.buildDailyBiasContext(visible, evaluationTime).marketFacts;
    var facts = {
        normalizedDirectionalSpread: metrics.normalizedDirectionalSpread(dmi.plusDI[index], dmi.minusDI[index]),
        adx14: dmi.adx[index],
        signedMoveAtr24: delivery.signedMoveAtr,
        signedEfficiency24: delivery.signedEfficiency,
        theilSenSlope48: theilSen.slope48(visible),
        structureDirection: structureDirection(productionStructure, evaluationTime)
    };
    Object.keys(facts).forEach(function (key) {
        if (key !== 'structureDirection' && (typeof facts[key] !== 'number' || !isFinite(facts[key]))) {
            throw new Error('NON_FINITE_FACT_' + key);
        }
    });
    return {
        version: VERSION,
        symbol: opts.symbol || 'BTCUSDT',
        timeframe: TIMEFRAME,
        closedAt: latest.closeTime,
        facts: facts
    };
}

module.exports = {
    VERSION: VERSION,
    MIN_WARMUP: MIN_WARMUP,
    FOUR_HOURS_MS: FOUR_HOURS_MS,
    visibleClosed: visibleClosed,
    assertNative: assertNative,
    structureDirection: structureDirection,
    build: build
};
