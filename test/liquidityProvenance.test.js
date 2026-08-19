/**
 * Phase 11L.8 — Liquidity Provenance / Notification Explainability 测试
 *
 * 覆盖：
 *   - associateSweeps：方向过滤（LONG→SSL / SHORT→BSL）
 *   - confirmedAt <= availableAt（无 future leakage，fail-closed）
 *   - 窗口边界：leg.startIndex - maxLookbackBars → leg.endIndex
 *   - INSIDE_LEG（Leg K1 → Sweep → Leg K2/K3 允许）
 *   - primary = 最近候选；sweeps[] = 全候选（含 barsBeforeLegStart / relation）
 *   - NONE：无可靠关联返回 null（不猜测）
 *   - classifyMssLegRelation 四态
 *   - formatSweepPriceLine / formatSweepRelationLine（通知行）
 *   - buildAlerts 集成：alert.sweep 兼容 + liquidityContext + mssRelation
 */
var assert = require('assert');
var lp = require('../stats/liquidityProvenance');
var alertReplay = require('../stats/alertReplay');

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

function sweep(over) {
    return {
        id: 'SW:1', symbol: 'X', timeframe: '5m', type: 'LIQUIDITY_SWEEP',
        direction: 'BULLISH', side: 'SSL', liquidityId: 'L1', liquidityType: 'EQL',
        price: 99.8, confirmedAt: 1500001, candleIndex: 5,
        source: { liquidityId: 'L1', liquidityType: 'EQL', liquidityPrice: 99.8, side: 'SSL' },
        metadata: {}
    };
}

function leg(over) {
    return {
        startIndex: 10, endIndex: 12, lastIndex: 12,
        firstConfirmedAt: 1300001, lastConfirmedAt: 1500001,
        direction: 'BULLISH', ids: ['d1']
    };
}

/* ---------- 方向过滤 ---------- */

test('11L.8：BULLISH 只关联 SSL，忽略 BSL', function () {
    var sweeps = [
        { id: 's1', side: 'SSL', price: 99, confirmedAt: 1200001, candleIndex: 3 },
        { id: 's2', side: 'BSL', price: 105, confirmedAt: 1210001, candleIndex: 4 }
    ];
    var ctx = lp.associateSweeps({
        direction: 'BULLISH', leg: leg(), availableAt: 2000000, sweepEvents: sweeps
    });
    assert.ok(ctx, '有候选');
    assert.strictEqual(ctx.primarySweepId, 's1', 'BSL 被过滤，primary 是 SSL');
    assert.strictEqual(ctx.sweeps.length, 1, '候选只有 1 个 SSL');
});

test('11L.8：BEARISH 只关联 BSL', function () {
    var sweeps = [
        { id: 's1', side: 'SSL', price: 99, confirmedAt: 1200001, candleIndex: 3 },
        { id: 's2', side: 'BSL', price: 105, confirmedAt: 1210001, candleIndex: 4 }
    ];
    var ctx = lp.associateSweeps({
        direction: 'BEARISH', leg: leg(), availableAt: 2000000, sweepEvents: sweeps
    });
    assert.ok(ctx);
    assert.strictEqual(ctx.primarySweepId, 's2');
});

/* ---------- future leakage ---------- */

test('11L.8：sweep.confirmedAt > availableAt → 排除（无 future leakage）', function () {
    var sweeps = [
        { id: 's1', side: 'SSL', price: 99, confirmedAt: 9000001, candleIndex: 3 }, // 未来（availableAt 之后）
        { id: 's2', side: 'SSL', price: 98, confirmedAt: 1200001, candleIndex: 4 }  // 合法
    ];
    var ctx = lp.associateSweeps({
        direction: 'BULLISH', leg: leg(), availableAt: 2000000, sweepEvents: sweeps
    });
    assert.ok(ctx);
    assert.strictEqual(ctx.primarySweepId, 's2', '未来 sweep 被排除');
    assert.strictEqual(ctx.sweeps.length, 1);
});

test('11L.8：confirmedAt 缺失（旧构造）→ fail-closed 拒绝，不猜测', function () {
    var sweeps = [{ id: 's1', side: 'SSL', price: 99, candleIndex: 3 }]; // 无 confirmedAt
    var ctx = lp.associateSweeps({
        direction: 'BULLISH', leg: leg(), availableAt: 2000000, sweepEvents: sweeps
    });
    assert.strictEqual(ctx, null, '缺 confirmedAt 无法验证 leakage → NONE');
});

/* ---------- 窗口边界 ---------- */

test('11L.8：窗口 = leg.startIndex - N → leg.endIndex', function () {
    var sweeps = [
        { id: 'in', side: 'SSL', price: 99, confirmedAt: 1200001, candleIndex: 8 },   // start 10 - N(3)=7 → 8 在窗口内
        { id: 'out', side: 'SSL', price: 98, confirmedAt: 1100001, candleIndex: 6 }   // 6 < 7 → 窗口外
    ];
    var ctx = lp.associateSweeps({
        direction: 'BULLISH', leg: leg(), availableAt: 2000000, sweepEvents: sweeps, maxLookbackBars: 3
    });
    assert.ok(ctx);
    assert.strictEqual(ctx.sweeps.length, 1, '窗口外候选被排除');
    assert.strictEqual(ctx.primarySweepId, 'in');
});

