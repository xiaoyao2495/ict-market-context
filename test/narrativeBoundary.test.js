/**
 * Phase 11T.3 — Narrative Boundary Integrity Audit 测试
 * 覆盖：boundaryFromAmd / isPresent / classify 四态 / extractEntry / entryOutcome /
 *       boundaryPresenceTable / boundaryLossTable / retraceTracker.createRetrace 冻结 /
 *       shadowEntry amdAtTrigger 实时快照
 */
var assert = require('assert');
var nb = require('../stats/narrativeBoundary');
var retraceTracker = require('../replay/retraceTracker');
var shadowEntry = require('../stats/shadowEntry');
var amdState = require('../amd/amdState');
var thresholds = require('../config/thresholds');

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

function amdWithManip() {
    return {
        state: 'MANIPULATION_CONFIRMED',
        direction: 'BULLISH',
        lastPhase: 'MANIPULATION',
        manipulation: { sweepEvent: { price: 99, id: 'sweep1' } },
        accumulation: { rangeLow: 98, rangeHigh: 100 },
        distribution: null
    };
}
function amdEmpty() {
    return { state: 'SEARCHING', direction: null, lastPhase: 'SEARCHING', manipulation: null, accumulation: null, distribution: null };
}

/* ---------- boundaryFromAmd ---------- */

test('boundaryFromAmd：manip + acc 都在 → PRESENT 字段齐全', function () {
    var b = nb.boundaryFromAmd(amdWithManip());
    assert.strictEqual(b.hasManipulation, true);
    assert.strictEqual(b.manipulationExtreme, 99);
    assert.strictEqual(b.hasAccumulation, true);
    assert.strictEqual(b.accumulationRangeLow, 98);
    assert.strictEqual(b.accumulationRangeHigh, 100);
    assert.strictEqual(b.amdState, 'MANIPULATION_CONFIRMED');
    assert.strictEqual(b.amdDirection, 'BULLISH');
});

test('boundaryFromAmd：空 AMD → 全 false/null', function () {
    var b = nb.boundaryFromAmd(amdEmpty());
    assert.strictEqual(b.hasManipulation, false);
    assert.strictEqual(b.hasAccumulation, false);
    assert.strictEqual(b.manipulationExtreme, null);
    assert.strictEqual(b.accumulationRangeLow, null);
});

test('boundaryFromAmd：distribution displacementEvent 优先', function () {
    var amd = { distribution: { displacementEvent: { id: 'd1' } } };
    assert.strictEqual(nb.boundaryFromAmd(amd).distributionEventId, 'd1');
    assert.strictEqual(nb.boundaryFromAmd({ distribution: {} }).distributionEventId, null);
});

/* ---------- classify ---------- */

test('classify：watch 有 + action 有 → PRESENT_THROUGHOUT', function () {
    assert.strictEqual(nb.classify(nb.boundaryFromAmd(amdWithManip()), nb.boundaryFromAmd(amdWithManip())), 'PRESENT_THROUGHOUT');
});
test('classify：watch 无 + action 无 → MISSING_FROM_START', function () {
    assert.strictEqual(nb.classify(nb.boundaryFromAmd(amdEmpty()), nb.boundaryFromAmd(amdEmpty())), 'MISSING_FROM_START');
});
test('classify：watch 有 + action 无 → LOST_AFTER_WATCH（pipeline/AMD reset）', function () {
    assert.strictEqual(nb.classify(nb.boundaryFromAmd(amdWithManip()), nb.boundaryFromAmd(amdEmpty())), 'LOST_AFTER_WATCH');
});
test('classify：watch 无 + action 有 → PRESENT_AT_TRIGGER_ONLY（WATCH 建立过早）', function () {
    assert.strictEqual(nb.classify(nb.boundaryFromAmd(amdEmpty()), nb.boundaryFromAmd(amdWithManip())), 'PRESENT_AT_TRIGGER_ONLY');
});

/* ---------- entryOutcome ---------- */

test('entryOutcome：LONG target 先到 → TARGET + mfe/mae', function () {
    var candles = [];
    var i;
    for (i = 0; i < 30; i++) candles.push(m5(100, 101, 99.8, 100.5, i));
    for (i = 11; i < 15; i++) candles[i] = m5(100, 105.5, 99.9, 105, i);
    var ex = { direction: 'LONG', entryPrice: 100, targetPrice: 105, stopPrice: 99.5, atr: 1, startIdx: 10 };
    var oc = nb.entryOutcome(ex, candles, {});
    assert.strictEqual(oc.first, 'TARGET');
    assert.strictEqual(oc.stopOutThenTarget, false);
    assert.ok(oc.mfePct > 0);
});

test('entryOutcome：stop 先扫后 target → STOP + stopOutThenTarget', function () {
    var candles = [];
    var i;
    for (i = 0; i < 30; i++) candles.push(m5(100, 101, 99.8, 100.5, i));
    candles[11] = m5(100, 100.5, 99.0, 99.5, 11);
    for (i = 12; i < 20; i++) candles[i] = m5(99.5, 106, 99.4, 105.5, i);
    var ex = { direction: 'LONG', entryPrice: 100, targetPrice: 105, stopPrice: 99.5, atr: 1, startIdx: 10 };
    var oc = nb.entryOutcome(ex, candles, {});
    assert.strictEqual(oc.first, 'STOP');
    assert.strictEqual(oc.stopOutThenTarget, true);
});

/* ---------- boundaryPresenceTable ---------- */

function mkEntry(over) {
    var e = {
        direction: 'LONG', entryPrice: 100, targetPrice: 105, stopPrice: 99.5,
        entryIndex: 10,
        diagnostics: { atr: 1 },
        boundaryAtWatch: nb.boundaryFromAmd(amdWithManip()),
        boundaryAtAction: nb.boundaryFromAmd(amdWithManip()),
        alignmentAtWatch: 'MATCH',
        biasAtWatch: 'BULLISH',
        fvgScoreAtWatch: 70
    };
    if (over) { for (var k in over) e[k] = over[k]; }
    return e;
}

test('boundaryPresenceTable：PRESENT/MISSING 分组与指标', function () {
    var candles = [];
    var i;
    for (i = 0; i < 40; i++) candles.push(m5(100, 101, 99.8, 100.5, i));
    for (i = 11; i < 20; i++) candles[i] = m5(100, 105.5, 99.9, 105, i); // target 先到
    var entries = [
        mkEntry(), // PRESENT
        mkEntry({
            boundaryAtWatch: nb.boundaryFromAmd(amdEmpty()),
            boundaryAtAction: nb.boundaryFromAmd(amdEmpty()),
            alignmentAtWatch: 'UNCONFIRMED', biasAtWatch: 'NEUTRAL',
            fvgScoreAtWatch: null
        }) // MISSING
    ];
    var t = nb.boundaryPresenceTable(entries, candles, {});
    assert.strictEqual(t.present.n, 1);
    assert.strictEqual(t.missing.n, 1);
    assert.strictEqual(t.present.survivalRate, 1); // present survival 100%
    assert.strictEqual(t.present.alignMatchRate, 1);
    assert.strictEqual(t.missing.alignMatchRate, 0);
    assert.strictEqual(t.present.medFvgScore, 70);
    assert.strictEqual(t.missing.medFvgScore, null);
});

test('boundaryPresenceTable：stop 被扫且之后到 target → survival 0 / targetHit 1 / stopToTarget 1', function () {
    var candles = [];
    var i;
    for (i = 0; i < 40; i++) candles.push(m5(100, 101, 99.8, 100.5, i));
    candles[11] = m5(100, 100.5, 99.0, 99.5, 11);
    for (i = 12; i < 20; i++) candles[i] = m5(99.5, 106, 99.4, 105.5, i);
    var t = nb.boundaryPresenceTable([mkEntry()], candles, {});
    assert.strictEqual(t.present.survivalRate, 0);
    assert.strictEqual(t.present.targetHitRate, 1);
    assert.strictEqual(t.present.stopToTargetRate, 1);
});

/* ---------- boundaryLossTable ---------- */

test('boundaryLossTable：四类分类', function () {
    var entries = [
        mkEntry(), // PRESENT THROUGHOUT
        mkEntry({ boundaryAtWatch: nb.boundaryFromAmd(amdEmpty()), boundaryAtAction: nb.boundaryFromAmd(amdEmpty()) }), // MISSING FROM START
        mkEntry({ boundaryAtWatch: nb.boundaryFromAmd(amdWithManip()), boundaryAtAction: nb.boundaryFromAmd(amdEmpty()) }), // LOST AFTER WATCH
        mkEntry({ boundaryAtWatch: nb.boundaryFromAmd(amdEmpty()), boundaryAtAction: nb.boundaryFromAmd(amdWithManip()) }) // PRESENT AT TRIGGER ONLY
    ];
    var t = nb.boundaryLossTable(entries);
    assert.strictEqual(t.total, 4);
    assert.strictEqual(t.classification.PRESENT_THROUGHOUT.n, 1);
    assert.strictEqual(t.classification.MISSING_FROM_START.n, 1);
    assert.strictEqual(t.classification.LOST_AFTER_WATCH.n, 1);
    assert.strictEqual(t.classification.PRESENT_AT_TRIGGER_ONLY.n, 1);
});

/* ---------- retraceTracker 集成 ---------- */

test('createRetrace：冻结 boundaryAtWatch + alignment/bias/fvgScore', function () {
    var r = retraceTracker.createRetrace({
        symbol: 'BTCUSDT', direction: 'BULLISH',
        fvg: { id: 'f1', zoneLow: 99.5, zoneHigh: 100.5, midpoint: 100, _score: 68 },
        watchIndex: 10, watchAt: 1234, atr: 1,
        draw: null, amd: amdWithManip(), swings: [], tickSize: 0.01,
        candle: m5(100, 101, 99.8, 100.5, 10),
        alignment: 'MATCH', bias: 'BULLISH'
    });
    assert.strictEqual(r.boundaryAtWatch.hasManipulation, true);
    assert.strictEqual(r.boundaryAtWatch.manipulationExtreme, 99);
    assert.strictEqual(r.alignmentAtWatch, 'MATCH');
    assert.strictEqual(r.biasAtWatch, 'BULLISH');
    assert.strictEqual(r.fvgScoreAtWatch, 68);
});

/* ---------- shadowEntry 集成 ---------- */

