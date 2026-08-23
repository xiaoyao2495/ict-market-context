/**
 * Phase 11L.17 — Equal Liquidity Quality Audit（Liquidity Object 本身的质量）
 *
 * 背景（用户 2026-08-20）：11L.16 封板 —— 2-2 Pivot→Swing 层不收紧（无可靠 sweep 前资格特征，
 * protected/age/displacement/excursion 无单调增量）。下一步不问"哪个 Swing 更高级"，而问
 * "什么价格位置天然更可能形成真正的 liquidity pool"。优先 EQL/EQH，因为它们由 5m 2-2 pivot
 * 直接生成，但被当作 Significant Liquidity（11L.15 B 口径 → PRIORITY_HIGH）——"两个普通 local
 * pivot 价格恰好接近 → EQL → 立即升级 Significant"这个跃迁是否太容易？
 *
 * 本模块从 EQL/EQH Event 本身出发（sweep 时点可观测信息，无 future leakage，无循环依赖——
 * forward 指标 MSS/StrongLeg/HIGH 不参与任何维度判定），对每个 EQL/EQH 类 sweep 判定 6 个透明
 * 维度（不合成总分，各维度独立统计）：
 *
 *   ① touchCount      ：level 由几个成员构成（metadata.memberCount；2 touch / 3+ touch）
 *   ② clusterWidth    ：成员价差跨度 / tolerance（width/tolerance，越接近 1 越 loose）
 *   ③ formationSpan   ：第一个成员 sourceOpenTime → 最后成员 sourceCloseTime（5m bar 数；
 *                        <12 bars 快速形成 / >=12 bars 长时间形成）
 *   ④ ageBeforeSweep  ：level 形成（confirmedAt = 最后成员确认）→ sweep 的存活 bar 数
 *                        （<48 bars 年轻 / >=48 bars 老）
 *   ⑤ reactionStrength：每个成员 touch 后 5 bars 内价格最大远离 >= 1.0 × 窗口平均 range
 *                        （全部成员满足 → strong；触及后无反应 → weak）
 *   ⑥ cleanliness     ：level 形成后、sweep 前，close 穿越 level 次数 === 0 → clean；
 *                        反复穿越 → polluted
 *
 * 输出（同 11L.16 结构）：
 *   A. 每维度 true/false 两组的后续 delivery 指标（复用 sweepCentricAudit.computeSweepOutcomes：
 *      MSS / protectedMSS / StrongLeg / HIGH / MFE / MAE，1h 窗口）
 *   B. 维度命中数分布 0..6 → forward 曲线（看单调性：质量维度全部命中 vs 全部未命中）
 *
 * 决策框架（用户）：若 "2-touch loose EQL HIGH ~8%" vs "3+ touch clean EQL HIGH ~18%+"
 *   → 找到 Liquidity Object Quality，后续可收窄 Significant 口径（通知层净化）；
 *   若无差异 → 维持现状（EQL/EQH 升级 Significant 跃迁无大害）。
 * 纯诊断，生产 detector 零改动。
 */
var sweepCentricAudit = require('./sweepCentricAudit');
var equalLiquidity = require('../liquidity/equalLiquidity');
var thresholds = require('../config/thresholds');

var DIMS = ['touchCount', 'clusterWidth', 'formationSpan', 'ageBeforeSweep', 'reactionStrength', 'cleanliness'];

/**
 * 诊断参数（非生产判定阈值——生产阈值只读自 thresholds.equalLiquidity）。
 * 全部可在 input 覆盖，供测试/分桶实验。
 */
function cfgOf(input) {
    var c = input || {};
    return {
        barMs: 300000,                 // 5m
        tickSize: c.tickSize !== undefined ? c.tickSize : 0, // 生产容差含 tickSize（exchangeInfo），默认退化纯百分比
        widthLooseRatio: c.widthLooseRatio !== undefined ? c.widthLooseRatio : 0.5,
        spanBarsMin: c.spanBarsMin !== undefined ? c.spanBarsMin : 12,
        ageBarsMin: c.ageBarsMin !== undefined ? c.ageBarsMin : 48,
        reactionBars: c.reactionBars !== undefined ? c.reactionBars : 5,
        reactionAtrMin: c.reactionAtrMin !== undefined ? c.reactionAtrMin : 1.0,
        right: c.right !== undefined ? c.right : 2
    };
}

/** 是否为 EQL/EQH 类 sweep（母样本筛选） */
function isEqualType(sourceType) {
    var t = String(sourceType || '').toUpperCase();
    return t === 'EQL' || t === 'EQH';
}

