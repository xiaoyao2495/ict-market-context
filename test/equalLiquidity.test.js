/**
 * equalLiquidity 单元测试
 *
 * 核心验证点：
 * - 两个接近 Swing High → 1 个 EQH（BSL）
 * - 两个接近 Swing Low → 1 个 EQL（SSL）
 * - 超出 tolerance → 不形成
 * - 小于 minBarsApart / 大于 maxBarsApart → 不形成
 * - 三个相近成员 → 合并为 1 个 group，不产生 pair duplicate
 * - confirmedAt = max(member.confirmedAt)
 * - evaluationTime 早于第二成员确认时间 → 不提前生成（回放安全）
 * - price = 成员平均价；metadata 含 minPrice/maxPrice/memberCount/members
 */
var assert = require('assert');
var equalLiquidity = require('../liquidity/equalLiquidity');

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

/**
 * 构造一条已确认的 swing liquidity
 */
function swing(type, index, price, confirmedAt, openTime) {
    return {
        id: 'BTCUSDT:5m:' + type + ':' + openTime,
        symbol: 'BTCUSDT',
        timeframe: '5m',
        type: type,
        side: type === 'SWING_HIGH' ? 'BSL' : 'SSL',
        price: price,
        sourceOpenTime: openTime,
        sourceCloseTime: openTime + 300000 - 1,
        createdAt: confirmedAt,
        confirmedAt: confirmedAt,
        status: 'ACTIVE',
        touchedAt: null,
        sweptAt: null,
        brokenAt: null,
        metadata: { source: 'futures', index: index }
    };
}

var OPTS = {
    symbol: 'BTCUSDT',
    evaluationTime: 9999999999999
};

/* ---------- 基础分组 ---------- */

test('两个接近的 Swing High → 1 个 EQH（BSL，price=均值）', function () {
    // 63000 与 63010：tolerance = 63000*0.0002 = 12.6，差 10 < 12.6 ✓
    var swings = [
        swing('SWING_HIGH', 10, 63000, 1000, 10000),
        swing('SWING_HIGH', 20, 63010, 2000, 20000)
    ];
    var result = equalLiquidity.detectEqualLiquidity(swings, OPTS);
    assert.strictEqual(result.length, 1);
    var eqh = result[0];
    assert.strictEqual(eqh.type, 'EQH');
    assert.strictEqual(eqh.side, 'BSL');
    assert.strictEqual(eqh.price, 63005); // 均值
    assert.strictEqual(eqh.metadata.memberCount, 2);
    assert.strictEqual(eqh.metadata.minPrice, 63000);
    assert.strictEqual(eqh.metadata.maxPrice, 63010);
});

test('两个接近的 Swing Low → 1 个 EQL（SSL）', function () {
    var swings = [
        swing('SWING_LOW', 10, 62000, 1000, 10000),
        swing('SWING_LOW', 20, 62008, 2000, 20000)
    ];
    var result = equalLiquidity.detectEqualLiquidity(swings, OPTS);
    assert.strictEqual(result.length, 1);
    var eql = result[0];
    assert.strictEqual(eql.type, 'EQL');
    assert.strictEqual(eql.side, 'SSL');
    assert.strictEqual(eql.price, 62004);
    assert.strictEqual(eql.metadata.memberCount, 2);
});

test('超出 tolerance → 不形成', function () {
    // 63000 与 63030：差 30 > 12.6
    var swings = [
        swing('SWING_HIGH', 10, 63000, 1000, 10000),
        swing('SWING_HIGH', 20, 63030, 2000, 20000)
    ];
    var result = equalLiquidity.detectEqualLiquidity(swings, OPTS);
    assert.strictEqual(result.length, 0);
});

test('小于 minBarsApart（index 间隔 2）→ 不形成', function () {
    var swings = [
        swing('SWING_HIGH', 10, 63000, 1000, 10000),
        swing('SWING_HIGH', 12, 63010, 2000, 20000)
    ];
    var result = equalLiquidity.detectEqualLiquidity(swings, OPTS);
    assert.strictEqual(result.length, 0);
});

test('大于 maxBarsApart（间隔 201）→ 不形成', function () {
    var swings = [
        swing('SWING_HIGH', 10, 63000, 1000, 10000),
        swing('SWING_HIGH', 211, 63010, 2000, 20000)
    ];
    var result = equalLiquidity.detectEqualLiquidity(swings, OPTS);
    assert.strictEqual(result.length, 0);
});

/* ---------- 三成员合并 ---------- */

test('三个相近 High 合并为 1 个 EQH（不产生 A+B / A+C / B+C）', function () {
    var swings = [
        swing('SWING_HIGH', 10, 63000, 1000, 10000),
        swing('SWING_HIGH', 20, 63010, 2000, 20000),
        swing('SWING_HIGH', 30, 62998, 3000, 30000)
    ];
    var result = equalLiquidity.detectEqualLiquidity(swings, OPTS);
    assert.strictEqual(result.length, 1); // 绝不是 3 个
    var eqh = result[0];
    assert.strictEqual(eqh.metadata.memberCount, 3);
    assert.strictEqual(eqh.price, (63000 + 63010 + 62998) / 3);
    assert.strictEqual(eqh.metadata.minPrice, 62998);
    assert.strictEqual(eqh.metadata.maxPrice, 63010);
    assert.strictEqual(eqh.metadata.members.length, 3);
});