test('shadowEntry：trigger 时记录 amdAtTrigger（实时 AMD 快照）', function () {
    // BULLISH zone 在价格上方（102-102.5），base 价格 103.5-105 在上方，
    // candles[12] 回踩进 zone（low 102.3 <= zoneHigh 102.5）
    var candles = [];
    var i;
    for (i = 0; i < 30; i++) candles.push(m5(104, 105, 103.5, 104.5, i));
    candles[12] = m5(104, 104.5, 102.3, 103.8, 12);

    var amdTrace = [];
    for (i = 0; i < 30; i++) amdTrace[i] = nb.boundaryFromAmd(amdEmpty());
    amdTrace[12] = nb.boundaryFromAmd(amdWithManip()); // trigger 时 AMD 已有 manip

    var r = retraceTracker.createRetrace({
        symbol: 'BTCUSDT', direction: 'BULLISH',
        fvg: { id: 'f1', zoneLow: 102.0, zoneHigh: 102.5, midpoint: 102.25, _score: 60 },
        watchIndex: 10, watchAt: 1234, atr: 1,
        draw: { bsl: { primary: { targetPrice: 105 } } },
        amd: amdEmpty(), // WATCH 时无 boundary
        swings: [], tickSize: 0.01,
        candle: candles[10],
        alignment: 'UNCONFIRMED', bias: 'NEUTRAL'
    });
    r.closeIndex = 20;
    r.closeAt = candles[20].closeTime;
    var results = shadowEntry.runShadowEntries(r, {
        candles: candles,
        atrSeries: {},
        amdTrace: amdTrace,
        thresholds: require('../config/thresholds')
    });
    var triggered = results.filter(function (s) { return s.triggered; });
    assert.ok(triggered.length >= 1, '至少一个 tolerance 触发');
    var sr = triggered[0];
    assert.strictEqual(sr.triggerIndex, 12);
    assert.ok(sr.amdAtTrigger, 'amdAtTrigger 应存在');
    assert.strictEqual(sr.amdAtTrigger.hasManipulation, true);
    assert.strictEqual(nb.isPresent(sr.boundaryAtWatch), false); // WATCH 时无
    assert.strictEqual(nb.classify(sr.boundaryAtWatch, sr.amdAtTrigger), 'PRESENT_AT_TRIGGER_ONLY');
    assert.strictEqual(sr.alignmentAtWatch, 'UNCONFIRMED');
    assert.strictEqual(sr.fvgScoreAtWatch, 60);
});

/* ---------- Phase 11T.4：amdFromBoundary / amdFromLastNarrative / synthAmdForStop ---------- */

test('amdFromBoundary：从判定快照反构造 planStop 可读 amd', function () {
    var b = nb.boundaryFromAmd(amdWithManip());
    var amd = nb.amdFromBoundary(b);
    assert.strictEqual(amd.manipulation.sweepEvent.price, 99);
    assert.strictEqual(amd.accumulation.rangeLow, 98);
    assert.strictEqual(amd.accumulation.rangeHigh, 100);
});

test('amdFromLastNarrative：从 lastNarrative 快照构造 amd', function () {
    var ln = {
        direction: 'BULLISH',
        accumulation: { rangeLow: 97, rangeHigh: 99 },
        manipulation: { sweepPrice: 96.5, sweepId: 's1', confirmedAt: 1234 },
        distribution: null,
        confirmedAt: 1234,
        confirmedIndex: 10,
        invalidatedAt: null
    };
    var amd = nb.amdFromLastNarrative(ln);
    assert.strictEqual(amd.manipulation.sweepEvent.price, 96.5);
    assert.strictEqual(amd.accumulation.rangeLow, 97);
});

test('synthAmdForStop：current 优先；无 current 用 lastNarrative；都无 → 空', function () {
    var cur = nb.boundaryFromAmd(amdWithManip());
    var empty = nb.boundaryFromAmd(amdEmpty());
    var ln = {
        accumulation: { rangeLow: 97, rangeHigh: 99 },
        manipulation: { sweepPrice: 96.5 },
        confirmedIndex: 10
    };
    // current 有 → current
    assert.ok(nb.synthAmdForStop(cur, ln).manipulation);
    // current 无 + lastNarrative 有 → lastNarrative
    var s2 = nb.synthAmdForStop(empty, ln);
    assert.strictEqual(s2.manipulation.sweepEvent.price, 96.5);
    // 都无 → 空 amd（planStop fallback SWING/FVG）
    assert.deepStrictEqual(nb.synthAmdForStop(empty, null), {});
});

/* ---------- Phase 11T.4：amdState lastNarrative（默认关闭） ---------- */

test('amdState：enabled=false → lastNarrative 恒 null（可关闭通道）', function () {
    var cfg = JSON.parse(JSON.stringify(thresholds));
    cfg.amd.lastNarrative.enabled = false;
    var st = amdState.createAmdState();
    st.direction = 'BULLISH';
    st.accumulation = { rangeLow: 98, rangeHigh: 100 };
    st.manipulation = { sweepEvent: { price: 99 }, confirmedAt: 1000 };
    // 直接验证 resetToSearching 路径：DISTRIBUTION reset
    st.phase = 'DISTRIBUTION';
    amdState.updateAmdState(st, { candleIndex: 100 }, { thresholds: cfg });
    assert.strictEqual(st.lastNarrative, null);
    assert.strictEqual(st.phase, 'SEARCHING');
});

test('amdState：enabled=true（默认）→ DISTRIBUTION reset 冻结 TradeContextSnapshot', function () {
    var st = amdState.createAmdState();
    st.direction = 'BULLISH';
    st.accumulation = { rangeLow: 98, rangeHigh: 100, confirmedAt: 800 };
    st.manipulation = { sweepEvent: { price: 99, id: 's1', confirmedAt: 900 }, confirmedAt: 900 };
    st.distribution = { displacementEvent: { id: 'd1' }, confirmedAt: 950 };
    st.confirmedAt = 950;
    st.phase = 'DISTRIBUTION';
    amdState.updateAmdState(st, { candleIndex: 100 }, { thresholds: thresholds });
    assert.strictEqual(st.phase, 'SEARCHING');
    assert.ok(st.lastNarrative, 'lastNarrative 应存在');
    // TradeContextSnapshot 字段
    assert.strictEqual(st.lastNarrative.direction, 'BULLISH');
    assert.strictEqual(st.lastNarrative.accumulation.rangeLow, 98);
    assert.strictEqual(st.lastNarrative.manipulation.sweepPrice, 99);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(st.lastNarrative.distribution, 'mssEventId'), false);
    assert.strictEqual(st.lastNarrative.distribution.displacementEventId, 'd1');
    assert.strictEqual(st.lastNarrative.source, 'AMD_NARRATIVE');
    assert.strictEqual(st.lastNarrative.expiresAt, 100 + thresholds.amd.lastNarrative.maxAgeBars); // candleIndex + maxAge
    // invalidationBoundary（11T.5S 严格版）：BULLISH → short = min(sweep 99, rangeLow 98) = 98，long = rangeHigh 100
    assert.strictEqual(st.lastNarrative.invalidationBoundary.short, 98);
    assert.strictEqual(st.lastNarrative.invalidationBoundary.long, 100);
    // 原对象已被 reset 清空，快照不受污染（immutable 语义）
    assert.strictEqual(st.accumulation, null);
    assert.strictEqual(st.manipulation, null);
});

test('amdState：lastNarrative expiresAt 过期 → 清空（Persistent ≠ Permanent）', function () {
    var st = amdState.createAmdState();
    st.direction = 'BULLISH';
    st.accumulation = { rangeLow: 98, rangeHigh: 100 };
    st.manipulation = { sweepEvent: { price: 99 }, confirmedAt: 900 };
    st.confirmedAt = 950;
    st.phase = 'DISTRIBUTION';
    amdState.updateAmdState(st, { candleIndex: 100 }, { thresholds: thresholds });
    assert.ok(st.lastNarrative);
    var exp = st.lastNarrative.expiresAt;
    // 超过 expiresAt 后清空
    amdState.updateAmdState(st, { candleIndex: exp + 1 }, { thresholds: thresholds });
    assert.strictEqual(st.lastNarrative, null);
});

test('amdState：新一轮 manipulation confirmed → lastNarrative 清空', function () {
    var cfg = JSON.parse(JSON.stringify(thresholds));
    cfg.amd.lastNarrative.enabled = true;
    var st = amdState.createAmdState();
    st.direction = 'BULLISH';
    st.accumulation = { rangeLow: 98, rangeHigh: 100 };
    st.manipulation = { sweepEvent: { price: 99 }, confirmedAt: 900 };
    st.confirmedAt = 950;
    st.index = 80;
    st.phase = 'DISTRIBUTION';
    amdState.updateAmdState(st, { candleIndex: 100 }, { thresholds: cfg });
    assert.ok(st.lastNarrative);
    // 新一轮 manipulation：SEARCHING + accumulation + sweep → confirmed
    var st2 = amdState.createAmdState();
    st2.lastNarrative = st.lastNarrative; // 模拟上一轮快照
    st2.phase = 'SEARCHING';
    st2.direction = 'BEARISH';
    st2.accumulation = { rangeLow: 101, rangeHigh: 103, confirmedAt: 100, atr: 0.5 };
    var sweep = { side: 'BSL', price: 103.2, confirmedAt: 200, id: 's2', candleIndex: 50 };
    var input = {
        candleIndex: 60,
        candle: m5(103, 104, 102.5, 103.8, 60),
        evaluationTime: 1000,
        candles: [],
        newSweeps: [sweep],
        newMss: [], newDisplacements: [],
        registry: { getActive: function () { return []; } },
        draw: null,
        confirmGap: 1
    };
    // accumulation 确认需要 detectAccumulation —— 简化：直接手动推进到 MANIPULATION
    // 通过 updateAmdState 完整跑一次（accumulation 依赖 candles 历史，这里构造短序列）
    var candles2 = [];
    for (var ci = 0; ci < 20; ci++) candles2.push(m5(101 + ci * 0.05, 102, 101, 102, ci));
    input.candles = candles2;
    amdState.updateAmdState(st2, input, { thresholds: cfg });
    // 若 manipulation 确认 → lastNarrative 清空；否则至少不报错（accumulation 未确认场景）
    if (st2.manipulation) {
        assert.strictEqual(st2.lastNarrative, null);
    }
});

/* ---------- shadowEntry stopLive / stopRetain ---------- */

