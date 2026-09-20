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

function shouldNotifyExecutionEvent(event) {
    return !!event && event.shadow !== true &&
        (event.type === 'BREAKOUT_ENTRY_SUBMITTED' || event.type === 'POSITION_CLOSED');
}

function value(v) { return v === undefined || v === null || v === '' ? 'UNKNOWN' : String(v); }
function bool(v) { return v === true ? 'true' : v === false ? 'false' : 'UNKNOWN'; }
function closedLines(summary) {
    var s = summary || {};
    var setup = s.setup || {};
    var entry = s.entry || {};
    var protection = s.protection || {};
    var exit = s.exit || {};
    var result = s.result || {};
    var audit = s.executionAudit || {};
    return [
        'direction=' + value(s.direction), 'tradeId=' + value(s.tradeId),
        'setupId=' + value(s.setupId), 'eqId=' + value(s.eqId),
        '', '[SETUP]', 'submittedAt=' + value(setup.submittedAt),
        'plannedEntry=' + value(setup.plannedEntry), 'initialSL=' + value(setup.initialSL),
        'initialTP=' + value(setup.initialTP), 'initialRR=' + value(setup.initialRR),
        '', '[ENTRY]', 'filled=' + bool(entry.filled), 'fillPrice=' + value(entry.fillPrice),
        'filledAt=' + value(entry.filledAt), 'qty=' + value(entry.qty), 'notional=' + value(entry.notional),
        '', '[PROTECTION]', 'slPlaced=' + bool(protection.slPlaced),
        'tpPlaced=' + bool(protection.tpPlaced),
        'protectionEventuallyVerified=' + bool(protection.protectionEventuallyVerified),
        'protectionVerifyFailureCount=' + value(protection.protectionVerifyFailureCount),
        'temporaryExecutionHaltSeen=' + bool(protection.temporaryExecutionHaltSeen),
        'temporaryExecutionHaltCleared=' + bool(protection.temporaryExecutionHaltCleared),
        '', '[EXIT]', 'exitReason=' + value(exit.exitReason), 'exitPrice=' + value(exit.exitPrice),
        'closedAt=' + value(exit.closedAt), 'holdingSeconds=' + value(exit.holdingSeconds),
        '', '[RESULT]', 'grossPnl=' + value(result.grossPnl), 'fees=' + value(result.fees),
        'netPnl=' + value(result.netPnl), 'realizedR=' + value(result.realizedR),
        '', '[EXECUTION_AUDIT]', 'duplicateOrderDetected=' + bool(audit.duplicateOrderDetected),
        'orphanProtectionDetected=' + bool(audit.orphanProtectionDetected),
        'unresolvedProtection=' + bool(audit.unresolvedProtection),
        'executionAnomaly=' + bool(audit.executionAnomaly)
    ];
}

function build(event, keyword) {
    var lines = [(keyword || '检测') + ' REAL ORDER EXECUTION V1',
        'event=' + event.type, 'symbol=' + event.symbol];
    if (event.type === 'POSITION_CLOSED') return lines.concat(closedLines(event.summary)).join('\n');
    if (event.type === 'BREAKOUT_ENTRY_SUBMITTED') {
        lines.push('direction=' + value(event.direction), 'tradeId=' + value(event.tradeId),
            'setupId=' + value(event.setupId), 'eqId=' + value(event.eqId),
            'entry=' + value(event.entryTrigger), 'initialSL=' + value(event.initialSL),
            'initialTP=' + value(event.initialTP), 'initialRR=' + value(event.initialRR),
            'qty=' + value(event.qty), 'notional=' + value(event.notional),
            'submittedAt=' + value(event.submittedAt));
        return lines.join('\n');
    }
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
module.exports = { build: build, tpAnchorLines: tpAnchorLines, eqAnchorCountLine: eqAnchorCountLine,
    shouldNotifyExecutionEvent: shouldNotifyExecutionEvent, closedLines: closedLines };
