/**
 * Replay Integrity Integration Tests（Phase 11R.1）
 *
 * 锁死三个审计问题的回归：
 *   1. P0：incrementalFvg 必须用当前 [index-2, index]（全局语义），
 *      不能 slice(-3) 取数据集最后三根
 *   2. displacement 关联必须用全局 candleIndex（tail 切片时）
 *   3. FVG lifecycle 从 formation candle 之后一根开始（formation ≠ mitigation）
 *   4. ATR warmup：startIndex 处 ATR 必须已 seed（非 TR/14 错误值）
 */
var assert = require('assert');
var replayState = require('../replay/replayState');
var fvgRegistry = require('../fvg/fvgRegistry');
var eventRegistry = require('../events/eventRegistry');
var replayEngine = require('../replay/replayEngine');
var atrIndicator = require('../indicators/atr');

var tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

function runTest(t) {
    try {
        t.fn();
        console.log('PASS  ' + t.name);
        return true;
    } catch (e) {
        console.log('FAIL  ' + t.name);
        console.log('      ' + (e && e.message ? e.message : e));
        return false;
    }
}

/* ---------------- helpers ---------------- */

var BAR = 300000;

function m5(open, high, low, close, i) {
    var t = 1000000 + i * BAR;
    return {
        openTime: t, open: open, high: high, low: low, close: close,
        closeTime: t + BAR - 1, closed: true, source: 'futures'
    };
}

/**
 * 构造 6 根 K：
 *   index=2 形成 Bullish FVG A（c0.high=100 < c2.low=110）
 *   index=5 形成 Bullish FVG B（c3.high=120 < c5.low=130）
 * 中间根不产生缺口。
 */
function fvgTimelineCandles() {
    return [
        m5(98, 100, 97, 99, 0),    // c0: high 100
        m5(101, 104, 100, 103, 1), // c1
        m5(108, 112, 107, 111, 2), // c2: low 110 → FVG A [100, 110]
        m5(113, 120, 112, 119, 3), // c3: high 120
        m5(121, 124, 120, 123, 4), // c4
        m5(128, 132, 127, 131, 5)  // c5: low 130 → FVG B [120, 130]
    ];
}

function makeState(index) {
    var state = replayState.createReplayState({ symbol: 'BTCUSDT', timeframe: '5m' });
    state.eventRegistry = eventRegistry.createEventRegistry();
    state.fvgReg = fvgRegistry.createFvgRegistry();
    return state;
}

/* ================= 1. P0: slice(-3) 修复 ================= */

test('P0：index=2 只形成 FVG A，不能拿到"数据集最后三根"的 FVG B', function () {
    var candles = fvgTimelineCandles();
    var state = makeState(2);

    replayState.incrementalFvg(state, candles, candles[2], 2, candles[2].closeTime, { tickSize: 0.1 }, []);

    var all = state.fvgReg.getAll('BTCUSDT');
    assert.strictEqual(all.length, 1, 'index=2 应只有 1 个 FVG');
    assert.strictEqual(all[0].zoneLow, 100);
    assert.strictEqual(all[0].zoneHigh, 107); // c2.low
    assert.strictEqual(all[0].candleIndex, 2);
});

test('P0：index=5 时 FVG A 与 FVG B 都在，且各自 candleIndex 正确', function () {
    var candles = fvgTimelineCandles();
    var state = makeState(5);

    replayState.incrementalFvg(state, candles, candles[2], 2, candles[2].closeTime, { tickSize: 0.1 }, []);
    replayState.incrementalFvg(state, candles, candles[5], 5, candles[5].closeTime, { tickSize: 0.1 }, []);

    var all = state.fvgReg.getAll('BTCUSDT');
    assert.strictEqual(all.length, 2);
    var a = all.filter(function (f) { return f.zoneLow === 100; })[0];
    var b = all.filter(function (f) { return f.zoneLow === 120; })[0];
    assert.ok(a && a.candleIndex === 2);
    assert.ok(b && b.candleIndex === 5);
});

