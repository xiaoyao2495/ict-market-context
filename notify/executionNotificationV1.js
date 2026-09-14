'use strict';

/**
 * TP anchor significance block (HISTORICAL_TURNING_POINT_SIGNIFICANCE_V1 §57).
 *
 * The TP universe is the only thing the semantic layer narrows on the execution
 * side. This block records WHICH anchor was actually selected and WHY it was
 * allowed into the universe. It is a read-only copy of an already-frozen
 * decision; Entry / SL / TP / RR values are never touched here.
 */
function tpAnchorLines(significance) {
    if (!significance) return ['TP Anchor: 无 Historical Anchor 语义记录（AUTO_FALLBACK / 未评估）'];
    return [
        'TP Anchor: ' + significance.price,
        '  Turning Significance: ' + (significance.significance || '-') + ' / ' + (significance.confidence || '-'),
        '  Turning Reason: ' + (significance.primaryReason || '-'),
        '  Turning Semantic Version: ' + (significance.semanticVersion || '-'),
        '  Turning Status: ' + (significance.eligible === true
            ? 'LLM_QUALIFIED_HISTORICAL_ANCHOR'
            : (significance.gateReason || significance.errorCode || 'NOT_ELIGIBLE'))
    ];
}

function eqAnchorCountLine(records) {
    if (!records || !records.length) return null;
    var eligible = records.filter(function (record) { return record && record.eligible === true; }).length;
    return 'EQ Historical Anchors: ' + eligible + ' / ' + records.length + ' LLM_QUALIFIED';
}

function build(event, keyword) {
    var lines = [(keyword || '检测') + ' REAL ORDER EXECUTION V1',
        'event=' + event.type, 'symbol=' + event.symbol];
    if (event.tradeId) lines.push('tradeId=' + event.tradeId);
    if (event.reasonCode) lines.push('reason=' + event.reasonCode);
    if (event.critical) lines.push('severity=CRITICAL');
    if (event.detail) lines.push('detail=' + event.detail);
    if (event.entryPrice !== undefined && event.entryPrice !== null) lines.push('Entry: ' + event.entryPrice);
    if (event.stopPrice !== undefined && event.stopPrice !== null) lines.push('SL: ' + event.stopPrice);
    if (event.targetPrice !== undefined && event.targetPrice !== null) lines.push('TP: ' + event.targetPrice);
    if (event.initialRR !== undefined && event.initialRR !== null) lines.push('RR: ' + event.initialRR);
    if (event.tpAnchorSignificance !== undefined) lines = lines.concat(tpAnchorLines(event.tpAnchorSignificance));
    var eqLine = eqAnchorCountLine(event.eqHistoricalAnchorSignificance);
    if (eqLine) lines.push(eqLine);
    return lines.join('\n');
}
module.exports = { build: build, tpAnchorLines: tpAnchorLines, eqAnchorCountLine: eqAnchorCountLine };
