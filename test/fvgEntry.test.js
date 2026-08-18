/**
 * FVG + Entry Gate 测试（Phase 9）
 *
 * 覆盖：
 *   FVG detector（bullish/bearish/no gap/gap threshold/future candle/confirmedAt）
 *   Displacement association（方向/距离/同 candle/未来）
 *   FVG lifecycle（touch/midpoint/fill/对称/单调/未来）
 *   FVG registry（去重/getBefore/方向/状态）
 *   FVG scorer（分项/cap/threshold）
 *   Entry Gate（CLOSED/WAITING_FVG/WAITING_RETRACE/ENTRY_READY/INVALIDATED/
 *                方向错误/低分/多 FVG 选择/deterministic/future）
 */
var assert = require('assert');
var fvgDetector = require('../fvg/fvgDetector');
var fvgRegistry = require('../fvg/fvgRegistry');
var fvgLifecycle = require('../fvg/fvgLifecycle');
var fvgScorer = require('../fvg/fvgScorer');
var entryGate = require('../entry/entryGate');
var entryExplanation = require('../entry/entryExplanation');
var entryInvalidation = require('../entry/entryInvalidation');

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

function m5(open, high, low, close, index) {
    var t = 1000000 + index * BAR;
    return {
        openTime: t,
        open: open,
        high: high,
        low: low,
        close: close,
        closeTime: t + BAR - 1,
        closed: true,
        source: 'futures'
    };
}

/**
 * 构造一个 base 序列（前 20 根平缓，ATR 稳定 ~10），
 * 然后在 i=20 处产生三根 K 线 FVG：
 *   bullish: c18.high < c20.low（缺口 10+）
 *   bearish: c18.low > c20.high
 */
function baseCandles() {
    var out = [];
    var i;
    for (i = 0; i < 20; i++) {
        out.push(m5(100 + i, 105 + i, 98 + i, 103 + i, i));
    }
    return out;
}

function disp(id, direction, candleIndex, extra) {
    var e = {
        id: id,
        symbol: 'BTCUSDT',
        timeframe: '5m',
        type: 'DISPLACEMENT',
        direction: direction,
        confirmedAt: 1000000 + candleIndex * BAR + BAR - 1,
        candleIndex: candleIndex,
        price: 0,
        source: {},
        metadata: { mssEventId: null }
    };
    if (extra) {
        if (extra.mssEventId) e.metadata.mssEventId = extra.mssEventId;
        if (extra.confirmedAt !== undefined) e.confirmedAt = extra.confirmedAt;
    }
    return e;
}

function makeFvg(overrides) {
    var f = {
        id: 'F1',
        symbol: 'BTCUSDT',
        timeframe: '5m',
        direction: 'BULLISH',
        zoneLow: 63000,
        zoneHigh: 63040,
        midpoint: 63020,
        gapSize: 40,
        gapPct: 0.0006,
        gapAtr: 2.0,
        createdAt: 1000000,
        confirmedAt: 1000000 + BAR - 1,
        candleIndex: 20,
        status: 'ACTIVE',
        touchedAt: null,
        midpointTouchedAt: null,
        filledAt: null,
        invalidatedAt: null,
        displacementEventId: 'D1',
        metadata: {
            displacementMetadata: { mssEventId: 'M1' },
            atr: 20
        }
    };
    if (overrides) {
        Object.keys(overrides).forEach(function (k) { f[k] = overrides[k]; });
    }
    return f;
}

function scenario(direction, state) {
    return {
        scenarioState: state || (direction === 'BULLISH' ? 'BULLISH_WATCH' : 'BEARISH_WATCH'),
        action: 'WATCH',
        direction: direction,
        inputs: {}
    };
}

function amd(direction, state) {
    return { direction: direction, state: state || 'MANIPULATION_CONFIRMED' };
}

function gateInput(overrides) {
    var input = {
        symbol: 'BTCUSDT',
        evaluationTime: 1000000 + 25 * BAR,
        currentPrice: 63300,
        scenario: scenario('BULLISH'),
        action: 'WATCH',
        amd: amd('BULLISH'),
        alignment: 'MATCH',
        fvgs: [makeFvg()]
    };
    if (overrides) {
        Object.keys(overrides).forEach(function (k) { input[k] = overrides[k]; });
    }
    return input;
}