test('P0：index=5 时重复调用不产生重复 FVG（id 去重）', function () {
    var candles = fvgTimelineCandles();
    var state = makeState(5);
    replayState.incrementalFvg(state, candles, candles[2], 2, candles[2].closeTime, { tickSize: 0.1 }, []);
    replayState.incrementalFvg(state, candles, candles[5], 5, candles[5].closeTime, { tickSize: 0.1 }, []);
    replayState.incrementalFvg(state, candles, candles[5], 5, candles[5].closeTime, { tickSize: 0.1 }, []);
    assert.strictEqual(state.fvgReg.size(), 2);
});

/* ================= 2. displacement 全局索引关联 ================= */

test('P0：displacement 关联用全局 candleIndex（tail 切片不破坏）', function () {
    var candles = fvgTimelineCandles();
    var state = makeState(2);
    // displacement 事件在全局 index=2（与 FVG 同根）
    var disp = {
        id: 'D1', symbol: 'BTCUSDT', timeframe: '5m', type: 'DISPLACEMENT',
        direction: 'BULLISH', candleIndex: 2,
        confirmedAt: candles[2].closeTime, price: 111,
        source: {}, metadata: {}
    };
    state.eventRegistry.add(disp);

    replayState.incrementalFvg(state, candles, candles[2], 2, candles[2].closeTime,
        { tickSize: 0.1 }, state.eventRegistry.getByType('BTCUSDT', 'DISPLACEMENT'));

    var f = state.fvgReg.getByDirection('BTCUSDT', 'BULLISH')[0];
    assert.strictEqual(f.displacementEventId, 'D1');
});

test('P0：不同根 displacement 不关联（>2 bars）', function () {
    var candles = fvgTimelineCandles();
    var state = makeState(2);
    var disp = {
        id: 'D_EARLY', symbol: 'BTCUSDT', timeframe: '5m', type: 'DISPLACEMENT',
        direction: 'BULLISH', candleIndex: -5, // 远在 2 bars 前
        confirmedAt: candles[0].closeTime, price: 100, source: {}, metadata: {}
    };
    state.eventRegistry.add(disp);
    replayState.incrementalFvg(state, candles, candles[2], 2, candles[2].closeTime,
        { tickSize: 0.1 }, state.eventRegistry.getByType('BTCUSDT', 'DISPLACEMENT'));
    var f = state.fvgReg.getByDirection('BTCUSDT', 'BULLISH')[0];
    assert.strictEqual(f.displacementEventId, null);
});

/* ================= 3. lifecycle formation candle 跳过 ================= */

test('P0：formation candle 不评估自身 lifecycle（新 FVG 保持 ACTIVE）', function () {
    var candles = fvgTimelineCandles();
    var state = makeState(2);
    // c2.low=105：> c0.high 100（形成缺口 FVG [100,105]），
    // 且 low=105 <= zoneHigh 105 → 若被同根评估会标 TOUCHED。
    // 修复后 formation candle 不评估 → 保持 ACTIVE。
    candles[2] = m5(108, 112, 105, 111, 2);

    replayState.incrementalFvg(state, candles, candles[2], 2, candles[2].closeTime, { tickSize: 0.1 }, []);
    var all = state.fvgReg.getAll('BTCUSDT');
    assert.strictEqual(all.length, 1);
    var f = all[0];
    assert.strictEqual(f.status, 'ACTIVE', 'formation candle 不能把 FVG 标 TOUCHED');
    assert.strictEqual(f.touchedAt, null);

    // 下一根 c3 才可能触发 lifecycle（c3.low=112 > zoneHigh 105 → 仍未 touch）
    replayState.incrementalFvg(state, candles, candles[3], 3, candles[3].closeTime, { tickSize: 0.1 }, []);
    assert.strictEqual(f.status, 'ACTIVE');
});

/* ================= 4. ATR warmup ================= */

