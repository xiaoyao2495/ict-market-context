/**
 * Conflict Detector —— 识别“主要证据是否分裂”
 *
 * 原则：
 * - Conflict 只描述冲突，不自己创造方向
 * - Conflict 不得直接修改 raw Bias Score（只影响 confidence）
 * - NEUTRAL / score = 0 不构成 conflict
 *
 * 三种冲突（第一版）：
 *   A. STRUCTURE_VS_DELIVERY  MAJOR
 *      HTF structure 与 LTF delivery 强方向相反
 *   B. DRAW_VS_STRUCTURE      MODERATE
 *      Liquidity draw 与 HTF structure 方向相反
 *   C. LOCATION_VS_DELIVERY   MINOR
 *      Price location 与近期 delivery 方向相反
 *      （通常表示可能还在完成 retracement，而非 HTF Bias 已翻）
 */
var thresholds = require('../config/thresholds');

function signOf(n) {
    return n > 0 ? 1 : n < 0 ? -1 : 0;
}

function dirText(sign) {
    return sign > 0 ? 'bullish' : 'bearish';
}

/**
 * @param {Object} components { liquidity, structure, location, delivery }（各含 score）
 * @param {Object} [options] { thresholds }
 * @returns {Array} conflicts
 */
function detectConflicts(components, options) {
    var conflicts = [];
    var liq = signOf(components.liquidity.score);
    var struct = signOf(components.structure.score);
    var loc = signOf(components.location.score);
    var deliv = signOf(components.delivery.score);
    var delivAvailable = components.delivery.available;

    // A. STRUCTURE_VS_DELIVERY（MAJOR）
    if (delivAvailable && struct !== 0 && deliv !== 0 && struct !== deliv) {
        conflicts.push({
            type: 'STRUCTURE_VS_DELIVERY',
            severity: 'MAJOR',
            bullishEvidence: struct > 0 ? ['STRUCTURE'] : ['DELIVERY'],
            bearishEvidence: struct > 0 ? ['DELIVERY'] : ['STRUCTURE'],
            reason:
                'HTF structure ' + dirText(struct) +
                ' while LTF delivery ' + dirText(deliv)
        });
    }

    // B. DRAW_VS_STRUCTURE（MODERATE）
    if (liq !== 0 && struct !== 0 && liq !== struct) {
        conflicts.push({
            type: 'DRAW_VS_STRUCTURE',
            severity: 'MODERATE',
            bullishEvidence: liq > 0 ? ['LIQUIDITY'] : ['STRUCTURE'],
            bearishEvidence: liq > 0 ? ['STRUCTURE'] : ['LIQUIDITY'],
            reason:
                'liquidity draw ' + dirText(liq) +
                ' while HTF structure ' + dirText(struct)
        });
    }

    // C. LOCATION_VS_DELIVERY（MINOR）
    if (delivAvailable && loc !== 0 && deliv !== 0 && loc !== deliv) {
        conflicts.push({
            type: 'LOCATION_VS_DELIVERY',
            severity: 'MINOR',
            bullishEvidence: loc > 0 ? ['LOCATION'] : ['DELIVERY'],
            bearishEvidence: loc > 0 ? ['DELIVERY'] : ['LOCATION'],
            reason:
                'price location ' + dirText(loc) +
                ' while recent delivery ' + dirText(deliv) +
                ' (possible retracement completion)'
        });
    }

    return conflicts;
}

module.exports = {
    detectConflicts: detectConflicts
};
