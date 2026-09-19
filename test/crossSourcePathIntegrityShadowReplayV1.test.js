'use strict';

// CROSS_SOURCE_PATH_INTEGRITY_V1 shadow replay - deterministic unit coverage.
//
// Covers §1 (window arithmetic + completeness gate + network/offline separation) and §7
// (PATH_UNKNOWN fail-closed classification) of the shadow-replay brief, plus two regression
// guards for bugs that produced a silent REPLAY_INVALID on real data:
//
//   R1  `windowBarsExpected` divided `(delta + 1)` by BAR_MS, under-counting the window by one
//       bar and failing every symbol with WINDOW_INCOMPLETE.
//   R2  the fetch start was computed as `window.startTime - warmupBars * BAR_MS`, which lands
//       1 ms off the openTime grid and silently loses the OLDEST warmup bar -> WARMUP_INSUFFICIENT.
//
// No network, no LLM, no production state.

var assert = require('assert');
var path = require('path');

var series = require('../research/cross-source-path-integrity-shadow-replay-v1/lib/seriesIntegrityV1');
var offlineReplay = require('../research/cross-source-path-integrity-shadow-replay-v1/lib/offlineReplayV1');
var entry = require('../scripts/research/crossSourcePathIntegrityShadowReplayV1');

var BAR_MS = series.BAR_MS;
var WARMUP = 1500;

var passed = 0, failed = 0;
function check(name, fn) {
    try { fn(); passed += 1; console.log('PASS  ' + name); }
    catch (error) { failed += 1; console.log('FAIL  ' + name + '\n      ' + error.message); }
}
function throwsWith(fn, token) {
    try { fn(); } catch (error) {
        assert.ok(String(error.message).indexOf(token) >= 0,
            'expected "' + token + '" in "' + error.message + '"');
        return;
    }
    assert.fail('expected a throw containing ' + token);
}

// ---------------------------------------------------------------- fixtures

/** A complete, grid-aligned 5m futures series covering the window plus `warmupBars` before it. */
function syntheticSeries(endTime, days, warmupBars, source) {
    var win = series.windowFor(endTime, days);
    var start = series.fetchStartFor(win, warmupBars);
    var out = [];
    for (var t = start; t <= win.endTime - (BAR_MS - 1); t += BAR_MS) {
        out.push({ openTime: t, closeTime: t + BAR_MS - 1, open: 100, high: 101, low: 99,
            close: 100, source: source || 'futures' });
    }
    return { window: win, candles: out };
}

/** A minimal but valid Two-Bar candidate: BULLISH over bars 3 and 4, extreme on K1. */
function bullishCandidate(candles, index) {
    var k1 = candles[index - 1];
    var k2 = candles[index];
    k1 = { openTime: k1.openTime, closeTime: k1.closeTime, open: 100, high: 101, low: 100, close: 100 };
    k2 = { openTime: k2.openTime, closeTime: k2.closeTime, open: 100, high: 101, low: 100, close: 100 };
    return { symbol: 'TESTUSDT', direction: 'BULLISH', endIndex: index, windowBars: [k1, k2] };
}

/** A Dynamic-D reference point shaped like the detector's output. */
function anchorPoint(spec) {
    return { id: spec.id, processId: 'P', pointSide: spec.side || 'LOW', price: spec.price,
        occurredAt: spec.occurredAt, confirmedAt: spec.confirmedAt,
        occurredBarIndex: spec.occurredBarIndex, state: 'ACTIVE',
        inactivatedAt: null, inactivatedBy: null,
        localizedExtremePrice: spec.price, localizationMode: 'SAME_PROCESS_WICK_V1' };
}

/** A pipeline-arm stand-in exposing only what the replay reads. */
function stubArm(points) {
    var state = { symbol: 'TESTUSDT', timeframe: '5m', recentSurvivalPoints: points };
    return { dynamicDState: function () { return state; } };
}

