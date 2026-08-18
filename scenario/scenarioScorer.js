/**
 * Scenario Scorer（Phase 8）
 *
 * 自定义工程评分（0-100），不是 probability。
 * Score 只表示 scenario quality，不驱动 Action —— Action 必须满足显式状态条件。
 *
 * 分项（权重）：
 *   Bias quality      30   HIGH=30 / MEDIUM=22 / LOW=12
 *   Draw alignment    20   matching strong=20 / lean=12 / balanced=5 / opposite=0
 *   AMD phase quality 30   COMPLETE=30 / DISTRIBUTION=26 / MANIPULATION=20 /
 *                          ACCUMULATION=12 / CANDIDATE=5 / OPPOSITE=0
 *   Delivery alignment 15  matching complete=15 / partial=8 / neutral=3 / opposite=0
 *   Conflict penalty   5   无 MAJOR=5 / 有 MAJOR=0
 *
 * Quality buckets：0-39 LOW / 40-69 MEDIUM / 70-100 HIGH
 */
var thresholds = require('../config/thresholds');

/**
 * @param {Object} result scenarioEngine 输出（含 inputs: { bias, draw, amd, alignment, conflicts, delivery }）
 * @param {Object} [options] { thresholds }
 * @returns {Object} {
 *   total, quality, breakdown: { bias, draw, amd, delivery, conflict }
 * }
 */
function scoreScenario(result, options) {
    var opts = options || {};
    var cfg = (opts.thresholds || thresholds).scenario;
    var sw = cfg.score;
    var inputs = result.inputs || {};
    var bias = inputs.bias || {};
    var draw = inputs.draw || null;
    var amd = inputs.amd || {};
    var conflicts = inputs.conflicts || [];
    var delivery = inputs.delivery || null;
    var direction = result.direction;

    // ---- bias quality ----
    var biasScore = sw.bias.low;
    if (bias.confidence === 'HIGH') {
        biasScore = sw.bias.high;
    } else if (bias.confidence === 'MEDIUM') {
        biasScore = sw.bias.medium;
    }

    // ---- draw alignment ----
    var drawScore = 0;
    if (draw && draw.direction) {
        var dd = draw.direction;
        var ddBullish = dd === 'BSL' || dd === 'LEAN_BSL';
        var ddBearish = dd === 'SSL' || dd === 'LEAN_SSL';
        var directionBullish = direction === 'BULLISH';
        var directionBearish = direction === 'BEARISH';
        if ((directionBullish && ddBullish) || (directionBearish && ddBearish)) {
            // 同方向：strong（BSL/SSL）20，lean 12
            drawScore =
                dd === 'BSL' || dd === 'SSL'
                    ? sw.draw.matchingStrong
                    : sw.draw.matchingLean;
        } else if ((directionBullish && ddBearish) || (directionBearish && ddBullish)) {
            drawScore = sw.draw.opposite;
        } else if (dd === 'BALANCED') {
            drawScore = sw.draw.balanced;
        }
    } else if (draw && draw.direction === 'BALANCED') {
        drawScore = sw.draw.balanced;
    }

    // ---- AMD phase quality ----
    var amdScore = 0;
    if (amd.direction) {
        if (amd.direction === direction) {
            var st = amd.state || 'SEARCHING';
            if (st === 'COMPLETE') {
                amdScore = sw.amd.completeMatch;
            } else if (st === 'DISTRIBUTION_CONFIRMED') {
                amdScore = sw.amd.distributionConfirmed;
            } else if (st === 'MANIPULATION_CONFIRMED') {
                amdScore = sw.amd.manipulationConfirmed;
            } else if (st === 'ACCUMULATION_CONFIRMED') {
                amdScore = sw.amd.accumulationConfirmed;
            } else {
                amdScore = sw.amd.candidate; // CANDIDATE / SEARCHING
            }
        } else {
            amdScore = sw.amd.opposite; // AMD 方向相反 → 0
        }
    }

    // ---- delivery alignment ----
    var deliveryScore = 0;
    if (delivery && delivery.available && delivery.direction) {
        if (delivery.direction === direction) {
            deliveryScore =
                Math.abs(delivery.score || 0) >= 20
                    ? sw.delivery.matchingComplete
                    : sw.delivery.matchingPartial;
        } else if (delivery.direction === 'NEUTRAL') {
            deliveryScore = sw.delivery.neutral;
        } else {
            deliveryScore = sw.delivery.opposite;
        }
    } else {
        deliveryScore = sw.delivery.neutral; // 无 delivery 数据 → neutral
    }

    // ---- conflict penalty ----
    var hasMajor = (conflicts || []).some(function (c) {
        return c && c.severity === 'MAJOR';
    });
    var conflictScore = hasMajor ? sw.conflict.hasMajor : sw.conflict.noMajor;

    var total = Math.max(
        0,
        Math.min(100, biasScore + drawScore + amdScore + deliveryScore + conflictScore)
    );
    var quality =
        total < cfg.quality.lowMax ? 'LOW' : total < cfg.quality.mediumMax ? 'MEDIUM' : 'HIGH';

    return {
        total: total,
        quality: quality,
        breakdown: {
            bias: biasScore,
            draw: drawScore,
            amd: amdScore,
            delivery: deliveryScore,
            conflict: conflictScore
        }
    };
}

module.exports = {
    scoreScenario: scoreScenario
};
