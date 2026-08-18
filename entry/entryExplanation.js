/**
 * Entry Explanation（Phase 9.2）
 *
 * Reporter 不重新推理 —— Engine 判断，Reporter 展示。
 * 输出：
 *   confirmations 已满足的入场前置条件
 *   waiting       还等什么
 *   invalidation  失效条件
 *   fvg           primary FVG 详情（zone/midpoint/score）
 */
var entryInvalidation = require('./entryInvalidation');

/**
 * @param {Object} gateResult entryGate 输出
 * @param {Object} input 与 runEntryGate 相同的输入
 * @param {Object} [options]
 * @returns {Object} { confirmations, waiting, invalidation, fvg }
 */
function buildEntryExplanation(gateResult, input, options) {
    var state = gateResult.state;
    var scenario = input.scenario || {};
    var amd = input.amd || {};
    var alignment = input.alignment || null;
    var direction = scenario.direction;

    var confirmations = [];
    var waiting = [];
    var fvg = [];

    // ---- confirmations ----
    if (state === 'WAITING_FVG' || state === 'WAITING_RETRACE' || state === 'ENTRY_READY') {
        confirmations.push('Action = WATCH');
        if (scenario.scenarioState) {
            confirmations.push('Scenario ' + scenario.scenarioState);
        }
        if (amd.direction) {
            confirmations.push('AMD direction ' + amd.direction + ' (state ' + (amd.state || 'SEARCHING') + ')');
        }
        if (alignment === 'MATCH') {
            confirmations.push('Alignment MATCH');
        }
    }
    if (state === 'WAITING_RETRACE' || state === 'ENTRY_READY') {
        confirmations.push('Valid FVG found (direction + displacement + score)');
    }
    if (state === 'ENTRY_READY') {
        confirmations.push('Price retraced into FVG zone');
    }

    // ---- waiting ----
    if (state === 'WAITING_FVG') {
        waiting.push('Matching valid FVG (direction + displacement + score >= threshold)');
    }
    if (state === 'WAITING_RETRACE') {
        waiting.push('Price retrace into FVG zone');
    }
    if (state === 'CLOSED') {
        waiting.push('Action must be WATCH for Entry Gate to open');
    }
    if (state === 'INVALIDATED') {
        waiting.push('Context must re-establish (new matching scenario + valid FVG)');
    }

    // ---- fvg ----
    if (gateResult.fvg) {
        var f = gateResult.fvg;
        fvg.push({
            direction: f.direction,
            zoneLow: f.zoneLow,
            zoneHigh: f.zoneHigh,
            midpoint: f.midpoint,
            status: f.status,
            score: f._score !== undefined ? f._score : null,
            displacementEventId: f.displacementEventId,
            gapAtr: f.gapAtr,
            gapPct: f.gapPct
        });
    }

    return {
        confirmations: confirmations,
        waiting: waiting,
        invalidation: entryInvalidation.buildEntryInvalidation(gateResult, input, options),
        fvg: fvg
    };
}

module.exports = {
    buildEntryExplanation: buildEntryExplanation
};