var SYMBOL_RULES = { symbol: 'TESTUSDT', source: 'futures', tickSize: 0.01, stepSize: 0.001,
    minQty: 0.001, minNotional: 5 };

// ---------------------------------------------------------- §1 window math

check('windowFor(2 days) yields 576 five-minute bars ending at endTime', function () {
    var end = series.lastClosedBarCloseTime(1789803599999);
    var win = series.windowFor(end, 2);
    assert.strictEqual(win.bars, 576);
    assert.strictEqual(win.startTime, end - 575 * BAR_MS);
    assert.strictEqual(win.endTime % BAR_MS, BAR_MS - 1, 'endTime must be a closeTime');
});

check('R1: windowBarsExpected counts the window inclusively at both ends (576, not 575)', function () {
    var end = series.lastClosedBarCloseTime(1789803599999);
    var win = series.windowFor(end, 2);
    assert.strictEqual(Math.round((win.endTime - win.startTime) / BAR_MS) + 1, 576);
    var s = syntheticSeries(end, 2, WARMUP);
    var q = series.verifySeries(s.candles, s.window, WARMUP);
    assert.strictEqual(q.windowBarsExpected, 576, 'off-by-one regression');
    assert.strictEqual(q.windowBars, 576);
});

check('R2: fetchStartFor lands exactly warmupBars before the window, on the openTime grid', function () {
    var end = series.lastClosedBarCloseTime(1789803599999);
    var win = series.windowFor(end, 2);
    var start = series.fetchStartFor(win, WARMUP);
    assert.strictEqual(start % BAR_MS, 0, 'fetch start must be an openTime');
    var firstWindowBarOpenTime = win.startTime - (BAR_MS - 1);
    assert.strictEqual((firstWindowBarOpenTime - start) / BAR_MS, WARMUP,
        'must hand back exactly warmupBars closed bars, not warmupBars - 1');
    var s = syntheticSeries(end, 2, WARMUP);
    assert.strictEqual(s.candles.length, WARMUP + 576);
});

// ------------------------------------------------- §1 completeness gate

check('verifySeries PASSes a complete, contiguous, futures-only series with full warmup', function () {
    var s = syntheticSeries(series.lastClosedBarCloseTime(1789803599999), 2, WARMUP);
    var q = series.verifySeries(s.candles, s.window, WARMUP);
    assert.strictEqual(q.PASS, true, 'reason=' + q.reason);
    assert.strictEqual(q.warmupBars, WARMUP);
    assert.strictEqual(q.futuresBars, s.candles.length);
});

check('verifySeries fails closed on a single missing bar', function () {
    var s = syntheticSeries(series.lastClosedBarCloseTime(1789803599999), 2, WARMUP);
    s.candles.splice(1000, 1);
    var q = series.verifySeries(s.candles, s.window, WARMUP);
    assert.strictEqual(q.PASS, false);
    assert.strictEqual(q.reason, 'SERIES_GAP');
});

check('verifySeries rejects any non-futures bar (spot mirror never masquerades)', function () {
    var s = syntheticSeries(series.lastClosedBarCloseTime(1789803599999), 2, WARMUP);
    s.candles[500].source = 'spot-mirror';          // inside warmup
    s.candles[s.candles.length - 1].source = 'spot-fill'; // inside window
    var q = series.verifySeries(s.candles, s.window, WARMUP);
    assert.strictEqual(q.PASS, false);
    assert.strictEqual(q.reason, 'NON_FUTURES_SOURCE');
    assert.strictEqual(q.spotMirrorBars, 2);
});

check('verifySeries fails closed when the final window bar is absent', function () {
    var s = syntheticSeries(series.lastClosedBarCloseTime(1789803599999), 2, WARMUP);
    s.candles.pop();
    var q = series.verifySeries(s.candles, s.window, WARMUP);
    assert.strictEqual(q.PASS, false);
    assert.strictEqual(q.reason, 'WINDOW_INCOMPLETE');
});

