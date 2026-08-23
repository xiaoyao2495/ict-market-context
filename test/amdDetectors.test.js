/**
 * manipulationDetector + distributionDetector 单元测试
 */
var assert = require('assert');
var manipulationDetector = require('../amd/manipulationDetector');
var distributionDetector = require('../amd/distributionDetector');
var eventRegistry = require('../events/eventRegistry');

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

var BAR = 300000;

function acc(rangeLow, rangeHigh, atr, confirmedAt) {
    return {
        rangeLow: rangeLow, rangeHigh: rangeHigh,
        mid: (rangeLow + rangeHigh) / 2,
        rangeWidth: rangeHigh - rangeLow,
        atr: atr, confirmedAt: confirmedAt
    };
}

function sweep(id, side, price, confirmedAt, candleIndex, liquidityType) {
    return {
        id: id, symbol: 'BTCUSDT', timeframe: '5m', type: 'LIQUIDITY_SWEEP',
        direction: side === 'SSL' ? 'BULLISH' : 'BEARISH',
        side: side, liquidityId: id, price: price,
        confirmedAt: confirmedAt, candleIndex: candleIndex,
        source: { liquidityType: liquidityType || 'PDH', side: side },
        metadata: {}
    };
}

function mssEvent(id, direction, confirmedAt, candleIndex) {
    return {
        id: id, symbol: 'BTCUSDT', timeframe: '5m', type: 'STRUCTURAL_MSS', direction: direction,
        confirmedAt: confirmedAt, candleIndex: candleIndex,
        price: 100, source: { candle: { close: 100 } }, metadata: {}
    };
}

function dispEvent(id, direction, confirmedAt, close, candleIndex) {
    return {
        id: id, symbol: 'BTCUSDT', timeframe: '5m', type: 'DISPLACEMENT', direction: direction,
        confirmedAt: confirmedAt, candleIndex: candleIndex,
        price: close, source: { candle: { close: close } }, metadata: {}
    };
}

function makeRegistry(events) {
    var r = eventRegistry.createEventRegistry();
    r.addMany(events);
    return r;
}

/* ---------- manipulation：bullish（SSL near rangeLow） ---------- */

test('SSL sweep near rangeLow → BULLISH manipulation', function () {
    var a = acc(100, 110, 5, 1000000); // tolerance = max(5*0.1, 100*0.001) = 0.5
    var reg = makeRegistry([sweep('s1', 'SSL', 99.6, 1000000 + 2 * BAR, 10)]);
    var r = manipulationDetector.detectManipulation({
        accumulation: a, eventRegistry: reg, candles: [], timeframe: '5m',
        evaluationTime: 9999999999999, symbol: 'BTCUSDT'
    }, {});
    assert.ok(r);
    assert.strictEqual(r.direction, 'BULLISH');
    assert.strictEqual(r.state, 'MANIPULATION_CONFIRMED'); // 35 + 15(PDH) + ... >= 60
});

test('BSL sweep near rangeHigh → BEARISH manipulation', function () {
    var a = acc(100, 110, 5, 1000000);
    var reg = makeRegistry([sweep('s1', 'BSL', 110.4, 1000000 + 2 * BAR, 10)]);
    var r = manipulationDetector.detectManipulation({
        accumulation: a, eventRegistry: reg, candles: [], timeframe: '5m',
        evaluationTime: 9999999999999, symbol: 'BTCUSDT'
    }, {});
    assert.strictEqual(r.direction, 'BEARISH');
});

test('far-away sweep（远离边界且未穿透）→ 拒绝', function () {
    var a = acc(100, 110, 5, 1000000);
    // SSL sweep price 93 → penetration 7 (1.4 ATR)，在合理穿透范围内 → 接受
    // 用 89 → penetration 11 > 2 ATR → 拒绝（更像真突破）
    var reg = makeRegistry([sweep('s1', 'SSL', 89, 1000000 + 2 * BAR, 10)]);
    var r = manipulationDetector.detectManipulation({
        accumulation: a, eventRegistry: reg, candles: [], timeframe: '5m',
        evaluationTime: 9999999999999, symbol: 'BTCUSDT'
    }, {});
    assert.strictEqual(r, null);
});

