/**
 * drawEngine 单元测试
 *
 * 核心验证点：
 * - BSL/SSL 分开排名、primary/secondary 正确
 * - imbalance 正确
 * - direction label 阈值边界（+25 / +10 / +9.999 / -9.999 / -10 / -25）
 * - tie break（score → strength → distance → confirmedAt → id）
 * - 空侧保护（BSL=0 SSL=78 → imbalance=-78 → SSL）
 * - 两侧都空 → BALANCED + explanation
 * - replay safety（future liquidity 不参与）
 */
var assert = require('assert');
var drawEngine = require('../draw/drawEngine');
var liquidityRegistry = require('../liquidity/liquidityRegistry');
var thresholds = require('../config/thresholds');

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

function makeRegistry(liquidities) {
    var r = liquidityRegistry.createRegistry();
    r.addMany(liquidities);
    return r;
}

function engine(registry, clusters, currentPrice, evaluationTime) {
    return drawEngine.runDrawEngine({
        symbol: 'BTCUSDT',
        currentPrice: currentPrice !== undefined ? currentPrice : 63343,
        evaluationTime: evaluationTime !== undefined ? evaluationTime : 9999999999999,
        registry: registry,
        clusters: clusters || []
    });
}

/* ---------- direction label 阈值边界（重点锁定） ---------- */

test('directionLabel：+25 → BSL', function () {
    assert.strictEqual(drawEngine.directionLabel(25, thresholds), 'BSL');
});

test('directionLabel：+24.99 → LEAN_BSL', function () {
    assert.strictEqual(drawEngine.directionLabel(24.99, thresholds), 'LEAN_BSL');
});

test('directionLabel：+10 → LEAN_BSL（含边界）', function () {
    assert.strictEqual(drawEngine.directionLabel(10, thresholds), 'LEAN_BSL');
});

test('directionLabel：+9.999 → BALANCED', function () {
    assert.strictEqual(drawEngine.directionLabel(9.999, thresholds), 'BALANCED');
});

test('directionLabel：0 → BALANCED', function () {
    assert.strictEqual(drawEngine.directionLabel(0, thresholds), 'BALANCED');
});

test('directionLabel：-9.999 → BALANCED', function () {
    assert.strictEqual(drawEngine.directionLabel(-9.999, thresholds), 'BALANCED');
});

test('directionLabel：-10 → LEAN_SSL（含边界）', function () {
    assert.strictEqual(drawEngine.directionLabel(-10, thresholds), 'LEAN_SSL');
});

test('directionLabel：-24.99 → LEAN_SSL', function () {
    assert.strictEqual(drawEngine.directionLabel(-24.99, thresholds), 'LEAN_SSL');
});

test('directionLabel：-25 → SSL', function () {
    assert.strictEqual(drawEngine.directionLabel(-25, thresholds), 'SSL');
});

test('directionLabel：极端值', function () {
    assert.strictEqual(drawEngine.directionLabel(100, thresholds), 'BSL');
    assert.strictEqual(drawEngine.directionLabel(-100, thresholds), 'SSL');
});

/* ---------- 引擎集成 ---------- */

test('engine：BSL/SSL 分开排名，primary/secondary 正确', function () {
    var r = makeRegistry([
        liq('B1', 'EQH', 'BSL', 64000), // strength 70
        liq('B2', 'SWING_HIGH', 'BSL', 63420), // strength 20，更近
        liq('S1', 'EQL', 'SSL', 62716), // strength 70
        liq('S2', 'SWING_LOW', 'SSL', 63030) // strength 20，更近
    ]);
    var out = engine(r, [], 63343);
    // BSL：primary 应为更近的 B2？distance 77/63343=0.12% → 100；B1 657/63343=1.04% → 50
    // B2 draw = 20*.55 + 100*.3 + 100*.15 = 11+30+15 = 56
    // B1(EQH 55) draw = 55*.55 + 50*.3 + 100*.15 = 30.25+15+15 = 60.25
    // → primary = B1（60.25 > 56）
    assert.strictEqual(out.bsl.candidates.length, 2);
    assert.strictEqual(out.bsl.primary.targetPrice, 64000);
    assert.strictEqual(out.bsl.secondary.targetPrice, 63420);
    assert.ok(out.bsl.primary.drawScore > out.bsl.secondary.drawScore);

    assert.strictEqual(out.ssl.candidates.length, 2);
    assert.strictEqual(out.ssl.primary.targetPrice, 62716);
    assert.strictEqual(out.ssl.secondary.targetPrice, 63030);
});

test('engine：imbalance = BSL primary - SSL primary', function () {
    var r = makeRegistry([
        liq('B1', 'EQH', 'BSL', 64000),
        liq('S1', 'EQL', 'SSL', 62716)
    ]);
    var out = engine(r, [], 63343);
    var expected = Math.round((out.bsl.score - out.ssl.score) * 10) / 10;
    assert.strictEqual(out.imbalance, expected);
    assert.strictEqual(out.imbalance, out.bsl.score - out.ssl.score);
});

test('engine：BSL cluster 作为 primary（cluster 优先且更强）', function () {
    var m1 = liq('M1', 'SWING_HIGH', 'BSL', 63590);
    var m2 = liq('M2', 'EQH', 'BSL', 63600);
    var c = cluster('BSL', 63580, 63610, 'ACTIVE', { members: [m1, m2], strength: 92 });
    var r = makeRegistry([m1, m2, liq('S1', 'EQL', 'SSL', 62716)]);
    var out = engine(r, [c], 63343);
    assert.strictEqual(out.bsl.primary.targetType, 'CLUSTER');
    assert.strictEqual(out.bsl.primary.targetPrice, 63610); // zoneHigh
    // 成员不重复出现
    assert.strictEqual(out.bsl.candidates.length, 1);
    assert.ok(out.bsl.primary.reasons.length >= 3);
});