check('verifySeries fails closed when warmup is one bar short (R2 guard)', function () {
    var s = syntheticSeries(series.lastClosedBarCloseTime(1789803599999), 2, WARMUP);
    s.candles.shift();
    var q = series.verifySeries(s.candles, s.window, WARMUP);
    assert.strictEqual(q.PASS, false);
    assert.strictEqual(q.reason, 'WARMUP_INSUFFICIENT');
    assert.strictEqual(q.warmupBars, WARMUP - 1);
});

// ------------------------------------------ §1 network / offline separation

check('offline replay closure contains no market-data module', function () {
    var guard = entry.armOfflineGuard();
    var leaked = guard.leaked;
    guard.release();
    assert.deepStrictEqual(leaked, [], 'leaked: ' + leaked.join(','));
    assert.ok(guard.closureSize > 0, 'closure must be resolvable');
});

check('the LLM client and its http stack are reported as INERT, not silently ignored', function () {
    var guard = entry.armOfflineGuard();
    guard.release();
    var joined = guard.inert.join(',');
    assert.ok(joined.indexOf('ai/deepseekClient') >= 0, 'LLM client must be reported');
    assert.ok(joined.indexOf('axios') >= 0, 'axios must be reported');
});

check('the offline tripwire is armed and actually fires on an http call', function () {
    var guard = entry.armOfflineGuard();
    assert.strictEqual(guard.tripwireArmed, true);
    throwsWith(function () { require('https').request({ host: 'example.invalid', path: '/' }); },
        'NETWORK_ACCESS_ATTEMPTED_DURING_OFFLINE_REPLAY');
    assert.strictEqual(guard.attempts.length, 1, 'the attempt must be counted');
    guard.release();
});

check('releasing the guard restores the http entry points', function () {
    var pristine = require('https').request;          // captured BEFORE arming
    var guard = entry.armOfflineGuard();
    assert.notStrictEqual(require('https').request, pristine, 'the guard must actually patch');
    guard.release();
    assert.strictEqual(require('https').request, pristine, 'https.request must be restored');
});

// ------------------------------------------------ §7 PATH_UNKNOWN fail-closed

check('classifyUnknown returns null for decided results (PASS / FAIL are never UNKNOWN)', function () {
    assert.strictEqual(offlineReplay.classifyUnknown({ status: 'PASS' }), null);
    assert.strictEqual(offlineReplay.classifyUnknown({ status: 'FAIL' }), null);
    assert.strictEqual(offlineReplay.classifyUnknown(null), null);
});

check('classifyUnknown reports MISSING_PROVENANCE when the rule had no provenance to work with', function () {
    var reason = offlineReplay.classifyUnknown({ status: 'UNKNOWN', anchorOccurredAt: null,
        partnerPrice: 1, twoBarExtreme: 1, k1OpenTime: 1, intermediateBarCount: 3 });
    assert.strictEqual(reason, 'MISSING_PROVENANCE');
});

check('classifyUnknown reports MISSING_INTERMEDIATE_BARS when a gap left nothing to scan', function () {
    var reason = offlineReplay.classifyUnknown({ status: 'UNKNOWN', anchorOccurredAt: 100,
        partnerPrice: 1, twoBarExtreme: 1, k1OpenTime: 200, intermediateBarCount: 0 });
    assert.strictEqual(reason, 'MISSING_INTERMEDIATE_BARS');
});

check('classifyUnknown falls back to OTHER (still fail-closed, never a pass)', function () {
    var reason = offlineReplay.classifyUnknown({ status: 'UNKNOWN', anchorOccurredAt: 100,
        partnerPrice: 1, twoBarExtreme: 1, k1OpenTime: 200, intermediateBarCount: 5 });
    assert.strictEqual(reason, 'OTHER');
});

