/**
 * Distance Scorer（纯函数）
 *
 * 只做一件事：根据 distancePct 查离散距离表返回 0-100 分数。
 * - BSL / SSL 完全对称，不根据 side 改变算法
 * - 边界锁死：distancePct <= bands[i].maxPct 即命中该档（0.25% 命中第一档而非第二档）
 * - 参数全部来自 config/thresholds.js 的 draw.distanceBands
 */
var thresholds = require('../config/thresholds');

/**
 * @param {number} distancePct 相对距离（0.0042 = 0.42%）
 * @param {Object} [config] 覆盖配置（默认 thresholds.draw）
 * @returns {number} 0-100
 */
function scoreDistance(distancePct, config) {
    var cfg = config || thresholds.draw;
    var bands = cfg.distanceBands || [];
    var i;
    for (i = 0; i < bands.length; i++) {
        if (distancePct <= bands[i].maxPct) {
            return bands[i].score;
        }
    }
    return cfg.distanceFallbackScore !== undefined
        ? cfg.distanceFallbackScore
        : 15;
}

module.exports = {
    scoreDistance: scoreDistance
};
