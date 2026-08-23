/**
 * MSS Detector —— 市场结构破坏
 *
 * 原则（WICK ≠ MSS）：
 *   WICK  → liquidity interaction
 *   CLOSE → structural break candidate
 *
 * Bullish MSS：
 *   - close 突破【最近一个未消费的 confirmed Swing High】
 *   - 必须 close > level（不允许只有 wick）
 *   - break candle bullish（close > open）优先（requireDirectionalBody）
 *   - bodyRatio >= minBodyRatio
 *   - breakDistance >= level × minBreakPct（防 tick 级假突破）
 * Bearish MSS 对称（close 跌破最近未消费 Swing Low）
 *
 * replay safe：
 *   - reference swing confirmedAt <= candle.closeTime 才可参与
 *   - 同一 reference swing 只产生一次 MSS（consumed tracking）
 *   - 每根 candle 每方向最多一个 MSS（取最近 reference）
 */
var thresholds = require('../config/thresholds');

/**
 * 质量检查（bodyRatio / directional body）
 */
function passesQuality(candle, direction, cfg) {
    var range = candle.high - candle.low;
    if (range <= 0) {
        return false;
    }
    var body = Math.abs(candle.close - candle.open);
    var bodyRatio = body / range;
    if (bodyRatio < cfg.minBodyRatio) {
        return false;
    }
    if (cfg.requireDirectionalBody) {
        if (direction === 'BULLISH' && candle.close <= candle.open) {
            return false;
        }
        if (direction === 'BEARISH' && candle.close >= candle.open) {
            return false;
        }
    }
    return true;
}

/**
 * 检测 MSS
 * @param {Array} candles 已收盘 K 线（时间升序）
 * @param {Array} swings SWING_HIGH / SWING_LOW liquidity（confirmedAt 已设置）
 * @param {Object} [options] { symbol, timeframe, thresholds }
 * @returns {Array} MSS Market Events
 */
function detectMss(candles, swings, options) {
    var opts = options || {};
    var cfg = (opts.thresholds || thresholds).events.mss;
    var symbol = opts.symbol || (swings[0] && swings[0].symbol) || 'UNKNOWN';
    var timeframe = opts.timeframe || (swings[0] && swings[0].timeframe) || '5m';
    var baseIndex = opts.baseIndex || 0;

    // 持久 consumed tracking（Phase 11R 增量模式）：外部传入的对象跨调用保留，
    // 保证同一 reference swing 全局只产生一次 MSS。
    var consumed = opts.consumedRefs || {};
    var results = [];

    (candles || []).forEach(function (candle, i) {
        if (candle.closed === false) {
            return;
        }
        var evalTime = candle.closeTime;

        // ---- Bullish MSS：突破最近未消费 Swing High ----
        var highs = candidateReferences(swings, 'SWING_HIGH', evalTime, consumed);
        if (highs.length > 0) {
            var refHigh = highs[0]; // confirmedAt 最近
            var breakDist = candle.close - refHigh.price;
            if (
                breakDist > 0 &&
                breakDist >= refHigh.price * cfg.minBreakPct &&
                passesQuality(candle, 'BULLISH', cfg)
            ) {
                results.push(buildMssEvent(candle, baseIndex + i, refHigh, 'BULLISH', breakDist, cfg, symbol, timeframe));
                // Phase 11R.2：consumed 记录时间戳（candle.closeTime）供生命周期诊断
                // （total / oldest / age buckets）。truthy 语义不变，兼容 candidateReferences。
                consumed[refHigh.id] = candle.closeTime;
            }
        }

        // ---- Bearish MSS：跌破最近未消费 Swing Low ----
        var lows = candidateReferences(swings, 'SWING_LOW', evalTime, consumed);
        if (lows.length > 0) {
            var refLow = lows[0];
            var breakDistLow = refLow.price - candle.close;
            if (
                breakDistLow > 0 &&
                breakDistLow >= refLow.price * cfg.minBreakPct &&
                passesQuality(candle, 'BEARISH', cfg)
            ) {
                results.push(buildMssEvent(candle, baseIndex + i, refLow, 'BEARISH', breakDistLow, cfg, symbol, timeframe));
                consumed[refLow.id] = candle.closeTime;
            }
        }
    });

    return results;
}

/**
 * 候选 reference：confirmedAt <= evalTime、未 consumed，按 confirmedAt 降序
 */
function candidateReferences(swings, type, evalTime, consumed) {
    return (swings || [])
        .filter(function (s) {
            return (
                s.type === type &&
                s.confirmedAt !== undefined &&
                s.confirmedAt <= evalTime &&
                !consumed[s.id]
            );
        })
        .sort(function (a, b) {
            return b.confirmedAt - a.confirmedAt;
        });
}

function buildMssEvent(candle, i, ref, direction, breakDistance, cfg, symbol, timeframe) {
    var range = candle.high - candle.low;
    var body = Math.abs(candle.close - candle.open);
    var bodyRatio = range > 0 ? body / range : 0;
    var closeStrength =
        direction === 'BULLISH'
            ? (candle.close - candle.low) / range
            : (candle.high - candle.close) / range;

    return {
        id: symbol + ':' + timeframe + ':MSS:' + direction + ':' + ref.id,
        symbol: symbol,
        timeframe: timeframe,
        type: 'MSS',
        direction: direction,
        occurredAt: candle.openTime,
        confirmedAt: candle.closeTime,
        candleIndex: i,
        price: ref.price,
        source: {
            referenceSwingId: ref.id,
            referencePrice: ref.price,
            breakDistance: breakDistance,
            breakPct: ref.price > 0 ? breakDistance / ref.price : 0,
            candle: {
                open: candle.open,
                high: candle.high,
                low: candle.low,
                close: candle.close
            }
        },
        metadata: {
            bodyRatio: round4(bodyRatio),
            closeStrength: round4(closeStrength)
        }
    };
}

function round4(n) {
    return Math.round(n * 10000) / 10000;
}

module.exports = {
    detectMss: detectMss
};
