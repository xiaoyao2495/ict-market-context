/**
 * liquidityLifecycle 单元测试
 *
 * 状态机：ACTIVE → TOUCHED → SWEPT → BROKEN（只升不降）
 * 优先级：BROKEN > SWEPT > TOUCHED > ACTIVE
 * 约束：只处理已收盘 K 线；时间戳用 candle.closeTime
 */
var assert = require('assert');
var lifecycle = require('../liquidity/liquidityLifecycle');

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

function candle(high, low, close, closeTime, options) {
    return {
        openTime: closeTime - 300000,
        open: close,
        high: high,
        low: low,
        close: close,
        volume: 0,
        closeTime: closeTime,
        closed: options && options.closed !== undefined ? options.closed : true,
        source: 'futures'
    };
}

function liquidity(side, price) {
    return {
        id: 'BTCUSDT:5m:SWING_HIGH:1',
        symbol: 'BTCUSDT',
        timeframe: '5m',
        type: side === 'BSL' ? 'SWING_HIGH' : 'SWING_LOW',
        side: side,
        price: price,
        sourceOpenTime: 0,
        sourceCloseTime: 0,
        createdAt: 0,
        confirmedAt: 0,
        status: 'ACTIVE',
        touchedAt: null,
        sweptAt: null,
        brokenAt: null,
        metadata: {}
    };
}

/* ---------- BSL ---------- */

test('BSL：wick through + close below → SWEPT', function () {
    var l = liquidity('BSL', 100);
    var c = candle(100.4, 99.2, 99.8, 12345);
    var r = lifecycle.evaluateLiquidity(l, c);
    assert.ok(r);
    assert.strictEqual(r.status, 'SWEPT');
    assert.strictEqual(r.previousStatus, 'ACTIVE');
    assert.strictEqual(r.sweptAt, 12345); // candle.closeTime
    assert.strictEqual(r.touchedAt, 12345);
    assert.strictEqual(r.brokenAt, null);
    assert.strictEqual(r.event.type, 'LIQUIDITY_SWEPT');
    assert.strictEqual(r.event.side, 'BSL');
    assert.strictEqual(r.event.at, 12345);
});

test('BSL：close above → BROKEN', function () {
    var l = liquidity('BSL', 100);
    var c = candle(101, 99, 100.6, 12345);
    var r = lifecycle.evaluateLiquidity(l, c);
    assert.ok(r);
    assert.strictEqual(r.status, 'BROKEN');
    assert.strictEqual(r.brokenAt, 12345);
    assert.strictEqual(r.event.type, 'LIQUIDITY_BROKEN');
});

test('BSL：只 touch 不 sweep/break → TOUCHED', function () {
    var l = liquidity('BSL', 100);
    var c = candle(100, 99.5, 99.7, 12345); // high 恰好 == 100
    var r = lifecycle.evaluateLiquidity(l, c);
    assert.ok(r);
    assert.strictEqual(r.status, 'TOUCHED');
    assert.strictEqual(r.touchedAt, 12345);
    assert.strictEqual(r.sweptAt, null);
    assert.strictEqual(r.brokenAt, null);
    assert.strictEqual(r.event.type, 'LIQUIDITY_TOUCHED');
});

test('BSL：完全未触及 → ACTIVE（无变化，返回 null）', function () {
    var l = liquidity('BSL', 100);
    var c = candle(99.9, 99.5, 99.7, 12345);
    var r = lifecycle.evaluateLiquidity(l, c);
    assert.strictEqual(r, null);
});

/* ---------- SSL ---------- */

test('SSL：wick through + close above → SWEPT', function () {
    var l = liquidity('SSL', 100);
    var c = candle(100.8, 99.6, 100.2, 12345);
    var r = lifecycle.evaluateLiquidity(l, c);
    assert.ok(r);
    assert.strictEqual(r.status, 'SWEPT');
    assert.strictEqual(r.sweptAt, 12345);
    assert.strictEqual(r.event.type, 'LIQUIDITY_SWEPT');
});

test('SSL：close below → BROKEN', function () {
    var l = liquidity('SSL', 100);
    var c = candle(100.2, 99, 99.4, 12345);
    var r = lifecycle.evaluateLiquidity(l, c);
    assert.ok(r);
    assert.strictEqual(r.status, 'BROKEN');
    assert.strictEqual(r.brokenAt, 12345);
    assert.strictEqual(r.event.type, 'LIQUIDITY_BROKEN');
});

