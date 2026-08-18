/**
 * Freshness Scorer（纯函数）
 *
 * Draw 层的 Freshness 表达“作为当前目标还完整到什么程度”：
 *   Liquidity ACTIVE        100
 *   Liquidity TOUCHED        80
 *   Liquidity SWEPT/BROKEN    0
 *   Cluster ACTIVE          100
 *   Cluster PARTIAL          75
 *   Cluster CONSUMED          0
 *
 * 不做成员级细节分析 —— Phase 4 已经推导出 cluster state。
 * 与 Phase 4 Strength 中的 freshness 乘数概念一致，
 * 但这里是 Draw 层独立计算（强度层已对 lifecycle 做一次衰减，
 * 这里只按 state/status 映射，避免重复严重惩罚）。
 */
var thresholds = require('../config/thresholds');

/**
 * @param {Object} candidate 统一 candidate（targetType + state/status）
 * @param {Object} [config] 覆盖配置（默认 thresholds.draw）
 * @returns {number} 0-100
 */
function scoreFreshness(candidate, config) {
    var cfg = config || thresholds.draw;
    if (!candidate) {
        return 0;
    }
    if (candidate.targetType === 'CLUSTER') {
        var mult = cfg.clusterStateMultiplier;
        var m = mult && mult[candidate.state] !== undefined ? mult[candidate.state] : 0;
        return 100 * m;
    }
    // standalone liquidity
    if (candidate.status === 'ACTIVE') {
        return 100;
    }
    if (candidate.status === 'TOUCHED') {
        return 80;
    }
    return 0;
}

module.exports = {
    scoreFreshness: scoreFreshness
};
