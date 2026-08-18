/**
 * AMD State Machine
 *
 * 状态：
 *   SEARCHING → ACCUMULATION_CANDIDATE → ACCUMULATION_CONFIRMED
 *     → MANIPULATION_CONFIRMED → DISTRIBUTION_CONFIRMED → COMPLETE
 *   + INVALIDATED
 *
 * 流水线（deterministic，evaluationTime 驱动）：
 *   accumulation → manipulation → distribution
 *
 * INVALIDATED 条件（第一版）：
 *   A. accumulation 确认后，evaluationTime 超过 manipulationTimeoutBars 仍无 manipulation
 *   B. manipulation 后出现 opposite structural acceptance（相反方向 MSS 先出现）
 *   C. manipulation 后超过 distributionTimeoutBars 无 matching MSS/displacement
 *   D. accumulation range 被 opposite side 明确 breakout（未 reclaim）
 *
 * AMD 是 LTF price action 事实；Bias Alignment 是上下文评价（不修改这里）。
 */
var accumulationDetector = require('./accumulationDetector');
var manipulationDetector = require('./manipulationDetector');
var distributionDetector = require('./distributionDetector');
var thresholds = require('../config/thresholds');

var INTERVAL_MS = {
    '1m': 60000, '5m': 300000, '15m': 900000, '30m': 1800000,
    '1h': 3600000, '4h': 14400000, '1d': 86400000
};

function barMsOf(timeframe) {
    return INTERVAL_MS[timeframe] || 300000;
}

/**
 * 运行 AMD 状态机
 * @param {Object} input
 *   { symbol, timeframe, candles, evaluationTime,
 *     liquidityRegistry, eventRegistry, draw, bias? }
 * @param {Object} [options] { thresholds }
 */
function runAmd(input, options) {
    var opts = options || {};
    var cfg = (opts.thresholds || thresholds).amd;
    var timeframe = input.timeframe || '5m';
    var evaluationTime = input.evaluationTime;
    var barMs = barMsOf(timeframe);
    var symbol = input.symbol;

    var out = {
        symbol: symbol,
        timeframe: timeframe,
        state: 'SEARCHING',
        direction: null,
        accumulation: null,
        manipulation: null,
        distribution: null,
        startedAt: null,
        confirmedAt: null,
        invalidatedAt: null,
        invalidationReason: null,
        score: 0,
        reasons: []
    };

    // ---- 1. Accumulation ----
    var acc = accumulationDetector.detectAccumulation({
        candles: input.candles,
        endIndex: input.endIndex,
        evaluationTime: evaluationTime,
        timeframe: timeframe,
        symbol: symbol,
        liquidityRegistry: input.liquidityRegistry
    }, opts);

    if (!acc) {
        return out; // SEARCHING
    }
    out.accumulation = acc;
    out.startedAt = acc.confirmedAt;
    out.state = acc.state; // CANDIDATE / CONFIRMED
    out.direction = null;

    if (acc.state !== 'ACCUMULATION_CONFIRMED') {
        return out;
    }

    // ---- 2. Manipulation ----
    var manip = manipulationDetector.detectManipulation({
        accumulation: acc,
        eventRegistry: input.eventRegistry,
        candles: input.candles,
        timeframe: timeframe,
        evaluationTime: evaluationTime,
        symbol: symbol
    }, opts);

    if (!manip || manip.state !== 'MANIPULATION_CONFIRMED') {
        // A: 超时无 manipulation
        if (evaluationTime - acc.confirmedAt > cfg.invalidate.manipulationTimeoutBars * barMs) {
            out.state = 'INVALIDATED';
            out.invalidatedAt = evaluationTime;
            out.invalidationReason = 'no manipulation within ' + cfg.invalidate.manipulationTimeoutBars + ' bars of accumulation';
        }
        // D: range 被 opposite side 明确 breakout
        if (out.state !== 'INVALIDATED' && rangeOppositeBreakout(acc, input.candles, evaluationTime, timeframe)) {
            out.state = 'INVALIDATED';
            out.invalidatedAt = evaluationTime;
            out.invalidationReason = 'accumulation range broken by opposite side';
        }
        return out;
    }

    out.manipulation = manip;
    out.direction = manip.direction;
    out.state = 'MANIPULATION_CONFIRMED';
    out.confirmedAt = manip.confirmedAt;

    // B: manipulation 后、matching MSS 之前出现 opposite MSS → INVALIDATED
    if (oppositeMssBeforeDistribution(manip, input.eventRegistry, evaluationTime)) {
        out.state = 'INVALIDATED';
        out.invalidatedAt = evaluationTime;
        out.invalidationReason = 'opposite structural acceptance after manipulation';
        return out;
    }

    // ---- 3. Distribution ----
    var dist = distributionDetector.detectDistribution({
        accumulation: acc,
        manipulation: manip,
        eventRegistry: input.eventRegistry,
        draw: input.draw,
        timeframe: timeframe,
        evaluationTime: evaluationTime,
        symbol: symbol
    }, opts);

    if (!dist || dist.state !== 'DISTRIBUTION_CONFIRMED') {
        // C: manipulation 后超时无 matching MSS/displacement
        if (evaluationTime - manip.confirmedAt > cfg.invalidate.distributionTimeoutBars * barMs) {
            out.state = 'INVALIDATED';
            out.invalidatedAt = evaluationTime;
            out.invalidationReason = 'no matching MSS/displacement within ' + cfg.invalidate.distributionTimeoutBars + ' bars of manipulation';
        }
        return out;
    }

    out.distribution = dist;
    out.state = 'DISTRIBUTION_CONFIRMED';
    out.confirmedAt = dist.confirmedAt;
    return out;
}

