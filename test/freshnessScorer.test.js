/**
 * freshnessScorer 单元测试
 *
 * Liquidity ACTIVE 100 / TOUCHED 80 / SWEPT·BROKEN 0
 * Cluster ACTIVE 100 / PARTIAL 75 / CONSUMED 0
 */
var assert = require('assert');
var freshnessScorer = require('../draw/freshnessScorer');

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

function liquidityCandidate(status) {
    return {
        targetType: 'LIQUIDITY',
        status: status
    };
}

function clusterCandidate(state) {
    return {
        targetType: 'CLUSTER',
        state: state
    };
}

test('Liquidity ACTIVE = 100', function () {
    assert.strictEqual(freshnessScorer.scoreFreshness(liquidityCandidate('ACTIVE')), 100);
});

test('Liquidity TOUCHED = 80', function () {
    assert.strictEqual(freshnessScorer.scoreFreshness(liquidityCandidate('TOUCHED')), 80);
});

test('Liquidity SWEPT = 0', function () {
    assert.strictEqual(freshnessScorer.scoreFreshness(liquidityCandidate('SWEPT')), 0);
});

test('Liquidity BROKEN = 0', function () {
    assert.strictEqual(freshnessScorer.scoreFreshness(liquidityCandidate('BROKEN')), 0);
});

test('Cluster ACTIVE = 100', function () {
    assert.strictEqual(freshnessScorer.scoreFreshness(clusterCandidate('ACTIVE')), 100);
});

test('Cluster PARTIAL = 75', function () {
    assert.strictEqual(freshnessScorer.scoreFreshness(clusterCandidate('PARTIAL')), 75);
});

test('Cluster CONSUMED = 0', function () {
    assert.strictEqual(freshnessScorer.scoreFreshness(clusterCandidate('CONSUMED')), 0);
});

test('未知 state/status → 0（保守）', function () {
    assert.strictEqual(freshnessScorer.scoreFreshness({ targetType: 'CLUSTER', state: 'WEIRD' }), 0);
    assert.strictEqual(freshnessScorer.scoreFreshness({ targetType: 'LIQUIDITY', status: 'WEIRD' }), 0);
    assert.strictEqual(freshnessScorer.scoreFreshness(null), 0);
});

console.log('----');
console.log('freshnessScorer: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) {
    process.exit(1);
}
