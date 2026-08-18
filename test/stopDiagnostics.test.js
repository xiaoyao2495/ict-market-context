/**
 * Stop Placement Diagnostics 测试（Phase 11S）
 *
 * 覆盖：
 *   buildStopCandidates：4 类候选生成、baseline 标记、distanceAtr/rr 计算、minRR 不参与选择
 *   stopDiagnostics：source 分布、distanceAtr 分桶、候选对比、MAE/MFE 分布、STOP_OUT_THEN_TARGET
 */
var assert = require('assert');
var stopPlanner = require('../trade/stopPlanner');
var stopDiagnostics = require('../stats/stopDiagnostics');

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
function m5(o, h, l, c, i) {
    var t = 1000000 + i * BAR;
    return { openTime: t, open: o, high: h, low: l, close: c, closeTime: t + BAR - 1, closed: true, source: 'futures' };
}

function amdCtx(manipLow, rangeLow) {
    return {
        manipulation: manipLow !== undefined
            ? { sweepEvent: { price: manipLow }, score: 80 }
            : null,
        accumulation: rangeLow !== undefined
            ? { rangeLow: rangeLow, rangeHigh: rangeLow + 100, atr: 10 }
            : null
    };
}

function baseInput(overrides) {
    var input = {
        direction: 'LONG',
        entryPrice: 64126.65,
        targetPrice: 64195.10,
        amd: amdCtx(64120, 64078),
        swings: [
            { price: 64095, confirmedAt: 1000 },
            { price: 64050, confirmedAt: 500 }
        ],
        fvg: { zoneLow: 64108, zoneHigh: 64160 },
        evaluationTime: 2000,
        tickSize: 0.1,
        atr: 75
    };
    if (overrides) {
        Object.keys(overrides).forEach(function (k) { input[k] = overrides[k]; });
    }
    return input;
}

/* ================= buildStopCandidates ================= */

test('candidates：LONG 生成 MANIPULATION/ACCUMULATION/SWING/FVG 四类候选', function () {
    var cs = stopPlanner.buildStopCandidates(baseInput(), {});
    var sources = cs.map(function (c) { return c.source; });
    assert.ok(sources.indexOf('MANIPULATION_SWEEP') !== -1);
    assert.ok(sources.indexOf('ACCUMULATION_RANGE') !== -1);
    assert.ok(sources.indexOf('SWING') !== -1);
    assert.ok(sources.indexOf('FVG_FALLBACK') !== -1);
});

test('candidates：每个候选有 distanceAtr 与 resultingRR（ATR 标准化）', function () {
    var cs = stopPlanner.buildStopCandidates(baseInput(), {});
    cs.forEach(function (c) {
        assert.ok(c.distanceAtr !== null && c.distanceAtr !== undefined);
        assert.ok(c.rr !== null && c.rr !== undefined);
    });
    // MANIPULATION stop：buffer = max(tickSize*2, ATR*0.05) = max(0.2, 3.75) = 3.75
    // stop = 64120 - 3.75 = 64116.25 → distance = 64126.65 - 64116.25 = 10.4
    // distanceAtr = 10.4 / 75 ≈ 0.1387
    var man = cs.filter(function (c) { return c.source === 'MANIPULATION_SWEEP'; })[0];
    assert.ok(Math.abs(man.distanceAtr - 10.4 / 75) < 0.01);
    // ACCUMULATION rangeLow 64078 → 更远 → rr 更低
    var acc = cs.filter(function (c) { return c.source === 'ACCUMULATION_RANGE'; })[0];
    assert.ok(acc.distanceAtr > man.distanceAtr);
    assert.ok(acc.rr < man.rr);
});

test('candidates：baseline 标记（当前正式规则的选择）', function () {
    var cs = stopPlanner.buildStopCandidates(baseInput(), {});
    var baseline = cs.filter(function (c) { return c.isBaseline; });
    assert.strictEqual(baseline.length, 1);
    // Phase 11T.5S：manip + acc 并存 → 严格组合 NARRATIVE_BOUNDARY
    assert.strictEqual(baseline[0].source, 'NARRATIVE_BOUNDARY');
});

test('candidates：SHORT 对称（reference 在 entry 上方）', function () {
    var input = baseInput({
        direction: 'SHORT',
        entryPrice: 64100,
        targetPrice: 63900,
        amd: amdCtx(undefined, undefined),
        swings: [{ price: 64150, confirmedAt: 1000 }],
        fvg: { zoneLow: 64000, zoneHigh: 64160 }
    });
    input.amd = {
        manipulation: { sweepEvent: { price: 64140 }, score: 80 },
        accumulation: null
    };
    var cs = stopPlanner.buildStopCandidates(input, {});
    var man = cs.filter(function (c) { return c.source === 'MANIPULATION_SWEEP'; })[0];
    assert.ok(man.valid);
    assert.ok(man.price > input.entryPrice); // 风险方向
});

test('candidates：无效候选（reference 不在风险方向）标 valid=false', function () {
    var cs = stopPlanner.buildStopCandidates(baseInput({
        amd: amdCtx(64150, 64170) // sweep/range 都在 entry 上方（LONG 无效）
    }), {});
    var man = cs.filter(function (c) { return c.source === 'MANIPULATION_SWEEP'; })[0];
    assert.strictEqual(man.valid, false);
    assert.strictEqual(man.price, null);
});

