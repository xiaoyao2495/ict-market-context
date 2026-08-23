/**
 * eventEngine + deliveryBias(registry) 集成测试
 *
 * 完整 bullish 链：SSL Sweep → Bullish MSS → Bullish Displacement → delivery +25
 */
var assert = require('assert');
var eventEngine = require('../events/eventEngine');
var eventRegistry = require('../events/eventRegistry');
var liquidityRegistry = require('../liquidity/liquidityRegistry');
var deliveryBias = require('../bias/deliveryBias');

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

function m5(open, high, low, close, openTime, closed) {
    return {
        openTime: openTime,
        open: open,
        high: high,
        low: low,
        close: close,
        closeTime: openTime + BAR - 1,
        closed: closed !== false,
        source: 'futures'
    };
}

/**
 * 构造 bullish delivery 链环境：
 * 15 根平缓（ATR≈10，close 始终 < 105）→ c15 SSL sweep → c16 bullish MSS → c17 大 bullish displacement
 */
function bullishContext() {
    var candles = [];
    var i;
    for (i = 0; i < 15; i++) {
        // open/low/close = 85+i（max 99），high = 95+i → close 从不破 105，range 恒 10
        candles.push(m5(85 + i, 95 + i, 85 + i, 85 + i, 1000000 + i * BAR));
    }
    candles.push(m5(85, 86, 80, 86.5, 1000000 + 15 * BAR)); // SSL sweep（PDL 84：low 80 < 84 && close 86.5 > 84）
    candles.push(m5(103, 108, 102, 107, 1000000 + 16 * BAR)); // bullish MSS（破 swing high 105）
    candles.push(m5(105, 135, 104, 133, 1000000 + 17 * BAR)); // 大 bullish displacement

    // SSL liquidity（price 84，base close min 85 从不破它）
    var liqReg = liquidityRegistry.createRegistry();
    liqReg.add({
        id: 'BTCUSDT:PDL:2026-08-17',
        symbol: 'BTCUSDT',
        timeframe: '1d',
        type: 'PDL',
        side: 'SSL',
        price: 84,
        confirmedAt: candles[10].closeTime,
        status: 'ACTIVE',
        touchedAt: null,
        sweptAt: null,
        brokenAt: null,
        metadata: {}
    });

    // swing high reference（confirmedAt 早于 MSS candle，且 base close 从不突破）
    var swings = [{
        id: 'BTCUSDT:5m:SWING_HIGH:1',
        symbol: 'BTCUSDT',
        timeframe: '5m',
        type: 'SWING_HIGH',
        side: 'BSL',
        price: 105,
        confirmedAt: candles[5].closeTime,
        status: 'ACTIVE',
        touchedAt: null,
        sweptAt: null,
        brokenAt: null,
        metadata: {}
    }];

    return { candles: candles, swings: swings, liquidityRegistry: liqReg };
}

/* ---------- 完整 bullish 链 ---------- */

test('eventEngine：SSL sweep → bullish MSS → bullish displacement 三类事件', function () {
    var ctx = bullishContext();
    var out = eventEngine.runEventEngine({
        symbol: 'BTCUSDT',
        timeframe: '5m',
        candles: ctx.candles,
        swings: ctx.swings,
        liquidityRegistry: ctx.liquidityRegistry
    });
    var reg = out.eventRegistry;

    var sweeps = reg.getByType('BTCUSDT', 'LIQUIDITY_SWEEP');
    var mss = reg.getByType('BTCUSDT', 'MSS');
    var disps = reg.getByType('BTCUSDT', 'DISPLACEMENT');

    assert.strictEqual(sweeps.length, 1);
    assert.strictEqual(sweeps[0].direction, 'BULLISH'); // SSL sweep
    assert.strictEqual(sweeps[0].confirmedAt, 1000000 + 15 * BAR + BAR - 1);

    assert.strictEqual(mss.length, 1);
    assert.strictEqual(mss[0].direction, 'BULLISH');

    // c16（same-candle MSS 加分）与 c17（大幅）都可能产生 bullish displacement
    assert.ok(disps.length >= 1);
    var lastDisp = disps[disps.length - 1];
    assert.strictEqual(lastDisp.direction, 'BULLISH');
    assert.ok(lastDisp.metadata.score >= 3);
});

