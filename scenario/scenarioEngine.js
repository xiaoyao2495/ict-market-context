/**
 * Scenario Engine（Phase 8）
 *
 * 核心原则：Direction ≠ Action。
 * - Scenario 只描述市场状态（NEUTRAL / CONFLICT / BULLISH_WAIT / BULLISH_WATCH /
 *   BULLISH_SETUP / BEARISH_WAIT / BEARISH_WATCH / BEARISH_SETUP）
 * - Action 由 actionEngine 决定（NO_TRADE / WAIT / WATCH / SETUP_READY）
 * - Bias 有方向不代表 BUY：可能只是 WAIT（AMD 未确认 / 发生 opposite delivery）
 *
 * 输入（全部来自已完成的模块）：
 *   bias       biasEngine 输出（direction / confidence / components / conflicts）
 *   draw       drawEngine 输出（direction / imbalance / bsl / ssl）
 *   amd        amdStateMachine 输出（state / direction / ...）
 *   alignment  'MATCH' | 'OPPOSITE' | 'UNCONFIRMED'（或 amdAlignment 对象）
 *   conflicts  冲突数组 [{ type, severity }]
 *   delivery   delivery 组件（缺省取 bias.components.delivery）
 *
 * 决策规则：
 *   NEUTRAL bias:
 *     - 无强冲突          → NEUTRAL / WAIT
 *     - LOW confidence + MAJOR conflict → CONFLICT / NO_TRADE
 *   Opposite AMD（AMD 方向与 bias 相反）:
 *     - bias confidence HIGH/MEDIUM → BULLISH_WAIT|BEARISH_WAIT / WAIT
 *       （可能是 HTF bullish context 中的 LTF bearish retracement）
 *     - bias LOW + MAJOR conflict  → CONFLICT / NO_TRADE（blocking）
 *   AMD matching + alignment MATCH:
 *     - state COMPLETE + delivery matching + 无 MAJOR → SETUP（setupReadyType='CONTEXT_READY'）
 *     - state >= MANIPULATION_CONFIRMED → WATCH
 *     - 否则 → WAIT
 *   AMD 缺失/方向未知 → WAIT（有叙事缺触发）
 */
var thresholds = require('../config/thresholds');
var actionEngine = require('./actionEngine');
var scenarioScorer = require('./scenarioScorer');
var scenarioExplanation = require('./scenarioExplanation');
var invalidationEngine = require('./invalidationEngine');

/**
 * bias.direction → 归一化方向（BULLISH / BEARISH / NEUTRAL）
 */
function biasDirectionOf(bias) {
    if (!bias || !bias.direction) {
        return 'NEUTRAL';
    }
    var d = bias.direction;
    if (d === 'BULLISH' || d === 'LEAN_BULLISH') {
        return 'BULLISH';
    }
    if (d === 'BEARISH' || d === 'LEAN_BEARISH') {
        return 'BEARISH';
    }
    return 'NEUTRAL';
}

function isBullish(d) {
    return d === 'BULLISH';
}

function isBearish(d) {
    return d === 'BEARISH';
}

/**
 * draw 是否与 bias 方向一致（draw 只确认 narrative，不单独决定 scenario 方向）
 */
function drawMatches(biasDir, draw) {
    if (!draw || !draw.direction) {
        return false;
    }
    var dd = draw.direction;
    if (isBullish(biasDir)) {
        return dd === 'BSL' || dd === 'LEAN_BSL';
    }
    if (isBearish(biasDir)) {
        return dd === 'SSL' || dd === 'LEAN_SSL';
    }
    return false;
}

function amdDirectionOf(amd) {
    return amd && amd.direction ? amd.direction : null;
}

/**
 * delivery 是否与 AMD 方向匹配（available + 方向一致 + 有分）
 */
function deliveryMatches(amdDir, delivery) {
    if (!amdDir || !delivery || !delivery.available) {
        return false;
    }
    if (delivery.direction !== amdDir) {
        return false;
    }
    return Math.abs(delivery.score || 0) > 0;
}

