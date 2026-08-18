/**
 * Entry Invalidation（Phase 9.2）
 *
 * 输出 Entry Gate 的失效条件（描述列表）。
 * 只输出描述，不自动交易。
 *
 * Bullish：
 *   - Scenario 不再 bullish（BULLISH_WATCH 消失）
 *   - AMD INVALIDATED
 *   - Alignment OPPOSITE
 *   - Bearish delivery 取代 bullish chain
 *   - FVG invalidated / filled without trade
 * Bearish 对称。
 */
/**
 * @param {Object} gateResult entryGate 输出
 * @param {Object} input 与 runEntryGate 相同的输入
 * @param {Object} [options]
 * @returns {Array<string>}
 */
function buildEntryInvalidation(gateResult, input, options) {
    var scenario = input.scenario || {};
    var direction = scenario.direction;

    if (direction === 'BULLISH') {
        return [
            'Scenario exits BULLISH_WATCH (action no longer WATCH)',
            'AMD becomes INVALIDATED',
            'Alignment becomes OPPOSITE',
            'Bearish delivery replaces bullish chain',
            'FVG invalidated or filled without entry'
        ];
    }
    if (direction === 'BEARISH') {
        return [
            'Scenario exits BEARISH_WATCH (action no longer WATCH)',
            'AMD becomes INVALIDATED',
            'Alignment becomes OPPOSITE',
            'Bullish delivery replaces bearish chain',
            'FVG invalidated or filled without entry'
        ];
    }
    return [
        'Scenario must re-enter matching WATCH state',
        'A fresh valid FVG must form'
    ];
}

module.exports = {
    buildEntryInvalidation: buildEntryInvalidation
};