check('hasFutureBar detects a candidate intermediate bar closing after confirmation', function () {
    var bars = [{ openTime: 100, closeTime: 150 }, { openTime: 200, closeTime: 250 }];
    assert.strictEqual(offlineReplay.hasFutureBar(bars, 50, 300, 200), true);
    assert.strictEqual(offlineReplay.hasFutureBar(bars, 50, 300, 400), false);
    assert.strictEqual(offlineReplay.hasFutureBar(bars, 300, 300, 200), false,
        'not applicable when there is no intermediate range');
});

// ------------------------------------------- §2/§3 arm invariants & the single variable

check('detached sweep: a strictly-crossed reference stays ACTIVE on the arm but is excluded', function () {
    var candles = syntheticSeries(series.lastClosedBarCloseTime(1789803599999), 2, WARMUP).candles;
    var candidate = bullishCandidate(candles, 4);
    // candidate.price = 100 (min low of K1/K2). A LOW reference ABOVE 100 is strictly crossed.
    var consumed = anchorPoint({ id: 'CONSUMED', price: 100.5, occurredAt: candles[1].openTime,
        confirmedAt: candles[1].closeTime, occurredBarIndex: 1 });
    var equal = anchorPoint({ id: 'EQUAL', price: 100, occurredAt: candles[2].openTime,
        confirmedAt: candles[2].closeTime, occurredBarIndex: 2 });
    var arm = stubArm([consumed, equal]);
    var sample = offlineReplay.evaluateCandidate(candidate, {
        symbol: 'TESTUSDT', candles: candles, currentBarIndex: 4, tolerance: 1,
        armBefore: arm, armAfter: arm, symbolRules: SYMBOL_RULES,
        contractPrice: candles[4].close, sweepMode: 'detached'
    });
    var ids = sample.evaluations.map(function (e) { return e.partnerId; });
    assert.deepStrictEqual(ids, ['EQUAL'], 'the consumed reference must not be a partner');
    assert.strictEqual(consumed.state, 'ACTIVE',
        'detached mode must not mutate the arm: a sibling candidate cannot retire a reference');
    assert.strictEqual(sample.flags.setupBefore, true);
});

check('swept ablation: the same candidate DOES mutate the shared state (switch is real)', function () {
    var candles = syntheticSeries(series.lastClosedBarCloseTime(1789803599999), 2, WARMUP).candles;
    var candidate = bullishCandidate(candles, 4);
    var consumed = anchorPoint({ id: 'CONSUMED', price: 100.5, occurredAt: candles[1].openTime,
        confirmedAt: candles[1].closeTime, occurredBarIndex: 1 });
    var equal = anchorPoint({ id: 'EQUAL', price: 100, occurredAt: candles[2].openTime,
        confirmedAt: candles[2].closeTime, occurredBarIndex: 2 });
    var arm = stubArm([consumed, equal]);
    offlineReplay.evaluateCandidate(candidate, {
        symbol: 'TESTUSDT', candles: candles, currentBarIndex: 4, tolerance: 1,
        armBefore: arm, armAfter: arm, symbolRules: SYMBOL_RULES,
        contractPrice: candles[4].close, sweepMode: 'swept'
    });
    assert.strictEqual(consumed.state, 'INACTIVE');
    assert.strictEqual(consumed.inactivatedBy, 'STRICT_CROSS');
});

check('the frozen rule is the ONLY variable: the arms must agree on the population', function () {
    var candles = syntheticSeries(series.lastClosedBarCloseTime(1789803599999), 2, WARMUP).candles;
    var candidate = bullishCandidate(candles, 4);
    var forBefore = stubArm([anchorPoint({ id: 'EQUAL', price: 100, occurredAt: candles[2].openTime,
        confirmedAt: candles[2].closeTime, occurredBarIndex: 2 })]);
    var forAfter = stubArm([]);
    throwsWith(function () {
        offlineReplay.evaluateCandidate(candidate, {
            symbol: 'TESTUSDT', candles: candles, currentBarIndex: 4, tolerance: 1,
            armBefore: forBefore, armAfter: forAfter, symbolRules: SYMBOL_RULES,
            contractPrice: candles[4].close, sweepMode: 'detached'
        });
    }, 'ARM_DIVERGENCE');
});

