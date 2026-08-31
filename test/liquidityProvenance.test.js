/**
 * Phase 11L.8 — Liquidity Provenance / Notification Explainability 测试（follow-up 收口）
 *
 * 覆盖：
 *   - associateSweeps 两字段结构：allCandidates / immediateSweep（primarySweep 兼容字段已移除）
 *   - 方向过滤（LONG→SSL / SHORT→BSL）
 *   - confirmedAt <= availableAt（无 future leakage，缺失 fail-closed）
 *   - 窗口边界：48 bars 内可关联、49 bars 外不可关联（production 窗口锁定）
 *   - immediateSweep = 距离 leg.startIndex 最近；距离相同取 confirmedAt 更新
 *   - INSIDE_LEG（Leg K1 → Sweep → Leg K2/K3 允许）
 *   - NONE：无可靠关联返回 null（不猜测）
 *   - sourceType 忠实展示；缺失 → UNKNOWN
 *   - formatSweepPriceLine / formatSweepRelationLine（BEFORE_LEG · 12 bars / INSIDE_LEG · 1 bar）
 *   - buildAlerts 集成：alert.sweep 兼容 + liquidityContext + mssRelation；NONE 时 HIGH 正常
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
        startAt: 1300001, endAt: 1500001,
        firstConfirmedAt: 1300001, lastConfirmedAt: 1500001,
        direction: 'BULLISH', ids: ['d1']
    };
}

/* ---------- 两字段结构 ---------- */

test('11L.8：返回结构 = { allCandidates, immediateSweep }（primarySweep 已移除）', function () {
    var sweeps = [
        { id: 's1', side: 'SSL', price: 99, confirmedAt: 1200001, candleIndex: 6 }
    ];
    var ctx = lp.associateSweeps({
        direction: 'BULLISH', displacement: leg(), availableAt: 2000000, sweepEvents: sweeps
    });
    assert.ok(ctx);
    assert.ok(Array.isArray(ctx.allCandidates), 'allCandidates 是数组');
    assert.strictEqual(ctx.allCandidates.length, 1);
    assert.ok(ctx.immediateSweep, 'immediateSweep 非空');
    assert.strictEqual(ctx.primarySweep, undefined, 'primarySweep 兼容字段已删除');
    assert.strictEqual(ctx.immediateSweep.id, 's1');
    assert.strictEqual(ctx.immediateSweep.relation, 'BEFORE_LEG');
});

/* ---------- 方向过滤 ---------- */

test('11L.8：BULLISH 只关联 SSL，忽略 BSL', function () {
    var sweeps = [
        { id: 's1', side: 'SSL', price: 99, confirmedAt: 1200001, candleIndex: 3 },
        { id: 's2', side: 'BSL', price: 105, confirmedAt: 1210001, candleIndex: 4 }
    ];
    var ctx = lp.associateSweeps({
        direction: 'BULLISH', displacement: leg(), availableAt: 2000000, sweepEvents: sweeps
    });
    assert.ok(ctx);
    assert.strictEqual(ctx.immediateSweep.id, 's1', 'BSL 被过滤');
    assert.strictEqual(ctx.allCandidates.length, 1);
});

test('11L.8：BEARISH 只关联 BSL', function () {
    var sweeps = [
        { id: 's1', side: 'SSL', price: 99, confirmedAt: 1200001, candleIndex: 3 },
        { id: 's2', side: 'BSL', price: 105, confirmedAt: 1210001, candleIndex: 4 }
    ];
    var ctx = lp.associateSweeps({
        direction: 'BEARISH', displacement: leg(), availableAt: 2000000, sweepEvents: sweeps
    });
    assert.strictEqual(ctx.immediateSweep.id, 's2');
});

/* ---------- future leakage ---------- */

test('11L.8：sweep.confirmedAt > availableAt → 排除（无 future leakage）', function () {
    var sweeps = [
        { id: 's1', side: 'SSL', price: 99, confirmedAt: 9000001, candleIndex: 3 }, // 未来
        { id: 's2', side: 'SSL', price: 98, confirmedAt: 1200001, candleIndex: 4 }  // 合法
    ];
    var ctx = lp.associateSweeps({
        direction: 'BULLISH', displacement: leg(), availableAt: 2000000, sweepEvents: sweeps
    });
    assert.ok(ctx);
    assert.strictEqual(ctx.immediateSweep.id, 's2', '未来 sweep 被排除');
    assert.strictEqual(ctx.allCandidates.length, 1);
});

test('11L.8：confirmedAt 缺失（旧构造）→ fail-closed 拒绝，不猜测', function () {
    var sweeps = [{ id: 's1', side: 'SSL', price: 99, candleIndex: 3 }];
    var ctx = lp.associateSweeps({
        direction: 'BULLISH', displacement: leg(), availableAt: 2000000, sweepEvents: sweeps
    });
    assert.strictEqual(ctx, null, '缺 confirmedAt 无法验证 leakage → NONE');
});

