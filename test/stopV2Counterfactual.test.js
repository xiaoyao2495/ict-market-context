/**
 * Phase 11T.2 — Stop Candidate V2 Counterfactual 测试
 * 覆盖：extractNarrativeRefs / buildV2Models（manip/acc 双套 + NBUF 变体）/
 *       simulateOutcome 四态（TARGET/STOP/AMBIGUOUS/NEITHER + stopOutThenTarget）/
 *       v2Matrix（BASELINE vs V2 同 target 矩阵）/ baselineVsV2 配对
 */
var assert = require('assert');
var v2 = require('../stats/stopV2Counterfactual');

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

// 合成 entry：LONG，entry 100，target 105，atr 1，baseline stop 99.5
// candidates 手写，模拟 buildStopCandidates 输出
function mkEntry(over) {
    var e = {
        direction: 'LONG',
        entryPrice: 100,
        targetPrice: 105,
        stopPrice: 99.5,
        entryIndex: 10,
        diagnostics: {
            atr: 1,
            stopCandidates: [
                {
                    source: 'MANIPULATION_SWEEP', referencePrice: 99.2, price: 99.15, valid: true,
                    isBeyondManipulationExtreme: true, isBeyondAccumulationRange: false, distanceAtr: 0.85, rr: 5.88
                },
                {
                    source: 'ACCUMULATION_RANGE', referencePrice: 98.8, price: 98.75, valid: true,
                    isBeyondManipulationExtreme: false, isBeyondAccumulationRange: true, distanceAtr: 1.25, rr: 4.0
                }
            ]
        }
    };
    if (over) { for (var k in over) e[k] = over[k]; }
    return e;
}

/* ---------- extractNarrativeRefs ---------- */

test('extractNarrativeRefs：从 candidates 提取 manip extreme + acc boundary', function () {
    var refs = v2.extractNarrativeRefs(mkEntry());
    assert.strictEqual(refs.manipExtreme, 99.2);
    assert.strictEqual(refs.accBoundary, 98.8);
});

test('extractNarrativeRefs：无 candidates → null', function () {
    var refs = v2.extractNarrativeRefs({ diagnostics: { stopCandidates: [] } });
    assert.strictEqual(refs.manipExtreme, null);
    assert.strictEqual(refs.accBoundary, null);
});

/* ---------- buildV2Models ---------- */

test('buildV2Models：manip + acc 都存在 → 生成两套 + NBUF 变体（共 4 模型）', function () {
    var models = v2.buildV2Models(mkEntry(), {});
    assert.strictEqual(models.length, 4);
    var keys = models.map(function (m) { return m.key; });
    assert.ok(keys.indexOf('MANIPULATION_INVALIDATION') !== -1);
    assert.ok(keys.indexOf('ACCUMULATION_INVALIDATION') !== -1);
    assert.ok(keys.indexOf('MANIPULATION_INVALIDATION_NBUF') !== -1);
    assert.ok(keys.indexOf('ACCUMULATION_INVALIDATION_NBUF') !== -1);
    // manip: stop 99.15；NBUF: max distance 1.0 ATR → stop = min(99.15, 99) = 99
    var manip = models.filter(function (m) { return m.key === 'MANIPULATION_INVALIDATION'; })[0];
    var manipNbuf = models.filter(function (m) { return m.key === 'MANIPULATION_INVALIDATION_NBUF'; })[0];
    assert.strictEqual(manip.price, 99.15);
    assert.strictEqual(manipNbuf.price, 99);
    assert.strictEqual(manipNbuf.distanceAtr, 1);
});

test('buildV2Models：仅 manip 存在 → 2 模型；仅 acc → 2 模型；都无 → 0', function () {
    var e1 = mkEntry();
    e1.diagnostics.stopCandidates = [e1.diagnostics.stopCandidates[0]];
    assert.strictEqual(v2.buildV2Models(e1, {}).length, 2);

    var e2 = mkEntry();
    e2.diagnostics.stopCandidates = [e2.diagnostics.stopCandidates[1]];
    assert.strictEqual(v2.buildV2Models(e2, {}).length, 2);

    var e3 = mkEntry({ diagnostics: { atr: 1, stopCandidates: [] } });
    assert.strictEqual(v2.buildV2Models(e3, {}).length, 0);
});

