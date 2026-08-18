/**
 * Trade Planning + Simulation 测试（Phase 10）
 *
 * 覆盖：
 *   Entry Planner（midpoint/short/not ready/missed）
 *   Stop Planner（优先级链/buffer/invalid）
 *   Target Planner（primary/secondary/wrong side/no target）
 *   RR Calculator（long/short/边界/拒绝）
 *   Trade Plan（READY/NOT_AVAILABLE/ENTRY_MISSED/REJECTED）
 *   Simulator（fill/no fill/expiry/cancel/WIN/LOSS/AMBIGUOUS/future/deterministic）
 *   MAE/MFE
 *   Integration
 */
var assert = require('assert');
var entryPlanner = require('../trade/entryPlanner');
var stopPlanner = require('../trade/stopPlanner');
var targetPlanner = require('../trade/targetPlanner');
var rrCalculator = require('../trade/rrCalculator');
var tradePlan = require('../trade/tradePlan');
var tradeSimulator = require('../trade/tradeSimulator');

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

function readyGate(zone, currentPrice, direction) {
    var f = {
        direction: direction === 'LONG' ? 'BULLISH' : 'BEARISH',
        zoneLow: zone.low,
        zoneHigh: zone.high,
        midpoint: zone.midpoint,
        status: 'TOUCHED',
        displacementEventId: 'D1'
    };
    return {
        state: 'ENTRY_READY',
        entryZone: zone,
        preferredEntry: zone.midpoint,
        fvg: f,
        scenarioRef: null
    };
}

function amdCtx(opts) {
    var o = opts || {};
    return {
        manipulation: o.manipulation
            ? { sweepEvent: { price: o.manipulation }, score: 80 }
            : null,
        accumulation: o.rangeLow !== undefined
            ? { rangeLow: o.rangeLow, rangeHigh: o.rangeHigh !== undefined ? o.rangeHigh : o.rangeLow + 100, atr: 10 }
            : null
    };
}

function drawCtx(opts) {
    var o = opts || {};
    function cand(id, price, drawScore, strength) {
        return { id: id, targetPrice: price, drawScore: drawScore !== undefined ? drawScore : 80, strength: strength !== undefined ? strength : 70 };
    }
    return {
        bsl: {
            primary: o.bslPrimary ? cand('B1', o.bslPrimary, 85, 80) : null,
            secondary: o.bslSecondary ? cand('B2', o.bslSecondary, 60, 60) : null
        },
        ssl: {
            primary: o.sslPrimary ? cand('S1', o.sslPrimary, 85, 80) : null,
            secondary: o.sslSecondary ? cand('S2', o.sslSecondary, 60, 60) : null
        }
    };
}

function m5(open, high, low, close, index, closed) {
    var t = 1000000 + index * BAR;
    return {
        openTime: t,
        open: open,
        high: high,
        low: low,
        close: close,
        closeTime: t + BAR - 1,
        closed: closed !== false,
        source: 'futures'
    };
}

function longPlan() {
    return {
        id: 'T1',
        symbol: 'BTCUSDT',
        createdAt: 1000000,
        direction: 'LONG',
        status: 'READY',
        entry: { price: 63340 },
        stop: { price: 63265 },
        target: { price: 63580 },
        rr: 3.2
    };
}

function shortPlan() {
    return {
        id: 'T2',
        symbol: 'BTCUSDT',
        createdAt: 1000000,
        direction: 'SHORT',
        status: 'READY',
        entry: { price: 63340 },
        stop: { price: 63415 },
        target: { price: 63100 },
        rr: 3.2
    };
}

/* ================= Entry Planner ================= */

test('entry：midpoint long', function () {
    var zone = { low: 63320, high: 63360, midpoint: 63340 };
    var r = entryPlanner.planEntry({
        entryGate: readyGate(zone, 63330, 'LONG'),
        currentPrice: 63330,
        direction: 'LONG',
        evaluationTime: 1000
    }, {});
    assert.strictEqual(r.status, 'READY');
    assert.strictEqual(r.price, 63340);
    assert.strictEqual(r.type, 'FVG_MIDPOINT');
});

