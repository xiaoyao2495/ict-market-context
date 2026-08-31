/**
 * Phase 11L.10 — Liquidity Relevance Audit 测试
 *
 * 覆盖：
 *   - sourceGroupOf 分组（SIGNIFICANT / SWING / OTHER）
 *   - classifyPostSweepBehavior：IMMEDIATE_REJECTION / RE_CROSS / ADJACENT / DELAYED_RECLAIM /
 *     NO_SWEEP / UNKNOWN，BULLISH 与 BEARISH 对称
 *   - auditRelevance：交叉表 + behavior 分布 + 只统计 HIGH
 */
var assert = require('assert');
var lra = require('../stats/liquidityRelevanceAudit');

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

/* ---------- sourceGroupOf ---------- */

test('11L.10：sourceGroupOf 分组', function () {
    assert.strictEqual(lra.sourceGroupOf('EQL'), 'SIGNIFICANT');
    assert.strictEqual(lra.sourceGroupOf('EQH'), 'SIGNIFICANT');
    assert.strictEqual(lra.sourceGroupOf('PDH'), 'SIGNIFICANT');
    assert.strictEqual(lra.sourceGroupOf('PDL'), 'SIGNIFICANT');
    assert.strictEqual(lra.sourceGroupOf('ASIA_LOW'), 'SIGNIFICANT');
    assert.strictEqual(lra.sourceGroupOf('LONDON_HIGH'), 'SIGNIFICANT');
    assert.strictEqual(lra.sourceGroupOf('NEW_YORK_LOW'), 'SIGNIFICANT');
    assert.strictEqual(lra.sourceGroupOf('SWING_HIGH'), 'SWING');
    assert.strictEqual(lra.sourceGroupOf('SWING_LOW'), 'SWING');
    assert.strictEqual(lra.sourceGroupOf('UNKNOWN'), 'OTHER');
    assert.strictEqual(lra.sourceGroupOf(''), 'OTHER');
});

/* ---------- classifyPostSweepBehavior ---------- */

function mkCandles() {
    var candles = [];
    // 40 根：保证 auditRelevance 测试里 availableIndex=19 → 1h 窗口（20+12=32）完整（11L.15a）
    for (var i = 0; i < 40; i++) candles.push(m5(100, 101, 99, 100.5, i));
    return candles;
}

test('11L.10：IMMEDIATE_REJECTION（sweep 后第一根 reclaim 且无 re-cross）', function () {
    var candles = mkCandles();
    // BULLISH + SSL sweep @ p=99：sweep 在 idx 5，leg.start=12
    // idx 6 收在 99.5（>= 99 reclaim），idx 7-11 low 都 >= 99 → 无 re-cross
    candles[6] = m5(98.5, 100.2, 98.4, 99.5, 6);
    for (var j = 7; j < 12; j++) candles[j] = m5(99.5, 100.8, 99.1, 100.3, j);
    var alert = {
        direction: 'BULLISH', formationStartIndex: 12,
        liquidityContext: { immediateSweep: { candleIndex: 5, sourcePrice: 99 } }
    };
    assert.strictEqual(lra.classifyPostSweepBehavior(alert, candles), 'IMMEDIATE_REJECTION');
});

test('11L.10：RE_CROSS（sweep 后价格又插回 sweep 价下方）', function () {
    var candles = mkCandles();
    // BULLISH + SSL sweep @ p=99：idx 6 reclaim，但 idx 9 low=98.5 < 99 → re-cross
    candles[6] = m5(98.5, 100.2, 98.4, 99.5, 6);
    candles[9] = m5(100.0, 100.1, 98.5, 99.8, 9);
    var alert = {
        direction: 'BULLISH', formationStartIndex: 12,
        liquidityContext: { immediateSweep: { candleIndex: 5, sourcePrice: 99 } }
    };
    assert.strictEqual(lra.classifyPostSweepBehavior(alert, candles), 'RE_CROSS');
});

test('11L.10：ADJACENT（sweep 紧邻/在 leg 内）', function () {
    var candles = mkCandles();
    var alert = {
        direction: 'BULLISH', formationStartIndex: 10,
        liquidityContext: { immediateSweep: { candleIndex: 9, sourcePrice: 99 } } // s+1 = 10 >= legStart
    };
    assert.strictEqual(lra.classifyPostSweepBehavior(alert, candles), 'ADJACENT');
});