test('buildV2Models：候选未越过边界（isBeyond=false）→ 不采纳', function () {
    var e = mkEntry();
    e.diagnostics.stopCandidates = [{
        source: 'MANIPULATION_SWEEP', referencePrice: 99.2, price: 99.15, valid: true,
        isBeyondManipulationExtreme: false, isBeyondAccumulationRange: false
    }];
    assert.strictEqual(v2.buildV2Models(e, {}).length, 0);
});

/* ---------- simulateOutcome ---------- */

test('simulateOutcome：LONG target 先到 → TARGET', function () {
    var candles = [];
    var i;
    for (i = 0; i < 30; i++) candles.push(m5(100, 101, 99.8, 100.5, i));
    for (i = 11; i < 15; i++) candles[i] = m5(100, 105.5, 99.9, 105, i); // high >= 105
    var ex = { direction: 'LONG', entryPrice: 100, targetPrice: 105, atr: 1 };
    var o = v2.simulateOutcome(ex, 99.5, candles, 10, {});
    assert.strictEqual(o.first, 'TARGET');
    assert.strictEqual(o.stopOutThenTarget, false);
});

test('simulateOutcome：stop 先到，之后 target 到达 → STOP + stopOutThenTarget', function () {
    var candles = [];
    var i;
    for (i = 0; i < 30; i++) candles.push(m5(100, 101, 99.8, 100.5, i));
    candles[11] = m5(100, 100.5, 99.0, 99.5, 11); // low 99 <= 99.5 stop
    for (i = 12; i < 20; i++) candles[i] = m5(99.5, 106, 99.4, 105.5, i); // 之后 high >= 105
    var ex = { direction: 'LONG', entryPrice: 100, targetPrice: 105, atr: 1 };
    var o = v2.simulateOutcome(ex, 99.5, candles, 10, {});
    assert.strictEqual(o.first, 'STOP');
    assert.strictEqual(o.stopOutThenTarget, true);
});

test('simulateOutcome：同根 stop+target → AMBIGUOUS（保守，stopOutThenTarget=false）', function () {
    var candles = [];
    var i;
    for (i = 0; i < 30; i++) candles.push(m5(100, 101, 99.8, 100.5, i));
    candles[11] = m5(100, 105.5, 99.0, 100, 11); // low 99 <= stop 且 high 105.5 >= target
    var ex = { direction: 'LONG', entryPrice: 100, targetPrice: 105, atr: 1 };
    var o = v2.simulateOutcome(ex, 99.5, candles, 10, {});
    assert.strictEqual(o.first, 'AMBIGUOUS');
    assert.strictEqual(o.stopOutThenTarget, false);
});

test('simulateOutcome：horizon 内都未触及 → NEITHER', function () {
    var candles = [];
    var i;
    for (i = 0; i < 30; i++) candles.push(m5(100, 100.5, 99.8, 100.2, i)); // 无 stop/target
    var ex = { direction: 'LONG', entryPrice: 100, targetPrice: 105, atr: 1 };
    var o = v2.simulateOutcome(ex, 99.5, candles, 10, { horizon: 15 });
    assert.strictEqual(o.first, 'NEITHER');
    assert.strictEqual(o.stopOutThenTarget, false);
});

test('simulateOutcome：SHORT 对称（target 先到）', function () {
    var candles = [];
    var i;
    for (i = 0; i < 30; i++) candles.push(m5(100, 100.5, 99.8, 100, i));
    for (i = 11; i < 15; i++) candles[i] = m5(100, 100.2, 94.5, 95, i); // low <= 95 target
    var ex = { direction: 'SHORT', entryPrice: 100, targetPrice: 95, atr: 1 };
    var o = v2.simulateOutcome(ex, 100.5, candles, 10, {});
    assert.strictEqual(o.first, 'TARGET');
});

/* ---------- v2Matrix ---------- */