test('穿透过深（>2 ATR）→ 拒绝（更像真突破）', function () {
    var a = acc(100, 110, 5, 1000000);
    // SSL sweep price 88 → penetration 12 > 10 (2*ATR)
    var reg = makeRegistry([sweep('s1', 'SSL', 88, 1000000 + 2 * BAR, 10)]);
    var r = manipulationDetector.detectManipulation({
        accumulation: a, eventRegistry: reg, candles: [], timeframe: '5m',
        evaluationTime: 9999999999999, symbol: 'BTCUSDT'
    }, {});
    assert.strictEqual(r, null);
});

test('future sweep → 拒绝', function () {
    var a = acc(100, 110, 5, 1000000);
    var reg = makeRegistry([sweep('s1', 'SSL', 99.6, 9999999999999, 10)]);
    var r = manipulationDetector.detectManipulation({
        accumulation: a, eventRegistry: reg, candles: [], timeframe: '5m',
        evaluationTime: 5000000, symbol: 'BTCUSDT'
    }, {});
    assert.strictEqual(r, null);
});

test('sweep 超过 manipulationMaxBars（13 bars）→ 拒绝', function () {
    var a = acc(100, 110, 5, 1000000);
    var reg = makeRegistry([sweep('s1', 'SSL', 99.6, 1000000 + 13 * BAR, 10)]);
    var r = manipulationDetector.detectManipulation({
        accumulation: a, eventRegistry: reg, candles: [], timeframe: '5m',
        evaluationTime: 9999999999999, symbol: 'BTCUSDT'
    }, {});
    assert.strictEqual(r, null);
});

test('EQH sweep 加分（比无 bonus 的 swing sweep score 高）', function () {
    var a = acc(100, 110, 5, 1000000);
    var reg1 = makeRegistry([sweep('s1', 'SSL', 99.6, 1000000 + 2 * BAR, 10, 'SWING_HIGH')]); // 无 bonus
    var reg2 = makeRegistry([sweep('s2', 'SSL', 99.6, 1000000 + 2 * BAR, 10, 'EQH')]); // equal bonus
    var r1 = manipulationDetector.detectManipulation({ accumulation: a, eventRegistry: reg1, candles: [], timeframe: '5m', evaluationTime: 9999999999999, symbol: 'BTCUSDT' }, {});
    var r2 = manipulationDetector.detectManipulation({ accumulation: a, eventRegistry: reg2, candles: [], timeframe: '5m', evaluationTime: 9999999999999, symbol: 'BTCUSDT' }, {});
    assert.ok(r2.score > r1.score);
});

test('sweep 在 accumulation 之前 → 拒绝', function () {
    var a = acc(100, 110, 5, 1000000);
    var reg = makeRegistry([sweep('s1', 'SSL', 99.6, 500000, 10)]);
    var r = manipulationDetector.detectManipulation({
        accumulation: a, eventRegistry: reg, candles: [], timeframe: '5m',
        evaluationTime: 9999999999999, symbol: 'BTCUSDT'
    }, {});
    assert.strictEqual(r, null);
});

/* ---------- distribution ---------- */

test('bullish distribution：matching MSS + displacement → CONFIRMED', function () {
    var a = acc(100, 110, 5, 1000000);
    var manip = { direction: 'BULLISH', confirmedAt: 1000000 + 2 * BAR, score: 80, symbol: 'BTCUSDT' };
    var mss = mssEvent('m1', 'BULLISH', 1000000 + 3 * BAR, 12);
    var disp = dispEvent('d1', 'BULLISH', 1000000 + 4 * BAR, 112, 13);
    var reg = makeRegistry([mss, disp]);
    var r = distributionDetector.detectDistribution({
        accumulation: a, manipulation: manip, eventRegistry: reg,
        draw: null, timeframe: '5m', evaluationTime: 9999999999999, symbol: 'BTCUSDT'
    }, {});
    assert.ok(r);
    assert.strictEqual(r.direction, 'BULLISH');
    assert.strictEqual(r.state, 'DISTRIBUTION_CONFIRMED'); // 30 + 35 = 65
});

