/**
 * eventRegistry + sweepEventAdapter 单元测试
 */
var assert = require('assert');
var eventRegistry = require('../events/eventRegistry');
var sweepEventAdapter = require('../events/sweepEventAdapter');

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

function event(id, type, direction, confirmedAt) {
    return {
        id: id,
        symbol: 'BTCUSDT',
        timeframe: '5m',
        type: type,
        direction: direction,
        occurredAt: confirmedAt - 300000,
        confirmedAt: confirmedAt,
        candleIndex: 0,
        price: 100,
        source: {},
        metadata: {}
    };
}

/* ---------- registry 基础 ---------- */

test('add / dedupe：相同 id 不重复加入', function () {
    var r = eventRegistry.createEventRegistry();
    assert.strictEqual(r.add(event('e1', 'MSS', 'BULLISH', 1000)), true);
    assert.strictEqual(r.add(event('e1', 'MSS', 'BULLISH', 1000)), false);
    assert.strictEqual(r.size(), 1);
});

test('addMany：返回实际加入数', function () {
    var r = eventRegistry.createEventRegistry();
    var list = [
        event('e1', 'MSS', 'BULLISH', 1000),
        event('e2', 'MSS', 'BEARISH', 2000),
        event('e1', 'MSS', 'BULLISH', 1000) // 重复
    ];
    assert.strictEqual(r.addMany(list), 2);
});

test('getByType / getByDirection / getById', function () {
    var r = eventRegistry.createEventRegistry();
    r.add(event('e1', 'MSS', 'BULLISH', 1000));
    r.add(event('e2', 'DISPLACEMENT', 'BULLISH', 2000));
    r.add(event('e3', 'MSS', 'BEARISH', 3000));
    assert.strictEqual(r.getByType('BTCUSDT', 'MSS').length, 2);
    assert.strictEqual(r.getByDirection('BTCUSDT', 'BULLISH').length, 2);
    assert.strictEqual(r.getById('e2').type, 'DISPLACEMENT');
    assert.strictEqual(r.getById('NOPE'), null);
});

test('getBefore：confirmedAt > evaluationTime 不返回（防未来数据）', function () {
    var r = eventRegistry.createEventRegistry();
    r.add(event('e1', 'MSS', 'BULLISH', 1000));
    r.add(event('e2', 'MSS', 'BEARISH', 9999999999999)); // 未来
    var before = r.getBefore('BTCUSDT', 5000);
    assert.strictEqual(before.length, 1);
    assert.strictEqual(before[0].id, 'e1');
});

test('getRecent：类型过滤 + limit + 升序', function () {
    var r = eventRegistry.createEventRegistry();
    r.add(event('e1', 'MSS', 'BULLISH', 1000));
    r.add(event('e2', 'MSS', 'BULLISH', 2000));
    r.add(event('e3', 'MSS', 'BULLISH', 3000));
    r.add(event('e4', 'DISPLACEMENT', 'BULLISH', 4000));
    var recent = r.getRecent('BTCUSDT', 'MSS', 9999999999999, 2);
    assert.strictEqual(recent.length, 2);
    assert.strictEqual(recent[0].id, 'e2'); // 升序取末尾 2 条
    assert.strictEqual(recent[1].id, 'e3');
});

test('getRecent：evaluationTime 过滤 + 无 limit 全量', function () {
    var r = eventRegistry.createEventRegistry();
    r.add(event('e1', 'MSS', 'BULLISH', 1000));
    r.add(event('e2', 'MSS', 'BULLISH', 9999999999999));
    var recent = r.getRecent('BTCUSDT', null, 5000, undefined);
    assert.strictEqual(recent.length, 1);
});

/* ---------- sweepEventAdapter ---------- */

function liq(id, type, side, price, timeframe) {
    return {
        id: id,
        symbol: 'BTCUSDT',
        timeframe: timeframe || '5m',
        type: type,
        side: side,
        price: price,
        status: 'SWEPT',
        sweptAt: 12345,
        metadata: {}
    };
}

function candle(open, high, low, close, openTime) {
    return {
        openTime: openTime,
        open: open,
        high: high,
        low: low,
        close: close,
        closeTime: openTime + 300000 - 1,
        closed: true
    };
}

test('BSL sweep → direction BEARISH，side 保留，confirmedAt = closeTime', function () {
    var l = liq('L1', 'PDH', 'BSL', 63390);
    var c = candle(63300, 63400, 63250, 63320, 1000000);
    var ev = sweepEventAdapter.buildSweepEvent(l, c, 42);
    assert.ok(ev);
    assert.strictEqual(ev.type, 'LIQUIDITY_SWEEP');
    assert.strictEqual(ev.direction, 'BEARISH');
    assert.strictEqual(ev.side, 'BSL'); // 顶层保留
    assert.strictEqual(ev.liquidityId, 'L1'); // 顶层保留
    assert.strictEqual(ev.source.side, 'BSL');
    assert.strictEqual(ev.source.liquidityId, 'L1');
    assert.strictEqual(ev.source.liquidityType, 'PDH');
    assert.strictEqual(ev.source.liquidityPrice, 63390);
    assert.strictEqual(ev.price, 63390);
    assert.strictEqual(ev.confirmedAt, 1000000 + 300000 - 1); // candle.closeTime
    assert.strictEqual(ev.candleIndex, 42);
    assert.strictEqual(ev.occurredAt, 1000000); // candle.openTime
});

test('SSL sweep → direction BULLISH', function () {
    var l = liq('L2', 'PDL', 'SSL', 62716);
    var c = candle(62800, 62850, 62600, 62750, 2000000);
    var ev = sweepEventAdapter.buildSweepEvent(l, c, 7);
    assert.strictEqual(ev.direction, 'BULLISH');
    assert.strictEqual(ev.side, 'SSL');
});

test('未收盘 candle → null', function () {
    var l = liq('L1', 'PDH', 'BSL', 100);
    var c = candle(100, 101, 99, 100.5, 3000000);
    c.closed = false;
    assert.strictEqual(sweepEventAdapter.buildSweepEvent(l, c, 0), null);
});

test('sweep 事件 id 确定性（liquidityId 唯一）', function () {
    var l = liq('L1', 'PDH', 'BSL', 63390);
    var c = candle(100, 101, 99, 100.5, 4000000);
    var ev = sweepEventAdapter.buildSweepEvent(l, c, 1);
    assert.strictEqual(ev.id, 'BTCUSDT:5m:SWEEP:L1');
});

console.log('----');
console.log('eventRegistry/sweepAdapter: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) {
    process.exit(1);
}
