/**
 * Phase 11D.9 — Delivery Alignment Audit
 *
 * 人工复核结论（#6/#8/#9 false-directional、#10 local-valid、#3/#5/#7 delivery-aligned）：
 *   Opportunity Quality（MSS×Leg×Near Draw → tier）≠ Direction Quality。
 *   HIGH_QUALITY 实际是 HIGH_QUALITY_LOCAL_OPPORTUNITY，不是 HIGH_CONFIDENCE_DIRECTION。
 *
 * 本模块回答：当 5m MSS → strong DisplacementLeg → FVG → Near Draw 出现时，
 * 什么条件区分"主导 Delivery"（A 类）与"局部 impulse"（B/C 类）？
 *
 * 四个审计维度（用户指定优先级）：
 *   1. HTF narrative alignment —— 1h/4h 已收盘趋势方向 + bias 方向 vs 机会方向
 *   2. Sweep 层级 —— 信号前 liquidity sweep 的 timeframe（5m/15m/1h/4h+）
 *   3. MSS 是否改变 dealing range delivery —— leg 完成后回撤是否守住 leg 起点
 *      （deliveryHold：12 根内低点未破 leg 起点 low = 未回吐整个 leg）
 *   4. Continuation / Acceptance —— leg 后是否创 leg 新高且 close 保持（12 根）
 *
 * 输出三分类（对齐人工 A/B/C）：
 *   DELIVERY_ALIGNED    ①HTF 同向 且 ③deliveryHold 且 ④continuation
 *   FALSE_DIRECTIONAL   !①HTF 同向（主导方向相反 → 局部 impulse）
 *   LOCAL_VALID         其余（结构成立但未形成持续主导 delivery）
 */
var WINDOW_BARS = 12; // 1h

/**
 * 对单个 alert 计算 alignment 维度 + 1h 方向表现。
 * @param {Object} al buildAlerts 输出（含 dispId/legStartIndex/nearTarget/anchorIndex/anchorPrice/direction）
 * @param {Array} candles 5m candles
 * @param {Object} legByDispId dispId → leg（含 startIndex/endIndex/rangeAtr）
 * @param {Array} biasTrace 逐根 { direction, confidence }
 * @param {Array} htfTrendTrace 逐根 { h1Up, h4Up }
 * @returns {Object|null} { htfAlign: { bias, h1, h4, score }, sweepTf, sweepLevel,
 *                          deliveryHold, continuation, deliveryClass, dirHit1h, nearHit1h, mfe1h }
 */