/* ---------- 48-bar 窗口边界（production 锁定） ---------- */

test('11L.8：48 bars 内可关联（leg.startIndex - 48 边界恰好命中）', function () {
    var sweeps = [
        { id: 's1', side: 'SSL', price: 99, confirmedAt: 1200001, candleIndex: 10 - 48 } // start 10 - 48 = -38 → candleIndex -38
    ];
    var ctx = lp.associateSweeps({
        direction: 'BULLISH', displacement: leg(), availableAt: 2000000, sweepEvents: sweeps, maxLookbackBars: 48
    });
    assert.ok(ctx, '恰好 48 bars 前 → 窗口内');
    assert.strictEqual(ctx.allCandidates.length, 1);
    assert.strictEqual(ctx.immediateSweep.barsBeforeLegStart, 48);
});

test('11L.8：49 bars 外不可关联（leg.startIndex - 49 越界）', function () {
    var sweeps = [
        { id: 's1', side: 'SSL', price: 99, confirmedAt: 1200001, candleIndex: 10 - 49 } // -39 < -38 → 窗口外
    ];
    var ctx = lp.associateSweeps({
        direction: 'BULLISH', displacement: leg(), availableAt: 2000000, sweepEvents: sweeps, maxLookbackBars: 48
    });
    assert.strictEqual(ctx, null, '49 bars 前 → 窗口外 → NONE');
});

test('11L.8：默认 maxLookbackBars = 48（production 窗口）', function () {
    var sweeps = [
        { id: 's1', side: 'SSL', price: 99, confirmedAt: 1200001, candleIndex: 10 - 48 },
        { id: 's2', side: 'SSL', price: 98, confirmedAt: 1100001, candleIndex: 10 - 49 }
    ];
    var ctx = lp.associateSweeps({
        direction: 'BULLISH', displacement: leg(), availableAt: 2000000, sweepEvents: sweeps
    });
    assert.ok(ctx);
    assert.strictEqual(ctx.allCandidates.length, 1, '默认窗口 48，49 bars 外被排除');
    assert.strictEqual(lp.DEFAULT_MAX_LOOKBACK_BARS, 48);
});

test('11L.8：sweep 在 leg.endIndex 之后 → 排除（必须与 leg 形成过程相关）', function () {
    var sweeps = [{ id: 's1', side: 'SSL', price: 99, confirmedAt: 1600001, candleIndex: 13 }]; // endIndex 12 之后
    var ctx = lp.associateSweeps({
        direction: 'BULLISH', displacement: leg(), availableAt: 2000000, sweepEvents: sweeps
    });
    assert.strictEqual(ctx, null);
});

/* ---------- immediateSweep 选择 ---------- */

test('11L.8：immediateSweep = 距离 leg.startIndex 最近', function () {
    var sweeps = [
        { id: 'far', side: 'SSL', price: 98, confirmedAt: 1100001, candleIndex: 2 },  // 距 start 10 有 8
        { id: 'near', side: 'SSL', price: 99, confirmedAt: 1250001, candleIndex: 8 }  // 距 start 10 有 2 → 最近
    ];
    var ctx = lp.associateSweeps({
        direction: 'BULLISH', displacement: leg(), availableAt: 2000000, sweepEvents: sweeps
    });
    assert.strictEqual(ctx.immediateSweep.id, 'near', '距离最近者胜');
    assert.strictEqual(ctx.allCandidates.length, 2, 'allCandidates 保留全部');
});

test('11L.8：距离相同 → 取 confirmedAt 更新的', function () {
    var sweeps = [
        { id: 'old', side: 'SSL', price: 98, confirmedAt: 1100001, candleIndex: 8 },  // 距 2，旧
        { id: 'new', side: 'SSL', price: 99, confirmedAt: 1250001, candleIndex: 12 }  // 距 |10-12|=2，新 → 胜
    ];
    var ctx = lp.associateSweeps({
        direction: 'BULLISH', displacement: leg(), availableAt: 2000000, sweepEvents: sweeps
    });
    assert.strictEqual(ctx.immediateSweep.id, 'new', '距离相同取 confirmedAt 更新');
});

test('11L.8：INSIDE_LEG（Leg K1 → Sweep → Leg K2/K3）允许', function () {
    var sweeps = [{ id: 's1', side: 'SSL', price: 99, confirmedAt: 1400001, candleIndex: 11 }]; // leg 内
    var ctx = lp.associateSweeps({
        direction: 'BULLISH', displacement: leg(), availableAt: 2000000, sweepEvents: sweeps
    });
    assert.ok(ctx);
    assert.strictEqual(ctx.immediateSweep.relation, 'INSIDE_LEG');
    assert.strictEqual(ctx.immediateSweep.barsBeforeLegStart, -1, '10 - 11 = -1');
});