check('with no partner in either arm the filter cannot create a setup (SETUP_CREATED_BY_PATH_FILTER === 0)', function () {
    var candles = syntheticSeries(series.lastClosedBarCloseTime(1789803599999), 2, WARMUP).candles;
    var candidate = bullishCandidate(candles, 4);
    var empty = stubArm([]);
    var sample = offlineReplay.evaluateCandidate(candidate, {
        symbol: 'TESTUSDT', candles: candles, currentBarIndex: 4, tolerance: 1,
        armBefore: empty, armAfter: empty, symbolRules: SYMBOL_RULES,
        contractPrice: candles[4].close, sweepMode: 'detached'
    });
    assert.strictEqual(sample.flags.setupBefore, false);
    assert.strictEqual(sample.flags.setupAfter, false);
    assert.strictEqual(sample.flags.setupCreatedByPathFilter, false);
    assert.strictEqual(sample.before.reasonCode, 'NO_DYNAMIC_D_EQ_PARTNER');
    assert.strictEqual(sample.after.reasonCode, 'NO_DYNAMIC_D_EQ_PARTNER');
});

// ------------------------------------------------------- §6 anchor integrity

check('the three frozen REAL anchors are well-formed and self-consistent', function () {
    var keys = Object.keys(entry.REAL_ANCHORS);
    assert.strictEqual(keys.length, 3);
    keys.forEach(function (key) {
        var spec = entry.REAL_ANCHORS[key];
        var m = /^TWO_BAR_REVERSAL_V1:(BULLISH|BEARISH):([A-Z]+USDT):(\d+):(\d+)$/.exec(spec.twoBarId);
        assert.ok(m, 'unparseable twoBarId for ' + key);
        assert.strictEqual(m[2], spec.symbol);
        assert.strictEqual(m[1], spec.direction);
        assert.strictEqual(Number(m[4]) - Number(m[3]), 2 * BAR_MS - 1, 'K1/K2 must be adjacent bars');
        assert.ok(spec.expect && typeof spec.expect === 'object');
    });
    assert.strictEqual(entry.REAL_ANCHORS.REAL_002_BTC.expect.newPartnerPrice, 80467.5);
    assert.strictEqual(entry.REAL_ANCHORS.REAL_002_BTC.expect.newRR, 2.106212);
    assert.strictEqual(entry.REAL_ANCHORS.REAL_003_SOL.expect.setupAfter, false);
});

check('sweep modes are declared and the default is the production-faithful one', function () {
    assert.deepStrictEqual(offlineReplay.SWEEP_MODES, ['detached', 'swept']);
    assert.strictEqual(offlineReplay.stateForMatcher(stubArm([]), 'detached').recentSurvivalPoints.length, 0);
});

check('totals bookkeeping sums every count field', function () {
    var total = entry.emptyTotals();
    entry.addTotals(total, { candidatesInWindow: 3, setupRemoved: 2, planPreserved: 1, ignored: 99 });
    assert.strictEqual(total.candidatesInWindow, 3);
    assert.strictEqual(total.setupRemoved, 2);
    assert.strictEqual(total.planPreserved, 1);
    assert.strictEqual(total.ignored, undefined, 'unknown keys must not leak into the totals');
});

