/**
 * Phase 11L.10 — Liquidity Recency Audit（sweep 距离 → 机会质量分桶）
 *
 * 背景（用户 2026-08-19）：真实通知里出现过 ZEC 的 sweep 距 leg 22 bars（110 分钟），
 * "显示起来很奇怪"。问题：Liquidity Recency 到底有没有信息价值？
 *
 * 方法：90d HIGH=575 按 immediateSweep.barsBeforeLegStart（= leg.startIndex - sweep.candleIndex）分桶：
 *   INSIDE_LEG（leg 内，bars <= 0）
 *   1-3 bars / 4-6 bars / 7-12 bars / 13-24 bars / 25-48 bars
 *   NONE（无方向匹配 sweep 关联，liquidityContext null）
 *
 * 每桶：n / NearHit30m / NearHit1h / MFE / MAE（口径与 assessAlerts 一致：
 *   availableIndex+1 起、notificationPrice 基准、notificationNearTarget 目标）。
 *
 * 解读：
 *   - 各桶 NearHit 差不多 → Liquidity Taken 永远只是 Context（不参与 HIGH）
 *   - 1-6 bars 明显强、13-48 bars 接近 NONE → 有证据定义 notificationSweep，
 *     甚至未来考虑让 Recent Sweep 成为 Opportunity Quality 维度
 *   - 纯审计，不改 48 bars / 不改通知 / 不让 Sweep 参与 HIGH
 */
var BUCKETS = [
    { key: 'INSIDE_LEG', test: function (b) { return b <= 0; } },
    { key: '1-3 bars', test: function (b) { return b >= 1 && b <= 3; } },
    { key: '4-6 bars', test: function (b) { return b >= 4 && b <= 6; } },
    { key: '7-12 bars', test: function (b) { return b >= 7 && b <= 12; } },
    { key: '13-24 bars', test: function (b) { return b >= 13 && b <= 24; } },
    { key: '25-48 bars', test: function (b) { return b >= 25 && b <= 48; } }
];

/**
 * barsBeforeLegStart → 分桶 key；null（无 immediateSweep）→ 'NONE'
 */
function bucketOf(bars) {
    if (typeof bars !== 'number') return 'NONE';
    for (var i = 0; i < BUCKETS.length; i++) {
        if (BUCKETS[i].test(bars)) return BUCKETS[i].key;
    }
    return '>48'; // 防御（窗口内不应出现）
}

/**
 * 分桶统计（HIGH 母样本）。
 * @param {Array} alerts buildAlerts 输出（仅统计 tier=HIGH_QUALITY，含 liquidityContext / notification*）
 * @param {Array} candles 5m candles
 * @returns {Object} buckets: { KEY: { n, nearHit30m, nearCnt30m, nearHit1h, nearCnt1h, mfeSum, maeSum, mfeCnt } }
 *                   + order（展示顺序）
 */
function auditLiquidityRecency(alerts, candles) {
    var order = ['INSIDE_LEG', '1-3 bars', '4-6 bars', '7-12 bars', '13-24 bars', '25-48 bars', 'NONE'];
    var buckets = {};
    order.forEach(function (k) {
        buckets[k] = { n: 0, nearHit30m: 0, nearCnt30m: 0, nearHit1h: 0, nearCnt1h: 0, mfeSum: 0, maeSum: 0, mfeCnt: 0 };
    });

    (alerts || []).forEach(function (al) {
        if (!al || al.tier !== 'HIGH_QUALITY') return;
        var bars = null;
        if (al.liquidityContext && al.liquidityContext.immediateSweep) {
            bars = al.liquidityContext.immediateSweep.barsBeforeLegStart;
        }
        var key = bucketOf(bars);
        if (!buckets[key]) buckets[key] = { n: 0, nearHit30m: 0, nearCnt30m: 0, nearHit1h: 0, nearCnt1h: 0, mfeSum: 0, maeSum: 0, mfeCnt: 0 };
        var b = buckets[key];
        b.n++;
        var availIdx = al.availableIndex !== undefined && al.availableIndex !== null ? al.availableIndex : al.anchorIndex;
        var start = availIdx !== null && availIdx !== undefined ? availIdx + 1 : null;
        if (start === null || start >= candles.length) return;
        var basePrice = al.notificationPrice !== undefined && al.notificationPrice !== null ? al.notificationPrice : al.anchorPrice;
        var hitTarget = al.notificationNearTarget !== undefined && al.notificationNearTarget !== null ? al.notificationNearTarget : al.nearTarget;
        var bullish = al.direction === 'BULLISH';
        var windows = [{ key: '30m', bars: 6 }, { key: '1h', bars: 12 }];
        var mfe = 0, mae = 0, nearHit30m = false, nearHit1h = false;
        windows.forEach(function (w) {
            var lastJ = Math.min(start + w.bars - 1, candles.length - 1);
            var hit = false;
            for (var j = start; j <= lastJ; j++) {
                var c = candles[j];
                if (!c) break;
                if (bullish) {
                    if (c.high - basePrice > mfe) mfe = c.high - basePrice;
                    if (basePrice - c.low > mae) mae = basePrice - c.low;
                    if (hitTarget !== null && hitTarget !== undefined && c.high >= hitTarget) hit = true;
                } else {
                    if (basePrice - c.low > mfe) mfe = basePrice - c.low;
                    if (c.high - basePrice > mae) mae = c.high - basePrice;
                    if (hitTarget !== null && hitTarget !== undefined && c.low <= hitTarget) hit = true;
                }
            }
            if (w.key === '30m') nearHit30m = hit;
            else nearHit1h = hit;
        });
        if (hitTarget !== null && hitTarget !== undefined) {
            b.nearCnt30m++;
            b.nearCnt1h++;
            if (nearHit30m) b.nearHit30m++;
            if (nearHit1h) b.nearHit1h++;
        }
        b.mfeSum += mfe / basePrice * 100;
        b.maeSum += mae / basePrice * 100;
        b.mfeCnt++;
    });
    return { buckets: buckets, order: order };
}

module.exports = {
    auditLiquidityRecency: auditLiquidityRecency,
    bucketOf: bucketOf,
    BUCKETS: BUCKETS
};
