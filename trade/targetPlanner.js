/**
 * Target Planner（Phase 10）
 *
 * 复用 Draw Engine：LONG 用 active BSL draw，SHORT 用 active SSL draw。
 * 候选优先级：
 *   1. Primary Draw
 *   2. Secondary Draw
 *   3. 无（不强行凑）
 *
 * Target 必须在 entry 的盈利方向：
 *   LONG  target > entry
 *   SHORT target < entry
 *
 * 不得为了满足 RR 人工延长 target —— 真实 RR 不足时由 RR 检查拒绝。
 */
var thresholds = require('../config/thresholds');

/**
 * @param {Object} input {
 *   direction,   'LONG' | 'SHORT'
 *   entryPrice,
 *   draw,        drawEngine 输出（bsl.primary/secondary, ssl.primary/secondary）
 * }
 * @param {Object} [options]
 * @returns {Object} {
 *   status: 'READY' | 'INVALID',
 *   price, source, candidateId, strength, drawScore, reason
 * }
 */
function planTarget(input, options) {
    var direction = input.direction;
    var entryPrice = input.entryPrice;
    var draw = input.draw || {};

    var side = direction === 'LONG' ? 'bsl' : 'ssl';
    var sideBlock = draw[side] || {};

    var primary = sideBlock.primary || null;
    var secondary = sideBlock.secondary || null;

    var candidate = primary || secondary;
    if (!candidate) {
        return {
            status: 'INVALID',
            price: null,
            source: null,
            candidateId: null,
            strength: null,
            drawScore: null,
            reason: 'No active ' + (direction === 'LONG' ? 'BSL' : 'SSL') + ' draw candidate'
        };
    }

    // Target 必须在盈利方向
    var inProfit =
        (direction === 'LONG' && candidate.targetPrice > entryPrice) ||
        (direction === 'SHORT' && candidate.targetPrice < entryPrice);
    if (!inProfit) {
        // primary 方向不对时尝试 secondary
        if (secondary && secondary !== primary) {
            candidate = secondary;
            var inProfit2 =
                (direction === 'LONG' && candidate.targetPrice > entryPrice) ||
                (direction === 'SHORT' && candidate.targetPrice < entryPrice);
            if (inProfit2) {
                return ready(candidate, 'SECONDARY_DRAW', direction);
            }
        }
        return {
            status: 'INVALID',
            price: null,
            source: null,
            candidateId: null,
            strength: null,
            drawScore: null,
            reason: 'Draw target not on profit side of entry'
        };
    }

    return ready(candidate, primary === candidate ? 'PRIMARY_DRAW' : 'SECONDARY_DRAW', direction);
}

function ready(candidate, source, direction) {
    return {
        status: 'READY',
        price: candidate.targetPrice,
        source: source,
        candidateId: candidate.id,
        strength: candidate.strength !== undefined ? candidate.strength : null,
        drawScore: candidate.drawScore !== undefined ? candidate.drawScore : null,
        reason: null
    };
}

module.exports = {
    planTarget: planTarget
};
