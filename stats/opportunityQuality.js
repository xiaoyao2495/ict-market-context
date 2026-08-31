/**
 * Phase 11D.7 — Opportunity Quality Tier
 *
 * Opportunity Quality = Canonical Delivery Quality
 *                       + Reachable Draw Quality（Near Draw）
 *
 * 规则分层（不用神秘总分，每档可解释）：
 *   HIGH_QUALITY : Leg = STRONG / EXPLOSIVE
 *                  && Near Draw 存在（可达）
 *                  && 无 direction conflict
 *   WATCH        : Leg = NORMAL && Near Draw 存在
 *   LOW_QUALITY  : WEAK leg / 无 Near Draw / direction conflict
 *
 * 锁死语义：机会身份 = Canonical Displacement；FVG 是 formation 的结构证据；
 * Near Draw 是目标。1h validation 锚在 canonical formation 完成时刻。
 */
var DEFAULT_WINDOW_BARS = 12; // 1h = 12 根 5m

function describeCanonicalDelivery(displacement, candles) {
    var start = candles && candles[displacement.startIndex];
    var end = candles && candles[displacement.endIndex];
    var atr = displacement.atr;
    if (!start || !end || !atr || atr <= 0) return { quality:'WEAK', rangeAtr:null, netMoveAtr:null, bodyEfficiency:null };
    var high = -Infinity, low = Infinity, totalBody = 0, totalRange = 0;
    for (var i = displacement.startIndex; i <= displacement.endIndex; i++) {
        var c = candles[i];
        if (!c) continue;
        high = Math.max(high, c.high); low = Math.min(low, c.low);
        totalBody += Math.abs(c.close - c.open); totalRange += c.high - c.low;
    }
    var rangeAtr = (high - low) / atr;
    var netMoveAtr = Math.abs(displacement.endPrice - displacement.startPrice) / atr;
    var bodyEfficiency = totalRange > 0 ? totalBody / totalRange : 0;
    var quality = rangeAtr >= 2.5 && netMoveAtr >= 2 && bodyEfficiency >= 0.6 ? 'EXPLOSIVE'
        : rangeAtr >= 1.8 && netMoveAtr >= 1.2 ? 'STRONG'
        : rangeAtr >= 1 ? 'NORMAL' : 'WEAK';
    return { quality:quality, rangeAtr:rangeAtr, netMoveAtr:netMoveAtr, bodyEfficiency:bodyEfficiency };
}

/**
 * @param {Object} opts { deliveryQuality, nearDrawAvailable, directionConflict }
 * @returns {string} 'HIGH_QUALITY' | 'WATCH' | 'LOW_QUALITY'
 */
function classifyOpportunityTier(opts) {
    var delivery = opts.deliveryQuality || 'WEAK';
    var nearOk = opts.nearDrawAvailable !== false;
    var conflict = !!opts.directionConflict;
    if (conflict || !nearOk) {
        return 'LOW_QUALITY';
    }
    var strongDelivery = delivery === 'STRONG' || delivery === 'EXPLOSIVE';
    if (strongDelivery) {
        return 'HIGH_QUALITY';
    }
    if (delivery === 'NORMAL') {
        return 'WATCH';
    }
    return 'LOW_QUALITY';
}

/**
 * 为每个 opportunity 挂 tier / leg 维度 / 锚点 / near target。
 * @param {Array} opportunities buildOpportunities 输出 [{ id, direction, fvgIds, ... }]
 * @param {Array} fvgs 全部 FVG（含 displacementEventId）
 * @param {Object} displacementById canonical id → displacement
 * @param {Array} drawTrace 逐根 { bslNear, bslMacro, sslNear, sslMacro }
 * @param {Array} [candles] 5m candles（Phase 11L.7：notificationPrice 需 availableIndex 处 close）
 * @returns {Array} items [{ id, direction, tier, deliveryQuality, anchorIndex, nearTarget, hasDisplacement,
 *                          notificationPrice, notificationNearTarget, notificationNearDistPct }]
 */