test('entry：midpoint short', function () {
    var zone = { low: 63320, high: 63360, midpoint: 63340 };
    var r = entryPlanner.planEntry({
        entryGate: readyGate(zone, 63350, 'SHORT'),
        currentPrice: 63350,
        direction: 'SHORT',
        evaluationTime: 1000
    }, {});
    assert.strictEqual(r.status, 'READY');
    assert.strictEqual(r.price, 63340);
});

test('entry：gate 非 ENTRY_READY → NOT_AVAILABLE', function () {
    var r = entryPlanner.planEntry({
        entryGate: { state: 'WAITING_RETRACE', entryZone: null },
        currentPrice: 63340,
        direction: 'LONG',
        evaluationTime: 1000
    }, {});
    assert.strictEqual(r.status, 'NOT_AVAILABLE');
});

test('entry：价格明显越过 → ENTRY_MISSED（long）', function () {
    var zone = { low: 63320, high: 63360, midpoint: 63340 };
    var r = entryPlanner.planEntry({
        entryGate: readyGate(zone, 63500, 'LONG'),
        currentPrice: 63500, // 超过 midpoint + tolerance
        direction: 'LONG',
        evaluationTime: 1000
    }, {});
    assert.strictEqual(r.status, 'ENTRY_MISSED');
});

test('entry：ZONE_EDGE 模式（LONG 用下沿）', function () {
    var zone = { low: 63320, high: 63360, midpoint: 63340 };
    var r = entryPlanner.planEntry({
        entryGate: readyGate(zone, 63325, 'LONG'),
        currentPrice: 63325,
        direction: 'LONG',
        evaluationTime: 1000
    }, { thresholds: { trade: { entry: { mode: 'ZONE_EDGE', missedTolerancePct: 0.0015 }, stop: {}, rr: {}, simulator: {} } } });
    assert.strictEqual(r.status, 'READY');
    assert.strictEqual(r.price, 63320);
    assert.strictEqual(r.type, 'ZONE_EDGE');
});

/* ================= Stop Planner ================= */

test('stop：严格 narrative boundary（LONG，min(sweep, rangeLow)）', function () {
    var r = stopPlanner.planStop({
        direction: 'LONG',
        entryPrice: 63340,
        amd: amdCtx({ manipulation: 63270, rangeLow: 63280 }),
        swings: [{ price: 63250, confirmedAt: 500 }],
        fvg: { zoneLow: 63310, zoneHigh: 63360 },
        evaluationTime: 1000,
        tickSize: 0.1,
        atr: 20
    }, {});
    assert.strictEqual(r.status, 'READY');
    assert.strictEqual(r.source, 'NARRATIVE_BOUNDARY');
    assert.strictEqual(r.referencePrice, 63270); // min(63270, 63280) = 63270
    // buffer = max(0.1*2, 20*0.05) = 1
    assert.strictEqual(r.price, 63269);
});

test('stop：accumulation rangeLow fallback（LONG）', function () {
    var r = stopPlanner.planStop({
        direction: 'LONG',
        entryPrice: 63340,
        amd: amdCtx({ rangeLow: 63280 }),
        swings: [],
        fvg: { zoneLow: 63310, zoneHigh: 63360 },
        evaluationTime: 1000,
        tickSize: 0.1,
        atr: 20
    }, {});
    assert.strictEqual(r.source, 'ACCUMULATION_RANGE_LOW');
    assert.strictEqual(r.referencePrice, 63280);
});

test('stop：swing low fallback（LONG 取最近下方）', function () {
    var r = stopPlanner.planStop({
        direction: 'LONG',
        entryPrice: 63340,
        amd: amdCtx({}),
        swings: [
            { price: 63100, confirmedAt: 100 },
            { price: 63250, confirmedAt: 500 } // 最近下方
        ],
        fvg: { zoneLow: 63310, zoneHigh: 63360 },
        evaluationTime: 1000,
        tickSize: 0.1,
        atr: 20
    }, {});
    assert.strictEqual(r.source, 'SWING_LOW');
    assert.strictEqual(r.referencePrice, 63250);
});

