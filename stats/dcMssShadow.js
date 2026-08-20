/**
 * Phase 12.3 — DC Structural Swing MSS Shadow（V1：ATR DC 1.0 + close confirmation）
 *
 * 背景（用户 2026-08-20 定案）：Legacy MSS 保持 authoritative，DC MSS 纯 shadow。
 *   并行跑两套结构：
 *     LEGACY : 2-2 LOCAL_PIVOT → legacy swing → legacy MSS（detectMss 全量离线跑，与 replay 口径一致）
 *     SHADOW : ATR DC 1.0 + close → DC structural swing → DC MSS（同一 detectMss、同一 cfg）
 *   比较顺序：先 Structure Quality（churn / 密度 / break 质量），再 Delivery Quality
 *   （displacement 命中 / MFE / MAE），最后才考虑是否进入 HIGH。
 *
 * 【future-safety（用户强制，专项测试锁定）】
 *   DC swing.confirmedAt = reversal close 达 1 ATR 的 bar closeTime；
 *   detectMss.candidateReferences 只允许 confirmedAt <= evalTime（candle.closeTime）的 reference →
 *   swing 确认之前的价格越位不会产生 MSS。测试验证：swing 未确认时无 MSS，
 *   且所有 MSS 的 referenceSwing.confirmedAt <= 该 MSS candle 的 closeTime。
 *
 * 纯诊断：pivotDetector / swingLiquidity / mssDetector / 生产所有消费方零改动。
 */
var mssDetector = require('../events/mssDetector');
var directionalChangeAudit = require('./directionalChangeAudit');

var DEFAULT_K = 1.0;
var CHURN_BARS = 6;   // 30min（5m bar）
var DELIVERY_BARS = 12; // 1h

/**
 * DC swings → mssDetector 兼容格式（{ id, type: SWING_HIGH/LOW, confirmedAt, price }）。
 * direction 映射：DC 'HIGH' → 'SWING_HIGH'（MSS reference 按该 type 过滤）。
 * 【confirmedAt 必须转为时间戳】buildDcSwings 的 occurredAt/confirmedAt 是 bar index，
 * 而 detectMss 的 evalTime = candle.closeTime（ms）→ 必须用 candles[index].closeTime 转换，
 * 否则 future-safety 检查（confirmedAt <= evalTime）完全失效。
 */
function packageDcSwings(dcSwings, symbol, timeframe, candles) {
    return (dcSwings || []).map(function (s) {
        var type = s.direction === 'HIGH' ? 'SWING_HIGH' : 'SWING_LOW';
        var confTs = candles && candles[s.confirmedAt] ? candles[s.confirmedAt].closeTime : s.confirmedAt;
        return {
            id: (symbol || 'X') + ':DC:' + type + ':' + confTs + ':' + s.extremeIndex,
            symbol: symbol || 'X',
            timeframe: timeframe || '5m',
            type: type,
            side: type === 'SWING_HIGH' ? 'BSL' : 'SSL',
            price: s.price,
            confirmedAt: confTs,
            metadata: {
                source: 'dc',
                dcK: s.dcK !== undefined ? s.dcK : DEFAULT_K,
                replacements: s.replacements,
                extremeIndex: s.extremeIndex,
                occurredAt: s.occurredAt,
                extremeATR: s.extremeATR,
                index: s.extremeIndex // classifyMssReference 依赖（referenceAgeBars/wasLatestOpposingSwing）
            }
        };
    });
}

/**
 * 对一套 swings 跑 detectMss（离线全量，consumedRefs 独立）。
 * @returns {Array} MSS events
 */
function runMss(candles, swings, symbol, timeframe) {
    return mssDetector.detectMss(candles, swings, {
        symbol: symbol,
        timeframe: timeframe,
        consumedRefs: {}
    });
}

