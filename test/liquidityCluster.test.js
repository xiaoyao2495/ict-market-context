/**
 * liquidityCluster 单元测试
 *
 * 核心验证点：
 * - 相近 BSL 合并 / 相近 SSL 合并 / BSL·SSL 不混合
 * - 超 tolerance 不合并（zone 链式扩展）
 * - 三个成员只生成一个 cluster（不重复分组）
 * - zoneLow / zoneHigh / centerPrice 正确
 * - 防未来数据（confirmedAt <= evaluationTime）
 * - standalone 识别
 * - state 推导（ACTIVE / PARTIAL / CONSUMED）
 */
var assert = require('assert');
var liquidityCluster = require('../liquidity/liquidityCluster');

var passed = 0;
var failed = 0;

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log('PASS  ' + name);
    } catch (e) {
        failed++;
        console.log('FAIL  ' + name + '  ->  ' + e.message);
    }
}

function liquidity(id, type, side, price, status, opts) {
    var o = opts || {};
    return {
        id: id,
        symbol: 'BTCUSDT',
        timeframe: o.timeframe || '5m',
        type: type,
        side: side,
        price: price,
        sourceOpenTime: o.openTime || 0,
        sourceCloseTime: (o.openTime || 0) + 300000 - 1,
        createdAt: o.confirmedAt || 1000,
        confirmedAt: o.confirmedAt || 1000,
        status: status || 'ACTIVE',
        touchedAt: null,
        sweptAt: null,
        brokenAt: null,
        metadata: { source: 'futures', index: o.index }
    };
}

var OPTS = { symbol: 'BTCUSDT', evaluationTime: 9999999999999 };

/* ---------- 基础聚类 ---------- */

test('相近 BSL 合并：zone 链式扩展（63390 → 63401 → 63408 → 63415）', function () {
    // tolerance = 63415 * 0.0003 ≈ 19.02
    var list = [
        liquidity('a', 'EQH', 'BSL', 63390, 'ACTIVE'),
        liquidity('b', 'EQH', 'BSL', 63401, 'ACTIVE'),
        liquidity('c', 'SWING_HIGH', 'BSL', 63408, 'ACTIVE'),
        liquidity('d', 'SWING_HIGH', 'BSL', 63415, 'ACTIVE')
    ];
    var clusters = liquidityCluster.buildClusters(list, OPTS);
    assert.strictEqual(clusters.length, 1);
    var c = clusters[0];
    assert.strictEqual(c.side, 'BSL');
    assert.strictEqual(c.zoneLow, 63390);
    assert.strictEqual(c.zoneHigh, 63415);
    assert.strictEqual(c.centerPrice, (63390 + 63415) / 2);
    assert.strictEqual(c.members.length, 4);
    assert.strictEqual(c.state, 'ACTIVE');
});

test('超 tolerance 不合并（63550 与 zone 上沿脱节）', function () {
    var list = [
        liquidity('a', 'EQH', 'BSL', 63390, 'ACTIVE'),
        liquidity('b', 'SWING_HIGH', 'BSL', 63400, 'ACTIVE'), // 桥接成员
        liquidity('c', 'EQH', 'BSL', 63415, 'ACTIVE'),
        liquidity('d', 'SWING_HIGH', 'BSL', 63550, 'ACTIVE') // 与 63415 差 135 >> 19
    ];
    var clusters = liquidityCluster.buildClusters(list, OPTS);
    assert.strictEqual(clusters.length, 1); // 63550 单独 → 不是 cluster
    assert.strictEqual(clusters[0].zoneLow, 63390);
    assert.strictEqual(clusters[0].zoneHigh, 63415);
    assert.strictEqual(clusters[0].members.length, 3);
});

test('相近 SSL 合并', function () {
    var list = [
        liquidity('a', 'EQL', 'SSL', 63020, 'ACTIVE'),
        liquidity('b', 'EQL', 'SSL', 63031, 'ACTIVE'),
        liquidity('c', 'SWING_LOW', 'SSL', 63040, 'ACTIVE')
    ];
    var clusters = liquidityCluster.buildClusters(list, OPTS);
    assert.strictEqual(clusters.length, 1);
    var c = clusters[0];
    assert.strictEqual(c.side, 'SSL');
    assert.strictEqual(c.zoneLow, 63020);
    assert.strictEqual(c.zoneHigh, 63040);
    assert.strictEqual(c.members.length, 3);
});

test('BSL 与 SSL 绝不混合', function () {
    var list = [
        liquidity('a', 'EQH', 'BSL', 63400, 'ACTIVE'),
        liquidity('b', 'EQH', 'BSL', 63410, 'ACTIVE'),
        liquidity('c', 'EQL', 'SSL', 63405, 'ACTIVE'), // 价格相近但方向相反
        liquidity('d', 'EQL', 'SSL', 63408, 'ACTIVE')
    ];
    var clusters = liquidityCluster.buildClusters(list, OPTS);
    assert.strictEqual(clusters.length, 2);
    assert.strictEqual(clusters[0].side, 'BSL');
    assert.strictEqual(clusters[1].side, 'SSL');
    assert.strictEqual(clusters[0].members.length, 2);
    assert.strictEqual(clusters[1].members.length, 2);
});

