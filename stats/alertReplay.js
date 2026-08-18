/**
 * Phase 11D.8 — Opportunity Alert Validation（历史通知回放）
 *
 * 目的：验证"过去 90 天如果系统已部署，我会收到什么通知、这些通知值不值得看"。
 * 不接钉钉、不写 client —— 先把通知时点、内容、质量全部离线回放。
 *
 * 通知时点 = opportunity 信息完备时刻（最后一个 leg 完成，anchorIndex）：
 *   - 此时 MSS quality / leg quality / near draw / distance 全部可知
 *   - 同一 opportunity 只通知一次（fvgIds 已合并，天然去重）
 * 通知后质量 = 锚后最早 N+1 起 30m(6)/1h(12) 根：
 *   - Near Draw Hit（窗口内触达 near target）
 *   - MFE / MAE（顺向 / 逆向最大幅度，相对 %）
 *
 * 防统计幻觉：Near Draw 距离分层（<0.1 / 0.1-0.25 / 0.25-0.5 / 0.5-1 / >1 %）
 * —— 若 >0.5% 距离桶的 HIGH 仍明显优于 WATCH/LOW，信号才硬。
 */
var opportunityQuality = require('./opportunityQuality');

var WINDOWS = [
    { key: 'w30m', bars: 6 },
    { key: 'w1h', bars: 12 }
];

var DIST_BUCKETS = [
    { key: '<0.1%', min: 0, max: 0.1 },
    { key: '0.1-0.25%', min: 0.1, max: 0.25 },
    { key: '0.25-0.5%', min: 0.25, max: 0.5 },
    { key: '0.5-1%', min: 0.5, max: 1.0 },
    { key: '>1%', min: 1.0, max: Infinity }
];

function distBucketOf(pct) {
    for (var i = 0; i < DIST_BUCKETS.length; i++) {
        var b = DIST_BUCKETS[i];
        if (pct >= b.min && pct < b.max) return b.key;
    }
    return '>1%';
}

/**
 * 构建通知列表（按真实时间顺序 = anchorIndex 升序）。
 * @param {Array} opportunities buildOpportunities 输出
 * @param {Array} fvgs 全部 FVG（含 displacementEventId / zoneLow / zoneHigh）
 * @param {Object} legByDispId dispId → { quality, mssQuality, endIndex, direction, rangeAtr, netMoveAtr, bodyEfficiency, mssId }
 * @param {Array} drawTrace 逐根 { bslNear, bslMacro, sslNear, sslMacro }
 * @param {Array} sweepEvents LIQUIDITY_SWEEP 事件（leg 前窗口内同向最近一个）
 * @param {Array} candles 5m candles（取时间/价格）
 * @param {Array} [mssEvents] MSS 事件（人工核对：referencePrice / breakPct）
 * @returns {Array} alerts [{ id, tier, direction, mssQuality, legQuality, anchorIndex, anchorTime,
 *                           anchorPrice, nearTarget, nearDistPct, fvgCount, fvgIds,
 *                           legRangeAtr, legNetMoveAtr, legBodyEff, mssRefPrice, mssBreakPct,
 *                           sweep: { price, side, barsAgo } | null }]
 */
function buildAlerts(opportunities, fvgs, legByDispId, drawTrace, sweepEvents, candles, mssEvents) {
    var items = opportunityQuality.buildTierIndex(opportunities, fvgs, legByDispId, drawTrace);
    var alerts = [];
    var fvgById = {};
    var mssById = {};
    (fvgs || []).forEach(function (f) { fvgById[f.id] = f; });
    (mssEvents || []).forEach(function (m) { mssById[m.id] = m; });
    items.forEach(function (it) {
        if (!it.hasLeg || it.anchorIndex === null || it.anchorIndex === undefined) return;
        var anchor = candles[it.anchorIndex];
        if (!anchor) return;
        var anchorPrice = anchor.close;
        var nearDistPct = it.nearTarget !== null && it.nearTarget !== undefined && anchorPrice > 0
            ? Math.abs(it.nearTarget - anchorPrice) / anchorPrice * 100
            : null;
        // Sweep 关联：anchorIndex 前 24 根内同方向最近 LIQUIDITY_SWEEP
        // BULLISH ← SSL sweep（side=SSL）；BEARISH ← BSL sweep（side=BSL）
        var wantSide = it.direction === 'BULLISH' ? 'SSL' : 'BSL';
        var sweep = null;
        (sweepEvents || []).forEach(function (se) {
            if (se.side !== wantSide) return;
            if (se.candleIndex === undefined || se.candleIndex >= it.anchorIndex) return;
            if (se.candleIndex < it.anchorIndex - 24) return;
            if (!sweep || se.candleIndex > sweep.candleIndex) {
                sweep = { price: se.price, side: se.side, barsAgo: it.anchorIndex - se.candleIndex, timeframe: se.timeframe || '5m' };
            }
        });
        // FVG 结构证据（该 opp 的 FVG 数 + 首个 FVG zone）
        var fvgCount = (it.fvgIds || []).length || 1;
        var firstFvg = it.fvgIds && it.fvgIds.length > 0 ? fvgById[it.fvgIds[0]] : null;
        // 人工核对辅助：leg 价量维度 + MSS reference（breakPct / referencePrice）
        var legObj = it.dispId ? (legByDispId[it.dispId] || null) : null;
        var mssEvent = legObj && legObj.mssId ? (mssById[legObj.mssId] || null) : null;
        alerts.push({
            id: it.id,
            tier: it.tier,
            direction: it.direction,
            mssQuality: it.mssQuality,
            legQuality: it.legQuality,
            anchorIndex: it.anchorIndex,
            anchorTime: anchor.closeTime,
            anchorPrice: anchorPrice,
            nearTarget: it.nearTarget,
            nearDistPct: nearDistPct,
            fvgCount: fvgCount,
            fvgZone: firstFvg ? [firstFvg.zoneLow, firstFvg.zoneHigh] : null,
            sweep: sweep,
            dispId: it.dispId,
            legStartIndex: legObj ? legObj.startIndex : null,
            legRangeAtr: legObj ? legObj.rangeAtr : null,
            legNetMoveAtr: legObj ? legObj.netMoveAtr : null,
            legBodyEff: legObj ? legObj.bodyEfficiency : null,
            mssRefPrice: mssEvent && mssEvent.source ? mssEvent.source.referencePrice : null,
            mssBreakPct: mssEvent && mssEvent.source ? mssEvent.source.breakPct : null
        });
    });
    alerts.sort(function (a, b) { return a.anchorIndex - b.anchorIndex; });
    return alerts;
}