test('v2Matrix：BASELINE 行 survival 与手动一致；V2 行存在且 same target', function () {
    var candles = [];
    var i;
    for (i = 0; i < 40; i++) candles.push(m5(100, 101, 99.8, 100.5, i));
    for (i = 11; i < 20; i++) candles[i] = m5(100, 105.5, 99.9, 105, i); // target 105 先到（stop 99.5 未触）
    var entries = [mkEntry()];
    var m = v2.v2Matrix(entries, candles, {});
    assert.strictEqual(m.rows.BASELINE.n, 1);
    assert.strictEqual(m.rows.BASELINE.survivalN, 1);
    assert.strictEqual(m.rows.BASELINE.targetHitN, 1);
    // manip stop 99.15 也 survive（99.9 未触 99.15）
    assert.strictEqual(m.rows.MANIPULATION_INVALIDATION.n, 1);
    assert.strictEqual(m.rows.MANIPULATION_INVALIDATION.survivalN, 1);
    // NBUF stop 99 也 survive
    assert.strictEqual(m.rows.MANIPULATION_INVALIDATION_NBUF.survivalN, 1);
});

test('v2Matrix：stop 被扫（LOSS 但之后到 target）→ baseline survival 0、targetHit 1、stopToTarget 1', function () {
    var candles = [];
    var i;
    for (i = 0; i < 40; i++) candles.push(m5(100, 101, 99.8, 100.5, i));
    candles[11] = m5(100, 100.5, 99.0, 99.5, 11); // low 99 <= 99.5 baseline stop → 扫
    for (i = 12; i < 20; i++) candles[i] = m5(99.5, 106, 99.4, 105.5, i); // 之后 high 106 >= 105
    var entries = [mkEntry()];
    var m = v2.v2Matrix(entries, candles, {});
    assert.strictEqual(m.rows.BASELINE.survivalN, 0);
    assert.strictEqual(m.rows.BASELINE.targetHitN, 1);
    assert.strictEqual(m.rows.BASELINE.stopOutN, 1);
    assert.strictEqual(m.rows.BASELINE.stopOutThenTarget, 1);
    assert.strictEqual(m.rows.BASELINE.stopToTargetRate, 1);
    // manip stop 99.15 也会被扫（low 99 < 99.15）→ survival 0
    assert.strictEqual(m.rows.MANIPULATION_INVALIDATION.survivalN, 0);
});

test('v2Matrix：coverage 统计（both）', function () {
    var candles = [];
    var i;
    for (i = 0; i < 10; i++) candles.push(m5(100, 101, 99.8, 100.5, i));
    var entries = [mkEntry()];
    var m = v2.v2Matrix(entries, candles, {});
    assert.strictEqual(m.coverage.total, 1);
    assert.strictEqual(m.coverage.both, 1);
    assert.strictEqual(m.coverage.none, 0);
});

test('v2Matrix：medianRR 与 RR≥1.5 计算正确', function () {
    var candles = [];
    var i;
    for (i = 0; i < 10; i++) candles.push(m5(100, 101, 99.8, 100.5, i));
    var entries = [mkEntry()];
    var m = v2.v2Matrix(entries, candles, {});
    // manip stop 99.15 → risk 0.85, reward 5 → rr 5.88
    assert.ok(Math.abs(m.rows.MANIPULATION_INVALIDATION.medianRR - 5.88) < 0.01);
    assert.strictEqual(m.rows.MANIPULATION_INVALIDATION.rrGe15, 1);
    // NBUF stop 99 → risk 1.0 → rr 5.0
    assert.ok(Math.abs(m.rows.MANIPULATION_INVALIDATION_NBUF.medianRR - 5.0) < 0.01);
});

