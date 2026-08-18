/**
 * Scenario Explanation（Phase 8）
 *
 * Engine 负责判断，Reporter 只负责展示。
 * 输出结构化：
 *   context      当前市场背景（已确认的叙事）
 *   confirmations 已经满足的条件
 *   missing      还缺什么（waiting for）
 *   conflicts    存在的冲突
 *   invalidation 失效条件（引用 invalidationEngine）
 *
 * 不包含 FVG / Entry —— Phase 8 未实现。
 */
var invalidationEngine = require('./invalidationEngine');

/**
 * @param {Object} result scenarioEngine 输出
 * @param {Object} [options]
 * @returns {Object} { context, confirmations, missing, conflicts, invalidation }
 */
function buildExplanation(result, options) {
    var inputs = result.inputs || {};
    var bias = inputs.bias || {};
    var draw = inputs.draw || null;
    var amd = inputs.amd || {};
    var alignment = inputs.alignment || null;
    var conflicts = inputs.conflicts || [];
    var delivery = inputs.delivery || null;
    var direction = result.direction;
    var state = result.scenarioState;

    var context = [];
    var confirmations = [];
    var missing = [];
    var conflictList = [];

    // ---- context ----
    if (direction === 'BULLISH') {
        context.push('HTF bias bullish (confidence ' + (bias.confidence || 'UNKNOWN') + ')');
    } else if (direction === 'BEARISH') {
        context.push('HTF bias bearish (confidence ' + (bias.confidence || 'UNKNOWN') + ')');
    } else {
        context.push('HTF bias neutral');
    }
    if (draw && draw.direction) {
        context.push('Liquidity draw favors ' + draw.direction);
    }
    if (amd.direction) {
        context.push('AMD direction ' + amd.direction + ' (state ' + (amd.state || 'SEARCHING') + ')');
    }
    if (alignment) {
        context.push('Alignment ' + alignment);
    }

    // ---- confirmations / missing（按状态） ----
    if (state === 'BULLISH_SETUP' || state === 'BEARISH_SETUP') {
        confirmations.push('HTF bias matches AMD direction');
        confirmations.push('AMD state COMPLETE');
        confirmations.push('Delivery direction matches AMD');
        confirmations.push('Alignment MATCH');
        confirmations.push('No blocking (MAJOR) conflict');
    } else if (state === 'BULLISH_WATCH' || state === 'BEARISH_WATCH') {
        confirmations.push('HTF bias matches AMD direction');
        confirmations.push('AMD at least MANIPULATION_CONFIRMED');
        confirmations.push('Alignment MATCH');
        missing.push('AMD distribution not confirmed');
        if (!delivery || !delivery.available || delivery.direction !== amd.direction) {
            missing.push('Matching delivery incomplete');
        }
    } else if (state === 'BULLISH_WAIT' || state === 'BEARISH_WAIT') {
        confirmations.push('Directional HTF bias present');
        if (draw && drawMatchesInput(draw, direction)) {
            confirmations.push('Liquidity draw aligns with bias');
        }
        if (amd.direction && amd.direction !== direction) {
            missing.push('AMD opposes bias — waiting for LTF retracement to complete');
        } else {
            missing.push('AMD confirmation not yet present');
        }
        missing.push('Matching delivery chain incomplete');
    } else if (state === 'NEUTRAL') {
        confirmations.push('No directional HTF bias');
        missing.push('Directional HTF bias');
    } else if (state === 'CONFLICT') {
        missing.push('Conflict resolution (structure/delivery or bias confidence)');
    }

    // ---- conflicts ----
    (conflicts || []).forEach(function (c) {
        if (c && c.type) {
            conflictList.push(c.type + ' [' + (c.severity || 'UNKNOWN') + ']');
        }
    });

    return {
        context: context,
        confirmations: confirmations,
        missing: missing,
        conflicts: conflictList,
        invalidation: invalidationEngine.buildInvalidation(result, options)
    };
}

function drawMatchesInput(draw, direction) {
    var dd = draw.direction;
    if (direction === 'BULLISH') {
        return dd === 'BSL' || dd === 'LEAN_BSL';
    }
    if (direction === 'BEARISH') {
        return dd === 'SSL' || dd === 'LEAN_SSL';
    }
    return false;
}

module.exports = {
    buildExplanation: buildExplanation
};
