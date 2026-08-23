/**
 * Distribution Detector —— 消费 MSS / Displacement（Phase 7.1 产物）
 *
 * Bullish AMD Distribution：
 *   Bullish MSS → Bullish Displacement（顺序严格）
 * Bearish 对称。
 *
 * 顺序 + 窗口：
 *   manipulation.confirmedAt < mss.confirmedAt（<= 12 bars）
 *   mss.confirmedAt <= displacement.confirmedAt（<= 6 bars；same candle 允许 equal）
 *
 * Score（100）：
 *   matchingMSS 30 + matchingDisplacement 35 + sameDeliveryChain 15
 *   + rangeEscape 10 + targetLiquidity 10
 * score >= 60 → DISTRIBUTION_CONFIRMED
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

    var mssEvents = reg ? reg.getByType(symbol, 'MSS') : [];
    // Compatibility for isolated callers/tests that provide the pre-V1 event
    // contract. Production emits MSS signals, so this fallback is not a second
    // production detection path.
    if (reg && mssEvents.length === 0) mssEvents = reg.getByType(symbol, 'STRUCTURAL_MSS');
    var dispEvents = reg ? reg.getByType(symbol, 'DISPLACEMENT') : [];
    var candidates = [];

    mssEvents.forEach(function (mssEv) {
        if (mssEv.confirmedAt > evaluationTime) return;
        if (mssEv.direction !== direction) return; // 方向匹配
        if (mssEv.confirmedAt <= manip.confirmedAt) return; // 必须在 manipulation 之后
        var mssBars = Math.floor((mssEv.confirmedAt - manip.confirmedAt) / barMs);
        if (mssBars > cfg.mssMaxBars) return;

        dispEvents.forEach(function (dispEv) {
            if (dispEv.confirmedAt > evaluationTime) return;
            if (dispEv.direction !== direction) return;
            if (dispEv.confirmedAt < mssEv.confirmedAt) return; // 顺序
            var dispBars = Math.floor((dispEv.confirmedAt - mssEv.confirmedAt) / barMs);
            if (dispBars > cfg.displacementMaxBars) return;

            // 同一条链：disp 紧跟 mss（same candle 允许 equal）
            var sameChain = dispBars <= 1;

            var escape = rangeEscape(acc, direction, dispEv);
            var targetAvailable = targetLiquidityExists(input.draw, direction);

            var w = cfg.scoreWeights;
            var score = w.matchingMss + w.matchingDisplacement;
            if (sameChain) score += w.sameDeliveryChain;
            if (escape) score += w.rangeEscape;
            if (targetAvailable) score += w.targetLiquidity;
            score = Math.round(score);

            candidates.push({
                direction: direction,
                score: score,
                mssEvent: mssEv,
                displacementEvent: dispEv,
                rangeEscaped: escape,
                targetAvailable: targetAvailable,
                confirmedAt: dispEv.confirmedAt,
                state: score >= cfg.confirmThreshold ? 'DISTRIBUTION_CONFIRMED' : 'DISTRIBUTION_CANDIDATE',
                breakdown: {
                    matchingMss: w.matchingMss,
                    matchingDisplacement: w.matchingDisplacement,
                    sameDeliveryChain: sameChain ? w.sameDeliveryChain : 0,
                    rangeEscape: escape ? w.rangeEscape : 0,
                    targetLiquidity: targetAvailable ? w.targetLiquidity : 0
                }
            });
        });
    });

    if (candidates.length === 0) {
        return null;
    }

    // 最佳：score 高 → confirmedAt 近 → mssEvent.id 字典序
    candidates.sort(function (a, b) {
        if (a.score !== b.score) return b.score - a.score;
        if (a.confirmedAt !== b.confirmedAt) return b.confirmedAt - a.confirmedAt;
        return a.mssEvent.id < b.mssEvent.id ? -1 : 1;
    });

    var best = candidates[0];
    best.reasons = [
        (direction === 'BULLISH' ? 'Bullish' : 'Bearish') + ' MSS',
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