test('deliveryBias 消费 Event Registry：完整 bullish 链 → +25', function () {
    var ctx = bullishContext();
    var out = eventEngine.runEventEngine({
        symbol: 'BTCUSDT',
        timeframe: '5m',
        candles: ctx.candles,
        swings: ctx.swings,
        liquidityRegistry: ctx.liquidityRegistry
    });
    var evalTime = ctx.candles[17].closeTime + 1; // 刚完成 → ageBars 0
    var delivery = deliveryBias.scoreDeliveryBias({
        symbol: 'BTCUSDT',
        evaluationTime: evalTime,
        timeframe: '5m',
        eventRegistry: out.eventRegistry
    }, {});
    assert.strictEqual(delivery.available, true);
    assert.strictEqual(delivery.direction, 'BULLISH');
    assert.strictEqual(delivery.rawScore, 25);
    assert.strictEqual(delivery.score, 25);
    assert.ok(delivery.sweep && delivery.mss && delivery.displacement);
});

test('deliveryBias 数组接口向后兼容（不破坏）', function () {
    var ctx = bullishContext();
    var out = eventEngine.runEventEngine({
        symbol: 'BTCUSDT',
        timeframe: '5m',
        candles: ctx.candles,
        swings: ctx.swings,
        liquidityRegistry: ctx.liquidityRegistry
    });
    var reg = out.eventRegistry;
    var evalTime = ctx.candles[17].closeTime + 1;
    // 数组接口
    var delivery1 = deliveryBias.scoreDeliveryBias({
        evaluationTime: evalTime,
        timeframe: '5m',
        events: {
            sweeps: reg.getByType('BTCUSDT', 'LIQUIDITY_SWEEP'),
            mss: reg.getByType('BTCUSDT', 'MSS'),
            displacements: reg.getByType('BTCUSDT', 'DISPLACEMENT')
        }
    }, {});
    // registry 接口
    var delivery2 = deliveryBias.scoreDeliveryBias({
        symbol: 'BTCUSDT',
        evaluationTime: evalTime,
        timeframe: '5m',
        eventRegistry: reg
    }, {});
    assert.strictEqual(delivery1.score, delivery2.score);
    assert.strictEqual(delivery2.score, 25);
});

/* ---------- bearish 链 ---------- */

test('eventEngine：bearish 链（BSL sweep → bearish MSS → bearish displacement）→ -25', function () {
    var candles = [];
    var i;
    for (i = 0; i < 15; i++) {
        // open/low/close = 125-i（min 111），high = 135-i → close 从不破 108，range 恒 10
        candles.push(m5(125 - i, 135 - i, 125 - i, 125 - i, 2000000 + i * BAR));
    }
    candles.push(m5(124, 128, 123, 124.5, 2000000 + 15 * BAR)); // BSL sweep（PDH 126：high 128 > 126 && close 124.5 < 126）
    candles.push(m5(110, 111, 104, 105, 2000000 + 16 * BAR)); // bearish MSS（破 swing low 108）
    candles.push(m5(108, 110, 75, 78, 2000000 + 17 * BAR)); // 大 bearish displacement

    var liqReg = liquidityRegistry.createRegistry();
    liqReg.add({
        id: 'BTCUSDT:PDH:2026-08-17',
        symbol: 'BTCUSDT', timeframe: '1d', type: 'PDH', side: 'BSL', price: 126,
        confirmedAt: candles[10].closeTime, status: 'ACTIVE',
        touchedAt: null, sweptAt: null, brokenAt: null, metadata: {}
    });
    var swings = [{
        id: 'BTCUSDT:5m:SWING_LOW:1',
        symbol: 'BTCUSDT', timeframe: '5m', type: 'SWING_LOW', side: 'SSL', price: 108,
        confirmedAt: candles[5].closeTime, status: 'ACTIVE',
        touchedAt: null, sweptAt: null, brokenAt: null, metadata: {}
    }];

    var out = eventEngine.runEventEngine({
        symbol: 'BTCUSDT', timeframe: '5m',
        candles: candles, swings: swings, liquidityRegistry: liqReg
    });

    var delivery = deliveryBias.scoreDeliveryBias({
        symbol: 'BTCUSDT',
        evaluationTime: candles[17].closeTime + 1,
        timeframe: '5m',
        eventRegistry: out.eventRegistry
    }, {});
    assert.strictEqual(delivery.direction, 'BEARISH');
    assert.strictEqual(delivery.score, -25);
});

