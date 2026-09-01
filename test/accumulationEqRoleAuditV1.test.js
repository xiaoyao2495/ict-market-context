'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var audit = require('../audit/accumulationEqRoleAuditV1');

var passed = 0, failed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log('PASS  ' + name); }
    catch (error) { failed++; console.log('FAIL  ' + name + ' -> ' + error.stack); }
}

function frozenGroundTruth() {
    var rows = [];
    for (var i = 1; i <= 60; i++) {
        rows.push({ caseId: 'case' + String(i).padStart(3, '0'),
            humanLabel: i <= 32 ? 'CLEAR_A' : i <= 44 ? 'BORDERLINE_A' : 'NO_A',
            groundTruthFrozen: true, groundTruthStatus: 'APPROVED_V1' });
    }
    return rows;
}

function sampleCase(id, label, scoreWithout, eqs) {
    var gt = { caseId: id, humanLabel: label, featureSnapshot: {
        scoreWithEQ: scoreWithout + (eqs.length ? 8 : 0), scoreWithoutEQ: scoreWithout,
        eqContribution: eqs.length ? 8 : 0
    } };
    var sample = { row: { formationStartAt: 1000, confirmedAt: 10000, startIndex: 1, endIndex: 10,
        rangeHighAtConfirmation: 110, rangeLowAtConfirmation: 90, rangeMidAtConfirmation: 100 } };
    return audit.buildCase(gt, sample, eqs, 60);
}

function eq(id, type, confirmedAt, memberAddedAt) {
    return { id: id, type: type, price: type === 'EQH' ? 108 : 92, confirmedAt: confirmedAt,
        metadata: { members: [{ id: id + ':M1', type: type === 'EQH' ? 'SWING_HIGH' : 'SWING_LOW',
            price: type === 'EQH' ? 108 : 92, occurredAt: 2000, confirmedAt: 3000, memberAddedAt: memberAddedAt }] } };
}

test('Ground Truth remains exact 32/12/16', function () {
    assert.deepStrictEqual(audit.assertGroundTruth(frozenGroundTruth()), { CLEAR_A: 32, BORDERLINE_A: 12, NO_A: 16 });
});

test('EQ dependency uses frozen threshold definition', function () {
    var dependent = sampleCase('case001', 'CLEAR_A', 55, [eq('E1', 'EQH', 9000, 9000)]);
    var independent = sampleCase('case002', 'CLEAR_A', 63, [eq('E2', 'EQL', 9000, 9000)]);
    assert.strictEqual(dependent.eqDependentConfirmation, true);
    assert.strictEqual(independent.eqDependentConfirmation, false);
});

test('counterfactual is deterministic and cohort-separated', function () {
    var rows = [sampleCase('case001', 'CLEAR_A', 55, [eq('E1', 'EQH', 9000, 9000)]),
        sampleCase('case033', 'BORDERLINE_A', 59, [eq('E2', 'EQL', 9000, 9000)]),
        sampleCase('case045', 'NO_A', 52, [eq('E3', 'EQH', 9000, 9000)])];
    assert.deepStrictEqual(audit.counterfactualSummary(rows), audit.counterfactualSummary(rows));
    assert.strictEqual(audit.counterfactualSummary(rows).CLEAR_A_LOST_WITHOUT_EQ.count, 1);
    assert.strictEqual(audit.counterfactualSummary(rows).NO_A_REMOVED_WITHOUT_EQ.count, 1);
});

test('EQ timing uses fixed thirds and rejects future visibility', function () {
    assert.strictEqual(audit.timingBucket(2000, 1000, 10000), 'EARLY');
    assert.strictEqual(audit.timingBucket(5500, 1000, 10000), 'MIDDLE');
    assert.strictEqual(audit.timingBucket(9000, 1000, 10000), 'LATE');
    assert.strictEqual(audit.timingBucket(11000, 1000, 10000), 'FUTURE_AFTER_A_CONFIRMATION');
});

test('future EQ use is counted as a violation', function () {
    var row = sampleCase('case001', 'CLEAR_A', 55, [eq('FUTURE', 'EQH', 11000, 11000)]);
    assert.strictEqual(audit.timingSummary([row]).FUTURE_EQ_USED_FOR_A_CONFIRMATION, 1);
});

test('member projection is as-of memberAddedAt safe', function () {
    var object = eq('E1', 'EQH', 5000, 12000);
    assert.strictEqual(audit.visibleMembers(object, 10000).length, 0);
    assert.strictEqual(audit.visibleMembers(object, 12000).length, 1);
});

test('no label mutation', function () {
    var gt = frozenGroundTruth(), before = JSON.stringify(gt);
    audit.assertGroundTruth(gt);
    assert.strictEqual(JSON.stringify(gt), before);
});

test('no production or baseline source mutation', function () {
    var root = path.join(__dirname, '..');
    var files = ['amd/accumulationDetector.js', 'config/thresholds.js', 'events/displacementDetector.js',
        'liquidity/equalLiquidity.js', 'live/liveEngine.js'];
    function hashes() { return files.map(function (file) {
        return crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
    }); }
    var before = hashes();
    audit.roleEvaluation({}, {}, {}, {});
    assert.deepStrictEqual(hashes(), before);
});

test('research module contains no weight search, gate, or score implementation', function () {
    var source = fs.readFileSync(path.join(__dirname, '..', 'audit', 'accumulationEqRoleAuditV1.js'), 'utf8');
    assert.ok(!/grid.?search|weight.?sweep|optimal.?weight|machine.?learning|random.?forest/i.test(source));
    assert.ok(!/NEW_EQ_GATE|ACCUMULATION_V2_SCORE|productionThreshold/.test(source));
});

console.log('\nAccumulation EQ Role Audit V1: ' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
