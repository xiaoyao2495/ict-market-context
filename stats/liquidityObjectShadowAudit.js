/**
 * Phase 11L.11 — Liquidity Object Reclassification Shadow
 *
 * 背景（用户 2026-08-20）：ZEC / ACE / GPS 连续 Live 反例表明普通 5M SWING_LOW/HIGH
 * 作为 Liquidity Taken 容易失真；但 11L.10 尚未证明"删掉它以后解释层更好"。
 *
 * 决策：不直接删生产；先做 shadow —— 把普通 5m SWING 从 Liquidity Object 候选排除：
 *   保留：EQL / EQH / PDH / PDL / Session（ASIA/LONDON/NEW_YORK）等明确 external liquidity
 *   排除：普通 5m SWING_HIGH / SWING_LOW（产品语义倾向回归 Structure）
 *
 * 同一批 BTC 90d HIGH 比较：
 *   ① Liquidity Taken 覆盖率：生产（含 SWING）~90% → shadow（仅 SIGNIFICANT）掉到多少
 *   ② 分组 NearHit/MFE：
 *        SIGNIFICANT  shadow 模型仍有 immediateSweep（真正显著 liquidity）
 *        SWING_ONLY   生产有、shadow 无（被普通 swing 主导）
 *        NONE         两者皆无
 *   ③ SIGNIFICANT 示例通知行（供肉眼 ICT Narrative 检查）
 *
 * 决策分支（用户）：
 *   - Significant NearHit 72%+ vs Swing 65% → 有理由正式删普通 5m Swing
 *   - Significant 样本只有几十笔、NearHit 与 Swing 差不多 → 需定义 EXTERNAL_SWING /
 *     LIQUIDITY_BEARING_SWING（问题不是删 Swing 这么简单）
 *
 * 纯诊断：生产 associateSweeps 默认 excludeSwing=false（行为不变）。
 */
var liquidityProvenance = require('./liquidityProvenance');

/**
 * 对单个 HIGH alert 跑 shadow 关联（排除普通 SWING）。
 * @param {Object} alert buildAlerts 输出（direction / legStartIndex / anchorIndex / availableAt）
 * @param {Array} sweepEvents 全部 LIQUIDITY_SWEEP 事件
 * @param {Array} candles 5m candles
 * @param {Object} [opts] { maxLookbackBars }
 * @returns {Object|null} shadow liquidityContext（仅 SIGNIFICANT/OTHER 候选）
 */
function shadowAssociate(alert, sweepEvents, candles, opts) {
    var legStart = alert.legStartIndex !== undefined && alert.legStartIndex !== null ? alert.legStartIndex : alert.anchorIndex;
    var availAt = alert.availableAt !== undefined && alert.availableAt !== null ? alert.availableAt : alert.anchorTime;
    return liquidityProvenance.associateSweeps({
        direction: alert.direction,
        leg: {
            startIndex: legStart,
            endIndex: alert.anchorIndex,
            lastIndex: alert.anchorIndex
        },
        availableAt: availAt,
        sweepEvents: sweepEvents,
        maxLookbackBars: opts && opts.maxLookbackBars !== undefined ? opts.maxLookbackBars : null,
        excludeSwing: true
    });
}

/**
 * 单样本指标（通知后 availableIndex+1 起；notificationPrice 基准）。
 */
function statOne(alert, candles, windows) {
    var availIdx = alert.availableIndex !== undefined && alert.availableIndex !== null ? alert.availableIndex : alert.anchorIndex;
    var start = availIdx !== null && availIdx !== undefined ? availIdx + 1 : null;
    if (start === null || start >= candles.length) return null;
    var basePrice = alert.notificationPrice !== undefined && alert.notificationPrice !== null ? alert.notificationPrice : alert.anchorPrice;
    var hitTarget = alert.notificationNearTarget !== undefined && alert.notificationNearTarget !== null ? alert.notificationNearTarget : alert.nearTarget;
    var bullish = alert.direction === 'BULLISH';
    var out = { mfe: 0, mae: 0, near30: false, near1h: false };
    windows.forEach(function (w) {
        var lastJ = Math.min(start + w.bars - 1, candles.length - 1);
        var hit = false;
        for (var j = start; j <= lastJ; j++) {
            var c = candles[j];
            if (!c) break;
            if (bullish) {
                if (c.high - basePrice > out.mfe) out.mfe = c.high - basePrice;
                if (basePrice - c.low > out.mae) out.mae = basePrice - c.low;
                if (hitTarget !== null && hitTarget !== undefined && c.high >= hitTarget) hit = true;
            } else {
                if (basePrice - c.low > out.mfe) out.mfe = basePrice - c.low;
                if (c.high - basePrice > out.mae) out.mae = c.high - basePrice;
                if (hitTarget !== null && hitTarget !== undefined && c.low <= hitTarget) hit = true;
            }
        }
        if (w.key === '30m') out.near30 = hit;
        else out.near1h = hit;
    });
    return out;
}

