/**
 * Phase 11L.12 — Sweep-centric Validation 测试
 *
 * 覆盖：
 *   - classifySweepGroup 分组（EQL/EQH、PDH/PDL、SESSION、5m SWING、OTHER）
 *   - auditSweepCentric：方向匹配 MSS/protected MSS/StrongLeg/HIGH 启动率、MFE/MAE、
 *     索引窗口边界（sweep 后 1h 内）、母样本 = 全部 sweep（非 HIGH）
 */
var assert = require('assert');
var sca = require('../stats/sweepCentricAudit');

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

function mkSweep(id, side, type, candleIndex) {
    return { id: id, side: side, candleIndex: candleIndex, confirmedAt: 1000000 + candleIndex * BAR + BAR - 1,
        source: { liquidityType: type, liquidityPrice: 99, side: side } };
}
function mkMss(id, direction, candleIndex, refId) {
    return {
        id: id, direction: direction, candleIndex: candleIndex, confirmedAt: 1000000 + candleIndex * BAR + BAR - 1,
        source: { referenceSwingId: refId, referencePrice: 99, breakPct: 0.01 },
        metadata: { bodyRatio: 0.9 }
    };
}

/* ---------- 分组 ---------- */

test('11L.12：classifySweepGroup 分组', function () {
    assert.strictEqual(sca.classifySweepGroup('EQL'), 'EQL/EQH');
    assert.strictEqual(sca.classifySweepGroup('EQH'), 'EQL/EQH');
    assert.strictEqual(sca.classifySweepGroup('PDH'), 'PDH/PDL');
    assert.strictEqual(sca.classifySweepGroup('PDL'), 'PDH/PDL');
    assert.strictEqual(sca.classifySweepGroup('ASIA_LOW'), 'SESSION');
    assert.strictEqual(sca.classifySweepGroup('LONDON_HIGH'), 'SESSION');
    assert.strictEqual(sca.classifySweepGroup('NEW_YORK_LOW'), 'SESSION');
    assert.strictEqual(sca.classifySweepGroup('SWING_LOW'), '5m SWING');
    assert.strictEqual(sca.classifySweepGroup('SWING_HIGH'), '5m SWING');
    assert.strictEqual(sca.classifySweepGroup('UNKNOWN'), 'OTHER');
});

/* ---------- 审计 ---------- */

test('11L.12：sweep 后 1h 内 MSS/StrongLeg/HIGH 启动率 + MFE/MAE（母样本=全部 sweep）', function () {
    var candles = [];
    for (var i = 0; i < 30; i++) candles.push(m5(100, 101, 99, 100.5, i));
    // SSL sweep @ idx 5（BULLISH delivery）；idx 8 有 BULLISH MSS；idx 8 有 STRONG leg；idx 9 有 HIGH alert
    var sweeps = [
        mkSweep('s1', 'SSL', 'EQL', 5),
        mkSweep('s2', 'SSL', 'SWING_LOW', 10), // 窗口 idx11..22 不含 idx8 的 MSS → 启动率 0
        mkSweep('s3', 'BSL', 'EQH', 6)          // 方向 BEARISH，无匹配 delivery
    ];
    var swings = [{ id: 'SW1', type: 'SWING_HIGH', price: 99, index: 2, confirmedAt: candles[2].closeTime, timeframe: '5m' }];
    var mssEvents = [mkMss('m1', 'BULLISH', 8, 'SW1')];
    var displacementEvents = [{
        id: 'd1', direction: 'BULLISH', candleIndex: 8, confirmedAt: candles[8].closeTime,
        metadata: { mssEventId: 'm1' }
    }];
    var legByDispId = { d1: { quality: 'EXPLOSIVE', startIndex: 8, endIndex: 8 } };
    var alerts = [{ id: 'a1', tier: 'HIGH_QUALITY', direction: 'BULLISH', anchorIndex: 9 }];
    var res = sca.auditSweepCentric({
        sweepEvents: sweeps, mssEvents: mssEvents, swings: swings,
        displacementEvents: displacementEvents, legByDispId: legByDispId,
        alerts: alerts, candles: candles
    });
    var g = res.groups;
    // EQL sweep（idx5）：后续 1h 内 idx8 有 BULLISH MSS + protected + strong leg + idx9 HIGH
    // EQH sweep（idx6, BSL）：BEARISH 方向无匹配 delivery
    assert.strictEqual(g['EQL/EQH'].n, 2, 'EQL(SSL) + EQH(BSL) 同组');
    assert.strictEqual(g['EQL/EQH'].mss, 1, 'EQL sweep 后出现方向匹配 MSS（EQH 的 BEARISH 无）');
    assert.strictEqual(g['EQL/EQH'].protectedMss, 1, 'MSS 是 protected（最近 opposing + 强突破）');
    assert.strictEqual(g['EQL/EQH'].strongLeg, 1, '出现 EXPLOSIVE leg');
    assert.strictEqual(g['EQL/EQH'].high, 1, '形成 HIGH');
    assert.ok(g['EQL/EQH'].mfeCnt === 2 && g['EQL/EQH'].mfeSum > 0, 'MFE 计入（组内 2 个 sweep 都以 sweep K 收盘为基准）');
    // 5m SWING sweep（idx6）：后续 1h 内无 MSS → 启动率 0
    assert.strictEqual(g['5m SWING'].n, 1);
    assert.strictEqual(g['5m SWING'].mss, 0, '普通 Swing sweep 后续无 MSS');
});

test('11L.12：观察窗口边界（sweep 后 > windowBars 的 MSS 不计）', function () {
    var candles = [];
    for (var i = 0; i < 30; i++) candles.push(m5(100, 101, 99, 100.5, i));
    var sweeps = [mkSweep('s1', 'SSL', 'SWING_LOW', 5)];
    var swings = [{ id: 'SW1', type: 'SWING_HIGH', price: 99, index: 2, confirmedAt: candles[2].closeTime, timeframe: '5m' }];
    // MSS 在 idx 5+12+1 = 18（窗口外）
    var mssEvents = [mkMss('m1', 'BULLISH', 18, 'SW1')];
    var res = sca.auditSweepCentric({
        sweepEvents: sweeps, mssEvents: mssEvents, swings: swings,
        displacementEvents: [], legByDispId: {}, alerts: [], candles: candles
    });
    assert.strictEqual(res.groups['5m SWING'].mss, 0, '窗口外 MSS 不计');
});

test('11L.12：窗口内方向不匹配的 MSS 不计', function () {
    var candles = [];
    for (var i = 0; i < 30; i++) candles.push(m5(100, 101, 99, 100.5, i));
    var sweeps = [mkSweep('s1', 'SSL', 'EQL', 5)]; // BULLISH delivery
    var mssEvents = [mkMss('m1', 'BEARISH', 8, 'SW1')]; // 方向不匹配
    var swings = [];
    var res = sca.auditSweepCentric({
        sweepEvents: sweeps, mssEvents: mssEvents, swings: swings,
        displacementEvents: [], legByDispId: {}, alerts: [], candles: candles
    });
    assert.strictEqual(res.groups['EQL/EQH'].mss, 0, 'BEARISH MSS 不启动 BULLISH delivery 统计');
});

// ---------- 结果 ----------
console.log('sweepCentricAudit tests: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) {
    process.exit(1);
}