/**
 * D: accumulation range 被 opposite side 明确 breakout
 *（bullish AMD 的 range 下沿被有效跌破 / bearish 的上沿被有效突破——第一版简化检查）
 */
function rangeOppositeBreakout(acc, candles, evaluationTime, timeframe) {
    if (!candles) {
        return false;
    }
    var i;
    for (i = 0; i < candles.length; i++) {
        var c = candles[i];
        if (!c || c.closed === false) continue;
        if (c.closeTime > evaluationTime) continue;
        if (c.closeTime <= acc.confirmedAt) continue; // 只在 accumulation 之后
        // 简化：价格明显突破 range（超出 1 ATR）且未收回
        if (c.close < acc.rangeLow - acc.atr || c.close > acc.rangeHigh + acc.atr) {
            return true;
        }
    }
    return false;
}

/**
 * B: manipulation 后出现 opposite direction MSS（在 matching MSS 之前）
 */
function oppositeMssBeforeDistribution(manip, reg, evaluationTime) {
    if (!reg) {
        return false;
    }
    var opposite = manip.direction === 'BULLISH' ? 'BEARISH' : 'BULLISH';
    var mss = reg.getByType(manip.symbol, 'MSS');
    var found = null;
    mss.forEach(function (m) {
        if (m.confirmedAt > evaluationTime) return;
        if (m.direction === manip.direction) {
            if (!found || m.confirmedAt < found.confirmedAt) found = m;
        }
    });
    // 存在 matching MSS（后续会消费）→ opposite 不构成 invalidation
    var matchingExists = found !== null && found.confirmedAt > manip.confirmedAt;
    var oppositeFound = false;
    mss.forEach(function (m) {
        if (m.confirmedAt > evaluationTime) return;
        if (m.direction === opposite && m.confirmedAt > manip.confirmedAt) {
            if (!matchingExists || m.confirmedAt < found.confirmedAt) {
                oppositeFound = true;
            }
        }
    });
    return oppositeFound;
}

module.exports = {
    runAmd: runAmd
};
