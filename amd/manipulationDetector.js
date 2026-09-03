/**
 * Manipulation Detector —— 消费 LIQUIDITY_SWEEP，验证位置关系
 *
 * 不自己找 wick：只消费 Event Registry 中的 LIQUIDITY_SWEEP。
 *
 * Bullish AMD Manipulation：
 *   sweep.side = SSL / direction = BULLISH
 *   swept price 位于 rangeLow ± boundaryTolerance（或明确低于 rangeLow 后快速 reclaim）
 * Bearish AMD 对称（BSL / BEARISH，near rangeHigh）
 *
 * boundaryTolerance = max(accumulation.atr × atrTolerance, boundaryPrice × percentageTolerance)
 * 时间限制：sweep.confirmedAt > accumulation.confirmedAt，barsBetween <= manipulationMaxBars
 *
 * Score（100）：
 *   rangeBoundarySweep 35 + equalLiquiditySweep 15 + calendarSessionSweep 15
 *   + fastReclaim 20 + reasonablePenetration 15
 * score >= 60 → MANIPULATION_CONFIRMED
 *
 * 远离 accumulation boundary 的旧 sweep 不得作为 manipulation。
 */
var thresholds = require('../config/thresholds');

var INTERVAL_MS = {
    '1m': 60000, '5m': 300000, '15m': 900000, '30m': 1800000,
    '1h': 3600000, '4h': 14400000, '1d': 86400000
};
var SESSION_PREFIX = ['ASIA_', 'LONDON_', 'NEW_YORK_'];

function barMsOf(timeframe) {
    return INTERVAL_MS[timeframe] || 300000;
}

function isSession(type) {
    if (!type) return false;
    for (var i = 0; i < SESSION_PREFIX.length; i++) {
        if (type.indexOf(SESSION_PREFIX[i]) === 0) {
            return true;
        }
    }
    return false;
}

/**
 * 检测 Manipulation
 * @param {Object} input
 *   { accumulation, eventRegistry, candles, timeframe, evaluationTime, symbol }
 * @param {Object} [options] { thresholds }
 * @returns {Object|null} 最佳 manipulation
 */
function detectManipulation(input, options) {
    var opts = options || {};
    var cfg = (opts.thresholds || thresholds).amd.manipulation;
    var acc = input.accumulation;
    if (!acc) {
        return null;
    }
    var symbol = input.symbol;
    var timeframe = input.timeframe || '5m';
    var evaluationTime = input.evaluationTime;
    var barMs = barMsOf(timeframe);
    var reg = input.eventRegistry;

    var sweeps = reg ? reg.getByType(symbol, 'LIQUIDITY_SWEEP') : [];
    var candidates = [];

    sweeps.forEach(function (ev) {
        if (ev.confirmedAt > evaluationTime) {
            return; // 未来
        }
        if (ev.confirmedAt <= acc.confirmedAt) {
            return; // 必须在 accumulation 之后
        }
        var barsAfter = Math.floor((ev.confirmedAt - acc.confirmedAt) / barMs);
        if (barsAfter > cfg.maxBars) {
            return; // 超时
        }

        // 方向匹配：bullish AMD = SSL sweep；bearish AMD = BSL sweep
        var bullish = ev.side === 'SSL';
        var bearish = ev.side === 'BSL';
        if (!bullish && !bearish) {
            return;
        }

        // 位置：near rangeLow（bullish）/ near rangeHigh（bearish）
        var boundaryPrice = bullish ? acc.rangeLow : acc.rangeHigh;
        var tolerance = Math.max(
            acc.atr * cfg.atrTolerance,
            boundaryPrice * cfg.percentageTolerance
        );
        var distance = Math.abs(ev.price - boundaryPrice);
        var penetration = bullish ? boundaryPrice - ev.price : ev.price - boundaryPrice; // 越过边界的深度
        var nearBoundary = distance <= tolerance;

        // 明确越过边界（penetration > 0）也算（manipulation 通常穿透）
        if (!nearBoundary && penetration <= 0) {
            return; // 远离边界且未穿透 → 拒绝
        }
        if (penetration > acc.atr * 2) {
            return; // 穿透过深（>2 ATR）→ 更可能是真突破而非 manipulation
        }

        var score = evaluateManipulation(ev, acc, penetration, input.candles, barsAfter, cfg);
        candidates.push({
            direction: bullish ? 'BULLISH' : 'BEARISH',
            score: score.final,
            sweepEvent: ev,
            penetration: penetration,
            penetrationAtr: acc.atr > 0 ? penetration / acc.atr : 0,
            reclaimBars: score.reclaimBars,
            breakdown: score.breakdown,
            confirmedAt: ev.confirmedAt,
            state: score.final >= cfg.confirmThreshold ? 'MANIPULATION_CONFIRMED' : 'MANIPULATION_CANDIDATE'
        });
    });

    if (candidates.length === 0) {
        return null;
    }

    // 最佳 manipulation：score 高 → confirmedAt 近 → sweepEvent.id 字典序
    candidates.sort(function (a, b) {
        if (a.score !== b.score) return b.score - a.score;
        if (a.confirmedAt !== b.confirmedAt) return b.confirmedAt - a.confirmedAt;
        return a.sweepEvent.id < b.sweepEvent.id ? -1 : 1;
    });

    var best = candidates[0];
    best.reasons = buildManipReasons(best, acc, cfg);
    return best;
}

