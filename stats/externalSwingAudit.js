/**
 * Phase 11L.14 — EXTERNAL_SWING Shadow（Swing 内部再分级）
 *
 * 背景（用户 2026-08-20）：11L.13 已证明 SIGNIFICANT_ONLY（StrongLeg 56.3% / HIGH 17.2%）
 * 明显强于 SWING_ONLY（39.7% / 9.4%）。下一步只回答一个问题：
 *   普通 Swing 中，有没有一小部分"真正 meaningful 的 swing"，其表现能接近 Significant？
 *
 * 第一版透明规则（不做复杂评分）把 SWING 拆成：
 *   EXTERNAL_SWING：满足任一 ——
 *     ① 形成后较长时间未被取（sweep.confirmedAt - swing.confirmedAt >= ageMinBars，默认 24 = 2h）
 *     ② 接近更高周期极值（1h/4h 的极值 ± htfTolerance，截至 sweep 时刻，无 future leakage）
 *   INTERNAL_SWING：其余（普通内部 swing）
 *
 * 分组（共现判定复用 11L.13：价格容差 0.1% + 时间窗口 12 bars）：
 *   INTERNAL_SWING_ONLY / EXTERNAL_SWING_ONLY / SIGNIFICANT_ONLY / OVERLAP
 * 指标：Protected MSS / STRONG·EXPLOSIVE Leg / HIGH formation / MFE·MAE（复用 sweepCentric 指标）
 *
 * 决策（用户）：
 *   INTERNAL ~7% / EXTERNAL ~15% / SIGNIFICANT ~17% → internal 回归 Structure，external 升级 Liquidity Object
 *   EXTERNAL 仍 9-10% → Swing 整体弱，正式降级
 *
 * 纯诊断，不改生产。
 */
var sweepCentricAudit = require('./sweepCentricAudit');
var sweepIncrementalAudit = require('./sweepIncrementalAudit');
var thresholds = require('../config/thresholds');

var BAR_MS = 300000;

function cfgOf(input) {
    var e = (thresholds.events && thresholds.events.sweepExternal) ? thresholds.events.sweepExternal : {};
    return {
        ageMinBars: input.ageMinBars !== undefined ? input.ageMinBars : (e.ageMinBars !== undefined ? e.ageMinBars : 24),
        htfTolerance: input.htfTolerance !== undefined ? input.htfTolerance : (e.htfTolerance !== undefined ? e.htfTolerance : 0.002),
        priceTolerance: input.priceTolerance !== undefined
            ? input.priceTolerance
            : ((thresholds.events && thresholds.events.sweepIncremental && thresholds.events.sweepIncremental.priceTolerance) || 0.001),
        overlapBars: input.overlapBars !== undefined
            ? input.overlapBars
            : ((thresholds.events && thresholds.events.sweepIncremental && thresholds.events.sweepIncremental.overlapBars) || 12)
    };
}

/**
 * 构建 HTF 极值前缀索引（截至每时刻的最大 high / 最小 low，二分查找，无 future leakage）。
 * @param {Array} htfCandles 某周期蜡烛（时间升序，含 closeTime/high/low）
 * @returns {Object|null} { times, maxPrefix, minPrefix }
 */
function buildHtfExtremes(htfCandles) {
    var list = (htfCandles || []).filter(function (c) { return c && typeof c.closeTime === 'number'; });
    if (list.length === 0) return null;
    var times = [];
    var maxPrefix = [];
    var minPrefix = [];
    var mx = -Infinity;
    var mn = Infinity;
    list.forEach(function (c) {
        times.push(c.closeTime);
        if (c.high > mx) mx = c.high;
        if (c.low < mn) mn = c.low;
        maxPrefix.push(mx);
        minPrefix.push(mn);
    });
    return { times: times, maxPrefix: maxPrefix, minPrefix: minPrefix };
}

/**
 * 二分：最后一个 closeTime <= t 的 index；无 → -1
 */
function lastIndexAtOrBefore(times, t) {
    var lo = 0;
    var hi = times.length - 1;
    var ans = -1;
    while (lo <= hi) {
        var mid = (lo + hi) >> 1;
        if (times[mid] <= t) { ans = mid; lo = mid + 1; }
        else { hi = mid - 1; }
    }
    return ans;
}

/**
 * swing 是否接近某个 HTF 周期极值（截至 sweep 时刻）。
 */
function nearHtfExtreme(htfIdx, t, price, isLow, tolerance) {
    if (!htfIdx) return false;
    var i = lastIndexAtOrBefore(htfIdx.times, t);
    if (i < 0) return false;
    var extreme = isLow ? htfIdx.minPrefix[i] : htfIdx.maxPrefix[i];
    if (!isFinite(extreme)) return false;
    var bound = Math.max(extreme, price) * tolerance;
    return Math.abs(extreme - price) <= bound;
}

