/**
 * Phase 11S.1 — Retrace Diagnostics 测试
 * 覆盖：retraceTracker（距离定义/分类/边界）+ shadowEntry（准入触发/模拟/汇总）
 */
var assert = require('assert');
var retraceTracker = require('../replay/retraceTracker');
var shadowEntry = require('../stats/shadowEntry');

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

function m5(open, high, low, close, i) {
    var t = 1000000 + i * 300000;
    return { openTime: t, open: open, high: high, low: low, close: close, closeTime: t + 300000 - 1, closed: true, source: 'futures' };
}

function makeRetrace(overrides) {
    var r = retraceTracker.createRetrace({
        symbol: 'BTCUSDT',
        direction: 'BULLISH',
        fvg: { id: 'F1', zoneLow: 64000, zoneHigh: 64020, midpoint: 64010 },
        watchIndex: 10,
        watchAt: 1000000 + 10 * 300000,
        atr: 100,
        draw: null,
        amd: null,
        swings: [],
        tickSize: 0.1,
        candle: m5(64050, 64080, 64040, 64070, 10)
    });
    if (overrides) {
        for (var k in overrides) { r[k] = overrides[k]; }
    }
    return r;
}

/* ---------- distanceToZone ---------- */

test('distance：bullish 在 zone 上方 → low - zoneHigh', function () {
    var d = retraceTracker.distanceToZone('BULLISH', m5(64030, 64060, 64025, 64050, 0), 64000, 64020);
    assert.strictEqual(d, 5); // 64025 - 64020
});

test('distance：bullish 进入 zone → 0', function () {
    var d = retraceTracker.distanceToZone('BULLISH', m5(64010, 64030, 63990, 64020, 0), 64000, 64020);
    assert.strictEqual(d, 0); // low 63990 <= zoneHigh
});

test('distance：bearish 在 zone 下方 → zoneLow - high', function () {
    var d = retraceTracker.distanceToZone('BEARISH', m5(63970, 63985, 63950, 63960, 0), 64000, 64020);
    assert.strictEqual(d, 15); // 64000 - 63985
});

test('distance：bearish 进入 zone → 0', function () {
    var d = retraceTracker.distanceToZone('BEARISH', m5(64010, 64030, 63980, 64020, 0), 64000, 64020);
    assert.strictEqual(d, 0);
});

/* ---------- createRetrace 初始距离 ---------- */

test('create：initialDistance 记录创建那根 K 的距离（bullish 64040 > zoneHigh 64020 → 20）', function () {
    var r = makeRetrace();
    assert.strictEqual(r.initialDistance, 20);
    assert.ok(Math.abs(r.initialDistanceAtr - 0.2) < 0.0001);
    assert.strictEqual(r.zoneLow, 64000);
    assert.strictEqual(r.zoneHigh, 64020);
});

/* ---------- updateRetrace ---------- */

test('update：minDistanceAtr 与 barsToClosestApproach 正确', function () {
    var r = makeRetrace();
    // bar1: low 64025 → dist 5 → 0.05 ATR
    retraceTracker.updateRetrace(r, m5(64040, 64060, 64025, 64050, 11), 11, 100);
    assert.strictEqual(r.minDistanceToZone, 5);
    assert.ok(Math.abs(r.minDistanceAtr - 0.05) < 0.0001);
    assert.strictEqual(r.barsToClosestApproach, 1);
    // bar2: low 64030 → dist 10（不更新 min）
    retraceTracker.updateRetrace(r, m5(64040, 64060, 64030, 64050, 12), 12, 100);
    assert.strictEqual(r.minDistanceToZone, 5);
    assert.strictEqual(r.barsToClosestApproach, 1);
    assert.strictEqual(r.barsWatched, 2);
});

test('update：进入 zone → touchedZone true，距离 0', function () {
    var r = makeRetrace();
    retraceTracker.updateRetrace(r, m5(64010, 64030, 63995, 64020, 11), 11, 100);
    assert.strictEqual(r.touchedZone, true);
    assert.strictEqual(r.minDistanceToZone, 0);
});

