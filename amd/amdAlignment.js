/**
 * AMD ↔ Bias Alignment
 *
 * MATCH：Bias BULLISH/LEAN_BULLISH + AMD BULLISH（或对称）
 * OPPOSITE：明确相反
 * UNCONFIRMED：Bias NEUTRAL / 无方向
 *
 * Alignment 不修改 AMD state/score（AMD 是 LTF 事实，alignment 是上下文评价）。
 * Bias confidence LOW 时仍输出方向关系，但 metadata 标记 biasConfidenceLow = true。
 */
/**
 * @param {Object} bias biasEngine 输出（direction, confidence）
 * @param {string} amdDirection 'BULLISH' | 'BEARISH' | null
 * @returns {Object} { alignment, biasDirection, amdDirection, biasConfidenceLow }
 */
function align(bias, amdDirection) {
    var biasDir = bias && bias.direction ? bias.direction : null;
    var biasConfidenceLow = !!(bias && bias.confidence === 'LOW');

    var alignment;
    if (!amdDirection) {
        alignment = 'UNCONFIRMED';
    } else if (biasDir === 'NEUTRAL' || !biasDir) {
        alignment = 'UNCONFIRMED';
    } else {
        var biasBullish = biasDir === 'BULLISH' || biasDir === 'LEAN_BULLISH';
        var biasBearish = biasDir === 'BEARISH' || biasDir === 'LEAN_BEARISH';
        var amdBullish = amdDirection === 'BULLISH';
        if ((biasBullish && amdBullish) || (biasBearish && !amdBullish)) {
            alignment = 'MATCH';
        } else if ((biasBullish && !amdBullish) || (biasBearish && amdBullish)) {
            alignment = 'OPPOSITE';
        } else {
            alignment = 'UNCONFIRMED';
        }
    }

    return {
        alignment: alignment,
        biasDirection: biasDir,
        amdDirection: amdDirection,
        biasConfidenceLow: biasConfidenceLow
    };
}

module.exports = {
    align: align
};