test('11L.8：sweep 在 leg.endIndex 之后 → 排除（必须与 leg 形成过程相关）', function () {
    var sweeps = [{ id: 's1', side: 'SSL', price: 99, confirmedAt: 1600001, candleIndex: 13 }]; // endIndex 12 之后
    var ctx = lp.associateSweeps({
        direction: 'BULLISH', leg: leg(), availableAt: 2000000, sweepEvents: sweeps
    });
    assert.strictEqual(ctx, null, 'leg 后的 sweep 不关联');
});

/* ---------- INSIDE_LEG ---------- */

test('11L.8：Leg K1 → Sweep → Leg K2/K3 → INSIDE_LEG（允许，不强迫三段式）', function () {
    var sweeps = [{ id: 's1', side: 'SSL', price: 99, confirmedAt: 1400001, candleIndex: 11 }]; // leg 内（start 10..end 12）
    var ctx = lp.associateSweeps({
        direction: 'BULLISH', leg: leg(), availableAt: 2000000, sweepEvents: sweeps
    });
    assert.ok(ctx);
    assert.strictEqual(ctx.primary.relation, 'INSIDE_LEG');
    assert.strictEqual(ctx.primary.barsBeforeLegStart, -1, '10 - 11 = -1（leg 内）');
});

/* ---------- primary / sweeps[] ---------- */

test('11L.8：primary = confirmedAt 最近；sweeps[] = 全候选升序', function () {
    var sweeps = [
        { id: 'old', side: 'SSL', price: 98, confirmedAt: 1000001, candleIndex: 2 },
        { id: 'mid', side: 'SSL', price: 99, confirmedAt: 1200001, candleIndex: 6 },
        { id: 'new', side: 'SSL', price: 99.5, confirmedAt: 1250001, candleIndex: 8 }
    ];
    var ctx = lp.associateSweeps({
        direction: 'BULLISH', leg: leg(), availableAt: 2000000, sweepEvents: sweeps
    });
    assert.strictEqual(ctx.primarySweepId, 'new', '最近的为 primary');
    assert.strictEqual(ctx.sweeps.length, 3);
    assert.strictEqual(ctx.sweeps[0].id, 'old');
    assert.strictEqual(ctx.sweeps[2].id, 'new');
    assert.strictEqual(ctx.sweeps[0].relation, 'BEFORE_LEG');
    assert.strictEqual(ctx.sweeps[0].barsBeforeLegStart, 8, '10-2=8');
});

test('11L.8：无候选 → null（NONE，不猜测）', function () {
    var ctx = lp.associateSweeps({
        direction: 'BULLISH', leg: leg(), availableAt: 2000000, sweepEvents: []
    });
    assert.strictEqual(ctx, null);
});

/* ---------- classifyMssLegRelation ---------- */

test('11L.8：classifyMssLegRelation 四态', function () {
    var l = leg();
    assert.strictEqual(lp.classifyMssLegRelation(l, null), 'NONE', '无 MSS → NONE');
    assert.strictEqual(lp.classifyMssLegRelation(l, { confirmedAt: 1200001 }), 'BEFORE_LEG', 'MSS 在 leg 前');
    assert.strictEqual(lp.classifyMssLegRelation(l, { confirmedAt: 1400001 }), 'INSIDE_LEG', 'MSS 在 leg 内');
    assert.strictEqual(lp.classifyMssLegRelation(l, { confirmedAt: 1600001 }), 'AFTER_LEG', 'MSS 在 leg 后');
    // index 回退（无 confirmedAt 时）
    assert.strictEqual(lp.classifyMssLegRelation({ startIndex: 10, endIndex: 12 }, { candleIndex: 8 }), 'BEFORE_LEG');
    assert.strictEqual(lp.classifyMssLegRelation({ startIndex: 10, endIndex: 12 }, { candleIndex: 11 }), 'INSIDE_LEG');
});

/* ---------- 通知行格式化 ---------- */

test('11L.8：formatSweepPriceLine / formatSweepRelationLine', function () {
    var p = { side: 'SSL', sourceTimeframe: '5m', sourceType: 'EQL', sourcePrice: 1902.4, relation: 'BEFORE_LEG', barsBeforeLegStart: 3 };
    assert.strictEqual(lp.formatSweepPriceLine(p), 'SSL · 5M EQL @ 1902.40');
    assert.strictEqual(lp.formatSweepRelationLine(p), '发生于 Leg 前 3 bars');
    var p2 = { side: 'SSL', sourceTimeframe: '5m', sourceType: 'EQL', sourcePrice: 1902.4, relation: 'INSIDE_LEG', barsBeforeLegStart: -1 };
    assert.strictEqual(lp.formatSweepRelationLine(p2), '发生于 Leg 内');
    assert.strictEqual(lp.formatSweepPriceLine(null), null);
});

