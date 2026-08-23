/**
 * Phase 11L.8 第二刀 — MSS↔Leg Shadow Association Audit
 *
 * 已知事实：现有 HIGH 575/575 全部是 MSS_INSIDE_LEG —— 因为生产链
 * displacementDetector 的 same-candle bonus 只把【同根】MSS 挂到 displacement
 * （metadata.mssEventId = mssByIndex[index][0].id），MSS 必须先于/同根于位移腿。
 * 这不是市场里没有 BEFORE_LEG，而是生产链本身几乎只允许 inside-leg MSS 进入 HIGH。
 *
 * Shadow 旁路候选集：
 *   现有 authoritative HIGH  vs  允许 related MSS 位于 leg 前方的 shadow opportunity
 *
 * 只改变 MSS↔Leg association，其他全部冻结：
 *   Liquidity / DisplacementLeg / FVG / Near Draw / Opportunity tier 组成规则 都不变。
 * 不改生产 HIGH（纯诊断，promotion 前先看数据）。
 *
 * 三组（按 leg 的 related MSS 时间关系）：
 *   INSIDE_LEG      MSS.candleIndex ∈ [leg.startIndex, leg.endIndex]（现有语义）
 *   BEFORE_LEG      MSS.candleIndex ∈ [leg.startIndex - N, leg.startIndex - 1]，N 默认 6（最多 30 分钟）
 *   NO_RELATED_MSS  窗口内无方向匹配 MSS（对照：这些 leg 永远无缘 HIGH，质量应差）
 *
 * 决策语义（用户）：
 *   BEFORE 质量（NearHit/MFE）≈ INSIDE 甚至更好 → 有理由解除 same-candle 限制；
 *   BEFORE 明显更差 → 当前严格语义过滤了噪声，不该为理论漂亮放宽。
 */
var mssReference = require('./mssReference');
var opportunityQuality = require('./opportunityQuality');
var thresholds = require('../config/thresholds');

var DEFAULT_BEFORE_BARS = 6;

function beforeBarsOf(opts) {
    if (opts && opts.beforeLookbackBars !== undefined && opts.beforeLookbackBars !== null) {
        return opts.beforeLookbackBars;
    }
    var cfg = (thresholds.events && thresholds.events.mssShadow) ? thresholds.events.mssShadow : null;
    if (cfg && cfg.beforeLookbackBars !== undefined) {
        return cfg.beforeLookbackBars;
    }
    return DEFAULT_BEFORE_BARS;
}

/**
 * 为单个 leg 关联 related MSS（Shadow 旁路）。
 * 候选：方向匹配（leg.direction）+ 窗口 [startIndex - N, endIndex] + confirmedAt <= availableAt（无 future leakage）。
 * 选择：距离 leg.startIndex 最近（|candleIndex - startIndex|），距离相同取 confirmedAt 更新。
 * @param {Object} leg { startIndex, endIndex, direction, firstConfirmedAt, lastConfirmedAt }
 * @param {Array} mssEvents 全部 MSS 事件
 * @param {Object} [opts] { beforeLookbackBars, availableAt }
 * @returns {Object} { mssEvent, relation } relation = 'INSIDE_LEG' | 'BEFORE_LEG' | 'NO_RELATED_MSS'
 */
function associateRelatedMss(leg, mssEvents, opts) {
    if (!leg || !mssEvents) {
        return { mssEvent: null, relation: 'NO_RELATED_MSS' };
    }
    var N = beforeBarsOf(opts);
    var start = leg.startIndex;
    var end = leg.endIndex !== undefined ? leg.endIndex : leg.lastIndex;
    var lo = (typeof start === 'number' && typeof N === 'number') ? start - N : -Infinity;
    var availAt = opts && opts.availableAt;
    var wantDir = leg.direction;

    var candidates = [];
    (mssEvents || []).forEach(function (m) {
        if (!m || m.direction !== wantDir) return;
        if (typeof m.candleIndex !== 'number') return;
        if (m.candleIndex < lo) return;
        if (typeof end === 'number' && m.candleIndex > end) return;
        if (typeof availAt === 'number' && typeof m.confirmedAt === 'number' && m.confirmedAt > availAt) return;
        candidates.push(m);
    });
    if (candidates.length === 0) {
        return { mssEvent: null, relation: 'NO_RELATED_MSS' };
    }
    // 距离 leg.startIndex 最近；距离相同取 confirmedAt 更新
    candidates.sort(function (a, b) {
        var da = Math.abs(start - a.candleIndex);
        var db = Math.abs(start - b.candleIndex);
        if (da !== db) return da - db;
        return (b.confirmedAt || 0) - (a.confirmedAt || 0);
    });
    var best = candidates[0];
    var relation = (typeof start === 'number' && best.candleIndex >= start) ? 'INSIDE_LEG' : 'BEFORE_LEG';
    return { mssEvent: best, relation: relation };
}