test('11L.8：无候选 → null（NONE，不猜测）', function () {
    var ctx = lp.associateSweeps({
        direction: 'BULLISH', displacement: leg(), availableAt: 2000000, sweepEvents: []
    });
    assert.strictEqual(ctx, null);
});

/* ---------- sourceType 忠实展示 ---------- */

test('11L.8：sourceType 原样展示（SWING_LOW/EQL 等）；缺失 → UNKNOWN', function () {
    var sweeps = [
        { id: 's1', side: 'SSL', price: 99, confirmedAt: 1200001, candleIndex: 6, source: { liquidityType: 'SWING_LOW' } },
        { id: 's2', side: 'SSL', price: 98, confirmedAt: 1100001, candleIndex: 5, source: {} }
    ];
    var ctx = lp.associateSweeps({
        direction: 'BULLISH', displacement: leg(), availableAt: 2000000, sweepEvents: sweeps
    });
    // allCandidates 按 confirmedAt 升序：s2(1100001) 在前、s1(1200001) 在后
    assert.strictEqual(ctx.allCandidates[1].sourceType, 'SWING_LOW');
    assert.strictEqual(ctx.allCandidates[0].sourceType, 'UNKNOWN', '缺失不猜测，不美化');
});

/* ---------- 通知行格式化 ---------- */

test('11L.8：formatSweepPriceLine / formatSweepRelationLine（新措辞格式）', function () {
    var p = { side: 'SSL', sourceTimeframe: '5m', sourceType: 'SWING_LOW', sourcePrice: 66000, relation: 'BEFORE_LEG', barsBeforeLegStart: 12 };
    assert.strictEqual(lp.formatSweepPriceLine(p), 'SSL · 5M SWING_LOW @ 66000.00');
    assert.strictEqual(lp.formatSweepRelationLine(p), 'BEFORE_LEG · 12 bars');
    var p2 = { side: 'BSL', sourceTimeframe: '5m', sourceType: 'EQH', sourcePrice: 67250, relation: 'INSIDE_LEG', barsBeforeLegStart: 0 };
    assert.strictEqual(lp.formatSweepPriceLine(p2), 'BSL · 5M EQH @ 67250.00');
    assert.strictEqual(lp.formatSweepRelationLine(p2), 'INSIDE_LEG · 1 bar', '腿内第 1 根 → 1 bar（单数）');
    var p3 = { side: 'SSL', sourceTimeframe: '5m', sourceType: 'SWING_LOW', sourcePrice: 66000, relation: 'INSIDE_LEG', barsBeforeLegStart: -2 };
    assert.strictEqual(lp.formatSweepRelationLine(p3), 'INSIDE_LEG · 3 bars', '腿内第 3 根 → 3 bars');
    assert.strictEqual(lp.formatSweepPriceLine(null), null);
    // sourceType 缺失 → UNKNOWN（不猜测）
    var p4 = { side: 'SSL', sourceTimeframe: null, sourceType: null, sourcePrice: 1.5 };
    assert.strictEqual(lp.formatSweepPriceLine(p4), 'SSL · UNKNOWN UNKNOWN @ 1.50');
});

test('11L.8：价格行含 sweep 时间（UTC+8 MM-DD HH:MM，用户示例 "08-19 20:05"）', function () {
    // 2026-08-19 12:05 UTC = 20:05 UTC+8
    var ms = Date.UTC(2026, 7, 19, 12, 5, 0);
    assert.strictEqual(lp.fmtSweepTime(ms), '08-19 20:05');
    assert.strictEqual(lp.fmtSweepTime(null), null, '缺 confirmedAt → 不显示时间');
    var p = { side: 'SSL', sourceTimeframe: '5m', sourceType: 'SWING_LOW', sourcePrice: 66000, confirmedAt: ms };
    assert.strictEqual(lp.formatSweepPriceLine(p), 'SSL · 5M SWING_LOW @ 66000.00 · 08-19 20:05');
    // 无 confirmedAt → 原样（不追加时间）
    var p2 = { side: 'SSL', sourceTimeframe: '5m', sourceType: 'SWING_LOW', sourcePrice: 66000 };
    assert.strictEqual(lp.formatSweepPriceLine(p2), 'SSL · 5M SWING_LOW @ 66000.00');
});

/* ---------- buildAlerts 集成 ---------- */