test('11L.10：DELAYED_RECLAIM（未立即 reclaim 但无 re-cross）', function () {
    var candles = mkCandles();
    // BULLISH + SSL sweep @ p=99.6：idx 6 close 99.2 < 99.6（未 reclaim），但 idx 7-11 low >= 99.6（无 re-cross）
    candles[6] = m5(98.5, 100.2, 98.4, 99.2, 6);
    for (var j = 7; j < 12; j++) candles[j] = m5(99.7, 100.8, 99.6, 100.3, j);
    var alert = {
        direction: 'BULLISH', formationStartIndex: 12,
        liquidityContext: { immediateSweep: { candleIndex: 5, sourcePrice: 99.6 } }
    };
    assert.strictEqual(lra.classifyPostSweepBehavior(alert, candles), 'DELAYED_RECLAIM');
});

test('11L.10：BEARISH 对称（BSL sweep @ p=101）', function () {
    var candles = mkCandles();
    // BEARISH：idx 6 close 100.5 <= 101（reclaim），idx 7-11 high <= 101（无 re-cross）→ IMMEDIATE
    candles[6] = m5(101.5, 102.0, 100.2, 100.5, 6);
    for (var j = 7; j < 12; j++) candles[j] = m5(100.4, 100.9, 99.8, 99.9, j);
    var alert = {
        direction: 'BEARISH', formationStartIndex: 12,
        liquidityContext: { immediateSweep: { candleIndex: 5, sourcePrice: 101 } }
    };
    assert.strictEqual(lra.classifyPostSweepBehavior(alert, candles), 'IMMEDIATE_REJECTION');
    // re-cross：idx 9 high = 101.5 > 101
    candles[9] = m5(100.0, 101.5, 99.5, 100.2, 9);
    assert.strictEqual(lra.classifyPostSweepBehavior(alert, candles), 'RE_CROSS');
});

test('11L.10：NO_SWEEP / UNKNOWN', function () {
    var candles = mkCandles();
    var alertNo = { direction: 'BULLISH', formationStartIndex: 12, liquidityContext: null };
    assert.strictEqual(lra.classifyPostSweepBehavior(alertNo, candles), 'NO_SWEEP');
    var alertBad = { direction: 'BULLISH', formationStartIndex: 12, liquidityContext: { immediateSweep: {} } };
    assert.strictEqual(lra.classifyPostSweepBehavior(alertBad, candles), 'UNKNOWN');
});

/* ---------- auditRelevance ---------- */

test('11L.10：交叉表 + behavior 分布（只统计 HIGH）', function () {
    var candles = mkCandles();
    // 通知后触达 near
    candles[21] = m5(100.5, 105.5, 100.4, 105.2, 21);
    var alerts = [
        // HIGH + SWING + IMMEDIATE_REJECTION（sweep idx 5, legStart 12, barsBeforeLegStart 7）
        { id: 'a', tier: 'HIGH_QUALITY', direction: 'BULLISH', formationStartIndex: 12,
          availableIndex: 19, anchorIndex: 19, notificationPrice: 100.5, notificationNearTarget: 105, nearTarget: 105,
          liquidityContext: { immediateSweep: { candleIndex: 5, sourcePrice: 99, sourceType: 'SWING_LOW', barsBeforeLegStart: 7 } } },
        // HIGH + SIGNIFICANT + IMMEDIATE_REJECTION（EQL）
        { id: 'b', tier: 'HIGH_QUALITY', direction: 'BULLISH', formationStartIndex: 12,
          availableIndex: 19, anchorIndex: 19, notificationPrice: 100.5, notificationNearTarget: 105, nearTarget: 105,
          liquidityContext: { immediateSweep: { candleIndex: 5, sourcePrice: 99, sourceType: 'EQL', barsBeforeLegStart: 2 } } },
        // HIGH + NONE
        { id: 'c', tier: 'HIGH_QUALITY', direction: 'BULLISH', formationStartIndex: 12,
          availableIndex: 19, anchorIndex: 19, notificationPrice: 100.5, notificationNearTarget: 105, nearTarget: 105,
          liquidityContext: null },
        // 非 HIGH 不应统计
        { id: 'd', tier: 'WATCH', direction: 'BULLISH', formationStartIndex: 12,
          availableIndex: 19, anchorIndex: 19, notificationPrice: 100.5, notificationNearTarget: 105, nearTarget: 105,
          liquidityContext: { immediateSweep: { candleIndex: 5, sourcePrice: 99, sourceType: 'SWING_LOW', barsBeforeLegStart: 2 } } }
    ];
    var res = lra.auditRelevance(alerts, candles);
    // 交叉表
    assert.strictEqual(res.cross['SWING|7-12 bars'].n, 1, 'SWING × 7-12 桶');
    assert.strictEqual(res.cross['SIGNIFICANT|1-3 bars'].n, 1, 'EQL → SIGNIFICANT × 1-3 桶');
    assert.strictEqual(res.cross['NONE'].n, 1);
    assert.strictEqual(res.cross['SWING|1-3 bars'], undefined, 'WATCH 不统计');
    // behavior（默认 candles low=99，sweep p=99 → s+2 起无 low<99 → IMMEDIATE_REJECTION）
    assert.strictEqual(res.behavior.IMMEDIATE_REJECTION.n, 2, 'a、b 都是 immediate rejection（无 re-cross）');
    assert.strictEqual(res.behavior.NO_SWEEP.n, 1, 'c：无 sweep');
    assert.strictEqual(res.behavior.RE_CROSS, undefined, '无 re-cross 样本时不创建桶');
    // NearHit 计入
    assert.strictEqual(res.behavior.NO_SWEEP.nearHit1h, 1, '通知后 1h 触达');
    assert.strictEqual(res.behavior.NO_SWEEP.mfeCnt, 1);
});