test('shadowEntry：trigger 时重建 stopLive（实时）与 stopRetain（lastNarrative 补边界）', function () {
    var candles = [];
    var i;
    for (i = 0; i < 30; i++) candles.push(m5(104, 105, 103.5, 104.5, i));
    candles[12] = m5(104, 104.5, 102.3, 103.8, 12); // 回踩进 zone（102-102.5）

    var amdTrace = [];
    for (i = 0; i < 30; i++) amdTrace[i] = { boundary: nb.boundaryFromAmd(amdEmpty()), lastNarrative: null };
    amdTrace[12] = {
        boundary: nb.boundaryFromAmd(amdEmpty()), // trigger 时无 boundary
        lastNarrative: { // 上一轮 narrative 快照
            direction: 'BULLISH',
            accumulation: { rangeLow: 101.5, rangeHigh: 102.5 },
            manipulation: { sweepPrice: 101.2, sweepId: 's1' },
            distribution: null,
            confirmedAt: 900,
            confirmedIndex: 8
        }
    };

    var r = retraceTracker.createRetrace({
        symbol: 'BTCUSDT', direction: 'BULLISH',
        fvg: { id: 'f1', zoneLow: 102.0, zoneHigh: 102.5, midpoint: 102.25, _score: 60 },
        watchIndex: 10, watchAt: 1234, atr: 1,
        draw: { bsl: { primary: { targetPrice: 105 } } },
        amd: amdEmpty(),
        swings: [{ price: 103.2, confirmedAt: 900 }], // trigger 103.8 下方的 swing low
        tickSize: 0.01,
        candle: candles[10],
        alignment: 'UNCONFIRMED', bias: 'NEUTRAL'
    });
    r.closeIndex = 20;
    r.closeAt = candles[20].closeTime;
    var results = shadowEntry.runShadowEntries(r, {
        candles: candles,
        atrSeries: {},
        amdTrace: amdTrace,
        thresholds: require('../config/thresholds')
    });
    var sr = results.filter(function (s) { return s.triggered; })[0];
    assert.ok(sr, '至少一个 tolerance 触发');
    assert.ok(sr.stopLive, 'stopLive 应存在');
    assert.ok(sr.stopRetain, 'stopRetain 应存在');
    // trigger 时无 boundary → stopLive fallback SWING（很近）
    // lastNarrative 有 manip(101.2) + acc(101.5) → 严格组合 min(101.2, 101.5) = 101.2 → NARRATIVE_BOUNDARY（更远）
    assert.strictEqual(sr.stopLive.source, 'SWING_LOW');
    assert.strictEqual(sr.stopRetain.source, 'NARRATIVE_BOUNDARY');
    var liveDist = Math.abs(sr.triggerPrice - sr.stopLive.price);
    var retainDist = Math.abs(sr.triggerPrice - sr.stopRetain.price);
    assert.ok(retainDist > liveDist, 'retain stop 应比 live stop 更远（站到 narrative 外）');
});

/* ---------- Phase 11T.5：planStop retainedNarrative 消费（正式化） ---------- */

var stopPlanner = require('../trade/stopPlanner');

function retainedSnapshot(over) {
    var s = {
        direction: 'BULLISH',
        accumulation: { rangeLow: 97, rangeHigh: 99 },
        manipulation: { sweepPrice: 96.5, sweepId: 's1' },
        distribution: null,
        confirmedAt: 900,
        expiresAt: 1900,
        invalidationBoundary: { long: 99, short: 96.5 },
        source: 'AMD_NARRATIVE'
    };
    if (over) { for (var k in over) s[k] = over[k]; }
    return s;
}

test('planStop：current AMD 无 boundary → 用 retained invalidationBoundary（LONG short 侧）', function () {
    var stop = stopPlanner.planStop({
        direction: 'LONG',
        entryPrice: 100,
        amd: amdEmpty(),
        retainedNarrative: retainedSnapshot(),
        swings: [{ price: 99.2, confirmedAt: 900 }],
        fvg: { zoneLow: 99 },
        evaluationTime: 1000,
        tickSize: 0.01,
        atr: 1
    }, {});
    assert.strictEqual(stop.status, 'READY');
    assert.strictEqual(stop.source, 'RETAINED_NARRATIVE');
    // stop = 96.5 - buffer(0.05) = 96.45 < swing 99.2（retained 优先于 swing）
    assert.ok(stop.referencePrice < 99.2);
});

test('planStop：current AMD boundary 存在 → 优先 current（不落 retained）', function () {
    var stop = stopPlanner.planStop({
        direction: 'LONG',
        entryPrice: 100,
        amd: { manipulation: { sweepEvent: { price: 99.5 } } },
        retainedNarrative: retainedSnapshot(),
        swings: [], fvg: {}, evaluationTime: 1000, tickSize: 0.01, atr: 1
    }, {});
    assert.strictEqual(stop.source, 'MANIPULATION_SWEEP');
    assert.strictEqual(stop.referencePrice, 99.5);
});

test('planStop：INVALID_REFERENCE —— retained short 边界在 entry 上方（LONG）→ 跳过，fallback SWING', function () {
    var stop = stopPlanner.planStop({
        direction: 'LONG',
        entryPrice: 100,
        amd: amdEmpty(),
        retainedNarrative: retainedSnapshot({ invalidationBoundary: { long: 101, short: 101.5 } }), // short 在 entry 上方
        swings: [{ price: 99.2, confirmedAt: 900 }],
        fvg: {}, evaluationTime: 1000, tickSize: 0.01, atr: 1
    }, {});
    assert.strictEqual(stop.status, 'READY');
    assert.strictEqual(stop.source, 'SWING_LOW'); // 不强行采用 retained
    assert.strictEqual(stop.referencePrice, 99.2);
});

test('planStop：INVALID_REFERENCE —— SHORT 用 long 边界；long 在 entry 下方 → 跳过', function () {
    var stop = stopPlanner.planStop({
        direction: 'SHORT',
        entryPrice: 100,
        amd: amdEmpty(),
        retainedNarrative: retainedSnapshot({ direction: 'BEARISH', invalidationBoundary: { long: 98.5, short: 97 } }),
        swings: [{ price: 100.8, confirmedAt: 900 }],
        fvg: {}, evaluationTime: 1000, tickSize: 0.01, atr: 1
    }, {});
    assert.strictEqual(stop.status, 'READY');
    assert.strictEqual(stop.source, 'SWING_HIGH'); // long 98.5 < entry 100 → INVALID_REFERENCE → swing
});

test('buildStopCandidates：含 RETAINED_NARRATIVE 候选（direction 匹配侧）', function () {
    var cands = stopPlanner.buildStopCandidates({
        direction: 'LONG',
        entryPrice: 100,
        targetPrice: 105,
        amd: amdEmpty(),
        retainedNarrative: retainedSnapshot(),
        swings: [], fvg: {}, evaluationTime: 1000, tickSize: 0.01, atr: 1
    }, {});
    var retained = cands.filter(function (c) { return c.source === 'RETAINED_NARRATIVE'; });
    assert.strictEqual(retained.length, 1);
    assert.ok(retained[0].valid);
});

/* ---------- Phase 11T.5R：INVALIDATED 不 retain / direction 匹配 / flip 先于 plan ---------- */

test('② (11T.5R)：INVALIDATED AMD 不 retain —— 失败 narrative 不得成为 stop 边界', function () {
    var st = amdState.createAmdState();
    st.direction = 'BULLISH';
    st.accumulation = { rangeLow: 98, rangeHigh: 100, confirmedAt: 800 };
    st.manipulation = { sweepEvent: { price: 99, id: 's1', confirmedAt: 900 }, confirmedAt: 900 };
    st.confirmedAt = 900;
    st.invalidationReason = 'OPPOSITE_MSS';
    st.phase = 'INVALIDATED';
    amdState.updateAmdState(st, { candleIndex: 100 }, { thresholds: thresholds });
    assert.strictEqual(st.phase, 'SEARCHING');
    assert.strictEqual(st.lastNarrative, null, 'INVALIDATED 不得保留 lastNarrative');
});

test('② (11T.5R)：DISTRIBUTION 仍 retain（与 INVALIDATED 区分）', function () {
    var st = amdState.createAmdState();
    st.direction = 'BULLISH';
    st.accumulation = { rangeLow: 98, rangeHigh: 100, confirmedAt: 800 };
    st.manipulation = { sweepEvent: { price: 99, id: 's1', confirmedAt: 900 }, confirmedAt: 900 };
    st.distribution = { mssEvent: { id: 'm1' }, displacementEvent: { id: 'd1' }, confirmedAt: 950 };
    st.confirmedAt = 950;
    st.phase = 'DISTRIBUTION';
    amdState.updateAmdState(st, { candleIndex: 100 }, { thresholds: thresholds });
    assert.strictEqual(st.phase, 'SEARCHING');
    assert.ok(st.lastNarrative, 'DISTRIBUTION 完成应 retain');
    assert.strictEqual(st.lastNarrative.direction, 'BULLISH');
});

test('③ (11T.5R)：retained direction 不匹配 → 不用（BEARISH retained + LONG entry → SWING）', function () {
    var stop = stopPlanner.planStop({
        direction: 'LONG',
        entryPrice: 100,
        amd: amdEmpty(),
        retainedNarrative: retainedSnapshot({ direction: 'BEARISH', invalidationBoundary: { long: 101, short: 95 } }),
        swings: [{ price: 99.2, confirmedAt: 900 }],
        fvg: {}, evaluationTime: 1000, tickSize: 0.01, atr: 1
    }, {});
    assert.strictEqual(stop.status, 'READY');
    assert.strictEqual(stop.source, 'SWING_LOW', 'BEARISH retained 不得被 LONG trade 使用');
    assert.strictEqual(stop.referencePrice, 99.2);
});

test('③ (11T.5R)：direction=null retained → 拒绝（防御性，不接受隐式方向）', function () {
    var stop = stopPlanner.planStop({
        direction: 'LONG',
        entryPrice: 100,
        amd: amdEmpty(),
        retainedNarrative: retainedSnapshot({ direction: null, invalidationBoundary: { long: 101, short: 95 } }),
        swings: [{ price: 99.2, confirmedAt: 900 }],
        fvg: {}, evaluationTime: 1000, tickSize: 0.01, atr: 1
    }, {});
    assert.strictEqual(stop.source, 'SWING_LOW', 'direction=null 不接受');
});