test('两个独立簇：分别生成，不互相吞并', function () {
    var list = [
        liquidity('a', 'EQH', 'BSL', 63400, 'ACTIVE'),
        liquidity('b', 'EQH', 'BSL', 63410, 'ACTIVE'),
        liquidity('c', 'SWING_HIGH', 'BSL', 65000, 'ACTIVE'),
        liquidity('d', 'SWING_HIGH', 'BSL', 65010, 'ACTIVE')
    ];
    var clusters = liquidityCluster.buildClusters(list, OPTS);
    assert.strictEqual(clusters.length, 2);
    assert.strictEqual(clusters[0].zoneLow, 63400);
    assert.strictEqual(clusters[0].zoneHigh, 63410);
    assert.strictEqual(clusters[1].zoneLow, 65000);
    assert.strictEqual(clusters[1].zoneHigh, 65010);
});

test('单成员不构成 cluster', function () {
    var list = [
        liquidity('a', 'EQH', 'BSL', 63400, 'ACTIVE'),
        liquidity('b', 'SWING_HIGH', 'BSL', 65000, 'ACTIVE')
    ];
    var clusters = liquidityCluster.buildClusters(list, OPTS);
    assert.strictEqual(clusters.length, 0); // 两个都是孤立单点
});

/* ---------- state 推导 ---------- */

test('state：含 SWEPT 成员 → PARTIAL', function () {
    var list = [
        liquidity('a', 'EQH', 'BSL', 63408, 'BROKEN'), // 历史，price 落在 zone 内
        liquidity('b', 'EQH', 'BSL', 63406, 'ACTIVE'),
        liquidity('c', 'SWING_HIGH', 'BSL', 63412, 'ACTIVE')
    ];
    var clusters = liquidityCluster.buildClusters(list, OPTS);
    assert.strictEqual(clusters.length, 1);
    var c = clusters[0];
    assert.strictEqual(c.activeMembers, 2);
    assert.strictEqual(c.brokenMembers, 1);
    assert.strictEqual(c.sweptMembers, 0);
    assert.strictEqual(c.state, 'PARTIAL');
    assert.strictEqual(c.members.length, 3); // 历史成员回溯归属
});

test('state：全部消耗 → CONSUMED（buildCluster 内部推导）', function () {
    var all = [
        liquidity('a', 'EQH', 'BSL', 63400, 'SWEPT'),
        liquidity('b', 'EQH', 'BSL', 63410, 'BROKEN')
    ];
    // 直接构造：两个有效成员都已消耗的场景（聚类从有效成员开始，V1 不会自然产生，
    // 但代码结构必须支持 —— 未来传入历史成员时推导 PARTIAL/CONSUMED）
    var c = liquidityCluster.buildCluster([all[0], all[1]], 'BSL', 'BTCUSDT', all, 0.0003);
    assert.strictEqual(c.activeMembers, 0);
    assert.strictEqual(c.sweptMembers, 1);
    assert.strictEqual(c.brokenMembers, 1);
    assert.strictEqual(c.state, 'CONSUMED');
});

test('state：全部有效 → ACTIVE', function () {
    var list = [
        liquidity('a', 'EQH', 'BSL', 63400, 'ACTIVE'),
        liquidity('b', 'EQH', 'BSL', 63410, 'TOUCHED') // TOUCHED 仍有效
    ];
    var clusters = liquidityCluster.buildClusters(list, OPTS);
    assert.strictEqual(clusters.length, 1);
    assert.strictEqual(clusters[0].activeMembers, 2);
    assert.strictEqual(clusters[0].state, 'ACTIVE');
});

/* ---------- 防未来数据 ---------- */

test('confirmedAt > evaluationTime 的成员不参与聚类', function () {
    var list = [
        liquidity('a', 'EQH', 'BSL', 63400, 'ACTIVE', { confirmedAt: 5000 }),
        liquidity('b', 'EQH', 'BSL', 63410, 'ACTIVE', { confirmedAt: 9000 }) // 尚未确认
    ];
    var clusters = liquidityCluster.buildClusters(list, {
        symbol: 'BTCUSDT',
        evaluationTime: 7000
    });
    assert.strictEqual(clusters.length, 0); // 只有 1 个有效成员
});

/* ---------- standalone ---------- */

test('findStandalone：未进任何 cluster 的 ACTIVE 被识别', function () {
    var list = [
        liquidity('a', 'EQH', 'BSL', 63400, 'ACTIVE'),
        liquidity('b', 'EQH', 'BSL', 63410, 'ACTIVE'), // 与 a 成 cluster
        liquidity('c', 'SWING_HIGH', 'BSL', 65391, 'ACTIVE'), // 孤立
        liquidity('d', 'EQL', 'SSL', 62716, 'ACTIVE')
    ];
    var clusters = liquidityCluster.buildClusters(list, OPTS);
    assert.strictEqual(clusters.length, 1);

    var standalone = liquidityCluster.findStandalone(list, clusters, OPTS);
    assert.strictEqual(standalone.length, 2);
    var ids = standalone.map(function (s) {
        return s.id;
    });
    assert.ok(ids.indexOf('c') !== -1);
    assert.ok(ids.indexOf('d') !== -1);
    assert.ok(ids.indexOf('a') === -1); // cluster 成员不算 standalone
});

console.log('----');
console.log('liquidityCluster: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) {
    process.exit(1);
}
