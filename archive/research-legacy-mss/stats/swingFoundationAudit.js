/**
 * Phase 11L.16 — Swing Foundation Shadow Audit（三层拆解：LOCAL_PIVOT → STRUCTURAL_SWING → LIQUIDITY）
 *
 * 背景（用户 2026-08-20）：当前链路 "2-2 pivot → 直接叫 Swing → 直接当 Liquidity → 又拿这些 Swing
 * 去做 EQL/EQH、MSS、Sweep" 让"局部小拐点"被赋予太多语义。未来方向：
 *   LOCAL_PIVOT →（Swing Qualification）→ STRUCTURAL_SWING →（Liquidity Qualification）→ LIQUIDITY_OBJECT
 *
 * 本 phase 只做第一阶段+第二阶段 shadow（生产 detector 零改动）：
 *   母样本 = 全部 SWING 类 LIQUIDITY_SWEEP 事件（liquidityType ∈ SWING_HIGH/LOW）
 *   对每个被扫的 swing（2-2 pivot），用 **sweep 时点已知信息**（swing.confirmedAt → sweep.confirmedAt
 *   之间的窗口，无 future leakage）判定 5 个透明维度（不合成总分，各维度独立统计）：
 *
 *   ① mssReference   ：该 pivot 是否曾成为 opposing MSS 的 reference（SWING_LOW→BEARISH / SWING_HIGH→BULLISH，
 *                       且 MSS 在 sweep 前发生）——被结构确认过的 break
 *   ② protectedSwing ：pivot 确认后到 sweep 前，价格从未回到 pivot 价（第一次测试就是 sweep）——
 *                       用价格行为定义，不依赖 MSS（避免 protected↔MSS 循环定义）
 *   ③ displacementLeg：pivot 之后、sweep 之前，是否出现反向 STRONG/EXPLOSIVE displacement leg
 *                       （用户例：Pivot Low → bullish displacement → 突破 high → protected low）
 *   ④ dealingRange   ：pivot 价格是否接近更高周期极值（1h/4h，截至 sweep 时刻，复用 buildHtfExtremes）
 *   ⑤ excursion      ：pivot 后到 sweep 时价格最大远离 >= excursionAtrMin × ATR（窗口内 bar 范围均值）
 *
 * 输出：
 *   A. 每维度 true/false 两组的后续 delivery 指标（复用 computeSweepOutcomes）
 *      → 看"哪个维度有真实区分力"（STRUCTURAL 特征的维度 true 若显著强于 false，则值得收紧）
 *   B. 维度命中数分布（0..5 → forward 曲线）→ 看是否单调（全中 vs 全不中的差距）
 *
 * 决策框架（用户）：LOCAL/INTERNAL StrongLeg ~35% / HIGH ~7% vs STRUCTURAL ~55% / ~16%
 *   → 有证据才正式把 Pivot→Swing 收紧（第二轮再拿 STRUCTURAL_SWING 重建 EQL/EQH）。
 * 纯诊断，不改生产。
 */
var sweepCentricAudit = require('./sweepCentricAudit');
var externalSwingAudit = require('./externalSwingAudit');
var thresholds = require('../config/thresholds');

var DIMS = ['mssReference', 'protectedSwing', 'displacementLeg', 'dealingRange', 'excursion'];

function cfgOf(input) {
    var ext = (thresholds.events && thresholds.events.sweepExternal) ? thresholds.events.sweepExternal : {};
    return {
        htfTolerance: input.htfTolerance !== undefined ? input.htfTolerance : (ext.htfTolerance !== undefined ? ext.htfTolerance : 0.002),
        excursionAtrMin: input.excursionAtrMin !== undefined ? input.excursionAtrMin : 1.0
    };
}

/**
 * pivot 的 candle index（swing.metadata.index 优先，缺失回退 confirmedAt 反查 closeTime）。
 */
function swingIndex(swing, idxByClose) {
    if (swing && swing.metadata && typeof swing.metadata.index === 'number') {
        return swing.metadata.index;
    }
    if (idxByClose && swing && typeof swing.confirmedAt === 'number') {
        return idxByClose[swing.confirmedAt] !== undefined ? idxByClose[swing.confirmedAt] : null;
    }
    return null;
}