/**
 * 通知质量评估（30m/1h × tier × 距离桶）。
 * @param {Array} alerts buildAlerts 输出
 * @param {Array} candles 5m candles
 * @returns {Object} { total, byTier: {...}, perDay, perWeekHigh,
 *                     tierStats: { TIER: { n, w30m: {...}, w1h: {...} } },
 *                     distBuckets: { BUCKET: { TIER: { n, nearHit30m, nearHit1h } } } }
 */
function assessAlerts(alerts, candles) {
    var out = {
        total: alerts.length,
        byTier: { HIGH_QUALITY: 0, WATCH: 0, LOW_QUALITY: 0 },
        tierStats: {},
        distBuckets: {}
    };
    var firstIdx = alerts.length > 0 ? alerts[0].anchorIndex : null;
    var lastIdx = alerts.length > 0 ? alerts[alerts.length - 1].anchorIndex : null;
    var days = firstIdx !== null && lastIdx !== null && candles.length > 1
        ? Math.max(1, (candles[lastIdx].closeTime - candles[firstIdx].closeTime) / 86400000)
        : 1;
    out.days = Math.round(days * 10) / 10;
    out.perDay = alerts.length > 0 ? alerts.length / days : 0;

    function tacc(tier) {
        if (!out.tierStats[tier]) {
            out.tierStats[tier] = { n: 0, w30m: null, w1h: null };
            WINDOWS.forEach(function (w) {
                out.tierStats[tier]['w' + w.key.slice(1)] = { hit: 0, nearHit: 0, nearCnt: 0, mfeSum: 0, maeSum: 0 };
            });
        }
        return out.tierStats[tier];
    }

    alerts.forEach(function (al) {
        out.byTier[al.tier] = (out.byTier[al.tier] || 0) + 1;
        var a = tacc(al.tier);
        a.n++;
        // 距离桶
        var bucket = distBucketOf(al.nearDistPct !== null ? al.nearDistPct : Infinity);
        if (!out.distBuckets[bucket]) out.distBuckets[bucket] = {};
        var b = out.distBuckets[bucket];
        if (!b[al.tier]) b[al.tier] = { n: 0, nearHit30m: 0, nearHit1h: 0, nearCnt30m: 0, nearCnt1h: 0 };
        b[al.tier].n++;
        var start = al.anchorIndex + 1;
        WINDOWS.forEach(function (w) {
            var lastJ = Math.min(start + w.bars - 1, candles.length - 1);
            var bullish = al.direction === 'BULLISH';
            var mfe = 0, mae = 0, nearHit = false;
            for (var j = start; j <= lastJ; j++) {
                var c = candles[j];
                if (!c) break;
                if (bullish) {
                    if (c.high - al.anchorPrice > mfe) mfe = c.high - al.anchorPrice;
                    if (al.anchorPrice - c.low > mae) mae = al.anchorPrice - c.low;
                    if (al.nearTarget !== null && al.nearTarget !== undefined && c.high >= al.nearTarget) nearHit = true;
                } else {
                    if (al.anchorPrice - c.low > mfe) mfe = al.anchorPrice - c.low;
                    if (c.high - al.anchorPrice > mae) mae = al.anchorPrice - c.high;
                    if (al.nearTarget !== null && al.nearTarget !== undefined && c.low <= al.nearTarget) nearHit = true;
                }
            }
            var ws = a['w' + w.key.slice(1)];
            ws.mfeSum += mfe / al.anchorPrice * 100;
            ws.maeSum += mae / al.anchorPrice * 100;
            if (al.nearTarget !== null && al.nearTarget !== undefined) {
                ws.nearCnt++;
                if (nearHit) ws.nearHit++;
            }
            // 距离桶内 30m/1h nearHit
            var bn = b[al.tier];
            if (al.nearTarget !== null && al.nearTarget !== undefined) {
                if (w.key === 'w30m') { bn.nearCnt30m++; if (nearHit) bn.nearHit30m++; }
                else { bn.nearCnt1h++; if (nearHit) bn.nearHit1h++; }
            }
        });
    });
    // 每周 HIGH 次数（days/7）
    out.perWeekHigh = days > 0 ? (out.byTier.HIGH_QUALITY || 0) / (days / 7) : 0;
    return out;
}

module.exports = {
    buildAlerts: buildAlerts,
    assessAlerts: assessAlerts,
    DIST_BUCKETS: DIST_BUCKETS,
    distBucketOf: distBucketOf
};
