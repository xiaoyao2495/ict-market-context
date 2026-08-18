/**
 * Bias Scorer —— 五分量合成 + 方向判定
 *
 * rawScore = liquidity + structure + location + delivery
 * clamp：-100 ~ +100
 *
 * 方向（thresholds.bias.directionThresholds）：
 *   >= +35            BULLISH
 *   +15 ~ +34.999     LEAN_BULLISH
 *   -14.999 ~ +14.999 NEUTRAL
 *   -34.999 ~ -15     LEAN_BEARISH
 *   <= -35            BEARISH
 *
 * Bias Score 是方向性判断的 evidence points，不是概率。
 * Conflict 不修改 raw direction（只影响 confidence，见 biasEngine）。
 */
var thresholds = require('../config/thresholds');

function round2(n) {
    return Math.round(n * 100) / 100;
}

function clamp(n, min, max) {
    if (n < min) return min;
    if (n > max) return max;
    return n;
}

/**
 * score → 五档方向
 */
function directionOf(score, cfg) {
    var t = cfg.bias.directionThresholds;
    if (score >= t.strongBias) {
        return 'BULLISH';
    }
    if (score >= t.leanBias) {
        return 'LEAN_BULLISH';
    }
    if (score > t.leanBear) {
        return 'NEUTRAL';
    }
    if (score > t.strongBear) {
        return 'LEAN_BEARISH';
    }
    return 'BEARISH';
}

/**
 * @param {Object} components { liquidity, structure, location, delivery }（各含 score）
 * @param {Object} [options] { thresholds }
 * @returns {Object} { rawScore, score, direction }
 */
function scoreBias(components, options) {
    var cfg = (options && options.thresholds) || thresholds;
    var rawScore =
        (components.liquidity.score || 0) +
        (components.structure.score || 0) +
        (components.location.score || 0) +
        (components.delivery.score || 0);
    var score = clamp(round2(rawScore), -100, 100);
    return {
        rawScore: round2(rawScore),
        score: score,
        direction: directionOf(score, cfg)
    };
}

/**
 * 组件 score → 方向标签（BULLISH / BEARISH / NEUTRAL）
 */
function componentDirection(score) {
    if (score > 0) return 'BULLISH';
    if (score < 0) return 'BEARISH';
    return 'NEUTRAL';
}

module.exports = {
    scoreBias: scoreBias,
    directionOf: directionOf,
    componentDirection: componentDirection
};