function analyzeDeliveryAlignment(al, candles, legByDispId, biasTrace, htfTrendTrace) {
    var anchor = al.anchorIndex;
    if (anchor === null || anchor === undefined) return null;
    var bullish = al.direction === 'BULLISH';

    // ---- 1. HTF alignment（bias + 1h/4h 趋势）----
    var b = biasTrace && biasTrace[anchor] ? biasTrace[anchor] : null;
    var h = htfTrendTrace && htfTrendTrace[anchor] ? htfTrendTrace[anchor] : { h1Up: null, h4Up: null };
    var biasAlign = b && b.direction
        ? (bullish ? b.direction.indexOf('BULLISH') !== -1 : b.direction.indexOf('BEARISH') !== -1)
        : null;
    var h1Align = h.h1Up === null || h.h1Up === undefined ? null : (h.h1Up === bullish);
    var h4Align = h.h4Up === null || h.h4Up === undefined ? null : (h.h4Up === bullish);
    var alignScore = [biasAlign, h1Align, h4Align].reduce(function (s, x) { return s + (x === true ? 1 : 0); }, 0);
    var alignCount = [biasAlign, h1Align, h4Align].filter(function (x) { return x !== null; }).length;
    var htfAlign = { bias: biasAlign, h1: h1Align, h4: h4Align, score: alignScore, count: alignCount };

    // ---- 2. Sweep 层级 ----
    var sweepTf = al.sweep && al.sweep.timeframe ? al.sweep.timeframe : null;
    var sweepLevel = 'NONE';
    if (sweepTf) {
        var tfMin = parseInt(sweepTf, 10) || 0;
        sweepLevel = tfMin >= 60 ? 'HTF(1h+)' : (tfMin >= 15 ? 'MID(15m)' : '5M');
    }

    // ---- 3. deliveryHold：leg 完成后 12 根内低点（BULLISH）守住 leg 起点 low ----
    var leg = al.dispId ? (legByDispId[al.dispId] || null) : null;
    var legStartLow = null;
    var legStartIdx = al.legStartIndex;
    if (legStartIdx !== null && legStartIdx !== undefined && candles[legStartIdx]) {
        legStartLow = candles[legStartIdx].low;
    }
    var start = anchor + 1;
    var lastJ = Math.min(start + WINDOW_BARS - 1, candles.length - 1);
    var minLow = Infinity;
    var maxHigh = -Infinity;
    for (var j = start; j <= lastJ; j++) {
        var c = candles[j];
        if (!c) break;
        if (c.low < minLow) minLow = c.low;
        if (c.high > maxHigh) maxHigh = c.high;
    }
    var legEndHigh = null;
    var legEndIdx = leg ? leg.endIndex : null;
    if (legEndIdx !== null && legEndIdx !== undefined && candles[legEndIdx]) {
        legEndHigh = candles[legEndIdx].high;
    }
    var deliveryHold = (legStartLow !== null) && (minLow !== Infinity) ? (minLow >= legStartLow) : null;

    // ---- 4. continuation：12 根内创 leg 后新高（BULLISH: maxHigh > leg end high）----
    var continuation = (legEndHigh !== null) && (maxHigh !== -Infinity) ? (maxHigh > legEndHigh) : null;

    // ---- 分类 ----
    var deliveryClass;
    var htfSame = htfAlign.count > 0 && htfAlign.score === htfAlign.count;
    if (htfSame === true && deliveryHold === true && continuation === true) {
        deliveryClass = 'DELIVERY_ALIGNED';
    } else if (htfSame === false) {
        deliveryClass = 'FALSE_DIRECTIONAL';
    } else {
        deliveryClass = 'LOCAL_VALID';
    }

    // ---- 1h 方向表现（dirHit = 窗口结束 close 净涨跌；nearHit / mfe）----
    var anchorPrice = al.anchorPrice;
    var endClose = candles[lastJ] ? candles[lastJ].close : anchorPrice;
    var net = bullish ? endClose - anchorPrice : anchorPrice - endClose;
    var mfe = 0;
    var nearHit = false;
    for (var k = start; k <= lastJ; k++) {
        var ck = candles[k];
        if (!ck) break;
        if (bullish) {
            if (ck.high - anchorPrice > mfe) mfe = ck.high - anchorPrice;
            if (al.nearTarget !== null && al.nearTarget !== undefined && ck.high >= al.nearTarget) nearHit = true;
        } else {
            if (anchorPrice - ck.low > mfe) mfe = anchorPrice - ck.low;
            if (al.nearTarget !== null && al.nearTarget !== undefined && ck.low <= al.nearTarget) nearHit = true;
        }
    }

    return {
        htfAlign: htfAlign,
        sweepTf: sweepTf,
        sweepLevel: sweepLevel,
        deliveryHold: deliveryHold,
        continuation: continuation,
        deliveryClass: deliveryClass,
        dirHit1h: net > 0,
        nearHit1h: nearHit,
        mfe1h: mfe / anchorPrice * 100
    };
}

/**
 * 汇总：按 delivery class / HTF alignment / sweep 层级统计 1h dirHit。
 * @param {Array} rows analyzeDeliveryAlignment 输出（过滤 null）
 * @returns {Object} { byClass, byHtfScore, bySweepLevel, total }
 */
function assessDeliveryClasses(rows) {
    var out = { byClass: {}, byHtfScore: {}, bySweepLevel: {}, total: 0 };
    function acc(container, key) {
        if (!container[key]) {
            container[key] = { n: 0, dirHit: 0, nearHit: 0, nearCnt: 0, mfeSum: 0 };
        }
        return container[key];
    }
    (rows || []).forEach(function (r) {
        if (!r) return;
        out.total++;
        var c = acc(out.byClass, r.deliveryClass);
        c.n++; if (r.dirHit1h) c.dirHit++; if (r.nearHit1h) c.nearHit++; c.nearCnt++; c.mfeSum += r.mfe1h;
        var hs = acc(out.byHtfScore, r.htfAlign.score + '/' + r.htfAlign.count);
        hs.n++; if (r.dirHit1h) hs.dirHit++;
        var sl = acc(out.bySweepLevel, r.sweepLevel || 'NONE');
        sl.n++; if (r.dirHit1h) sl.dirHit++;
    });
    return out;
}

module.exports = {
    analyzeDeliveryAlignment: analyzeDeliveryAlignment,
    assessDeliveryClasses: assessDeliveryClasses,
    WINDOW_BARS: WINDOW_BARS
};
