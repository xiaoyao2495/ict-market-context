/**
 * FVG Detector（Phase 9.1）
 *
 * 三根 K 线 FVG：
 *   Bullish FVG：candle[i-2].high < candle[i].low
 *     zoneLow  = candle[i-2].high
 *     zoneHigh = candle[i].low
 *   Bearish FVG：candle[i-2].low > candle[i].high
 *     zoneLow  = candle[i].high
 *     zoneHigh = candle[i-2].low
 *
 * 规则：
 * - 只处理已收盘 candle；confirmedAt = candle[i].closeTime（绝不使用 openTime / 未来 candle）
 * - minGap = max(tickSize * minTickMultiplier, ATR * minAtrMultiplier)
 *   tickSize / ATR 缺失时允许使用可用项；两者都缺失用 percentage fallback
 * - Displacement association（可选）：方向匹配 + displacement.confirmedAt <= FVG confirmedAt
 *   + candleIndex 距离 <= maxDisplacementBars（同 candle 优先）
 *
 * 注意：FVG 不是独立信号。无 displacement 的 FVG 也会生成（quality 低），
 * 但 Entry Gate 只接受 displacementEventId 非空且 score >= threshold 的 FVG。
 */
var thresholds = require('../config/thresholds');
var atrIndicator = require('../indicators/atr');

/**
 * 计算 minGap（tickSize / ATR 缺项互降，都缺用 percentage fallback）
 * @param {number} price 参考价格（FVG 中心）
 * @param {number|null} tickSize
 * @param {number|null} atrValue
 * @param {Object} cfg
 */
function minGapFor(price, tickSize, atrValue, cfg) {
    var d = cfg.minGap || cfg.detector && cfg.detector.minGap || {};
    var parts = [];
    if (tickSize) {
        parts.push(tickSize * (d.tickMultiplier !== undefined ? d.tickMultiplier : 2));
    }
    if (atrValue) {
        parts.push(atrValue * (d.atrMultiplier !== undefined ? d.atrMultiplier : 0.05));
    }
    if (parts.length === 0) {
        return price * (d.percentageFallback !== undefined ? d.percentageFallback : 0.00005);
    }
    return Math.max.apply(null, parts);
}

/**
 * 关联 displacement 事件
 * @param {Array} displacements 已确认 displacement 事件
 * @param {string} direction FVG 方向
 * @param {number} candleIndex FVG 第三根 candle 索引
 * @param {number} maxBars 最大允许距离
 * @param {number} fvgConfirmedAt FVG 的 confirmedAt（displacement 必须不晚于它）
 * @returns {Object|null} { event, barsAway }（同 candle 优先）
 */
