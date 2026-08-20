/**
 * Phase 11L.14 — EXTERNAL_SWING Shadow 测试
 *
 * 覆盖：
 *   - classifySwingClass：age 规则（长期未被取）/ HTF proximity 规则 / INTERNAL 兜底
 *   - buildHtfExtremes + nearHtfExtreme：截至 sweep 时刻（无 future leakage）
 *   - auditExternalSwing：INTERNAL/EXTERNAL/SIGNIFICANT/OVERLAP 分组 + 多指标
 */
var assert = require('assert');
var esa = require('../stats/externalSwingAudit');

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

var BAR = 300000;
function m5(open, high, low, close, i) {
    var t = 1000000 + i * BAR;
    return { openTime: t, open: open, high: high, low: low, close: close, closeTime: t + BAR - 1, closed: true, source: 'futures' };
}

function mkSweep(id, side, type, candleIndex, price, liquidityId) {
    return { id: id, side: side, candleIndex: candleIndex, price: price, liquidityId: liquidityId,
        confirmedAt: 1000000 + candleIndex * BAR + BAR - 1,
        source: { liquidityType: type, liquidityPrice: price, side: side } };
}

/* ---------- classifySwingClass ---------- */

test('11L.14：classifySwingClass age 规则（>= ageMinBars → EXTERNAL）', function () {
    var sweep = mkSweep('s1', 'SSL', 'SWING_LOW', 30, 99, 'L1'); // confirmedAt = idx30 收盘
    var swing = { id: 'L1', type: 'SWING_LOW', price: 99, confirmedAt: 1000000 + 2 * BAR + BAR - 1 }; // idx2 形成
    // age = (idx30 - idx2) * 5min = 28 bars >= 24 → EXTERNAL
    assert.strictEqual(esa.classifySwingClass(sweep, swing, [], { ageMinBars: 24, htfTolerance: 0.002 }), 'EXTERNAL');
    // age 小且无 HTF → INTERNAL
    var swing2 = { id: 'L2', type: 'SWING_LOW', price: 99, confirmedAt: 1000000 + 25 * BAR + BAR - 1 }; // age 5 bars
    assert.strictEqual(esa.classifySwingClass(sweep, swing2, [], { ageMinBars: 24, htfTolerance: 0.002 }), 'INTERNAL');
});

test('11L.14：classifySwingClass HTF proximity 规则（接近 1h/4h 极值 → EXTERNAL）', function () {
    var sweep = mkSweep('s1', 'SSL', 'SWING_LOW', 10, 99, 'L1');
    var swing = { id: 'L1', type: 'SWING_LOW', price: 99, confirmedAt: 1000000 + 9 * BAR + BAR - 1 }; // age 1 bar
    // 1h 极值：low 最低 99.0（接近 swing 99）
    var htf = [];
    htf.push(m5(100, 101, 99.2, 99.5, 0));
    htf.push(m5(99.5, 100, 99.0, 99.8, 1));
    var htfIdx = esa.buildHtfExtremes(htf);
    var cfg = { ageMinBars: 24, htfTolerance: 0.002 };
    assert.strictEqual(esa.classifySwingClass(sweep, swing, [htfIdx], cfg), 'EXTERNAL', 'HTF low 99.0 与 swing 99 接近');
    // 远离 HTF 极值 → INTERNAL
    var swingFar = { id: 'L2', type: 'SWING_LOW', price: 95, confirmedAt: 1000000 + 9 * BAR + BAR - 1 };
    assert.strictEqual(esa.classifySwingClass(sweep, swingFar, [htfIdx], cfg), 'INTERNAL', '95 vs HTF low 99 差距大');
});

test('11L.14：nearHtfExtreme 无 future leakage（只看到 sweep 时刻前的极值）', function () {
    var htf = [];
    // idx0-2：high 100-103（前半段高点 103）；idx3+：high 110（未来高点，不应看到）
    htf.push(m5(100, 101, 99, 100.5, 0));
    htf.push(m5(100.5, 102, 100, 101, 1));
    htf.push(m5(101, 103, 100.5, 102, 2));
    htf.push(m5(102, 110, 101, 109, 3)); // 未来
    var htfIdx = esa.buildHtfExtremes(htf);
    // sweep 在 idx2（t = idx2 closeTime）→ 只看到 idx0-2，max high = 103
    var t = 1000000 + 2 * BAR + BAR - 1;
    assert.strictEqual(esa.nearHtfExtreme(htfIdx, t, 103, false, 0.002), true, '103 与截至 idx2 的 max 103 接近');
    assert.strictEqual(esa.nearHtfExtreme(htfIdx, t, 110, false, 0.002), false, '110 是未来高点，不应命中');
});

/* ---------- auditExternalSwing ---------- */

