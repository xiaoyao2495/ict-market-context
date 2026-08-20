/**
 * Phase 11L.13 — Liquidity Incremental Value Audit（独立增量）
 *
 * 方法论（用户 2026-08-20）：Liquidity Object 不互斥 —— 同一价格区域可能同时是
 * 5m SWING_LOW + EQL + PDL，价格扫过时 Registry 产生多个 SweepEvent，同一段 delivery
 * 可能同时记到多个类型 → 11L.12 的"各类型启动率差不多"可能只是共现（普通 swing
 * 搭了重要 liquidity 的便车），不代表普通 Swing 有独立信息。
 *
 * 分组（价格容差 + 时间窗口判定共现）：
 *   SWING_ONLY            5m SWING sweep，附近无 EQL/EQH、PDH/PDL、Session
 *   SWING_OVERLAP         5m SWING sweep，与至少一种 significant 重合
 *   SIGNIFICANT_ONLY      significant sweep，附近无普通 swing
 *   SIGNIFICANT_OVERLAP   significant + swing 共现
 *
 * 多指标（不只用 HIGH formation，因 HIGH 依赖当前 MSS/Leg/Draw 定义）：
 *   Protected MSS rate / STRONG·EXPLOSIVE Leg rate / HIGH formation rate /
 *   directional MFE / adverse MAE（复用 sweepCentricAudit 的后续 delivery 指标）
 *
 * 决策：
 *   SWING_ONLY HIGH ≈ SIGNIFICANT_ONLY → 普通 swing 有独立信息价值，不删
 *   SWING_ONLY 明显低、SWING_OVERLAP 明显高 → swing 搭便车，删除/降级有据
 *
 * 纯诊断，不改生产。
 */
var sweepCentricAudit = require('./sweepCentricAudit');
var thresholds = require('../config/thresholds');

/**
 * @param {Object} se sweep 事件
 * @param {Object} cfg { priceTolerance, overlapBars }
 * @returns {string} 'SWING_ONLY' | 'SWING_OVERLAP' | 'SIGNIFICANT_ONLY' | 'SIGNIFICANT_OVERLAP'
 */
function classifyOverlapGroup(se, hasSig, hasSwing) {
    var isSwing = sweepCentricAudit.isSwingType((se.source && se.source.liquidityType) || se.liquidityType);
    if (isSwing) {
        return hasSig ? 'SWING_OVERLAP' : 'SWING_ONLY';
    }
    return hasSwing ? 'SIGNIFICANT_OVERLAP' : 'SIGNIFICANT_ONLY';
}

/**
 * 构建共现索引：按 candleIndex 排序的 sweep 列表（含每个的 type 标记）。
 */
function buildCooccurIndex(sweepEvents, cfg) {
    var list = [];
    (sweepEvents || []).forEach(function (se) {
        if (typeof se.candleIndex !== 'number') return;
        var type = (se.source && se.source.liquidityType) || se.liquidityType || '';
        list.push({
            se: se,
            index: se.candleIndex,
            price: se.price,
            isSwing: sweepCentricAudit.isSwingType(type)
        });
    });
    list.sort(function (a, b) { return a.index - b.index; });
    return list;
}

/**
 * 查找一个 sweep 在价格容差 + 时间窗口内的邻居类型（swing/significant）。
 * @returns {Object} { hasSwing, hasSignificant }
 */
function neighborsOf(entry, list, cfg) {
    var tol = cfg.priceTolerance;
    var win = cfg.overlapBars;
    var hasSwing = false;
    var hasSignificant = false;
    // 向前扫到 index 差 > win
    for (var i = entry.pos - 1; i >= 0; i--) {
        var e = list[i];
        if (entry.index - e.index > win) break;
        if (e.se.id === entry.se.id) continue;
        var d = Math.abs(e.price - entry.price);
        if (d <= Math.max(e.price, entry.price) * tol) {
            if (e.isSwing) hasSwing = true; else hasSignificant = true;
        }
    }
    for (var j = entry.pos + 1; j < list.length; j++) {
        var f = list[j];
        if (f.index - entry.index > win) break;
        if (f.se.id === entry.se.id) continue;
        var d2 = Math.abs(f.price - entry.price);
        if (d2 <= Math.max(f.price, entry.price) * tol) {
            if (f.isSwing) hasSwing = true; else hasSignificant = true;
        }
    }
    return { hasSwing: hasSwing, hasSignificant: hasSignificant };
}

/**
 * Liquidity Incremental Value Audit（全部 LIQUIDITY_SWEEP 为母样本）。
 * @param {Object} input
 *   {
 *     sweepEvents, mssEvents, swings, displacementEvents, legByDispId, alerts, candles,
 *     windowBars, priceTolerance, overlapBars
 *   }
 * @returns {Object} {
 *   groups: { SWING_ONLY, SWING_OVERLAP, SIGNIFICANT_ONLY, SIGNIFICANT_OVERLAP }
 *            → { n, mss, protectedMss, strongLeg, high, mfeSum, maeSum, mfeCnt },
 *   order, windowBars, priceTolerance, overlapBars
 * }
 */
function auditIncrementalValue(input) {
    var idx = sweepCentricAudit.buildOutcomeIndex(input);
    var cfg = {
        priceTolerance: input.priceTolerance !== undefined
            ? input.priceTolerance
            : ((thresholds.events && thresholds.events.sweepIncremental && thresholds.events.sweepIncremental.priceTolerance) || 0.001),
        overlapBars: input.overlapBars !== undefined
            ? input.overlapBars
            : ((thresholds.events && thresholds.events.sweepIncremental && thresholds.events.sweepIncremental.overlapBars) || 12)
    };
    var list = buildCooccurIndex(input.sweepEvents, cfg);
    // 记录 pos 供邻域扫描
    list.forEach(function (e, k) { e.pos = k; });

    var order = ['SWING_ONLY', 'SWING_OVERLAP', 'SIGNIFICANT_ONLY', 'SIGNIFICANT_OVERLAP'];
    var groups = {};
    order.forEach(function (g) {
        groups[g] = { n: 0, mss: 0, protectedMss: 0, strongLeg: 0, high: 0, mfeSum: 0, maeSum: 0, mfeCnt: 0 };
    });

    list.forEach(function (entry) {
        var o = sweepCentricAudit.computeSweepOutcomes(entry.se, idx);
        if (!o) return;
        var nb = neighborsOf(entry, list, cfg);
        var group = classifyOverlapGroup(entry.se, nb.hasSignificant, nb.hasSwing);
        var g = groups[group];
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
    });
    return { groups: groups, order: order, windowBars: idx.windowBars, priceTolerance: cfg.priceTolerance, overlapBars: cfg.overlapBars };
}

module.exports = {
    auditIncrementalValue: auditIncrementalValue,
    classifyOverlapGroup: classifyOverlapGroup,
    buildCooccurIndex: buildCooccurIndex,
    neighborsOf: neighborsOf
};