test('三个相近 Low 合并为 1 个 EQL', function () {
    var swings = [
        swing('SWING_LOW', 10, 62000, 1000, 10000),
        swing('SWING_LOW', 20, 62005, 2000, 20000),
        swing('SWING_LOW', 30, 61998, 3000, 30000)
    ];
    var result = equalLiquidity.detectEqualLiquidity(swings, OPTS);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].type, 'EQL');
    assert.strictEqual(result[0].metadata.memberCount, 3);
});

test('两簇独立 equal（高簇 + 低簇）各生成 1 个，互不混淆', function () {
    var swings = [
        swing('SWING_HIGH', 10, 63000, 1000, 10000),
        swing('SWING_HIGH', 20, 63008, 2000, 20000),
        swing('SWING_LOW', 30, 62000, 3000, 30000),
        swing('SWING_LOW', 40, 62006, 4000, 40000)
    ];
    var result = equalLiquidity.detectEqualLiquidity(swings, OPTS);
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].type, 'EQH');
    assert.strictEqual(result[1].type, 'EQL');
});

/* ---------- confirmedAt 与回放安全 ---------- */

test('confirmedAt = max(member.confirmedAt)', function () {
    var swings = [
        swing('SWING_HIGH', 10, 63000, 1000, 10000),
        swing('SWING_HIGH', 20, 63010, 5000, 20000) // 第二个成员 11:00 才确认
    ];
    var result = equalLiquidity.detectEqualLiquidity(swings, OPTS);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].confirmedAt, 5000);
    assert.strictEqual(result[0].createdAt, 5000);
});

test('evaluationTime 早于第二成员 confirmedAt → EQH 不提前出现', function () {
    var swings = [
        swing('SWING_HIGH', 10, 63000, 1000, 10000), // 10:15 确认
        swing('SWING_HIGH', 20, 63010, 5000, 20000) // 11:00 确认
    ];
    // 回放到 10:30（第二成员尚未确认）→ 只有第一个成员 → 不构成
    var early = equalLiquidity.detectEqualLiquidity(swings, {
        symbol: 'BTCUSDT',
        evaluationTime: 3000
    });
    assert.strictEqual(early.length, 0);

    // 回放到 11:30 → 两个成员都确认 → 生成，confirmedAt = 11:00
    var late = equalLiquidity.detectEqualLiquidity(swings, {
        symbol: 'BTCUSDT',
        evaluationTime: 6000
    });
    assert.strictEqual(late.length, 1);
    assert.strictEqual(late[0].confirmedAt, 5000);
});

test('tolerance 随价格缩放：BTC 与低价币使用同一百分比', function () {
    // 100 与 100.05：tolerance = 100*0.0002 = 0.02，差 0.05 > 0.02 → 不形成
    var swings = [
        swing('SWING_HIGH', 10, 100, 1000, 10000),
        swing('SWING_HIGH', 20, 100.05, 2000, 20000)
    ];
    var result = equalLiquidity.detectEqualLiquidity(swings, OPTS);
    assert.strictEqual(result.length, 0);
});

test('tickSize 参与 tolerance：max(percent, tickSize*2)', function () {
    // price=100，tickSize=1 → tick tolerance = 2 > percent tolerance 0.02
    // 100 与 101.5：差 1.5 < 2 → 形成
    var swings = [
        swing('SWING_HIGH', 10, 100, 1000, 10000),
        swing('SWING_HIGH', 20, 101.5, 2000, 20000)
    ];
    var result = equalLiquidity.detectEqualLiquidity(swings, {
        symbol: 'BTCUSDT',
        evaluationTime: OPTS.evaluationTime,
        tickSize: 1
    });
    assert.strictEqual(result.length, 1);
});

test('members 保存原始 swing liquidity 引用', function () {
    var s1 = swing('SWING_HIGH', 10, 63000, 1000, 10000);
    var s2 = swing('SWING_HIGH', 20, 63010, 2000, 20000);
    var result = equalLiquidity.detectEqualLiquidity([s1, s2], OPTS);
    assert.strictEqual(result[0].metadata.members[0], s1);
    assert.strictEqual(result[0].metadata.members[1], s2);
});

test('id 稳定：同一组在任何调用下产生相同 id', function () {
    var swings = [
        swing('SWING_HIGH', 10, 63000, 1000, 10000),
        swing('SWING_HIGH', 20, 63010, 2000, 20000)
    ];
    var r1 = equalLiquidity.detectEqualLiquidity(swings, OPTS);
    var r2 = equalLiquidity.detectEqualLiquidity(swings, OPTS);
    assert.strictEqual(r1[0].id, r2[0].id);
    assert.strictEqual(r1[0].id, 'BTCUSDT:EQH:10000');
});

console.log('----');
console.log('equalLiquidity: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) {
    process.exit(1);
}
