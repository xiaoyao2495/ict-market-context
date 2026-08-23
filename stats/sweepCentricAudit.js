/**
 * Phase 11L.12 — Sweep-centric Validation（从 SweepEvent 出发，非 HIGH 出发）
 *
 * 方法论点（用户 2026-08-20）：此前 SIGNIFICANT vs SWING_ONLY 的 NearHit 比较是 HIGH-centric，
 * 存在条件选择偏差 —— 样本先被 MSS=PROTECTED + Leg=STRONG/EXPLOSIVE + Near Draw 合格筛强，
 * 此时 NearHit 主要由 MSS+Leg+Near Draw 决定，Liquidity 类型的增量被淹没。
 * 因此 "SIGNIFICANT 66.8% ≈ SWING_ONLY 66.7%" 只能说明"HIGH 条件成立后 NearHit 对 sweep 类型不敏感"，
 * 不能推出"普通 5m Swing 是有效的 liquidity object"。
 *
 * 正确验证：从 Sweep Event 本身出发，按 liquidity 类型分组，看后续 1h 内：
 *   - 是否出现方向匹配的 MSS（含 protected = PROTECTED_SWING / HTF_RELEVANT）
 *   - 是否出现 STRONG / EXPLOSIVE DisplacementLeg
 *   - 是否形成 HIGH_QUALITY 机会
 *   - 顺向 MFE / 逆向 MAE（以 sweep K 收盘为基准）
 *
 * 回答：什么 liquidity event 更容易"启动"后续有意义的 Delivery？
 * （11L.12 结论：各类型启动率同量级；但 Liquidity Object 不互斥 → 11L.13 增量审计）
 *
 * 纯诊断，不改生产。
 *
 * 本模块同时导出 buildOutcomeIndex / computeSweepOutcomes，供 11L.13
 * Liquidity Incremental Value Audit 复用同一套"后续 delivery 指标"实现。
 */
var DEFAULT_WINDOW_BARS = 12; // 1h

/**
 * sourceType → sweep 分组（用户表：EQL/EQH、PDH/PDL、SESSION、5m SWING、OTHER）
 */
function classifySweepGroup(sourceType) {
    var t = String(sourceType || '').toUpperCase();
    if (t === 'EQL' || t === 'EQH') return 'EQL/EQH';
    if (t === 'PDH' || t === 'PDL' || t === 'PWH' || t === 'PWL') return 'PDH/PDL';
    if (t.indexOf('ASIA') === 0 || t.indexOf('LONDON') === 0 || t.indexOf('NEW_YORK') === 0) return 'SESSION';
    if (t === 'SWING_HIGH' || t === 'SWING_LOW') return '5m SWING';
    return 'OTHER';
}

/**
 * 是否为普通 5m SWING（11L.13 增量审计用）
 */
function isSwingType(sourceType) {
    var t = String(sourceType || '').toUpperCase();
    return t === 'SWING_HIGH' || t === 'SWING_LOW';
}

/**
 * 构建"后续 delivery 指标"所需的索引（11L.12/11L.13 共享）。
 * @param {Object} input { mssEvents, displacementEvents, alerts, swings, legByDispId, candles, windowBars }
 * @returns {Object} { mssByIndex, dispByIndex, alertByAnchor, swings, legByDispId, candles, windowBars }
 */
function buildOutcomeIndex(input) {
    var W = input.windowBars || DEFAULT_WINDOW_BARS;
    var mssByIndex = {};
    (input.mssEvents || []).forEach(function (m) {
        if (typeof m.candleIndex !== 'number') return;
        if (!mssByIndex[m.candleIndex]) mssByIndex[m.candleIndex] = [];
        mssByIndex[m.candleIndex].push(m);
    });
    var dispByIndex = {};
    (input.displacementEvents || []).forEach(function (d) {
        if (typeof d.candleIndex !== 'number') return;
        if (!dispByIndex[d.candleIndex]) dispByIndex[d.candleIndex] = [];
        dispByIndex[d.candleIndex].push(d);
    });
    var alertByAnchor = {};
    (input.alerts || []).forEach(function (a) {
        if (a.tier !== 'HIGH_QUALITY') return;
        if (typeof a.anchorIndex !== 'number') return;
        if (!alertByAnchor[a.anchorIndex]) alertByAnchor[a.anchorIndex] = [];
        alertByAnchor[a.anchorIndex].push(a);
    });
    return {
        mssByIndex: mssByIndex,
        dispByIndex: dispByIndex,
        alertByAnchor: alertByAnchor,
        swings: input.swings || [],
        legByDispId: input.legByDispId || {},
        candles: input.candles || [],
        windowBars: W
    };
}

