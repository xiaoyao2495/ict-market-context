/**
 * Accumulation Detector —— 低效率 + 压缩 + 反复穿越
 *
 * 扫描最近 N 根已收盘 K 线（窗口 12-36 bars）：
 *   rangeHigh / rangeLow / rangeWidth / ATR
 *   normalizedRange = rangeWidth / ATR（压缩度）
 *   efficiency = |lastClose - firstClose| / Σ|close[i]-close[i-1]|（低效率 = 横盘）
 *   midCrossCount = close 穿越 mid 的次数
 *   equalLiquidity = 窗口内 EQH/EQL 数量（加分）
 *
 * 确认条件：
 *   bars >= 12 && normalizedRange <= 3.0 && efficiency <= 0.35 && midCrossCount >= 3
 * Score = rangeCompression 30 + lowEfficiency 25 + midCrosses 20 + equalLiquidity 15 + duration 10
 * score >= 60 → ACCUMULATION_CONFIRMED；条件满足但 score < 60 → ACCUMULATION_CANDIDATE
 *
 * 窗口选择（多个满足时）：score 高 → duration 长 → startIndex 小（deterministic）
 * replay safe：只读 [0..endIndex] 已收盘 K 线；confirmedAt = 窗口末根 closeTime
 */
var atrIndicator = require('../indicators/atr');
var thresholds = require('../config/thresholds');

var INTERVAL_MS = {
    '1m': 60000, '5m': 300000, '15m': 900000, '30m': 1800000,
    '1h': 3600000, '4h': 14400000, '1d': 86400000
};

function barMsOf(timeframe) {
    return INTERVAL_MS[timeframe] || 300000;
}

function clamp01(n) {
    if (n < 0) return 0;
    if (n > 1) return 1;
    return n;
}

/**
 * 计算单个窗口的 accumulation 指标
 */
function evaluateWindow(candles, start, end, atrValue, liquiditiesInside, cfg) {
    var i;
    var rangeHigh = -Infinity;
    var rangeLow = Infinity;
    var firstClose = candles[start].close;
    var lastClose = candles[end].close;
    var pathSum = 0;
    var midCross = 0;

    for (i = start; i <= end; i++) {
        var c = candles[i];
        if (c.high > rangeHigh) rangeHigh = c.high;
        if (c.low < rangeLow) rangeLow = c.low;
        if (i > start) {
            pathSum += Math.abs(c.close - candles[i - 1].close);
        }
    }

    var mid = (rangeHigh + rangeLow) / 2;
    var prevSide = null;
    for (i = start; i <= end; i++) {
        var side = candles[i].close >= mid ? 1 : -1;
        if (prevSide !== null && side !== prevSide) {
            midCross++;
        }
        prevSide = side;
    }

    var rangeWidth = rangeHigh - rangeLow;
    var normalizedRange = atrValue > 0 ? rangeWidth / atrValue : Infinity;
    var efficiency = pathSum > 0 ? Math.abs(lastClose - firstClose) / pathSum : 0;
    var bars = end - start + 1;

    var w = cfg.scoreWeights;
    // compression 映射：normalizedRange 0 → 满分；1.5 ATR → 30；2.0 ATR → 25；3.0（边界）→ 15
    var rangeCompressionScore = w.rangeCompression * clamp01(1.5 - normalizedRange / cfg.maxNormalizedRange);
    var lowEfficiencyScore = w.lowEfficiency * clamp01(1 - efficiency / cfg.maxEfficiency);
    var midCrossScore = w.midCrosses * clamp01(midCross / 6);
    var equalLiquidityScore = Math.min(w.equalLiquidity, (liquiditesInsideCount(liquiditiesInside) * w.equalLiquidity) / 2);
    var durationScore = w.duration * clamp01((bars - cfg.minBars) / (cfg.maxBars - cfg.minBars));
    var score = Math.round(
        rangeCompressionScore + lowEfficiencyScore + midCrossScore + equalLiquidityScore + durationScore
    );

    var conditionsMet =
        bars >= cfg.minBars &&
        normalizedRange <= cfg.maxNormalizedRange &&
        efficiency <= cfg.maxEfficiency &&
        midCross >= cfg.minMidCrosses;

    return {
        startIndex: start,
        endIndex: end,
        bars: bars,
        rangeHigh: rangeHigh,
        rangeLow: rangeLow,
        mid: mid,
        rangeWidth: rangeWidth,
        atr: atrValue,
        normalizedRange: normalizedRange,
        efficiency: efficiency,
        midCrossCount: midCross,
        liquidityInside: liquiditiesInside,
        score: score,
        conditionsMet: conditionsMet,
        state: conditionsMet ? (score >= cfg.confirmThreshold ? 'ACCUMULATION_CONFIRMED' : 'ACCUMULATION_CANDIDATE') : null,
        confirmedAt: candles[end].closeTime,
        breakdown: {
            rangeCompression: Math.round(rangeCompressionScore),
            lowEfficiency: Math.round(lowEfficiencyScore),
            midCrosses: Math.round(midCrossScore),
            equalLiquidity: Math.round(equalLiquidityScore),
            duration: Math.round(durationScore)
        }
    };
}