/* ================= FVG Detector ================= */

test('detector：bullish FVG（c18.high < c20.low）', function () {
    var candles = baseCandles();
    // c18(索引18): high 123；c20(索引20): low 130 → 缺口 123 < 130
    var c19 = m5(124, 128, 122, 126, 19);
    var c20 = m5(130, 140, 128, 138, 20);
    candles[18] = m5(119, 123, 117, 121, 18);
    candles[19] = c19;
    candles.push(c20);
    var fvgs = fvgDetector.detectFvg(candles, {
        symbol: 'BTCUSDT', timeframe: '5m',
        evaluationTime: 1000000 + 25 * BAR,
        tickSize: 0.1
    });
    var bullish = fvgs.filter(function (f) { return f.direction === 'BULLISH'; });
    assert.ok(bullish.length >= 1);
    var f = bullish[bullish.length - 1];
    assert.strictEqual(f.zoneLow, 123);
    assert.strictEqual(f.zoneHigh, 128); // c20.low
    assert.strictEqual(f.midpoint, 125.5);
});

test('detector：bearish FVG（c18.low > c20.high）', function () {
    var candles = baseCandles();
    candles[18] = m5(131, 135, 128, 133, 18);
    candles[19] = m5(128, 130, 126, 129, 19);
    candles.push(m5(118, 124, 115, 120, 20)); // c20.high 124 < c18.low 128
    var fvgs = fvgDetector.detectFvg(candles, {
        symbol: 'BTCUSDT', timeframe: '5m',
        evaluationTime: 1000000 + 25 * BAR,
        tickSize: 0.1
    });
    var bearish = fvgs.filter(function (f) { return f.direction === 'BEARISH'; });
    assert.ok(bearish.length >= 1);
    var f = bearish[bearish.length - 1];
    assert.strictEqual(f.zoneLow, 124); // c20.high
    assert.strictEqual(f.zoneHigh, 128); // c18.low
});

test('detector：无缺口 → 不生成', function () {
    var candles = baseCandles();
    candles[18] = m5(110, 115, 108, 113, 18);
    candles[19] = m5(113, 117, 111, 115, 19);
    candles.push(m5(114, 118, 112, 116, 20)); // c18.high 115 > c20.low 112，无缺口
    var fvgs = fvgDetector.detectFvg(candles, {
        symbol: 'BTCUSDT', timeframe: '5m',
        evaluationTime: 1000000 + 25 * BAR, tickSize: 0.1
    });
    // base 序列中可能存在自然 FVG？base 是连续推进无缺口；断言最后三根之间无 FVG
    var last = fvgs.filter(function (f) { return f.candleIndex === 20; });
    assert.strictEqual(last.length, 0);
});

test('detector：gap 低于阈值（minGap）→ 拒绝', function () {
    var candles = baseCandles();
    // 缺口只有 1.5（c18.high 123, c20.low 124.5），tickSize 0.1×2=0.2, ATR~10×0.05=0.5 → minGap 0.5
    candles[18] = m5(119, 123, 117, 121, 18);
    candles[19] = m5(124, 128, 122, 126, 19);
    candles.push(m5(124.5, 130, 123, 128, 20));
    var fvgs = fvgDetector.detectFvg(candles, {
        symbol: 'BTCUSDT', timeframe: '5m',
        evaluationTime: 1000000 + 25 * BAR, tickSize: 0.1
    });
    var last = fvgs.filter(function (f) { return f.candleIndex === 20; });
    assert.strictEqual(last.length, 0);
});

test('detector：gap 低于阈值（放大 tickSize multiplier）→ 拒绝', function () {
    var candles = baseCandles();
    candles[18] = m5(119, 123, 117, 121, 18);
    candles[19] = m5(124, 128, 122, 126, 19);
    candles.push(m5(129, 134, 127, 132, 20)); // 缺口 123 < 127 = 4
    // 自定义阈值：tickMultiplier 100（0.1*100=10 > 4）→ 拒绝
    var fvgs = fvgDetector.detectFvg(candles, {
        symbol: 'BTCUSDT', timeframe: '5m',
        evaluationTime: 1000000 + 25 * BAR, tickSize: 0.1,
        thresholds: {
            fvg: {
                minGap: { tickMultiplier: 100, atrMultiplier: 0.05 },
                maxDisplacementBars: 2
            }
        }
    });
    var last = fvgs.filter(function (f) { return f.candleIndex === 20; });
    assert.strictEqual(last.length, 0);
});

