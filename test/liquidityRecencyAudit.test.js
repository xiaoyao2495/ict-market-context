/**
 * Phase 11L.10 — Liquidity Recency Audit 测试
 *
 * 覆盖：
 *   - bucketOf 分桶边界（INSIDE_LEG / 1-3 / 4-6 / 7-12 / 13-24 / 25-48 / NONE / >48 防御）
 *   - auditLiquidityRecency：只统计 HIGH、分桶聚合、NearHit30m/1h/MFE/MAE
 */
var assert = require('assert');
var lra = require('../stats/liquidityRecencyAudit');

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

/* ---------- 分桶边界 ---------- */

test('11L.10：bucketOf 边界（含两端）', function () {
    assert.strictEqual(lra.bucketOf(0), 'INSIDE_LEG', '0 = leg 第一根 → INSIDE');
    assert.strictEqual(lra.bucketOf(-3), 'INSIDE_LEG', '负数 = leg 内');
    assert.strictEqual(lra.bucketOf(1), '1-3 bars');
    assert.strictEqual(lra.bucketOf(3), '1-3 bars');
    assert.strictEqual(lra.bucketOf(4), '4-6 bars');
    assert.strictEqual(lra.bucketOf(6), '4-6 bars');
    assert.strictEqual(lra.bucketOf(7), '7-12 bars');
    assert.strictEqual(lra.bucketOf(12), '7-12 bars');
    assert.strictEqual(lra.bucketOf(13), '13-24 bars');
    assert.strictEqual(lra.bucketOf(24), '13-24 bars');
    assert.strictEqual(lra.bucketOf(25), '25-48 bars');
    assert.strictEqual(lra.bucketOf(48), '25-48 bars');
    assert.strictEqual(lra.bucketOf(null), 'NONE', '无 immediateSweep → NONE');
    assert.strictEqual(lra.bucketOf(49), '>48', '窗口外（防御，正常不应出现）');
});

/* ---------- 统计聚合 ---------- */

test('11L.10：只统计 HIGH；NONE 与分桶样本分开计数', function () {
    var candles = [];
    for (var i = 0; i < 60; i++) candles.push(m5(100, 101, 99, 100.5, i));
    // 让通知后 1h 内触达 near（high >= 105）
    candles[21] = m5(100.5, 105.5, 100.4, 105.2, 21);
    var alerts = [
        // HIGH + sweep 距 leg.start 2 bars（1-3 桶）
        { id: 'a', tier: 'HIGH_QUALITY', direction: 'BULLISH', availableIndex: 19, anchorIndex: 19,
          notificationPrice: 100.5, notificationNearTarget: 105, nearTarget: 105,
          liquidityContext: { immediateSweep: { barsBeforeLegStart: 2 } } },
        // HIGH + NONE（无 sweep）
        { id: 'b', tier: 'HIGH_QUALITY', direction: 'BULLISH', availableIndex: 19, anchorIndex: 19,
          notificationPrice: 100.5, notificationNearTarget: 105, nearTarget: 105,
          liquidityContext: null },
        // 非 HIGH（不应统计）
        { id: 'c', tier: 'WATCH', direction: 'BULLISH', availableIndex: 19, anchorIndex: 19,
          notificationPrice: 100.5, notificationNearTarget: 105, nearTarget: 105,
          liquidityContext: { immediateSweep: { barsBeforeLegStart: 2 } } }
    ];
    var res = lra.auditLiquidityRecency(alerts, candles);
    var b = res.buckets;
    assert.strictEqual(b['1-3 bars'].n, 1, '只有 HIGH 且 sweep 距 2 bars 入 1-3 桶');
    assert.strictEqual(b.NONE.n, 1, 'HIGH + 无 sweep 入 NONE');
    assert.strictEqual(b['1-3 bars'].nearHit1h, 1, '通知后 1h 触达 near');
    assert.strictEqual(b['1-3 bars'].nearHit30m, 1, '21 根在 30m 窗口内触达');
    assert.strictEqual(b.NONE.nearHit1h, 1, 'NONE 也按通知后行情统计');
    assert.ok(b['1-3 bars'].mfeCnt === 1 && b['1-3 bars'].mfeSum > 0, 'MFE 计入');
    assert.strictEqual(b['25-48 bars'].n, 0, '无样本桶为 0');
});

test('11L.10：全部分桶覆盖（模拟 7 类样本）', function () {
    var candles = [];
    for (var i = 0; i < 60; i++) candles.push(m5(100, 101, 99, 100.5, i));
    var cases = [
        [0, 'INSIDE_LEG'], [2, '1-3 bars'], [5, '4-6 bars'], [9, '7-12 bars'],
        [18, '13-24 bars'], [30, '25-48 bars'], [null, 'NONE']
    ];
    var alerts = cases.map(function (c, idx) {
        var bars = c[0];
        return {
            id: 'a' + idx, tier: 'HIGH_QUALITY', direction: 'BULLISH',
            availableIndex: 20, anchorIndex: 20,
            notificationPrice: 100.5, notificationNearTarget: 105, nearTarget: 105,
            liquidityContext: bars === null ? null : { immediateSweep: { barsBeforeLegStart: bars } }
        };
    });
    var res = lra.auditLiquidityRecency(alerts, candles);
    cases.forEach(function (c) {
        assert.strictEqual(res.buckets[c[1]].n, 1, c[1] + ' 桶各 1 样本');
    });
    assert.strictEqual(res.buckets['>48'], undefined, '无 >48 样本时不创建该桶（防御桶仅实际出现才建）');
});

test('11L.10：无有效通知时点样本不计入 NearHit（incomplete）', function () {
    var candles = [];
    for (var i = 0; i < 60; i++) candles.push(m5(100, 101, 99, 100.5, i));
    var alerts = [{
        id: 'a', tier: 'HIGH_QUALITY', direction: 'BULLISH',
        availableIndex: 59, anchorIndex: 59, // 通知后无数据
        notificationPrice: 100.5, notificationNearTarget: 105, nearTarget: 105,
        liquidityContext: { immediateSweep: { barsBeforeLegStart: 2 } }
    }];
    var res = lra.auditLiquidityRecency(alerts, candles);
    assert.strictEqual(res.buckets['1-3 bars'].n, 1, '样本计数保留');
    assert.strictEqual(res.buckets['1-3 bars'].nearCnt1h, 0, '无通知后行情 → 不计入 NearHit');
    assert.strictEqual(res.buckets['1-3 bars'].mfeCnt, 0);
});

// ---------- 结果 ----------
console.log('liquidityRecencyAudit tests: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) {
    process.exit(1);
}
