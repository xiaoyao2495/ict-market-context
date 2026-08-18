/**
 * AMD Scorer
 *
 * AMD Score = Accumulation × 0.30 + Manipulation × 0.30 + Distribution × 0.40
 * 权重必须和 = 1（1e-9 容差），否则报错。
 * 未完成阶段 → 分数只用于观察，不标 COMPLETE。
 * AMD Score 不是 probability。
 */
var thresholds = require('../config/thresholds');

function clamp(n, min, max) {
    if (n < min) return min;
    if (n > max) return max;
    return n;
}

/**
 * @param {Object} amdResult runAmd 输出（含 accumulation/manipulation/distribution）
 * @param {Object} [options] { thresholds }
 * @returns {Object} { score, breakdown, complete }
 */
function scoreAmd(amdResult, options) {
    var cfg = (options && options.thresholds) || thresholds;
    var weights = cfg.amd.score;

    var sum = weights.accumulation + weights.manipulation + weights.distribution;
    if (Math.abs(sum - 1) > 1e-9) {
        throw new Error('AMD score weights must sum to 1, got ' + sum);
    }

    var accScore = amdResult.accumulation ? amdResult.accumulation.score : 0;
    var manipScore = amdResult.manipulation ? amdResult.manipulation.score : 0;
    var distScore = amdResult.distribution ? amdResult.distribution.score : 0;

    var score = Math.round(
        accScore * weights.accumulation +
        manipScore * weights.manipulation +
        distScore * weights.distribution
    );
    score = clamp(score, 0, 100);

    return {
        score: score,
        complete: amdResult.state === 'DISTRIBUTION_CONFIRMED',
        breakdown: {
            accumulation: accScore,
            manipulation: manipScore,
            distribution: distScore
        }
    };
}

module.exports = {
    scoreAmd: scoreAmd
};