/**
 * 为每个 hasLeg opportunity 构建 shadow item（tier 用 shadow MSS 关联重算，其余冻结）。
 * 结构对齐 opportunityQuality.buildTierIndex（notification 快照口径一致）。
 * @param {Array} opps buildOpportunities 输出
 * @param {Array} fvgs 全部 FVG
 * @param {Object} legByDispId dispId → leg（buildWindowedLegIndex 输出）
 * @param {Array} mssEvents 全部 MSS 事件
 * @param {Array} swings registry swings（classifyMssReference 用）
 * @param {Array} drawTrace 逐根 near target
 * @param {Array} candles 5m candles
 * @param {Object} [opts] { beforeLookbackBars }
 * @returns {Array} items [{ id, direction, group, tier, mssQuality, legQuality, anchorIndex,
 *                           availableIndex, notificationPrice, notificationNearTarget, hasLeg }]
 */
function buildShadowItems(opps, fvgs, legByDispId, mssEvents, swings, drawTrace, candles, opts) {
    var fvgByDisp = {};
    (fvgs || []).forEach(function (f) {
        if (f.displacementEventId) fvgByDisp[f.id] = f;
    });
    return (opps || []).map(function (o) {
        var dispIds = [];
        (o.fvgIds || []).forEach(function (fid) {
            var f = fvgByDisp[fid];
            if (f && f.displacementEventId && dispIds.indexOf(f.displacementEventId) === -1) {
                dispIds.push(f.displacementEventId);
            }
        });
        if (dispIds.length === 0) return null;
        // 取最后完成的 leg（endIndex 最大 = 机会当前状态）
        var best = null;
        dispIds.forEach(function (did) {
            var leg = legByDispId[did];
            if (leg && (!best || leg.endIndex > best.endIndex)) best = leg;
        });
        if (!best) return null;
        var dt = drawTrace && drawTrace[best.endIndex] ? drawTrace[best.endIndex] : null;
        var nearTarget = null;
        if (dt) {
            nearTarget = o.direction === 'BULLISH' ? dt.bslNear : dt.sslNear;
        }
        // Shadow：只改 MSS↔Leg association（related MSS 可在 leg 前 1~N 根）
        var availIdx = best.availableIndex !== undefined && best.availableIndex !== null ? best.availableIndex : best.endIndex;
        var availTime = null;
        if (candles && candles[availIdx]) availTime = candles[availIdx].closeTime;
        if (availTime === null && typeof best.lastConfirmedAt === 'number') availTime = best.lastConfirmedAt + 900000;
        var rel = associateRelatedMss(best, mssEvents, {
            beforeLookbackBars: beforeBarsOf(opts),
            availableAt: availTime
        });
        var shadowMssQuality = rel.mssEvent
            ? mssReference.classifyMssReference(rel.mssEvent, swings || []).quality
            : 'NO_MSS';
        var tier = opportunityQuality.classifyOpportunityTier({
            mssQuality: shadowMssQuality,
            legQuality: best.quality,
            nearDrawAvailable: nearTarget !== null && nearTarget !== undefined,
            directionConflict: false
        });
        // notification 快照（与 buildTierIndex 口径一致）
        var dtAvail = drawTrace && drawTrace[availIdx] ? drawTrace[availIdx] : null;
        var notifNear = null;
        if (dtAvail) notifNear = o.direction === 'BULLISH' ? dtAvail.bslNear : dtAvail.sslNear;
        if (notifNear === null || notifNear === undefined) notifNear = nearTarget;
        var notifPrice = candles && candles[availIdx] ? candles[availIdx].close : null;
        var notifDist = notifNear !== null && notifPrice !== null && notifPrice > 0
            ? Math.abs(notifNear - notifPrice) / notifPrice * 100 : null;
        return {
            id: o.id,
            direction: o.direction,
            group: rel.relation,
            tier: tier,
            mssQuality: shadowMssQuality,
            legQuality: best.quality,
            anchorIndex: best.endIndex,
            availableIndex: availIdx,
            notificationPrice: notifPrice,
            notificationNearTarget: notifNear,
            notificationNearDistPct: notifDist,
            hasLeg: true
        };
    }).filter(function (it) { return it !== null; });
}

