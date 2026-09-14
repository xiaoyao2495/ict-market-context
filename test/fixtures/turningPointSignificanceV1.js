'use strict';

/**
 * HISTORICAL_TURNING_POINT_SIGNIFICANCE_V1 — deterministic test fixtures.
 *
 * The candle builder keeps true range CONSTANT inside a leg, so Wilder ATR14 is
 * exactly |step| + 2*pad and every ATR-normalized fact has a closed-form expected
 * value. That keeps the facts tests exact rather than approximate.
 */

var BAR_MS = 300000;
var BASE_TIME = Date.UTC(2026, 0, 1, 0, 0, 0);

function buildSeries(closes, options) {
    var opts = options || {};
    var pad = opts.pad === undefined ? 5 : opts.pad;
    var step = opts.step === undefined ? 10 : opts.step;
    var highOverrides = opts.highOverrides || {};
    var lowOverrides = opts.lowOverrides || {};
    var time = opts.baseTime === undefined ? BASE_TIME : opts.baseTime;
    return closes.map(function (close, i) {
        var open = i === 0 ? close - step : closes[i - 1];
        var high = Math.max(open, close) + pad;
        var low = Math.min(open, close) - pad;
        if (highOverrides[i] !== undefined) high = highOverrides[i];
        if (lowOverrides[i] !== undefined) low = lowOverrides[i];
        var candle = {
            openTime: time + i * BAR_MS,
            open: open, high: high, low: low, close: close,
            closeTime: time + i * BAR_MS + BAR_MS - 1,
            closed: true, source: 'futures'
        };
        return candle;
    });
}

/** Rising leg then falling leg: a clean HIGH turning point. */
function highTurningSeries(options) {
    var opts = options || {};
    var up = opts.up === undefined ? 20 : opts.up;
    var down = opts.down === undefined ? 5 : opts.down;
    var closes = [];
    var value = opts.start === undefined ? 1000 : opts.start;
    for (var i = 0; i <= up; i++) { closes.push(value); value += opts.step === undefined ? 10 : opts.step; }
    value -= (opts.step === undefined ? 10 : opts.step);
    for (var d = 0; d < down; d++) { value -= 2 * (opts.step === undefined ? 10 : opts.step); closes.push(value); }
    return closes;
}

/** Falling leg then rising leg: a clean LOW turning point. */
function lowTurningSeries(options) {
    var opts = options || {};
    var series = highTurningSeries(opts);
    return series.map(function (v) { return 4000 - v; });
}

function makeCandidate(candles, spec) {
    var side = spec.side;
    var selector = candles[spec.selectorIndex];
    var localized = candles[spec.localizedIndex];
    var confirmation = candles[spec.confirmationIndex];
    if (!selector || !localized || !confirmation) throw new Error('FIXTURE_INDEX_OUT_OF_RANGE');
    var wick = side === 'HIGH' ? localized.high : localized.low;
    return {
        id: ['DYNDW', 'SAME_PROCESS_WICK_V1', 'TESTUSDT', '5m', side, localized.openTime,
            confirmation.closeTime].join(':'),
        processId: ['DYNDPROC', 'TESTUSDT', '5m', side, selector.openTime, confirmation.closeTime].join(':'),
        source: 'CAUSAL_DYNAMIC_D_V1',
        symbol: 'TESTUSDT',
        timeframe: '5m',
        pointSide: side,
        type: side === 'HIGH' ? 'DYNAMIC_D_HIGH' : 'DYNAMIC_D_LOW',
        selectorPrice: Number(selector.close),
        selectorOccurredAt: selector.openTime,
        selectorOccurredBarIndex: spec.selectorIndex,
        selectorWickPrice: side === 'HIGH' ? selector.high : selector.low,
        price: spec.localizedExtremePrice === undefined ? wick : spec.localizedExtremePrice,
        priceSource: 'SAME_PROCESS_WICK_EXTREME',
        localizationMode: 'SAME_PROCESS_WICK_V1',
        localizedExtremeOpenTime: localized.openTime,
        localizedExtremePrice: spec.localizedExtremePrice === undefined ? wick : spec.localizedExtremePrice,
        processStartBarIndex: spec.processStartIndex,
        processEndBarIndex: spec.confirmationIndex,
        occurredAt: localized.openTime,
        confirmedAt: confirmation.closeTime,
        occurredBarIndex: spec.localizedIndex,
        confirmationBarIndex: spec.confirmationIndex,
        thetaAtExtreme: spec.thetaAtExtreme === undefined ? 0.003 : spec.thetaAtExtreme,
        sigma5mAtExtreme: spec.sigma5m === undefined ? 0.001 : spec.sigma5m,
        sigma1hAtExtreme: spec.sigma1h === undefined ? 0.0035 : spec.sigma1h,
        floorActive: false,
        state: 'ACTIVE',
        inactivatedAt: null,
        inactivatedBy: null
    };
}