test('stop：FVG zoneLow fallback（LONG）', function () {
    var r = stopPlanner.planStop({
        direction: 'LONG',
        entryPrice: 63340,
        amd: amdCtx({}),
        swings: [],
        fvg: { zoneLow: 63310, zoneHigh: 63360 },
        evaluationTime: 1000,
        tickSize: 0.1,
        atr: 20
    }, {});
    assert.strictEqual(r.source, 'FVG_ZONE_LOW');
    assert.strictEqual(r.referencePrice, 63310);
});

test('stop：SHORT 对称（sweep high + buffer）', function () {
    var r = stopPlanner.planStop({
        direction: 'SHORT',
        entryPrice: 63340,
        amd: amdCtx({ manipulation: 63390 }),
        swings: [],
        fvg: { zoneLow: 63300, zoneHigh: 63350 },
        evaluationTime: 1000,
        tickSize: 0.1,
        atr: 20
    }, {});
    assert.strictEqual(r.source, 'MANIPULATION_SWEEP');
    assert.strictEqual(r.referencePrice, 63390);
    assert.strictEqual(r.price, 63391); // 63390 + 1
});

test('stop：无参考 → INVALID', function () {
    var r = stopPlanner.planStop({
        direction: 'LONG',
        entryPrice: 63340,
        amd: amdCtx({}),
        swings: [],
        fvg: { zoneLow: 63350, zoneHigh: 63400 }, // 下沿高于 entry → 不在风险方向
        evaluationTime: 1000,
        tickSize: 0.1,
        atr: 20
    }, {});
    assert.strictEqual(r.status, 'INVALID');
});

/* ================= Target Planner ================= */

test('target：primary BSL draw（LONG）', function () {
    var r = targetPlanner.planTarget({
        direction: 'LONG',
        entryPrice: 63340,
        draw: drawCtx({ bslPrimary: 63580, bslSecondary: 63620 })
    }, {});
    assert.strictEqual(r.status, 'READY');
    assert.strictEqual(r.price, 63580);
    assert.strictEqual(r.source, 'PRIMARY_DRAW');
    assert.strictEqual(r.candidateId, 'B1');
});

test('target：primary 不在盈利方向 → secondary fallback', function () {
    var r = targetPlanner.planTarget({
        direction: 'LONG',
        entryPrice: 63340,
        draw: drawCtx({ bslPrimary: 63200, bslSecondary: 63620 })
    }, {});
    assert.strictEqual(r.status, 'READY');
    assert.strictEqual(r.price, 63620);
    assert.strictEqual(r.source, 'SECONDARY_DRAW');
});

test('target：wrong side（LONG 用 SSL）→ INVALID', function () {
    var r = targetPlanner.planTarget({
        direction: 'LONG',
        entryPrice: 63340,
        draw: drawCtx({ sslPrimary: 63000 })
    }, {});
    assert.strictEqual(r.status, 'INVALID');
});

test('target：无候选 → INVALID', function () {
    var r = targetPlanner.planTarget({
        direction: 'LONG',
        entryPrice: 63340,
        draw: drawCtx({})
    }, {});
    assert.strictEqual(r.status, 'INVALID');
});

/* ================= RR Calculator ================= */

test('rr：long 正确', function () {
    var r = rrCalculator.calculateRR({ direction: 'LONG', entryPrice: 63340, stopPrice: 63265, targetPrice: 63580 }, {});
    assert.strictEqual(r.status, 'READY');
    assert.strictEqual(r.risk, 75);
    assert.strictEqual(r.reward, 240);
    assert.strictEqual(r.rr, 3.2);
});