test('detector：tickSize/ATR 都缺失 → percentage fallback 仍工作', function () {
    var candles = baseCandles();
    candles[18] = m5(119, 123, 117, 121, 18);
    candles[19] = m5(124, 128, 122, 126, 19);
    candles.push(m5(130, 140, 128, 138, 20)); // 缺口 5
    var fvgs = fvgDetector.detectFvg(candles, {
        symbol: 'BTCUSDT', timeframe: '5m',
        evaluationTime: 1000000 + 25 * BAR,
        tickSize: null
    });
    var last = fvgs.filter(function (f) { return f.candleIndex === 20; });
    // fallback = 127.5 * 0.00005 ≈ 0.006 << 5 → 生成
    assert.ok(last.length >= 1);
});

test('detector：confirmedAt = 第三根 closeTime（非 openTime）', function () {
    var candles = baseCandles();
    candles[18] = m5(119, 123, 117, 121, 18);
    candles[19] = m5(124, 128, 122, 126, 19);
    candles.push(m5(130, 140, 128, 138, 20));
    var fvgs = fvgDetector.detectFvg(candles, {
        symbol: 'BTCUSDT', timeframe: '5m',
        evaluationTime: 1000000 + 25 * BAR, tickSize: 0.1
    });
    var f = fvgs.filter(function (x) { return x.candleIndex === 20; })[0];
    assert.strictEqual(f.confirmedAt, 1000000 + 20 * BAR + BAR - 1);
    assert.strictEqual(f.createdAt, 1000000 + 20 * BAR);
});

test('detector：future candle（closeTime > evaluationTime）排除', function () {
    var candles = baseCandles();
    candles[18] = m5(119, 123, 117, 121, 18);
    candles[19] = m5(124, 128, 122, 126, 19);
    candles.push(m5(130, 140, 128, 138, 20));
    var fvgs = fvgDetector.detectFvg(candles, {
        symbol: 'BTCUSDT', timeframe: '5m',
        evaluationTime: 1000000 + 19 * BAR + 1, // c20 未收盘
        tickSize: 0.1
    });
    var last = fvgs.filter(function (f) { return f.candleIndex === 20; });
    assert.strictEqual(last.length, 0);
});

/* ================= Displacement Association ================= */

test('association：同方向 displacement 关联（0 bars）', function () {
    var candles = baseCandles();
    candles[18] = m5(119, 123, 117, 121, 18);
    candles[19] = m5(124, 128, 122, 126, 19);
    candles.push(m5(130, 140, 128, 138, 20));
    var fvgs = fvgDetector.detectFvg(candles, {
        symbol: 'BTCUSDT', timeframe: '5m',
        evaluationTime: 1000000 + 25 * BAR, tickSize: 0.1,
        displacements: [disp('D1', 'BULLISH', 20)]
    });
    var f = fvgs.filter(function (x) { return x.candleIndex === 20; })[0];
    assert.strictEqual(f.displacementEventId, 'D1');
    assert.strictEqual(f.metadata.displacementBarsAway, 0);
});

test('association：wrong direction displacement → 不关联', function () {
    var candles = baseCandles();
    candles[18] = m5(119, 123, 117, 121, 18);
    candles[19] = m5(124, 128, 122, 126, 19);
    candles.push(m5(130, 140, 128, 138, 20));
    var fvgs = fvgDetector.detectFvg(candles, {
        symbol: 'BTCUSDT', timeframe: '5m',
        evaluationTime: 1000000 + 25 * BAR, tickSize: 0.1,
        displacements: [disp('D1', 'BEARISH', 20)]
    });
    var f = fvgs.filter(function (x) { return x.candleIndex === 20; })[0];
    assert.strictEqual(f.displacementEventId, null);
});