function associateDisplacement(displacements, direction, candleIndex, maxBars, fvgConfirmedAt) {
    if (!displacements || displacements.length === 0) {
        return null;
    }
    var candidates = displacements.filter(function (d) {
        if (d.direction !== direction) {
            return false;
        }
        if (d.candleIndex > candleIndex) {
            return false; // displacement 必须在 FVG 之前或同 candle
        }
        if (fvgConfirmedAt !== undefined && d.confirmedAt > fvgConfirmedAt) {
            return false; // 防未来数据：displacement 必须已确认
        }
        return candleIndex - d.candleIndex <= maxBars;
    });
    if (candidates.length === 0) {
        return null;
    }
    // 同 candle 优先，其次最近
    candidates.sort(function (a, b) {
        var da = candleIndex - a.candleIndex;
        var db = candleIndex - b.candleIndex;
        if (da !== db) {
            return da - db;
        }
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    var best = candidates[0];
    return {
        event: best,
        barsAway: candleIndex - best.candleIndex
    };
}

/**
 * 检测 FVG
 * @param {Array} candles 已收盘 candle（时间升序）
 * @param {Object} [options] {
 *   evaluationTime, symbol, timeframe, tickSize,
 *   displacements: displacement 事件数组,
 *   thresholds
 * }
 * @returns {Array} FVG 对象数组
 */
function detectFvg(candles, options) {
    var opts = options || {};
    var symbol = opts.symbol || (candles[0] && candles[0].symbol) || 'UNKNOWN';
    var timeframe = opts.timeframe || '5m';
    var evaluationTime =
        opts.evaluationTime !== undefined ? opts.evaluationTime : Date.now();
    var cfg = opts.thresholds || thresholds;
    var fCfg = cfg.fvg || cfg;
    var displacements = opts.displacements || [];
    // Phase 11R.1：增量模式支持全局索引（tail 切片时 candleIndex/位移关联必须用全局索引）
    var baseIndex = opts.baseIndex || 0;
    var results = [];

    if (!candles || candles.length < 3) {
        return results;
    }

    // ATR 序列：优先外部增量 ATR（全局索引），否则内部构建（基于传入 candles）
    var period = 14;
    var atrSeries = {};
    var k;
    for (k = period; k < candles.length; k++) {
        var v = atrIndicator.atr(candles, period, k);
        if (v !== null && v !== undefined) {
            atrSeries[k] = v;
        }
    }
    var atrAt = function (globalIndex) {
        if (opts.atrSeries && opts.atrSeries[globalIndex] !== undefined) {
            return opts.atrSeries[globalIndex];
        }
        return atrSeries[globalIndex - baseIndex] !== undefined
            ? atrSeries[globalIndex - baseIndex]
            : null;
    };

    var i;
    for (i = 2; i < candles.length; i++) {
        var globalIndex = baseIndex + i;
        var c0 = candles[i - 2];
        var c1 = candles[i - 1];
        var c2 = candles[i];

        if (c0.closed === false || c1.closed === false || c2.closed === false) {
            continue; // 只处理已收盘 candle
        }
        if (c2.closeTime > evaluationTime) {
            continue; // 防未来数据：未到 evaluationTime 不生成
        }

        var direction = null;
        var zoneLow = null;
        var zoneHigh = null;

        if (c0.high < c2.low) {
            direction = 'BULLISH';
            zoneLow = c0.high;
            zoneHigh = c2.low;
        } else if (c0.low > c2.high) {
            direction = 'BEARISH';
            zoneLow = c2.high;
            zoneHigh = c0.low;
        } else {
            continue; // 无缺口
        }

        var midpoint = (zoneLow + zoneHigh) / 2;
        var gapSize = zoneHigh - zoneLow;
        var price = midpoint;
        var gapPct = price > 0 ? gapSize / price : 0;

        var atrValue = atrAt(globalIndex - 1);
        var gapAtr = atrValue ? gapSize / atrValue : 0;
        var minGap = minGapFor(price, opts.tickSize, atrValue, fCfg);
        if (gapSize < minGap) {
            continue; // gap 低于阈值，拒绝
        }

        // displacement association（用全局索引）
        var assoc = associateDisplacement(
            displacements,
            direction,
            globalIndex,
            fCfg.maxDisplacementBars !== undefined
                ? fCfg.maxDisplacementBars
                : 2,
            c2.closeTime
        );

        results.push({
            id: symbol + ':' + timeframe + ':FVG:' + direction + ':' + c2.openTime,
            symbol: symbol,
            timeframe: timeframe,
            direction: direction,
            zoneLow: round4(zoneLow),
            zoneHigh: round4(zoneHigh),
            midpoint: round4(midpoint),
            gapSize: round4(gapSize),
            gapPct: round4(gapPct),
            gapAtr: round4(gapAtr),
            createdAt: c2.openTime,
            confirmedAt: c2.closeTime,
            candleIndex: globalIndex,
            status: 'ACTIVE',
            touchedAt: null,
            midpointTouchedAt: null,
            filledAt: null,
            invalidatedAt: null,
            displacementEventId: assoc ? assoc.event.id : null,
            metadata: {
                displacementBarsAway: assoc ? assoc.barsAway : null,
                displacementConfirmedAt: assoc ? assoc.event.confirmedAt : null,
                displacementMetadata: assoc ? assoc.event.metadata : null,
                minGapUsed: round4(minGap),
                atr: atrValue ? round4(atrValue) : null,
                source: (candles[0] && candles[0].source) || null
            }
        });
    }

    return results;
}

function round4(n) {
    return Math.round(n * 10000) / 10000;
}

module.exports = {
    detectFvg: detectFvg,
    minGapFor: minGapFor,
    associateDisplacement: associateDisplacement
};
