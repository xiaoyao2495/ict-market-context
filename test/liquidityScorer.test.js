/**
 * liquidityScorer 单元测试
 *
 * 核心验证点：
 * - 各类型基础权重正确（PMH 90 / PWH 80 / PDH 70 / EQH 55 / Session）
 * - SWING 按周期：5m 20 / 15m 30 / 1h 45 / 4h 60 / 1d 75
 * - freshness 乘数（ACTIVE 1.0 / TOUCHED 0.8 / SWEPT·BROKEN 0）
 * - cluster：base = max(有效成员)、confluence、diversity、cap 100
 * - scoring breakdown 正确
 * - Strength 不含距离信息
 */
var assert = require('assert');
var liquidityScorer = require('../liquidity/liquidityScorer');

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

function liquidity(type, side, price, opts) {
    var o = opts || {};
    return {
        id: 'BTCUSDT:' + type + ':' + price,
        symbol: 'BTCUSDT',
        timeframe: o.timeframe || '5m',
        type: type,
        side: side,
        price: price,
        sourceOpenTime: 0,
        sourceCloseTime: 0,
        createdAt: 0,
        confirmedAt: 0,
        status: o.status || 'ACTIVE',
        touchedAt: null,
        sweptAt: null,
        brokenAt: null,
        metadata: o.metadata || {}
    };
}

/* ---------- 类型权重 ---------- */

test('PMH/PML = 90', function () {
    assert.strictEqual(liquidityScorer.scoreIndividual(liquidity('PMH', 'BSL', 100)), 90);
    assert.strictEqual(liquidityScorer.scoreIndividual(liquidity('PML', 'SSL', 100)), 90);
});

test('PWH/PWL = 80', function () {
    assert.strictEqual(liquidityScorer.scoreIndividual(liquidity('PWH', 'BSL', 100)), 80);
    assert.strictEqual(liquidityScorer.scoreIndividual(liquidity('PWL', 'SSL', 100)), 80);
});

test('PDH/PDL = 70', function () {
    assert.strictEqual(liquidityScorer.scoreIndividual(liquidity('PDH', 'BSL', 100)), 70);
    assert.strictEqual(liquidityScorer.scoreIndividual(liquidity('PDL', 'SSL', 100)), 70);
});

test('EQH/EQL = 55', function () {
    assert.strictEqual(liquidityScorer.scoreIndividual(liquidity('EQH', 'BSL', 100)), 55);
    assert.strictEqual(liquidityScorer.scoreIndividual(liquidity('EQL', 'SSL', 100)), 55);
});

test('Session 权重：ASIA 45 / LONDON 50 / NEW_YORK 50', function () {
    assert.strictEqual(liquidityScorer.scoreIndividual(liquidity('ASIA_HIGH', 'BSL', 100)), 45);
    assert.strictEqual(liquidityScorer.scoreIndividual(liquidity('ASIA_LOW', 'SSL', 100)), 45);
    assert.strictEqual(liquidityScorer.scoreIndividual(liquidity('LONDON_HIGH', 'BSL', 100)), 50);
    assert.strictEqual(liquidityScorer.scoreIndividual(liquidity('NEW_YORK_LOW', 'SSL', 100)), 50);
});

/* ---------- SWING 按周期 ---------- */

test('SWING 按周期：5m 20 / 15m 30 / 1h 45 / 4h 60 / 1d 75', function () {
    assert.strictEqual(
        liquidityScorer.scoreIndividual(liquidity('SWING_HIGH', 'BSL', 100, { timeframe: '5m' })),
        20
    );
    assert.strictEqual(
        liquidityScorer.scoreIndividual(liquidity('SWING_HIGH', 'BSL', 100, { timeframe: '15m' })),
        30
    );
    assert.strictEqual(
        liquidityScorer.scoreIndividual(liquidity('SWING_HIGH', 'BSL', 100, { timeframe: '1h' })),
        45
    );
    assert.strictEqual(
        liquidityScorer.scoreIndividual(liquidity('SWING_HIGH', 'BSL', 100, { timeframe: '4h' })),
        60
    );
    assert.strictEqual(
        liquidityScorer.scoreIndividual(liquidity('SWING_HIGH', 'BSL', 100, { timeframe: '1d' })),
        75
    );
});

test('非 SWING 不加 timeframeBonus（防 double counting）', function () {
    // PDH 不管 metadata.timeframe 是什么都 = 70
    assert.strictEqual(
        liquidityScorer.scoreIndividual(liquidity('PDH', 'BSL', 100, { timeframe: '1d' })),
        70
    );
});

/* ---------- freshness ---------- */

test('freshness：TOUCHED = ×0.8', function () {
    var l = liquidity('PDH', 'BSL', 100, { status: 'TOUCHED' });
    assert.strictEqual(liquidityScorer.scoreIndividual(l), 56); // 70 * 0.8
});

test('freshness：SWEPT / BROKEN = 0（不再是 active target）', function () {
    var swept = liquidity('PDH', 'BSL', 100, { status: 'SWEPT' });
    var broken = liquidity('PWH', 'BSL', 100, { status: 'BROKEN' });
    assert.strictEqual(liquidityScorer.scoreIndividual(swept), 0);
    assert.strictEqual(liquidityScorer.scoreIndividual(broken), 0);
});

test('上限 100：PMH + 高周期 swing 不会溢出', function () {
    var l = liquidity('PMH', 'BSL', 100);
    assert.strictEqual(liquidityScorer.scoreIndividual(l), 90); // 90 < 100
});

/* ---------- cluster ---------- */