test('association：>2 bars → 不关联', function () {
    var candles = baseCandles();
    candles[18] = m5(119, 123, 117, 121, 18);
    candles[19] = m5(124, 128, 122, 126, 19);
    candles.push(m5(130, 140, 128, 138, 20));
    var fvgs = fvgDetector.detectFvg(candles, {
        symbol: 'BTCUSDT', timeframe: '5m',
        evaluationTime: 1000000 + 25 * BAR, tickSize: 0.1,
        displacements: [disp('D1', 'BULLISH', 17)] // 3 bars 前
    });
    var f = fvgs.filter(function (x) { return x.candleIndex === 20; })[0];
    assert.strictEqual(f.displacementEventId, null);
});

test('association：同 candle 优先于更早的 displacement', function () {
    var candles = baseCandles();
    candles[18] = m5(119, 123, 117, 121, 18);
    candles[19] = m5(124, 128, 122, 126, 19);
    candles.push(m5(130, 140, 128, 138, 20));
    var fvgs = fvgDetector.detectFvg(candles, {
        symbol: 'BTCUSDT', timeframe: '5m',
        evaluationTime: 1000000 + 25 * BAR, tickSize: 0.1,
        displacements: [
            disp('D_EARLY', 'BULLISH', 18),
            disp('D_SAME', 'BULLISH', 20)
        ]
    });
    var f = fvgs.filter(function (x) { return x.candleIndex === 20; })[0];
    assert.strictEqual(f.displacementEventId, 'D_SAME');
    assert.strictEqual(f.metadata.displacementBarsAway, 0);
});

test('association：future displacement（confirmedAt > FVG confirmedAt）不关联', function () {
    var candles = baseCandles();
    candles[18] = m5(119, 123, 117, 121, 18);
    candles[19] = m5(124, 128, 122, 126, 19);
    candles.push(m5(130, 140, 128, 138, 20));
    var d = disp('D1', 'BULLISH', 20);
    d.confirmedAt = 1000000 + 25 * BAR; // 未来
    var fvgs = fvgDetector.detectFvg(candles, {
        symbol: 'BTCUSDT', timeframe: '5m',
        evaluationTime: 1000000 + 25 * BAR, tickSize: 0.1,
        displacements: [d]
    });
    var f = fvgs.filter(function (x) { return x.candleIndex === 20; })[0];
    assert.strictEqual(f.displacementEventId, null);
});

/* ================= FVG Lifecycle ================= */

test('lifecycle：bullish touch → midpoint → fill（单调）', function () {
    var f = makeFvg(); // zoneLow 63000, midpoint 63020, zoneHigh 63040
    var r1 = fvgLifecycle.evaluateFvg(f, m5(63100, 63150, 63030, 63100, 21)); // low 63030 <= 63040 → TOUCHED
    assert.strictEqual(r1.status, 'TOUCHED');
    assert.strictEqual(r1.touchedAt, 1000000 + 21 * BAR + BAR - 1);
    var r2 = fvgLifecycle.evaluateFvg(f, m5(63100, 63150, 63010, 63100, 22)); // low 63010 <= 63020 → MIDPOINT
    assert.strictEqual(r2.status, 'MIDPOINT_TOUCHED');
    assert.ok(r2.midpointTouchedAt > 0);
    var r3 = fvgLifecycle.evaluateFvg(f, m5(63100, 63150, 62950, 63100, 23)); // low 62950 <= 63000 → FILLED
    assert.strictEqual(r3.status, 'FILLED');
    assert.ok(r3.filledAt > 0);
});

test('lifecycle：单根大 candle 直接 FILLED（跨级）', function () {
    var f = makeFvg();
    var r = fvgLifecycle.evaluateFvg(f, m5(63100, 63150, 62900, 63050, 21));
    assert.strictEqual(r.status, 'FILLED');
    assert.ok(r.touchedAt && r.midpointTouchedAt && r.filledAt);
});