test('rr：short 正确', function () {
    var r = rrCalculator.calculateRR({ direction: 'SHORT', entryPrice: 63340, stopPrice: 63415, targetPrice: 63100 }, {});
    assert.strictEqual(r.status, 'READY');
    assert.strictEqual(r.risk, 75);
    assert.strictEqual(r.reward, 240);
    assert.strictEqual(r.rr, 3.2);
});

test('rr：risk <= 0 → INVALID', function () {
    var r = rrCalculator.calculateRR({ direction: 'LONG', entryPrice: 63340, stopPrice: 63350, targetPrice: 63580 }, {});
    assert.strictEqual(r.status, 'INVALID');
});

test('rr：reward <= 0 → INVALID', function () {
    var r = rrCalculator.calculateRR({ direction: 'LONG', entryPrice: 63340, stopPrice: 63265, targetPrice: 63300 }, {});
    assert.strictEqual(r.status, 'INVALID');
});

test('rr：精确 1.5 边界 → READY', function () {
    // risk 100, reward 150 → rr 1.5
    var r = rrCalculator.calculateRR({ direction: 'LONG', entryPrice: 63400, stopPrice: 63300, targetPrice: 63550 }, {});
    assert.strictEqual(r.status, 'READY');
    assert.strictEqual(r.rr, 1.5);
});

test('rr：< 1.5 → REJECTED INSUFFICIENT_RR', function () {
    var r = rrCalculator.calculateRR({ direction: 'LONG', entryPrice: 63340, stopPrice: 63265, targetPrice: 63400 }, {});
    assert.strictEqual(r.status, 'REJECTED');
    assert.ok(r.reason.indexOf('INSUFFICIENT_RR') !== -1);
});

/* ================= Trade Plan ================= */

test('plan：READY long（完整链路）', function () {
    var gate = readyGate({ low: 63320, high: 63360, midpoint: 63340 }, 63330, 'LONG');
    var plan = tradePlan.buildTradePlan({
        symbol: 'BTCUSDT',
        evaluationTime: 1000,
        entryGate: gate,
        currentPrice: 63330,
        amd: amdCtx({ manipulation: 63270, rangeLow: 63280 }),
        swings: [],
        draw: drawCtx({ bslPrimary: 63580 }),
        tickSize: 0.1,
        atr: 20,
        context: { bias: 'BULLISH', scenario: 'BULLISH_WATCH', amd: 'COMPLETE' }
    }, {});
    assert.strictEqual(plan.status, 'READY');
    assert.strictEqual(plan.direction, 'LONG');
    assert.strictEqual(plan.entry.price, 63340);
    assert.strictEqual(plan.stop.source, 'NARRATIVE_BOUNDARY'); // min(63270, 63280)
    assert.strictEqual(plan.target.source, 'PRIMARY_DRAW');
    assert.ok(plan.rr >= 1.5);
});

test('plan：READY short（对称）', function () {
    var gate = readyGate({ low: 63320, high: 63360, midpoint: 63340 }, 63350, 'SHORT');
    var plan = tradePlan.buildTradePlan({
        symbol: 'BTCUSDT',
        evaluationTime: 1000,
        entryGate: gate,
        currentPrice: 63350,
        amd: amdCtx({ manipulation: 63390 }),
        swings: [],
        draw: drawCtx({ sslPrimary: 63100 }),
        tickSize: 0.1,
        atr: 20,
        context: { bias: 'BEARISH', scenario: 'BEARISH_WATCH', amd: 'COMPLETE' }
    }, {});
    assert.strictEqual(plan.status, 'READY');
    assert.strictEqual(plan.direction, 'SHORT');
    assert.strictEqual(plan.stop.source, 'MANIPULATION_SWEEP');
});

test('plan：gate 非 ENTRY_READY → NOT_AVAILABLE', function () {
    var plan = tradePlan.buildTradePlan({
        symbol: 'BTCUSDT', evaluationTime: 1000,
        entryGate: { state: 'CLOSED', entryZone: null },
        currentPrice: 63340, amd: amdCtx({}), swings: [],
        draw: drawCtx({ bslPrimary: 63580 }), tickSize: 0.1, atr: 20
    }, {});
    assert.strictEqual(plan.status, 'NOT_AVAILABLE');
});

