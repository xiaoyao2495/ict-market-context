'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var eq = require('../audit/eqPersistentClusterShadowV3');
var retirement = require('../audit/eqStructuralRetirementShadowV1');

var passed = 0;
function test(name, fn) {
    fn();
    passed++;
    console.log('PASS ' + passed + ' ' + name);
}
function swing(id, confirmedAt, sourceOpenTime, price) {
    return { id: id, confirmedAt: confirmedAt, sourceOpenTime: sourceOpenTime,
        price: price, type: 'SWING_HIGH', metadata: { index: sourceOpenTime / 300000, right: 2 } };
}
function formationKey(cluster) {
    return cluster.type + '|' + cluster.members.slice(0, 2).map(function (row) { return row.id; }).join('|');
}
function semanticPopulation(result, start, end) {
    return result.clusters.filter(function (cluster) {
        return cluster.confirmedAt >= start && cluster.confirmedAt <= end;
    }).map(function (cluster) {
        return { formationKey: formationKey(cluster), type: cluster.type,
            memberIds: cluster.members.map(function (member) { return member.id; }) };
    }).sort(function (a, b) { return a.formationKey.localeCompare(b.formationKey); });
}

var a = swing('SWING:A', 100, 10, 100);
var b = swing('SWING:B', 200, 20, 101);
var c = swing('SWING:C', 300, 30, 102);

test('two distinct formations at the same price have different IDs', function () {
    assert.notStrictEqual(eq.clusterIdV3('BTCUSDT', '5m', 'EQH', a, b),
        eq.clusterIdV3('BTCUSDT', '5m', 'EQH', a, c));
});
test('same first-swing price with different second members has different IDs', function () {
    var b2 = swing('SWING:B2', 200, 20, b.price);
    assert.notStrictEqual(eq.clusterIdV3('BTCUSDT', '5m', 'EQH', a, b),
        eq.clusterIdV3('BTCUSDT', '5m', 'EQH', a, b2));
});
test('same timestamps with different canonical swing IDs remain distinct', function () {
    var twin = swing('SWING:TWIN', b.confirmedAt, b.sourceOpenTime, b.price);
    assert.notStrictEqual(eq.clusterIdV3('BTCUSDT', '5m', 'EQH', a, b),
        eq.clusterIdV3('BTCUSDT', '5m', 'EQH', a, twin));
});
test('member append does not change the formation ID', function () {
    var before = eq.clusterIdV3('BTCUSDT', '5m', 'EQH', a, b);
    var cluster = { id: before, members: [a, b] };
    cluster.members.push(c);
    assert.strictEqual(cluster.id, before);
});
test('structural retirement does not change public identity', function () {
    var id = eq.clusterIdV3('BTCUSDT', '5m', 'EQH', a, b);
    var cluster = { id: id, instanceId: id, type: 'EQH', confirmedAt: 200,
        formationZone: { low: 99, high: 101 }, members: [a, b] };
    cluster.retirement = retirement.createRetirementState(cluster);
    assert.strictEqual(cluster.retirement.clusterId, id);
    assert.strictEqual(cluster.retirement.clusterInstanceId, id);
});
test('as-of projection hides future append members', function () {
    var id = eq.clusterIdV3('BTCUSDT', '5m', 'EQH', a, b);
    var base = { id: id, type: 'EQH', side: 'BSL', createdAt: 200,
        confirmedAt: 200, formationAnchor: a, initialMembers: [a, b] };
    var ledger = [{ clusterId: id, memberAddedAt: 300, memberConfirmedAt: 300, member: c }];
    assert.deepStrictEqual(eq.projectClusterAsOf(base, ledger, [], 200).memberIds, ['SWING:A', 'SWING:B']);
});
test('formation-member input order does not affect ID', function () {
    assert.strictEqual(eq.clusterIdV3('BTCUSDT', '5m', 'EQH', a, b),
        eq.clusterIdV3('BTCUSDT', '5m', 'EQH', b, a));
});
test('future and mutable fields do not participate in ID', function () {
    var before = eq.clusterIdV3('BTCUSDT', '5m', 'EQH', a, b);
    a.status = 'BROKEN'; b.sweptAt = 999; b.referencePrice = 12345;
    assert.strictEqual(eq.clusterIdV3('BTCUSDT', '5m', 'EQH', a, b), before);
});

var inputPath = path.join(
    '/Users/yaodebao/.codex/visualizations/2026/08/24/01a031bc-fea2-7943-9b4f-2a5e77efcdda',
    'eqh-eql-persistent-cluster-shadow-v3', 'BTCUSDT-5m-bounded-input.json'
);
if (fs.existsSync(inputPath)) {
    var candles = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
    var start = Date.UTC(2026, 6, 22);
    var end = Date.UTC(2026, 7, 21) - 1;
    function run(factory) {
        return eq.runShadow(candles, { symbol: 'BTCUSDT', timeframe: '5m', left: 2, right: 2,
            validationStart: start, validationEnd: end, clusterIdFactory: factory });
    }
    var fixed1 = run(eq.clusterIdV3);
    var fixed2 = run(eq.clusterIdV3);
    var fixed3 = run(eq.clusterIdV3);
    var legacy = run(eq.legacyClusterIdV3Shadow);

    test('same bounded input replayed three times has identical hashes', function () {
        assert.strictEqual(eq.hash(fixed1.finalProjection), eq.hash(fixed2.finalProjection));
        assert.strictEqual(eq.hash(fixed1.finalProjection), eq.hash(fixed3.finalProjection));
    });
    test('all 446 validation cluster public IDs are unique', function () {
        var rows = fixed1.clusters.filter(function (cluster) {
            return cluster.confirmedAt >= start && cluster.confirmedAt <= end;
        });
        assert.strictEqual(rows.length, 446);
        assert.strictEqual(new Set(rows.map(function (cluster) { return cluster.id; })).size, 446);
    });
    test('legacy and fixed identity runs preserve every member assignment', function () {
        assert.deepStrictEqual(semanticPopulation(fixed1, start, end), semanticPopulation(legacy, start, end));
    });
    test('retirement ledger is attributable by unique public ID without audit-only suffix', function () {
        var result = retirement.run(candles, { symbol: 'BTCUSDT', timeframe: '5m',
            validationStart: start, validationEnd: end });
        var ids = result.clusters.map(function (cluster) { return cluster.id; });
        assert.strictEqual(new Set(ids).size, ids.length);
        assert.ok(result.retirementLedger.every(function (row) {
            return row.clusterId === row.clusterInstanceId && row.clusterId.indexOf(':INSTANCE:') === -1;
        }));
    });
} else {
    console.log('SKIP bounded 30D assertions: frozen local input is unavailable');
}

console.log('EQ Cluster Identity Collision Fix V1 targeted tests passed (' + passed + '/12)');
