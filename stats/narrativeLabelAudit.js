/**
 * Bias Phase 1 — ICT Narrative Ground Truth（纯诊断，生产零改动）
 *
 * 用户定案（2026-08-21）：不先写 Bias 算法，先建立"考试标准"——
 * 客观、无未来泄漏地识别完整 Bullish/Bearish ICT Narrative。
 *
 * Narrative Formation 定义（Follow-through 不塞进成立条件）：
 *   BULLISH  = SSL Raid（sweep.direction === 'BULLISH'，Sell-side 被获取）
 *              → Bullish Structural MSS（DC，同方向）
 *              → Bullish Displacement（leg.mssId === mss.id，12.5B 归属机制）
 *   BEARISH  = BSL Raid → Bearish Structural MSS → Bearish Displacement（镜像）
 *
 * Follow-through 单独作为 Outcome（不混入 setup）：
 *   disp 确认后 30m/1h/4h：MFE / MAE / Near Draw Hit / Continuation（同向新 disp）/
 *   Invalidation（反向 MSS）
 *
 * 纪律：
 *   - Raid→MSS 不设时间上限（锁因果顺序不锁距离，12.5B），记录 bars 分布
 *   - Detection 全部冻结：复用 replay 输出（sweepEvents + DC MSS + displacement +
 *     drawTrace）；Bias Engine 不动
 *   - 无未来泄漏：narrative 只用 raid ≤ mss ≤ disp 的已确认事件；outcome 从 disp 之后
 */
var displacementLeg = require('./displacementLeg');

/** 时间窗口（bars） */
var W30M = 6;
var W1H = 12;
var W4H = 48;

/**
 * 构造 narrative 链：每个 sweep → 下一个同向 DC MSS → 该 MSS 的 displacement leg。
 *
 * ⚠️ 边界纪律（防 target leakage）：本函数只消费 raid → MSS → Displacement 三段已确认事件；
 *    Follow-through（MFE/MAE/continuation/invalidation，见 outcomeOf）永远只作 Outcome，
 *    严禁回写进 NARRATIVE FORMED 定义。否则将来用 Bias 预测 Narrative 时，等于把"后来走对了"
 *    写进正确答案——典型 target leakage。13A.2 的 63.8%/70% 也只作旁证，不得用来反调本函数定义。
 * @param {Object} ctx { sweeps, mssEvents, legByDispId }
 * @returns {Array} narrative 数组 [{ raidSide, raidIndex, raidTime, mssId, mssIndex,
 *   mssTime, dispId, dispIndex, dispTime, raidToMssBars, mssToDispBars }]
 */
function buildNarratives(ctx) {
    var sweeps = (ctx.sweeps || []).slice().sort(function (a, b) {
        return (a.candleIndex || 0) - (b.candleIndex || 0);
    });
    var mssEvents = (ctx.mssEvents || []).filter(function (m) {
        return m && (m.direction === 'BULLISH' || m.direction === 'BEARISH') && typeof m.candleIndex === 'number';
    }).sort(function (a, b) { return a.candleIndex - b.candleIndex; });

    // mssId → leg 索引（同方向；一个 mss 触发一个 leg）
    var legByMssId = {};
    var legByDispId = ctx.legByDispId || {};
    Object.keys(legByDispId).forEach(function (did) {
        var leg = legByDispId[did];
        if (!leg || !leg.mssId || !leg.direction) return;
        if (!legByMssId[leg.mssId]) legByMssId[leg.mssId] = [];
        legByMssId[leg.mssId].push({ dispId: did, leg: leg });
    });

    var out = [];
    sweeps.forEach(function (sw) {
        var dir = sw.direction; // BULLISH（SSL raid）/ BEARISH（BSL raid）
        var raidIdx = typeof sw.candleIndex === 'number' ? sw.candleIndex : null;
        if (!raidIdx) return;
        // 下一个同向 DC MSS（raid 之后）
        var mss = null;
        for (var i = 0; i < mssEvents.length; i++) {
            if (mssEvents[i].candleIndex > raidIdx && mssEvents[i].direction === dir) { mss = mssEvents[i]; break; }
        }
        if (!mss) return;
        // 该 MSS 的 displacement leg（同方向）
        var legs = legByMssId[mss.id] || [];
        var hit = null;
        for (var j = 0; j < legs.length; j++) {
            if (legs[j].leg.direction === dir) { hit = legs[j]; break; }
        }
        if (!hit) return;
        var leg = hit.leg;
        var dispIdx = typeof leg.startIndex === 'number' ? leg.startIndex : null;
        out.push({
            raidSide: sw.side === 'BSL' ? 'BSL' : 'SSL',
            raidIndex: raidIdx,
            raidTime: sw.confirmedAt || null,
            mssId: mss.id,
            mssIndex: mss.candleIndex,
            mssTime: mss.confirmedAt || null,
            dispId: hit.dispId,
            dispIndex: dispIdx,
            dispTime: null,
            raidToMssBars: mss.candleIndex - raidIdx,
            mssToDispBars: dispIdx !== null ? dispIdx - mss.candleIndex : null
        });
    });
    return out;
}