test('plan：价格越过 → ENTRY_MISSED', function () {
    var gate = readyGate({ low: 63320, high: 63360, midpoint: 63340 }, 63500, 'LONG');
    var plan = tradePlan.buildTradePlan({
        symbol: 'BTCUSDT', evaluationTime: 1000,
        entryGate: gate, currentPrice: 63500,
        amd: amdCtx({}), swings: [], draw: drawCtx({ bslPrimary: 63580 }),
        tickSize: 0.1, atr: 20
    }, {});
    assert.strictEqual(plan.status, 'ENTRY_MISSED');
});

test('plan：RR 不足 → REJECTED（不强行改 target）', function () {
    var gate = readyGate({ low: 63320, high: 63360, midpoint: 63340 }, 63330, 'LONG');
    var plan = tradePlan.buildTradePlan({
        symbol: 'BTCUSDT', evaluationTime: 1000,
        entryGate: gate, currentPrice: 63330,
        amd: amdCtx({ manipulation: 63270 }), swings: [],
        draw: drawCtx({ bslPrimary: 63400 }), // 目标太近 → RR 0.8
        tickSize: 0.1, atr: 20
    }, {});
    assert.strictEqual(plan.status, 'REJECTED');
    assert.ok(plan.reasons.some(function (r) { return r.indexOf('INSUFFICIENT_RR') !== -1; }));
    // target 没有被人工推远
    assert.strictEqual(plan.target.price, 63400);
});

/* ================= Simulator ================= */

test('sim：entry fill → OPEN', function () {
    var candles = [
        m5(63300, 63330, 63290, 63310, 1), // 未触及 entry 63340
        m5(63320, 63360, 63310, 63350, 2)  // 触及 → OPEN
    ];
    var r = tradeSimulator.simulateTrade(longPlan(), candles, {});
    assert.strictEqual(r.status, 'OPEN');
    assert.strictEqual(r.entryAt, candles[1].closeTime);
    assert.strictEqual(r.waitBars, 1);
});

test('sim：no fill → 数据结束仍 WAIT_ENTRY', function () {
    var candles = [
        m5(63100, 63200, 63050, 63150, 1),
        m5(63150, 63250, 63100, 63200, 2)
    ];
    var r = tradeSimulator.simulateTrade(longPlan(), candles, {});
    assert.strictEqual(r.status, 'WAIT_ENTRY');
    assert.strictEqual(r.entryAt, null);
    assert.strictEqual(r.waitBars, 2);
});

test('sim：等待超时 → EXPIRED', function () {
    var candles = [];
    var i;
    for (i = 1; i <= 15; i++) {
        candles.push(m5(63100, 63200, 63050, 63150, i)); // 全不触及 entry 63340
    }
    var r = tradeSimulator.simulateTrade(longPlan(), candles, {});
    assert.strictEqual(r.status, 'EXPIRED');
    assert.ok(r.reasons.some(function (x) { return x.indexOf('timeout') !== -1; }));
});

test('sim：等待期 context invalidated → CANCELLED', function () {
    var candles = [
        m5(63100, 63200, 63050, 63150, 1),
        m5(63150, 63250, 63100, 63200, 2)
    ];
    var r = tradeSimulator.simulateTrade(longPlan(), candles, {
        cancelCheck: function (c, i) { return i === 1; }
    });
    assert.strictEqual(r.status, 'CANCELLED');
    assert.ok(r.reasons.some(function (x) { return x.indexOf('invalidated') !== -1; }));
});

test('sim：long WIN（先到 target）', function () {
    var candles = [
        m5(63300, 63330, 63290, 63310, 1),
        m5(63320, 63400, 63310, 63390, 2),  // fill（63340 在范围内）
        m5(63390, 63600, 63380, 63590, 3)   // high 63600 >= 63580 → WIN
    ];
    var r = tradeSimulator.simulateTrade(longPlan(), candles, {});
    assert.strictEqual(r.status, 'WIN');
    assert.strictEqual(r.exitPrice, 63580);
    assert.strictEqual(r.realizedR, 3.2);
    assert.strictEqual(r.holdBars, 2);
});