test('v2Matrix：TOO_CLOSE_TO_NOISE 诊断不拒单（仍计入矩阵）', function () {
    var candles = [];
    var i;
    for (i = 0; i < 40; i++) candles.push(m5(100, 101, 99.8, 100.5, i));
    for (i = 11; i < 20; i++) candles[i] = m5(100, 105.5, 99.9, 105, i);
    var e = mkEntry();
    // 构造 distanceAtr=0.6 的 manip 候选（< 0.75 但 >= 0.5）
    e.diagnostics.stopCandidates = [{
        source: 'MANIPULATION_SWEEP', referencePrice: 99.4, price: 99.4, valid: true,
        isBeyondManipulationExtreme: true, isBeyondAccumulationRange: false, distanceAtr: 0.6, rr: 8.33
    }];
    var m = v2.v2Matrix([e], candles, {});
    var row = m.rows.MANIPULATION_INVALIDATION;
    assert.strictEqual(row.n, 1); // 未被拒
    assert.strictEqual(row.tooClose[0].threshold, 0.5);
    assert.strictEqual(row.tooClose[0].n, 0);
    assert.strictEqual(row.tooClose[1].threshold, 0.75);
    assert.strictEqual(row.tooClose[1].n, 1);
    assert.strictEqual(row.tooClose[2].threshold, 1.0);
    assert.strictEqual(row.tooClose[2].n, 1);
});

/* ---------- baselineVsV2 ---------- */

test('baselineVsV2：baseline 死、V2 活且 RR≥1.5 → survGainButRrLt15 不计数', function () {
    var candles = [];
    var i;
    for (i = 0; i < 40; i++) candles.push(m5(100, 101, 99.8, 100.5, i));
    candles[11] = m5(100, 100.5, 99.3, 99.5, 11); // low 99.3: 扫 baseline 99.5；不扫 manip 99.15
    for (i = 12; i < 20; i++) candles[i] = m5(99.5, 106, 99.4, 105.5, i);
    var entries = [mkEntry()];
    var p = v2.baselineVsV2(entries, candles, {});
    var manip = p.models.MANIPULATION_INVALIDATION;
    assert.strictEqual(manip.pairs, 1);
    assert.strictEqual(manip.baseSurv, 0);
    assert.strictEqual(manip.v2Surv, 1);
    assert.strictEqual(manip.survDelta, 1);
    assert.strictEqual(manip.rrGe15, 1); // rr 5.88 >= 1.5
    assert.strictEqual(manip.survGainButRrLt15, 0);
});

test('baselineVsV2：V2 survival 提升但 RR<1.5 → survGainButRrLt15 计数', function () {
    var candles = [];
    var i;
    for (i = 0; i < 40; i++) candles.push(m5(100, 101, 99.8, 100.5, i));
    candles[11] = m5(100, 100.5, 99.3, 99.5, 11);
    for (i = 12; i < 20; i++) candles[i] = m5(99.5, 106, 99.4, 105.5, i);
    var e = mkEntry();
    // 构造远 stop：risk 拉大 → rr < 1.5（reward 5 / risk 4 = 1.25）
    e.diagnostics.stopCandidates = [{
        source: 'MANIPULATION_SWEEP', referencePrice: 96, price: 96, valid: true,
        isBeyondManipulationExtreme: true, isBeyondAccumulationRange: false, distanceAtr: 4, rr: 1.25
    }];
    var p = v2.baselineVsV2([e], candles, {});
    var manip = p.models.MANIPULATION_INVALIDATION;
    assert.strictEqual(manip.v2Surv, 1);
    assert.strictEqual(manip.survGainButRrLt15, 1);
    assert.strictEqual(manip.rrGe15, 0);
});

test('baselineVsV2：stop-out-then-target 对比（baseline 多、V2 少）', function () {
    var candles = [];
    var i;
    for (i = 0; i < 40; i++) candles.push(m5(100, 101, 99.8, 100.5, i));
    candles[11] = m5(100, 100.5, 99.3, 99.5, 11); // 扫 baseline 99.5（low 99.3）
    for (i = 12; i < 20; i++) candles[i] = m5(99.5, 106, 99.4, 105.5, i);
    var e = mkEntry();
    // manip stop 99.15 未被扫（low 99.3 > 99.15）→ 直接 target
    var p = v2.baselineVsV2([e], candles, {});
    var manip = p.models.MANIPULATION_INVALIDATION;
    assert.strictEqual(manip.baseStopOutThenTarget, 1);
    assert.strictEqual(manip.v2StopOutThenTarget, 0);
});

console.log('');
console.log('stopV2Counterfactual: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