/**
 * manipulation 评分（含 reclaim 计算）
 */
function evaluateManipulation(ev, acc, penetration, candles, barsAfter, cfg) {
    var w = cfg.scoreWeights;
    var breakdown = {};

    // 1. rangeBoundarySweep 35：在边界附近或穿透
    breakdown.rangeBoundarySweep = w.rangeBoundarySweep;

    // 2. equalLiquiditySweep 15
    breakdown.equalLiquiditySweep =
        ev.source.liquidityType === 'EQH' || ev.source.liquidityType === 'EQL'
            ? w.equalLiquiditySweep
            : 0;

    // 3. calendarSessionSweep 15
    breakdown.calendarSessionSweep = isSession(ev.source.liquidityType)
        ? w.calendarSessionSweep
        : 0;

    // 4. fastReclaim 20：sweep 后价格快速收回 range
    var reclaimBars = computeReclaimBars(ev, acc, candles);
    breakdown.fastReclaim = reclaimBars <= 2 ? w.fastReclaim : reclaimBars <= 5 ? Math.round(w.fastReclaim * 0.5) : 0;

    // 5. reasonablePenetration 15：穿透幅度合理（<= 0.5 ATR 满分）
    var penAtr = acc.atr > 0 ? penetration / acc.atr : 0;
    breakdown.reasonablePenetration =
        penAtr <= 0.5 ? w.reasonablePenetration : penAtr <= 1.0 ? Math.round(w.reasonablePenetration * 0.5) : 0;

    var final = Math.round(
        breakdown.rangeBoundarySweep +
        breakdown.equalLiquiditySweep +
        breakdown.calendarSessionSweep +
        breakdown.fastReclaim +
        breakdown.reasonablePenetration
    );

    return {
        final: final,
        breakdown: breakdown,
        reclaimBars: reclaimBars
    };
}

/**
 * sweep 之后第一根 close 收回 range 的 bars 数（bullish → close > rangeLow；bearish → close < rangeHigh）
 */
function computeReclaimBars(ev, acc, candles) {
    if (!candles) {
        return 999;
    }
    var target = ev.side === 'SSL' ? acc.rangeLow : acc.rangeHigh;
    var i;
    for (i = 0; i < candles.length; i++) {
        var c = candles[i];
        if (!c || c.closed === false) {
            continue;
        }
        if (c.closeTime <= ev.confirmedAt) {
            continue; // 只找 sweep 之后的 candle
        }
        if (ev.side === 'SSL' && c.close > target) {
            return i - ev.candleIndex;
        }
        if (ev.side === 'BSL' && c.close < target) {
            return i - ev.candleIndex;
        }
    }
    return 999;
}

function buildManipReasons(best, acc, cfg) {
    var ev = best.sweepEvent;
    var reasons = [];
    reasons.push((best.direction === 'BULLISH' ? 'SSL' : 'BSL') + ' swept ' + ev.source.liquidityType);
    if (ev.source.liquidityType === 'EQH' || ev.source.liquidityType === 'EQL') {
        reasons.push('equal liquidity swept');
    }
    reasons.push(best.direction === 'BULLISH' ? 'Near range low' : 'Near range high');
    if (best.reclaimBars <= 2) {
        reasons.push('Fast reclaim (' + best.reclaimBars + ' bars)');
    }
    return reasons;
}

module.exports = {
    detectManipulation: detectManipulation
};