test('11L.14：五组分组 + 多指标', function () {
    var candles = [];
    for (var i = 0; i < 40; i++) candles.push(m5(100, 101, 99, 100.5, i));
    var sweeps = [
        // ① INTERNAL_SWING_ONLY：SWING @92 idx5（age 1、远离 HTF low 95、附近无 significant）
        mkSweep('s1', 'SSL', 'SWING_LOW', 5, 92, 'SW1'),
        // ② EXTERNAL_SWING_ONLY：SWING @95 idx3（接近 HTF low 95）
        mkSweep('s2', 'SSL', 'SWING_LOW', 3, 95, 'SW2'),
        // ③ OVERLAP ×2：SWING @99 idx7 与 EQL @99 idx7 共现
        mkSweep('s3', 'SSL', 'SWING_LOW', 7, 99, 'SW3'),
        mkSweep('s6', 'SSL', 'EQL', 7, 99, 'EQ1'),
        // ④ SIGNIFICANT_ONLY：EQL @105 idx20（附近无 swing）
        mkSweep('s5', 'SSL', 'EQL', 20, 105, 'EQ2')
    ];
    var swings = [
        { id: 'SW1', type: 'SWING_LOW', price: 92, confirmedAt: 1000000 + 4 * BAR + BAR - 1 }, // age 1
        { id: 'SW2', type: 'SWING_LOW', price: 95, confirmedAt: 1000000 + 1 * BAR + BAR - 1 }, // age 2，HTF 命中
        { id: 'SW3', type: 'SWING_LOW', price: 99, confirmedAt: 1000000 + 6 * BAR + BAR - 1 },
        { id: 'REF1', type: 'SWING_HIGH', price: 99, index: 2, confirmedAt: candles[2].closeTime, timeframe: '5m' } // MSS reference（classifyMssReference 用）
    ];
    // HTF：1h 蜡烛，low 最低 95（idx0）→ SW2(95) 接近
    var htf = [m5(100, 101, 95, 99, 0), m5(99, 100, 96, 99.5, 1), m5(99.5, 100.5, 98, 100, 2)];
    // 后续 delivery：idx8 BULLISH MSS（s1/s2/s3/s6 窗口内）
    var mssEvents = [{
        id: 'm1', direction: 'BULLISH', candleIndex: 8, confirmedAt: candles[8].closeTime,
        source: { referenceSwingId: 'REF1', referencePrice: 99, breakPct: 0.01 }, metadata: { bodyRatio: 0.9 }
    }];
    var swingsForMss = [{ id: 'REF1', type: 'SWING_HIGH', price: 99, index: 2, confirmedAt: candles[2].closeTime, timeframe: '5m' }];
    var displacementEvents = [{ id: 'd1', direction: 'BULLISH', candleIndex: 8, confirmedAt: candles[8].closeTime, metadata: { mssEventId: 'm1' } }];
    var legByDispId = { d1: { quality: 'EXPLOSIVE', startIndex: 8, endIndex: 8 } };
    var alerts = [{ id: 'a1', tier: 'HIGH_QUALITY', direction: 'BULLISH', anchorIndex: 9 }];
    var res = esa.auditExternalSwing({
        sweepEvents: sweeps, swings: swings, htfCandles: { '1h': htf, '4h': [] },
        mssEvents: mssEvents, swingsForMss: swingsForMss,
        displacementEvents: displacementEvents, legByDispId: legByDispId,
        alerts: alerts, candles: candles,
        ageMinBars: 24, htfTolerance: 0.002, priceTolerance: 0.001, overlapBars: 12
    });
    var g = res.groups;
    assert.strictEqual(g.INTERNAL_SWING_ONLY.n, 1, 's1 @92：age 1、远离 HTF、无 significant 共现');
    assert.strictEqual(g.EXTERNAL_SWING_ONLY.n, 1, 's2 @95：HTF low 95 命中');
    assert.strictEqual(g.OVERLAP.n, 2, 's3(SWING)+s6(EQL) @99 idx7 共现');
    assert.strictEqual(g.SIGNIFICANT_ONLY.n, 1, 's5 @105 idx20：附近无 swing');
    // 多指标：s1/s2/s3/s6 后续 1h 有 protected MSS + strong leg + HIGH（idx8/9 在窗口内）
    assert.strictEqual(g.INTERNAL_SWING_ONLY.protectedMss, 1);
    assert.strictEqual(g.INTERNAL_SWING_ONLY.strongLeg, 1);
    assert.strictEqual(g.INTERNAL_SWING_ONLY.high, 1);
    assert.strictEqual(g.EXTERNAL_SWING_ONLY.protectedMss, 1);
    assert.strictEqual(g.EXTERNAL_SWING_ONLY.high, 1);
    assert.strictEqual(g.SIGNIFICANT_ONLY.high, 0, 's5 窗口内无 delivery');
    assert.ok(g.INTERNAL_SWING_ONLY.mfeCnt === 1 && g.INTERNAL_SWING_ONLY.mfeSum > 0, 'MFE 计入');
});

/* ---------- 阈值默认 ---------- */

test('11L.14：默认参数来自 thresholds', function () {
    var candles = [];
    for (var i = 0; i < 20; i++) candles.push(m5(100, 101, 99, 100.5, i));
    var sweeps = [mkSweep('s1', 'SSL', 'SWING_LOW', 5, 99, 'SW1')];
    var swings = [{ id: 'SW1', type: 'SWING_LOW', price: 99, confirmedAt: 1000000 + 4 * BAR + BAR - 1 }];
    var res = esa.auditExternalSwing({
        sweepEvents: sweeps, swings: swings, htfCandles: {},
        mssEvents: [], swingsForMss: [], displacementEvents: [], legByDispId: {},
        alerts: [], candles: candles
    });
    assert.strictEqual(res.ageMinBars, 24, '默认 age 24');
    assert.strictEqual(res.htfTolerance, 0.002, '默认 HTF 容差 0.2%');
    assert.strictEqual(res.groups.INTERNAL_SWING_ONLY.n, 1, '无 HTF、age 小 → INTERNAL');
});

// ---------- 结果 ----------
console.log('externalSwingAudit tests: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) {
    process.exit(1);
}
