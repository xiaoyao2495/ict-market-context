/**
 * Phase 12.5B — Structural Liquidity Causal Chain Shadow
 *
 * 背景（用户 2026-08-20 定案）：Priority Liquidity 现状是"48 bars 窗口相关性"
 * （windowHasSignificant：allCandidates 任一 SIGNIFICANT 即通过），用户看到
 * "Priority Liquidity: BSL · EQH @ 2267.09 · 45 bars" 会理解成"这次 SHORT 是因为
 * 这个 BSL 被扫了"——但 2267 在价格下方、45 bars ago、早已被穿越，不是本次 bearish
 * delivery 的源头（真正 BSL 是 19:30 高点 2318.78）。11L.15b 只修了展示层，判定层
 * 仍是相关性窗口。
 *
 * 12.5B 冻结定义（因果链，替代相关性窗口）：
 *   DC STRUCTURAL_SWING
 *     → Structural BSL / SSL candidate（带确认时点，confirmedAt 严格：候选在 raid 当时必须已确认）
 *     → 实际 Raid（价格穿越 candidate price）
 *     → 方向匹配的 DC MSS（raid 之后）
 *     → MSS 所属当前 Displacement Leg（leg.mssId 归属）
 *     → CAUSAL LIQUIDITY
 *
 * 纪律（用户）：
 *   - **不预锁时间距离**（不写死 24 bars 窗口）——先锁因果顺序；raidToMssBars /
 *     mssToLegBars / objectAgeAtRaid 作为审计字段跑分布，之后再决定是否设上限。
 *   - **不预设正确答案**（ETH 案例不强行命中 2318.78）——时序结构正确即可，
 *     NONE 也比强行关联可信。
 *   - 验收案例：20:09 ETH SHORT 不得把 2267.09（45 bars 前、价格下方的旧 EQH）当
 *     causal BSL。
 *
 * 纯诊断：生产判定（windowHasSignificant / 通知）零改动。
 */
var alertPrioritization = require('./alertPrioritization');
var WINDOWS = [{ key: '30m', bars: 6 }, { key: '1h', bars: 12 }];
var lra = require('./liquidityRelevanceAudit');

function newAcc() {
    return { n: 0, nearHit30m: 0, nearCnt30m: 0, nearHit1h: 0, nearCnt1h: 0, mfeSum: 0, maeSum: 0, mfeCnt: 0 };
}
function accAdd(acc, al, candles) {
    acc.n++;
    var st = lra.statOne(al, candles, WINDOWS);
    if (!st) return;
    if (al.notificationNearTarget !== null && al.notificationNearTarget !== undefined) {
        if (st.complete30) { acc.nearCnt30m++; if (st.near30) acc.nearHit30m++; }
        if (st.complete1h) { acc.nearCnt1h++; if (st.near1h) acc.nearHit1h++; }
    }
    if (st.complete1h) {
        var base = al.notificationPrice !== undefined && al.notificationPrice !== null ? al.notificationPrice : al.anchorPrice;
        if (base) { acc.mfeSum += st.mfe / base * 100; acc.maeSum += st.mae / base * 100; acc.mfeCnt++; }
    }
}

/**
 * 构建 raid 索引：每个 DC swing 候选，从确认 bar 之后找价格首次穿越（raid）。
 * BSL（SWING_HIGH）→ high >= price；SSL（SWING_LOW）→ low <= price。
 * confirmedAt 严格：扫描从候选确认 bar 之后开始（确认前价格不可能穿越极值，但防御性保证）。
 * 不锁 raid 距确认的最大距离（objectAgeAtRaid 由审计字段暴露）。
 * @param {Array} dcSwings packageForMss 格式
 * @param {Array} candles
 * @returns {Object} { raidByCandidateId: { id: { raidIndex, raidPrice } | null }, confirmBarById }
 */
