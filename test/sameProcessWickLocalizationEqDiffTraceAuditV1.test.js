'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var path = require('path');
var auditModule = require('../research/same-process-wick-localization-v1/eqDiffTraceAuditV1');

var ROOT = path.join(__dirname, '..');
var OUT = path.join(ROOT, 'research-output', 'same-process-wick-localization-v1', 'eq-diff-trace-audit-v1');
var EXPECTED = {
    RAYSOLUSDT: { oldEq: 43, newEq: 46, exactSame: 13, partnerChanged: 21, added: 12, removed: 9 },
    BTCUSDT: { oldEq: 29, newEq: 22, exactSame: 5, partnerChanged: 8, added: 9, removed: 16 },
    ETHUSDT: { oldEq: 27, newEq: 29, exactSame: 13, partnerChanged: 8, added: 8, removed: 6 },
    DOGEUSDT: { oldEq: 40, newEq: 44, exactSame: 18, partnerChanged: 8, added: 18, removed: 14 },
    LSKUSDT: { oldEq: 73, newEq: 71, exactSame: 39, partnerChanged: 23, added: 9, removed: 11 }
};
var audit = auditModule.buildAudit();

function view(overrides) {
    return Object.assign({ processId: 'P', passesTolerance: true, within36h: true,
        activeStatusAtEvaluation: 'ACTIVE', strictCrossAtCurrentPivot: false,
        presentInSurvivalRegistry: true, matches: true }, overrides || {});
}

test('01 diff classification is deterministic', function () {
    assert.equal(auditModule.hash(auditModule.buildAudit()), auditModule.hash(audit));
});

test('02 count reconciliation exactly reproduces frozen OLD/NEW totals', function () {
    Object.keys(EXPECTED).forEach(function (symbol) {
        Object.keys(EXPECTED[symbol]).forEach(function (key) {
            assert.equal(audit.symbols[symbol][key], EXPECTED[symbol][key], symbol + ' ' + key);
        });
        assert.equal(audit.symbols[symbol].oldEq,
            audit.symbols[symbol].exactSame + audit.symbols[symbol].partnerChanged + audit.symbols[symbol].removed);
        assert.equal(audit.symbols[symbol].newEq,
            audit.symbols[symbol].exactSame + audit.symbols[symbol].partnerChanged + audit.symbols[symbol].added);
    });
});

test('03 every compared decision uses the same current point and evaluation time', function () {
    Object.values(audit.hiddenLogicChecks).forEach(function (checks) {
        assert.equal(checks.currentPoint, true);
        assert.equal(checks.currentPointConfirmedAt, true);
        assert.equal(checks.evaluationTime, true);
    });
});

test('04 same-process reanchor and different-process switch are detected separately', function () {
    var changed = audit.ledger.filter(function (row) { return row.classification === 'HISTORICAL_PARTNER_CHANGED_ONLY'; });
    assert.equal(changed.filter(function (row) { return row.subtype === 'SAME_PROCESS_REANCHORED'; }).length, 52);
    assert.equal(changed.filter(function (row) { return row.subtype === 'PAIRING_SWITCHED_TO_DIFFERENT_PROCESS'; }).length, 16);
});

test('05 tolerance enter mechanism is deterministic', function () {
    assert.deepEqual(auditModule.transitionMechanisms(view({ passesTolerance: false, matches: false }), view()),
        ['ANCHOR_PRICE_ENTERED_EQ_TOLERANCE']);
});

test('06 tolerance leave mechanism is deterministic', function () {
    assert.deepEqual(auditModule.transitionMechanisms(view(), view({ passesTolerance: false, matches: false })),
        ['ANCHOR_PRICE_LEFT_EQ_TOLERANCE']);
});

test('07 36h enter mechanism is deterministic', function () {
    assert.deepEqual(auditModule.transitionMechanisms(view({ within36h: false, matches: false }), view()),
        ['ANCHOR_OCCURRENCE_ENTERED_36H_WINDOW']);
});