/* ---------- statOne 完整窗口（11L.15a right-censoring） ---------- */

test('11L.15a：statOne 只计完整窗口（1h 不足 12 根不算 miss）', function () {
    var candles = mkCandles(); // 40 根
    var win = [{ key: '30m', bars: 6 }, { key: '1h', bars: 12 }];
    function mkAlert(availIdx) {
        return { id: 'x', direction: 'BULLISH', availableIndex: availIdx, anchorIndex: availIdx,
            notificationPrice: 100.5, notificationNearTarget: 105, nearTarget: 105 };
    }
    // availIdx=33 → start=34：30m 完整（34+6=40 <= 40），1h 不完整（34+12=46 > 40）
    var st = lra.statOne(mkAlert(33), candles, win);
    assert.strictEqual(st.complete30, true, '30m 恰好完整 6 根');
    assert.strictEqual(st.complete1h, false, '1h 不足 12 根 → 不完整');
    assert.strictEqual(st.near1h, false, '不完整窗口不算 hit');
    // availIdx=35 → start=36：30m 也不完整（36+6=42 > 40）
    var st2 = lra.statOne(mkAlert(35), candles, win);
    assert.strictEqual(st2.complete30, false);
    assert.strictEqual(st2.complete1h, false);
    // availIdx=19 → start=20：两个窗口都完整
    var st3 = lra.statOne(mkAlert(19), candles, win);
    assert.strictEqual(st3.complete30, true);
    assert.strictEqual(st3.complete1h, true);
});

test('11L.15a：accAdd 不完整窗口不计 denominator 与 MFE', function () {
    var ap = require('../stats/alertPrioritization');
    var candles = mkCandles(); // 40 根
    var acc = ap.newAcc();
    // availIdx=35 → 无完整窗口：n 计、nearCnt/mfeCnt 不计
    ap.accAdd(acc, { id: 'y', tier: 'HIGH_QUALITY', direction: 'BULLISH',
        availableIndex: 35, anchorIndex: 35, notificationPrice: 100.5, notificationNearTarget: 105 }, candles);
    assert.strictEqual(acc.n, 1);
    assert.strictEqual(acc.nearCnt30m, 0, '30m 不完整 → 不计 denominator');
    assert.strictEqual(acc.nearCnt1h, 0);
    assert.strictEqual(acc.mfeCnt, 0, 'MFE 需完整 1h');
    // availIdx=33 → 30m 完整但 1h 不完整：nearCnt30m=1、nearCnt1h=0、mfeCnt=0
    ap.accAdd(acc, { id: 'z', tier: 'HIGH_QUALITY', direction: 'BULLISH',
        availableIndex: 33, anchorIndex: 33, notificationPrice: 100.5, notificationNearTarget: 105 }, candles);
    assert.strictEqual(acc.n, 2);
    assert.strictEqual(acc.nearCnt30m, 1);
    assert.strictEqual(acc.nearCnt1h, 0, '1h 不完整 → 不计 1h denominator');
    assert.strictEqual(acc.mfeCnt, 0);
});

// ---------- 结果 ----------
console.log('liquidityRelevanceAudit tests: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) {
    process.exit(1);
}
