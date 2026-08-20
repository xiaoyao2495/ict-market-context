/**
 * Phase 11L.15 — Alert Prioritization Shadow（通知层筛选：Significant Liquidity 硬门槛）
 *
 * 背景（用户 2026-08-20）：从 Top10 扩到更多币 + 美股合约后，"所有 HIGH 都推钉钉"不可持续。
 * 拆两层：
 *   市场 → 所有 Opportunity → HIGH/WATCH/LOW（研究层：全部保留、全部落日志）
 *        → Alert Filter（新增，第一版唯一条件 = HIGH + Significant Liquidity）
 *        → PRIORITY_HIGH → 钉钉
 *
 * Significant Liquidity（用户限定第一版）：
 *   EQL / EQH / PDL / PDH / Session Low / High（复用 liquidityRelevanceAudit.sourceGroupOf → 'SIGNIFICANT'）
 * 普通 5M SWING_HIGH / SWING_LOW → 保留在 Engine（Structure / Context），但不足单独触发优先通知。
 *
 * 两个口径（都算，供用户审计后定）：
 *   A. immediate 口径（通知显示口径）：immediateSweep.sourceType 是 SIGNIFICANT
 *      —— 与 Liquidity Taken 通知行显示的 liquidity 完全一致
 *   B. window 口径（窗口内存在）：allCandidates 任一 sourceType 是 SIGNIFICANT
 *      —— 11L.11 发现：48 窗口内其实存在大量 significant 候选（43.9% HIGH 能关联到），
 *         只是被更频繁的 swing 抢走 immediateSweep。若通知只显示最近 sweep，这会低估 significant 存在。
 *
 * 输出：HIGH_TOTAL / PRIORITY / SUPPRESSED（含抑制原因分布）+ 每组的 forward 指标
 *   （NearHit30m / NearHit1h / MFE / MAE，口径与其他 audit 一致：
 *    availableIndex+1 起、notificationPrice 基准、notificationNearTarget 目标）。
 *
 * 决策框架（用户）：若消息量明显下降且 PRIORITY vs SUPPRESSED 质量无恶化 → 钉钉只推 PRIORITY_HIGH。
 * 纯 shadow：不改钉钉、不改 HIGH、不改通知。
 */
var lra = require('./liquidityRelevanceAudit');

var WINDOWS = [{ key: '30m', bars: 6 }, { key: '1h', bars: 12 }];

/**
 * sourceType → 是否 Significant Liquidity（EQL/EQH/PDL/PDH/Session；普通 swing 不算）
 */
function isSignificant(sourceType) {
    return lra.sourceGroupOf(sourceType) === 'SIGNIFICANT';
}

/**
 * immediateSweep 的 significance 组（通知显示口径）。
 * @returns {string} 'SIGNIFICANT' | 'SWING' | 'OTHER' | 'NONE'
 */
function immediateGroupOf(alert) {
    var sw = alert && alert.liquidityContext && alert.liquidityContext.immediateSweep;
    if (!sw) return 'NONE';
    return lra.sourceGroupOf(sw.sourceType);
}

/**
 * 窗口内（allCandidates）是否存在任一 Significant Liquidity。
 */
function windowHasSignificant(alert) {
    var ctx = alert && alert.liquidityContext;
    if (!ctx || !Array.isArray(ctx.allCandidates)) return false;
    for (var i = 0; i < ctx.allCandidates.length; i++) {
        if (ctx.allCandidates[i] && isSignificant(ctx.allCandidates[i].sourceType)) return true;
    }
    return false;
}

/**
 * 空统计累加器（与 auditRelevance / auditLiquidityRecency 同口径）。
 */
function newAcc() {
    return { n: 0, nearHit30m: 0, nearCnt30m: 0, nearHit1h: 0, nearCnt1h: 0, mfeSum: 0, maeSum: 0, mfeCnt: 0 };
}

/**
 * 累加单样本的 forward 指标。
 * 11L.15a（Forward Sample Integrity）：30m/1h 需完整 6/12 根后续 5m 才计 denominator；
 * MFE/MAE 为 1h 口径，需完整 12 根（right-censoring 防护——刚发生的 HIGH 不会被算成 1h miss）。
 */
function accAdd(acc, al, candles) {
    acc.n++;
    var st = lra.statOne(al, candles, WINDOWS);
    if (!st) return;
    if (al.notificationNearTarget !== null && al.notificationNearTarget !== undefined) {
        if (st.complete30) {
            acc.nearCnt30m++;
            if (st.near30) acc.nearHit30m++;
        }
        if (st.complete1h) {
            acc.nearCnt1h++;
            if (st.near1h) acc.nearHit1h++;
        }
    }
    if (st.complete1h) {
        var base = al.notificationPrice !== undefined && al.notificationPrice !== null ? al.notificationPrice : al.anchorPrice;
        if (base) {
            acc.mfeSum += st.mfe / base * 100;
            acc.maeSum += st.mae / base * 100;
            acc.mfeCnt++;
        }
    }
}

/**
 * 11L.15 Alert Prioritization Audit（HIGH 母样本）。
 * @param {Array} alerts buildAlerts 输出（仅统计 tier=HIGH_QUALITY）
 * @param {Array} candles 5m candles
 * @returns {Object} {
 *   total,
 *   baseline: acc,                                   // 全部 HIGH（生产现状对照）
 *   variants: {
 *     immediate: { priority: acc, suppressed: acc, suppressedReasons: {SWING:n, OTHER:n, NONE:n} },
 *     window:    { priority: acc, suppressed: acc, suppressedReasons: {...} }
 *   }
 * }
 */
function auditPrioritization(alerts, candles) {
    var out = {
        total: 0,
        baseline: newAcc(),
        variants: {
            immediate: { priority: newAcc(), suppressed: newAcc(), suppressedReasons: {} },
            window: { priority: newAcc(), suppressed: newAcc(), suppressedReasons: {} }
        }
    };

    (alerts || []).forEach(function (al) {
        if (!al || al.tier !== 'HIGH_QUALITY') return;
        out.total++;
        accAdd(out.baseline, al, candles);

        // 口径 A：immediateSweep 显著
        var ig = immediateGroupOf(al);
        var priA = ig === 'SIGNIFICANT';
        accAdd(priA ? out.variants.immediate.priority : out.variants.immediate.suppressed, al, candles);
        if (!priA) {
            out.variants.immediate.suppressedReasons[ig] = (out.variants.immediate.suppressedReasons[ig] || 0) + 1;
        }

        // 口径 B：窗口内任一候选显著
        var priB = windowHasSignificant(al);
        accAdd(priB ? out.variants.window.priority : out.variants.window.suppressed, al, candles);
        if (!priB) {
            // 抑制原因：immediate 不是 SIGNIFICANT（若 immediate 是 SIGNIFICANT 则 B 必 priority，不会到这里）
            out.variants.window.suppressedReasons[ig] = (out.variants.window.suppressedReasons[ig] || 0) + 1;
        }
    });
    return out;
}

module.exports = {
    auditPrioritization: auditPrioritization,
    isSignificant: isSignificant,
    immediateGroupOf: immediateGroupOf,
    windowHasSignificant: windowHasSignificant,
    newAcc: newAcc,
    accAdd: accAdd
};
