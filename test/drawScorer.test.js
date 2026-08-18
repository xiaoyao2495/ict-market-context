/**
 * drawScorer 单元测试
 *
 * Draw Score = Strength×0.55 + Distance×0.30 + Freshness×0.15
 * - 权重之和必须 = 1（1e-9 容差），否则报错
 * - 始终返回 breakdown
 * - final 限制 0-100
 * - 不是 probability
 */
var assert = require('assert');
var drawScorer = require('../draw/drawScorer');

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

function candidate(strength, distanceScore, freshness) {
    return {
        strength: strength,
        distanceScore: distanceScore,
        freshness: freshness
    };
}

test('用户示例：strength 92 / distance 85 / freshness 100 → 91.1', function () {
    var bd = drawScorer.scoreDraw(candidate(92, 85, 100), {});
    assert.strictEqual(bd.strengthScore, 92);
    assert.strictEqual(bd.strengthContribution, 50.6); // 92*0.55
    assert.strictEqual(bd.distanceScore, 85);
    assert.strictEqual(bd.distanceContribution, 25.5); // 85*0.30
});

test('用户示例完整 breakdown 正确', function () {
    var bd = drawScorer.scoreDraw(candidate(92, 85, 100), {});
    assert.strictEqual(bd.freshnessScore, 100);
    assert.strictEqual(bd.freshnessContribution, 15); // 100*0.15
    assert.strictEqual(bd.final, 91.1);
    assert.deepStrictEqual(bd, {
        strengthScore: 92,
        strengthContribution: 50.6,
        distanceScore: 85,
        distanceContribution: 25.5,
        freshnessScore: 100,
        freshnessContribution: 15,
        final: 91.1
    });
});

test('final 上限 100', function () {
    var bd = drawScorer.scoreDraw(candidate(100, 100, 100), {});
    assert.strictEqual(bd.final, 100);
});

test('final 下限 0', function () {
    var bd = drawScorer.scoreDraw(candidate(0, 0, 0), {});
    assert.strictEqual(bd.final, 0);
});

test('权重不合法（sum != 1）→ 明确报错', function () {
    var badThresholds = {
        draw: {
            weights: { strength: 0.6, distance: 0.3, freshness: 0.15 } // sum=1.05
        }
    };
    assert.throws(function () {
        drawScorer.scoreDraw(candidate(50, 50, 50), { thresholds: badThresholds });
    }, /must sum to 1/);
});

test('权重浮点误差 1e-9 内可接受', function () {
    var okThresholds = {
        draw: {
            weights: { strength: 0.55, distance: 0.3, freshness: 0.15 + 1e-10 }
        }
    };
    var bd = drawScorer.scoreDraw(candidate(50, 50, 50), { thresholds: okThresholds });
    assert.strictEqual(typeof bd.final, 'number');
});

console.log('----');
console.log('drawScorer: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) {
    process.exit(1);
}