function clusterWith(members) {
    return {
        id: 'X',
        symbol: 'BTCUSDT',
        side: 'BSL',
        zoneLow: 63000,
        zoneHigh: 63100,
        centerPrice: 63050,
        members: members,
        activeMembers: members.filter(function (m) {
            return m.status === 'ACTIVE' || m.status === 'TOUCHED';
        }).length,
        sweptMembers: 0,
        brokenMembers: 0,
        state: 'ACTIVE',
        strength: 0,
        metadata: {}
    };
}

test('cluster：base = max(有效成员 strength)，无 confluence（单成员）', function () {
    var c = clusterWith([
        liquidity('PDH', 'BSL', 63050)
    ]);
    var bd = liquidityScorer.scoreCluster(c);
    assert.strictEqual(bd.base, 70);
    assert.strictEqual(bd.confluenceBonus, 0); // 1 个成员无额外印证
    assert.strictEqual(bd.diversityBonus, 0); // 1 类
    assert.strictEqual(bd.final, 70);
});

test('cluster：PDH + EQH + 1H Swing → 92（用户示例参数）', function () {
    var c = clusterWith([
        liquidity('PDH', 'BSL', 63050),
        liquidity('EQH', 'BSL', 63060),
        liquidity('SWING_HIGH', 'BSL', 63070, { timeframe: '1h' })
    ]);
    var bd = liquidityScorer.scoreCluster(c);
    // base = max(70, 55, 45) = 70
    // confluence = (3-1)*6 = 12
    // diversity = (CALENDAR+EQUAL+STRUCTURE = 3类 - 1) * 5 = 10
    assert.strictEqual(bd.base, 70);
    assert.strictEqual(bd.confluenceBonus, 12);
    assert.strictEqual(bd.diversityBonus, 10);
    assert.strictEqual(bd.final, 92);
    assert.deepStrictEqual(bd, {
        base: 70,
        confluenceBonus: 12,
        diversityBonus: 10,
        final: 92
    });
});

test('cluster：同类 3 成员（三个 5m swing）→ diversity 0、confluence 有', function () {
    var c = clusterWith([
        liquidity('SWING_HIGH', 'BSL', 63050, { timeframe: '5m' }),
        liquidity('SWING_HIGH', 'BSL', 63060, { timeframe: '5m' }),
        liquidity('SWING_HIGH', 'BSL', 63070, { timeframe: '5m' })
    ]);
    var bd = liquidityScorer.scoreCluster(c);
    assert.strictEqual(bd.base, 20);
    assert.strictEqual(bd.confluenceBonus, 12);
    assert.strictEqual(bd.diversityBonus, 0); // 只有 STRUCTURE 一类
    assert.strictEqual(bd.final, 32);
});

test('cluster：final 上限 100', function () {
    var c = clusterWith([
        liquidity('PMH', 'BSL', 63050),
        liquidity('PDH', 'BSL', 63055),
        liquidity('EQH', 'BSL', 63060),
        liquidity('LONDON_HIGH', 'BSL', 63065)
    ]);
    var bd = liquidityScorer.scoreCluster(c);
    // base = 90，confluence = 3*6=18，diversity = (4-1)*5=15 → 123 → cap 100
    assert.strictEqual(bd.final, 100);
});

test('cluster：SWEPT 成员 freshness=0，不影响 base', function () {
    var c = clusterWith([
        liquidity('PDH', 'BSL', 63050, { status: 'SWEPT' }), // 已消耗
        liquidity('EQH', 'BSL', 63060)
    ]);
    var bd = liquidityScorer.scoreCluster(c);
    assert.strictEqual(bd.base, 55); // max(0, 55)
    // 有效成员只有 1 个 → confluence 0
    assert.strictEqual(bd.confluenceBonus, 0);
    assert.strictEqual(bd.final, 55);
});

/* ---------- 类别 ---------- */

test('categoryOf：CALENDAR / EQUAL / STRUCTURE / SESSION', function () {
    assert.strictEqual(liquidityScorer.categoryOf(liquidity('PDH', 'BSL', 1)), 'CALENDAR');
    assert.strictEqual(liquidityScorer.categoryOf(liquidity('PML', 'SSL', 1)), 'CALENDAR');
    assert.strictEqual(liquidityScorer.categoryOf(liquidity('EQH', 'BSL', 1)), 'EQUAL');
    assert.strictEqual(liquidityScorer.categoryOf(liquidity('EQL', 'SSL', 1)), 'EQUAL');
    assert.strictEqual(liquidityScorer.categoryOf(liquidity('SWING_HIGH', 'BSL', 1)), 'STRUCTURE');
    assert.strictEqual(liquidityScorer.categoryOf(liquidity('SWING_LOW', 'SSL', 1)), 'STRUCTURE');
    assert.strictEqual(liquidityScorer.categoryOf(liquidity('ASIA_HIGH', 'BSL', 1)), 'SESSION');
    assert.strictEqual(liquidityScorer.categoryOf(liquidity('NEW_YORK_LOW', 'SSL', 1)), 'SESSION');
});

/* ---------- Strength 不含距离 ---------- */

test('Strength 与价格无关（不含 distance 信息）', function () {
    var near = liquidityScorer.scoreIndividual(liquidity('PDH', 'BSL', 63400));
    var far = liquidityScorer.scoreIndividual(liquidity('PDH', 'BSL', 70000));
    assert.strictEqual(near, far); // 距离留给 Draw Engine
});

console.log('----');
console.log('liquidityScorer: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) {
    process.exit(1);
}
