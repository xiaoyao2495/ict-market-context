/**
 * Distribution Detector —— 消费 price-only Displacement
 *
 * Bullish AMD Distribution：
 *   manipulation 后首次 Bullish Displacement
 * Bearish 对称。
 *
 * 顺序 + 窗口：
 *   manipulation.confirmedAt <= displacement.confirmedAt（<= 6 bars）
 *
 * range escape：bullish → displacement close > accumulation.rangeHigh；bearish 对称
 * target liquidity：bullish → draw 存在 ACTIVE BSL 候选；bearish → ACTIVE SSL
 */
var thresholds = require('../config/thresholds');

var INTERVAL_MS = {
    '1m': 60000, '5m': 300000, '15m': 900000, '30m': 1800000,
    '1h': 3600000, '4h': 14400000, '1d': 86400000
};

function barMsOf(timeframe) {
    return INTERVAL_MS[timeframe] || 300000;
}

/**
 * 检测 Distribution
 * @param {Object} input
 *   { accumulation, manipulation, eventRegistry, draw, timeframe, evaluationTime, symbol }
 * @param {Object} [options] { thresholds }
 * @returns {Object|null} 最佳 distribution
 */
function detectDistribution(input, options) {
    var opts = options || {};
    var cfg = (opts.thresholds || thresholds).amd.distribution;
    var manip = input.manipulation;
    var acc = input.accumulation;
    if (!manip || !acc) {
        return null;
    }
    var symbol = input.symbol;
    var timeframe = input.timeframe || '5m';
    var evaluationTime = input.evaluationTime;
    var barMs = barMsOf(timeframe);
    var reg = input.eventRegistry;
    var direction = manip.direction; // 'BULLISH' | 'BEARISH'

    var dispEvents = reg ? reg.getByType(symbol, 'DISPLACEMENT') : [];
    var candidates = [];

    dispEvents.forEach(function (dispEv) {
        if (dispEv.confirmedAt > evaluationTime) return;
        if (dispEv.direction !== direction) return;
        if (dispEv.confirmedAt < manip.confirmedAt) return;
        var dispBars = Math.floor((dispEv.confirmedAt - manip.confirmedAt) / barMs);
        if (dispBars > cfg.displacementMaxBars) return;
        candidates.push({
            direction: direction,
            displacementEvent: dispEv,
            rangeEscaped: rangeEscape(acc, direction, dispEv),
            targetAvailable: targetLiquidityExists(input.draw, direction),
            confirmedAt: dispEv.confirmedAt,
            state: 'DISTRIBUTION_CONFIRMED'
        });
    });

    if (candidates.length === 0) {
        return null;
    }

    // 首个确认的方向匹配 Displacement 是 causal distribution 触发。
    candidates.sort(function (a, b) {
        if (a.confirmedAt !== b.confirmedAt) return a.confirmedAt - b.confirmedAt;
        return a.displacementEvent.id < b.displacementEvent.id ? -1 : 1;
    });

    var best = candidates[0];
    best.reasons = [
        (direction === 'BULLISH' ? 'Bullish' : 'Bearish') + ' displacement',
        best.rangeEscaped ? 'Range escaped' : 'No range escape'
    ];
    return best;
}

/**
 * bullish → displacement close > rangeHigh；bearish → close < rangeLow
 */
function rangeEscape(acc, direction, dispEv) {
    var close = dispEv.source.candle ? dispEv.source.candle.close : dispEv.price;
    if (direction === 'BULLISH') {
        return close > acc.rangeHigh;
    }
    return close < acc.rangeLow;
}

/**
 * bullish → draw 有 ACTIVE BSL 候选；bearish → ACTIVE SSL
 */
function targetLiquidityExists(draw, direction) {
    if (!draw) {
        return false;
    }
    if (direction === 'BULLISH') {
        return !!(draw.bsl && draw.bsl.candidates && draw.bsl.candidates.length > 0);
    }
    return !!(draw.ssl && draw.ssl.candidates && draw.ssl.candidates.length > 0);
}

module.exports = {
    detectDistribution: detectDistribution
};