test('lifecycle：bearish 对称', function () {
    var f = makeFvg({ direction: 'BEARISH', zoneLow: 63000, zoneHigh: 63040, midpoint: 63020 });
    var r1 = fvgLifecycle.evaluateFvg(f, m5(62900, 63005, 62850, 62900, 21)); // high 63005 >= 63000 → TOUCHED
    assert.strictEqual(r1.status, 'TOUCHED');
    var r2 = fvgLifecycle.evaluateFvg(f, m5(62900, 63025, 62850, 62900, 22)); // high 63025 >= 63020 → MIDPOINT
    assert.strictEqual(r2.status, 'MIDPOINT_TOUCHED');
    var r3 = fvgLifecycle.evaluateFvg(f, m5(62900, 63050, 62850, 62900, 23)); // high 63050 >= 63040 → FILLED
    assert.strictEqual(r3.status, 'FILLED');
});

test('lifecycle：状态只升不降', function () {
    var f = makeFvg();
    fvgLifecycle.applyFvgEvent(f, fvgLifecycle.evaluateFvg(f, m5(63100, 63150, 63010, 63100, 21))); // MIDPOINT
    var r = fvgLifecycle.evaluateFvg(f, m5(63100, 63150, 63030, 63100, 22)); // low 63030（只到 TOUCHED 级别）
    assert.strictEqual(r.status, 'MIDPOINT_TOUCHED'); // 不降回 TOUCHED
    assert.strictEqual(r.changed, false);
});

test('lifecycle：未收盘 candle → null（不改状态）', function () {
    var f = makeFvg();
    var c = m5(63100, 63150, 62900, 63050, 21);
    c.closed = false;
    assert.strictEqual(fvgLifecycle.evaluateFvg(f, c), null);
});

test('lifecycle：invalidate 显式置 INVALIDATED', function () {
    var f = makeFvg();
    fvgLifecycle.invalidate(f, 999);
    assert.strictEqual(f.status, 'INVALIDATED');
    assert.strictEqual(f.invalidatedAt, 999);
});

/* ================= FVG Registry ================= */

test('registry：add/dedupe/getActive/getByDirection/getByStatus/getBefore', function () {
    var r = fvgRegistry.createFvgRegistry();
    var f1 = makeFvg({ id: 'F1', status: 'ACTIVE', confirmedAt: 100 });
    var f2 = makeFvg({ id: 'F2', direction: 'BEARISH', status: 'TOUCHED', confirmedAt: 200 });
    var f3 = makeFvg({ id: 'F3', status: 'FILLED', confirmedAt: 300 });
    assert.strictEqual(r.add(f1), true);
    assert.strictEqual(r.add(f1), false); // 去重
    r.add(f2);
    r.add(f3);
    assert.strictEqual(r.size(), 3);
    assert.strictEqual(r.getActive('BTCUSDT').length, 1);
    assert.strictEqual(r.getByDirection('BTCUSDT', 'BEARISH').length, 1);
    assert.strictEqual(r.getByStatus('BTCUSDT', 'FILLED').length, 1);
    assert.strictEqual(r.getById('F2').status, 'TOUCHED');
    assert.strictEqual(r.getBefore(250).length, 2); // 未来 F3 不返回
});

/* ================= FVG Scorer ================= */

test('scorer：满分（displacement + gap + MSS + AMD + scenario）= 100', function () {
    var f = makeFvg(); // 有 D1, gapAtr 2.0, mss M1
    var s = fvgScorer.scoreFvg(f, { amdDirection: 'BULLISH', scenarioDirection: 'BULLISH' }, {});
    assert.strictEqual(s.total, 100);
    assert.deepStrictEqual(s.breakdown, {
        displacement: 40, gap: 20, mss: 15, amd: 15, scenario: 10
    });
    assert.strictEqual(s.passed, true);
});

test('scorer：无 displacement → passed false（Entry Gate 不可用）', function () {
    var f = makeFvg({ displacementEventId: null, metadata: { displacementMetadata: null } });
    var s = fvgScorer.scoreFvg(f, { amdDirection: 'BULLISH', scenarioDirection: 'BULLISH' }, {});
    assert.strictEqual(s.breakdown.displacement, 0);
    assert.strictEqual(s.passed, false);
});

test('scorer：AMD 相反 → amd 0 分', function () {
    var f = makeFvg();
    var s = fvgScorer.scoreFvg(f, { amdDirection: 'BEARISH', scenarioDirection: 'BULLISH' }, {});
    assert.strictEqual(s.breakdown.amd, 0);
});