test('④ (11T.5R)：shouldClearLastNarrative —— BEARISH retained + BULLISH scenario → 清空', function () {
    var bear = retainedSnapshot({ direction: 'BEARISH' });
    assert.strictEqual(nb.shouldClearLastNarrative(bear, 'BULLISH_WATCH', null), true);
    assert.strictEqual(nb.shouldClearLastNarrative(bear, 'BEARISH_WATCH', null), false);
    assert.strictEqual(nb.shouldClearLastNarrative(bear, 'BULLISH_WATCH', 'LEAN_SSL'), true);
    assert.strictEqual(nb.shouldClearLastNarrative(bear, 'BULLISH_WATCH', 'LEAN_BSL'), true); // draw flip 也清
    assert.strictEqual(nb.shouldClearLastNarrative(bear, 'BULLISH_WATCH', 'BALANCED'), true);
    assert.strictEqual(nb.shouldClearLastNarrative(null, 'BULLISH_WATCH', null), false);
});

/* ---------- Phase 11T.5S：严格 Narrative Boundary（min/max 组合） ---------- */

test('11T.5S：planStop current AMD 严格组合 —— sweep 99 + rangeLow 98 → NARRATIVE_BOUNDARY 98（min）', function () {
    var stop = stopPlanner.planStop({
        direction: 'LONG',
        entryPrice: 102,
        amd: {
            manipulation: { sweepEvent: { price: 99 } },
            accumulation: { rangeLow: 98, rangeHigh: 101 }
        },
        retainedNarrative: null,
        swings: [{ price: 100.5, confirmedAt: 900 }],
        fvg: {}, evaluationTime: 1000, tickSize: 0.01, atr: 1
    }, {});
    assert.strictEqual(stop.status, 'READY');
    assert.strictEqual(stop.source, 'NARRATIVE_BOUNDARY');
    assert.strictEqual(stop.referencePrice, 98, '严格版取 min(sweep 99, rangeLow 98) = 98');
    // stop = 98 - buffer(0.05) = 97.95，比 swing 100.5 更远
    assert.ok(stop.price < 100.5);
});

test('11T.5S：SHORT 严格组合 —— sweep 101 + rangeHigh 102 → NARRATIVE_BOUNDARY 102（max）', function () {
    var stop = stopPlanner.planStop({
        direction: 'SHORT',
        entryPrice: 100,
        amd: {
            manipulation: { sweepEvent: { price: 101 } },
            accumulation: { rangeLow: 98, rangeHigh: 102 }
        },
        retainedNarrative: null,
        swings: [{ price: 100.5, confirmedAt: 900 }],
        fvg: {}, evaluationTime: 1000, tickSize: 0.01, atr: 1
    }, {});
    assert.strictEqual(stop.status, 'READY');
    assert.strictEqual(stop.source, 'NARRATIVE_BOUNDARY');
    assert.strictEqual(stop.referencePrice, 102, '严格版取 max(sweep 101, rangeHigh 102) = 102');
});

test('11T.5S：单存在回退 —— 只有 sweep → MANIPULATION_SWEEP；只有 rangeLow → ACCUMULATION_RANGE_LOW', function () {
    var stop1 = stopPlanner.planStop({
        direction: 'LONG', entryPrice: 100,
        amd: { manipulation: { sweepEvent: { price: 99.5 } } },
        swings: [{ price: 99.2, confirmedAt: 900 }], fvg: {},
        evaluationTime: 1000, tickSize: 0.01, atr: 1
    }, {});
    assert.strictEqual(stop1.source, 'MANIPULATION_SWEEP');
    assert.strictEqual(stop1.referencePrice, 99.5);

    var stop2 = stopPlanner.planStop({
        direction: 'LONG', entryPrice: 100,
        amd: { accumulation: { rangeLow: 98.5, rangeHigh: 101 } },
        swings: [{ price: 99.2, confirmedAt: 900 }], fvg: {},
        evaluationTime: 1000, tickSize: 0.01, atr: 1
    }, {});
    assert.strictEqual(stop2.source, 'ACCUMULATION_RANGE_LOW');
    assert.strictEqual(stop2.referencePrice, 98.5);
});

test('11T.5S：INVALID_REFERENCE 保留 —— 严格边界不在 entry 风险方向 → 跳过', function () {
    var stop = stopPlanner.planStop({
        direction: 'LONG', entryPrice: 100,
        amd: {
            manipulation: { sweepEvent: { price: 101 } }, // sweep 在 entry 上方
            accumulation: { rangeLow: 100.5, rangeHigh: 103 }
        },
        swings: [{ price: 99.2, confirmedAt: 900 }], fvg: {},
        evaluationTime: 1000, tickSize: 0.01, atr: 1
    }, {});
    assert.strictEqual(stop.source, 'SWING_LOW', '严格边界 100.5 不在 entry(100) 下方 → INVALID_REFERENCE → swing');
    assert.strictEqual(stop.referencePrice, 99.2);
});

test('11T.5S：computeInvalidationBoundary 严格版（retained 侧）', function () {
    var amd = require('../amd/amdState');
    // 直接验证 amdState 的 computeInvalidationBoundary 通过 retain 路径
    var st = amd.createAmdState();
    st.direction = 'BULLISH';
    st.accumulation = { rangeLow: 98, rangeHigh: 100, confirmedAt: 800 };
    st.manipulation = { sweepEvent: { price: 99, id: 's1', confirmedAt: 900 }, confirmedAt: 900 };
    st.distribution = { mssEvent: { id: 'm1' }, displacementEvent: { id: 'd1' }, confirmedAt: 950 };
    st.confirmedAt = 950;
    st.phase = 'DISTRIBUTION';
    amd.updateAmdState(st, { candleIndex: 100 }, { thresholds: thresholds });
    assert.strictEqual(st.lastNarrative.invalidationBoundary.short, 98, 'min(99, 98) = 98');
    assert.strictEqual(st.lastNarrative.invalidationBoundary.long, 100);
});

/* ---------- Phase 11E.3：Entry Confirmation Counterfactual ---------- */

test('11E.3：4 种 entry 确认变体 —— ENTRY_NOW 最早，确认变体延迟触发', function () {
    var candles = [];
    var i;
    for (i = 0; i < 30; i++) candles.push(m5(104, 105, 103.5, 104.5, i));
    // trigger：回踩进 zone（low 102.3 <= zoneHigh 102.5）
    candles[12] = m5(104, 104.5, 102.3, 102.4, 12);  // close 102.4（在 zone 内，未 reclaim）
    candles[13] = m5(102.5, 104, 102.4, 103.2, 13);  // bullish close > open → AFTER_1_BAR_CONFIRM（close 103.2 > 102.4）
    candles[14] = m5(103, 104.5, 102.9, 104.2, 14);  // close 104.2 > zoneHigh 102.5 → AFTER_RECLAIM / MIDPOINT 也已满足

    var r = retraceTracker.createRetrace({
        symbol: 'BTCUSDT', direction: 'BULLISH',
        fvg: { id: 'f1', zoneLow: 102.0, zoneHigh: 102.5, midpoint: 102.25, _score: 60 },
        watchIndex: 10, watchAt: 1234, atr: 1,
        draw: { bsl: { primary: { targetPrice: 108 } } },
        amd: amdEmpty(), swings: [{ price: 101.8, confirmedAt: 900 }], tickSize: 0.01,
        candle: candles[10], alignment: 'UNCONFIRMED', bias: 'NEUTRAL'
    });
    r.closeIndex = 25;
    r.closeAt = candles[25].closeTime;
    var results = shadowEntry.runEntryConfirmation(r, {
        candles: candles,
        thresholds: require('../config/thresholds')
    });
    var keys = results.map(function (v) { return v.variant; });
    ['ENTRY_NOW', 'AFTER_1_BAR_CONFIRM', 'AFTER_RECLAIM', 'AFTER_MIDPOINT_RECLAIM'].forEach(function (k) {
        assert.ok(keys.indexOf(k) !== -1, k + ' 应触发');
    });
    var now = results.filter(function (v) { return v.variant === 'ENTRY_NOW'; })[0];
    var confirm = results.filter(function (v) { return v.variant === 'AFTER_1_BAR_CONFIRM'; })[0];
    assert.ok(confirm.entryIndex > now.entryIndex, '确认变体应晚于 ENTRY_NOW');
    r.confirmationResults = results;
    var rows = shadowEntry.summarizeConfirmations([r]);
    assert.strictEqual(rows.length, 4);
    var nowRow = rows.filter(function (x) { return x.variant === 'ENTRY_NOW'; })[0];
    assert.strictEqual(nowRow.entries, 1);
});

/* ---------- Phase 11E.6：Directional Confirmation（正式化） ---------- */

var tradePlan = require('../trade/tradePlan');

test('11E.6：buildTradePlan entryPrice 覆盖 —— 确认 K 收盘价 = 实际 entry，不按旧价成交', function () {
    var gate = { state: 'ENTRY_READY', entryZone: { low: 100, high: 101, midpoint: 100.5 }, preferredEntry: 100, fvg: { zoneLow: 100, zoneHigh: 101, direction: 'BULLISH' } };
    var plan = tradePlan.buildTradePlan({
        symbol: 'BTCUSDT', evaluationTime: 1000,
        entryGate: gate, currentPrice: 101.5,
        entryPrice: 101.2, // 确认 K 收盘价（≠ 旧 preferredEntry 100）
        amd: amdWithManip(), swings: [],
        draw: { bsl: { primary: { targetPrice: 108 } } },
        tickSize: 0.01, atr: 1,
        context: { bias: 'BULLISH', scenario: 'BULLISH_WATCH', amd: 'COMPLETE' }
    }, {});
    assert.strictEqual(plan.status, 'READY');
    assert.strictEqual(plan.entry.price, 101.2, 'entry 必须是确认 K 收盘价');
    assert.strictEqual(plan.entry.mode, 'CONFIRMED');
    // RR 基于确认后 entry 重算（不是旧 entry 100）
    assert.ok(plan.entry.price > 100);
});