/** A Dynamic-D shaped point for anchor-universe tests (EQ / TP). */
function anchorPoint(spec) {
    var occurredBarIndex = spec.occurredBarIndex;
    var processStartBarIndex = spec.processStartBarIndex == null
        ? Math.max(0, occurredBarIndex - 20) : spec.processStartBarIndex;
    return {
        id: spec.id || ['DYNDW', 'SAME_PROCESS_WICK_V1', spec.symbol || 'TESTUSDT', '5m',
            spec.pointSide, spec.occurredAt, spec.confirmedAt].join(':'),
        processId: spec.processId || ['DYNDPROC', spec.symbol || 'TESTUSDT', '5m', spec.pointSide,
            spec.occurredAt, spec.confirmedAt].join(':'),
        source: 'CAUSAL_DYNAMIC_D_V1',
        symbol: spec.symbol || 'TESTUSDT',
        timeframe: '5m',
        pointSide: spec.pointSide,
        type: spec.pointSide === 'HIGH' ? 'DYNAMIC_D_HIGH' : 'DYNAMIC_D_LOW',
        price: spec.price,
        priceSource: 'SAME_PROCESS_WICK_EXTREME',
        localizationMode: 'SAME_PROCESS_WICK_V1',
        occurredAt: spec.occurredAt,
        confirmedAt: spec.confirmedAt,
        occurredBarIndex: occurredBarIndex,
        confirmationBarIndex: occurredBarIndex + 1,
        processStartBarIndex: processStartBarIndex,
        processEndBarIndex: occurredBarIndex + 1,
        selectorOccurredBarIndex: occurredBarIndex,
        selectorOccurredAt: spec.occurredAt,
        selectorPrice: spec.price,
        selectorWickPrice: spec.price,
        localizedExtremeOpenTime: spec.occurredAt,
        localizedExtremePrice: spec.price,
        thetaAtExtreme: 0.003,
        sigma5mAtExtreme: 0.001,
        sigma1hAtExtreme: 0.0035,
        floorActive: false,
        state: spec.state || 'ACTIVE',
        inactivatedAt: null,
        inactivatedBy: null
    };
}

/** A confirmed ordinary 2L/2R pivot as the equilibrium-pairing candidate. */
function pivotPoint(spec) {
    return {
        id: spec.id || ['SWING', spec.symbol || 'TESTUSDT', '5m', spec.type, spec.occurredAt].join(':'),
        symbol: spec.symbol || 'TESTUSDT',
        timeframe: '5m',
        type: spec.type,
        price: spec.price,
        occurredAt: spec.occurredAt,
        sourceOpenTime: spec.occurredAt,
        sourceCloseTime: spec.occurredAt + BAR_MS - 1,
        confirmedAt: spec.confirmedAt,
        metadata: { index: spec.index }
    };
}

module.exports = {
    BAR_MS: BAR_MS,
    BASE_TIME: BASE_TIME,
    buildSeries: buildSeries,
    highTurningSeries: highTurningSeries,
    lowTurningSeries: lowTurningSeries,
    makeCandidate: makeCandidate,
    anchorPoint: anchorPoint,
    pivotPoint: pivotPoint
};
