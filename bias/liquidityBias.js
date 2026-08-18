/**
 * Liquidity Bias —— 消费 Phase 5 Draw Engine 的方向输出
 *
 * Draw = BSL      → +30（bullish evidence）
 * Draw = LEAN_BSL → +15
 * Draw = BALANCED →   0
 * Draw = LEAN_SSL → -15
 * Draw = SSL      → -30
 *
 * 注意：这是 bias evidence points，不是概率。
 * 无候选（两侧都空）→ 0，reason 明确说明。
 */
var thresholds = require('../config/thresholds');

/**
 * @param {Object} drawResult runDrawEngine 的输出
 * @param {Object} [options] { thresholds }
 * @returns {Object} { score, drawDirection, reason }
 */
function scoreLiquidityBias(drawResult, options) {
    var cfg = (options && options.thresholds) || thresholds;
    var table = cfg.bias.liquidity;
    var direction = drawResult && drawResult.direction ? drawResult.direction : 'BALANCED';

    var score = table[direction] !== undefined ? table[direction] : 0;

    var reason;
    if (direction === 'BALANCED') {
        reason = drawResult && drawResult.explanation
            ? 'draw balanced: ' + drawResult.explanation
            : 'draw balanced (no directional evidence)';
    } else {
        reason = direction + ' liquidity draw';
    }

    return {
        score: score,
        drawDirection: direction,
        reason: reason
    };
}

module.exports = {
    scoreLiquidityBias: scoreLiquidityBias
};