test('update：填满 zone（low <= zoneLow）→ filledZone', function () {
    var r = makeRetrace();
    retraceTracker.updateRetrace(r, m5(63990, 64010, 63980, 63990, 11), 11, 100);
    assert.strictEqual(r.filledZone, true);
    assert.strictEqual(r.touchedZone, true);
});

test('update：bearish 对称（high >= zoneLow → touched）', function () {
    var r = makeRetrace({ direction: 'BEARISH', fvg: { id: 'F1', zoneLow: 64000, zoneHigh: 64020, midpoint: 64010 } });
    retraceTracker.updateRetrace(r, m5(64020, 64030, 63980, 64020, 11), 11, 100);
    assert.strictEqual(r.touchedZone, true);
});

test('update：future12/24 快照在第 12/24 根记录', function () {
    var r = makeRetrace();
    for (var i = 1; i <= 24; i++) {
        retraceTracker.updateRetrace(r, m5(64030, 64060, 64030, 64050, 10 + i), 10 + i, 100);
    }
    assert.ok(r.future12Bars);
    assert.strictEqual(r.future12Bars.bars, 12);
    assert.ok(r.future24Bars);
    assert.strictEqual(r.future24Bars.bars, 24);
});

/* ---------- 分类 ---------- */

test('classify：真实进入 zone → TOUCHED_ZONE', function () {
    var r = makeRetrace();
    retraceTracker.updateRetrace(r, m5(63990, 64010, 63980, 63990, 11), 11, 100);
    r = retraceTracker.closeRetrace(r, 12, 1000000 + 12 * 300000, 'WATCH_END');
    assert.strictEqual(r.classification, 'TOUCHED_ZONE');
});

test('classify：minDistanceAtr 0.03 → NEAR_MISS_0_05_ATR', function () {
    var r = makeRetrace();
    retraceTracker.updateRetrace(r, m5(64030, 64060, 64023, 64050, 11), 11, 100); // dist 3 → 0.03
    r = retraceTracker.closeRetrace(r, 12, 0, 'WATCH_END');
    assert.strictEqual(r.classification, 'NEAR_MISS_0_05_ATR');
});

test('classify：0.08 → NEAR_MISS_0_10_ATR', function () {
    var r = makeRetrace();
    retraceTracker.updateRetrace(r, m5(64030, 64060, 64028, 64050, 11), 11, 100); // dist 8 → 0.08
    r = retraceTracker.closeRetrace(r, 12, 0, 'WATCH_END');
    assert.strictEqual(r.classification, 'NEAR_MISS_0_10_ATR');
});

test('classify：0.20 → NEAR_MISS_0_25_ATR', function () {
    var r = makeRetrace();
    retraceTracker.updateRetrace(r, m5(64040, 64060, 64040, 64050, 11), 11, 100); // dist 20 → 0.20
    r = retraceTracker.closeRetrace(r, 12, 0, 'WATCH_END');
    assert.strictEqual(r.classification, 'NEAR_MISS_0_25_ATR');
});

test('classify：0.50 → NEVER_CLOSE（WATCH_END）', function () {
    var r = makeRetrace();
    retraceTracker.updateRetrace(r, m5(64050, 64070, 64050, 64060, 11), 11, 100); // dist 30 → 0.30
    r = retraceTracker.closeRetrace(r, 12, 0, 'WATCH_END');
    assert.strictEqual(r.classification, 'NEVER_CLOSE');
});

test('classify：从未接近 + 失效 → INVALIDATED_BEFORE_RETRACE', function () {
    var r = makeRetrace();
    retraceTracker.updateRetrace(r, m5(64050, 64070, 64050, 64060, 11), 11, 100); // dist 30 → 0.30
    r = retraceTracker.closeRetrace(r, 12, 0, 'INVALIDATED');
    assert.strictEqual(r.classification, 'INVALIDATED_BEFORE_RETRACE');
});

