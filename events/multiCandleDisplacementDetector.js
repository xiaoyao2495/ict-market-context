/** Frozen C2 multi-candle price-delivery detector. */
'use strict';
var thresholds = require('../config/thresholds');
var atrIndicator = require('../indicators/atr');

function configOf(options) {
    var root = (options && options.thresholds || thresholds).events.displacement.multiCandle;
    return root;
}

function detectAt(candles, endIndex, options) {
    var opts = options || {};
    var cfg = configOf(opts);
    var symbol = opts.symbol || 'UNKNOWN';
    var timeframe = opts.timeframe || '5m';
    var end = candles && candles[endIndex];
    var atr = opts.atrSeries && opts.atrSeries[endIndex];
    if (atr === undefined) atr = atrIndicator.atr(candles, cfg.atrPeriod, endIndex);
    if (!end || end.closed === false || !isFinite(atr) || atr <= 0) return [];
    var out = [];
    cfg.nVariants.forEach(function (N) {
        var startIndex = endIndex - N;
        if (startIndex < 0) return;
        var start = candles[startIndex];
        if (!start || start.closed === false) return;
        var delta = end.close - start.close;
        if (delta === 0) return;
        var netMove = Math.abs(delta);
        var grossMove = 0;
        for (var i = startIndex + 1; i <= endIndex; i++) {
            if (!candles[i] || candles[i].closed === false) return;
            grossMove += Math.abs(candles[i].close - candles[i - 1].close);
        }
        if (grossMove <= 0) return;
        var normalizedMove = netMove / atr;
        var directionalEfficiency = netMove / grossMove;
        var normalizedSpeed = normalizedMove / N;
        if (normalizedMove < cfg.normalizedMoveThreshold ||
            directionalEfficiency < cfg.directionalEfficiencyThreshold ||
            normalizedSpeed < cfg.normalizedSpeedThreshold) return;
        var direction = delta > 0 ? 'BULLISH' : 'BEARISH';
        out.push({
            id: symbol + ':' + timeframe + ':RAW_DISPLACEMENT:MULTI_CANDLE:' + direction + ':N' + N + ':' + start.openTime + ':' + end.closeTime,
            source: 'MULTI_CANDLE_C2',
            symbol: symbol,
            timeframe: timeframe,
            direction: direction,
            formationType: 'MULTI_CANDLE',
            startIndex: startIndex,
            endIndex: endIndex,
            startAt: start.openTime,
            endAt: end.closeTime,
            confirmedAt: end.closeTime,
            startPrice: start.close,
            endPrice: end.close,
            atr: atr,
            metrics: {
                N: N,
                netMove: netMove,
                grossMove: grossMove,
                normalizedMove: normalizedMove,
                directionalEfficiency: directionalEfficiency,
                normalizedSpeed: normalizedSpeed
            }
        });
    });
    return out;
}

function detectMultiCandleDisplacement(candles, options) {
    var opts = options || {};
    if (!opts.atrSeries) {
        opts = Object.assign({}, opts, { atrSeries: buildAtrSeries(candles, configOf(opts).atrPeriod) });
    }
    var out = [];
    for (var i = 0; i < (candles || []).length; i++) {
        out = out.concat(detectAt(candles, i, opts));
    }
    return out;
}

function buildAtrSeries(candles, period) {
    var out = new Array((candles || []).length).fill(null);
    var sum = 0, previous = null;
    for (var i = 1; i < out.length; i++) {
        var tr = atrIndicator.trueRange(candles[i], candles[i - 1]);
        if (i <= period) sum += tr;
        if (i === period) previous = sum / period;
        else if (i > period) previous = (previous * (period - 1) + tr) / period;
        if (i >= period) out[i] = previous;
    }
    return out;
}

module.exports = {
    detectAt: detectAt,
    detectMultiCandleDisplacement: detectMultiCandleDisplacement,
    configOf: configOf,
    buildAtrSeries: buildAtrSeries
};