test('bearish distribution：matching MSS + displacement', function () {
    var a = acc(100, 110, 5, 1000000);
    var manip = { direction: 'BEARISH', confirmedAt: 1000000 + 2 * BAR, score: 80, symbol: 'BTCUSDT' };
    var mss = mssEvent('m1', 'BEARISH', 1000000 + 3 * BAR, 12);
    var disp = dispEvent('d1', 'BEARISH', 1000000 + 4 * BAR, 88, 13);
    var reg = makeRegistry([mss, disp]);
    var r = distributionDetector.detectDistribution({
        accumulation: a, manipulation: manip, eventRegistry: reg,
        draw: null, timeframe: '5m', evaluationTime: 9999999999999, symbol: 'BTCUSDT'
    }, {});
    assert.strictEqual(r.direction, 'BEARISH');
    assert.strictEqual(r.state, 'DISTRIBUTION_CONFIRMED');
});

test('wrong direction（bullish AMD + bearish MSS）→ 拒绝', function () {
    var a = acc(100, 110, 5, 1000000);
    var manip = { direction: 'BULLISH', confirmedAt: 1000000 + 2 * BAR, score: 80, symbol: 'BTCUSDT' };
    var mss = mssEvent('m1', 'BEARISH', 1000000 + 3 * BAR, 12);
    var disp = dispEvent('d1', 'BULLISH', 1000000 + 4 * BAR, 112, 13);
    var reg = makeRegistry([mss, disp]);
    var r = distributionDetector.detectDistribution({
        accumulation: a, manipulation: manip, eventRegistry: reg,
        draw: null, timeframe: '5m', evaluationTime: 9999999999999, symbol: 'BTCUSDT'
    }, {});
    assert.strictEqual(r, null);
});

test('order strict：MSS 在 manipulation 之前 → 拒绝', function () {
    var a = acc(100, 110, 5, 1000000);
    var manip = { direction: 'BULLISH', confirmedAt: 1000000 + 5 * BAR, score: 80, symbol: 'BTCUSDT' };
    var mss = mssEvent('m1', 'BULLISH', 1000000 + 3 * BAR, 12); // 在 manip 之前
    var disp = dispEvent('d1', 'BULLISH', 1000000 + 6 * BAR, 112, 13);
    var reg = makeRegistry([mss, disp]);
    var r = distributionDetector.detectDistribution({
        accumulation: a, manipulation: manip, eventRegistry: reg,
        draw: null, timeframe: '5m', evaluationTime: 9999999999999, symbol: 'BTCUSDT'
    }, {});
    assert.strictEqual(r, null);
});

test('MSS timeout（>12 bars）→ 拒绝', function () {
    var a = acc(100, 110, 5, 1000000);
    var manip = { direction: 'BULLISH', confirmedAt: 1000000, score: 80, symbol: 'BTCUSDT' };
    var mss = mssEvent('m1', 'BULLISH', 1000000 + 13 * BAR, 12);
    var disp = dispEvent('d1', 'BULLISH', 1000000 + 14 * BAR, 112, 13);
    var reg = makeRegistry([mss, disp]);
    var r = distributionDetector.detectDistribution({
        accumulation: a, manipulation: manip, eventRegistry: reg,
        draw: null, timeframe: '5m', evaluationTime: 9999999999999, symbol: 'BTCUSDT'
    }, {});
    assert.strictEqual(r, null);
});

test('displacement timeout（>6 bars after MSS）→ 拒绝', function () {
    var a = acc(100, 110, 5, 1000000);
    var manip = { direction: 'BULLISH', confirmedAt: 1000000, score: 80, symbol: 'BTCUSDT' };
    var mss = mssEvent('m1', 'BULLISH', 1000000 + 2 * BAR, 12);
    var disp = dispEvent('d1', 'BULLISH', 1000000 + 2 * BAR + 7 * BAR, 112, 13); // 7 bars > 6
    var reg = makeRegistry([mss, disp]);
    var r = distributionDetector.detectDistribution({
        accumulation: a, manipulation: manip, eventRegistry: reg,
        draw: null, timeframe: '5m', evaluationTime: 9999999999999, symbol: 'BTCUSDT'
    }, {});
    assert.strictEqual(r, null);
});