test('candidates：planStop 严格组合（11T.5S —— manip+acc 并存取外侧）', function () {
    // Phase 11T.5S：manip(64120) + acc(64078) → min(64120, 64078) = 64078
    var r = stopPlanner.planStop({
        direction: 'LONG',
        entryPrice: 64126.65,
        amd: amdCtx(64120, 64078),
        swings: [{ price: 64095, confirmedAt: 1000 }],
        fvg: { zoneLow: 64108, zoneHigh: 64160 },
        evaluationTime: 2000,
        tickSize: 0.1,
        atr: 75
    }, {});
    assert.strictEqual(r.source, 'NARRATIVE_BOUNDARY');
    assert.strictEqual(r.referencePrice, 64078);
});

/* ================= stopDiagnostics ================= */

function trade(overrides) {
    var t = {
        planId: 'T1', status: 'LOSS', direction: 'LONG',
        entryPrice: 64126.65, stopPrice: 64120.55, targetPrice: 64195.10,
        exitIndex: 10, maeR: 2.1, mfeR: 8.9, rr: 11.22,
        diagnostics: {
            stopSource: 'MANIPULATION_SWEEP',
            stopDistanceAtr: 0.08,
            initialRiskAtr: 0.08,
            stopCandidates: [
                { source: 'MANIPULATION_SWEEP', isBaseline: true, valid: true, distanceAtr: 0.08, risk: 6.1, rr: 11.22 },
                { source: 'ACCUMULATION_RANGE', isBaseline: false, valid: true, distanceAtr: 0.64, risk: 48.45, rr: 1.41 }
            ]
        },
        context: { bias: 'LEAN_BULLISH' }
    };
    if (overrides) {
        Object.keys(overrides).forEach(function (k) { t[k] = overrides[k]; });
    }
    return t;
}

test('stats：stopSource 分布', function () {
    var out = stopDiagnostics.analyzeStopSources([
        trade({ planId: 'A', status: 'WIN' }),
        trade({ planId: 'B', status: 'LOSS' }),
        trade({ planId: 'C', status: 'LOSS', diagnostics: { stopSource: 'FVG_FALLBACK' } })
    ]);
    assert.strictEqual(out.MANIPULATION_SWEEP.count, 2);
    assert.strictEqual(out.MANIPULATION_SWEEP.wins, 1);
    assert.strictEqual(out.FVG_FALLBACK.count, 1);
});

test('stats：stopDistanceAtr 分桶', function () {
    var out = stopDiagnostics.analyzeStopDistance([
        trade({ planId: 'A', diagnostics: { stopDistanceAtr: 0.08 } }),   // <0.10
        trade({ planId: 'B', diagnostics: { stopDistanceAtr: 0.20 } }),   // 0.10-0.25
        trade({ planId: 'C', diagnostics: { stopDistanceAtr: 0.80 } }),   // 0.50-1.00
        trade({ planId: 'D', diagnostics: { stopDistanceAtr: 2.5 } })     // >1.00
    ]);
    assert.strictEqual(out['< 0.10 ATR'].count, 1);
    assert.strictEqual(out['0.10-0.25 ATR'].count, 1);
    assert.strictEqual(out['0.50-1.00 ATR'].count, 1);
    assert.strictEqual(out['> 1.00 ATR'].count, 1);
});

test('stats：候选对比行（baseline vs alternative）', function () {
    var rows = stopDiagnostics.analyzeCandidates([trade()]);
    assert.strictEqual(rows.length, 2);
    var baseline = rows.filter(function (r) { return r.isBaseline; })[0];
    var alt = rows.filter(function (r) { return !r.isBaseline; })[0];
    assert.strictEqual(baseline.rr, 11.22);
    assert.strictEqual(alt.rr, 1.41);
});

test('stats：MAE/MFE 分布（median/p90）', function () {
    var mm = stopDiagnostics.analyzeMaeMfe([
        trade({ planId: 'A', status: 'WIN', maeR: 0.1, mfeR: 3.0 }),
        trade({ planId: 'B', status: 'WIN', maeR: 0.3, mfeR: 4.0 }),
        trade({ planId: 'C', status: 'WIN', maeR: 0.5, mfeR: 5.0 }),
        trade({ planId: 'D', status: 'LOSS', maeR: 1.0, mfeR: 2.0 })
    ]);
    assert.strictEqual(mm.win.maeR.count, 3);
    assert.strictEqual(mm.win.maeR.median, 0.3);
    assert.ok(mm.win.maeR.p90 >= 0.5);
    assert.strictEqual(mm.loss.maeR.median, 1.0);
});

test('stats：STOP_OUT_THEN_TARGET（LOSS 后 12/24 bars 到达 target）', function () {
    var candles = [];
    var i;
    // 构造：LOSS trade 在 index=10 结算；index=15 价格到达 target 64195
    for (i = 0; i < 30; i++) {
        candles.push(m5(64000 + i * 10, 64100 + i * 10, 63900 + i * 10, 64050 + i * 10, i));
    }
    candles[15] = m5(64100, 64200, 64090, 64180, 15); // high 64200 >= 64195
    var out = stopDiagnostics.analyzeStopOutThenTarget([trade()], candles, [12, 24]);
    assert.strictEqual(out.lookahead_12.losses, 1);
    assert.strictEqual(out.lookahead_12.hitTarget, 1); // index 15-10=5 bars 内
    assert.strictEqual(out.lookahead_12.rate, 100);
    assert.strictEqual(out.lookahead_24.hitTarget, 1);
});

test('stats：Stop Efficiency 明细行', function () {
    var rows = stopDiagnostics.stopEfficiencyRows([
        trade({ planId: 'A', status: 'LOSS' }),
        trade({ planId: 'B', status: 'WIN' })
    ]);
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[0].initialRiskAtr, 0.08);
    assert.strictEqual(rows[0].stopSource, 'MANIPULATION_SWEEP');
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