test('SSL：只 touch → TOUCHED', function () {
    var l = liquidity('SSL', 100);
    var c = candle(100.5, 100, 100.3, 12345); // low 恰好 == 100
    var r = lifecycle.evaluateLiquidity(l, c);
    assert.ok(r);
    assert.strictEqual(r.status, 'TOUCHED');
});

/* ---------- 优先级 ---------- */

test('BROKEN 优先级高于 TOUCHED（一根 K 线同时 close 穿透）', function () {
    var l = liquidity('BSL', 100);
    var c = candle(101, 99, 100.6, 12345); // 既 touch 又 break
    var r = lifecycle.evaluateLiquidity(l, c);
    assert.strictEqual(r.status, 'BROKEN'); // 绝不是 TOUCHED
});

test('SWEPT 优先级高于 TOUCHED（wick through + reclaim）', function () {
    var l = liquidity('BSL', 100);
    var c = candle(100.4, 99.2, 99.8, 12345); // 既 touch 又 sweep
    var r = lifecycle.evaluateLiquidity(l, c);
    assert.strictEqual(r.status, 'SWEPT'); // 绝不是 TOUCHED
});

/* ---------- 未收盘 K 线 ---------- */

test('未收盘 K 线不得改变状态（返回 null）', function () {
    var l = liquidity('BSL', 100);
    var c = candle(101, 99, 100.6, 12345, { closed: false });
    var r = lifecycle.evaluateLiquidity(l, c);
    assert.strictEqual(r, null);
});

/* ---------- 状态只升不降 ---------- */

test('SWEPT 后再 touch → 无变化（不倒退）', function () {
    var l = liquidity('BSL', 100);
    l.status = 'SWEPT';
    l.sweptAt = 111;
    var c = candle(100.4, 99.2, 99.8, 222);
    var r = lifecycle.evaluateLiquidity(l, c);
    assert.strictEqual(r, null);
});

test('SWEPT → BROKEN：close 再次收在 level 上方', function () {
    var l = liquidity('BSL', 100);
    l.status = 'SWEPT';
    l.touchedAt = 111;
    l.sweptAt = 111;
    var c = candle(101, 99, 100.6, 222);
    var r = lifecycle.evaluateLiquidity(l, c);
    assert.ok(r);
    assert.strictEqual(r.status, 'BROKEN');
    assert.strictEqual(r.brokenAt, 222);
    assert.strictEqual(r.sweptAt, 111); // 保留早期 sweep 时间
    assert.strictEqual(r.touchedAt, 111);
});

test('BROKEN 后不再变化', function () {
    var l = liquidity('BSL', 100);
    l.status = 'BROKEN';
    l.brokenAt = 111;
    var c = candle(102, 98, 101, 222);
    var r = lifecycle.evaluateLiquidity(l, c);
    assert.strictEqual(r, null);
});

test('TOUCHED → SWEPT：touchedAt 保留早期值', function () {
    var l = liquidity('BSL', 100);
    l.status = 'TOUCHED';
    l.touchedAt = 111;
    var c = candle(100.4, 99.2, 99.8, 222);
    var r = lifecycle.evaluateLiquidity(l, c);
    assert.strictEqual(r.status, 'SWEPT');
    assert.strictEqual(r.touchedAt, 111); // 更早的 touch 保留
    assert.strictEqual(r.sweptAt, 222);
});

/* ---------- 纯函数：不修改入参 ---------- */

test('不修改传入的 liquidity / candle', function () {
    var l = liquidity('BSL', 100);
    var snapshotL = JSON.stringify(l);
    var c = candle(101, 99, 100.6, 12345);
    var snapshotC = JSON.stringify(c);
    lifecycle.evaluateLiquidity(l, c);
    assert.strictEqual(JSON.stringify(l), snapshotL);
    assert.strictEqual(JSON.stringify(c), snapshotC);
    assert.strictEqual(l.status, 'ACTIVE'); // 状态仍为 ACTIVE
});

console.log('----');
console.log('liquidityLifecycle: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) {
    process.exit(1);
}
