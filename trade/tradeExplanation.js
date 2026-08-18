/**
 * Trade Explanation（Phase 10）
 *
 * Reporter 不重新推理 —— Engine 判断，Reporter 展示。
 * 输出：
 *   confirmations 已满足的条件
 *   missing       还缺什么
 *   reasons       plan 的 reasons（rejection / missed 原因）
 */
/**
 * @param {Object} plan tradePlan 输出
 * @param {Object} [options]
 * @returns {Object} { confirmations, missing, reasons }
 */
function buildTradeExplanation(plan, options) {
    var confirmations = [];
    var missing = [];

    if (plan.status === 'READY') {
        confirmations.push('Entry Gate ENTRY_READY');
        confirmations.push('Entry valid (' + plan.entry.type + ')');
        confirmations.push('Stop valid (' + plan.stop.source + ')');
        confirmations.push('Target valid (' + plan.target.source + ')');
        confirmations.push('RR ' + plan.rr + ' >= min');
    } else if (plan.status === 'NOT_AVAILABLE') {
        missing.push('Entry Gate must be ENTRY_READY');
    } else if (plan.status === 'ENTRY_MISSED') {
        missing.push('Price retrace back to entry zone');
    } else if (plan.status === 'REJECTED') {
        missing.push('Risk/reward requirements');
        (plan.reasons || []).forEach(function (r) {
            missing.push(r);
        });
    }

    return {
        confirmations: confirmations,
        missing: missing,
        reasons: plan.reasons || []
    };
}

module.exports = {
    buildTradeExplanation: buildTradeExplanation
};
