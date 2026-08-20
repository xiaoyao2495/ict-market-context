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
 * （第二层 provenance 有效性验证 = HIGH 侧，见 11L.10 classifyPostSweepBehavior，另行）
 *
 * 纯诊断，不改生产。
 */
var mssReference = require('./mssReference');

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
 * Sweep-centric 审计（全部 LIQUIDITY_SWEEP 事件为母样本）。
 * @param {Object} input
 *   {
 *     sweepEvents: Array,          // 全部 LIQUIDITY_SWEEP（含 source.liquidityType / candleIndex / confirmedAt / side）
 *     mssEvents: Array,            // 全部 MSS 事件
 *     swings: Array,               // registry swings（classifyMssReference 用）
 *     displacementEvents: Array,   // 全部 DISPLACEMENT 事件
 *     legByDispId: Object,         // dispId → leg（含 quality）
 *     alerts: Array,               // buildAlerts 输出（tier / anchorIndex / direction）
 *     candles: Array,              // 5m candles
 *     windowBars: number           // 观察窗口（默认 12 = 1h）
 *   }
 * @returns {Object} {
 *   groups: { GROUP: { n, mss, protectedMss, strongLeg, high, mfeSum, maeSum, mfeCnt } },
 *   order: [...],
 *   windowBars
 * }
 */
function auditSweepCentric(input) {
    var W = input.windowBars || DEFAULT_WINDOW_BARS;
    var candles = input.candles || [];
    // 索引（避免 O(n²)）
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
        var s = se.candleIndex;
        if (typeof s !== 'number') return;
        var dir = se.side === 'SSL' ? 'BULLISH' : 'BEARISH';
        var group = classifySweepGroup((se.source && se.source.liquidityType) || se.liquidityType);
        var g = acc(group);
        g.n++;

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
            // 顺向 MFE / 逆向 MAE（以 sweep K 收盘为基准）
            if (base !== null) {
                if (dir === 'BULLISH') {
                    if (c.high - base > mfe) mfe = c.high - base;
                    if (base - c.low > mae) mae = base - c.low;
                } else {
                    if (base - c.low > mfe) mfe = base - c.low;
                    if (c.high - base > mae) mae = base - c.high;
                }
            }
            // 方向匹配 MSS
            (mssByIndex[j] || []).forEach(function (m) {
                if (m.direction !== dir) return;
                mssFound = true;
                var q = mssReference.classifyMssReference(m, input.swings || []).quality;
                if (q === 'PROTECTED_SWING' || q === 'HTF_RELEVANT') protectedFound = true;
            });
            // STRONG/EXPLOSIVE leg（displacement → leg）
            (dispByIndex[j] || []).forEach(function (d) {
                if (d.direction !== dir) return;
                var leg = input.legByDispId && input.legByDispId[d.id];
                if (leg && (leg.quality === 'STRONG' || leg.quality === 'EXPLOSIVE')) strongLegFound = true;
            });
            // 形成 HIGH（anchor 落在窗口内）
            (alertByAnchor[j] || []).forEach(function (a) {
                if (a.direction === dir) highFound = true;
            });
        }

        if (mssFound) g.mss++;
        if (protectedFound) g.protectedMss++;
        if (strongLegFound) g.strongLeg++;
        if (highFound) g.high++;
        if (base !== null) {
            g.mfeSum += mfe / base * 100;
            g.maeSum += mae / base * 100;
            g.mfeCnt++;
        }
    });

    return { groups: groups, order: order, windowBars: W };
}

module.exports = {
    auditSweepCentric: auditSweepCentric,
    classifySweepGroup: classifySweepGroup,
    DEFAULT_WINDOW_BARS: DEFAULT_WINDOW_BARS
};
