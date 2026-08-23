/**
 * Phase 11D.7 — Opportunity Quality Tier
 *
 * Opportunity Quality = MSS existence + Delivery Quality（DisplacementLeg）
 *                       + Reachable Draw Quality（Near Draw）
 *
 * 规则分层（不用神秘总分，每档可解释）：
 *   HIGH_QUALITY : MSS exists && Leg = STRONG / EXPLOSIVE
 *                  && Near Draw 存在（可达）
 *                  && 无 direction conflict
 *   WATCH        : MSS exists && Leg = NORMAL && Near Draw 存在
 *   LOW_QUALITY  : NO_MSS / WEAK leg / 无 Near Draw / direction conflict
 *
 * Structural Provenance（mssQuality/referenceRole/protectedBreak）只作 enrichment；
 * protected/important swing 不是 HIGH prerequisite。
 *
 * 锁死语义：机会身份 = Sweep → MSS → DisplacementLeg；FVG 只是 delivery leg 的
 * 结构证据（去重单位是 leg 不是 FVG）；Near Draw 是目标。
 * 1h validation 锚在 leg 完成时刻（大样本），不是稀有 FVG retrace。
 */
var DEFAULT_WINDOW_BARS = 12; // 1h = 12 根 5m

/**
 * @param {Object} opts { mssExists, mssQuality(enrichment), legQuality, nearDrawAvailable, directionConflict }
 * @returns {string} 'HIGH_QUALITY' | 'WATCH' | 'LOW_QUALITY'
 */
function classifyOpportunityTier(opts) {
    var mss = opts.mssQuality || 'NO_MSS';
    var leg = opts.legQuality || 'WEAK';
    var nearOk = opts.nearDrawAvailable !== false;
    var conflict = !!opts.directionConflict;
    var mssExists = opts.mssExists !== undefined ? !!opts.mssExists : mss !== 'NO_MSS';
    if (conflict || !nearOk || !mssExists) {
        return 'LOW_QUALITY';
    }
    var strongLeg = leg === 'STRONG' || leg === 'EXPLOSIVE';
    if (strongLeg) {
        return 'HIGH_QUALITY';
    }
    if (leg === 'NORMAL') {
        return 'WATCH';
    }
    return 'LOW_QUALITY';
}

/**
 * 为每个 opportunity 挂 tier / leg 维度 / 锚点 / near target。
 * @param {Array} opportunities buildOpportunities 输出 [{ id, direction, fvgIds, ... }]
 * @param {Array} fvgs 全部 FVG（含 displacementEventId）
 * @param {Object} legByDispId dispId → { quality, mssQuality, endIndex, direction }
 * @param {Array} drawTrace 逐根 { bslNear, bslMacro, sslNear, sslMacro }
 * @param {Array} [candles] 5m candles（Phase 11L.7：notificationPrice 需 availableIndex 处 close）
 * @returns {Array} items [{ id, direction, tier, mssQuality, legQuality, anchorIndex, nearTarget, hasLeg,
 *                          notificationPrice, notificationNearTarget, notificationNearDistPct }]
 */
