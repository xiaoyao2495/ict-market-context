/**
 * Phase 11L.9 — Production MSS Direction Integrity Audit
 *
 * 背景：11L.8-S2 shadow 发现 production INSIDE HIGH = 570 vs buildAlerts 575（差 ~5 笔）。
 * 怀疑点：displacementDetector 的 same-candle bonus 把【同根第一个】MSS 挂到 displacement
 * （metadata.mssEventId = mssByIndex[index][0].id），且【不校验方向】——
 * 生产 authoritative path（leg.mssId → classifyMssReference）也不校验 mss.direction === leg.direction。
 *
 * 本审计：对 575 条 HIGH 逐笔检查 leg.direction vs leg.mssId 对应 MSS 的 direction。
 * 输出：
 *   MATCH      mss.direction === leg.direction
 *   OPPOSITE   mss.direction !== leg.direction（挂载方向不一致 —— 候选疑点）
 *   MISSING    leg.mssId 存在但 MSS 事件找不到
 *   NO_MSS     leg.mssId 缺失（HIGH 不应出现，观察）
 *
 * 纯诊断，不改生产。若 OPPOSITE 属实再决定是否修；否则关闭挂账 §8.6。
 */
/**
 * @param {Array} alerts buildAlerts 输出（含 direction / dispId）
 * @param {Object} legByDispId dispId → leg（含 mssId / startIndex / endIndex）
 * @param {Object} mssById mssId → MSS 事件（含 direction / candleIndex / confirmedAt）
 * @returns {Object} { total, MATCH, OPPOSITE, MISSING, NO_MSS, details: [...] }
 */
function auditMssDirection(alerts, legByDispId, mssById) {
    var out = {
        total: 0,
        MATCH: 0,
        OPPOSITE: 0,
        MISSING: 0,
        NO_MSS: 0,
        details: []
    };
    (alerts || []).forEach(function (al) {
        if (!al || !al.direction) return;
        out.total++;
        var leg = al.dispId ? (legByDispId[al.dispId] || null) : null;
        var mssId = leg && leg.mssId ? leg.mssId : null;
        if (!mssId) {
            out.NO_MSS++;
            return;
        }
        var mssEvent = mssById[mssId] || null;
        if (!mssEvent || !mssEvent.direction) {
            out.MISSING++;
            out.details.push({
                id: al.id, legDirection: al.direction, mssId: mssId,
                status: 'MISSING', anchorIndex: al.anchorIndex, anchorTime: al.anchorTime
            });
            return;
        }
        if (mssEvent.direction === al.direction) {
            out.MATCH++;
        } else {
            out.OPPOSITE++;
            out.details.push({
                id: al.id,
                legDirection: al.direction,
                mssDirection: mssEvent.direction,
                mssId: mssId,
                status: 'OPPOSITE',
                anchorIndex: al.anchorIndex,
                anchorTime: al.anchorTime,
                mssCandleIndex: mssEvent.candleIndex,
                legStartIndex: leg ? leg.startIndex : null,
                legEndIndex: leg ? (leg.endIndex !== undefined ? leg.endIndex : leg.lastIndex) : null
            });
        }
    });
    out.details.sort(function (a, b) { return a.anchorIndex - b.anchorIndex; });
    return out;
}

module.exports = {
    auditMssDirection: auditMssDirection
};