check('verdict is REPLAY_INVALID when nothing was measured', function () {
    assert.strictEqual(entry.classifyVerdict({ symbols: ['X'], invalidSymbols: [],
        counts: { candidatesInWindow: 0, setupCreatedByPathFilter: 0, pathUnknown: 0,
            pathPass: 0, pathReject: 0 } }), 'REPLAY_INVALID');
    assert.strictEqual(entry.classifyVerdict({ symbols: ['X'], invalidSymbols: ['X'],
        counts: { candidatesInWindow: 10, setupCreatedByPathFilter: 0, pathUnknown: 0,
            pathPass: 5, pathReject: 5 } }), 'REPLAY_INVALID');
    assert.strictEqual(entry.classifyVerdict({ symbols: ['X'], invalidSymbols: [],
        counts: { candidatesInWindow: 10, setupCreatedByPathFilter: 0, pathUnknown: 0,
            pathPass: 5, pathReject: 5 } }), 'REPLAY_OK');
    assert.strictEqual(entry.classifyVerdict({ symbols: ['X'], invalidSymbols: [],
        counts: { candidatesInWindow: 10, setupCreatedByPathFilter: 1, pathUnknown: 0,
            pathPass: 5, pathReject: 5 } }), 'REPLAY_INVALID',
        'a setup created by the filter is an implementation anomaly');
});

check('the anchor gate compares each frozen expectation field by field', function () {
    var ok = entry.evaluateAnchorGate({
        A: { label: 'A', found: true, setupBefore: true, setupAfter: true, partnerUnchanged: true,
            partnerReplaced: false, planPreserved: true, oldPartner: { price: 1 },
            newPartner: { price: 1 }, after: { ok: true, initialRR: 1.5 },
            expect: { setupBefore: true, setupAfter: true, partnerUnchanged: true,
                partnerReplaced: false, planPreserved: true, oldPartnerPrice: 1,
                newPartnerPrice: 1, newRR: 1.5 } }
    });
    assert.strictEqual(ok.PASS, true);
    assert.strictEqual(ok.anchors[0].checks.length, 8, 'every declared field must be compared');

    var bad = entry.evaluateAnchorGate({
        A: { label: 'A', found: true, setupBefore: false, setupAfter: false, partnerUnchanged: false,
            partnerReplaced: false, planPreserved: false, oldPartner: { price: 1 },
            newPartner: null, after: { ok: false },
            expect: { setupBefore: true, setupAfter: false, oldPartnerPrice: 1 } }
    });
    assert.strictEqual(bad.PASS, false);
    assert.strictEqual(bad.anchors[0].checks.filter(function (c) { return !c.ok; }).length, 1);

    var missing = entry.evaluateAnchorGate({
        A: { label: 'A', found: false, expect: { setupBefore: true } }
    });
    assert.strictEqual(missing.PASS, false, 'a missing anchor must fail the gate, never pass quietly');
});

check('the semantic digest is insensitive to timing but sensitive to content', function () {
    var base = entry.emptyTotals();
    base.candidatesInWindow = 5;
    var summary = { window: { startTime: 0, endTime: 1 }, symbols: ['X'], sweepMode: { mode: 'detached' },
        counts: base, invalidSymbols: [], unknownReasons: {}, unknownDetail: [],
        replacements: [], removals: [], realAnchors: {}, anchorGate: { PASS: true },
        offlineGuard: { networkCallAttempts: 0 }, frozenRules: {}, verdict: 'REPLAY_OK' };
    var perSymbol = [{ symbol: 'X', counts: base, unknownReasons: {}, quality: {}, elapsedMs: 1 }];
    var d1 = entry.semanticDigest(summary, perSymbol);
    perSymbol[0].elapsedMs = 999999;
    assert.strictEqual(entry.semanticDigest(summary, perSymbol), d1, 'timing must not affect the digest');
    summary.counts = JSON.parse(JSON.stringify(base));
    summary.counts.candidatesInWindow = 6;
    assert.notStrictEqual(entry.semanticDigest(summary, perSymbol), d1,
        'a real content change must change the digest');
});

console.log('');
console.log('CHECKS PASSED: ' + passed);
console.log('CHECKS FAILED: ' + failed);
console.log('CROSS_SOURCE_PATH_INTEGRITY_SHADOW_REPLAY_V1=' + (failed === 0 ? 'PASS' : 'FAIL'));
if (failed) process.exitCode = 1;