function buildTierIndex(opportunities, fvgs, displacementById, drawTrace, candles) {
    return (opportunities || []).map(function (o) {
        var displacement = o.displacement || displacementById && displacementById[o.canonicalDisplacementId];
        if (!displacement) return { id:o.id, direction:o.direction, tier:'LOW_QUALITY',
            deliveryQuality:'WEAK', anchorIndex:null, nearTarget:null, hasDisplacement:false, fvgIds:o.fvgIds || [] };
        var delivery = describeCanonicalDelivery(displacement, candles);
        var dt = drawTrace && drawTrace[displacement.endIndex];
        var nearTarget = dt ? (o.direction === 'BULLISH' ? dt.bslNear : dt.sslNear) : null;
        var tier = classifyOpportunityTier({ deliveryQuality:delivery.quality,
            nearDrawAvailable:nearTarget !== null && nearTarget !== undefined, directionConflict:false });
        var availIdx = displacement.endIndex;
        var notifPrice = candles && candles[availIdx] ? candles[availIdx].close : null;
        var notifDist = nearTarget !== null && nearTarget !== undefined && notifPrice > 0
            ? Math.abs(nearTarget - notifPrice) / notifPrice * 100 : null;
        return {
            id:o.id, direction:o.direction, tier:tier, deliveryQuality:delivery.quality,
            anchorIndex:displacement.endIndex, nearTarget:nearTarget, hasDisplacement:true,
            fvgIds:o.fvgIds || [], availableIndex:availIdx, availableAt:displacement.confirmedAt,
            notificationPrice:notifPrice, notificationNearTarget:nearTarget,
            notificationNearDistPct:notifDist, canonicalDisplacementId:displacement.id,
            displacement:displacement, formationRangeAtr:delivery.rangeAtr,
            formationNetMoveAtr:delivery.netMoveAtr, formationBodyEfficiency:delivery.bodyEfficiency
        };
    });
}

/**
 * 1h Direction Validation（Phase 11L.4：锚 = 通知可用时点 availableIndex 的下一根，
 * 不再用 leg 完成根 anchorIndex —— 修正"事件完成时间超前于系统可确认时间"的
 * information-availability leakage；availableIndex 缺失时回退 anchorIndex 保持兼容）。
 * @param {Array} items buildTierIndex 输出
 * @param {Array} candles 5m candles
 * @param {number} [windowBars] 默认 12（1h）
 * @returns {Object} { HIGH_QUALITY: {n,hit,mfeSum,maeSum,maeCnt,nearHit,nearCnt}, WATCH, LOW_QUALITY }
 */
function validateTiers(items, candles, windowBars) {
    var W = windowBars || DEFAULT_WINDOW_BARS;
    var agg = { HIGH_QUALITY: null, WATCH: null, LOW_QUALITY: null };
    function acc(k) {
        if (!agg[k]) {
            agg[k] = { n: 0, hit: 0, mfeSum: 0, maeSum: 0, maeCnt: 0, nearHit: 0, nearCnt: 0 };
        }
        return agg[k];
    }
    (items || []).forEach(function (it) {
        if (!it.hasDisplacement || it.anchorIndex === null || it.anchorIndex === undefined) return;
        // 11L.4：通知可用时点（availableIndex 优先；旧调用无该字段时回退 anchorIndex）
        var availIdx = it.availableIndex !== undefined && it.availableIndex !== null ? it.availableIndex : it.anchorIndex;
        var start = availIdx + 1; // 通知后最早 N+1 才允许观察（无 information-availability leakage）
        if (start >= candles.length) return;
        var anchor = candles[it.anchorIndex];
        if (!anchor) return;
        var anchorPrice = anchor.close;
        var bullish = it.direction === 'BULLISH';
        var lastJ = Math.min(start + W - 1, candles.length - 1);
        var mfe = 0;
        var mae = 0;
        var nearHit = false;
        for (var j = start; j <= lastJ; j++) {
            var c = candles[j];
            if (!c) break;
            if (bullish) {
                if (c.high - anchorPrice > mfe) mfe = c.high - anchorPrice;
                if (anchorPrice - c.low > mae) mae = anchorPrice - c.low;
                if (it.nearTarget !== null && it.nearTarget !== undefined && c.high >= it.nearTarget) nearHit = true;
            } else {
                if (anchorPrice - c.low > mfe) mfe = anchorPrice - c.low;
                if (c.high - anchorPrice > mae) mae = anchorPrice - c.high;
                if (it.nearTarget !== null && it.nearTarget !== undefined && c.low <= it.nearTarget) nearHit = true;
            }
        }
        var endClose = candles[lastJ] ? candles[lastJ].close : anchorPrice;
        var net = bullish ? endClose - anchorPrice : anchorPrice - endClose;
        var a = acc(it.tier);
        a.n++;
        if (net > 0) a.hit++;
        a.mfeSum += mfe / anchorPrice * 100; // 相对百分比（与 narrativeDirection 口径一致）
        a.maeSum += mae / anchorPrice * 100;
        if (mae > 0) a.maeCnt++;
        if (it.nearTarget !== null && it.nearTarget !== undefined) {
            a.nearCnt++;
            if (nearHit) a.nearHit++;
        }
    });
    return agg;
}

module.exports = {
    describeCanonicalDelivery: describeCanonicalDelivery,
    classifyOpportunityTier: classifyOpportunityTier,
    buildTierIndex: buildTierIndex,
    validateTiers: validateTiers,
    DEFAULT_WINDOW_BARS: DEFAULT_WINDOW_BARS
};
