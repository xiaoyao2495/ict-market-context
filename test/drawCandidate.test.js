/**
 * drawCandidate 单元测试
 *
 * 核心验证点：
 * - BSL cluster target = zoneHigh；SSL cluster target = zoneLow
 * - standalone target = price（zoneLow = zoneHigh = price）
 * - BSL 只保留 currentPrice 上方 / SSL 只保留下方
 * - cluster members 不重复成为 standalone candidate
 * - CONSUMED 排除、PARTIAL 保留
 * - confirmedAt > evaluationTime 排除
 */
var assert = require('assert');
var drawCandidate = require('../draw/drawCandidate');

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

function liq(id, type, side, price, opts) {
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
        createdAt: o.confirmedAt !== undefined ? o.confirmedAt : 1000,
        confirmedAt: o.confirmedAt !== undefined ? o.confirmedAt : 1000,
        status: o.status || 'ACTIVE',
        touchedAt: null,
        sweptAt: null,
        brokenAt: null,
        metadata: { source: 'futures' }
    };
}

function cluster(side, zoneLow, zoneHigh, state, opts) {
    var o = opts || {};
    var members = o.members || [];
    var confirmedAt = 0;
    members.forEach(function (m) {
        if (m.confirmedAt > confirmedAt) confirmedAt = m.confirmedAt;
    });
    return {
        id: 'BTCUSDT:CLUSTER:' + side + ':' + zoneLow,
        symbol: 'BTCUSDT',
        side: side,
        zoneLow: zoneLow,
        zoneHigh: zoneHigh,
        centerPrice: (zoneLow + zoneHigh) / 2,
        members: members,
        activeMembers: members.length,
        sweptMembers: 0,
        brokenMembers: 0,
        state: state,
        confirmedAt: o.confirmedAt !== undefined ? o.confirmedAt : confirmedAt || 1000,
        strength: o.strength !== undefined ? o.strength : 80,
        metadata: { strengthBreakdown: null }
    };
}

var BASE = {
    symbol: 'BTCUSDT',
    currentPrice: 63343,
    evaluationTime: 9999999999999
};

/* ---------- targetPrice 规则 ---------- */

test('BSL cluster target = zoneHigh', function () {
    var c = cluster('BSL', 63580, 63610, 'ACTIVE', { strength: 92 });
    var out = drawCandidate.buildCandidates({
        symbol: 'BTCUSDT', currentPrice: 63343, evaluationTime: BASE.evaluationTime,
        clusters: [c], standalone: []
    });
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].targetType, 'CLUSTER');
    assert.strictEqual(out[0].targetPrice, 63610); // zoneHigh
    assert.strictEqual(out[0].zoneLow, 63580);
    assert.strictEqual(out[0].zoneHigh, 63610);
    assert.strictEqual(out[0].side, 'BSL');
});

test('SSL cluster target = zoneLow', function () {
    var c = cluster('SSL', 62716, 62740, 'ACTIVE');
    var out = drawCandidate.buildCandidates({
        symbol: 'BTCUSDT', currentPrice: 63343, evaluationTime: BASE.evaluationTime,
        clusters: [c], standalone: []
    });
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].targetPrice, 62716); // zoneLow
    assert.strictEqual(out[0].side, 'SSL');
});

test('standalone：target = zoneLow = zoneHigh = price', function () {
    var l = liq('L1', 'PDH', 'BSL', 64000);
    var out = drawCandidate.buildCandidates({
        symbol: 'BTCUSDT', currentPrice: 63343, evaluationTime: BASE.evaluationTime,
        clusters: [], standalone: [l]
    });
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].targetType, 'LIQUIDITY');
    assert.strictEqual(out[0].targetPrice, 64000);
    assert.strictEqual(out[0].zoneLow, 64000);
    assert.strictEqual(out[0].zoneHigh, 64000);
    assert.strictEqual(out[0].strength, 70); // PDH 权重
    assert.strictEqual(out[0].sourceTypes[0], 'PDH');
});

/* ---------- 方向过滤 ---------- */

test('BSL 只保留 currentPrice 上方', function () {
    var above = liq('L1', 'PDH', 'BSL', 64000); // 64000 > 63343 ✓
    var below = liq('L2', 'SWING_HIGH', 'BSL', 62000); // 已被价格越过 ✗
    var out = drawCandidate.buildCandidates({
        symbol: 'BTCUSDT', currentPrice: 63343, evaluationTime: BASE.evaluationTime,
        clusters: [], standalone: [above, below]
    });
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].id, 'DRAW:L1');
});

