/**
 * Phase 11L.10 — Liquidity Relevance Audit（Recency × Significance × Post-sweep behavior）
 *
 * 背景（用户 2026-08-19/20）：真实 Live 连续两个反例——
 *   ZEC：22 bars（110 分钟）普通 SWING_LOW
 *   ACE：13 bars（65 分钟）普通 SWING_LOW，且 sweep 后价格已围绕/穿越 0.1882 交易很久、结构已发展
 * 结论："最近 48 根出现过方向匹配 Sweep" ≠ "这个 Sweep 对当前 Delivery 仍有解释力"。
 * 纯 recency（距离多少 bars）不够，必须三维一起看：
 *
 * ① Recency（距离 leg.startIndex 的 bars）：
 *   INSIDE / 1-3 / 4-6 / 7-12 / 13-24 / 25-48 / NONE
 *
 * ② Source significance（liquidity 类型权重）：
 *   SIGNIFICANT = EQL / EQH / PDH / PDL / SESSION（ASIA/LONDON/NEW_YORK/PWH/PWL）
 *   SWING       = SWING_HIGH / SWING_LOW（普通 swing，ICT 语义上权重最低）
 *   OTHER       = 其余（UNKNOWN 等）
 *   NONE        = 无关联
 *   —— 普通小 swing low ≠ meaningful SSL pool，不应与 EQL/PDL/Session 同权重。
 *
 * ③ Post-sweep behavior（sweep 后价格行为 —— 最接近"仍属当前 Narrative？"）：
 *   IMMEDIATE_REJECTION : sweep 后第一根收盘即 reclaim，且 leg 前从未再穿越 sweep 价
 *                         （raid → rejection → repricing）
 *   RE_CROSS            : sweep 后价格又插回/收在 sweep 价另一侧（prolonged trading /
 *                          re-cross —— 普通 swing violation）
 *   ADJACENT            : sweep 在 leg 内或紧邻 leg 前一根（无中间观察窗口）
 *   DELAYED_RECLAIM     : 未立即 reclaim 但也无再穿越（横盘后收回）
 *   NO_SWEEP            : 无关联
 *   UNKNOWN             : 数据不足
 *
 * 输出：
 *   A. Recency × Source 交叉表（n / NearHit1h / MFE）
 *   B. Post-sweep behavior 分布（n / NearHit30m / NearHit1h / MFE / MAE）
 *   C. NONE 对照
 *
 * 纯诊断：不改 48 bars、不改通知、不让 Sweep 参与 HIGH。
 */
var liquidityRecencyAudit = require('./liquidityRecencyAudit');

/**
 * sourceType → significance 组
 */
function sourceGroupOf(sourceType) {
    var t = String(sourceType || '').toUpperCase();
    if (t === 'EQL' || t === 'EQH') return 'SIGNIFICANT';
    if (t === 'PDH' || t === 'PDL' || t === 'PWH' || t === 'PWL') return 'SIGNIFICANT';
    if (t.indexOf('ASIA') === 0 || t.indexOf('LONDON') === 0 || t.indexOf('NEW_YORK') === 0) return 'SIGNIFICANT';
    if (t === 'SWING_HIGH' || t === 'SWING_LOW') return 'SWING';
    if (t === '' || t === 'UNKNOWN') return 'OTHER';
    return 'OTHER';
}

/**
 * Post-sweep behavior 分类（启发式第一版，先看分布）。
 * @param {Object} alert buildAlerts 输出（liquidityContext.immediateSweep / direction / legStartIndex）
 * @param {Array} candles 5m candles
 * @returns {string} IMMEDIATE_REJECTION | RE_CROSS | ADJACENT | DELAYED_RECLAIM | NO_SWEEP | UNKNOWN
 */
function classifyPostSweepBehavior(alert, candles) {
    var ctx = alert && alert.liquidityContext;
    var sw = ctx && ctx.immediateSweep;
    if (!sw) return 'NO_SWEEP';
    var s = sw.candleIndex;
    var p = sw.sourcePrice;
    var legStart = alert && alert.legStartIndex;
    if (typeof s !== 'number' || typeof p !== 'number' || typeof legStart !== 'number') return 'UNKNOWN';
    var bullish = alert.direction === 'BULLISH';
    // sweep 在 leg 内或紧邻 leg 前一根 → 无中间观察窗口
    if (s >= legStart || s + 1 >= legStart) return 'ADJACENT';
    var first = candles[s + 1];
    if (!first) return 'ADJACENT';
    var firstClose = first.close;
    // 第一根（s+1）是 sweep 的延续（从 sweep 价另一侧起涨/起跌），其 low/high 不算 re-cross；
    // 从 s+2 起检查是否又插回 sweep 价另一侧。
    var reCross = false;
    for (var j = s + 2; j < legStart; j++) {
        var c = candles[j];
        if (!c) continue;
        if (bullish) {
            if (c.low < p) reCross = true;   // 又插回 sweep 价下方（对 SSL）
        } else {
            if (c.high > p) reCross = true;  // 又插回 sweep 价上方（对 BSL）
        }
    }
    var reclaimed = bullish ? firstClose >= p : firstClose <= p;
    if (reclaimed && !reCross) return 'IMMEDIATE_REJECTION';
    if (reCross) return 'RE_CROSS';
    return 'DELAYED_RECLAIM';
}