/* ---------- 空侧保护 ---------- */

test('engine：BSL 无候选 → score 0，SSL 主导 → direction SSL', function () {
    var r = makeRegistry([
        liq('S1', 'EQL', 'SSL', 62716),
        liq('S2', 'SWING_LOW', 'SSL', 62535)
    ]);
    var out = engine(r, [], 63343);
    assert.strictEqual(out.bsl.candidates.length, 0);
    assert.strictEqual(out.bsl.primary, null);
    assert.strictEqual(out.bsl.score, 0);
    assert.ok(out.ssl.score > 0);
    // imbalance = 0 - ssl < 0；方向取决于幅度（此处 ssl 不会超过 25？EQL 55 → draw≈60.3 → imbalance=-60.3 → SSL）
    assert.strictEqual(out.direction, 'SSL');
});

test('engine：两侧都无候选 → BALANCED + 明确 explanation', function () {
    var r = makeRegistry([]);
    var out = engine(r, [], 63343);
    assert.strictEqual(out.bsl.primary, null);
    assert.strictEqual(out.ssl.primary, null);
    assert.strictEqual(out.imbalance, 0);
    assert.strictEqual(out.direction, 'BALANCED');
    assert.strictEqual(out.explanation, 'No active liquidity draw candidates');
});

test('engine：无候选不抛异常（合法状态）', function () {
    var r = makeRegistry([]);
    assert.doesNotThrow(function () {
        engine(r, [], 63343);
    });
});

/* ---------- 防未来数据（replay safety） ---------- */

test('engine：confirmedAt > evaluationTime 的 liquidity 不参与', function () {
    var r = makeRegistry([
        liq('B1', 'EQH', 'BSL', 64000, { confirmedAt: 9999999999999 }), // 未来
        liq('S1', 'EQL', 'SSL', 62716, { confirmedAt: 1000 })
    ]);
    var out = engine(r, [], 63343, 5000);
    assert.strictEqual(out.bsl.candidates.length, 0); // B1 未确认
    assert.strictEqual(out.ssl.candidates.length, 1);
});

test('engine：cluster 成员未确认不参与', function () {
    var m1 = liq('M1', 'SWING_HIGH', 'BSL', 63590, { confirmedAt: 9999999999999 });
    var m2 = liq('M2', 'EQH', 'BSL', 63600, { confirmedAt: 9999999999999 });
    var c = cluster('BSL', 63580, 63610, 'ACTIVE', { members: [m1, m2], confirmedAt: 9999999999999 });
    var r = makeRegistry([m1, m2]);
    var out = engine(r, [c], 63343, 5000);
    assert.strictEqual(out.bsl.candidates.length, 0);
});

/* ---------- tie break ---------- */

test('compareCandidates：score 高优先', function () {
    var a = { drawScore: 90, strength: 70, distanceAbs: 100, confirmedAt: 1000, id: 'a' };
    var b = { drawScore: 80, strength: 90, distanceAbs: 10, confirmedAt: 1000, id: 'b' };
    assert.ok(drawEngine.compareCandidates(a, b) < 0); // a 排前
});

test('compareCandidates：score 相同 → strength 高优先', function () {
    var a = { drawScore: 80, strength: 70, distanceAbs: 100, confirmedAt: 1000, id: 'a' };
    var b = { drawScore: 80, strength: 90, distanceAbs: 10, confirmedAt: 1000, id: 'b' };
    assert.ok(drawEngine.compareCandidates(a, b) > 0); // b 排前
});

test('compareCandidates：score+strength 相同 → distance 近优先', function () {
    var a = { drawScore: 80, strength: 70, distanceAbs: 100, confirmedAt: 1000, id: 'a' };
    var b = { drawScore: 80, strength: 70, distanceAbs: 10, confirmedAt: 1000, id: 'b' };
    assert.ok(drawEngine.compareCandidates(a, b) > 0); // b 排前
});

test('compareCandidates：前三项相同 → confirmedAt 早优先', function () {
    var a = { drawScore: 80, strength: 70, distanceAbs: 100, confirmedAt: 5000, id: 'a' };
    var b = { drawScore: 80, strength: 70, distanceAbs: 100, confirmedAt: 1000, id: 'b' };
    assert.ok(drawEngine.compareCandidates(a, b) > 0); // b（更早）排前
});

test('compareCandidates：全部相同 → id 字典序（deterministic）', function () {
    var a = { drawScore: 80, strength: 70, distanceAbs: 100, confirmedAt: 1000, id: 'a' };
    var b = { drawScore: 80, strength: 70, distanceAbs: 100, confirmedAt: 1000, id: 'b' };
    assert.strictEqual(drawEngine.compareCandidates(a, b), -1);
    assert.strictEqual(drawEngine.compareCandidates(b, a), 1);
    // 自反
    assert.strictEqual(drawEngine.compareCandidates(a, a), 0);
});

test('engine：排序 deterministic（两次运行结果一致）', function () {
    var r = makeRegistry([
        liq('B1', 'EQH', 'BSL', 64000),
        liq('B2', 'SWING_HIGH', 'BSL', 65391),
        liq('S1', 'EQL', 'SSL', 62716)
    ]);
    var out1 = engine(r, [], 63343);
    var out2 = engine(r, [], 63343);
    assert.strictEqual(out1.bsl.primary.id, out2.bsl.primary.id);
    assert.strictEqual(out1.ssl.primary.id, out2.ssl.primary.id);
    assert.strictEqual(out1.direction, out2.direction);
});

console.log('----');
console.log('drawEngine: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) {
    process.exit(1);
}
