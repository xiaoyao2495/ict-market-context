/**
 * distanceScorer 单元测试
 *
 * 离散距离表（thresholds.draw.distanceBands）：
 *   <=0.25% → 100 / <=0.50% → 85 / <=1.00% → 70 / <=2.00% → 50 / <=4.00% → 30 / >4% → 15
 * 边界锁死：0.25% 必须命中第一档，不是第二档
 */
var assert = require('assert');
var distanceScorer = require('../draw/distanceScorer');

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

test('0.10% → 100', function () {
    assert.strictEqual(distanceScorer.scoreDistance(0.001), 100);
});

test('0.25% 边界 → 100（第一档，不是第二档）', function () {
    assert.strictEqual(distanceScorer.scoreDistance(0.0025), 100);
});

test('0.2501% → 85（第二档）', function () {
    assert.strictEqual(distanceScorer.scoreDistance(0.002501), 85);
});

test('0.50% 边界 → 85', function () {
    assert.strictEqual(distanceScorer.scoreDistance(0.005), 85);
});

test('0.5001% → 70', function () {
    assert.strictEqual(distanceScorer.scoreDistance(0.005001), 70);
});

test('1.00% 边界 → 70', function () {
    assert.strictEqual(distanceScorer.scoreDistance(0.01), 70);
});

test('1.01% → 50', function () {
    assert.strictEqual(distanceScorer.scoreDistance(0.0101), 50);
});

test('2.00% 边界 → 50', function () {
    assert.strictEqual(distanceScorer.scoreDistance(0.02), 50);
});

test('2.01% → 30', function () {
    assert.strictEqual(distanceScorer.scoreDistance(0.0201), 30);
});

test('4.00% 边界 → 30', function () {
    assert.strictEqual(distanceScorer.scoreDistance(0.04), 30);
});

test('4.01% → 15（fallback）', function () {
    assert.strictEqual(distanceScorer.scoreDistance(0.0401), 15);
});

test('10% → 15（fallback）', function () {
    assert.strictEqual(distanceScorer.scoreDistance(0.1), 15);
});

test('0 → 100', function () {
    assert.strictEqual(distanceScorer.scoreDistance(0), 100);
});

test('BSL/SSL 完全对称：算法不读 side', function () {
    // 同样的距离，无论方向都得到相同分数
    assert.strictEqual(distanceScorer.scoreDistance(0.004), distanceScorer.scoreDistance(0.004));
    assert.strictEqual(distanceScorer.scoreDistance(0.004), 85);
});

console.log('----');
console.log('distanceScorer: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) {
    process.exit(1);
}