/**
 * Narrative 的 follow-through outcome（disp 之后，无未来泄漏）。
 * @param {Object} narrative buildNarratives 单项
 * @param {Object} ctx { candles, drawTrace }
 * @returns {Object} { mfe30m, mfe1h, mfe4h, mae1h, nearHit1h, continuation, invalidated }
 *   （null 表示窗口数据不足）
 */
function outcomeOf(narrative, ctx) {
    var candles = ctx.candles || [];
    var dispIdx = narrative.dispIndex;
    if (dispIdx === null || dispIdx === undefined) return null;
    var baseBar = candles[dispIdx];
    if (!baseBar) return null;
    var base = baseBar.close;
    var dir = narrative.raidSide === 'SSL' ? 'BULLISH' : 'BEARISH'; // SSL raid → bullish

    var mfe = { '30': null, '1h': null, '4h': null };
    var mae = { '1h': null };
    var nearHit1h = null;

    // near target（as-of disp 时点）：BULLISH → 上方 bslNear；BEARISH → 下方 sslNear
    var dt = ctx.drawTrace && ctx.drawTrace[dispIdx];
    var target = null;
    if (dt) target = dir === 'BULLISH' ? dt.bslNear : dt.sslNear;

    var end4h = Math.min(candles.length, dispIdx + W4H);
    for (var j = dispIdx + 1; j < end4h; j++) {
        var c = candles[j];
        if (!c) continue;
        var rel = j - dispIdx;
        if (dir === 'BULLISH') {
            if (c.high - base > mfe['4h'] || mfe['4h'] === null) mfe['4h'] = c.high - base;
            if (rel <= W30M && (c.high - base > mfe['30'] || mfe['30'] === null)) mfe['30'] = c.high - base;
            if (rel <= W1H) {
                if (c.high - base > mfe['1h'] || mfe['1h'] === null) mfe['1h'] = c.high - base;
                if (base - c.low > mae['1h'] || mae['1h'] === null) mae['1h'] = base - c.low;
                if (target !== null && target !== undefined && c.high >= target) nearHit1h = true;
            }
        } else {
            if (base - c.low > mfe['4h'] || mfe['4h'] === null) mfe['4h'] = base - c.low;
            if (rel <= W30M && (base - c.low > mfe['30'] || mfe['30'] === null)) mfe['30'] = base - c.low;
            if (rel <= W1H) {
                if (base - c.low > mfe['1h'] || mfe['1h'] === null) mfe['1h'] = base - c.low;
                if (c.high - base > mae['1h'] || mae['1h'] === null) mae['1h'] = c.high - base;
                if (target !== null && target !== undefined && c.low <= target) nearHit1h = true;
            }
        }
    }
    // continuation：4h 内同向新 displacement（disp 之后）
    var cont = false;
    (ctx.displacementEvents || []).forEach(function (d) {
        if (typeof d.candleIndex === 'number' && d.candleIndex > dispIdx && d.candleIndex <= dispIdx + W4H && d.direction === dir) cont = true;
    });
    // invalidation：4h 内反向 MSS（disp 之后）
    var inv = false;
    (ctx.mssEvents || []).forEach(function (m) {
        if (typeof m.candleIndex === 'number' && m.candleIndex > dispIdx && m.candleIndex <= dispIdx + W4H &&
            m.direction !== dir && (m.direction === 'BULLISH' || m.direction === 'BEARISH')) inv = true;
    });

    return {
        mfe30m: mfe['30'],
        mfe1h: mfe['1h'],
        mfe4h: mfe['4h'],
        mae1h: mae['1h'],
        nearHit1h: nearHit1h,
        continuation: cont,
        invalidated: inv
    };
}