/**
 * delivery 是否"完整匹配"（方向一致且 |score| >= completeThreshold，默认 20）
 */
function deliveryComplete(amdDir, delivery, completeThreshold) {
    if (!deliveryMatches(amdDir, delivery)) {
        return false;
    }
    return Math.abs(delivery.score || 0) >= (completeThreshold !== undefined ? completeThreshold : 20);
}

function hasMajorConflict(conflicts) {
    return (conflicts || []).some(function (c) {
        return c && c.severity === 'MAJOR';
    });
}

/**
 * alignment 可能是字符串或 amdAlignment 对象
 */
function alignmentOf(alignment) {
    if (typeof alignment === 'string') {
        return alignment;
    }
    return alignment && alignment.alignment ? alignment.alignment : null;
}

/**
 * blocking conflict：bias LOW + MAJOR conflict + AMD OPPOSITE
 * 这是唯一直接 block 的组合；MODERATE/MINOR 不直接 block。
 */
function isBlocking(bias, conflicts, alignment) {
    return !!(
        bias &&
        bias.confidence === 'LOW' &&
        hasMajorConflict(conflicts) &&
        alignmentOf(alignment) === 'OPPOSITE'
    );
}

function runScenarioEngine(input, options) {
    var opts = options || {};
    var symbol = input.symbol || 'UNKNOWN';
    var evaluationTime = input.evaluationTime;
    var bias = input.bias || {};
    var draw = input.draw || null;
    var amd = input.amd || {};
    var alignment = alignmentOf(input.alignment);
    var conflicts = input.conflicts || [];
    var delivery =
        input.delivery ||
        (bias.components && bias.components.delivery) ||
        null;

    // 防未来数据：AMD 状态必须已确认（confirmedAt <= evaluationTime），
    // 否则视为未来状态，降级为"无方向"（不参与 WATCH/SETUP 判定）。
    var amdConfirmed = true;
    if (
        amd.confirmedAt !== undefined &&
        evaluationTime !== undefined &&
        amd.confirmedAt > evaluationTime
    ) {
        amdConfirmed = false;
    }
    var effectiveAmd = amdConfirmed ? amd : { direction: null, state: 'SEARCHING' };

    var biasDir = biasDirectionOf(bias);
    var amdDir = amdDirectionOf(effectiveAmd);
    var reasons = [];
    var block = false;
    var scenarioState;
    var bullish = isBullish(biasDir);
    var waitState = bullish ? 'BULLISH_WAIT' : 'BEARISH_WAIT';

    // ---- NEUTRAL ----
    if (biasDir === 'NEUTRAL') {
        if (bias.confidence === 'LOW' && hasMajorConflict(conflicts)) {
            scenarioState = 'CONFLICT';
            block = true;
            reasons.push('Bias neutral with low confidence and major conflict');
        } else {
            scenarioState = 'NEUTRAL';
            reasons.push('No directional HTF bias');
        }
        return buildOutput({
            symbol: symbol,
            evaluationTime: evaluationTime,
            scenarioState: scenarioState,
            direction: biasDir,
            block: block,
            reasons: reasons,
            bias: bias,
            draw: draw,
            amd: effectiveAmd,
            alignment: alignment,
            conflicts: conflicts,
            delivery: delivery
        }, opts);
    }

    // ---- directional bias ----
    var watchState = bullish ? 'BULLISH_WATCH' : 'BEARISH_WATCH';
    var setupState = bullish ? 'BULLISH_SETUP' : 'BEARISH_SETUP';

    // 1. blocking conflict（最高优先级）
    if (isBlocking(bias, conflicts, alignment)) {
        scenarioState = 'CONFLICT';
        block = true;
        reasons.push('Blocking conflict: LOW bias confidence + MAJOR conflict + AMD OPPOSITE');
        return buildOutput({
            symbol: symbol,
            evaluationTime: evaluationTime,
            scenarioState: scenarioState,
            direction: biasDir,
            block: block,
            reasons: reasons,
            bias: bias,
            draw: draw,
            amd: effectiveAmd,
            alignment: alignment,
            conflicts: conflicts,
            delivery: delivery
        }, opts);
    }

    // 2. Opposite AMD（AMD 有方向且与 bias 相反）
    if (amdDir && amdDir !== biasDir) {
        if (bias.confidence === 'LOW' && hasMajorConflict(conflicts)) {
            // 兜底：alignment 未明确 OPPOSITE 但实质相反
            scenarioState = 'CONFLICT';
            block = true;
            reasons.push('Opposite AMD with low bias confidence and major conflict');
        } else {
            scenarioState = waitState;
            reasons.push('LTF AMD opposes HTF bias; treat as possible retracement');
        }
        return buildOutput({
            symbol: symbol,
            evaluationTime: evaluationTime,
            scenarioState: scenarioState,
            direction: biasDir,
            block: block,
            reasons: reasons,
            bias: bias,
            draw: draw,
            amd: effectiveAmd,
            alignment: alignment,
            conflicts: conflicts,
            delivery: delivery
        }, opts);
    }

    // 3. AMD 方向匹配
    if (amdDir === biasDir && alignment === 'MATCH') {
        if (effectiveAmd.state === 'COMPLETE' && deliveryComplete(amdDir, delivery) && !hasMajorConflict(conflicts)) {
            scenarioState = setupState;
            reasons.push('Context setup ready: AMD COMPLETE + matching delivery, no major conflict');
        } else if (
            effectiveAmd.state === 'MANIPULATION_CONFIRMED' ||
            effectiveAmd.state === 'DISTRIBUTION_CONFIRMED'
        ) {
            scenarioState = watchState;
            reasons.push('Bias/Draw/AMD aligned; waiting for distribution confirmation');
        } else {
            scenarioState = waitState;
            reasons.push('AMD direction matches but not yet manipulation-confirmed');
        }
        return buildOutput({
            symbol: symbol,
            evaluationTime: evaluationTime,
            scenarioState: scenarioState,
            direction: biasDir,
            block: block,
            reasons: reasons,
            bias: bias,
            draw: draw,
            amd: effectiveAmd,
            alignment: alignment,
            conflicts: conflicts,
            delivery: delivery
        }, opts);
    }

    // 4. AMD 缺失 / 方向未知 / alignment 未确认
    scenarioState = waitState;
    reasons.push('Directional narrative present, key trigger (AMD confirmation) missing');
    return buildOutput({
        symbol: symbol,
        evaluationTime: evaluationTime,
        scenarioState: scenarioState,
        direction: biasDir,
        block: block,
        reasons: reasons,
        bias: bias,
        draw: draw,
        amd: effectiveAmd,
        alignment: alignment,
        conflicts: conflicts,
        delivery: delivery
    }, opts);
}