/** ① touchCount：memberCount >= 3 → '3+ touch'（true）；=== 2 → '2 touch'（false） */
function touchCountDim(eq) {
    return (eq.metadata && eq.metadata.memberCount) >= 3;
}

/** ② clusterWidth：width / tolerance >= 0.5 → 'loose'（true）；< 0.5 → 'tight'（false） */
function clusterWidthDim(eq, cfg) {
    var md = eq.metadata;
    if (!md || typeof md.maxPrice !== 'number' || typeof md.minPrice !== 'number') return false;
    var w = md.maxPrice - md.minPrice;
    var eqCfg = thresholds.equalLiquidity || {};
    var tol = equalLiquidity.toleranceFor(
        eq.price,
        eqCfg.percentageTolerance,
        cfg.tickSize,
        (thresholds.tickSize || {}).equalMultiplier
    );
    if (!(tol > 0)) return false;
    return w / tol >= cfg.widthLooseRatio;
}

/** ③ formationSpan：成员时间跨度 >= 12 bars → 'slow'（true）；< 12 → 'fast'（false） */
function formationSpanDim(eq, cfg) {
    if (typeof eq.sourceCloseTime !== 'number' || typeof eq.sourceOpenTime !== 'number') return false;
    var spanMs = eq.sourceCloseTime - eq.sourceOpenTime;
    if (spanMs <= 0) return false;
    return Math.round(spanMs / cfg.barMs) >= cfg.spanBarsMin;
}

/** ④ ageBeforeSweep：level 形成 → sweep 存活 >= 48 bars → 'old'（true）；< 48 → 'young'（false） */
function ageBeforeSweepDim(eq, se, cfg) {
    if (typeof eq.confirmedAt !== 'number' || typeof se.confirmedAt !== 'number') return false;
    var ageMs = se.confirmedAt - eq.confirmedAt;
    if (ageMs < 0) return false;
    return Math.round(ageMs / cfg.barMs) >= cfg.ageBarsMin;
}

/**
 * ⑤ reactionStrength：每个成员 touch 后 5 bars 内最大远离 >= 1.0 × 窗口平均 range。
 * 窗口 = [成员确认 bar 下一根, +reactionBars)，clamp 到 sweep K（无未来泄漏）。
 * 全部成员满足 → strong（true）；任一成员无反应 → weak（false）。
 */
function reactionStrengthDim(eq, se, candles, idxByClose, cfg) {
    var md = eq.metadata;
    if (!md || !Array.isArray(md.members) || md.members.length === 0) return false;
    var level = eq.price;
    var end = typeof se.candleIndex === 'number' ? se.candleIndex : Infinity;
    for (var i = 0; i < md.members.length; i++) {
        var m = md.members[i];
        var startIdx = null;
        if (m && typeof m.sourceCloseTime === 'number' && idxByClose[m.sourceCloseTime] !== undefined) {
            startIdx = idxByClose[m.sourceCloseTime] + 1;
        } else if (m && m.metadata && typeof m.metadata.index === 'number') {
            startIdx = m.metadata.index + cfg.right + 1;
        }
        if (startIdx === null) return false;
        var best = 0;
        var sumRange = 0;
        var n = 0;
        for (var j = startIdx; j < Math.min(startIdx + cfg.reactionBars, end); j++) {
            var c = candles[j];
            if (!c) continue;
            var far = Math.max(c.high - level, level - c.low);
            if (far > best) best = far;
            sumRange += (c.high - c.low);
            n++;
        }
        if (n === 0 || sumRange <= 0) return false;
        if (best / (sumRange / n) < cfg.reactionAtrMin) return false;
    }
    return true;
}

/**
 * ⑥ cleanliness：level 形成（最后成员确认）后、sweep K 前，close 穿越 level 次数 === 0 → clean（true）。
 * 穿越 = close 从 level 一侧摆到另一侧（wick 触及不算）。
 */
function cleanlinessDim(eq, se, candles, idxByClose) {
    if (typeof eq.confirmedAt !== 'number' || typeof se.candleIndex !== 'number') return false;
    var eqIdx = idxByClose[eq.confirmedAt];
    if (eqIdx === undefined || eqIdx === null) return false;
    var level = eq.price;
    var side = null;
    var crosses = 0;
    for (var j = eqIdx + 1; j < se.candleIndex; j++) {
        var c = candles[j];
        if (!c) continue;
        var ns = c.close >= level ? 1 : -1;
        if (side === null) {
            side = ns;
        } else if (ns !== side) {
            crosses++;
            side = ns;
        }
    }
    return crosses === 0;
}