/** 维度①：pivot 是否在 sweep 前成为 opposing MSS 的 reference */
function hasOpposingMssReference(swing, se, mssEvents) {
    var wantDir = swing.type === 'SWING_LOW' ? 'BEARISH' : 'BULLISH';
    return (mssEvents || []).some(function (m) {
        if (m.direction !== wantDir) return false;
        if (!m.source || m.source.referenceSwingId !== swing.id) return false;
        if (typeof m.confirmedAt !== 'number' || typeof se.confirmedAt !== 'number') return false;
        // 严格在 sweep 之前发生（同根 MSS 不算——sweep K 的 intrabar 先后无法确认）
        if (m.confirmedAt >= se.confirmedAt) return false;
        return true;
    });
}

/** 维度②：pivot 确认后到 sweep 前，价格从未回到 pivot 价（第一次测试就是 sweep） */
function isProtectedUntilSweep(swing, se, candles, pivotIdx) {
    if (pivotIdx === null || typeof se.candleIndex !== 'number') return false;
    var isLow = swing.type === 'SWING_LOW';
    for (var j = pivotIdx + 1; j < se.candleIndex; j++) {
        var c = candles[j];
        if (!c) continue;
        if (isLow) {
            if (c.low <= swing.price) return false; // 提前被测试过
        } else {
            if (c.high >= swing.price) return false;
        }
    }
    return true;
}

/** 维度③：pivot 之后、sweep 之前，是否出现反向 STRONG/EXPLOSIVE displacement leg */
function hasOpposingLeg(swing, se, idx) {
    var wantDir = swing.type === 'SWING_LOW' ? 'BULLISH' : 'BEARISH';
    var pivotIdx = swingIndex(swing, idx.idxByClose);
    if (pivotIdx === null || typeof se.candleIndex !== 'number') return false;
    var found = false;
    Object.keys(idx.dispByIndex || {}).forEach(function (k) {
        if (found) return;
        var j = parseInt(k, 10);
        if (j <= pivotIdx || j >= se.candleIndex) return;
        (idx.dispByIndex[k] || []).forEach(function (d) {
            if (d.direction !== wantDir) return;
            var leg = idx.legByDispId && idx.legByDispId[d.id];
            if (leg && (leg.quality === 'STRONG' || leg.quality === 'EXPLOSIVE')) found = true;
        });
    });
    return found;
}

/** 维度④：pivot 价格是否接近更高周期极值（1h/4h，截至 sweep 时刻） */
function nearDealingRange(swing, se, htfIndexes, cfg) {
    if (!htfIndexes || htfIndexes.length === 0 || !swing) return false;
    var isLow = swing.type === 'SWING_LOW';
    for (var i = 0; i < htfIndexes.length; i++) {
        if (htfIndexes[i] &&
            externalSwingAudit.nearHtfExtreme(htfIndexes[i], se.confirmedAt, swing.price, isLow, cfg.htfTolerance)) {
            return true;
        }
    }
    return false;
}

/**
 * 维度⑤：pivot 后到 sweep 时的最大远离 / ATR（窗口内 bar 范围均值）>= excursionAtrMin。
 * 窗口 = (pivotIdx, se.candleIndex]（含 sweep 触发 K，其收盘通常已远离 pivot）。
 */
function excursionAtr(swing, se, candles, pivotIdx) {
    if (pivotIdx === null || typeof se.candleIndex !== 'number') return 0;
    var isLow = swing.type === 'SWING_LOW';
    var maxFar = 0;
    var sumRange = 0;
    var n = 0;
    for (var j = pivotIdx + 1; j <= se.candleIndex; j++) {
        var c = candles[j];
        if (!c) continue;
        if (isLow) {
            if (c.high - swing.price > maxFar) maxFar = c.high - swing.price;
        } else {
            if (swing.price - c.low > maxFar) maxFar = swing.price - c.low;
        }
        sumRange += (c.high - c.low);
        n++;
    }
    if (n === 0 || sumRange <= 0) return 0;
    return maxFar / (sumRange / n);
}