/**
 * 构建两套 MSS（legacy + DC shadow）。
 * @param {Array} candles
 * @param {Array} legacySwings replay result.swings（2-2 LOCAL_PIVOT 包装）
 * @param {Object} [opts] { k, symbol, timeframe }
 * @returns {Object} { legacy: { swings, mss }, dc: { swings, mss }, k }
 */
function buildDcMss(candles, legacySwings, opts) {
    var o = opts || {};
    var k = o.k !== undefined ? o.k : DEFAULT_K;
    var symbol = o.symbol || (legacySwings[0] && legacySwings[0].symbol) || 'X';
    var timeframe = o.timeframe || '5m';

    var dcRaw = directionalChangeAudit.buildDcSwings(candles, k, { confirmWith: 'close' });
    var dcSwings = packageDcSwings(dcRaw, symbol, timeframe, candles);

    return {
        legacy: {
            swings: legacySwings || [],
            mss: runMss(candles, legacySwings || [], symbol, timeframe)
        },
        dc: {
            swings: dcSwings,
            mss: runMss(candles, dcSwings, symbol, timeframe)
        },
        k: k
    };
}

function medianSorted(arr) {
    if (arr.length === 0) return null;
    var a = arr.slice().sort(function (x, y) { return x - y; });
    var mid = Math.floor(a.length / 2);
    if (a.length % 2 === 1) return a[mid];
    return (a[mid - 1] + a[mid]) / 2;
}
function mean(arr) {
    if (arr.length === 0) return null;
    var s = 0;
    for (var i = 0; i < arr.length; i++) s += arr[i];
    return s / arr.length;
}

/**
 * Structure Quality 统计（MSS 事件本身）。
 * @param {Array} mssEvents 按 candleIndex 升序
 * @param {number} days
 * @returns {Object} {
 *   n, perDay, bull, bear, refSwingCount, gapMedian, gapMean,
 *   churnFlips, churnRate, churnClusters, sameDirShort,
 *   breakPctMedian, bodyRatioMedian, closeStrengthMedian
 * }
 */
function structureStats(mssEvents, days) {
    var n = mssEvents.length;
    var bull = 0;
    var bear = 0;
    var refIds = {};
    var gaps = [];
    var flips = 0;
    var sameDirShort = 0;
    var breakPcts = [];
    var bodyRatios = [];
    var closeStrengths = [];

    var sorted = mssEvents.slice().sort(function (a, b) { return a.candleIndex - b.candleIndex; });
    for (var i = 0; i < sorted.length; i++) {
        var m = sorted[i];
        if (m.direction === 'BULLISH') bull++;
        else bear++;
        if (m.source && m.source.referenceSwingId) refIds[m.source.referenceSwingId] = true;
        if (m.source && typeof m.source.breakPct === 'number') breakPcts.push(m.source.breakPct);
        if (m.metadata && typeof m.metadata.bodyRatio === 'number') bodyRatios.push(m.metadata.bodyRatio);
        if (m.metadata && typeof m.metadata.closeStrength === 'number') closeStrengths.push(m.metadata.closeStrength);
        if (i > 0) {
            var gap = sorted[i].candleIndex - sorted[i - 1].candleIndex;
            gaps.push(gap);
            var sameDir = sorted[i].direction === sorted[i - 1].direction;
            if (!sameDir && gap <= CHURN_BARS) flips++;
            if (sameDir && gap <= CHURN_BARS) sameDirShort++;
        }
    }

    // churn 簇：连续 >= 3 个 MSS，方向严格交替且相邻间隔 <= CHURN_BARS
    var clusters = 0;
    var run = 1;
    for (var j = 1; j < sorted.length; j++) {
        var gapJ = sorted[j].candleIndex - sorted[j - 1].candleIndex;
        var flipJ = sorted[j].direction !== sorted[j - 1].direction;
        if (flipJ && gapJ <= CHURN_BARS) {
            run++;
        } else {
            if (run >= 3) clusters++;
            run = 1;
        }
    }
    if (run >= 3) clusters++;

    return {
        n: n,
        perDay: days > 0 ? n / days : 0,
        bull: bull,
        bear: bear,
        refSwingCount: Object.keys(refIds).length,
        gapMedian: medianSorted(gaps),
        gapMean: mean(gaps),
        churnFlips: flips,
        churnRate: n > 1 ? flips / (n - 1) : 0,
        churnClusters: clusters,
        sameDirShort: sameDirShort,
        breakPctMedian: medianSorted(breakPcts),
        bodyRatioMedian: medianSorted(bodyRatios),
        closeStrengthMedian: medianSorted(closeStrengths)
    };
}