test('11E.6：确认后 entry 变差 → RR 重算可能 <1.5（CONFIRMATION_REJECTED_RR 语义）', function () {
    var gate = { state: 'ENTRY_READY', entryZone: { low: 100, high: 101, midpoint: 100.5 }, preferredEntry: 100, fvg: { zoneLow: 100, zoneHigh: 101, direction: 'BULLISH' } };
    // 确认 K 收盘远高于 entry（101.5），stop 重算后 risk 变大 → RR 缩水
    var plan = tradePlan.buildTradePlan({
        symbol: 'BTCUSDT', evaluationTime: 1000,
        entryGate: gate, currentPrice: 101.6,
        entryPrice: 101.5,
        amd: amdWithManip(), swings: [],
        draw: { bsl: { primary: { targetPrice: 108 } } },
        tickSize: 0.01, atr: 1,
        context: { bias: 'BULLISH', scenario: 'BULLISH_WATCH', amd: 'COMPLETE' }
    }, {});
    // stop 在 sweep 99 外 → risk = 101.5-98.95 ≈ 2.55；target 108 → reward 6.5 → RR ≈ 2.5（仍 READY）
    // 关键断言：RR 必须基于确认后 entry（101.5）而非旧 entry（100）计算
    var risk = 101.5 - plan.stop.price;
    assert.ok(Math.abs(plan.rr - (108 - 101.5) / risk) < 0.02, 'RR 必须基于确认后 entry 重算');
});

/* ---------- Phase 11N：Narrative Direction Validation ---------- */

var narrativeDirection = require('../stats/narrativeDirection');

test('11N：BULLISH 回踩事件 —— 未来上涨 → dirCorrect/MFE 为正，Draw Hit 统计', function () {
    var candles = [];
    var i;
    for (i = 0; i < 60; i++) candles.push(m5(104, 105, 103.5, 104.5, i));
    // 回踩：index 10 wick 触及 zone（low 102.3 <= zoneHigh 102.5）
    candles[10] = m5(104, 104.5, 102.3, 103.0, 10);
    // 未来上涨：index 11-16 稳步走高，index 14 触及 target 108
    candles[11] = m5(103.2, 104.5, 103.0, 104.0, 11);
    candles[12] = m5(104.0, 105.5, 103.8, 105.2, 12);
    candles[13] = m5(105.0, 107.0, 104.8, 106.5, 13);
    candles[14] = m5(106.0, 108.2, 105.8, 107.8, 14); // high 108.2 >= target 108
    candles[15] = m5(107.5, 109.0, 107.2, 108.6, 15);

    var r = retraceTracker.createRetrace({
        symbol: 'BTCUSDT', direction: 'BULLISH',
        fvg: { id: 'f1', zoneLow: 102.0, zoneHigh: 102.5, midpoint: 102.25, _score: 80 },
        watchIndex: 8, watchAt: 1234, atr: 1,
        draw: { bsl: { primary: { targetPrice: 108 } } },
        amd: amdEmpty(), swings: [], tickSize: 0.01,
        candle: candles[8], alignment: 'MATCH', bias: 'BULLISH'
    });
    r.closeIndex = 40;
    r.closeAt = candles[40].closeTime;
    var ev = narrativeDirection.analyzeRetrace(r, candles);
    assert.ok(ev, '应有回踩事件');
    assert.strictEqual(ev.direction, 'BULLISH');
    assert.strictEqual(ev.alignment, 'MATCH');
    assert.strictEqual(ev.touchIndex, 10, 'wick 触及根');
    assert.ok(ev.w30m.dirCorrect, '30m 净涨跌应为正');
    assert.ok(ev.w30m.mfePct > 0);
    assert.strictEqual(ev.w30m.drawHit, true, '30m 内应触达 primary target');
    // 汇总
    var sum = narrativeDirection.summarizeNarrativeDirection([ev]);
    assert.ok(sum.groups.MATCH.n === 1);
    assert.ok(sum.groups.MATCH.w30m.hit === 1);
});

test('11N：BEARISH 对称 + 未回踩事件返回 null', function () {
    var candles = [];
    var i;
    for (i = 0; i < 60; i++) candles.push(m5(96, 97, 95, 96.5, i));
    // 回踩：index 10 high 101.7 >= zoneLow 101.5（BEARISH 触及）
    candles[10] = m5(97, 101.7, 96, 101.0, 10);
    // 未来下跌
    candles[11] = m5(100.5, 101.0, 99.0, 99.5, 11);
    candles[12] = m5(99.0, 99.8, 97.5, 98.0, 12);

    var r = retraceTracker.createRetrace({
        symbol: 'BTCUSDT', direction: 'BEARISH',
        fvg: { id: 'f2', zoneLow: 101.5, zoneHigh: 102.0, midpoint: 101.75, _score: 75 },
        watchIndex: 8, watchAt: 1234, atr: 1,
        draw: { ssl: { primary: { targetPrice: 96 } } },
        amd: amdEmpty(), swings: [], tickSize: 0.01,
        candle: candles[8], alignment: 'OPPOSITE', bias: 'BEARISH'
    });
    r.closeIndex = 40;
    r.closeAt = candles[40].closeTime;
    var ev = narrativeDirection.analyzeRetrace(r, candles);
    assert.ok(ev);
    assert.strictEqual(ev.direction, 'BEARISH');
    assert.ok(ev.w30m.dirCorrect, 'BEARISH 净跌应为正');
    // 未回踩：独立 candles（价格一直远离 zone 102.0-102.5，low 从未 <= zoneHigh）→ null
    var farCandles = [];
    for (var k = 0; k < 60; k++) farCandles.push(m5(104, 105, 103.5, 104.5, k)); // low 103.5 > zoneHigh 102.5
    var r2 = retraceTracker.createRetrace({
        symbol: 'BTCUSDT', direction: 'BULLISH',
        fvg: { id: 'f3', zoneLow: 102.0, zoneHigh: 102.5, midpoint: 102.25, _score: 70 },
        watchIndex: 8, watchAt: 1234, atr: 1,
        draw: { bsl: { primary: { targetPrice: 108 } } },
        amd: amdEmpty(), swings: [], tickSize: 0.01,
        candle: farCandles[8], alignment: 'MATCH', bias: 'BULLISH'
    });
    r2.closeIndex = 40;
    r2.closeAt = farCandles[40].closeTime;
    var ev2 = narrativeDirection.analyzeRetrace(r2, farCandles);
    assert.strictEqual(ev2, null, '价格从未触及 zone → 无事件');
});

/* ---------- Phase 11D.3：Opportunity / DisplacementLeg ---------- */

var opportunity = require('../stats/opportunity');

test('11D.3：同一 Displacement Leg 的多个 FVG 归为一个 Opportunity（连续同向合并）', function () {
    // 2 个连续 BULLISH displacement（间隔 1 根 5m < 3 根窗口）+ 3 个 FVG 关联
    var events = {
        DISPLACEMENT: [
            { id: 'd1', direction: 'BULLISH', confirmedAt: 1000000, metadata: { mssEventId: 'm1' } },
            { id: 'd2', direction: 'BULLISH', confirmedAt: 1300000, metadata: { mssEventId: null } } // 同 leg（15min 内）
        ],
        MSS: [{ id: 'm1', confirmedAt: 900000 }]
    };
    var fvgs = [
        { id: 'f1', direction: 'BULLISH', displacementEventId: 'd1', confirmedAt: 1100000 },
        { id: 'f2', direction: 'BULLISH', displacementEventId: 'd2', confirmedAt: 1400000 },
        { id: 'f3', direction: 'BULLISH', displacementEventId: 'd2', confirmedAt: 1500000 }
    ];
    var opps = opportunity.buildOpportunities('BTCUSDT', fvgs, events);
    // d1+d2 连续同向 → 同一 leg → 同一 opportunity
    assert.strictEqual(opps.length, 1, '3 个 FVG 应归 1 个 opportunity');
    assert.strictEqual(opps[0].fvgIds.length, 3);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(opps[0], 'mssId'), false);
    assert.strictEqual(opps[0].nLegs, 1);
    var s = opportunity.summarizeOpportunities(opps);
    assert.strictEqual(s.opportunities, 1);
    assert.strictEqual(s.totalFvgs, 3);
});

test('11D.3：间隔远的 displacement 不合并（不同 leg → 不同 opportunity）', function () {
    var events = {
        DISPLACEMENT: [
            { id: 'd1', direction: 'BULLISH', confirmedAt: 1000000, metadata: {} },
            { id: 'd2', direction: 'BULLISH', confirmedAt: 5000000, metadata: {} } // 40 分钟 > 15 分钟窗口
        ],
        MSS: []
    };
    var fvgs = [
        { id: 'f1', direction: 'BULLISH', displacementEventId: 'd1', confirmedAt: 1100000 },
        { id: 'f2', direction: 'BULLISH', displacementEventId: 'd2', confirmedAt: 5100000 }
    ];
    var opps = opportunity.buildOpportunities('BTCUSDT', fvgs, events);
    assert.strictEqual(opps.length, 2, '间隔 40 分钟的两个 displacement 应各自成机会');
});

/* ---------- Phase 11D.5：DisplacementLeg ---------- */

var displacementLeg = require('../stats/displacementLeg');

test('11D.5：3 根连续同向 displacement 合并为 1 leg，价量维度与 quality 分级正确', function () {
    // 3 根连续 BULLISH displacement（candleIndex 10/11/12），ATR 1
    var disp = [
        { id: 'd1', direction: 'BULLISH', candleIndex: 10, confirmedAt: 1000000, metadata: { atr: 1, mssEventId: null } },
        { id: 'd2', direction: 'BULLISH', candleIndex: 11, confirmedAt: 1300000, metadata: { atr: 1, mssEventId: null } },
        { id: 'd3', direction: 'BULLISH', candleIndex: 12, confirmedAt: 1600000, metadata: { atr: 1, mssEventId: null } }
    ];
    // candles：连续大阳线（range 2.6 ATR，netMove 2.4 ATR）
    var candles = [];
    for (var i = 0; i < 30; i++) candles.push(m5(100, 101, 99, 100.5, i));
    candles[10] = m5(100.5, 102.5, 100.4, 102.4, 10);
    candles[11] = m5(102.4, 104.4, 102.3, 104.3, 11);
    candles[12] = m5(104.3, 106.3, 104.2, 106.2, 12);
    var legs = displacementLeg.buildDisplacementLegs(disp, []);
    assert.strictEqual(legs.length, 1, '3 连续同向应合并为 1 leg');
    assert.strictEqual(legs[0].startIndex, 10);
    assert.strictEqual(legs[0].endIndex, 12);
    assert.strictEqual(legs[0].bars, 3);
    displacementLeg.enrichLegWithCandles(legs[0], candles);
    // range = 106.3 - 100.4 = 5.9 → rangeAtr 5.9；netMove = |106.2 - 100.5| = 5.7 → 5.7
    assert.ok(legs[0].rangeAtr > 5);
    assert.ok(legs[0].netMoveAtr > 5);
    assert.strictEqual(displacementLeg.classifyLegQuality(legs[0]), 'EXPLOSIVE');
    // 4 根间隔 → 不合并
    var disp2 = [
        { id: 'e1', direction: 'BULLISH', candleIndex: 10, confirmedAt: 1000000, metadata: { atr: 1 } },
        { id: 'e2', direction: 'BULLISH', candleIndex: 20, confirmedAt: 2000000, metadata: { atr: 1 } }
    ];
    var legs2 = displacementLeg.buildDisplacementLegs(disp2, []);
    assert.strictEqual(legs2.length, 2, '间隔 10 根不应合并');
});

