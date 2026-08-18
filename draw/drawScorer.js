/**
 * Draw Scorer（纯函数）
 *
 * Draw Score = Strength×w1 + Distance×w2 + Freshness×w3
 *
 * 重要：
 * - Draw Score 不是 probability，只是“作为当前 liquidity target 的相对优先级”
 * - 构造时校验权重之和 = 1（允许 1e-9 浮点误差），否则明确报错
 * - 始终返回 breakdown（不只是 final），便于 Replay 调参
 */
var thresholds = require('../config/thresholds');

function round1(n) {
    return Math.round(n * 10) / 10;
}

function clamp(n, min, max) {
    if (n < min) return min;
    if (n > max) return max;
    return n;
}

/**
 * 校验权重之和 = 1
 */
function validateWeights(weights) {
    var sum =
        (weights.strength || 0) +
        (weights.distance || 0) +
        (weights.freshness || 0);
    if (Math.abs(sum - 1) > 1e-9) {
        throw new Error(
            'Draw weights must sum to 1, got ' + sum +
            ' (strength=' + weights.strength +
            ', distance=' + weights.distance +
            ', freshness=' + weights.freshness + ')'
        );
    }
}

/**
 * @param {Object} candidate 已含 strength / distanceScore / freshness
 * @param {Object} [options] { thresholds }
 * @returns {Object} breakdown { strengthScore, strengthContribution, distanceScore,
 *   distanceContribution, freshnessScore, freshnessContribution, final }
 */
function scoreDraw(candidate, options) {
    var cfg = (options && options.thresholds) || thresholds;
    var weights = cfg.draw.weights;
    validateWeights(weights);

    var strengthScore = candidate.strength;
    var distanceScore = candidate.distanceScore;
    var freshnessScore = candidate.freshness;

    var strengthContribution = round1(strengthScore * weights.strength);
    var distanceContribution = round1(distanceScore * weights.distance);
    var freshnessContribution = round1(freshnessScore * weights.freshness);

    var final = clamp(
        round1(strengthContribution + distanceContribution + freshnessContribution),
        0,
        100
    );

    return {
        strengthScore: strengthScore,
        strengthContribution: strengthContribution,
        distanceScore: distanceScore,
        distanceContribution: distanceContribution,
        freshnessScore: freshnessScore,
        freshnessContribution: freshnessContribution,
        final: final
    };
}

module.exports = {
    scoreDraw: scoreDraw,
    validateWeights: validateWeights
};