/**
 * Liquidity Object Reclassification Shadow 审计（HIGH 母样本）。
 * @param {Array} alerts buildAlerts 输出
 * @param {Array} sweepEvents 全部 LIQUIDITY_SWEEP 事件
 * @param {Array} candles 5m candles
 * @param {Object} [opts] { maxLookbackBars }
 * @returns {Object} {
 *   total, prodCoverage, shadowCoverage,
 *   groups: { SIGNIFICANT, SWING_ONLY, NONE } → { n, nearHit30m, nearCnt30m, nearHit1h, nearCnt1h, mfeSum, maeSum, mfeCnt },
 *   significantSamples: [ { alertId, side, sourceType, sourcePrice, relation, barsBeforeLegStart, anchorTime, direction } ]（前 N 条，肉眼 ICT 检查）
 * }
 */
function auditObjectShadow(alerts, sweepEvents, candles, opts) {
    var windows = [{ key: '30m', bars: 6 }, { key: '1h', bars: 12 }];
    var out = {
        total: 0,
        prodCoverage: 0,
        shadowCoverage: 0,
        groups: {},
        significantSamples: []
    };
    function acc(g) {
        if (!out.groups[g]) {
            out.groups[g] = { n: 0, nearHit30m: 0, nearCnt30m: 0, nearHit1h: 0, nearCnt1h: 0, mfeSum: 0, maeSum: 0, mfeCnt: 0 };
        }
        return out.groups[g];
    }
    (alerts || []).forEach(function (al) {
        if (!al || al.tier !== 'HIGH_QUALITY') return;
        out.total++;
        var prodSw = al.liquidityContext && al.liquidityContext.immediateSweep ? al.liquidityContext.immediateSweep : null;
        var shadowCtx = shadowAssociate(al, sweepEvents, candles, opts);
        var shadowSw = shadowCtx && shadowCtx.immediateSweep ? shadowCtx.immediateSweep : null;
        if (prodSw) out.prodCoverage++;
        if (shadowSw) out.shadowCoverage++;

        var group;
        if (shadowSw) {
            group = 'SIGNIFICANT';
            if (out.significantSamples.length < 12) {
                out.significantSamples.push({
                    alertId: al.id,
                    direction: al.direction,
                    side: shadowSw.side,
                    sourceType: shadowSw.sourceType,
                    sourcePrice: shadowSw.sourcePrice,
                    relation: shadowSw.relation,
                    barsBeforeLegStart: shadowSw.barsBeforeLegStart,
                    anchorTime: al.anchorTime,
                    availableAt: al.availableAt
                });
            }
        } else if (prodSw) {
            group = 'SWING_ONLY';
        } else {
            group = 'NONE';
        }
        var g = acc(group);
        g.n++;
        var st = statOne(al, candles, windows);
        if (st) {
            if (al.notificationNearTarget !== null && al.notificationNearTarget !== undefined) {
                g.nearCnt30m++;
                g.nearCnt1h++;
                if (st.near30) g.nearHit30m++;
                if (st.near1h) g.nearHit1h++;
            }
            g.mfeSum += st.mfe / (al.notificationPrice || al.anchorPrice) * 100;
            g.maeSum += st.mae / (al.notificationPrice || al.anchorPrice) * 100;
            g.mfeCnt++;
        }
    });
    out.prodCoverage = out.total > 0 ? out.prodCoverage / out.total : 0;
    out.shadowCoverage = out.total > 0 ? out.shadowCoverage / out.total : 0;
    return out;
}

module.exports = {
    auditObjectShadow: auditObjectShadow,
    shadowAssociate: shadowAssociate
};
