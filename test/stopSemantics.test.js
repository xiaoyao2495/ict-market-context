/**
 * Phase 11T — Stop Semantics Audit 测试
 * 覆盖：flagTooTight / survivalCurve（各 ATR 档位 survival rate）/ candidateRows（narrative invalidation）
 */
var assert = require('assert');
var stopSemantics = require('../stats/stopSemantics');
var stopPlanner = require('../trade/stopPlanner');

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

function trade(over) {
    var t = {
        tradeId: 'T1', direction: 'LONG', status: 'LOSS',
        entryPrice: 100, stopPrice: 99.5, targetPrice: 105,
        rr: 10, entryIndex: 10, maeAtMfePeak: 0.3, mfeBeforeStop: 2.5,
        diagnostics: { atr: 1.5, initialRiskAtr: 0.33, stopDistanceAtr: 0.33, stopCandidates: [] }
    };
    if (over) { for (var k in over) t[k] = over[k]; }
    return t;
}

/* ---------- flagTooTight ---------- */

test('tooTight：stopDistanceAtr 0.33 < 0.5 → flag', function () {
    var f = stopSemantics.flagTooTight([trade()])[0];
    assert.strictEqual(f.flag, true);
    assert.ok(f.reasons.some(function (r) { return r.indexOf('0.33') !== -1; }));
});

test('tooTight：rr 17 > 10 → flag', function () {
    var f = stopSemantics.flagTooTight([trade({ diagnostics: { atr: 3, initialRiskAtr: 1, stopDistanceAtr: 1.0 }, rr: 17 })])[0];
    assert.strictEqual(f.flag, true);
    assert.ok(f.reasons.some(function (r) { return r.indexOf('17') !== -1; }));
});

test('tooTight：正常 stop（0.8 ATR、rr 2）→ 不 flag', function () {
    var f = stopSemantics.flagTooTight([trade({ diagnostics: { atr: 3, initialRiskAtr: 0.8, stopDistanceAtr: 0.8 }, rr: 2 })])[0];
    assert.strictEqual(f.flag, false);
});

/* ---------- survivalCurve ---------- */

test('survivalCurve：tight stop 死、宽 stop 活（LONG 先到 target）', function () {
    var candles = [];
    var i;
    for (i = 0; i < 30; i++) {
        candles.push(m5(99, 101, 98, 100, i));
    }
    // 未来：先小幅下探 99（0.25 ATR=0.25 的 stop 99.75 被扫），再涨到 105 target
    candles[11] = m5(100, 100.5, 99.0, 100.2, 11); // low 99 → stop 99.75 被扫（0.25 ATR）
    for (i = 12; i < 20; i++) {
        candles[i] = m5(100, 105.5, 99.8, 105, i); // high 105.5 >= target 105
    }
    var entries = [{
        direction: 'LONG', entryPrice: 100, targetPrice: 105, atr: 1, entryIndex: 10
    }];
    var curve = stopSemantics.survivalCurve(entries, candles, {});
    assert.strictEqual(curve.entries, 1);
    // 0.25 ATR：stop 99.75，candle 11 low 99 扫 → 死
    assert.strictEqual(curve.tiers[0.25].survived, 0);
    // 1.0 ATR：stop 99，candle 11 low 99 == stop → stopHit；后续 high 105.5 → targetHit 同根？不同根。
    // candle 11 low 99 <= stop 99 → stop 先触 → 死
    assert.strictEqual(curve.tiers[1.0].survived, 0);
    // 2.0 ATR：stop 98，candle 11 low 99 不触 → 后续 target 105 先到 → 活
    assert.strictEqual(curve.tiers[2.0].survived, 1);
    assert.strictEqual(curve.tiers[2.0].rate, 1);
});

test('survivalCurve：同根 stop+target → 不算 survive（AMBIGUOUS 保守）', function () {
    var candles = [];
    var i;
    for (i = 0; i < 30; i++) {
        candles.push(m5(100, 101, 99, 100, i));
    }
    // 单根同时 low 98（扫 0.5 ATR stop 99.5）与 high 106（触 target 105）
    candles[11] = m5(100, 106, 98, 105, 11);
    var curve = stopSemantics.survivalCurve([{
        direction: 'LONG', entryPrice: 100, targetPrice: 105, atr: 1, entryIndex: 10
    }], candles, {});
    assert.strictEqual(curve.tiers[0.5].survived, 0, '同根触碰保守不算 survive');
});

/* ---------- Phase 11T.1：Narrative Validity 二维 ---------- */

