'use strict';

/**
 * TURNING_FACTS_TESTS — HISTORICAL_TURNING_POINT_SIGNIFICANCE_FACTS_V1 (spec §65).
 *
 * Cases A-K plus the FUTURE_LEAK and null/0 separation gates.
 */

var assert = require('assert');
var fixtures = require('./fixtures/turningPointSignificanceV1');
var factsMod = require('../semantic/turningPointSignificanceFactsV1');

var passed = 0;
function check(name, fn) {
    fn();
    passed += 1;
    console.log('PASS ' + name);
}
function close(actual, expected, tolerance, label) {
    assert.ok(Math.abs(actual - expected) <= (tolerance === undefined ? 1e-6 : tolerance),
        label + ' expected ' + expected + ' got ' + actual);
}

// ---- shared series: rising 0..20 (+10/bar) then falling 21..25 (-20/bar) ----
var HIGH_CLOSES = fixtures.highTurningSeries({ up: 20, down: 5, start: 1000, step: 10 });
var HIGH_CANDLES = fixtures.buildSeries(HIGH_CLOSES, { pad: 5, step: 10 });
var HIGH_CANDIDATE = fixtures.makeCandidate(HIGH_CANDLES, {
    side: 'HIGH', selectorIndex: 20, localizedIndex: 20, confirmationIndex: 25, processStartIndex: 0
});
var HIGH_FACTS = factsMod.buildCanonicalFacts({ candidate: HIGH_CANDIDATE, candles: HIGH_CANDLES });

// Wilder ATR14 with constant true range |step| + 2*pad = 20.
var ATR = 20;

check('A. HIGH incoming directional move is positive', function () {
    // selectorClose 1200 - processStartClose 1000
    assert.strictEqual(HIGH_FACTS.incomingProcess.moveAtr, 200 / ATR);
    assert.ok(HIGH_FACTS.incomingProcess.moveAtr > 0);
});

check('B. LOW incoming directional move is positive', function () {
    var closes = fixtures.lowTurningSeries({ up: 20, down: 5, start: 1000, step: 10 });
    var candles = fixtures.buildSeries(closes, { pad: 5, step: 10 });
    var candidate = fixtures.makeCandidate(candles, {
        side: 'LOW', selectorIndex: 20, localizedIndex: 20, confirmationIndex: 25, processStartIndex: 0
    });
    var facts = factsMod.buildCanonicalFacts({ candidate: candidate, candles: candles });
    // processStartClose 3000 - selectorClose 2800
    assert.strictEqual(facts.incomingProcess.moveAtr, 200 / ATR);
    assert.ok(facts.incomingProcess.moveAtr > 0);
});

check('C. HIGH reversal move sign and magnitude', function () {
    // selectorClose 1200 - confirmationClose 1100
    assert.strictEqual(HIGH_FACTS.reversalProcess.closeMoveAtr, 100 / ATR);
});

check('D. LOW reversal move sign and magnitude', function () {
    var closes = fixtures.lowTurningSeries({ up: 20, down: 5, start: 1000, step: 10 });
    var candles = fixtures.buildSeries(closes, { pad: 5, step: 10 });
    var candidate = fixtures.makeCandidate(candles, {
        side: 'LOW', selectorIndex: 20, localizedIndex: 20, confirmationIndex: 25, processStartIndex: 0
    });
    var facts = factsMod.buildCanonicalFacts({ candidate: candidate, candles: candles });
    // confirmationClose 2900 - selectorClose 2800
    assert.strictEqual(facts.reversalProcess.closeMoveAtr, 100 / ATR);
});

check('C2. HIGH reversal excursion uses the localized wick', function () {
    // localized high 1205 - min low over [20..25] 1095 = 110
    assert.strictEqual(HIGH_FACTS.reversalProcess.excursionAtr, 110 / ATR);
});