test('scorer：cap 100', function () {
    var f = makeFvg({ gapAtr: 5 });
    var s = fvgScorer.scoreFvg(f, { amdDirection: 'BULLISH', scenarioDirection: 'BULLISH' }, {});
    assert.ok(s.total <= 100);
});

test('scorer：threshold 60（低于不 passed）', function () {
    // 只有 displacement 40 + gap 10 = 50 → 不通过
    var f = makeFvg({
        gapAtr: 0.5,
        metadata: { displacementMetadata: { mssEventId: null } }
    });
    var s = fvgScorer.scoreFvg(f, { amdDirection: 'BEARISH', scenarioDirection: 'BEARISH' }, {});
    assert.ok(s.total < 60);
    assert.strictEqual(s.passed, false);
});

/* ================= Entry Gate ================= */

test('gate：NO_TRADE → CLOSED（不扫描 FVG）', function () {
    var g = entryGate.runEntryGate(gateInput({ action: 'NO_TRADE', scenario: { scenarioState: 'CONFLICT', action: 'NO_TRADE', direction: null, inputs: {} } }), {});
    assert.strictEqual(g.state, 'CLOSED');
    assert.strictEqual(g.fvg, null);
});

test('gate：WAIT → CLOSED', function () {
    var g = entryGate.runEntryGate(gateInput({ action: 'WAIT', scenario: { scenarioState: 'BULLISH_WAIT', action: 'WAIT', direction: 'BULLISH', inputs: {} } }), {});
    assert.strictEqual(g.state, 'CLOSED');
});

test('gate：WATCH + 无 FVG → WAITING_FVG', function () {
    var g = entryGate.runEntryGate(gateInput({ fvgs: [] }), {});
    assert.strictEqual(g.state, 'WAITING_FVG');
});

test('gate：WATCH + FVG 但价格未进 zone → WAITING_RETRACE', function () {
    // FVG zone 63000-63040，currentPrice 63300（上方）→ 未进入
    var g = entryGate.runEntryGate(gateInput({ currentPrice: 63300 }), {});
    assert.strictEqual(g.state, 'WAITING_RETRACE');
    assert.ok(g.fvg);
    assert.strictEqual(g.preferredEntry, 63020); // midpoint
});

test('gate：bullish retrace 进 zone → ENTRY_READY', function () {
    var g = entryGate.runEntryGate(gateInput({ currentPrice: 63025 }), {});
    assert.strictEqual(g.state, 'ENTRY_READY');
    assert.deepStrictEqual(g.entryZone, { low: 63000, high: 63040, midpoint: 63020 });
    assert.strictEqual(g.preferredEntry, 63020);
});

test('gate：bearish retrace 进 zone → ENTRY_READY', function () {
    var f = makeFvg({ direction: 'BEARISH', zoneLow: 63000, zoneHigh: 63040, midpoint: 63020 });
    var g = entryGate.runEntryGate(gateInput({
        scenario: scenario('BEARISH'),
        amd: amd('BEARISH'),
        currentPrice: 63025, // 在 bearish FVG zone 内
        fvgs: [f]
    }), {});
    assert.strictEqual(g.state, 'ENTRY_READY');
    assert.strictEqual(g.fvg.direction, 'BEARISH');
});

test('gate：wrong direction FVG 拒绝', function () {
    var f = makeFvg({ direction: 'BEARISH' }); // 但 scenario bullish
    var g = entryGate.runEntryGate(gateInput({ fvgs: [f] }), {});
    assert.strictEqual(g.state, 'WAITING_FVG');
});

test('gate：low score FVG 拒绝（无 displacement）', function () {
    var f = makeFvg({ displacementEventId: null, metadata: { displacementMetadata: null } });
    var g = entryGate.runEntryGate(gateInput({ fvgs: [f] }), {});
    assert.strictEqual(g.state, 'WAITING_FVG');
});