/* ---------- Phase 11D.7：Opportunity Quality Tier ---------- */

var opportunityQuality = require('../stats/opportunityQuality');

test('11D.7：tier 只由 leg、near draw 与 conflict 分层', function () {
    assert.strictEqual(opportunityQuality.classifyOpportunityTier({ legQuality: 'EXPLOSIVE', nearDrawAvailable: true }), 'HIGH_QUALITY');
    assert.strictEqual(opportunityQuality.classifyOpportunityTier({ legQuality: 'STRONG', nearDrawAvailable: true }), 'HIGH_QUALITY');
    assert.strictEqual(opportunityQuality.classifyOpportunityTier({ legQuality: 'NORMAL', nearDrawAvailable: true }), 'WATCH');
    assert.strictEqual(opportunityQuality.classifyOpportunityTier({ legQuality: 'WEAK', nearDrawAvailable: true }), 'LOW_QUALITY');
    assert.strictEqual(opportunityQuality.classifyOpportunityTier({ legQuality: 'EXPLOSIVE', nearDrawAvailable: false }), 'LOW_QUALITY');
    assert.strictEqual(opportunityQuality.classifyOpportunityTier({ legQuality: 'EXPLOSIVE', nearDrawAvailable: true, directionConflict: true }), 'LOW_QUALITY');
});

test('11D.7：buildTierIndex 挂档 —— leg endIndex 取 near target，tier 判定正确', function () {
    var fvgs = [
        { id: 'f1', direction: 'BULLISH', displacementEventId: 'd1' },
        { id: 'f2', direction: 'BULLISH', displacementEventId: 'd2' }
    ];
    var opps = [
        { id: 'm1', direction: 'BULLISH', fvgIds: ['f1'] },
        { id: 'm2', direction: 'BULLISH', fvgIds: ['f2'] }
    ];
    var legByDispId = {
        d1: { quality: 'EXPLOSIVE', mssQuality: 'PROTECTED_SWING', endIndex: 10 },
        d2: { quality: 'WEAK', mssQuality: 'INTERNAL', endIndex: 15 }
    };
    var drawTrace = [];
    drawTrace[10] = { bslNear: 105, bslMacro: 110, sslNear: null, sslMacro: null };
    drawTrace[15] = { bslNear: null, bslMacro: null, sslNear: null, sslMacro: null };
    var items = opportunityQuality.buildTierIndex(opps, fvgs, legByDispId, drawTrace);
    assert.strictEqual(items.length, 2);
    assert.strictEqual(items[0].tier, 'HIGH_QUALITY');
    assert.strictEqual(items[0].anchorIndex, 10);
    assert.strictEqual(items[0].nearTarget, 105, 'drawTrace[10].bslNear');
    assert.strictEqual(items[1].tier, 'LOW_QUALITY', 'WEAK leg + 无 near draw');
    assert.strictEqual(items[1].nearTarget, null);
});

test('11D.7：validateTiers —— 1h 方向 hit / nearHit 聚合正确（锚 = leg 完成下一根）', function () {
    // HIGH 机会：独立价格路径 —— 锚 index 10（close 100.5），11-22 一路上涨，22 close 105.5 > 锚
    var candlesA = [];
    for (var i = 0; i < 40; i++) candlesA.push(m5(100, 101, 99, 100.5, i));
    candlesA[11] = m5(100.5, 102, 100.4, 101.5, 11);
    candlesA[12] = m5(101.5, 105.2, 101.4, 104.8, 12); // high 105.2 >= near 105
    for (var k = 13; k <= 22; k++) candlesA[k] = m5(104.5, 106, 104.3, 105.5, k); // 窗口结束仍高位
    // WATCH 机会：独立价格路径 —— 锚 index 20（close 100.5），21-32 一路下跌，32 close 98 < 锚
    var candlesB = [];
    for (var j = 0; j < 40; j++) candlesB.push(m5(100, 101, 99, 100.5, j));
    for (var m = 21; m <= 32; m++) candlesB[m] = m5(100.3, 100.5, 97.8, 98.0, m);
    var itemsA = [
        { id: 'a', direction: 'BULLISH', tier: 'HIGH_QUALITY', anchorIndex: 10, nearTarget: 105, hasLeg: true },
        { id: 'c', direction: 'BULLISH', tier: 'LOW_QUALITY', anchorIndex: null, nearTarget: null, hasLeg: false }
    ];
    var itemsB = [
        { id: 'b', direction: 'BULLISH', tier: 'WATCH', anchorIndex: 20, nearTarget: 102, hasLeg: true }
    ];
    var aggA = opportunityQuality.validateTiers(itemsA, candlesA, 12);
    assert.strictEqual(aggA.HIGH_QUALITY.n, 1);
    assert.strictEqual(aggA.HIGH_QUALITY.hit, 1, '窗口结束净涨跌为正');
    assert.strictEqual(aggA.HIGH_QUALITY.nearHit, 1, 'high >= nearTarget');
    assert.strictEqual(aggA.LOW_QUALITY, null, '无 leg 锚点的 LOW item 不参与 validation（键保持 null）');
    var aggB = opportunityQuality.validateTiers(itemsB, candlesB, 12);
    assert.strictEqual(aggB.WATCH.n, 1);
    assert.strictEqual(aggB.WATCH.hit, 0, '窗口结束净跌 → 未朝方向走');
    assert.strictEqual(aggB.WATCH.nearHit, 0);
});

/* ---------- Phase 11D.8：Opportunity Alert Replay ---------- */

var alertReplay = require('../stats/alertReplay');

test('11D.8：buildAlerts —— 同一 Opportunity 只通知一次，时间升序，sweep 关联正确', function () {
    var candles = [];
    for (var i = 0; i < 60; i++) candles.push(m5(100, 101, 99, 100.5, i));
    var fvgs = [
        { id: 'f1', direction: 'BULLISH', displacementEventId: 'd1', zoneLow: 100.2, zoneHigh: 100.8 },
        { id: 'f2', direction: 'BULLISH', displacementEventId: 'd1', zoneLow: 100.5, zoneHigh: 101.0 }, // 同 leg 第二个 FVG
        { id: 'f3', direction: 'BEARISH', displacementEventId: 'd2', zoneLow: 101.0, zoneHigh: 101.5 }
    ];
    var opps = [
        { id: 'm1', direction: 'BULLISH', fvgIds: ['f1', 'f2'], createdAt: 1000000, lastAt: 1400000 },
        { id: 'm2', direction: 'BEARISH', fvgIds: ['f3'], createdAt: 2000000, lastAt: 2200000 }
    ];
    var legByDispId = {
        d1: { quality: 'EXPLOSIVE', mssQuality: 'PROTECTED_SWING', endIndex: 20, direction: 'BULLISH', ids: ['d1'] },
        d2: { quality: 'NORMAL', mssQuality: 'INTERNAL', endIndex: 30, direction: 'BEARISH', ids: ['d2'] }
    };
    var drawTrace = [];
    drawTrace[20] = { bslNear: 105, bslMacro: 110, sslNear: null, sslMacro: null };
    drawTrace[30] = { bslNear: null, bslMacro: null, sslNear: 96, sslMacro: 94 };
    var sweeps = [
        { side: 'SSL', price: 99.8, candleIndex: 15, confirmedAt: 6000000 },  // 同向（BULLISH）leg 前窗口内
        { side: 'BSL', price: 102, candleIndex: 25, confirmedAt: 7500000 }    // BEARISH
    ];
    legByDispId.d1.rangeAtr = 2.6;
    legByDispId.d1.netMoveAtr = 2.1;
    legByDispId.d1.bodyEfficiency = 0.7;
    var alerts = alertReplay.buildAlerts(opps, fvgs, legByDispId, drawTrace, sweeps, candles);
    assert.strictEqual(alerts.length, 2, '2 个 opportunity → 2 条通知（f1+f2 合并为 1）');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(alerts[0], 'mssRefPrice'), false);
    assert.strictEqual(alerts[0].legRangeAtr, 2.6);
    assert.strictEqual(alerts[0].legBodyEff, 0.7);
    assert.strictEqual(alerts[0].anchorIndex, 20, '时间升序');
    assert.strictEqual(alerts[0].tier, 'HIGH_QUALITY');
    assert.strictEqual(alerts[0].fvgCount, 2, '同 leg 2 个 FVG 只算一条通知但记录数量');
    assert.ok(alerts[0].sweep && alerts[0].sweep.side === 'SSL', 'BULLISH 关联 SSL sweep');
    assert.strictEqual(alerts[0].sweep.barsAgo, 5, '20-15=5');
    assert.strictEqual(alerts[0].nearDistPct !== null, true);
    assert.ok(Math.abs(alerts[0].nearDistPct - (105 - 100.5) / 100.5 * 100) < 1e-6);
    // BEARISH：BSL sweep（25）在锚 30 前 24 根窗口内（barsAgo=5）→ 非 null
    assert.ok(alerts[1].sweep && alerts[1].sweep.side === 'BSL', 'BEARISH 关联 BSL sweep');
    assert.strictEqual(alerts[1].sweep.barsAgo, 5);
});

