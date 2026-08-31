/**
 * Phase 11D.8 — Opportunity Alert Validation（历史通知回放）
 *
 * 目的：验证"过去 90 天如果系统已部署，我会收到什么通知、这些通知值不值得看"。
 * 不接钉钉、不写 client —— 先把通知时点、内容、质量全部离线回放。
 *
 * Phase 11L.4（Alert Availability-Time Fix）：
 *   通知时点 ≠ leg 完成根（anchorIndex）。15min 时间窗 leg 的"系统首次能确认 leg 已结束"
 *   时刻是 availableAt（= availableIndex 对应 K 收盘）：
 *     - 下一个 displacement 触发关闭：availableAt = 触发 K closeTime
 *     - timeout 过期关闭：availableAt = lastConfirmedAt + 15min
 *   历史统计必须从 availableAt 之后的最早 N+1 开始（否则把"通知发出前已发生的行情"
 *   算进 post-alert 表现 —— information-availability leakage，会虚高 near draw hit 率）。
 *   anchorTime/anchorIndex 保留，仅描述 displacement leg 本身。
 *
 * 通知后质量 = availableIndex+1 起 30m(6)/1h(12) 根：
 *   - Near Draw Hit（窗口内触达 near target）
 *   - MFE / MAE（顺向 / 逆向最大幅度，相对 %）
 *
 * 防统计幻觉：Near Draw 距离分层（<0.1 / 0.1-0.25 / 0.25-0.5 / 0.5-1 / >1 %）
 * —— 若 >0.5% 距离桶的 HIGH 仍明显优于 WATCH/LOW，信号才硬。
 *
 * Phase 11L.5（P0-2，target staleness）：
 *   81% 统计使用 anchor 时刻冻结的 nearTarget；anchor+1..availableIndex 之间价格可能已
 *   TOUCHED/SWEPT/BROKEN 该 target。**数据结论（90d）**：被触及/穿越的机会 1h hit 反而
 *   更高（81% vs 剔除后 33-41%）——触及 ≠ 失效，近端流动性被测试恰是机会生效标志。
 *   用户决策【放弃 suppress】：Live 不拦截（仅 opp.nearConsumed 标记观察），
 *   历史统计不剔除样本，staleNearSuppressed 仅作为观察计数输出。
 */
var opportunityQuality = require('./opportunityQuality');
var nearStaleness = require('./nearStaleness');
var liquidityProvenance = require('./liquidityProvenance');

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
 * @param {Object} displacementById canonical id → displacement
 * @param {Array} drawTrace 逐根 { bslNear, bslMacro, sslNear, sslMacro }
 * @param {Array} sweepEvents LIQUIDITY_SWEEP 事件（leg 前窗口内同向最近一个）
 * @param {Array} candles 5m candles（取时间/价格）
 * @returns {Array} alerts [{ id, tier, direction, deliveryQuality, anchorIndex, anchorTime,
 *                           anchorPrice, nearTarget, nearDistPct, fvgCount, fvgIds,
 *                           formationRangeAtr, formationNetMoveAtr, formationBodyEfficiency,
 *                           availableIndex, availableAt, closeReason,
 *                           notificationPrice, notificationNearTarget, notificationNearDistPct,
 *                           sweep: { price, side, barsAgo } | null }]
 */