/* ---------- 方向不匹配 / 未来事件 ---------- */

test('eventEngine：sweep 与 MSS 方向不匹配 → 无完整链', function () {
    var ctx = bullishContext();
    // 把 MSS 环境改成 bearish：在 sweep 后加一根跌破 swing low 的 candle
    var candles = ctx.candles.slice(0, 16); // 到 sweep 为止
    candles.push(m5(100, 101, 94, 95, 1000000 + 16 * BAR)); // bearish 下跌 candle（但无 swing low reference → 无 MSS）
    var out = eventEngine.runEventEngine({
        symbol: 'BTCUSDT', timeframe: '5m',
        candles: candles, swings: ctx.swings, liquidityRegistry: ctx.liquidityRegistry
    });
    var delivery = deliveryBias.scoreDeliveryBias({
        symbol: 'BTCUSDT',
        evaluationTime: candles[16].closeTime + 1,
        timeframe: '5m',
        eventRegistry: out.eventRegistry
    }, {});
    // 有 sweep（BULLISH）但无匹配 MSS → 只有 sweep-only 链
    assert.strictEqual(delivery.rawScore, 8);
    assert.strictEqual(delivery.mss, null);
});

test('未来事件（confirmedAt > evaluationTime）不参与 delivery', function () {
    var reg = eventRegistry.createEventRegistry();
    reg.add({
        id: 'F1', symbol: 'BTCUSDT', timeframe: '5m', type: 'MSS', direction: 'BULLISH',
        confirmedAt: 9999999999999, occurredAt: 0, candleIndex: 0, price: 100, source: {}, metadata: {}
    });
    var delivery = deliveryBias.scoreDeliveryBias({
        symbol: 'BTCUSDT',
        evaluationTime: 5000,
        timeframe: '5m',
        eventRegistry: reg
    }, {});
    assert.strictEqual(delivery.available, false); // 全被过滤
});

test('eventEngine：deterministic（相同输入状态 → 相同事件）', function () {
    // eventEngine 会推进（修改）传入的 liquidityRegistry，
    // 因此每次 run 需用相同初始状态（fresh context）
    var run = function () {
        var ctx = bullishContext();
        return eventEngine.runEventEngine({
            symbol: 'BTCUSDT', timeframe: '5m',
            candles: ctx.candles, swings: ctx.swings, liquidityRegistry: ctx.liquidityRegistry
        });
    };
    var o1 = run();
    var o2 = run();
    assert.strictEqual(o1.eventRegistry.size(), o2.eventRegistry.size());
    assert.strictEqual(o1.mssEvents.length, o2.mssEvents.length);
    assert.strictEqual(o1.mssEvents[0].id, o2.mssEvents[0].id);
    assert.strictEqual(o1.displacementEvents.length, o2.displacementEvents.length);
});

console.log('----');
console.log('eventEngine integration: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) {
    process.exit(1);
}