/**
 * 单个 sweep 的后续 delivery 指标（11L.12/11L.13 共享）。
 * @param {Object} se LIQUIDITY_SWEEP 事件（side / candleIndex）
 * @param {Object} idx buildOutcomeIndex 输出
 * @returns {Object|null} {
 *   mss, protectedMss, strongLeg, high,   // 布尔
 *   mfePct, maePct, counted               // MFE/MAE 相对 %（counted=false 表示基准缺失）
 * } | null（candleIndex 缺失）
 */
function computeSweepOutcomes(se, idx) {
    var s = se.candleIndex;
    if (typeof s !== 'number') return null;
    var candles = idx.candles;
    var W = idx.windowBars;
    var dir = se.side === 'SSL' ? 'BULLISH' : 'BEARISH';
    var mssFound = false;
    var protectedFound = false;
    var strongLegFound = false;
    var highFound = false;
    var base = candles[s] ? candles[s].close : null;
    var mfe = 0;
    var mae = 0;

    var end = Math.min(s + W, candles.length - 1);
    for (var j = s + 1; j <= end; j++) {
        var c = candles[j];
        if (!c) continue;
        if (base !== null) {
            if (dir === 'BULLISH') {
                if (c.high - base > mfe) mfe = c.high - base;
                if (base - c.low > mae) mae = base - c.low;
            } else {
                if (base - c.low > mfe) mfe = base - c.low;
                if (c.high - base > mae) mae = base - c.high;
            }
        }
        (idx.mssByIndex[j] || []).forEach(function (m) {
            if (m.direction !== dir) return;
            mssFound = true;
            // STRUCTURAL_MSS is authoritative by construction: it can only be emitted
            // by a close through an ACTIVE_PROTECTED swing.  Do not re-introduce the
            // retired age/latest-opposing-swing quality proxy in this diagnostic.
            if (m.type === 'STRUCTURAL_MSS' || !m.type || m.protectedBreak === true ||
                (m.metadata && m.metadata.protectedBreak === true) ||
                m.referenceStructuralRole === 'ACTIVE_PROTECTED' ||
                (m.source && m.source.referenceStructuralRole === 'ACTIVE_PROTECTED')) {
                protectedFound = true;
            }
        });
        (idx.dispByIndex[j] || []).forEach(function (d) {
            if (d.direction !== dir) return;
            var leg = idx.legByDispId[d.id];
            if (leg && (leg.quality === 'STRONG' || leg.quality === 'EXPLOSIVE')) strongLegFound = true;
        });
        (idx.alertByAnchor[j] || []).forEach(function (a) {
            if (a.direction === dir) highFound = true;
        });
    }
    return {
        mss: mssFound,
        protectedMss: protectedFound,
        strongLeg: strongLegFound,
        high: highFound,
        mfePct: base !== null ? mfe / base * 100 : null,
        maePct: base !== null ? mae / base * 100 : null,
        counted: base !== null
    };
}

/**
 * Sweep-centric 审计（全部 LIQUIDITY_SWEEP 事件为母样本）。
 * @param {Object} input
 *   {
 *     sweepEvents, mssEvents, swings, displacementEvents, legByDispId, alerts, candles,
 *     windowBars
 *   }
 * @returns {Object} { groups: { GROUP: { n, mss, protectedMss, strongLeg, high, mfeSum, maeSum, mfeCnt } }, order, windowBars }
 */
function auditSweepCentric(input) {
    var idx = buildOutcomeIndex(input);
    var groups = {};
    var order = [];
    function acc(g) {
        if (!groups[g]) {
            groups[g] = { n: 0, mss: 0, protectedMss: 0, strongLeg: 0, high: 0, mfeSum: 0, maeSum: 0, mfeCnt: 0 };
            order.push(g);
        }
        return groups[g];
    }
    (input.sweepEvents || []).forEach(function (se) {
        var o = computeSweepOutcomes(se, idx);
        if (!o) return;
        var group = classifySweepGroup((se.source && se.source.liquidityType) || se.liquidityType);
        var g = acc(group);
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
    return { groups: groups, order: order, windowBars: idx.windowBars };
}

module.exports = {
    auditSweepCentric: auditSweepCentric,
    classifySweepGroup: classifySweepGroup,
    isSwingType: isSwingType,
    buildOutcomeIndex: buildOutcomeIndex,
    computeSweepOutcomes: computeSweepOutcomes,
    DEFAULT_WINDOW_BARS: DEFAULT_WINDOW_BARS
};