test('SSL 只保留 currentPrice 下方', function () {
    var below = liq('L1', 'PDL', 'SSL', 62716);
    var above = liq('L2', 'SWING_LOW', 'SSL', 64000);
    var out = drawCandidate.buildCandidates({
        symbol: 'BTCUSDT', currentPrice: 63343, evaluationTime: BASE.evaluationTime,
        clusters: [], standalone: [below, above]
    });
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].id, 'DRAW:L1');
});

/* ---------- 成员不重复 ---------- */

test('cluster members 不重复成为 standalone candidate', function () {
    var m1 = liq('M1', 'PDH', 'BSL', 63590);
    var m2 = liq('M2', 'EQH', 'BSL', 63600);
    var c = cluster('BSL', 63580, 63610, 'ACTIVE', { members: [m1, m2] });
    var out = drawCandidate.buildCandidates({
        symbol: 'BTCUSDT', currentPrice: 63343, evaluationTime: BASE.evaluationTime,
        clusters: [c], standalone: [m1, m2]
    });
    assert.strictEqual(out.length, 1); // 只有 cluster，没有 PDH/EQH 独立候选
    assert.strictEqual(out[0].targetType, 'CLUSTER');
    assert.strictEqual(out[0].sourceTypes.length, 2);
    assert.ok(out[0].sourceTypes.indexOf('PDH') !== -1);
    assert.ok(out[0].sourceTypes.indexOf('EQH') !== -1);
});

/* ---------- 状态过滤 ---------- */

test('CONSUMED cluster 排除', function () {
    var c = cluster('BSL', 63580, 63610, 'CONSUMED');
    var out = drawCandidate.buildCandidates({
        symbol: 'BTCUSDT', currentPrice: 63343, evaluationTime: BASE.evaluationTime,
        clusters: [c], standalone: []
    });
    assert.strictEqual(out.length, 0);
});

test('PARTIAL cluster 保留（freshness 由 scorer 降低）', function () {
    var c = cluster('BSL', 63580, 63610, 'PARTIAL');
    var out = drawCandidate.buildCandidates({
        symbol: 'BTCUSDT', currentPrice: 63343, evaluationTime: BASE.evaluationTime,
        clusters: [c], standalone: []
    });
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].state, 'PARTIAL');
});

/* ---------- 防未来数据 ---------- */

test('confirmedAt > evaluationTime 的 cluster 排除', function () {
    var c = cluster('BSL', 63580, 63610, 'ACTIVE', { confirmedAt: 9999999999999 });
    var out = drawCandidate.buildCandidates({
        symbol: 'BTCUSDT', currentPrice: 63343, evaluationTime: 5000,
        clusters: [c], standalone: []
    });
    assert.strictEqual(out.length, 0);
});

test('confirmedAt > evaluationTime 的 standalone 排除', function () {
    var l = liq('L1', 'PDH', 'BSL', 64000, { confirmedAt: 9999999999999 });
    var out = drawCandidate.buildCandidates({
        symbol: 'BTCUSDT', currentPrice: 63343, evaluationTime: 5000,
        clusters: [], standalone: [l]
    });
    assert.strictEqual(out.length, 0);
});

/* ---------- 字段完整性 ---------- */

test('candidate 统一字段完整（cluster）', function () {
    var m1 = liq('M1', 'PDH', 'BSL', 63590, { confirmedAt: 3000 });
    var m2 = liq('M2', 'EQH', 'BSL', 63600, { confirmedAt: 5000 });
    var c = cluster('BSL', 63580, 63610, 'ACTIVE', { members: [m1, m2] });
    var out = drawCandidate.buildCandidates({
        symbol: 'BTCUSDT', currentPrice: 63343, evaluationTime: BASE.evaluationTime,
        clusters: [c], standalone: []
    });
    var cand = out[0];
    assert.ok(cand.id.indexOf('DRAW:') === 0);
    assert.strictEqual(cand.symbol, 'BTCUSDT');
    assert.strictEqual(cand.side, 'BSL');
    assert.strictEqual(typeof cand.strength, 'number');
    assert.strictEqual(cand.freshness, 0); // engine 填
    assert.strictEqual(cand.distanceAbs, 0); // engine 填
    assert.strictEqual(cand.distancePct, 0);
    assert.strictEqual(cand.confirmedAt, 5000); // max(member.confirmedAt)
    assert.strictEqual(cand.members.length, 2);
});

console.log('----');
console.log('drawCandidate: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) {
    process.exit(1);
}
