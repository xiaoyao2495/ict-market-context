/**
 * Phase 11L.13 — Liquidity Incremental Value Audit 测试
 *
 * 覆盖：
 *   - classifyOverlapGroup 四组
 *   - neighborsOf 共现判定（价格容差 + 时间窗口边界）
 *   - auditIncrementalValue：SWING_ONLY / SWING_OVERLAP / SIGNIFICANT_ONLY / SIGNIFICANT_OVERLAP 分组统计
 */
var assert = require('assert');
var sia = require('../stats/sweepIncrementalAudit');

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

function mkSweep(id, side, type, candleIndex, price) {
    return { id: id, side: side, candleIndex: candleIndex, price: price, confirmedAt: 1000000 + candleIndex * BAR + BAR - 1,
        source: { liquidityType: type, liquidityPrice: price, side: side } };
}
function mkMss(id, direction, candleIndex, refId) {
    return {
        id: id, direction: direction, candleIndex: candleIndex, confirmedAt: 1000000 + candleIndex * BAR + BAR - 1,
        source: { referenceSwingId: refId, referencePrice: 99, breakPct: 0.01 },
        metadata: { bodyRatio: 0.9 }
    };
}

/* ---------- 分组 ---------- */

test('11L.13：classifyOverlapGroup 四组', function () {
    var sw = { source: { liquidityType: 'SWING_LOW' } };
    var sig = { source: { liquidityType: 'EQL' } };
    assert.strictEqual(sia.classifyOverlapGroup(sw, false, false), 'SWING_ONLY');
    assert.strictEqual(sia.classifyOverlapGroup(sw, true, false), 'SWING_OVERLAP');
    assert.strictEqual(sia.classifyOverlapGroup(sig, false, false), 'SIGNIFICANT_ONLY');
    assert.strictEqual(sia.classifyOverlapGroup(sig, false, true), 'SIGNIFICANT_OVERLAP');
});

/* ---------- 共现判定 ---------- */

test('11L.13：neighborsOf 价格容差 + 时间窗口边界', function () {
    var sweeps = [
        mkSweep('A', 'SSL', 'SWING_LOW', 5, 99),
        mkSweep('B', 'SSL', 'EQL', 6, 99.05),   // 与 A：价格差 0.05 <= 0.099、idx 差 1 <= 12 → 共现
        mkSweep('C', 'SSL', 'EQL', 20, 99),     // 与 A：idx 差 15 > 12 → 不共现（时间窗口外）
        mkSweep('D', 'SSL', 'SWING_LOW', 5, 100) // 与 A：价格差 1 > 0.1 → 不共现（价格容差外）
    ];
    var list = sia.buildCooccurIndex(sweeps, { priceTolerance: 0.001, overlapBars: 12 });
    list.forEach(function (e, k) { e.pos = k; });
    var nbA = sia.neighborsOf(list[0], list, { priceTolerance: 0.001, overlapBars: 12 });
    assert.strictEqual(nbA.hasSignificant, true, 'B（EQL）与 A 共现');
    assert.strictEqual(nbA.hasSwing, false, 'D（价格差超容差）不共现；C（时间窗口外）不共现');
});

/* ---------- 增量审计 ---------- */

test('11L.13：SWING_ONLY 独立 vs SWING_OVERLAP 共现（多指标）', function () {
    var candles = [];
    for (var i = 0; i < 40; i++) candles.push(m5(100, 101, 99, 100.5, i));
    var sweeps = [
        mkSweep('sw1', 'SSL', 'SWING_LOW', 3, 95),  // 价格远离 99 → 附近无 significant → SWING_ONLY
        mkSweep('sw2', 'SSL', 'SWING_LOW', 5, 99),  // 附近有 EQL(sw3) → SWING_OVERLAP
        mkSweep('sw3', 'SSL', 'EQL', 6, 99),        // 附近有 SWING → SIGNIFICANT_OVERLAP
        mkSweep('sw4', 'SSL', 'EQL', 20, 105)       // 附近无 → SIGNIFICANT_ONLY（窗口 21..32 无 delivery）
    ];
    var swings = [{ id: 'SW1', type: 'SWING_HIGH', price: 99, index: 2, confirmedAt: candles[2].closeTime, timeframe: '5m' }];
    var mssEvents = [mkMss('m1', 'BULLISH', 8, 'SW1')]; // idx8 在 sw1/sw2/sw3 窗口内，sw4 窗口外
    var displacementEvents = [{ id: 'd1', direction: 'BULLISH', candleIndex: 8, confirmedAt: candles[8].closeTime, metadata: { mssEventId: 'm1' } }];
    var legByDispId = { d1: { quality: 'EXPLOSIVE', startIndex: 8, endIndex: 8 } };
    var alerts = [{ id: 'a1', tier: 'HIGH_QUALITY', direction: 'BULLISH', anchorIndex: 9 }];
    var res = sia.auditIncrementalValue({
        sweepEvents: sweeps, mssEvents: mssEvents, swings: swings,
        displacementEvents: displacementEvents, legByDispId: legByDispId,
        alerts: alerts, candles: candles,
        priceTolerance: 0.001, overlapBars: 12
    });
    var g = res.groups;
    assert.strictEqual(g.SWING_ONLY.n, 1, 'sw1：价格 95 远离 significant');
    assert.strictEqual(g.SWING_OVERLAP.n, 1, 'sw2：附近有 EQL(sw3)');
    assert.strictEqual(g.SIGNIFICANT_OVERLAP.n, 1, 'sw3：附近有 SWING(sw2)');
    assert.strictEqual(g.SIGNIFICANT_ONLY.n, 1, 'sw4：附近无');
    // 多指标：sw1/sw2/sw3 后续 1h 都有 protected MSS + strong leg + HIGH（idx8/9 在窗口内）
    assert.strictEqual(g.SWING_ONLY.protectedMss, 1, 'SWING_ONLY 也有独立 delivery（MSS idx8）');
    assert.strictEqual(g.SWING_ONLY.strongLeg, 1);
    assert.strictEqual(g.SWING_ONLY.high, 1);
    assert.strictEqual(g.SWING_OVERLAP.protectedMss, 1);
    assert.strictEqual(g.SWING_OVERLAP.high, 1);
    assert.strictEqual(g.SIGNIFICANT_ONLY.high, 0, 'sw4 窗口内无 delivery');
    assert.ok(g.SWING_ONLY.mfeCnt === 1 && g.SWING_ONLY.mfeSum > 0, 'MFE 计入');
});

/* ---------- 阈值配置默认 ---------- */

test('11L.13：默认共现参数来自 thresholds', function () {
    var candles = [];
    for (var i = 0; i < 20; i++) candles.push(m5(100, 101, 99, 100.5, i));
    var sweeps = [mkSweep('sw1', 'SSL', 'SWING_LOW', 5, 99), mkSweep('sw2', 'SSL', 'EQL', 5, 99)];
    var res = sia.auditIncrementalValue({
        sweepEvents: sweeps, mssEvents: [], swings: [], displacementEvents: [],
        legByDispId: {}, alerts: [], candles: candles
    });
    assert.strictEqual(res.priceTolerance, 0.001, '默认 0.1%');
    assert.strictEqual(res.overlapBars, 12, '默认 12 bars');
    assert.strictEqual(res.groups.SWING_OVERLAP.n, 1, '默认参数下 sw1 与 EQL 共现');
});

// ---------- 结果 ----------
console.log('sweepIncrementalAudit tests: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) {
    process.exit(1);
}