test('survivalCurve 二维：越过 manipulation extreme 的 stop → valid；未越过 → micro', function () {
    var candles = [];
    var i;
    for (i = 0; i < 30; i++) {
        candles.push(m5(99, 101, 98, 100, i));
    }
    // 未来：low 98.4（扫 1.0 ATR stop 99.0? 不——stop 99 在 low 98.4 上方被扫）→ 后续 high 105.5 target
    candles[11] = m5(100, 100.5, 98.4, 100.2, 11);
    for (i = 12; i < 20; i++) {
        candles[i] = m5(100, 105.5, 99.8, 105, i);
    }
    // entry LONG at 100, target 105, atr 1.0, manip extreme 98.6, acc boundary 98.0
    var entries = [{
        direction: 'LONG', entryPrice: 100, targetPrice: 105, atr: 1, entryIndex: 10,
        manipExtreme: 98.6, accBoundary: 98.0
    }];
    var curve = stopSemantics.survivalCurve(entries, candles, {});
    // 1.0 ATR stop = 99.0：99.0 < manipExtreme 98.6? 否（99 > 98.6）→ micro；99.0 < acc 98? 否 → micro
    var t1 = curve.tiers[1.0];
    assert.strictEqual(t1.microTotal, 1);
    assert.strictEqual(t1.validTotal, 0);
    // 2.0 ATR stop = 98.0：98.0 < 98.6 → beyond manip → valid；且 98.0 <= 98.0 → beyond acc → valid
    var t2 = curve.tiers[2.0];
    assert.strictEqual(t2.validTotal, 1);
    assert.strictEqual(t2.microTotal, 0);
    // 2.0 ATR survive（low 98.4 > stop 98.0 → target 先到）
    assert.strictEqual(t2.validSurvived, 1);
    assert.strictEqual(t2.validRate, 1);
});

/* ---------- referenceSurvival ---------- */

test('referenceSurvival：candidates 分组统计（SWING vs MANIPULATION）', function () {
    var candles = [];
    var i;
    for (i = 0; i < 30; i++) {
        candles.push(m5(99, 101, 98, 100, i));
    }
    candles[11] = m5(100, 100.5, 98.2, 100.2, 11);
    for (i = 12; i < 20; i++) {
        candles[i] = m5(100, 105.5, 99.8, 105, i);
    }
    var entries = [{
        direction: 'LONG', entryPrice: 100, targetPrice: 105, atr: 1, entryIndex: 10,
        candidates: [
            { source: 'MANIPULATION_SWEEP', price: 98.5, distanceAtr: 1.5, rr: 3.0, valid: true, isBaseline: false },
            { source: 'SWING', price: 99.2, distanceAtr: 0.8, rr: 5.0, valid: true, isBaseline: true }
        ]
    }];
    var ref = stopSemantics.referenceSurvival(entries, candles, {});
    assert.strictEqual(ref.entries, 1);
    // MANIPULATION 98.5：low 98.2 扫 stop? 98.2 < 98.5 → 死（target 105 之后才到）→ survive 0
    var man = ref.bySource.MANIPULATION_SWEEP;
    assert.ok(man);
    assert.strictEqual(man.n, 1);
    assert.strictEqual(man.survived, 0);
    // SWING 99.2：low 98.2 < 99.2 → 死 → survive 0；avgRR = 5.0
    var sw = ref.bySource.SWING;
    assert.ok(sw);
    assert.strictEqual(sw.n, 1);
    assert.ok(Math.abs(sw.avgRr - 5.0) < 0.01);
});

/* ---------- candidateRows（narrative invalidation） ---------- */

test('candidateRows：ATR 档位生成 + narrativeInvalidation 判定', function () {
    var cands = stopPlanner.buildStopCandidates({
        direction: 'LONG',
        entryPrice: 100,
        targetPrice: 108,
        amd: {
            manipulation: { sweepEvent: { price: 98.5 } },
            accumulation: { rangeLow: 97 }
        },
        swings: [],
        fvg: { zoneLow: 99 },
        evaluationTime: 1000,
        tickSize: 0.1,
        atr: 1.0
    }, {});
    // ATR 档位存在（0.25-2.0）
    var atrCands = cands.filter(function (c) { return c.source === 'ATR_BASED'; });
    assert.strictEqual(atrCands.length, 6);
    // MANIPULATION_SWEEP 候选：stop = 98.5 - buffer（buffer = max(0.1*2, 1.0*0.05) = 0.2）→ 98.3 < sweep 98.5 → beyond manip
    var man = cands.filter(function (c) { return c.source === 'MANIPULATION_SWEEP'; })[0];
    assert.strictEqual(man.isBeyondManipulationExtreme, true);
    assert.strictEqual(man.narrativeInvalidation, true);
    // SWING 候选不存在（swings 空）
    assert.strictEqual(cands.filter(function (c) { return c.source === 'SWING'; }).length, 0);
});

test('candidateRows：trades 的 stopCandidates 汇总为行', function () {
    var t = trade();
    t.diagnostics.stopCandidates = stopPlanner.buildStopCandidates({
        direction: 'LONG', entryPrice: 100, targetPrice: 108,
        amd: { manipulation: { sweepEvent: { price: 98.5 } }, accumulation: { rangeLow: 97 } },
        swings: [], fvg: { zoneLow: 99 },
        evaluationTime: 1000, tickSize: 0.1, atr: 1.0
    }, {});
    var rows = stopSemantics.candidateRows([t]);
    assert.ok(rows.length >= 7); // 4 类 + 6 ATR 档（可能 baseline 合并）
    assert.ok(rows.some(function (r) { return r.source === 'ATR_BASED' && r.narrativeInvalidation !== undefined; }));
    var baseline = rows.filter(function (r) { return r.isBaseline; });
    assert.ok(baseline.length >= 1);
});

console.log('');
console.log('stopSemantics: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) {
    process.exit(1);
}