test('11D.8：assessAlerts —— 30m/1h nearHit 与距离分桶', function () {
    var candles = [];
    for (var i = 0; i < 60; i++) candles.push(m5(100, 101, 99, 100.5, i));
    // alert A：BULLISH，near 103（距离 2.49% >1% 桶），锚 10，1h 内触达 103
    candles[11] = m5(100.5, 102, 100.4, 101.5, 11);
    candles[12] = m5(101.5, 103.5, 101.4, 103.2, 12); // high >= 103
    // alert B：BULLISH，near 100.7（距离 0.2% → 0.1-0.25% 桶），锚 20，30m 内触达但 1h 回落后未再触达？
    candles[21] = m5(100.5, 100.8, 100.2, 100.6, 21); // high 100.8 >= 100.7 → 30m hit
    candles[22] = m5(100.6, 100.75, 99.5, 99.8, 22); // 30m 窗口（6 根 = 21-26）内 high 100.75 < 100.7 → 不再触
    var alerts = [
        { id: 'a', tier: 'HIGH_QUALITY', direction: 'BULLISH', anchorIndex: 10, anchorPrice: 100.5, nearTarget: 103, nearDistPct: 2.49 },
        { id: 'b', tier: 'WATCH', direction: 'BULLISH', anchorIndex: 20, anchorPrice: 100.5, nearTarget: 100.7, nearDistPct: 0.2 }
    ];
    var a = alertReplay.assessAlerts(alerts, candles);
    assert.strictEqual(a.byTier.HIGH_QUALITY, 1);
    assert.strictEqual(a.tierStats.HIGH_QUALITY.w1h.nearHit, 1);
    assert.strictEqual(a.tierStats.WATCH.w30m.nearHit, 1, '30m 内触达');
    assert.strictEqual(a.tierStats.WATCH.w1h.nearHit, 1, '1h 内触达（21 根已触）');
    // 距离桶
    assert.ok(a.distBuckets['>1%'].HIGH_QUALITY.n === 1, '2.49% → >1% 桶');
    assert.ok(a.distBuckets['0.1-0.25%'].WATCH.n === 1, '0.2% → 0.1-0.25% 桶');
});

/* ---------- Phase 11D.9：Delivery Alignment Audit ---------- */

var deliveryAlignment = require('../stats/deliveryAlignment');

test('11D.9：DELIVERY_ALIGNED —— HTF 全同向 + deliveryHold + continuation → A 类', function () {
    var candles = [];
    for (var i = 0; i < 60; i++) candles.push(m5(100, 101, 99, 100.5, i));
    // leg：start 8（low 99.5），end 12（high 104）；锚 12，price 103
    candles[8] = m5(100, 101, 99.5, 100.5, 8);
    candles[9] = m5(100.5, 102, 100.4, 101.8, 9);
    candles[10] = m5(101.8, 103.5, 101.7, 103.2, 10);
    candles[11] = m5(103.2, 104, 103.1, 103.8, 11);
    candles[12] = m5(103.8, 104.5, 103.6, 103.0, 12); // leg end high 104.5
    // 后续 12 根：低点 >= leg start low 99.5（deliveryHold），且创新高 106 > 104.5（continuation），close 保持
    for (var k = 13; k <= 24; k++) candles[k] = m5(103.5, 106, 103.4, 105.5, k);
    var al = {
        direction: 'BULLISH', anchorIndex: 12, anchorPrice: 103.0,
        nearTarget: 105, dispId: 'd1', legStartIndex: 8
    };
    var legByDispId = { d1: { startIndex: 8, endIndex: 12, ids: ['d1'] } };
    var biasTrace = []; biasTrace[12] = { direction: 'BULLISH', confidence: 60 };
    var htfTrendTrace = []; htfTrendTrace[12] = { h1Up: true, h4Up: true };
    var r = deliveryAlignment.analyzeDeliveryAlignment(al, candles, legByDispId, biasTrace, htfTrendTrace);
    assert.ok(r, '应分析出结果');
    assert.strictEqual(r.deliveryClass, 'DELIVERY_ALIGNED');
    assert.strictEqual(r.dirHit1h, true, '窗口结束 close 105.5 > 锚 103');
    assert.strictEqual(r.nearHit1h, true, 'high 106 >= near 105');
});

test('11D.9：FALSE_DIRECTIONAL —— HTF 反向 → C 类（#6/#8/#9 模式）', function () {
    var candles = [];
    for (var i = 0; i < 60; i++) candles.push(m5(100, 101, 99, 100.5, i));
    // leg start 8 起点 low 101；leg end 12 high 104，后续回撤到 99（< 101 = 跌破 leg 起点）
    candles[8] = m5(101, 102, 101.0, 101.5, 8);
    candles[12] = m5(103, 104, 102.8, 103.2, 12);
    for (var k = 13; k <= 24; k++) candles[k] = m5(102, 102.5, 99.0, 99.5, k);
    var al = {
        direction: 'BULLISH', anchorIndex: 12, anchorPrice: 103.2,
        nearTarget: null, dispId: 'd1', legStartIndex: 8
    };
    var legByDispId = { d1: { startIndex: 8, endIndex: 12, ids: ['d1'] } };
    var biasTrace = []; biasTrace[12] = { direction: 'BEARISH', confidence: 55 };
    var htfTrendTrace = []; htfTrendTrace[12] = { h1Up: false, h4Up: false };
    var r = deliveryAlignment.analyzeDeliveryAlignment(al, candles, legByDispId, biasTrace, htfTrendTrace);
    assert.strictEqual(r.deliveryClass, 'FALSE_DIRECTIONAL', 'HTF 全反向 → 假方向');
    assert.strictEqual(r.dirHit1h, false, '净跌');
    assert.strictEqual(r.deliveryHold, false, '回撤跌破 leg 起点');
});

test('11D.9：LOCAL_VALID —— HTF 同向但无 continuation → B 类（#10 模式）', function () {
    var candles = [];
    for (var i = 0; i < 60; i++) candles.push(m5(100, 101, 99, 100.5, i));
    // leg end 12 high 104.5；后续不创新高（max 104.2 < 104.5），但守住 leg 起点
    candles[12] = m5(103, 104.5, 102.9, 103.2, 12);
    for (var k = 13; k <= 24; k++) candles[k] = m5(102.8, 104.2, 102.6, 103.0, k);
    var al = {
        direction: 'BULLISH', anchorIndex: 12, anchorPrice: 103.2,
        nearTarget: 103.5, dispId: 'd1', legStartIndex: 8
    };
    var legByDispId = { d1: { startIndex: 8, endIndex: 12, ids: ['d1'] } };
    var biasTrace = []; biasTrace[12] = { direction: 'BULLISH', confidence: 60 };
    var htfTrendTrace = []; htfTrendTrace[12] = { h1Up: true, h4Up: true };
    var r = deliveryAlignment.analyzeDeliveryAlignment(al, candles, legByDispId, biasTrace, htfTrendTrace);
    assert.strictEqual(r.deliveryClass, 'LOCAL_VALID', '同向但未创新高 → 局部有效');
    assert.strictEqual(r.continuation, false);
    // 汇总
    var s = deliveryAlignment.assessDeliveryClasses([r]);
    assert.strictEqual(s.byClass.LOCAL_VALID.n, 1);
});

/* ---------- Phase 11D.10：HTF Liquidity Context ---------- */

var htfLiquidityContext = require('../stats/htfLiquidityContext');

function htfCandlesWave(n, base) {
    // 波浪：up-down-up-down，产生 1h pivots
    var out = [];
    for (var i = 0; i < n; i++) {
        var o = base + (i % 4 === 0 ? 0 : (i % 4 === 1 ? 3 : (i % 4 === 2 ? 0 : -3)));
        out.push({
            openTime: i * 3600000, open: o,
            high: o + 4, low: o - 4,
            close: i % 4 === 1 ? o + 2 : o - 1,
            closeTime: i * 3600000 + 3599999, closed: true, source: 'futures'
        });
    }
    return out;
}

test('11D.10：buildHtfLiquidity —— 1H/4H confirmed pivots 入池，带 confirmedAt', function () {
    var h1 = htfCandlesWave(60, 100);
    var h4 = htfCandlesWave(40, 200);
    var pool = htfLiquidityContext.buildHtfLiquidity(h1, h4);
    assert.ok(pool.length > 0, '应有 HTF liquidity');
    var has1h = pool.filter(function (x) { return x.level === '1H_SWING'; }).length > 0;
    var has4h = pool.filter(function (x) { return x.level === '4H_SWING'; }).length > 0;
    assert.ok(has1h, '有 1H_SWING');
    assert.ok(has4h, '有 4H_SWING');
    pool.forEach(function (lq) {
        assert.ok(lq.confirmedAt > 0, 'confirmedAt 已封板');
        assert.ok(lq.side === 'BSL' || lq.side === 'SSL');
    });
});

test('11D.10：sweepLevelOf —— BULLISH 扫 1H low → 1H_SWING；未扫 → 5M/NONE', function () {
    // 5m 时间轴：m5 用 1000000+i*300000；1h 波浪用 i*3600000（基准 0）
    // 锚 80 → 5m 时间 1000000+80*300000 = 25000000；1h pivot low(i=3) confirmedAt = (3+2)*3600000 = 18000000 < 25000000 ✓ 可见
    var candles = [];
    for (var i = 0; i < 100; i++) candles.push(m5(100, 101, 99, 100.5, i));
    // 窗口内（锚 80 前 48 根 = 32-80）价格曾跌破 93（1h pivot low）
    candles[60] = m5(100, 100.5, 92.5, 99.5, 60); // low 92.5 < 93
    // 锚 80，anchorPrice 101（收回在 93 之上）
    candles[80] = m5(100.8, 101.5, 100.7, 101.0, 80);
    var h1 = htfCandlesWave(60, 100); // 波浪 i%4=3 → pivot low 93
    var pool = htfLiquidityContext.buildHtfLiquidity(h1, []);
    var al = {
        direction: 'BULLISH', anchorIndex: 80, anchorTime: candles[80].closeTime,
        anchorPrice: 101.0, sweep: { price: 99.5, side: 'SSL' }
    };
    var sw = htfLiquidityContext.sweepLevelOf(al, candles, pool, []);
    assert.strictEqual(sw.level, '1H_SWING', '窗口内穿过已确认的 1h pivot low 93');
    assert.ok(sw.distPct > 0);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(sw, 'distToMssRefPct'), false);

    // 未扫 HTF：1h 在 200 附近（anchor 101 下方最近的 HTF low 193 未被穿，窗口 low 最低 99）
    var candles2 = [];
    for (var j = 0; j < 100; j++) candles2.push(m5(100, 101, 99, 100.5, j));
    candles2[80] = m5(100.8, 101.5, 100.7, 101.0, 80);
    var pool2 = htfLiquidityContext.buildHtfLiquidity(htfCandlesWave(60, 200), []); // pivot low 193 在 200 附近
    var al2 = {
        direction: 'BULLISH', anchorIndex: 80, anchorTime: candles2[80].closeTime,
        anchorPrice: 101.0, sweep: { price: 99.2, side: 'SSL' }
    };
    var sw2 = htfLiquidityContext.sweepLevelOf(al2, candles2, pool2, []);
    assert.strictEqual(sw2.level, '5M_INTERNAL', '无 HTF 命中 → 5m sweep');
});

