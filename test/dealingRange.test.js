/**
 * dealingRange + premiumDiscount 单元测试
 */
var assert = require('assert');
var dealingRange = require('../structure/dealingRange');
var premiumDiscount = require('../context/premiumDiscount');

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

function pivot(type, price, time) {
    return { type: type, index: 0, price: price, time: time };
}

/* ---------- dealingRange ---------- */

test('range = 最近 swing high / low 组合', function () {
    var pivots = [
        pivot('HIGH', 64000, 1000),
        pivot('LOW', 62000, 2000),
        pivot('HIGH', 63500, 3000), // 最近的 high
        pivot('LOW', 62500, 4000) // 最近的 low
    ];
    var r = dealingRange.buildDealingRange(pivots, {});
    assert.ok(r);
    assert.strictEqual(r.high, 63500);
    assert.strictEqual(r.low, 62500);
    assert.strictEqual(r.mid, 63000);
    assert.strictEqual(r.width, 1000);
    assert.strictEqual(r.highTime, 3000);
    assert.strictEqual(r.lowTime, 4000);
});

test('空 pivots → null', function () {
    assert.strictEqual(dealingRange.buildDealingRange([], {}), null);
});

test('缺 high 或 low → null', function () {
    assert.strictEqual(
        dealingRange.buildDealingRange([pivot('HIGH', 64000, 1000)], {}),
        null
    );
});

test('防未来数据：time > evaluationTime 的 pivot 不参与', function () {
    var pivots = [
        pivot('HIGH', 64000, 1000),
        pivot('LOW', 62000, 9999999999) // 未来
    ];
    var r = dealingRange.buildDealingRange(pivots, { evaluationTime: 5000 });
    assert.strictEqual(r, null); // 只剩 high
});

/* ---------- premiumDiscount ---------- */

var range = { high: 100, low: 90, mid: 95, width: 10 };

test('price 接近 high → EXTREME PREMIUM', function () {
    var l = premiumDiscount.classifyLocation(99, range, {});
    assert.strictEqual(l.zone, 'PREMIUM');
    assert.strictEqual(l.intensity, 'EXTREME');
    assert.ok(l.ratio > 0.8);
});

test('ratio 0.9 → EXTREME PREMIUM（边界含）', function () {
    var l = premiumDiscount.classifyLocation(99, range, {});
    assert.strictEqual(l.ratio, 0.9);
});

test('price 70% 位置 → PREMIUM MODERATE', function () {
    var l = premiumDiscount.classifyLocation(97, range, {});
    assert.strictEqual(l.zone, 'PREMIUM');
    assert.strictEqual(l.intensity, 'MODERATE');
});

test('mid 附近 → EQUILIBRIUM', function () {
    var l = premiumDiscount.classifyLocation(95, range, {});
    assert.strictEqual(l.zone, 'EQUILIBRIUM');
});

test('price 30% 位置 → DISCOUNT MODERATE', function () {
    var l = premiumDiscount.classifyLocation(93, range, {});
    assert.strictEqual(l.zone, 'DISCOUNT');
    assert.strictEqual(l.intensity, 'MODERATE');
});

test('price 接近 low → EXTREME DISCOUNT', function () {
    var l = premiumDiscount.classifyLocation(91, range, {});
    assert.strictEqual(l.zone, 'DISCOUNT');
    assert.strictEqual(l.intensity, 'EXTREME');
});

test('无 range → UNKNOWN', function () {
    var l = premiumDiscount.classifyLocation(95, null, {});
    assert.strictEqual(l.zone, 'UNKNOWN');
    assert.strictEqual(l.ratio, null);
});

test('flat range（high == low）→ EQUILIBRIUM', function () {
    var l = premiumDiscount.classifyLocation(95, { high: 95, low: 95 }, {});
    assert.strictEqual(l.zone, 'EQUILIBRIUM');
});

console.log('----');
console.log('dealingRange/premiumDiscount: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) {
    process.exit(1);
}