/**
 * Population Audit：narratives 分布 + Raid→MSS/Disp 转化率 + 时间结构 + outcome。
 * @param {Object} ctx { candles, sweeps, mssEvents, displacementEvents, legByDispId, drawTrace }
 * @returns {Object} { narratives, stats, outcome }
 */
function auditNarratives(ctx) {
    var narratives = buildNarratives(ctx);

    // Raid→MSS / Raid→Disp 转化率
    var sweeps = (ctx.sweeps || []).filter(function (s) {
        return (s.direction === 'BULLISH' || s.direction === 'BEARISH') && typeof s.candleIndex === 'number';
    });
    var raidToMss = 0, raidToDisp = 0;
    var narrByRaidSide = { BSL: 0, SSL: 0 };
    var median = { raidToMss: [], mssToDisp: [], raidToDisp: [] };

    // mss→disp 索引（用于转化率统计的"有 MSS"判定）
    var mssSet = {};
    (ctx.mssEvents || []).forEach(function (m) { if (m && m.id) mssSet[m.id] = true; });

    narratives.forEach(function (n) {
        narrByRaidSide[n.raidSide] = (narrByRaidSide[n.raidSide] || 0) + 1;
        median.raidToMss.push(n.raidToMssBars);
        if (n.mssToDispBars !== null) median.mssToDisp.push(n.mssToDispBars);
        median.raidToDisp.push(n.mssToDispBars !== null ? n.raidToMssBars + n.mssToDispBars : null);
    });

    // outcome 聚合
    var outcome = { BULLISH: [], BEARISH: [] };
    narratives.forEach(function (n) {
        var o = outcomeOf(n, ctx);
        if (o) outcome[n.raidSide === 'SSL' ? 'BULLISH' : 'BEARISH'].push(o);
    });

    return {
        narratives: narratives,
        stats: {
            totalSweeps: sweeps.length,
            bullSweeps: sweeps.filter(function (s) { return s.direction === 'BULLISH'; }).length,
            bearSweeps: sweeps.filter(function (s) { return s.direction === 'BEARISH'; }).length,
            narratives: narratives.length,
            narrByRaidSide: narrByRaidSide,
            raidToMssRate: null, // 由调用方补（需要 raid→mss 配对计数，见下）
            raidToDispRate: null,
            medianBars: {
                raidToMss: medianOf(median.raidToMss),
                mssToDisp: medianOf(median.mssToDisp),
                raidToDisp: medianOf(median.raidToDisp.filter(function (v) { return v !== null; }))
            }
        },
        outcome: outcome,
        outcomeSummary: summarizeOutcome(outcome)
    };
}

function medianOf(arr) {
    if (!arr || arr.length === 0) return null;
    var s = arr.slice().sort(function (a, b) { return a - b; });
    var m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function meanOf(arr) {
    if (!arr || arr.length === 0) return null;
    var s = 0;
    arr.forEach(function (v) { s += v; });
    return s / arr.length;
}

function summarizeOutcome(outcome) {
    var out = {};
    Object.keys(outcome).forEach(function (dir) {
        var list = outcome[dir];
        out[dir] = {
            n: list.length,
            mfe30mMean: meanOf(list.map(function (o) { return o.mfe30m; })),
            mfe1hMean: meanOf(list.map(function (o) { return o.mfe1h; })),
            mae1hMean: meanOf(list.map(function (o) { return o.mae1h; })),
            nearHit1hRate: list.length > 0 ? list.filter(function (o) { return o.nearHit1h; }).length / list.length : null,
            continuationRate: list.length > 0 ? list.filter(function (o) { return o.continuation; }).length / list.length : null,
            invalidationRate: list.length > 0 ? list.filter(function (o) { return o.invalidated; }).length / list.length : null
        };
    });
    return out;
}

module.exports = {
    W30M: W30M, W1H: W1H, W4H: W4H,
    buildNarratives: buildNarratives,
    outcomeOf: outcomeOf,
    auditNarratives: auditNarratives
};