/**
 * 透明规则判定 SWING class：EXTERNAL / INTERNAL。
 * @param {Object} sweep LIQUIDITY_SWEEP 事件（liquidityId / confirmedAt）
 * @param {Object|null} swing swing liquidity（confirmedAt / type / price）
 * @param {Array} htfIndexes buildHtfExtremes 数组（多周期）
 * @param {Object} cfg { ageMinBars, htfTolerance }
 * @returns {string} 'EXTERNAL' | 'INTERNAL'
 */
function classifySwingClass(sweep, swing, htfIndexes, cfg) {
    // 规则 ①：形成后较长时间未被取
    if (swing && typeof swing.confirmedAt === 'number' && typeof sweep.confirmedAt === 'number') {
        var ageBars = (sweep.confirmedAt - swing.confirmedAt) / BAR_MS;
        if (ageBars >= cfg.ageMinBars) return 'EXTERNAL';
    }
    // 规则 ②：接近更高周期极值（1h / 4h）
    if (swing && htfIndexes && htfIndexes.length > 0) {
        var isLow = swing.type === 'SWING_LOW';
        var tol = cfg.htfTolerance;
        for (var i = 0; i < htfIndexes.length; i++) {
            if (htfIndexes[i] && nearHtfExtreme(htfIndexes[i], sweep.confirmedAt, swing.price, isLow, tol)) {
                return 'EXTERNAL';
            }
        }
    }
    return 'INTERNAL';
}

/**
 * EXTERNAL_SWING Shadow 审计（全部 LIQUIDITY_SWEEP 为母样本）。
 * @param {Object} input
 *   {
 *     sweepEvents, swings, htfCandles（可选：{ '1h': [...], '4h': [...] } 或数组数组）,
 *     mssEvents, swingsForMss（result.swings，classifyMssReference 用）, displacementEvents,
 *     legByDispId, alerts, candles, windowBars, ageMinBars, htfTolerance
 *   }
 * @returns {Object} {
 *   groups: { INTERNAL_SWING_ONLY, EXTERNAL_SWING_ONLY, SIGNIFICANT_ONLY, OVERLAP }
 *            → { n, mss, protectedMss, strongLeg, high, mfeSum, maeSum, mfeCnt },
 *   order, windowBars, ageMinBars, htfTolerance, priceTolerance, overlapBars
 * }
 */
function auditExternalSwing(input) {
    var idx = sweepCentricAudit.buildOutcomeIndex(input);
    var cfg = cfgOf(input);
    var swingsById = {};
    (input.swings || []).forEach(function (s) { if (s && s.id) swingsById[s.id] = s; });
    // HTF 极值索引（多周期）
    var htfIndexes = [];
    if (input.htfCandles) {
        var list = Array.isArray(input.htfCandles) ? input.htfCandles : [input.htfCandles['1h'], input.htfCandles['4h']];
        list.forEach(function (hc) {
            var ex = buildHtfExtremes(hc);
            if (ex) htfIndexes.push(ex);
        });
    }
    // 共现索引
    var coList = sweepIncrementalAudit.buildCooccurIndex(input.sweepEvents, cfg);
    coList.forEach(function (e, k) { e.pos = k; });

    var order = ['INTERNAL_SWING_ONLY', 'EXTERNAL_SWING_ONLY', 'SIGNIFICANT_ONLY', 'OVERLAP'];
    var groups = {};
    order.forEach(function (g) {
        groups[g] = { n: 0, mss: 0, protectedMss: 0, strongLeg: 0, high: 0, mfeSum: 0, maeSum: 0, mfeCnt: 0 };
    });

    coList.forEach(function (entry) {
        var se = entry.se;
        var o = sweepCentricAudit.computeSweepOutcomes(se, idx);
        if (!o) return;
        var nb = sweepIncrementalAudit.neighborsOf(entry, coList, cfg);
        var group;
        if (sweepCentricAudit.isSwingType((se.source && se.source.liquidityType) || se.liquidityType)) {
            if (nb.hasSignificant) {
                group = 'OVERLAP';
            } else {
                var swing = swingsById[se.liquidityId] || null;
                var cls = classifySwingClass(se, swing, htfIndexes, cfg);
                group = cls === 'EXTERNAL' ? 'EXTERNAL_SWING_ONLY' : 'INTERNAL_SWING_ONLY';
            }
        } else {
            group = nb.hasSwing ? 'OVERLAP' : 'SIGNIFICANT_ONLY';
        }
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
    return {
        groups: groups, order: order, windowBars: idx.windowBars,
        ageMinBars: cfg.ageMinBars, htfTolerance: cfg.htfTolerance,
        priceTolerance: cfg.priceTolerance, overlapBars: cfg.overlapBars
    };
}

module.exports = {
    auditExternalSwing: auditExternalSwing,
    classifySwingClass: classifySwingClass,
    buildHtfExtremes: buildHtfExtremes,
    lastIndexAtOrBefore: lastIndexAtOrBefore,
    nearHtfExtreme: nearHtfExtreme
};