/**
 * 组装完整输出：actionEngine 门控 action + scorer + explanation + invalidation
 */
function buildOutput(parts, opts) {
    var actionResult = actionEngine.resolveAction(parts.scenarioState, parts, opts);
    var result = {
        symbol: parts.symbol,
        evaluationTime: parts.evaluationTime,
        scenarioState: parts.scenarioState,
        action: actionResult.action,
        setupReadyType: actionResult.setupReadyType,
        direction: parts.direction,
        block: parts.block,
        reasons: parts.reasons,
        inputs: {
            bias: parts.bias,
            draw: parts.draw,
            amd: parts.amd,
            alignment: parts.alignment,
            conflicts: parts.conflicts,
            delivery: parts.delivery
        }
    };
    result.quality = scenarioScorer.scoreScenario(result, opts);
    result.explanation = scenarioExplanation.buildExplanation(result, opts);
    result.invalidation = invalidationEngine.buildInvalidation(result, opts);
    return result;
}

module.exports = {
    runScenarioEngine: runScenarioEngine,
    biasDirectionOf: biasDirectionOf,
    drawMatches: drawMatches,
    deliveryMatches: deliveryMatches,
    deliveryComplete: deliveryComplete,
    hasMajorConflict: hasMajorConflict,
    alignmentOf: alignmentOf,
    isBlocking: isBlocking
};