test('P0/P1：warmup 后 startIndex 处 ATR 与全量计算一致（非 TR/14 错误值）', function () {
    // 构造 40 根波动数据
    var candles = [];
    var i;
    var price = 100;
    for (i = 0; i < 40; i++) {
        var o = price;
        var c = price + (i % 5 === 0 ? -8 : 6);
        candles.push(m5(o, Math.max(o, c) + 3, Math.min(o, c) - 3, c, i));
        price = c;
    }
    // 模拟 warmup：0 → 19（startIndex=20）
    var atrSeries = {};
    var prev = null;
    var k;
    for (k = 0; k < 20; k++) {
        prev = replayEngine._updateAtrIncremental(atrSeries, candles, k, prev, 14);
    }
    // 增量值 vs 全量值（endIndex=19）
    var full = atrIndicator.atr(candles, 14, 19);
    assert.ok(Math.abs(atrSeries[19] - full) < 1e-9, 'warmup ATR=' + atrSeries[19] + ' full=' + full);
    // 关键：不能是 TR/14（错误初始化）
    var wrong = atrIndicator.trueRange(candles[19], candles[18]) / 14;
    assert.ok(Math.abs(atrSeries[19] - wrong) > 1, '不能是 TR/14 错误值');
});

/* ---------------- Phase 11T.5R：P0 signal-candle self-fill ---------------- */

test('P0 (11T.5R)：信号 K 禁止 self-fill —— candle N 穿 entry 不成交，N+1 才成交', function () {
    var thresholds = require('../config/thresholds');
    var pending = {
        plan: { direction: 'LONG', entry: { price: 100 }, stop: { price: 99 }, target: { price: 105 }, rr: 5 },
        phase: 'WAIT_ENTRY',
        waitBars: 0, holdBars: 0, mae: 0, mfe: 0,
        entryAt: null,
        entryIndex: 10, // plan 在 index 10 收盘后创建
        diagnostics: {}, context: {}, cancelCheck: null
    };
    var state = { pendingTrade: pending, trades: [], symbol: 'BTCUSDT' };

    // candle 10（信号 K）range 穿 entry（low 98 <= 100 <= high 101）
    // → P0 修复后：index <= entryIndex → 不 fill、不 waitBars++
    var r1 = replayState.updatePendingTrade(state, m5(99, 101, 98, 100, 10), 10, { thresholds: thresholds });
    assert.strictEqual(r1, null, '信号 K 不得成交');
    assert.strictEqual(pending.phase, 'WAIT_ENTRY', '信号 K 后仍在等待');
    assert.strictEqual(pending.waitBars, 0, '信号 K 不计入等待');

    // candle 11 range 穿 entry → 成交
    var r2 = replayState.updatePendingTrade(state, m5(99, 101, 98, 100, 11), 11, { thresholds: thresholds });
    assert.strictEqual(pending.phase, 'OPEN', 'N+1 应成交');
    assert.ok(pending.entryAt, 'entryAt 应已设置');
});

test('P0 (11T.5R)：SHORT 同理 —— 信号 K 不成交，N+1 成交', function () {
    var thresholds = require('../config/thresholds');
    var pending = {
        plan: { direction: 'SHORT', entry: { price: 100 }, stop: { price: 101 }, target: { price: 95 }, rr: 5 },
        phase: 'WAIT_ENTRY',
        waitBars: 0, holdBars: 0, mae: 0, mfe: 0,
        entryAt: null,
        entryIndex: 10,
        diagnostics: {}, context: {}, cancelCheck: null
    };
    var state = { pendingTrade: pending, trades: [], symbol: 'BTCUSDT' };
    var r1 = replayState.updatePendingTrade(state, m5(101, 102, 99, 101, 10), 10, { thresholds: thresholds });
    assert.strictEqual(r1, null);
    assert.strictEqual(pending.phase, 'WAIT_ENTRY');
    var r2 = replayState.updatePendingTrade(state, m5(101, 102, 99, 101, 11), 11, { thresholds: thresholds });
    assert.strictEqual(pending.phase, 'OPEN');
});

/* ---------------- run ---------------- */

var passCount = 0;
tests.forEach(function (t) {
    if (runTest(t)) {
        passCount++;
    }
});

console.log('--------------------------------');
console.log(passCount + ' / ' + tests.length + ' passed');
if (passCount !== tests.length) {
    process.exit(1);
}
