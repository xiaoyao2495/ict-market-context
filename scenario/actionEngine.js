/**
 * Action Engine（Phase 8）
 *
 * 只输出四类动作：
 *   NO_TRADE    上下文冲突大 / Bias 无效 / AMD 反向且质量差
 *   WAIT        有方向性叙事，但缺少关键触发
 *   WATCH       HTF Bias / Draw / AMD 基本对齐，等待具体入场确认
 *   SETUP_READY 上下文与 LTF 条件都成熟，可交给 Entry Engine
 *
 * 重要：
 * - Action 由 scenarioState 显式状态逻辑推导，绝不因 score 高自动升级。
 * - SETUP_READY 输出 setupReadyType = 'CONTEXT_READY'（Phase 8 无 FVG，
 *   只是 Context Setup Ready，不是 Entry Ready）。
 * - 本模块做防御性门控：即使 scenarioState 是 SETUP，若显式条件不满足
 *   （如 delivery 未匹配 / AMD 未 COMPLETE / alignment 非 MATCH），
 *   也保守降级为 WAIT，防止状态机与条件脱节。
 */
var thresholds = require('../config/thresholds');

/**
 * @param {string} scenarioState
 * @param {Object} parts { bias, draw, amd, alignment, conflicts, delivery, direction }
 * @param {Object} [options] { thresholds }
 * @returns {Object} { action, setupReadyType }
 */
function resolveAction(scenarioState, parts, options) {
    var opts = options || {};
    var cfg = (opts.thresholds || thresholds).scenario;

    switch (scenarioState) {
        case 'CONFLICT':
            return { action: 'NO_TRADE', setupReadyType: null };

        case 'NEUTRAL':
            return { action: 'WAIT', setupReadyType: null };

        case 'BULLISH_SETUP':
        case 'BEARISH_SETUP':
            // 防御性门控：重新校验显式条件
            if (setupConditionsMet(parts, cfg)) {
                return { action: 'SETUP_READY', setupReadyType: 'CONTEXT_READY' };
            }
            return { action: 'WAIT', setupReadyType: null };

        case 'BULLISH_WATCH':
        case 'BEARISH_WATCH':
            // 防御性门控：AMD 至少 MANIPULATION_CONFIRMED 且 alignment MATCH
            if (watchConditionsMet(parts)) {
                return { action: 'WATCH', setupReadyType: null };
            }
            return { action: 'WAIT', setupReadyType: null };

        case 'BULLISH_WAIT':
        case 'BEARISH_WAIT':
        default:
            return { action: 'WAIT', setupReadyType: null };
    }
}

/**
 * SETUP_READY 显式条件：
 * - AMD direction 与 bias 匹配
 * - alignment MATCH
 * - AMD state COMPLETE
 * - delivery 方向匹配
 * - 无 MAJOR conflict
 */
function setupConditionsMet(parts, cfg) {
    var biasDir = parts.direction;
    var amd = parts.amd || {};
    var alignment =
        typeof parts.alignment === 'string'
            ? parts.alignment
            : parts.alignment && parts.alignment.alignment
            ? parts.alignment.alignment
            : null;
    var delivery = parts.delivery || null;
    var conflicts = parts.conflicts || [];

    if (amd.direction !== biasDir) {
        return false;
    }
    if (alignment !== 'MATCH') {
        return false;
    }
    if (amd.state !== 'COMPLETE') {
        return false;
    }
    if (!delivery || !delivery.available || delivery.direction !== amd.direction) {
        return false;
    }
    if (Math.abs(delivery.score || 0) <= 0) {
        return false;
    }
    var hasMajor = conflicts.some(function (c) {
        return c && c.severity === 'MAJOR';
    });
    if (hasMajor) {
        return false;
    }
    return true;
}

/**
 * WATCH 显式条件：AMD 方向匹配 + alignment MATCH + state >= MANIPULATION_CONFIRMED
 */
function watchConditionsMet(parts) {
    var biasDir = parts.direction;
    var amd = parts.amd || {};
    var alignment =
        typeof parts.alignment === 'string'
            ? parts.alignment
            : parts.alignment && parts.alignment.alignment
            ? parts.alignment.alignment
            : null;

    if (amd.direction !== biasDir) {
        return false;
    }
    if (alignment !== 'MATCH') {
        return false;
    }
    var s = amd.state;
    if (s !== 'MANIPULATION_CONFIRMED' && s !== 'DISTRIBUTION_CONFIRMED') {
        return false;
    }
    return true;
}

module.exports = {
    resolveAction: resolveAction,
    setupConditionsMet: setupConditionsMet,
    watchConditionsMet: watchConditionsMet
};
