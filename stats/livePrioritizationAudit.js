/**
 * Phase 11L.15 — Live Prioritization Shadow Audit（3-7 天 Live 样本的 forward 对比）
 *
 * 输入：scripts/live.js 在 handleHigh 里写盘的 prioritization.jsonl（每 symbol 一份）+
 *       同一 symbol 的 candles.jsonl（5m 收盘数据，计算 forward 用）。
 *
 * 记录字段（live.js logShadowOpp 定义，schema 锁定勿改）：
 *   id / symbol / ts / priority(PRIORITY_HIGH|STANDARD_HIGH) / direction / tier
 *   availableAt / anchorTime / anchorIndex / notificationPrice / notificationNearTarget / nearTarget
 *   nearDistPct / notificationNearDistPct
 *
 * 11L.15a（Forward Sample Integrity）：
 *   - 按 opp.id 去重（crash/replay 边界下 STANDARD 不写 delivered，可能重复落盘）
 *     → 输出 rawRecords / uniqueOpportunities / duplicateRecords
 *   - forward 只计完整窗口样本（30m=6 根 / 1h=12 根），刚发生的 HIGH 不算 miss（复用 statOne）
 *
 * 输出：按 priority 分两组的 forward 指标（口径与 90d audit 一致）：
 *   n / NearHit30m / NearHit1h / MFE1h% / MAE1h%
 *   —— 3-7 天后对比：PRIORITY_HIGH > STANDARD_HIGH（消息量减少且质量未恶化）→ 正式钉钉只推 PRIORITY。
 *   "人工值得看比例"由用户在钉钉消息（🔴 PRIORITY / 🟡 STANDARD 标识）上人工评估，脚本不算。
 *
 * 注意：本模块只读审计 live 已写盘的记录，不改变已发生的钉钉发送——
 * enabled=true 时 STANDARD 已被 suppress，属 Live Notification Experiment（非纯 shadow），
 * 相关措辞见 scripts/live.js 与 thresholds.notify.prioritization。
 */
var ap = require('./alertPrioritization');

/**
 * 记录 → 伪 alert（audit 口径与 90d 一致：availableIndex+1 起、notificationPrice 基准）。
 * availableAt（closeTime）→ candle index 由调用方传入的索引查找。
 */
function toPseudoAlert(rec, idxByClose) {
    var idx = null;
    if (idxByClose && typeof rec.availableAt === 'number') {
        idx = idxByClose[rec.availableAt] !== undefined ? idxByClose[rec.availableAt] : null;
    }
    return {
        id: rec.id,
        tier: 'HIGH_QUALITY',
        direction: rec.direction,
        anchorIndex: rec.anchorIndex !== undefined ? rec.anchorIndex : idx,
        availableIndex: idx,
        notificationPrice: rec.notificationPrice !== undefined ? rec.notificationPrice : null,
        notificationNearTarget: rec.notificationNearTarget !== undefined ? rec.notificationNearTarget : rec.nearTarget,
        nearTarget: rec.nearTarget,
        _priority: rec.priority === 'PRIORITY_HIGH' ? 'PRIORITY_HIGH' : 'STANDARD_HIGH'
    };
}

/**
 * 构建 closeTime → candle index 索引（openTime 兜底）。
 */
function buildCloseIndex(candles) {
    var idx = {};
    (candles || []).forEach(function (c, i) {
        if (!c) return;
        if (typeof c.closeTime === 'number') idx[c.closeTime] = i;
        else if (typeof c.openTime === 'number') idx[c.openTime] = i;
    });
    return idx;
}

/**
 * Live Prioritization Audit。
 * @param {Array} records prioritization.jsonl 解析结果（可能含 crash/replay 重复条目）
 * @param {Array} candles 5m candles（closeTime 齐全）
 * @returns {Object} {
 *   rawRecords,              // 文件原始条数（含重复）
 *   uniqueOpportunities,     // 按 id 去重后的机会数
 *   duplicateRecords,        // 被去重的重复条数
 *   unmatched,               // unique 中 availableAt 未在 candles 找到（无法算 forward）
 *   groups: { PRIORITY_HIGH: acc, STANDARD_HIGH: acc }
 * }
 */
function auditLivePrioritization(records, candles) {
    var idxByClose = buildCloseIndex(candles);
    var groups = {
        PRIORITY_HIGH: ap.newAcc(),
        STANDARD_HIGH: ap.newAcc()
    };
    var rawRecords = 0;
    var uniqueOpportunities = 0;
    var duplicateRecords = 0;
    var unmatched = 0;
    var seen = {};
    (records || []).forEach(function (rec) {
        if (!rec || !rec.id) return;
        rawRecords++;
        // 11L.15a：按 opp.id 去重（crash/replay 边界 STANDARD 可能重复落盘；以首条为准）
        if (seen[rec.id]) {
            duplicateRecords++;
            return;
        }
        seen[rec.id] = true;
        uniqueOpportunities++;
        var al = toPseudoAlert(rec, idxByClose);
        var g = groups[al._priority];
        if (typeof al.availableIndex !== 'number' || al.availableIndex >= candles.length) {
            unmatched++;
            g.n++; // 计数仍计入，forward 指标缺
            return;
        }
        ap.accAdd(g, al, candles);
    });
    return {
        rawRecords: rawRecords,
        uniqueOpportunities: uniqueOpportunities,
        duplicateRecords: duplicateRecords,
        unmatched: unmatched,
        groups: groups
    };
}

module.exports = {
    auditLivePrioritization: auditLivePrioritization,
    toPseudoAlert: toPseudoAlert,
    buildCloseIndex: buildCloseIndex
};