check('D2. LOW reversal excursion uses the localized wick', function () {
    var closes = fixtures.lowTurningSeries({ up: 20, down: 5, start: 1000, step: 10 });
    var candles = fixtures.buildSeries(closes, { pad: 5, step: 10 });
    var candidate = fixtures.makeCandidate(candles, {
        side: 'LOW', selectorIndex: 20, localizedIndex: 20, confirmationIndex: 25, processStartIndex: 0
    });
    var facts = factsMod.buildCanonicalFacts({ candidate: candidate, candles: candles });
    // max high over [20..25] 2905 - localized low 2795 = 110
    assert.strictEqual(facts.reversalProcess.excursionAtr, 110 / ATR);
});

check('E. efficiency is within [0,1] and exact for a monotone path', function () {
    assert.strictEqual(HIGH_FACTS.incomingProcess.efficiency, 1);
    assert.strictEqual(HIGH_FACTS.reversalProcess.efficiency, 1);
    [HIGH_FACTS.incomingProcess.efficiency, HIGH_FACTS.reversalProcess.efficiency].forEach(function (value) {
        assert.ok(value >= 0 && value <= 1, 'efficiency out of range: ' + value);
    });
});

check('E2. zero path length yields 0, not null', function () {
    var candles = fixtures.buildSeries([1000, 1000, 1000, 1000], { pad: 5, step: 0 });
    var candidate = fixtures.makeCandidate(candles, {
        side: 'HIGH', selectorIndex: 2, localizedIndex: 2, confirmationIndex: 3, processStartIndex: 0
    });
    var facts = factsMod.buildCanonicalFacts({ candidate: candidate, candles: candles });
    assert.strictEqual(facts.incomingProcess.efficiency, 0);
    assert.notStrictEqual(facts.incomingProcess.efficiency, null);
});

check('F. speed = ATR-normalized move / durationBars', function () {
    assert.strictEqual(HIGH_FACTS.incomingProcess.durationBars, 21);   // 20 - 0 + 1
    assert.strictEqual(HIGH_FACTS.reversalProcess.durationBars, 6);    // 25 - 20 + 1
    assert.strictEqual(HIGH_FACTS.incomingProcess.speedAtrPerBar,
        Math.round((200 / ATR) / 21 * 1e6) / 1e6);
    assert.strictEqual(HIGH_FACTS.reversalProcess.speedAtrPerBar,
        Math.round((100 / ATR) / 6 * 1e6) / 1e6);
});

check('G. ATR normalization uses the SELECTOR ATR, not a later ATR', function () {
    // Deep pre-extreme low so the selector bar and the confirmation bar differ.
    var candles = fixtures.buildSeries(HIGH_CLOSES, { pad: 5, step: 10, lowOverrides: { 10: 800 } });
    var candidate = fixtures.makeCandidate(candles, {
        side: 'HIGH', selectorIndex: 20, localizedIndex: 20, confirmationIndex: 25, processStartIndex: 0
    });
    var facts = factsMod.buildCanonicalFacts({ candidate: candidate, candles: candles });
    var selectorAtr = factsMod.wilderAtr14At(candles, 20);
    var laterAtr = factsMod.wilderAtr14At(candles, 25);
    assert.ok(Math.abs(selectorAtr - laterAtr) > 0.5, 'fixture must make the two ATRs differ');
    close(facts.volatility.atr14AtSelector, selectorAtr, 1e-6, 'atr14AtSelector');
    assert.notStrictEqual(facts.volatility.atr14AtSelector, Math.round(laterAtr * 1e6) / 1e6);
    close(facts.reversalProcess.closeMoveAtr, 100 / selectorAtr, 1e-5, 'reversal normalized by selector ATR');
});

check('G2. Wilder ATR14 matches the production seed/smoothing convention', function () {
    // 15 bars of constant TR=20 -> published ATR at index 14 is exactly 20.
    var candles = fixtures.buildSeries([1000, 1010, 1020, 1030, 1040, 1050, 1060, 1070,
        1080, 1090, 1100, 1110, 1120, 1130, 1140], { pad: 5, step: 10 });
    assert.strictEqual(factsMod.wilderAtr14At(candles, 14), 20);
    // Before the seed exists the ATR is unavailable, not zero.
    assert.strictEqual(factsMod.wilderAtr14At(candles, 13), null);
});