test('sim：long LOSS（先到 stop）', function () {
    var candles = [
        m5(63300, 63330, 63290, 63310, 1),
        m5(63320, 63400, 63310, 63390, 2),  // fill
        m5(63300, 63350, 63200, 63250, 3)   // low 63200 <= 63265 → LOSS
    ];
    var r = tradeSimulator.simulateTrade(longPlan(), candles, {});
    assert.strictEqual(r.status, 'LOSS');
    assert.strictEqual(r.exitPrice, 63265);
    assert.strictEqual(r.realizedR, -1);
});

test('sim：short WIN', function () {
    var candles = [
        m5(63400, 63450, 63350, 63400, 1),
        m5(63360, 63400, 63300, 63320, 2),  // fill（63340 在范围内）
        m5(63200, 63350, 63000, 63050, 3)   // low 63000 <= 63100 → WIN
    ];
    var r = tradeSimulator.simulateTrade(shortPlan(), candles, {});
    assert.strictEqual(r.status, 'WIN');
    assert.strictEqual(r.exitPrice, 63100);
    assert.strictEqual(r.realizedR, 3.2);
});

test('sim：short LOSS', function () {
    var candles = [
        m5(63400, 63450, 63350, 63400, 1),
        m5(63360, 63400, 63300, 63320, 2),  // fill
        m5(63400, 63500, 63380, 63450, 3)   // high 63500 >= 63415 → LOSS
    ];
    var r = tradeSimulator.simulateTrade(shortPlan(), candles, {});
    assert.strictEqual(r.status, 'LOSS');
    assert.strictEqual(r.exitPrice, 63415);
    assert.strictEqual(r.realizedR, -1);
});

test('sim：同根 K 同时碰 SL+TP → AMBIGUOUS（不算 WIN）', function () {
    var candles = [
        m5(63300, 63330, 63290, 63310, 1),
        m5(63320, 63400, 63310, 63390, 2),  // fill
        m5(63300, 63600, 63200, 63400, 3)   // low 63200 <= 63265 且 high 63600 >= 63580 → AMBIGUOUS
    ];
    var r = tradeSimulator.simulateTrade(longPlan(), candles, {});
    assert.strictEqual(r.status, 'AMBIGUOUS');
    assert.strictEqual(r.ambiguous, true);
    assert.strictEqual(r.realizedR, 0);
    assert.ok(r.reasons.some(function (x) { return x.indexOf('ambiguous') !== -1; }));
});

test('sim：future candle 排除（closed=false 跳过）', function () {
    var candles = [
        m5(63320, 63400, 63310, 63390, 2),
        m5(63390, 63600, 63380, 63590, 3)
    ];
    candles[0].closed = false; // 未收盘，不应触发 fill
    var r = tradeSimulator.simulateTrade(longPlan(), candles, {});
    assert.strictEqual(r.entryAt, null);
    assert.strictEqual(r.status, 'WAIT_ENTRY');
});

test('sim：deterministic replay', function () {
    var candles = [
        m5(63320, 63400, 63310, 63390, 2),
        m5(63390, 63600, 63380, 63590, 3)
    ];
    var r1 = tradeSimulator.simulateTrade(longPlan(), candles, {});
    var r2 = tradeSimulator.simulateTrade(longPlan(), candles, {});
    assert.strictEqual(r1.status, r2.status);
    assert.strictEqual(r1.exitAt, r2.exitAt);
    assert.strictEqual(r1.realizedR, r2.realizedR);
});

/* ================= MAE / MFE ================= */