function buildRaidIndex(dcSwings, candles) {
    var raidByCandidateId = {};
    var confirmBarById = {};
    var idxByClose = {};
    candles.forEach(function (c, i) { if (c && typeof c.closeTime === 'number') idxByClose[c.closeTime] = i; });

    (dcSwings || []).forEach(function (s) {
        var confirmBar = s.metadata && typeof s.metadata.index === 'number'
            ? s.metadata.index
            : (idxByClose[s.confirmedAt] !== undefined ? idxByClose[s.confirmedAt] : null);
        if (confirmBar === null || confirmBar === undefined) return;
        confirmBarById[s.id] = confirmBar;
        var isHigh = s.type === 'SWING_HIGH';
        var raid = null;
        for (var j = confirmBar + 1; j < candles.length; j++) {
            var c = candles[j];
            if (!c) continue;
            if (isHigh ? c.high >= s.price : c.low <= s.price) { raid = { raidIndex: j, raidPrice: c.close }; break; }
        }
        raidByCandidateId[s.id] = raid;
    });
    return { raidByCandidateId: raidByCandidateId, confirmBarById: confirmBarById };
}

/**
 * 因果链判定：对单个 HIGH alert，找造成当前 leg 的 Structural Liquidity。
 * @param {Object} alert buildAlerts 输出（tier=HIGH_QUALITY；含 direction/dispId/legStartIndex）
 * @param {Object} ctx {
 *   dcSwings, dcMss, candles, legByDispId,
 *   raidByCandidateId, confirmBarById
 * }
 * @returns {Object|null} {
 *   candidateId, side, price, raidIndex, raidPrice,
 *   mssId, objectAgeAtRaid, raidToMssBars, mssToLegBars, raidToLegBars
 * } | null（未命中因果链）
 */
function findCausalLiquidity(alert, ctx) {
    var dir = alert.direction;
    // SHORT → BSL 候选（SWING_HIGH）；LONG → SSL 候选（SWING_LOW）
    var needType = dir === 'BEARISH' ? 'SWING_HIGH' : 'SWING_LOW';
    var needMssDir = dir === 'BEARISH' ? 'BEARISH' : 'BULLISH';
    var leg = alert.dispId ? (ctx.legByDispId[alert.dispId] || null) : null;
    if (!leg) return null;
    var legStart = leg.startIndex !== undefined ? leg.startIndex : alert.legStartIndex;
    if (legStart === undefined || legStart === null) return null;
    // 链第四环：MSS 必须属于当前 Displacement Leg（leg.mssId = displacement 的 mssEventId，
    // 即"这个 leg 由该 MSS 触发"的直接证据）。HIGH 的 leg.mssId 必非空（tier 要求
    // PROTECTED/HTF mssQuality，来自 leg.mssId 的 MSS）；为空则无因果链。
    if (!leg.mssId) return null;

    var mssByIndex = ctx.mssByIndex || {};
    var best = null;
    (ctx.dcSwings || []).forEach(function (s) {
        if (s.type !== needType) return;
        var raid = ctx.raidByCandidateId[s.id];
        if (!raid) return; // 从未被 raid
        // 候选必须在 raid 时已确认（confirmedAt 严格）——buildRaidIndex 已从确认后扫起，防御性再查
        var confirmBar = ctx.confirmBarById[s.id];
        if (confirmBar === undefined || confirmBar === null) return;
        if (confirmBar >= raid.raidIndex) return;
        // 因果顺序（锁顺序，不锁距离）：raid 必须在 leg 开始之前——raid 发生在 leg 中段
        // 不可能"导致"该 leg（raidToLegBars 仍作为审计字段，距离不设硬上限）
        if (raid.raidIndex >= legStart) return;
        // raid 后找【属于当前 leg 的同方向 DC MSS】（leg.mssId 严格匹配 = 同一因果链）
        var mss = null;
        for (var j = raid.raidIndex; j < ctx.candles.length; j++) {
            var list = mssByIndex[j] || [];
            for (var k = 0; k < list.length; k++) {
                if (list[k].direction === needMssDir && list[k].id === leg.mssId) { mss = list[k]; break; }
            }
            if (mss) break;
        }
        if (!mss) return;
        var mssToLegBars = mss.candleIndex - legStart;
        var candidate = {
            candidateId: s.id,
            side: s.side,
            price: s.price,
            raidIndex: raid.raidIndex,
            raidPrice: raid.raidPrice,
            mssId: mss.id,
            objectAgeAtRaid: raid.raidIndex - confirmBar,
            raidToMssBars: mss.candleIndex - raid.raidIndex,
            mssToLegBars: mssToLegBars,
            raidToLegBars: legStart - raid.raidIndex
        };
        // 取 raid 最接近 leg 开始（raidToLegBars 最小且 >= 0 优先）的候选
        if (!best || candidate.raidToLegBars < best.raidToLegBars) best = candidate;
    });
    return best;
}