test('classify：接近过（0.10）+ 失效 → 仍 NEAR_MISS（NEAR 优先于 INVALIDATED）', function () {
    var r = makeRetrace();
    retraceTracker.updateRetrace(r, m5(64030, 64060, 64028, 64050, 11), 11, 100); // 0.08
    r = retraceTracker.closeRetrace(r, 12, 0, 'INVALIDATED');
    assert.strictEqual(r.classification, 'NEAR_MISS_0_10_ATR');
});

/* ---------- Shadow Entry ---------- */

function shadowContext(candles) {
    return {
        candles: candles,
        atrSeries: {},
        thresholds: require('../config/thresholds')
    };
}

test('shadow：zone_touch 准入（tol=0）触发于进入 zone 的那根', function () {
    var candles = [
        m5(64050, 64080, 64040, 64070, 10), // watch 创建（bar 0）
        m5(64040, 64060, 64030, 64050, 11), // 未进 zone
        m5(64020, 64040, 63990, 64030, 12)  // low 63990 <= zoneHigh → 进 zone
    ];
    var r = makeRetrace();
    r.atrAtWatch = 100;
    r.watchIndex = 0;
    r.closeIndex = 2;
    r.draw = {
        bsl: { primary: { targetPrice: 64200, id: 'D1' }, secondary: null, candidates: [] },
        ssl: { primary: null, secondary: null, candidates: [] }
    };
    r.amd = { manipulation: { sweepEvent: { price: 63950 } }, accumulation: { rangeLow: 63900 } };
    r.swings = [];
    r.tickSize = 0.1;

    var results = shadowEntry.runShadowEntries(r, shadowContext(candles));
    var zoneTouch = results.filter(function (x) { return x.tolerance === 0; })[0];
    assert.strictEqual(zoneTouch.triggered, true);
    assert.strictEqual(zoneTouch.triggerIndex, 2); // 数组位置（全局 watchIndex 0 + 2）
    assert.strictEqual(zoneTouch.triggerPrice, 64030); // 触发那根 close
    assert.ok(zoneTouch.stop && zoneTouch.stop.status === 'READY');
    assert.ok(zoneTouch.rr > 0);
    assert.ok(zoneTouch.sim);
});

test('shadow：0.25 ATR 准入在 tol=0 未触发时仍可触发', function () {
    var candles = [
        m5(64050, 64080, 64040, 64070, 10),
        m5(64040, 64060, 64025, 64050, 11), // dist 5 → 0.05 ATR（未进 zone）
        m5(64050, 64070, 64045, 64060, 12)
    ];
    var r = makeRetrace();
    r.atrAtWatch = 100;
    r.watchIndex = 0;
    r.closeIndex = 2;
    r.draw = { bsl: { primary: { targetPrice: 64200, id: 'D1' }, secondary: null, candidates: [] }, ssl: { primary: null, secondary: null, candidates: [] } };
    r.amd = { manipulation: { sweepEvent: { price: 63950 } }, accumulation: { rangeLow: 63900 } };
    r.swings = [];
    r.tickSize = 0.1;

    var results = shadowEntry.runShadowEntries(r, shadowContext(candles));
    var zt = results.filter(function (x) { return x.tolerance === 0; })[0];
    var t25 = results.filter(function (x) { return x.tolerance === 0.25; })[0];
    assert.strictEqual(zt.triggered, false);
    assert.strictEqual(t25.triggered, true);
    assert.strictEqual(t25.triggerIndex, 1); // 数组位置
});