test('11L.8：buildAlerts —— alert.sweep + liquidityContext', function () {
    var candles = [];
    for (var i = 0; i < 60; i++) candles.push(m5(100, 101, 99, 100.5, i));
    var fvgs = [
        { id: 'f1', direction: 'BULLISH', displacementEventId: 'd1', zoneLow: 100.2, zoneHigh: 100.8 }
    ];
    var opps = [
        { id: 'm1', direction: 'BULLISH', canonicalDisplacementId: 'd1', fvgIds: ['f1'], createdAt: 1000000, lastAt: 1400000 }
    ];
    var legByDispId = {
        d1: {
            id: 'd1', type: 'DISPLACEMENT', atr: 0.5, startPrice: 99, endPrice: 101,
            startIndex: 15, endIndex: 20, lastIndex: 20,
            startAt: candles[15].openTime, endAt: candles[20].closeTime,
            confirmedAt: candles[20].closeTime, direction: 'BULLISH'
        }
    };
    var drawTrace = [];
    drawTrace[20] = { bslNear: 105, bslMacro: 110, sslNear: null, sslMacro: null };
    var sweeps = [
        { id: 'sw1', side: 'SSL', price: 98.5, liquidityType: 'EQL', timeframe: '5m', confirmedAt: candles[14].closeTime, candleIndex: 14, source: { liquidityType: 'EQL' } },
        { id: 'sw2', side: 'SSL', price: 97, liquidityType: 'SWING_LOW', timeframe: '5m', confirmedAt: candles[12].closeTime - 1, candleIndex: 11, source: { liquidityType: 'SWING_LOW' } }
    ];
    var mssEvents = [{ id: 'm1', source: { referencePrice: 99.0, breakPct: 0.0012 }, confirmedAt: candles[15].closeTime - 1 }];
    var alerts = alertReplay.buildAlerts(opps, fvgs, legByDispId, drawTrace, sweeps, candles, mssEvents);
    assert.strictEqual(alerts.length, 1);
    var al = alerts[0];
    // 兼容字段：sweep 摘要（immediateSweep = 距 start 15 最近 → sw1 距 1）
    assert.ok(al.sweep && al.sweep.side === 'SSL');
    assert.strictEqual(al.sweep.barsAgo, 20 - 14, 'anchor 20 - sweep 14 = 6');
    assert.strictEqual(al.sweep.relation, 'BEFORE_LEG');
    assert.strictEqual(al.sweep.sourceType, 'EQL');
    // 新结构：liquidityContext 两字段（allCandidates + immediateSweep）
    assert.ok(al.liquidityContext);
    assert.strictEqual(al.liquidityContext.immediateSweep.id, 'sw1', '距 leg.startIndex(15) 最近');
    assert.strictEqual(al.liquidityContext.primarySweep, undefined, 'primarySweep 已移除');
    assert.strictEqual(al.liquidityContext.allCandidates.length, 2, '全候选保留');
    assert.strictEqual(al.liquidityContext.immediateSweep.barsBeforeLegStart, 1, '15 - 14 = 1');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(al, 'mssRelation'), false);
});

test('11L.8：buildAlerts —— 无 sweep → liquidityContext null，HIGH 仍正常产生（NONE 不降级）', function () {
    var candles = [];
    for (var i = 0; i < 60; i++) candles.push(m5(100, 101, 99, 100.5, i));
    var fvgs = [{ id: 'f1', direction: 'BULLISH', displacementEventId: 'd1', zoneLow: 100.2, zoneHigh: 100.8 }];
    var opps = [{ id: 'm1', direction: 'BULLISH', canonicalDisplacementId: 'd1', fvgIds: ['f1'], createdAt: 1000000, lastAt: 1400000 }];
    var legByDispId = {
        d1: {
            id: 'd1', type: 'DISPLACEMENT', atr: 0.5, startPrice: 99, endPrice: 101,
            startIndex: 15, endIndex: 20, lastIndex: 20,
            startAt: candles[15].openTime, endAt: candles[20].closeTime,
            confirmedAt: candles[20].closeTime, direction: 'BULLISH'
        }
    };
    var drawTrace = [];
    drawTrace[20] = { bslNear: 105, bslMacro: 110, sslNear: null, sslMacro: null };
    var alerts = alertReplay.buildAlerts(opps, fvgs, legByDispId, drawTrace, [], candles, []);
    assert.strictEqual(alerts.length, 1);
    assert.strictEqual(alerts[0].liquidityContext, null);
    assert.strictEqual(alerts[0].sweep, null);
    assert.strictEqual(alerts[0].tier, 'HIGH_QUALITY', 'NONE 不影响 tier');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(alerts[0], 'mssRelation'), false);
});

// ---------- 结果 ----------
console.log('liquidityProvenance tests: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) {
    process.exit(1);
}