/**
 * 统计单一样本的一组指标（通知后 availableIndex+1 起；notificationPrice 基准）。
 */
function statOne(alert, candles, windows) {
    var availIdx = alert.availableIndex !== undefined && alert.availableIndex !== null ? alert.availableIndex : alert.anchorIndex;
    var start = availIdx !== null && availIdx !== undefined ? availIdx + 1 : null;
    if (start === null || start >= candles.length) return null;
    var basePrice = alert.notificationPrice !== undefined && alert.notificationPrice !== null ? alert.notificationPrice : alert.anchorPrice;
    var hitTarget = alert.notificationNearTarget !== undefined && alert.notificationNearTarget !== null ? alert.notificationNearTarget : alert.nearTarget;
    var bullish = alert.direction === 'BULLISH';
    var out = { mfe: 0, mae: 0, near30: false, near1h: false };
    windows.forEach(function (w) {
        var lastJ = Math.min(start + w.bars - 1, candles.length - 1);
        var hit = false;
        for (var j = start; j <= lastJ; j++) {
            var c = candles[j];
            if (!c) break;
            if (bullish) {
                if (c.high - basePrice > out.mfe) out.mfe = c.high - basePrice;
                if (basePrice - c.low > out.mae) out.mae = basePrice - c.low;
                if (hitTarget !== null && hitTarget !== undefined && c.high >= hitTarget) hit = true;
            } else {
                if (basePrice - c.low > out.mfe) out.mfe = basePrice - c.low;
                if (c.high - basePrice > out.mae) out.mae = c.high - basePrice;
                if (hitTarget !== null && hitTarget !== undefined && c.low <= hitTarget) hit = true;
            }
        }
        if (w.key === '30m') out.near30 = hit;
        else out.near1h = hit;
    });
    return out;
}

/**
 * 三维度 Relevance Audit（HIGH 母样本）。
 * @param {Array} alerts buildAlerts 输出
 * @param {Array} candles 5m candles
 * @returns {Object} {
 *   cross:  { ROW: { n, nearHit1h, nearCnt1h, mfeSum, mfeCnt } }  ROW = '<group>|<bucket>'（'NONE' 单行）
 *   crossOrder: [...],
 *   behavior: { KEY: { n, nearHit30m, nearCnt30m, nearHit1h, nearCnt1h, mfeSum, maeSum, mfeCnt } }
 *   behaviorOrder: [...]
 * }
 */
function auditRelevance(alerts, candles) {
    var windows = [{ key: '30m', bars: 6 }, { key: '1h', bars: 12 }];
    var cross = {};
    var crossOrder = [];
    var behavior = {};
    var behaviorOrder = ['IMMEDIATE_REJECTION', 'RE_CROSS', 'ADJACENT', 'DELAYED_RECLAIM', 'UNKNOWN', 'NO_SWEEP'];

    function accCross(row) {
        if (!cross[row]) {
            cross[row] = { n: 0, nearHit1h: 0, nearCnt1h: 0, mfeSum: 0, mfeCnt: 0 };
            crossOrder.push(row);
        }
        return cross[row];
    }
    function accBehavior(k) {
        if (!behavior[k]) {
            behavior[k] = { n: 0, nearHit30m: 0, nearCnt30m: 0, nearHit1h: 0, nearCnt1h: 0, mfeSum: 0, maeSum: 0, mfeCnt: 0 };
        }
        return behavior[k];
    }

    (alerts || []).forEach(function (al) {
        if (!al || al.tier !== 'HIGH_QUALITY') return;
        var ctx = al.liquidityContext;
        var sw = ctx && ctx.immediateSweep;
        // ① recency（复用 recency audit 的桶）
        var bars = sw ? sw.barsBeforeLegStart : null;
        var recencyBucket = liquidityRecencyAudit.bucketOf(bars);
        // ② significance
        var group = sw ? sourceGroupOf(sw.sourceType) : 'NONE';
        var row = group === 'NONE' ? 'NONE' : group + '|' + recencyBucket;
        var c = accCross(row);
        // ③ behavior
        var bh = classifyPostSweepBehavior(al, candles);
        var b = accBehavior(bh);

        var st = statOne(al, candles, windows);
        c.n++;
        b.n++;
        if (st) {
            if (al.notificationNearTarget !== null && al.notificationNearTarget !== undefined) {
                c.nearCnt1h++;
                if (st.near1h) c.nearHit1h++;
                b.nearCnt30m++;
                b.nearCnt1h++;
                if (st.near30) b.nearHit30m++;
                if (st.near1h) b.nearHit1h++;
            }
            c.mfeSum += st.mfe / (al.notificationPrice || al.anchorPrice) * 100;
            c.mfeCnt++;
            b.mfeSum += st.mfe / (al.notificationPrice || al.anchorPrice) * 100;
            b.maeSum += st.mae / (al.notificationPrice || al.anchorPrice) * 100;
            b.mfeCnt++;
        }
    });
    return { cross: cross, crossOrder: crossOrder, behavior: behavior, behaviorOrder: behaviorOrder };
}

module.exports = {
    auditRelevance: auditRelevance,
    sourceGroupOf: sourceGroupOf,
    classifyPostSweepBehavior: classifyPostSweepBehavior
};