/**
 * Delivery Quality 统计（MSS 后 1h 价格/事件路径）。
 * @param {Array} mssEvents
 * @param {Array} candles
 * @param {Object} idx { dispByIndex（legacy displacement 事件按 candleIndex）, legByDispId }
 * @returns {Object} { dispStrongRate, mfeMean, maeMean, nextSameDirMssRate }
 */
function deliveryStats(mssEvents, candles, idx) {
    var n = mssEvents.length;
    if (n === 0) {
        return { n: 0, dispStrongRate: null, mfeMean: null, maeMean: null, nextSameDirMssRate: null };
    }
    var mssByIndex = {};
    mssEvents.forEach(function (m) {
        if (typeof m.candleIndex !== 'number') return;
        if (!mssByIndex[m.candleIndex]) mssByIndex[m.candleIndex] = [];
        mssByIndex[m.candleIndex].push(m);
    });
    var dispHit = 0;
    var nextHit = 0;
    var mfeSum = 0;
    var maeSum = 0;
    var cnt = 0;
    var endIdx = candles.length - 1;

    mssEvents.forEach(function (m) {
        var s = m.candleIndex;
        if (typeof s !== 'number') return;
        var base = candles[s] ? candles[s].close : null;
        var dir = m.direction;
        var mfe = 0;
        var mae = 0;
        var hasNext = false;
        var end = Math.min(s + DELIVERY_BARS, endIdx);
        for (var j = s + 1; j <= end; j++) {
            var c = candles[j];
            if (!c) continue;
            if (base !== null) {
                if (dir === 'BULLISH') {
                    if (c.high - base > mfe) mfe = c.high - base;
                    if (base - c.low > mae) mae = base - c.low;
                } else {
                    if (base - c.low > mfe) mfe = base - c.low;
                    if (c.high - base > mae) mae = base - c.high;
                }
            }
            var dispList = (idx && idx.dispByIndex && idx.dispByIndex[j]) || [];
            for (var d = 0; d < dispList.length; d++) {
                if (dispList[d].direction !== dir) continue;
                var leg = idx.legByDispId && idx.legByDispId[dispList[d].id];
                if (leg && (leg.quality === 'STRONG' || leg.quality === 'EXPLOSIVE')) dispHit++;
            }
            var nextList = mssByIndex[j] || [];
            for (var q = 0; q < nextList.length; q++) {
                if (nextList[q].direction === dir) hasNext = true;
            }
        }
        if (hasNext) nextHit++;
        if (base !== null) {
            mfeSum += mfe / base * 100;
            maeSum += mae / base * 100;
            cnt++;
        }
    });
    return {
        n: n,
        dispStrongRate: n > 0 ? dispHit / n : 0,
        mfeMean: cnt > 0 ? mfeSum / cnt : null,
        maeMean: cnt > 0 ? maeSum / cnt : null,
        nextSameDirMssRate: n > 0 ? nextHit / n : 0
    };
}

module.exports = {
    buildDcMss: buildDcMss,
    packageDcSwings: packageDcSwings,
    runMss: runMss,
    structureStats: structureStats,
    deliveryStats: deliveryStats,
    DEFAULT_K: DEFAULT_K,
    CHURN_BARS: CHURN_BARS,
    DELIVERY_BARS: DELIVERY_BARS
};
