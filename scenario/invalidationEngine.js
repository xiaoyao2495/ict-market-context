/**
 * Invalidation Engine（Phase 8）
 *
 * 输出当前 scenario 的失效条件（条件描述列表）。
 * 只输出描述，不自动交易 —— Phase 8 无 SL/TP / 自动交易。
 *
 * Bullish scenario 失效条件（示例）：
 *   - Bias becomes BEARISH
 *   - Primary Draw changes to SSL
 *   - AMD becomes INVALIDATED
 *   - Alignment becomes OPPOSITE with LOW bias confidence
 * Bearish 对称。
 */
/**
 * @param {Object} result scenarioEngine 输出
 * @param {Object} [options]
 * @returns {Array<string>} 失效条件描述
 */
function buildInvalidation(result, options) {
    var direction = result.direction;
    var amd = (result.inputs && result.inputs.amd) || {};
    var bias = (result.inputs && result.inputs.bias) || {};

    if (direction === 'BULLISH') {
        var list = [
            'Bias becomes BEARISH',
            'Primary Draw changes to SSL',
            'AMD becomes INVALIDATED'
        ];
        if (amd.state === 'COMPLETE') {
            list.push('Delivery flips to BEARISH');
        }
        if (bias.confidence === 'LOW') {
            list.push('Alignment becomes OPPOSITE with LOW bias confidence');
        } else {
            list.push('Alignment becomes OPPOSITE while bias confidence drops to LOW');
        }
        return list;
    }

    if (direction === 'BEARISH') {
        var list2 = [
            'Bias becomes BULLISH',
            'Primary Draw changes to BSL',
            'AMD becomes INVALIDATED'
        ];
        if (amd.state === 'COMPLETE') {
            list2.push('Delivery flips to BULLISH');
        }
        if (bias.confidence === 'LOW') {
            list2.push('Alignment becomes OPPOSITE with LOW bias confidence');
        } else {
            list2.push('Alignment becomes OPPOSITE while bias confidence drops to LOW');
        }
        return list2;
    }

    // NEUTRAL / CONFLICT
    if (result.scenarioState === 'CONFLICT') {
        return [
            'Major conflict resolves (structure/delivery alignment)',
            'Bias confidence rises above LOW',
            'Directional HTF bias emerges'
        ];
    }
    return [
        'Directional HTF bias emerges',
        'AMD direction confirms with MATCH alignment'
    ];
}

module.exports = {
    buildInvalidation: buildInvalidation
};