/**
 * 组合质量命中（用户 11L.17 下一刀：tight + young + clean 的 0/3 → 3/3 验证）。
 * 注意维度布尔方向：tight = clusterWidth==false，young = ageBeforeSweep==false，clean = cleanliness==true。
 * 概念干净：三个条件都是 EQL/EQH 自身形成/保持质量，不混 swing 生命周期维度（excursionV2）。
 */
var QUALITY_CONDITIONS = ['tight', 'young', 'clean'];

function qualityHits(sw) {
    var hits = 0;
    if (!sw.clusterWidth) hits++;    // tight（成员紧密）
    if (!sw.ageBeforeSweep) hits++;  // young（形成后 48 bars 内被扫）
    if (sw.cleanliness) hits++;      // clean（sweep 前未被反复穿越）
    return hits;
}

/**
 * Equal Liquidity Quality Audit（母样本 = 全部 EQL/EQH 类 sweep）。
 * @param {Object} input
 *   {
 *     sweepEvents, equalLiquidity（EQL/EQH 事件数组，replay result.equalLiquidity）,
 *     mssEvents, swings, displacementEvents, legByDispId, alerts, candles,
 *     windowBars, widthLooseRatio/spanBarsMin/ageBarsMin/reactionBars/reactionAtrMin/right（可选）
 *   }
 * @returns {Object} {
 *   dimensionStats: { DIM: { t: acc, f: acc } },
 *   countDist: { '0'..'6': acc },
 *   nTotal, unresolved, dims, windowBars, cfg
 * }
 */
function auditEqualLiquidity(input) {
    var idx = sweepCentricAudit.buildOutcomeIndex(input);
    var cfg = cfgOf(input);
    var idxByClose = {};
    (input.candles || []).forEach(function (c, i) {
        if (c && typeof c.closeTime === 'number') idxByClose[c.closeTime] = i;
    });

    var eqById = {};
    (input.equalLiquidity || []).forEach(function (e) {
        if (e && e.id) eqById[e.id] = e;
    });

    var nTotal = 0;
    var unresolved = 0;
    var dimensionStats = {};
    var countDist = {};
    var qualityDist = {};

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
    for (var q = 0; q <= QUALITY_CONDITIONS.length; q++) qualityDist[q] = newAcc();

    (input.sweepEvents || []).forEach(function (se) {
        var st = (se.source && se.source.liquidityType) || se.liquidityType;
        if (!isEqualType(st)) return;
        nTotal++;
        var eq = eqById[se.liquidityId] || null;
        var o = sweepCentricAudit.computeSweepOutcomes(se, idx);
        if (!eq || !eq.metadata || !Array.isArray(eq.metadata.members) || eq.metadata.members.length < 2 || !o) {
            unresolved++;
            return;
        }

        var sw = {
            touchCount: touchCountDim(eq),
            clusterWidth: clusterWidthDim(eq, cfg),
            formationSpan: formationSpanDim(eq, cfg),
            ageBeforeSweep: ageBeforeSweepDim(eq, se, cfg),
            reactionStrength: reactionStrengthDim(eq, se, input.candles || [], idxByClose, cfg),
            cleanliness: cleanlinessDim(eq, se, input.candles || [], idxByClose)
        };
        DIMS.forEach(function (d) {
            accAdd(dimensionStats[d][sw[d] ? 't' : 'f'], o);
        });
        var hit = 0;
        DIMS.forEach(function (d) { if (sw[d]) hit++; });
        accAdd(countDist[hit], o);
        accAdd(qualityDist[qualityHits(sw)], o);
    });

    return {
        dimensionStats: dimensionStats,
        countDist: countDist,
        qualityDist: qualityDist,
        qualityConditions: QUALITY_CONDITIONS,
        dims: DIMS,
        nTotal: nTotal,
        unresolved: unresolved,
        windowBars: idx.windowBars,
        cfg: cfg
    };
}

module.exports = {
    auditEqualLiquidity: auditEqualLiquidity,
    isEqualType: isEqualType,
    touchCountDim: touchCountDim,
    clusterWidthDim: clusterWidthDim,
    formationSpanDim: formationSpanDim,
    ageBeforeSweepDim: ageBeforeSweepDim,
    reactionStrengthDim: reactionStrengthDim,
    cleanlinessDim: cleanlinessDim,
    qualityHits: qualityHits,
    QUALITY_CONDITIONS: QUALITY_CONDITIONS,
    DIMS: DIMS,
    cfgOf: cfgOf
};