/**
 * Swing Foundation Audit（母样本 = 全部 SWING 类 sweep）。
 * @param {Object} input
 *   {
 *     sweepEvents, swings, mssEvents, displacementEvents, legByDispId, alerts, candles,
 *     htfCandles（可选 {'1h':[...], '4h':[...]}）, windowBars, excursionAtrMin, htfTolerance
 *   }
 * @returns {Object} {
 *   dimensionStats: { DIM: { t: acc, f: acc } },   // acc = { n, mss, protectedMss, strongLeg, high, mfeSum, maeSum, mfeCnt }
 *   countDist: { '0'..'5': acc },                  // 维度命中数 → forward（看单调性）
 *   nTotal, unresolved,                            // unresolved = swing 解析不到/无法定位 pivot
 *   dims, windowBars
 * }
 */
function auditSwingFoundation(input) {
    var idx = sweepCentricAudit.buildOutcomeIndex(input);
    var cfg = cfgOf(input);
    idx.idxByClose = null;
    // closeTime → index（pivot 定位 fallback）
    var idxByClose = {};
    (input.candles || []).forEach(function (c, i) {
        if (c && typeof c.closeTime === 'number') idxByClose[c.closeTime] = i;
    });
    idx.idxByClose = idxByClose;

    var swingsById = {};
    (input.swings || []).forEach(function (s) { if (s && s.id) swingsById[s.id] = s; });

    var htfIndexes = [];
    if (input.htfCandles) {
        var list = Array.isArray(input.htfCandles) ? input.htfCandles : [input.htfCandles['1h'], input.htfCandles['4h']];
        list.forEach(function (hc) {
            var ex = externalSwingAudit.buildHtfExtremes(hc);
            if (ex) htfIndexes.push(ex);
        });
    }

    var nTotal = 0;
    var unresolved = 0;
    var dimensionStats = {};
    var countDist = {};

    function newAcc() {
        return { n: 0, mss: 0, protectedMss: 0, strongLeg: 0, high: 0, mfeSum: 0, maeSum: 0, mfeCnt: 0 };
    }
    function accAdd(g, o) {
        g.n++;
        if (o.mss) g.mss++;
        if (o.protectedMss) g.protectedMss++;
        if (o.strongLeg) g.strongLeg++;
        if (o.high) g.high++;
        if (o.counted) {
            g.mfeSum += o.mfePct;
            g.maeSum += o.maePct;
            g.mfeCnt++;
        }
    }
    DIMS.forEach(function (d) {
        dimensionStats[d] = { t: newAcc(), f: newAcc() };
    });
    for (var k = 0; k <= DIMS.length; k++) countDist[k] = newAcc();

    (input.sweepEvents || []).forEach(function (se) {
        var st = (se.source && se.source.liquidityType) || se.liquidityType;
        if (!sweepCentricAudit.isSwingType(st)) return;
        nTotal++;
        var swing = swingsById[se.liquidityId] || null;
        var o = sweepCentricAudit.computeSweepOutcomes(se, idx);
        if (!swing || !o) { unresolved++; return; }
        var pivotIdx = swingIndex(swing, idxByClose);
        if (pivotIdx === null) { unresolved++; return; }

        var sw = {
            mssReference: hasOpposingMssReference(swing, se, input.mssEvents || []),
            protectedSwing: isProtectedUntilSweep(swing, se, input.candles || [], pivotIdx),
            displacementLeg: hasOpposingLeg(swing, se, idx),
            dealingRange: nearDealingRange(swing, se, htfIndexes, cfg),
            excursion: excursionAtr(swing, se, input.candles || [], pivotIdx) >= cfg.excursionAtrMin
        };
        DIMS.forEach(function (d) {
            accAdd(dimensionStats[d][sw[d] ? 't' : 'f'], o);
        });
        var hit = 0;
        DIMS.forEach(function (d) { if (sw[d]) hit++; });
        accAdd(countDist[hit], o);
    });

    return {
        dimensionStats: dimensionStats,
        countDist: countDist,
        dims: DIMS,
        nTotal: nTotal,
        unresolved: unresolved,
        windowBars: idx.windowBars,
        excursionAtrMin: cfg.excursionAtrMin,
        htfTolerance: cfg.htfTolerance
    };
}

module.exports = {
    auditSwingFoundation: auditSwingFoundation,
    hasOpposingMssReference: hasOpposingMssReference,
    isProtectedUntilSweep: isProtectedUntilSweep,
    hasOpposingLeg: hasOpposingLeg,
    nearDealingRange: nearDealingRange,
    excursionAtr: excursionAtr,
    swingIndex: swingIndex,
    DIMS: DIMS
};