function buildAlerts(opportunities, fvgs, displacementById, drawTrace, sweepEvents, candles) {
    var items = opportunityQuality.buildTierIndex(opportunities, fvgs, displacementById, drawTrace, candles);
    var alerts = [];
    var fvgById = {};
    (fvgs || []).forEach(function (f) { fvgById[f.id] = f; });
    items.forEach(function (it) {
        if (!it.hasDisplacement || it.anchorIndex === null || it.anchorIndex === undefined) return;
        var anchor = candles[it.anchorIndex];
        if (!anchor) return;
        // 11L.4：通知可用时点（availableIndex 优先；旧调用无该字段回退 anchorIndex）
        var availIdx = it.availableIndex !== undefined && it.availableIndex !== null
            ? it.availableIndex
            : it.anchorIndex;
        var availCandle = candles[availIdx];
        var anchorPrice = anchor.close;
        // 11L.5（P0-2）：target staleness 观察标记 —— near target 是 anchor 时刻冻结的；
        // anchor+1..availableIndex 之间若已触及（TOUCHED/SWEPT/BROKEN）→ 仅标记观察，
        // 不剔除统计、不拦截 Live（用户决策：触及 ≠ 失效，见文件头注释）
        var staleNear = false;
        var staleTouchIndex = null;
        if (it.nearTarget !== null && it.nearTarget !== undefined && availIdx > it.anchorIndex) {
            var cons = nearStaleness.checkNearConsumed(it.nearTarget, it.direction, candles, it.anchorIndex + 1, availIdx);
            staleNear = cons.consumed;
            staleTouchIndex = cons.firstTouchIndex;
        }
        var nearDistPct = it.nearTarget !== null && it.nearTarget !== undefined && anchorPrice > 0
            ? Math.abs(it.nearTarget - anchorPrice) / anchorPrice * 100
            : null;
        var displacement = it.displacement;
        // Phase 11L.8：Liquidity Provenance（Live/Replay 同一关联函数）。
        //   LONG → 只关联 SSL；SHORT → 只关联 BSL；sweep.confirmedAt <= availableAt（无 future leakage）；
        //   窗口 = leg.startIndex - maxLookbackBars → leg.endIndex（sweep 允许在 leg 内）。
        //   无法可靠关联 → null（通知显示 NONE，不猜测）。
        //   sweeps[] 记录窗口内全部候选（含 barsBeforeLegStart / relation）→ 诊断看真实分布定正式窗口。
        var prov = null;
        if (displacement) {
            var availTime = availCandle ? availCandle.closeTime : anchor.closeTime;
            prov = liquidityProvenance.associateSweeps({
                direction: it.direction,
                displacement: displacement,
                availableAt: availTime,
                sweepEvents: sweepEvents,
                maxLookbackBars: null // 使用 thresholds.events.sweepProvenance.maxLookbackBars（当前 48）
            });
        }
        // 兼容字段（旧调用/旧测试）：alert.sweep 摘要（新结构见 liquidityContext）
        var sweep = null;
        if (prov && prov.immediateSweep) {
            var pri = prov.immediateSweep;
            sweep = {
                price: pri.sourcePrice,
                side: pri.side,
                barsAgo: it.anchorIndex - pri.candleIndex,
                timeframe: pri.sourceTimeframe,
                relation: pri.relation,
                sourceType: pri.sourceType,
                sourceId: pri.sourceId,
                confirmedAt: pri.confirmedAt
            };
        }
        // FVG 结构证据（该 opp 的 FVG 数 + 首个 FVG zone）
        var fvgCount = (it.fvgIds || []).length || 1;
        var firstFvg = it.fvgIds && it.fvgIds.length > 0 ? fvgById[it.fvgIds[0]] : null;
        alerts.push({
            id: it.id,
            tier: it.tier,
            direction: it.direction,
            deliveryQuality: it.deliveryQuality,
            anchorIndex: it.anchorIndex,
            anchorTime: anchor.closeTime,
            anchorPrice: anchorPrice,
            // 11L.4：真实通知时点（系统首次能确认 leg 结束）
            availableIndex: availIdx,
            availableAt: availCandle ? availCandle.closeTime : (it.availableAt !== undefined ? it.availableAt : anchor.closeTime),
            closeReason: 'canonical-confirmation',
            // 11L.5（P0-2）：通知前 near 已被价格消费（Live 将 STALE_NEAR_SUPPRESSED）
            staleNear: staleNear,
            staleTouchIndex: staleTouchIndex,
            nearTarget: it.nearTarget,
            nearDistPct: nearDistPct,
            // Phase 11L.7：Notification Snapshot 收口 —— 通知时点（availableAt）重新冻结的
            // 价格/目标/距离。post-alert 统计一律用 notification* 字段（回退 anchor 字段兼容旧调用）。
            notificationPrice: it.notificationPrice,
            notificationNearTarget: it.notificationNearTarget,
            notificationNearDistPct: it.notificationNearDistPct,
            fvgCount: fvgCount,
            fvgZone: firstFvg ? [firstFvg.zoneLow, firstFvg.zoneHigh] : null,
            sweep: sweep,
            // Phase 11L.8：Liquidity Provenance（allCandidates 全候选 + immediateSweep 通知展示）
            liquidityContext: prov,
            canonicalDisplacementId: displacement ? displacement.id : null,
            formationStartIndex: displacement ? displacement.startIndex : null,
            formationRangeAtr: it.formationRangeAtr,
            formationNetMoveAtr: it.formationNetMoveAtr,
            formationBodyEfficiency: it.formationBodyEfficiency
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
        distBuckets: {},
        // 11L.4：无有效通知时点（数据末尾 timeout，availableAt 超出历史数据）的样本——
        // 真实运行会被通知，但历史数据里没有"通知后"行情可验证，不计入 hit 率（避免稀释）
        incomplete: 0,
        // 11L.5（P0-2）：HIGH 且 near 在通知前已被触及 —— 观察计数（不剔除样本）
        staleNearSuppressed: 0
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
        // 11L.4：通知后最早 N+1 = availableIndex + 1（锚不再用 anchorIndex）。
        // availableIndex 字段缺失（旧调用）→ 回退 anchorIndex；显式 null（tail 超界，
        // 历史数据里没有"通知后"行情可验证）→ 计 incomplete，不计入 hit 率
        var availIdx = al.availableIndex !== undefined ? al.availableIndex : al.anchorIndex;
        var start = availIdx !== null && availIdx !== undefined ? availIdx + 1 : null;
        if (start === null || start >= candles.length) {
            out.incomplete++;
            return;
        }
        // Phase 11L.7：Notification Snapshot 收口 —— post-alert 统计一律用通知时点快照：
        //   notificationPrice（MFE/MAE 基准）、notificationNearTarget（nearHit 目标）。
        //   回退 anchor 字段保持旧调用/旧测试兼容（无 notification* 字段时行为不变）。
        var basePrice = al.notificationPrice !== undefined && al.notificationPrice !== null
            ? al.notificationPrice
            : al.anchorPrice;
        var hitTarget = al.notificationNearTarget !== undefined && al.notificationNearTarget !== null
            ? al.notificationNearTarget
            : al.nearTarget;
        // 11L.5（P0-2）：near 在通知前已被触及/穿越 —— 仅观察计数，不剔除样本。
        // 90d 数据结论：被触及机会的 1h hit 反而更高（81% vs 剔除后 33-41%），
        // 触及 ≠ 失效（近端流动性被测试恰是机会生效标志）→ 用户决策【放弃 suppress】。
        if (al.tier === 'HIGH_QUALITY' && al.staleNear) {
            out.staleNearSuppressed = (out.staleNearSuppressed || 0) + 1;
        }
        var a = tacc(al.tier);
        a.n++;
        // 距离桶：使用通知时点距离（回退 anchor 距离）
        var distPct = al.notificationNearDistPct !== undefined && al.notificationNearDistPct !== null
            ? al.notificationNearDistPct
            : al.nearDistPct;
        var bucket = distBucketOf(distPct !== null ? distPct : Infinity);
        if (!out.distBuckets[bucket]) out.distBuckets[bucket] = {};
        var b = out.distBuckets[bucket];
        if (!b[al.tier]) b[al.tier] = { n: 0, nearHit30m: 0, nearHit1h: 0, nearCnt30m: 0, nearCnt1h: 0 };
        b[al.tier].n++;
        WINDOWS.forEach(function (w) {
            var lastJ = Math.min(start + w.bars - 1, candles.length - 1);
            var bullish = al.direction === 'BULLISH';
            var mfe = 0, mae = 0, nearHit = false;
            for (var j = start; j <= lastJ; j++) {
                var c = candles[j];
                if (!c) break;
                if (bullish) {
                    if (c.high - basePrice > mfe) mfe = c.high - basePrice;
                    if (basePrice - c.low > mae) mae = basePrice - c.low;
                    if (hitTarget !== null && hitTarget !== undefined && c.high >= hitTarget) nearHit = true;
                } else {
                    if (basePrice - c.low > mfe) mfe = basePrice - c.low;
                    if (c.high - basePrice > mae) mae = basePrice - c.high;
                    if (hitTarget !== null && hitTarget !== undefined && c.low <= hitTarget) nearHit = true;
                }
            }
            var ws = a['w' + w.key.slice(1)];
            ws.mfeSum += mfe / basePrice * 100;
            ws.maeSum += mae / basePrice * 100;
            if (hitTarget !== null && hitTarget !== undefined) {
                ws.nearCnt++;
                if (nearHit) ws.nearHit++;
            }
            // 距离桶内 30m/1h nearHit
            var bn = b[al.tier];
            if (hitTarget !== null && hitTarget !== undefined) {
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