check('H. same-process wick price is preserved from the frozen candidate', function () {
    assert.strictEqual(HIGH_FACTS.turningPoint.localizedExtremePrice, 1205);
    assert.strictEqual(HIGH_FACTS.turningPoint.selectorClose, 1200);
    assert.notStrictEqual(HIGH_FACTS.turningPoint.localizedExtremePrice,
        HIGH_FACTS.turningPoint.selectorClose);
});

check('I. localized extreme != selector still yields correct window and excursion', function () {
    var candles = fixtures.buildSeries(HIGH_CLOSES, { pad: 5, step: 10, highOverrides: { 17: 1300 } });
    var candidate = fixtures.makeCandidate(candles, {
        side: 'HIGH', selectorIndex: 20, localizedIndex: 17, confirmationIndex: 25,
        processStartIndex: 0, localizedExtremePrice: 1300
    });
    var facts = factsMod.buildCanonicalFacts({ candidate: candidate, candles: candles });
    assert.strictEqual(facts.turningPoint.localizedExtremePrice, 1300);
    assert.strictEqual(facts.turningPoint.selectorClose, 1200);
    // The excursion window starts at the LOCALIZED extreme (index 17), so the
    // deep low at index 10 must not participate: 1300 - 1095 = 205.
    close(facts.reversalProcess.excursionAtr * facts.volatility.atr14AtSelector, 205, 1e-4,
        'excursion raw value');
});

check('J. unavailable facts are null, never 0', function () {
    // selectorIndex < 14 -> no published Wilder ATR yet.
    var candles = fixtures.buildSeries([1000, 1010, 1020, 1030, 1040, 1050, 1060], { pad: 5, step: 10 });
    var candidate = fixtures.makeCandidate(candles, {
        side: 'HIGH', selectorIndex: 5, localizedIndex: 5, confirmationIndex: 6, processStartIndex: 0
    });
    var facts = factsMod.buildCanonicalFacts({ candidate: candidate, candles: candles });
    assert.strictEqual(facts.volatility.atr14AtSelector, null);
    assert.strictEqual(facts.volatility.atr14PctPrice, null);
    assert.strictEqual(facts.incomingProcess.moveAtr, null);
    assert.strictEqual(facts.incomingProcess.speedAtrPerBar, null);
    assert.strictEqual(facts.reversalProcess.closeMoveAtr, null);
    assert.strictEqual(facts.reversalProcess.excursionAtr, null);
    assert.strictEqual(facts.reversalProcess.speedAtrPerBar, null);
    // A genuinely zero count stays 0; the two must remain distinguishable.
    assert.strictEqual(facts.displacement.sameDirectionCount, 0);
    assert.strictEqual(facts.displacement.firstSameDirectionAt, null);
    assert.strictEqual(facts.displacement.strongestSameDirectionScore, null);
    assert.strictEqual(facts.displacement.strongestOppositeDirectionScore, null);
    assert.strictEqual(facts.pivots.pivotRoleAtConfirmation, null);
});

check('J2. missing sigma/theta remain null rather than fabricated', function () {
    var candidate = Object.assign({}, HIGH_CANDIDATE, {
        sigma1hAtExtreme: null, thetaAtExtreme: null
    });
    var facts = factsMod.buildCanonicalFacts({ candidate: candidate, candles: HIGH_CANDLES });
    assert.strictEqual(facts.volatility.sigma1hAtSelector, null);
    assert.strictEqual(facts.volatility.thetaAtExtreme, null);
});

check('K. every fact timestamp is at or before candidate.confirmedAt', function () {
    var cutoff = HIGH_CANDIDATE.confirmedAt;
    var times = [];
    (function walk(value, key) {
        if (value && typeof value === 'object') {
            Object.keys(value).forEach(function (child) { walk(value[child], child); });
        } else if (typeof value === 'string' && /(At|Time)$/.test(key) && /^\d{4}-/.test(value)) {
            times.push(Date.parse(value));
        }
    })(HIGH_FACTS, '');
    assert.ok(times.length > 0, 'fixture must expose timestamps');
    times.forEach(function (time) { assert.ok(time <= cutoff, 'future timestamp ' + new Date(time).toISOString()); });
    assert.strictEqual(factsMod.validate(HIGH_FACTS).semanticTask,
        'HISTORICAL_TURNING_POINT_SIGNIFICANCE_V1');
});