test('mae/mfe：long 记录正确', function () {
    var candles = [
        m5(63320, 63400, 63310, 63390, 2),     // fill
        m5(63330, 63380, 63280, 63350, 3),     // MAE: 63340-63280=60, MFE: 63380-63340=40
        m5(63350, 63600, 63340, 63590, 4)      // high 63600 → WIN；MFE: 63600-63340=260
    ];
    var r = tradeSimulator.simulateTrade(longPlan(), candles, {});
    assert.strictEqual(r.status, 'WIN');
    assert.strictEqual(r.mfe, 260);
    assert.strictEqual(r.mae, 60);
    // risk = 75
    assert.ok(Math.abs(r.mfeR - 260 / 75) < 0.0001);
    assert.ok(Math.abs(r.maeR - 60 / 75) < 0.0001);
});

test('mae/mfe：short 记录正确', function () {
    var candles = [
        m5(63360, 63400, 63300, 63320, 2),     // fill（short entry 63340）
        m5(63350, 63410, 63310, 63380, 3),     // MAE: 63410-63340=70, MFE: 63340-63310=30（不碰 stop 63415）
        m5(63200, 63350, 63000, 63050, 4)      // low 63000 → WIN；MFE: 63340-63000=340
    ];
    var r = tradeSimulator.simulateTrade(shortPlan(), candles, {});
    assert.strictEqual(r.status, 'WIN');
    assert.strictEqual(r.mfe, 340);
    assert.strictEqual(r.mae, 70);
});

/* ================= Integration ================= */

test('integration：ENTRY_READY → READY plan → WIN', function () {
    var gate = readyGate({ low: 63320, high: 63360, midpoint: 63340 }, 63330, 'LONG');
    var plan = tradePlan.buildTradePlan({
        symbol: 'BTCUSDT', evaluationTime: 1000,
        entryGate: gate, currentPrice: 63330,
        amd: amdCtx({ manipulation: 63270 }), swings: [],
        draw: drawCtx({ bslPrimary: 63580 }),
        tickSize: 0.1, atr: 20
    }, {});
    assert.strictEqual(plan.status, 'READY');
    var candles = [
        m5(63320, 63400, 63310, 63390, 2),
        m5(63390, 63600, 63380, 63590, 3)
    ];
    var r = tradeSimulator.simulateTrade(plan, candles, {});
    assert.strictEqual(r.status, 'WIN');
    assert.ok(Math.abs(r.realizedR - plan.rr) < 0.01); // realizedR 用未取整 risk，rr 取整，容差比较
});

test('integration：insufficient RR 的 plan 永不进入模拟（REJECTED）', function () {
    var gate = readyGate({ low: 63320, high: 63360, midpoint: 63340 }, 63330, 'LONG');
    var plan = tradePlan.buildTradePlan({
        symbol: 'BTCUSDT', evaluationTime: 1000,
        entryGate: gate, currentPrice: 63330,
        amd: amdCtx({ manipulation: 63270 }), swings: [],
        draw: drawCtx({ bslPrimary: 63400 }),
        tickSize: 0.1, atr: 20
    }, {});
    assert.strictEqual(plan.status, 'REJECTED');
    assert.strictEqual(plan.entry.price, 63340); // 仍有 entry 但计划被拒
});

test('integration：future data 不影响历史结果（deterministic + closeTime 约束）', function () {
    var gate = readyGate({ low: 63320, high: 63360, midpoint: 63340 }, 63330, 'LONG');
    var plan = tradePlan.buildTradePlan({
        symbol: 'BTCUSDT', evaluationTime: 1000,
        entryGate: gate, currentPrice: 63330,
        amd: amdCtx({ manipulation: 63270 }), swings: [],
        draw: drawCtx({ bslPrimary: 63580 }),
        tickSize: 0.1, atr: 20
    }, {});
    // 同一组 candles 两次模拟结果一致
    var candles = [
        m5(63320, 63400, 63310, 63390, 2),
        m5(63390, 63600, 63380, 63590, 3)
    ];
    var r1 = tradeSimulator.simulateTrade(plan, candles, {});
    var r2 = tradeSimulator.simulateTrade(plan, candles, {});
    assert.deepStrictEqual(r1, r2);
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

