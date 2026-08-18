/**
 * Displacement Detector —— 价格是否以明显不平衡方式重新定价
 *
 * 评分制（score >= minScore → DISPLACEMENT）：
 *   Body Ratio >= 0.60                        +1
 *   Range >= ATR × 1.20                       +1
 *   Body >= ATR × 0.80                        +1
 *   Close near directional extreme >= 0.75    +1
 *   Same candle MSS（结构破坏）                +1
 *
 * 方向：
 *   close > open → BULLISH
 *   close < open → BEARISH
 *   Doji（body = 0）不生成
 *
 * replay safe：每根 candle 的 ATR 只读其之前的 K 线；
 *              只处理已收盘 candle；confirmedAt = candle.closeTime。
 */
var atrIndicator = require('../indicators/atr');
var thresholds = require('../config/thresholds');

/**
 * 检测 Displacement
 * @param {Array} candles 已收盘 K 线（时间升序）
 * @param {Array} [mssEvents] 同批 MSS 事件（用于 same-candle break bonus）
 * @param {Object} [options] { symbol, timeframe, thresholds }
 * @returns {Array} DISPLACEMENT Market Events
 */
function detectDisplacement(candles, mssEvents, options) {
    var opts = options || {};
    var cfg = (opts.thresholds || thresholds).events.displacement;
    var atrCfg = (opts.thresholds || thresholds).events.atr;
    var symbol = opts.symbol || 'UNKNOWN';
    var timeframe = opts.timeframe || '5m';
    var baseIndex = opts.baseIndex || 0;

    // same-candle MSS 索引：candleIndex（全局）-> [mss events]
    var mssByIndex = {};
    (mssEvents || []).forEach(function (m) {
        if (!mssByIndex[m.candleIndex]) {
            mssByIndex[m.candleIndex] = [];
        }
        mssByIndex[m.candleIndex].push(m);
    });

    var results = [];

    (candles || []).forEach(function (candle, i) {
        if (candle.closed === false) {
            return;
        }
        var index = baseIndex + i;
        var range = candle.high - candle.low;
        var body = Math.abs(candle.close - candle.open);
        if (range <= 0 || body === 0) {
            return; // doji / 平线不生成
        }

        // Phase 11R 增量模式：外部提供增量 ATR 序列（atrSeries[index]），
        // 避免每根全量重算 O(n²)；未提供时回退原逻辑。
        var atrValue =
            opts.atrSeries && opts.atrSeries[index] !== undefined
                ? opts.atrSeries[index]
                : atrIndicator.atr(candles, atrCfg.period, i);
        if (atrValue === null || atrValue <= 0) {
            return; // 数据不足
        }

        var direction = candle.close > candle.open ? 'BULLISH' : 'BEARISH';
        var bodyRatio = body / range;
        var rangeAtr = range / atrValue;
        var bodyAtr = body / atrValue;
        var closeExtremeRatio =
            direction === 'BULLISH'
                ? (candle.close - candle.low) / range
                : (candle.high - candle.close) / range;

        var score = 0;
        if (bodyRatio >= cfg.bodyRatioThreshold) {
            score++;
        }
        if (rangeAtr >= cfg.rangeAtrThreshold) {
            score++;
        }
        if (bodyAtr >= cfg.bodyAtrThreshold) {
            score++;
        }
        if (closeExtremeRatio >= cfg.closeExtremeThreshold) {
            score++;
        }
        var sameMss = mssByIndex[index] && mssByIndex[index].length > 0;
        if (sameMss) {
            score++;
        }

        if (score >= cfg.minScore) {
            results.push({
                id: symbol + ':' + timeframe + ':DISPLACEMENT:' + direction + ':' + candle.openTime,
                symbol: symbol,
                timeframe: timeframe,
                type: 'DISPLACEMENT',
                direction: direction,
                occurredAt: candle.openTime,
                confirmedAt: candle.closeTime,
                candleIndex: index,
                price: candle.close,
                source: {
                    candle: {
                        open: candle.open,
                        high: candle.high,
                        low: candle.low,
                        close: candle.close
                    }
                },
                metadata: {
                    body: round4(body),
                    range: round4(range),
                    bodyRatio: round4(bodyRatio),
                    atr: round4(atrValue),
                    rangeAtr: round4(rangeAtr),
                    bodyAtr: round4(bodyAtr),
                    closeExtremeRatio: round4(closeExtremeRatio),
                    score: score,
                    maxScore: cfg.maxScore,
                    mssEventId: sameMss ? mssByIndex[index][0].id : null
                }
            });
        }
    });

    return results;
}

function round4(n) {
    return Math.round(n * 10000) / 10000;
}

module.exports = {
    detectDisplacement: detectDisplacement
};