check('K2. FUTURE_LEAK is rejected, not silently tolerated', function () {
    var future = JSON.parse(JSON.stringify(HIGH_FACTS));
    future.structure.oppositeStructureBreakConfirmedAt = '2027-01-01T00:00:00.000Z';
    assert.throws(function () { factsMod.validate(future); },
        function (error) { return error.code === 'TURNING_SIGNIFICANCE_FACT_AFTER_CONFIRMED_AT'; });
});

check('L. candidate/candle misalignment fails closed', function () {
    var wrong = Object.assign({}, HIGH_CANDIDATE, { selectorPrice: 1 });
    assert.throws(function () { factsMod.buildCanonicalFacts({ candidate: wrong, candles: HIGH_CANDLES }); },
        function (error) { return error.code === 'TURNING_SIGNIFICANCE_CANDLE_ALIGNMENT_INVALID'; });
});

check('M. displacement window is (selector, confirmedAt] and direction-aware', function () {
    var rows = [
        { id: 'D0', direction: 'BULLISH', confirmedAt: HIGH_CANDLES[20].closeTime },      // at selector: excluded
        { id: 'D1', direction: 'BULLISH', confirmedAt: HIGH_CANDLES[21].closeTime },
        { id: 'D2', direction: 'BEARISH', confirmedAt: HIGH_CANDLES[22].closeTime },
        { id: 'D3', direction: 'BEARISH', confirmedAt: HIGH_CANDLES[25].closeTime },
        { id: 'D4', direction: 'BEARISH', confirmedAt: HIGH_CANDLES[25].closeTime + 300000 } // future: excluded
    ];
    var facts = factsMod.buildCanonicalFacts({
        candidate: HIGH_CANDIDATE, candles: HIGH_CANDLES, displacements: rows
    });
    assert.strictEqual(facts.displacement.sameDirectionCount, 1);
    assert.strictEqual(facts.displacement.oppositeDirectionCount, 2);
    assert.strictEqual(facts.displacement.firstSameDirectionAt,
        new Date(HIGH_CANDLES[21].closeTime).toISOString());
    assert.strictEqual(facts.displacement.firstOppositeDirectionAt,
        new Date(HIGH_CANDLES[22].closeTime).toISOString());
});

check('N. structural facts come from a prefix-only replay', function () {
    var empty = factsMod.buildCanonicalFacts({ candidate: HIGH_CANDIDATE, candles: HIGH_CANDLES });
    assert.strictEqual(empty.pivots.extremeIsCausalPivot, false);
    assert.strictEqual(empty.pivots.pivotRoleAtConfirmation, null);
    assert.strictEqual(empty.structure.oppositeStructureBreakOccurred, false);
    assert.strictEqual(empty.structure.oppositeStructureBreakConfirmedAt, null);
    assert.strictEqual(empty.structure.sameDirectionContinuationObservedBeforeConfirmation, false);
    assert.ok(empty.pivots.prePivotHighCount >= 0 && empty.pivots.turnPivotHighCount >= 0);
});

check('O. canonical serialization is stable and finite-only', function () {
    var semantic = require('../semantic/turningPointSignificanceSemanticV1');
    var a = semantic.stableSerialize(HIGH_FACTS);
    var b = semantic.stableSerialize(JSON.parse(JSON.stringify(HIGH_FACTS)));
    assert.strictEqual(a, b);
    assert.throws(function () { semantic.stableSerialize({ x: NaN }); },
        function (error) { return error.code === 'TURNING_SIGNIFICANCE_CANONICAL_NON_FINITE'; });
    assert.throws(function () { semantic.stableSerialize({ x: undefined }); },
        function (error) { return error.code === 'TURNING_SIGNIFICANCE_CANONICAL_UNDEFINED'; });
});

console.log('\nTURNING_FACTS_TESTS=PASS (' + passed + ' checks)');
