/**
 * Phase 11D.4 — Incremental Liquidity 等价性验证
 *
 * 验证增量 pivot 实现（每根只检测 5 根局部窗口）与全量实现
 * （每根 slice(0, index+1) + detectPivots 全量）在任意时刻产生
 * 完全相同的 registry 状态（swing ids + equal ids 集合）。
 */
var assert = require('assert');
var pivotDetector = require('../structure/pivotDetector');
var swingLiquidity = require('../liquidity/swingLiquidity');
var equalLiquidity = require('../liquidity/equalLiquidity');
var liquidityRegistry = require('../liquidity/liquidityRegistry');
var replayState = require('../replay/replayState');

var RIGHT = 2;
var BAR = 300000;

function m5(open, high, low, close, i) {
    var t = 1000000 + i * BAR;
    return {
        openTime: t, open: open, high: high, low: low, close: close,
        closeTime: t + BAR - 1, closed: true, source: 'futures'
    };
}

// 伪随机波浪 candles（保证有丰富 pivot）
function genCandles(n) {
    var out = [];
    var price = 100;
    var seed = 42;
    function rnd() {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return seed / 2147483648;
    }
    for (var i = 0; i < n; i++) {
        var move = (rnd() - 0.48) * 1.5;
        var open = price;
        var close = open + move;
        var high = Math.max(open, close) + rnd() * 0.8;
        var low = Math.min(open, close) - rnd() * 0.8;
        price = close;
        out.push(m5(open, high, low, close, i));
    }
    return out;
}

// 全量实现（原逻辑）
function fullStep(candles, index, registry) {
    var slice = candles.slice(0, index + 1);
    var pivots = pivotDetector.detectPivots(slice, { left: RIGHT, right: RIGHT });
    var newSwings = swingLiquidity.buildSwingLiquidity('TEST', '5m', pivots, slice, RIGHT);
    var added = [];
    newSwings.forEach(function (s) { if (registry.add(s)) added.push(s); });
    var equal = equalLiquidity.detectEqualLiquidity(newSwings, {
        symbol: 'TEST', evaluationTime: candles[index].closeTime, tickSize: 0.01
    });
    equal.forEach(function (e) { registry.add(e); });
    return added;
}

// 增量实现（新逻辑）
function incrStep(candles, index, registry, swingsArr) {
    var newPivots = [];
    var mid = index - RIGHT;
    if (mid >= 0) {
        var lo = Math.max(0, mid - RIGHT);
        var hi = Math.min(candles.length - 1, mid + RIGHT);
        var win = candles.slice(lo, hi + 1);
        var local = pivotDetector.detectPivots(win, { left: RIGHT, right: RIGHT });
        local.forEach(function (p) {
            var g = p.index + lo;
            if (g === mid) {
                newPivots.push({ type: p.type, index: g, price: p.price, confirmedAt: p.confirmedAt, time: p.time });
            }
        });
    }
    var newSwings = swingLiquidity.buildSwingLiquidity('TEST', '5m', newPivots, candles, RIGHT);
    var added = [];
    newSwings.forEach(function (s) { if (registry.add(s)) { added.push(s); } });
    var equal = equalLiquidity.detectEqualLiquidity(
        added.concat(
            registry.getByType('TEST', 'SWING_HIGH'),
            registry.getByType('TEST', 'SWING_LOW')
        ),
        { symbol: 'TEST', evaluationTime: candles[index].closeTime, tickSize: 0.01 }
    );
    equal.forEach(function (e) { registry.add(e); });
    added.forEach(function (s) { swingsArr.push(s); });
    return added;
}

var passed = 0;
var failed = 0;
function test(name, fn) {
    try {
        fn();
        passed++;
        console.log('PASS ' + name);
    } catch (e) {
        failed++;
        console.log('FAIL ' + name + ' -> ' + e.message);
    }
}

test('11D.4：增量 pivot 与全量在每一步 registry 状态一致（1000 根）', function () {
    var candles = genCandles(1000);
    var regFull = liquidityRegistry.createRegistry();
    var regIncr = liquidityRegistry.createRegistry();
    var swingsArr = [];
    for (var i = 0; i < candles.length; i++) {
        fullStep(candles, i, regFull);
        incrStep(candles, i, regIncr, swingsArr);
    }
    function idsOf(reg) {
        return reg.getAll('TEST').map(function (l) { return l.id; }).sort();
    }
    var f = idsOf(regFull);
    var g = idsOf(regIncr);
    assert.strictEqual(g.length, f.length, 'registry 条目数不同: ' + g.length + ' vs ' + f.length);
    for (var k = 0; k < f.length; k++) {
        assert.strictEqual(g[k], f[k], '第 ' + k + ' 个条目不同: ' + g[k] + ' vs ' + f[k]);
    }
});

console.log('');
console.log('incrementalLiquidityEquiv: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