function buildTierIndex(opportunities, fvgs, legByDispId, drawTrace, candles) {
    var fvgByDisp = {};
    (fvgs || []).forEach(function (f) {
        if (f.displacementEventId) {
            fvgByDisp[f.id] = f;
        }
    });
    return (opportunities || []).map(function (o) {
        var dispIds = [];
        (o.fvgIds || []).forEach(function (fid) {
            var f = fvgByDisp[fid];
            if (f && f.displacementEventId && dispIds.indexOf(f.displacementEventId) === -1) {
                dispIds.push(f.displacementEventId);
            }
        });
        if (dispIds.length === 0) {
            // 无 displacement 链（孤立 FVG）：无 delivery/mss 结构 → LOW，且无锚点不参与 1h validation
            return {
                id: o.id, direction: o.direction, tier: 'LOW_QUALITY',
                mssQuality: 'NO_MSS', legQuality: 'WEAK',
                anchorIndex: null, nearTarget: null, hasLeg: false,
                fvgIds: o.fvgIds || []
            };
        }
        // 取最后完成的 leg（endIndex 最大 = 机会当前状态）
        var best = null;
        dispIds.forEach(function (did) {
            var leg = legByDispId[did];
            if (leg && (!best || leg.endIndex > best.endIndex)) {
                best = leg;
            }
        });
        if (!best) {
            return {
                id: o.id, direction: o.direction, tier: 'LOW_QUALITY',
                mssQuality: 'NO_MSS', legQuality: 'WEAK',
                anchorIndex: null, nearTarget: null, hasLeg: false,
                fvgIds: o.fvgIds || []
            };
        }
        var dt = drawTrace && drawTrace[best.endIndex] ? drawTrace[best.endIndex] : null;
        var nearTarget = null;
        if (dt) {
            nearTarget = o.direction === 'BULLISH' ? dt.bslNear : dt.sslNear;
        }
        var nearOk = nearTarget !== null && nearTarget !== undefined;
        var tier = classifyOpportunityTier({
            mssQuality: best.mssQuality,
            legQuality: best.quality,
            nearDrawAvailable: nearOk,
            // directionConflict：OPPOSITE 不产生机会（gate 已过滤），冲突维度在 retrace 层挂账
            directionConflict: false
        });
        // Phase 11L.7：Notification Snapshot 收口 —— 通知内容必须在 availableAt 时重新冻结。
        //   anchor 的 nearTarget 只描述 leg 本身；通知时点（availableIndex）的 draw 可能已变化
        //   （该 15min 内 liquidity 可能已被触及/扫掉/更近）。因此：
        //     notificationNearTarget = drawTrace[availableIndex] 的 near（回退 anchor 的 nearTarget）
        //     notificationPrice      = availableIndex 处 close
        //     notificationNearDistPct = |notificationNearTarget - notificationPrice| / notificationPrice
        var availIdx = best.availableIndex !== undefined && best.availableIndex !== null
            ? best.availableIndex
            : best.endIndex;
        var dtAvail = drawTrace && drawTrace[availIdx] ? drawTrace[availIdx] : null;
        var notifNear = null;
        if (dtAvail) {
            notifNear = o.direction === 'BULLISH' ? dtAvail.bslNear : dtAvail.sslNear;
        }
        if (notifNear === null || notifNear === undefined) {
            notifNear = nearTarget; // 回退：通知时点 draw 不可用 → 用 anchor 冻结值（保守）
        }
        var notifPrice = candles && candles[availIdx] ? candles[availIdx].close : null;
        var notifDist = notifNear !== null && notifNear !== undefined && notifPrice !== null && notifPrice > 0
            ? Math.abs(notifNear - notifPrice) / notifPrice * 100
            : null;
        return {
            id: o.id, direction: o.direction, tier: tier,
            mssQuality: best.mssQuality, legQuality: best.quality,
            anchorIndex: best.endIndex, nearTarget: nearTarget, hasLeg: true,
            fvgIds: o.fvgIds || [],
            // 11L.4：通知可用时点（leg 关闭确认时间）。leg.availableIndex 缺失（旧构造）时回退
            // anchorIndex 保持兼容；authoritative 路径（buildWindowedLegIndex）必有该字段。
            availableIndex: availIdx,
            // Phase 11L.7：通知时点快照（Notification Snapshot）
            notificationPrice: notifPrice,
            notificationNearTarget: notifNear,
            notificationNearDistPct: notifDist,
            // 暴露 best leg 引用（Alert Replay 人工核对：rangeAtr/bodyEff/MSS reference 等）
            dispId: best.ids && best.ids.length > 0 ? best.ids[0] : null
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
        if (!it.hasLeg || it.anchorIndex === null || it.anchorIndex === undefined) return;
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
    classifyOpportunityTier: classifyOpportunityTier,
    buildTierIndex: buildTierIndex,
    validateTiers: validateTiers,
    DEFAULT_WINDOW_BARS: DEFAULT_WINDOW_BARS
};