test('same candle MSS+displacement 允许（sameDeliveryChain bonus）', function () {
    var a = acc(100, 110, 5, 1000000);
    var manip = { direction: 'BULLISH', confirmedAt: 1000000, score: 80, symbol: 'BTCUSDT' };
    var mss = mssEvent('m1', 'BULLISH', 1000000 + 2 * BAR, 12);
    var disp = dispEvent('d1', 'BULLISH', 1000000 + 2 * BAR, 112, 12); // same confirmedAt
    var reg = makeRegistry([mss, disp]);
    var r = distributionDetector.detectDistribution({
        accumulation: a, manipulation: manip, eventRegistry: reg,
        draw: null, timeframe: '5m', evaluationTime: 9999999999999, symbol: 'BTCUSDT'
    }, {});
    assert.ok(r);
    assert.ok(r.breakdown.sameDeliveryChain > 0);
});

test('range escape bonus：displacement close 超出 range', function () {
    var a = acc(100, 110, 5, 1000000);
    var manip = { direction: 'BULLISH', confirmedAt: 1000000, score: 80, symbol: 'BTCUSDT' };
    var mss = mssEvent('m1', 'BULLISH', 1000000 + 2 * BAR, 12);
    var dispInside = dispEvent('d1', 'BULLISH', 1000000 + 3 * BAR, 105, 13); // 未逃出
    var dispEscape = dispEvent('d2', 'BULLISH', 1000000 + 3 * BAR, 115, 13); // 逃出 rangeHigh 110
    var r1 = distributionDetector.detectDistribution({
        accumulation: a, manipulation: manip, eventRegistry: makeRegistry([mss, dispInside]),
        draw: null, timeframe: '5m', evaluationTime: 9999999999999, symbol: 'BTCUSDT'
    }, {});
    var r2 = distributionDetector.detectDistribution({
        accumulation: a, manipulation: manip, eventRegistry: makeRegistry([mss, dispEscape]),
        draw: null, timeframe: '5m', evaluationTime: 9999999999999, symbol: 'BTCUSDT'
    }, {});
    assert.ok(r2.score > r1.score);
    assert.strictEqual(r2.rangeEscaped, true);
});

test('target draw bonus：draw 有 matching side 候选', function () {
    var a = acc(100, 110, 5, 1000000);
    var manip = { direction: 'BULLISH', confirmedAt: 1000000, score: 80, symbol: 'BTCUSDT' };
    var mss = mssEvent('m1', 'BULLISH', 1000000 + 2 * BAR, 12);
    var disp = dispEvent('d1', 'BULLISH', 1000000 + 3 * BAR, 112, 13);
    var drawWith = { bsl: { candidates: [{ id: 'x' }] }, ssl: { candidates: [] } };
    var r = distributionDetector.detectDistribution({
        accumulation: a, manipulation: manip, eventRegistry: makeRegistry([mss, disp]),
        draw: drawWith, timeframe: '5m', evaluationTime: 9999999999999, symbol: 'BTCUSDT'
    }, {});
    assert.strictEqual(r.targetAvailable, true);
    assert.ok(r.breakdown.targetLiquidity > 0);
});

test('future MSS/displacement → 拒绝', function () {
    var a = acc(100, 110, 5, 1000000);
    var manip = { direction: 'BULLISH', confirmedAt: 1000000, score: 80, symbol: 'BTCUSDT' };
    var mss = mssEvent('m1', 'BULLISH', 9999999999999, 12);
    var disp = dispEvent('d1', 'BULLISH', 9999999999999, 112, 13);
    var reg = makeRegistry([mss, disp]);
    var r = distributionDetector.detectDistribution({
        accumulation: a, manipulation: manip, eventRegistry: reg,
        draw: null, timeframe: '5m', evaluationTime: 5000000, symbol: 'BTCUSDT'
    }, {});
    assert.strictEqual(r, null);
});

console.log('----');
console.log('manipulation/distribution: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) {
    process.exit(1);
}