/**
 * 12.5B 审计：全部 HIGH 的四象限 + 因果覆盖率 + 时间分布。
 * @param {Array} alerts DC 链路 HIGH alerts
 * @param {Object} ctx { dcSwings, dcMss, candles, legByDispId }
 * @returns {Object} {
 *   total, causalRate, windowRate,
 *   quadrants: { BOTH/CAUSAL_ONLY/WINDOW_ONLY/NEITHER: acc },
 *   dist: { objectAgeAtRaid/raidToMssBars/mssToLegBars/raidToLegBars: { 桶: n } },
 *   samples: [{ id, direction, causalPrice, causalRaidIndex, ... }]（诊断样例）
 * }
 */
function auditCausalShadow(alerts, ctx) {
    var idx = buildRaidIndex(ctx.dcSwings, ctx.candles);
    var mssByIndex = {};
    (ctx.dcMss || []).forEach(function (m) {
        if (typeof m.candleIndex !== 'number') return;
        if (!mssByIndex[m.candleIndex]) mssByIndex[m.candleIndex] = [];
        mssByIndex[m.candleIndex].push(m);
    });
    var fullCtx = {
        dcSwings: ctx.dcSwings || [],
        dcMss: ctx.dcMss || [],
        candles: ctx.candles,
        legByDispId: ctx.legByDispId || {},
        raidByCandidateId: idx.raidByCandidateId,
        confirmBarById: idx.confirmBarById,
        mssByIndex: mssByIndex
    };

    var quadrants = { BOTH: newAcc(), CAUSAL_ONLY: newAcc(), WINDOW_ONLY: newAcc(), NEITHER: newAcc() };
    var dist = {
        objectAgeAtRaid: {}, raidToMssBars: {}, mssToLegBars: {}, raidToLegBars: {}
    };
    var samples = [];
    var causalCount = 0;
    var windowCount = 0;

    function accBucket(map, v) {
        var b = v <= 0 ? '<=0' : v <= 6 ? '1-6' : v <= 12 ? '7-12' : v <= 24 ? '13-24' : v <= 48 ? '25-48' : '49+';
        map[b] = (map[b] || 0) + 1;
    }

    (alerts || []).forEach(function (al) {
        if (al.tier !== 'HIGH_QUALITY') return;
        var causal = findCausalLiquidity(al, fullCtx);
        var win = alertPrioritization.windowHasSignificant(al);
        if (causal) causalCount++;
        if (win) windowCount++;
        var q = (causal && win) ? 'BOTH' : (causal ? 'CAUSAL_ONLY' : (win ? 'WINDOW_ONLY' : 'NEITHER'));
        accAdd(quadrants[q], al, ctx.candles);
        if (causal) {
            accBucket(dist.objectAgeAtRaid, causal.objectAgeAtRaid);
            accBucket(dist.raidToMssBars, causal.raidToMssBars);
            accBucket(dist.mssToLegBars, causal.mssToLegBars);
            accBucket(dist.raidToLegBars, causal.raidToLegBars);
        }
        samples.push({
            id: al.id,
            direction: al.direction,
            anchorIndex: al.anchorIndex,
            quadrant: q,
            causalPrice: causal ? causal.price : null,
            causalSide: causal ? causal.side : null,
            causalRaidIndex: causal ? causal.raidIndex : null,
            causalRaidToLegBars: causal ? causal.raidToLegBars : null,
            windowSignificantPrices: alertPrioritization.significantCandidates(al).map(function (c) {
                return { sourceType: c.sourceType, sourcePrice: c.sourcePrice, barsBeforeLegStart: c.barsBeforeLegStart };
            })
        });
    });

    var total = samples.length;
    return {
        total: total,
        causalRate: total > 0 ? causalCount / total : 0,
        windowRate: total > 0 ? windowCount / total : 0,
        quadrants: quadrants,
        dist: dist,
        samples: samples
    };
}

module.exports = {
    buildRaidIndex: buildRaidIndex,
    findCausalLiquidity: findCausalLiquidity,
    auditCausalShadow: auditCausalShadow,
    newAcc: newAcc,
    accAdd: accAdd
};
