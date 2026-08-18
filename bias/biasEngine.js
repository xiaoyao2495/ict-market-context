/**
 * Bias Engine —— 五分量合成
 *
 * 输入统一 Market Context：
 * {
 *   symbol,
 *   evaluationTime,
 *   timeframe,        // delivery 事件链的周期基准（默认 5m）
 *   draw,             // drawEngine 输出
 *   structures,       // { '1d': classifyStructure, '4h': ..., '1h': ... }
 *   location,         // classifyLocation 输出 { zone, ratio, intensity }
 *   events: { sweeps, mss, displacements }
 * }
 *
 * 流水线：
 *   liquidityBias → structureBias → locationBias → deliveryBias
 *     → conflictDetector → biasScorer → confidence → explanation
 *
 * 输出：
 * {
 *   symbol, evaluationTime, direction, score, confidence,
 *   components: { liquidity, structure, location, delivery },
 *   conflicts, evidenceCoverage, explanation
 * }
 *
 * 原则：
 * - Bias Score 不是 probability
 * - Conflict 不修改 raw direction score（只影响 confidence）
 * - 所有事件 confirmedAt <= evaluationTime（防未来数据）
 * - 每个组件返回 available（真正无数据才 unavailable；BALANCED draw 仍 available）
 */
var liquidityBias = require('./liquidityBias');
var structureBias = require('./structureBias');
var locationBias = require('./locationBias');
var deliveryBias = require('./deliveryBias');
var conflictDetector = require('./conflictDetector');
var biasScorer = require('./biasScorer');
var biasExplanation = require('./biasExplanation');
var thresholds = require('../config/thresholds');

var CONFIDENCE_ORDER = ['LOW', 'MEDIUM', 'HIGH'];

/**
 * 计算 confidence（导出便于测试）
 * 基础：abs(score) < lowThreshold → LOW / < highThreshold → MEDIUM / else HIGH
 * 每个 MAJOR conflict 降 majorConflictDowngrade 级
 * coverage < coverageForcedLow → 强制 LOW；< coverageMaxMedium → 最大 MEDIUM
 */
function computeConfidence(score, conflicts, coverage, options) {
    var cfg = (options && options.thresholds) || thresholds;
    var c = cfg.bias.confidence;
    var abs = Math.abs(score);
    var level;
    if (abs < c.lowThreshold) {
        level = 0; // LOW
    } else if (abs < c.highThreshold) {
        level = 1; // MEDIUM
    } else {
        level = 2; // HIGH
    }

    // MAJOR conflicts 降级
    var major = 0;
    (conflicts || []).forEach(function (cf) {
        if (cf.severity === 'MAJOR') {
            major++;
        }
    });
    level -= major * c.majorConflictDowngrade;

    // evidence coverage
    if (coverage < c.coverageForcedLow) {
        level = Math.min(level, 0);
    } else if (coverage < c.coverageMaxMedium) {
        level = Math.min(level, 1);
    }

    level = Math.max(0, Math.min(2, level));
    return CONFIDENCE_ORDER[level];
}

/**
 * 组件是否 really 有数据
 */
function structureAvailable(structureResult) {
    var b = structureResult && structureResult.breakdown;
    if (!b) {
        return false;
    }
    var any = false;
    Object.keys(b).forEach(function (tf) {
        if (b[tf].structure && b[tf].structure !== 'MISSING') {
            any = true;
        }
    });
    return any;
}

/**
 * 运行 Bias Engine
 */
function runBiasEngine(context, options) {
    var opts = options || {};
    var symbol = context.symbol;
    var evaluationTime = context.evaluationTime;
    var timeframe = context.timeframe || '5m';
    var cfg = opts.thresholds || thresholds;

    // ---- 组件 ----
    var liquidity = liquidityBias.scoreLiquidityBias(context.draw, opts);
    liquidity.available = !(context.draw && context.draw.explanation);
    liquidity.direction = biasScorer.componentDirection(liquidity.score);

    var structure = structureBias.scoreStructureBias(context.structures, opts);
    structure.available = structureAvailable(structure);
    structure.direction = biasScorer.componentDirection(structure.score);

    var loc = context.location;
    var location = locationBias.scoreLocationBias(
        {
            drawDirection: context.draw ? context.draw.direction : 'BALANCED',
            location: loc
        },
        opts
    );
    location.available = !!(loc && loc.zone && loc.zone !== 'UNKNOWN');
    location.direction = biasScorer.componentDirection(location.score);

    var delivery = deliveryBias.scoreDeliveryBias(
        {
            evaluationTime: evaluationTime,
            timeframe: timeframe,
            events: context.events || {}
        },
        opts
    );
    // 统一组件 direction 格式：BULLISH / BEARISH / NEUTRAL
    delivery.direction =
        delivery.direction === 'BULLISH' || delivery.direction === 'BEARISH'
            ? delivery.direction
            : 'NEUTRAL';

    var components = {
        liquidity: liquidity,
        structure: structure,
        location: location,
        delivery: delivery
    };

    // ---- conflicts ----
    var conflicts = conflictDetector.detectConflicts(components, opts);

    // ---- bias score ----
    var bias = biasScorer.scoreBias(components, opts);

    // ---- evidence coverage ----
    var availableCount = 0;
    Object.keys(components).forEach(function (name) {
        if (components[name].available) {
            availableCount++;
        }
    });
    var total = 4;
    var ratio = availableCount / total;

    // ---- confidence ----
    var confidence = computeConfidence(bias.score, conflicts, ratio, opts);

    // ---- explanation ----
    var explanation = biasExplanation.buildExplanation({
        components: components,
        conflicts: conflicts
    });

    return {
        symbol: symbol,
        evaluationTime: evaluationTime,
        direction: bias.direction,
        score: bias.score,
        confidence: confidence,
        components: {
            liquidity: liquidity,
            structure: structure,
            location: location,
            delivery: delivery
        },
        conflicts: conflicts,
        evidenceCoverage: {
            available: availableCount,
            total: total,
            ratio: ratio
        },
        explanation: explanation
    };
}

module.exports = {
    runBiasEngine: runBiasEngine,
    computeConfidence: computeConfidence
};
