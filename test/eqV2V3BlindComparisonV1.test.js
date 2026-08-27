'use strict';

var assert = require('assert');
var comparison = require('../audit/eqV2V3BlindComparisonV1');

var passed = 0;
function test(name, fn) { fn(); passed++; console.log('PASS ' + passed + ' ' + name); }
function swing(id, confirmedAt) {
    return { id: id, symbol: 'BTCUSDT', timeframe: '5m', type: 'SWING_HIGH', side: 'BSL',
        price: 100, sourceOpenTime: confirmedAt - 900000, sourceCloseTime: confirmedAt - 600001,
        confirmedAt: confirmedAt, status: 'ACTIVE', metadata: { index: 1, right: 2 } };
}

test('same underlying Swing population has the same immutable hash', function () {
    var rows = [swing('A', 10), swing('B', 20)];
    var cloned = rows.map(function (row) { return Object.assign({}, row, { status: 'BROKEN' }); });
    assert.strictEqual(comparison.immutableSwingHash(rows), comparison.immutableSwingHash(cloned));
});
test('case selection helper is deterministic', function () {
    var rows = [1, 2, 3, 4, 5, 6];
    assert.deepStrictEqual(comparison.evenlyPick(rows, 3), comparison.evenlyPick(rows, 3));
});
test('A/B mapping is balanced', function () {
    var ids = Array.from({ length: 40 }, function (_, i) { return 'case' + String(i + 1).padStart(3, '0'); });
    var map = comparison.balancedAssignments(ids);
    assert.strictEqual(ids.filter(function (id) { return map[id].A === 'V2'; }).length, 20);
    assert.strictEqual(ids.filter(function (id) { return map[id].A === 'V3'; }).length, 20);
});
test('identity mapping can be checked as one public ID per case target', function () {
    var ids = ['EQV3:A:B', 'EQV3:A:C'];
    assert.strictEqual(new Set(ids).size, ids.length);
});
test('future cutoff check rejects a member confirmed after evaluationTime', function () {
    var evaluationTime = 100;
    var objects = [{ members: [{ confirmedAt: 100 }, { confirmedAt: 101 }] }];
    var violations = objects.reduce(function (count, object) {
        return count + object.members.filter(function (member) {
            return member.confirmedAt > evaluationTime;
        }).length;
    }, 0);
    assert.strictEqual(violations, 1);
});
test('comparison metadata contains no outcome fields', function () {
    assert.deepStrictEqual(comparison.noOutcomeFields({ modelAObjects: [], note: 'formation only' }), []);
    assert.strictEqual(comparison.noOutcomeFields({ sweepResult: true }).length, 1);
});
test('model-key reveal converts blind labels correctly', function () {
    var labels = [
        { caseId: 'case001', label: 'MODEL_A_BETTER' },
        { caseId: 'case002', label: 'MODEL_B_BETTER' },
        { caseId: 'case003', label: 'EQUAL' }
    ];
    var key = { case001: { A: 'V2', B: 'V3' }, case002: { A: 'V2', B: 'V3' },
        case003: { A: 'V3', B: 'V2' } };
    assert.deepStrictEqual(comparison.revealLabels(labels, key), {
        V2_BETTER: 1, V3_BETTER: 1, EQUAL: 1, BOTH_BAD: 0, UNCERTAIN: 0
    });
});
test('same review set produces the same hash', function () {
    var rows = [{ caseId: 'case001', side: 'EQH', evaluationTime: 10,
        windowStart: 0, windowEnd: 10, modelAObjects: [], modelBObjects: [], underlyingSwingIds: ['A'] }];
    assert.strictEqual(comparison.reviewSetHash(rows), comparison.reviewSetHash(JSON.parse(JSON.stringify(rows))));
});

console.log('EQH/EQL V2 vs V3 Blind-ish Human Comparison V1 tests passed (' + passed + '/8)');