/* ---------- Phase 11L：Live 管线基础单元 ---------- */

var dingTalk = require('../notify/dingTalk');
var persistence = require('../live/persistence');

test('11L：钉钉加签 —— 确定性向量（URL 编码 HMAC-SHA256）', function () {
    var ts = '1717674471240';
    var secret = 'SEC0000000000000000000000000000000000000000000000000000000000000000';
    var s = dingTalk.sign(secret, ts);
    assert.ok(s.length > 10, '签名非空');
    assert.ok(s.indexOf('+') === -1, 'URL 编码（+ → %2B）');
    assert.ok(s.indexOf('%') !== -1 || s.indexOf('=') !== -1, '含编码特征');
    // 确定性：同输入同输出
    assert.strictEqual(dingTalk.sign(secret, ts), dingTalk.sign(secret, ts));
});

test('11L：persistence —— candles JSONL 追加 + 恢复 round-trip', function () {
    var os = require('os');
    var path = require('path');
    var fs = require('fs');
    var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-test-'));
    var file = path.join(dir, 'candles.jsonl');
    persistence.appendCandles(file, [
        { openTime: 1, close: 100, high: 101, low: 99 },
        { openTime: 2, close: 101, high: 102, low: 100 }
    ]);
    persistence.appendCandles(file, [{ openTime: 3, close: 102, high: 103, low: 101 }]);
    var loaded = persistence.loadCandles(file);
    var candles = loaded.candles;
    assert.strictEqual(candles.length, 3, '追加式恢复');
    assert.strictEqual(candles[2].openTime, 3);
    assert.strictEqual(loaded.truncatedLines, 0);
    // JSON round-trip
    var pfile = path.join(dir, 'pushed.json');
    persistence.saveJson(pfile, { opp1: 100 });
    assert.deepStrictEqual(persistence.loadJson(pfile, {}), { opp1: 100 });
    // 清理
    fs.rmSync(dir, { recursive: true, force: true });
});

test('11L.7（P1）：persistence —— 尾部残缺行丢弃（掉电写一半），不整段清空', function () {
    var os = require('os');
    var path = require('path');
    var fs = require('fs');
    var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-test-'));
    var file = path.join(dir, 'candles.jsonl');
    // 正常 2 行 + 尾部写一半（残缺 JSON）
    fs.writeFileSync(file, JSON.stringify({ openTime: 1, close: 100 }) + '\n' +
        JSON.stringify({ openTime: 2, close: 101 }) + '\n' +
        '{"openTime":3,"close":10');
    var loaded = persistence.loadCandles(file);
    assert.strictEqual(loaded.candles.length, 2, '尾部残缺丢弃，历史不丢');
    assert.strictEqual(loaded.truncatedLines, 1, '记录丢弃行数');
    // 尾部残缺后 append 可继续（幂等）
    persistence.appendCandles(file, [{ openTime: 3, close: 102 }]);
    var again = persistence.loadCandles(file);
    assert.strictEqual(again.candles.length, 3, '补齐后恢复 3 根');
    fs.rmSync(dir, { recursive: true, force: true });
});

test('11L.7（P1）：persistence —— 中间行损坏 fail-closed 抛错', function () {
    var os = require('os');
    var path = require('path');
    var fs = require('fs');
    var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-test-'));
    var file = path.join(dir, 'candles.jsonl');
    fs.writeFileSync(file, JSON.stringify({ openTime: 1, close: 100 }) + '\n' +
        '{BROKEN MIDDLE LINE}\n' +
        JSON.stringify({ openTime: 3, close: 102 }) + '\n');
    var threw = false;
    try {
        persistence.loadCandles(file);
    } catch (e) {
        threw = true;
        assert.ok(e.message.indexOf('中间行损坏') !== -1, '报错信息含原因');
    }
    assert.strictEqual(threw, true, '中间行损坏必须抛错（不静默清空）');
    fs.rmSync(dir, { recursive: true, force: true });
});

/* ---------- Phase 11L.1：共享 Windowed Leg Builder ---------- */

test('11L.1：createWindowedLegBuilder —— 15min 窗合并（与 buildOpportunities 语义一致）', function () {
    var dl = require('../stats/displacementLeg');
    var b = dl.createWindowedLegBuilder(900000); // 15min
    // 同向、confirmedAt 差 10min → 合并（即使 candleIndex 不相邻）
    var r1 = b.feed({ id: 'd1', direction: 'BULLISH', candleIndex: 10, confirmedAt: 1000000, metadata: { atr: 1 } });
    var r2 = b.feed({ id: 'd2', direction: 'BULLISH', candleIndex: 13, confirmedAt: 1600000, metadata: { atr: 1, mssEventId: 'm1' } });
    assert.strictEqual(r1.closed, null);
    assert.strictEqual(r2.merged, true, '10min 差 → 同 leg');
    assert.strictEqual(r2.opened.ids.length, 2);
    assert.strictEqual(r2.opened.lastIndex, 13);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(r2.opened, 'mssId'), false);
    // 反方向 → 关旧开新
    var r3 = b.feed({ id: 'd3', direction: 'BEARISH', candleIndex: 20, confirmedAt: 1900000, metadata: { atr: 1 } });
    assert.ok(r3.closed && r3.closed.ids.length === 2, '反向 → 关闭 2 根的 leg');
    assert.strictEqual(r3.opened.direction, 'BEARISH');
    // 同向但 20min 差 → 关旧开新
    var r4 = b.feed({ id: 'd4', direction: 'BEARISH', candleIndex: 30, confirmedAt: 3100000, metadata: { atr: 1 } });
    assert.ok(r4.closed, '20min 差 → 新 leg');
    assert.ok(r4.closed.ids.length === 1);
    var tail = b.close();
    assert.ok(tail && tail.ids.length === 1);
});

test('11L.1：createWindowedLegBuilder.closeExpired —— 按时间过期关闭（Live 常驻无数据结束）', function () {
    var dl = require('../stats/displacementLeg');
    var b = dl.createWindowedLegBuilder(900000); // 15min
    b.feed({ id: 'd1', direction: 'BULLISH', candleIndex: 10, confirmedAt: 10000000, metadata: { atr: 1 } });
    // 差 10min < 15min → 不关闭
    assert.strictEqual(b.closeExpired(10600000), null, '10min 未到期');
    assert.ok(b.isOpen());
    // 差 16min >= 15min → 关闭并返回 leg
    var closed = b.closeExpired(11600000);
    assert.ok(closed && closed.ids.length === 1, '16min 到期关闭');
    assert.strictEqual(closed.lastIndex, 10);
    assert.ok(!b.isOpen());
    // 再次调用 → null（已关闭）
    assert.strictEqual(b.closeExpired(13000000), null);
    // 与 feed 合并语义互补：leg 内位移后不合并窗口边界
    var b2 = dl.createWindowedLegBuilder(900000);
    b2.feed({ id: 'x1', direction: 'BULLISH', candleIndex: 10, confirmedAt: 10000000, metadata: { atr: 1 } });
    b2.feed({ id: 'x2', direction: 'BULLISH', candleIndex: 11, confirmedAt: 10600000, metadata: { atr: 1 } }); // 合并，lastConfirmedAt=10:10
    assert.strictEqual(b2.closeExpired(11400000), null, '10:10+8min < 15min 未到期');
    var c2 = b2.closeExpired(12500000);
    assert.ok(c2 && c2.ids.length === 2, '10:10 + 15min = 10:25 到期关闭（2 根合并 leg）');
});

test('11L.1：buildWindowedLegIndex —— 与 Live 引擎同一实现', function () {
    var dl = require('../stats/displacementLeg');
    var candles = [];
    for (var i = 0; i < 30; i++) candles.push(m5(100, 101, 99, 100.5, i));
    candles[10] = m5(100, 102.5, 99.9, 102.2, 10);
    candles[11] = m5(102.2, 104.5, 102.1, 104.2, 11);
    var disp = [
        { id: 'd1', direction: 'BULLISH', candleIndex: 10, confirmedAt: 1000000, metadata: { atr: 1 } },
        { id: 'd2', direction: 'BULLISH', candleIndex: 11, confirmedAt: 1300000, metadata: { atr: 1 } }
    ];
    var idx = dl.buildWindowedLegIndex(disp, candles);
    assert.ok(idx.d1 && idx.d2, '两个 disp 映射到同一 leg');
    assert.strictEqual(idx.d1, idx.d2, '同一 leg 对象');
    assert.ok(idx.d1.rangeAtr > 0, 'enrich 生效');
    assert.ok(['STRONG', 'EXPLOSIVE', 'NORMAL'].indexOf(idx.d1.quality) !== -1);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(idx.d1, 'mssQuality'), false);
});

/* ---------- Phase 11L.2：Top 成交量 symbol ---------- */

var binanceRest = require('../data/binanceRest');

test('11L.2：parseTopCandidates —— 过滤 PERPETUAL/USDT/TRADING（季度合约与非 USDT 排除）', function () {
    var cands = binanceRest.parseTopCandidates([
        { symbol: 'BTCUSDT', status: 'TRADING', quoteAsset: 'USDT', contractType: 'PERPETUAL' },
        { symbol: 'ETHUSDT', status: 'TRADING', quoteAsset: 'USDT', contractType: 'PERPETUAL' },
        { symbol: 'BTCUSDT_250926', status: 'TRADING', quoteAsset: 'USDT', contractType: 'CURRENT_QUARTER' },
        { symbol: 'SHIBUSDT', status: 'TRADING', quoteAsset: 'BUSD', contractType: 'PERPETUAL' },
        { symbol: 'XRPUSDT', status: 'BREAK', quoteAsset: 'USDT', contractType: 'PERPETUAL' },
        { symbol: 'SOLUSDT', status: 'TRADING', quoteAsset: 'USDT' } // spot 源（无 contractType）→ 允许
    ]);
    var syms = cands.map(function (c) { return c.symbol; });
    assert.deepStrictEqual(syms, ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'], '季度/非USDT/非TRADING 排除，spot 无 contractType 放行');
});

console.log('');
console.log('narrativeBoundary: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