function liquiditesInsideCount(list) {
    return list ? list.length : 0;
}

/**
 * 检测 Accumulation
 * @param {Object} input
 *   { candles, endIndex?, evaluationTime, timeframe, liquidityRegistry?, symbol? }
 * @returns {Object|null} 最佳窗口评估；无满足窗口返回 null
 */
function detectAccumulation(input, options) {
    var opts = options || {};
    var cfg = (opts.thresholds || thresholds).amd.accumulation;
    var atrCfg = (opts.thresholds || thresholds).events.atr;
    var candles = input.candles || [];
    var timeframe = input.timeframe || '5m';
    var evaluationTime = input.evaluationTime;
    var symbol = input.symbol;
    var endIndex =
        input.endIndex !== undefined
            ? Math.min(input.endIndex, candles.length - 1)
            : candles.length - 1;

    if (endIndex < cfg.minBars - 1 || !candles[endIndex] || candles[endIndex].closed === false) {
        return null;
    }
    if (candles[endIndex].closeTime > evaluationTime) {
        return null; // 防未来
    }

    var atrValue = atrIndicator.atr(candles, atrCfg.period, endIndex);
    if (atrValue === null || atrValue <= 0) {
        return null;
    }

    // 扫描所有可能窗口 [start, end]
    var candidates = [];
    var start;
    var minStart = Math.max(0, endIndex - cfg.maxBars + 1);
    for (start = minStart; start <= endIndex - cfg.minBars + 1; start++) {
        var windowCandles = candles.slice(start, endIndex + 1);
        var inside = collectEqualLiquidity(input.liquidityRegistry, symbol, windowCandles);
        var w = evaluateWindow(candles, start, endIndex, atrValue, inside, cfg);
        if (w.conditionsMet) {
            candidates.push(w);
        }
    }

    if (candidates.length === 0) {
        return null;
    }

    // 窗口选择：score 高 → duration 长 → startIndex 小（deterministic）
    candidates.sort(function (a, b) {
        if (a.score !== b.score) return b.score - a.score;
        if (a.bars !== b.bars) return b.bars - a.bars;
        return a.startIndex - b.startIndex;
    });

    var best = candidates[0];
    best.candidateCount = candidates.length;
    best.reasons = buildReasons(best);
    return best;
}

/**
 * 窗口内 EQH/EQL（加分项）
 */
function collectEqualLiquidity(liquidityRegistry, symbol, windowCandles) {
    if (!liquidityRegistry) {
        return [];
    }
    var endTime = windowCandles[windowCandles.length - 1].closeTime;
    var startTime = windowCandles[0].openTime;
    return liquidityRegistry.getAll(symbol).filter(function (l) {
        return (
            (l.type === 'EQH' || l.type === 'EQL') &&
            l.status === 'ACTIVE' &&
            l.confirmedAt <= endTime &&
            l.price >= lowOf(windowCandles) &&
            l.price <= highOf(windowCandles)
        );
    });
}

function lowOf(candles) {
    var m = Infinity;
    candles.forEach(function (c) {
        if (c.low < m) m = c.low;
    });
    return m;
}

function highOf(candles) {
    var m = -Infinity;
    candles.forEach(function (c) {
        if (c.high > m) m = c.high;
    });
    return m;
}

function buildReasons(w) {
    return [
        w.bars + ' bars',
        'Range ' + w.rangeLow.toFixed(2) + ' - ' + w.rangeHigh.toFixed(2),
        'Width ' + w.normalizedRange.toFixed(2) + ' ATR',
        'Efficiency ' + w.efficiency.toFixed(2),
        'Mid crosses ' + w.midCrossCount
    ];
}

module.exports = {
    detectAccumulation: detectAccumulation,
    evaluateWindow: evaluateWindow
};