/* ---------- buildAlerts 集成 ---------- */

test('11L.8：buildAlerts —— alert.sweep 兼容 + liquidityContext + mssRelation', function () {
    var candles = [];
    for (var i = 0; i < 60; i++) candles.push(m5(100, 101, 99, 100.5, i));
    var fvgs = [
        { id: 'f1', direction: 'BULLISH', displacementEventId: 'd1', zoneLow: 100.2, zoneHigh: 100.8 }
    ];
    var opps = [
        { id: 'm1', direction: 'BULLISH', fvgIds: ['f1'], createdAt: 1000000, lastAt: 1400000 }
    ];
    var legByDispId = {
        d1: {
            quality: 'EXPLOSIVE', mssQuality: 'PROTECTED_SWING',
            startIndex: 15, endIndex: 20, lastIndex: 20,
            firstConfirmedAt: candles[15].closeTime, lastConfirmedAt: candles[20].closeTime,
            direction: 'BULLISH', ids: ['d1'], mssId: 'm1',
            rangeAtr: 2.6, netMoveAtr: 2.1, bodyEfficiency: 0.7
        }
    };
    var drawTrace = [];
    drawTrace[20] = { bslNear: 105, bslMacro: 110, sslNear: null, sslMacro: null };
    var sweeps = [
        { id: 'sw1', side: 'SSL', price: 98.5, liquidityType: 'EQL', timeframe: '5m', confirmedAt: candles[15].closeTime - 1, candleIndex: 14 },
        { id: 'sw2', side: 'SSL', price: 97, liquidityType: 'EQL', timeframe: '5m', confirmedAt: candles[12].closeTime - 1, candleIndex: 11 }
    ];
    var mssEvents = [{ id: 'm1', source: { referencePrice: 99.0, breakPct: 0.0012 }, confirmedAt: candles[15].closeTime - 1 }];
    var alerts = alertReplay.buildAlerts(opps, fvgs, legByDispId, drawTrace, sweeps, candles, mssEvents);
    assert.strictEqual(alerts.length, 1);
    var al = alerts[0];
    // 兼容字段：sweep 摘要（primary = 最近的 sw1）
    assert.ok(al.sweep && al.sweep.side === 'SSL');
    assert.strictEqual(al.sweep.barsAgo, 20 - 14, 'anchor 20 - sweep 14 = 6');
    assert.strictEqual(al.sweep.relation, 'BEFORE_LEG');
    assert.strictEqual(al.sweep.sourceType, 'EQL');
    // 新结构：liquidityContext
    assert.ok(al.liquidityContext);
    assert.strictEqual(al.liquidityContext.primarySweepId, 'sw1');
    assert.strictEqual(al.liquidityContext.sweeps.length, 2, '全候选记录（诊断用）');
    assert.strictEqual(al.liquidityContext.primary.barsBeforeLegStart, 15 - 14, 'start 15 - candle 14 = 1');
    // mssRelation：MSS confirmedAt < leg.firstConfirmedAt → BEFORE_LEG
    assert.strictEqual(al.mssRelation, 'BEFORE_LEG');
});

test('11L.8：buildAlerts —— 无法关联 → liquidityContext null + mssRelation NONE', function () {
    var candles = [];
    for (var i = 0; i < 60; i++) candles.push(m5(100, 101, 99, 100.5, i));
    var fvgs = [{ id: 'f1', direction: 'BULLISH', displacementEventId: 'd1', zoneLow: 100.2, zoneHigh: 100.8 }];
    var opps = [{ id: 'm1', direction: 'BULLISH', fvgIds: ['f1'], createdAt: 1000000, lastAt: 1400000 }];
    var legByDispId = {
        d1: {
            quality: 'EXPLOSIVE', mssQuality: 'PROTECTED_SWING',
            startIndex: 15, endIndex: 20, lastIndex: 20,
            firstConfirmedAt: candles[15].closeTime, lastConfirmedAt: candles[20].closeTime,
            direction: 'BULLISH', ids: ['d1'], rangeAtr: 2.6, netMoveAtr: 2.1, bodyEfficiency: 0.7
        }
    };
    var drawTrace = [];
    drawTrace[20] = { bslNear: 105, bslMacro: 110, sslNear: null, sslMacro: null };
    var alerts = alertReplay.buildAlerts(opps, fvgs, legByDispId, drawTrace, [], candles, []);
    assert.strictEqual(alerts.length, 1);
    assert.strictEqual(alerts[0].liquidityContext, null);
    assert.strictEqual(alerts[0].sweep, null);
    assert.strictEqual(alerts[0].mssRelation, 'NONE');
});

// ---------- 结果 ----------
console.log('liquidityProvenance tests: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) {
    process.exit(1);
}