test('08 36h leave mechanism is deterministic', function () {
    assert.deepEqual(auditModule.transitionMechanisms(view(), view({ within36h: false, matches: false })),
        ['ANCHOR_OCCURRENCE_LEFT_36H_WINDOW']);
});

test('09 ACTIVE/INACTIVE differences are mechanically named', function () {
    assert.deepEqual(auditModule.transitionMechanisms(view(), view({ activeStatusAtEvaluation: 'INACTIVE', matches: false })),
        ['ACTIVE_STATUS_CHANGED_DUE_TO_NEW_CANONICAL_PRICE']);
});

test('10 every observed ACTIVE difference has strict-cross evidence', function () {
    audit.ledger.filter(function (row) {
        return row.causalMechanisms.indexOf('ACTIVE_STATUS_CHANGED_DUE_TO_NEW_CANONICAL_PRICE') >= 0;
    }).forEach(function (row) {
        assert.equal(row.anchorDeltas.some(function (delta) {
            return delta.statusTransitionEvidence &&
                (delta.statusTransitionEvidence.oldLaneTransition || delta.statusTransitionEvidence.newLaneTransition);
        }), true, row.identity);
    });
});

test('11 process, theta and raw FVG hidden invariants all hold', function () {
    Object.values(audit.hiddenLogicChecks).forEach(function (checks) {
        Object.keys(checks).forEach(function (key) { assert.equal(checks[key], true, key); });
    });
});

test('12 ATR14 and EQ tolerance are unchanged at every decision', function () {
    Object.values(audit.hiddenLogicChecks).forEach(function (checks) {
        assert.equal(checks.atr14, true);
        assert.equal(checks.eqTolerance, true);
    });
});

test('13 no unexplained reason is allowed', function () {
    assert.equal(audit.totalDiffCases, 180);
    assert.equal(audit.explainedCases, 180);
    assert.equal(audit.unexplainedCases, 0);
    assert.equal(audit.ledger.some(function (row) { return row.changeReason === 'UNEXPLAINED_DIFFERENCE'; }), false);
});

test('14 no empirical 36h boundary transition was fabricated', function () {
    assert.equal(audit.ledger.some(function (row) {
        return row.causalMechanisms.some(function (mechanism) { return mechanism.indexOf('36H_WINDOW') >= 0; });
    }), false);
});

test('15 BTC fixed process has factual downstream EQ effect', function () {
    assert.equal(audit.specialTraces.btc.found, true);
    assert.equal(audit.specialTraces.btc.anchorTimeDeltaBars, -7);
    assert.equal(audit.specialTraces.btc.oldEqPartnerMatches.length, 2);
    assert.equal(audit.specialTraces.btc.newEqPartnerMatches.length, 0);
});

test('16 ETH fixed process shifts 89 bars but has no downstream EQ effect', function () {
    assert.equal(audit.specialTraces.eth.found, true);
    assert.equal(audit.specialTraces.eth.anchorTimeDeltaBars, -89);
    assert.equal(audit.specialTraces.eth.oldEqPartnerMatches.length, 0);
    assert.equal(audit.specialTraces.eth.newEqPartnerMatches.length, 0);
    assert.equal(audit.specialTraces.eth.oldStatusTransitions.length, 0);
    assert.equal(audit.specialTraces.eth.newStatusTransitions.length, 0);
});

test('17 required audit artifacts exist', function () {
    ['eq-diff-ledger.json', 'eq-diff-ledger.csv', 'reason-summary.json', 'symbol-summary.json',
        'sample-added.md', 'sample-removed.md', 'sample-partner-changed.md',
        'BTC-79466-to-79125-trace.md', 'ETH-89-bar-shift-trace.md', 'AUDIT_REPORT.md'].forEach(function (name) {
        assert.equal(fs.existsSync(path.join(OUT, name)), true, name);
    });
});
