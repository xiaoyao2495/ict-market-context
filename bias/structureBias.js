/**
 * Structure Bias —— HTF swing structure 加权合成
 *
 * 第一版只消费已确认的 swing structure（不混入 MSS）。
 *
 * 每周期结构分：
 *   BULLISH    → +maxWeight（如 4H = +20）
 *   BEARISH    → -maxWeight
 *   NEUTRAL    → 0（数据不足 / 平盘）
 *   CONFLICTED → 0（内部矛盾，不贡献方向）
 *
 * 合成（主周期优先，避免简单相加导致权重过大）：
 *   score = Σ(periodScore × periodMix)
 *   全 bullish 时 = 25×0.45 + 20×0.40 + 10×0.15 ≈ +20.75（不会溢出 ±25 上限概念）
 */
var thresholds = require('../config/thresholds');
var swingClassifier = require('../structure/swingClassifier');

/**
 * @param {Object} structures 各周期 classifyStructure 结果，如 { '1d': {...}, '4h': {...}, '1h': {...} }
 * @param {Object} [options] { thresholds }
 * @returns {Object} {
 *   score, breakdown: { '1d': {structure, weight, contribution}, ... },
 *   reason
 * }
 */
function scoreStructureBias(structures, options) {
    var cfg = (options && options.thresholds) || thresholds;
    var maxWeights = cfg.bias.structure.maxWeights;
    var mix = cfg.bias.structure.mix;

    var total = 0;
    var breakdown = {};
    var reasons = [];

    Object.keys(maxWeights).forEach(function (tf) {
        var s = structures && structures[tf];
        var weight = maxWeights[tf];
        var mixFactor = mix[tf] !== undefined ? mix[tf] : 0;
        var contribution = 0;
        var label;

        if (s && s.structure === swingClassifier.BULLISH) {
            contribution = weight * mixFactor;
            label = 'BULLISH';
            reasons.push(tf + ' structure bullish');
        } else if (s && s.structure === swingClassifier.BEARISH) {
            contribution = -weight * mixFactor;
            label = 'BEARISH';
            reasons.push(tf + ' structure bearish');
        } else {
            label = s ? s.structure : 'MISSING';
            if (label === 'CONFLICTED') {
                reasons.push(tf + ' structure conflicted (0)');
            }
        }

        breakdown[tf] = {
            structure: label,
            weight: weight,
            mix: mixFactor,
            contribution: round2(contribution)
        };
        total += contribution;
    });

    var score = round2(total);
    return {
        score: score,
        breakdown: breakdown,
        reason: reasons.length > 0 ? reasons.join('; ') : 'no HTF structure data'
    };
}

function round2(n) {
    return Math.round(n * 100) / 100;
}

module.exports = {
    scoreStructureBias: scoreStructureBias
};
