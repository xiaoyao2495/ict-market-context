/**
 * Phase 12.2 — ATR Directional Change Structural Swing Shadow（audit 统计层）
 *
 * 架构（Phase 12.5A）：**算法唯一实现在 structure/dcStructuralSwing.js**（createDcState /
 * stepDcState / buildDcSwings / packageForMss），本文件只保留 audit 统计（computeStats /
 * auditDc），buildDcSwings / atrAt / cfgOf 一律 re-export 自唯一实现——
 * 禁止任何"看起来一样"的复制算法（Shadow 验证 A == Live 上线 A）。
 *
 * 背景（用户 2026-08-20）：Phase 12.1 修正后结论——2-2 LOCAL_PIVOT 作为局部转折检测器没问题，
 * 但 90d 有 75.1% 的 pivot 最终被附近更极端同向 pivot 包含（层级冗余），不能继续把
 * LOCAL_PIVOT 等价于 STRUCTURAL_SWING。ATR Directional Change 天然消掉 nested pivot。
 *
 * 每档输出指标（用户表）：
 *   n / swingsPerHour       降噪程度、是否过密
 *   medianBarsPerLeg        一个结构平均持续多久
 *   medianLegRangeAtr       是否形成有效 price leg
 *   alternationRate         H→L→H→L 稳定率（DC 天然交替，作 sanity）
 *   medianConfirmDelay      occurredAt → confirmedAt 等多久
 *   replacements           一个最终 Swing 确认前吞掉多少 local extremes（分布）
 *
 * 纯诊断：生产 detector / MSS / 通知全部零改动（本模块仅统计层）。
 */
var dcss = require('../structure/dcStructuralSwing');

var DEFAULT_ATR_N = 14;

/** 唯一实现 re-export（禁止本地复制） */
var buildDcSwings = dcss.buildDcSwings;
var atrAt = dcss.atrAt;
var cfgOf = dcss.cfgOf;

function medianSorted(arr) {
    if (arr.length === 0) return null;
    var a = arr.slice().sort(function (x, y) { return x - y; });
    var mid = Math.floor(a.length / 2);
    if (a.length % 2 === 1) return a[mid];
    return (a[mid - 1] + a[mid]) / 2;
}
function mean(arr) {
    if (arr.length === 0) return null;
    var s = 0;
    for (var i = 0; i < arr.length; i++) s += arr[i];
    return s / arr.length;
}
function bucketReps(r) {
    if (r <= 1) return String(r);
    if (r <= 3) return '2-3';
    return '4+';
}

/**
 * 单档统计。
 */
function computeStats(swings, k, bars, cfg) {
    var n = swings.length;
    var legBars = [];
    var legRangeAtr = [];
    var delays = [];
    var reps = [];
    var repBuckets = {};
    var sameSide = 0;

    for (var i = 0; i < n; i++) {
        var s = swings[i];
        delays.push(s.confirmedAt - s.occurredAt);
        reps.push(s.replacements);
        var b = bucketReps(s.replacements);
        repBuckets[b] = (repBuckets[b] || 0) + 1;
        if (i < n - 1) {
            var s1 = swings[i + 1];
            legBars.push(s1.extremeIndex - s.extremeIndex);
            var avgAtr = (s.extremeATR + s1.extremeATR) / 2;
            if (avgAtr > 0) legRangeAtr.push(Math.abs(s1.price - s.price) / avgAtr);
            if (s1.direction === s.direction) sameSide++;
        }
    }
    var alternation = n >= 2 ? (n - 1 - sameSide) / (n - 1) : 1;
    return {
        k: k,
        n: n,
        swingsPerHour: bars > 0 ? n / (bars / 12) : 0,
        medianBarsPerLeg: medianSorted(legBars),
        medianLegRangeAtr: medianSorted(legRangeAtr),
        alternationRate: alternation,
        medianConfirmDelay: medianSorted(delays),
        delayMean: mean(delays),
        replacementBuckets: repBuckets,
        replacementMean: mean(reps),
        replacementMedian: medianSorted(reps)
    };
}

/**
 * 多档 ATR Directional Change 审计。
 * @param {Array} candles
 * @param {Array} ks [0.5, 0.75, 1.0, 1.5, 2.0]
 * @param {Object} [opts]
 * @returns {Array} 每档 stats
 */
function auditDc(candles, ks, opts) {
    var bars = candles ? candles.length : 0;
    return (ks || []).map(function (k) {
        return computeStats(buildDcSwings(candles, k, opts), k, bars, cfgOf(opts));
    });
}

module.exports = {
    buildDcSwings: buildDcSwings,
    auditDc: auditDc,
    computeStats: computeStats,
    atrAt: atrAt,
    cfgOf: cfgOf,
    DEFAULT_ATR_N: DEFAULT_ATR_N
};