test('gate：多 FVG deterministic 选择（chain 匹配优先）', function () {
    var chainFvg = makeFvg({ id: 'F_CHAIN', displacementEventId: 'D1', confirmedAt: 200 });
    var plainFvg = makeFvg({ id: 'F_PLAIN', displacementEventId: 'D2', confirmedAt: 100,
        metadata: { displacementMetadata: { mssEventId: null } } });
    var g1 = entryGate.runEntryGate(gateInput({ fvgs: [plainFvg, chainFvg] }), {});
    var g2 = entryGate.runEntryGate(gateInput({ fvgs: [chainFvg, plainFvg] }), {});
    assert.strictEqual(g1.fvg.id, 'F_CHAIN'); // chain（MSS）优先
    assert.strictEqual(g2.fvg.id, 'F_CHAIN');
});

test('gate：AMD INVALIDATED → INVALIDATED（曾进入 retrace）', function () {
    var g = entryGate.runEntryGate(gateInput({
        amd: amd('BULLISH', 'INVALIDATED'),
        currentPrice: 63025,
        previousState: 'WAITING_RETRACE'
    }), {});
    assert.strictEqual(g.state, 'INVALIDATED');
    assert.ok(g.invalidatedReason.indexOf('AMD') !== -1);
});

test('gate：alignment OPPOSITE → INVALIDATED', function () {
    var g = entryGate.runEntryGate(gateInput({
        alignment: 'OPPOSITE',
        previousState: 'WAITING_RETRACE'
    }), {});
    assert.strictEqual(g.state, 'INVALIDATED');
});

test('gate：scenario 翻向（不再 WATCH）→ INVALIDATED', function () {
    var g = entryGate.runEntryGate(gateInput({
        action: 'WAIT',
        scenario: { scenarioState: 'BULLISH_WAIT', action: 'WAIT', direction: 'BULLISH', inputs: {} },
        previousState: 'ENTRY_READY'
    }), {});
    assert.strictEqual(g.state, 'INVALIDATED');
});

test('gate：future FVG（confirmedAt > evaluationTime）被忽略', function () {
    var f = makeFvg({ confirmedAt: 1000000 + 30 * BAR }); // 未来
    var g = entryGate.runEntryGate(gateInput({ fvgs: [f] }), {});
    assert.strictEqual(g.state, 'WAITING_FVG');
});

test('gate：replay deterministic（两次结果一致）', function () {
    var input = gateInput({ currentPrice: 63025 });
    var g1 = entryGate.runEntryGate(JSON.parse(JSON.stringify(input)), {});
    var g2 = entryGate.runEntryGate(JSON.parse(JSON.stringify(input)), {});
    assert.strictEqual(g1.state, g2.state);
    assert.strictEqual(g1.fvg.id, g2.fvg.id);
});

/* ================= Explanation / Invalidation ================= */

test('explanation：ENTRY_READY confirmations 完整', function () {
    var gate = entryGate.runEntryGate(gateInput({ currentPrice: 63025 }), {});
    var e = entryExplanation.buildEntryExplanation(gate, {
        scenario: scenario('BULLISH'),
        amd: amd('BULLISH'),
        alignment: 'MATCH',
        action: 'WATCH'
    }, {});
    assert.ok(e.confirmations.length >= 3);
    assert.ok(e.waiting.length === 0 || e.waiting.every(function (w) { return w.indexOf('FVG') === -1; }));
    assert.strictEqual(e.fvg.length, 1);
    assert.strictEqual(e.fvg[0].midpoint, 63020);
});

test('explanation：WAITING_RETRACE waiting 描述', function () {
    var gate = entryGate.runEntryGate(gateInput({ currentPrice: 63300 }), {});
    var e = entryExplanation.buildEntryExplanation(gate, {
        scenario: scenario('BULLISH'),
        amd: amd('BULLISH'),
        alignment: 'MATCH',
        action: 'WATCH'
    }, {});
    assert.ok(e.waiting.some(function (w) { return w.indexOf('retrace') !== -1; }));
});

test('invalidation：bullish 失效条件', function () {
    var inv = entryInvalidation.buildEntryInvalidation({}, { scenario: scenario('BULLISH') }, {});
    assert.ok(inv.length >= 5);
    assert.ok(inv.some(function (x) { return x.indexOf('BULLISH_WATCH') !== -1; }));
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