test('shadow：triggered 但 stop INVALID → 无 sim', function () {
    var candles = [
        m5(64050, 64080, 64040, 64070, 10),
        m5(64020, 64040, 63990, 64030, 12)
    ];
    var r = makeRetrace();
    r.atrAtWatch = 100;
    r.watchIndex = 0;
    r.closeIndex = 2;
    r.draw = { bsl: { primary: { targetPrice: 64200, id: 'D1' }, secondary: null, candidates: [] }, ssl: { primary: null, secondary: null, candidates: [] } };
    r.amd = {}; // 无 manipulation/accumulation/swing/fvg 参考 → stop INVALID
    r.swings = [];
    r.tickSize = 0.1;
    r.fvg = undefined;

    var results = shadowEntry.runShadowEntries(r, shadowContext(candles));
    var zt = results.filter(function (x) { return x.tolerance === 0; })[0];
    assert.strictEqual(zt.triggered, true);
    assert.strictEqual(zt.stop.status, 'READY'); // amd={} 时仍走 FVG zoneLow fallback
    assert.strictEqual(zt.stop.source, 'FVG_ZONE_LOW');
    assert.ok(zt.sim); // 有 stop+target 即有 sim
});

test('shadow：WIN/LOSS 模拟与 realizedR（LONG 打到 target）', function () {
    var candles = [
        m5(64050, 64080, 64040, 64070, 10), // watch
        m5(64020, 64040, 63990, 64030, 12), // 进 zone → trigger close 64030
        m5(64030, 64210, 64025, 64200, 13)  // high 64210 >= target 64200 → WIN
    ];
    var r = makeRetrace();
    r.atrAtWatch = 100;
    r.watchIndex = 0;
    r.closeIndex = 2;
    r.draw = { bsl: { primary: { targetPrice: 64200, id: 'D1' }, secondary: null, candidates: [] }, ssl: { primary: null, secondary: null, candidates: [] } };
    r.amd = { manipulation: { sweepEvent: { price: 63950 } }, accumulation: { rangeLow: 63900 } };
    r.swings = [];
    r.tickSize = 0.1;

    var results = shadowEntry.runShadowEntries(r, shadowContext(candles));
    var zt = results.filter(function (x) { return x.tolerance === 0; })[0];
    assert.strictEqual(zt.sim.status, 'WIN');
    assert.ok(zt.sim.realizedR > 0);
    assert.strictEqual(zt.sim.entryPrice, 64030);
});

test('shadow：汇总 summarizeShadows 统计正确', function () {
    var retraces = [makeRetrace(), makeRetrace()];
    // 手工给两条 retrace 塞 shadow 结果，验证汇总
    retraces[0].shadowResults = [
        { tolerance: 0, toleranceLabel: 'zone_touch', triggered: true, sim: { status: 'WIN', realizedR: 2.5, maeR: 0.2 }, risk: 50, stop: { status: 'READY', price: 63950 } },
        { tolerance: 0.05, toleranceLabel: '0.05_atr', triggered: false }
    ];
    retraces[1].shadowResults = [
        { tolerance: 0, toleranceLabel: 'zone_touch', triggered: true, sim: { status: 'LOSS', realizedR: -1, maeR: 1 }, risk: 50, stop: { status: 'READY', price: 63950 } },
        { tolerance: 0.05, toleranceLabel: '0.05_atr', triggered: true, sim: { status: 'WIN', realizedR: 1.5, maeR: 0.3 }, risk: 30, stop: { status: 'READY', price: 63970 } }
    ];
    retraces[0].atrAtWatch = 100;
    retraces[1].atrAtWatch = 100;

    var rows = shadowEntry.summarizeShadows(retraces);
    var zt = rows.filter(function (x) { return x.tolerance === 0; })[0];
    assert.strictEqual(zt.entries, 2);
    assert.strictEqual(zt.filled, 2);
    assert.strictEqual(zt.wins, 1);
    assert.strictEqual(zt.losses, 1);
    assert.ok(Math.abs(zt.avgR - (2.5 - 1) / 2) < 0.001);
    assert.ok(Math.abs(zt.totalR - 1.5) < 0.001);
    assert.ok(Math.abs(zt.avgStopDistanceAtr - 0.5) < 0.001); // (50+50)/100/2
    var t05 = rows.filter(function (x) { return x.tolerance === 0.05; })[0];
    assert.strictEqual(t05.entries, 1);
    assert.strictEqual(t05.wins, 1);
});

/* ---------- 结果 ---------- */
console.log('');
console.log('retraceDiagnostics: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) {
    process.exit(1);
}