/**
 * Shadow 分组统计（通知后最早 N+1 = availableIndex+1 起；MFE/MAE 以 notificationPrice 为基准）。
 * @param {Array} items buildShadowItems 输出
 * @param {Array} candles 5m candles
 * @returns {Object} groups: { INSIDE_LEG, BEFORE_LEG, NO_RELATED_MSS } → {
 *   all, high, highNearHit30m, highNearCnt30m, highNearHit1h, highNearCnt1h,
 *   highMfeSum, highMaeSum, highMfeCnt, allNearHit1h, allNearCnt1h }
 */
function assessShadow(items, candles) {
    var groups = { INSIDE_LEG: null, BEFORE_LEG: null, NO_RELATED_MSS: null };
    function acc(g) {
        if (!groups[g]) {
            groups[g] = {
                all: 0, high: 0,
                highNearHit30m: 0, highNearCnt30m: 0,
                highNearHit1h: 0, highNearCnt1h: 0,
                highMfeSum: 0, highMaeSum: 0, highMfeCnt: 0,
                allNearHit1h: 0, allNearCnt1h: 0
            };
        }
        return groups[g];
    }
    function statFor(it, start, lastJ, basePrice, hitTarget, bullish) {
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
                if (c.high - basePrice > mae) mae = c.high - basePrice;
                if (hitTarget !== null && hitTarget !== undefined && c.low <= hitTarget) nearHit = true;
            }
        }
        return { mfe: mfe, mae: mae, nearHit: nearHit };
    }
    (items || []).forEach(function (it) {
        var a = acc(it.group);
        a.all++;
        var start = it.availableIndex !== null && it.availableIndex !== undefined ? it.availableIndex + 1 : null;
        if (start === null || start >= candles.length) return;
        var basePrice = it.notificationPrice !== null && it.notificationPrice !== undefined ? it.notificationPrice : null;
        if (basePrice === null) return;
        var hitTarget = it.notificationNearTarget;
        var bullish = it.direction === 'BULLISH';
        // 全部样本的 1h NearHit（对照组参考：若该组全部通知质量如何）
        var s1h = statFor(it, start, Math.min(start + 12 - 1, candles.length - 1), basePrice, hitTarget, bullish);
        if (hitTarget !== null && hitTarget !== undefined) {
            a.allNearCnt1h++;
            if (s1h.nearHit) a.allNearHit1h++;
        }
        if (it.tier !== 'HIGH_QUALITY') return;
        a.high++;
        // HIGH 子集 30m/1h
        var s30 = statFor(it, start, Math.min(start + 6 - 1, candles.length - 1), basePrice, hitTarget, bullish);
        if (hitTarget !== null && hitTarget !== undefined) {
            a.highNearCnt30m++;
            if (s30.nearHit) a.highNearHit30m++;
            a.highNearCnt1h++;
            if (s1h.nearHit) a.highNearHit1h++;
        }
        a.highMfeSum += s1h.mfe / basePrice * 100;
        a.highMaeSum += s1h.mae / basePrice * 100;
        a.highMfeCnt++;
    });
    return groups;
}

module.exports = {
    associateRelatedMss: associateRelatedMss,
    buildShadowItems: buildShadowItems,
    assessShadow: assessShadow,
    DEFAULT_BEFORE_BARS: DEFAULT_BEFORE_BARS
};
