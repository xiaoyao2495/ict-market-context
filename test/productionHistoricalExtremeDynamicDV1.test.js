'use strict';

/**
 * PRODUCTION_HISTORICAL_EXTREME_CC_DYNAMIC_D_V1 — targeted test suite.
 *
 * Covers spec §28-§32 contract for the Causal Dynamic D historical-anchor
 * replacement (liquidity/causalDynamicDHistoricalExtremes.js) and its wiring
 * into productionEqualLiquidityV1.js:
 *
 *   A. CC detection (port of benchmarked research CC arm; params FROZEN)
 *   B. SELECTOR_PRICE (close) != BUSINESS_PRICE (wick) invariant
 *   C. ACTIVE -> INACTIVE terminal lifecycle (age expiry / ordinary 2/2 strict
 *      cross), STRICT_INVALIDATION priority, AGE_EXPIRY_PRECEDES_EQ,
 *      NO RETROACTIVE REWRITE
 *   D. Integration through producer.step / replayState / provenance
 *   E. Causality & future-leak guards
 */

var assert = require('assert');
var dynamicD = require('../liquidity/causalDynamicDHistoricalExtremes');
var producer = require('../liquidity/productionEqualLiquidityV1');
var provenance = require('../liquidity/productionEqProvenance');
var replayState = require('../replay/replayState');

var BAR = 300000; // 5m in ms
var FIVE_DAYS_MS = dynamicD.FIVE_DAYS_MS;

var passed = 0, failed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log('PASS  ' + name); }
    catch (error) { failed++; console.log('FAIL  ' + name + ' -> ' + error.stack); }
}

function candle(i, open, high, low, close, closed) {
    return {
        openTime: i * BAR,
        closeTime: i * BAR + BAR - 1,
        open: open, high: high, low: low, close: close,
        closed: closed === undefined ? true : closed
    };
}
// Default envelope: wick = close +/- 1 so price (wick) != selectorPrice (close).
function c(i, close) { return candle(i, close, close + 1, close - 1, close); }

// ---- A. Detection --------------------------------------------------------

test('A1 createState exposes expected fields and empty survival list', function () {
    var s = dynamicD.createState({ symbol: 'BTCUSDT', timeframe: '5m' });
    assert.strictEqual(s.version, dynamicD.VERSION);
    assert.strictEqual(s.initialized, false);
    assert.strictEqual(s.direction, null);
    assert.strictEqual(s.recentSurvivalPoints.length, 0);
    assert.strictEqual(s.confirmedPoints.length, 0);
    assert.strictEqual(s.lastIndex, -1);
});

test('A2 raw (unclosed) candle yields no points and does not advance index', function () {
    var s = dynamicD.createState({});
    var out = dynamicD.step(s, candle(0, 100, 101, 99, 100, false), 0, [candle(0, 100, 101, 99, 100, false)]);
    assert.strictEqual(out.dynamicDPoints.length, 0);
    assert.strictEqual(s.lastIndex, -1);
});

test('A3 non-sequential index throws', function () {
    var s = dynamicD.createState({});
    dynamicD.step(s, c(0, 100), 0, [c(0, 100)]);
    assert.throws(function () { dynamicD.step(s, c(5, 100), 5, [c(5, 100)]); });
});

test('A4 volatility not ready before 288 returns: seed set, no reversal events', function () {
    var s = dynamicD.createState({});
    var out = [];
    for (var i = 0; i < 200; i++) {
        out = dynamicD.step(s, c(i, 100), i, []);
    }
    assert.strictEqual(s.volatilityReady, false);
    assert.strictEqual(s.recentSurvivalPoints.length, 0);
    assert.strictEqual(out.dynamicDPoints.length, 0);
});

test('A5 single peak after warmup emits exactly one HIGH detection', function () {
    var s = dynamicD.createState({});
    var candles = [];
    for (var i = 0; i < 289; i++) candles.push(c(i, 100));
    candles.push(c(289, 110));   // new UP extreme
    candles.push(c(290, 100));   // reversal confirms HIGH (clear drop >= theta)
    var points = [];
    for (var j = 0; j < candles.length; j++) {
        var r = dynamicD.step(s, candles[j], j, candles);
        points = points.concat(r.dynamicDPoints);
    }
    assert.strictEqual(points.length, 1);
    assert.strictEqual(points[0].pointSide, 'HIGH');
    assert.strictEqual(points[0].occurredBarIndex, 289);
    assert.strictEqual(points[0].confirmationBarIndex, 290);
});

test('A6 single trough after warmup emits exactly one LOW detection', function () {
    var s = dynamicD.createState({});
    var candles = [];
    for (var i = 0; i < 289; i++) candles.push(c(i, 100));
    candles.push(c(289, 90));   // new DOWN extreme
    candles.push(c(290, 100));  // reversal confirms LOW (clear rebound >= theta)
    var points = [];
    for (var j = 0; j < candles.length; j++) {
        var r = dynamicD.step(s, candles[j], j, candles);
        points = points.concat(r.dynamicDPoints);
    }
    assert.strictEqual(points.length, 1);
    assert.strictEqual(points[0].pointSide, 'LOW');
});

test('A7 same-candle rule: a new-extreme candle does not also confirm a reversal', function () {
    // 291-candle peak series yields exactly ONE event (at the confirmation bar),
    // proving the extreme candle (289) is not itself a reversal confirmation.
    var s = dynamicD.createState({});
    var candles = [];
    for (var i = 0; i < 289; i++) candles.push(c(i, 100));
    candles.push(c(289, 110));
    candles.push(c(290, 100));
    var points = [];
    for (var j = 0; j < candles.length; j++) {
        var r = dynamicD.step(s, candles[j], j, candles);
        points = points.concat(r.dynamicDPoints);
    }
    assert.strictEqual(points.length, 1);
    assert.strictEqual(points[0].confirmationBarIndex, 290);
});

test('A8 EXTREME_TIME_SNAPSHOT: thetaAtExtreme frozen at extreme candle', function () {
    var s = dynamicD.createState({});
    var candles = [];
    for (var i = 0; i < 289; i++) candles.push(c(i, 100));
    // small new extreme (+0.1%): the extreme candle's own return is tiny, so the
    // trailing volatility stays at the THETA_FLOOR 0.003 — this is what validates
    // EXTREME_TIME_SNAPSHOT freezing the floor (a 10% jump would inflate theta).
    candles.push(c(289, 100.1));
    candles.push(c(290, 99.7)); // reversal confirms HIGH (drop > 0.3% theta)
    var point = null;
    for (var j = 0; j < candles.length; j++) {
        var r = dynamicD.step(s, candles[j], j, candles);
        if (r.dynamicDPoints.length) point = r.dynamicDPoints[0];
    }
    assert.ok(point);
    assert.strictEqual(point.thetaAtExtreme, 0.003);
    assert.strictEqual(point.floorActive, true);
});

test('A9 NEW_RUN init = confirmation candle close (DOWN_RUN starts from C.close)', function () {
    var s = dynamicD.createState({});
    var candles = [];
    for (var i = 0; i < 289; i++) candles.push(c(i, 100));
    candles.push(c(289, 110));
    candles.push(c(290, 100)); // HIGH confirmed, new DOWN_RUN extreme = confirmation close 100
    for (var j = 0; j < candles.length; j++) dynamicD.step(s, candles[j], j, candles);
    assert.strictEqual(s.direction, 'DOWN_RUN');
    assert.strictEqual(s.extreme.price, 100); // confirmation candle close
});

test('A10 monotonic increasing closes emit zero reversals', function () {
    var s = dynamicD.createState({});
    var candles = [];
    for (var i = 0; i < 320; i++) candles.push(c(i, 100 + i * 0.1));
    var points = [];
    for (var j = 0; j < candles.length; j++) {
        var r = dynamicD.step(s, candles[j], j, candles);
        points = points.concat(r.dynamicDPoints);
    }
    assert.strictEqual(points.length, 0);
});

test('A11 monotonic decreasing closes emit zero reversals', function () {
    var s = dynamicD.createState({});
    var candles = [];
    for (var i = 0; i < 320; i++) candles.push(c(i, 100 - i * 0.1));
    var points = [];
    for (var j = 0; j < candles.length; j++) {
        var r = dynamicD.step(s, candles[j], j, candles);
        points = points.concat(r.dynamicDPoints);
    }
    assert.strictEqual(points.length, 0);
});

test('A12 determinism: identical series -> identical point set (id/price/sequence)', function () {
    function run() {
        var s = dynamicD.createState({});
        var candles = [];
        for (var i = 0; i < 289; i++) candles.push(c(i, 100));
        candles.push(c(289, 110));
        candles.push(c(290, 109.5));
        var pts = [];
        for (var j = 0; j < candles.length; j++) {
            var r = dynamicD.step(s, candles[j], j, candles);
            r.dynamicDPoints.forEach(function (p) { pts.push(p); });
        }
        return JSON.parse(JSON.stringify(pts));
    }
    assert.deepStrictEqual(run(), run());
});

test('A13 id is deterministic and embeds type+occurredAt+confirmedAt', function () {
    var s = dynamicD.createState({});
    var candles = [];
    for (var i = 0; i < 289; i++) candles.push(c(i, 100));
    candles.push(c(289, 110));
    candles.push(c(290, 100));
    var point = null;
    for (var j = 0; j < candles.length; j++) {
        var r = dynamicD.step(s, candles[j], j, candles);
        if (r.dynamicDPoints.length) point = r.dynamicDPoints[0];
    }
    assert.ok(point);
    var seg = ['DYND', 'UNKNOWN', '5m', 'HIGH', String(289 * BAR), String(290 * BAR + BAR - 1)].join(':');
    assert.strictEqual(point.id, seg);
});

// ---- B. SELECTOR_PRICE != BUSINESS_PRICE --------------------------------

test('B1 HIGH anchor: selectorPrice = close, price = candle.high', function () {
    var s = dynamicD.createState({});
    var candles = [];
    for (var i = 0; i < 289; i++) candles.push(c(i, 100));
    candles.push(c(289, 110)); // high = 111, close = 110
    candles.push(c(290, 100));
    var point = null;
    for (var j = 0; j < candles.length; j++) {
        var r = dynamicD.step(s, candles[j], j, candles);
        if (r.dynamicDPoints.length) point = r.dynamicDPoints[0];
    }
    assert.strictEqual(point.selectorPrice, 110);
    assert.strictEqual(point.price, 111); // REAL WICK (high)
    assert.notStrictEqual(point.selectorPrice, point.price);
});

test('B2 LOW anchor: selectorPrice = close, price = candle.low', function () {
    var s = dynamicD.createState({});
    var candles = [];
    for (var i = 0; i < 289; i++) candles.push(c(i, 100));
    candles.push(c(289, 90)); // low = 89, close = 90
    candles.push(c(290, 100)); // clear rebound >= theta (0.55% < theta ~0.0195 would NOT confirm)
    var point = null;
    for (var j = 0; j < candles.length; j++) {
        var r = dynamicD.step(s, candles[j], j, candles);
        if (r.dynamicDPoints.length) point = r.dynamicDPoints[0];
    }
    assert.strictEqual(point.selectorPrice, 90);
    assert.strictEqual(point.price, 89); // REAL WICK (low)
});

test('B3 selectorPrice never enters EQ comparison (wick used instead)', function () {
    var st = producer.createState({ symbol: 'X', timeframe: '5m' });
    st.fiveMinuteAtrValue = 1000;
    var anchor = mkAnchor('HIGH', 0, 100, { selectorPrice: 99999 });
    st.dynamicD.recentSurvivalPoints.push(anchor);
    var piv = mkPivot('HIGH', 5, 100);
    var res = producer.step(st, c(0, 100), 0, [c(0, 100)], [piv]);
    assert.strictEqual(res.equalLiquidity.length, 1);
    assert.strictEqual(res.equalLiquidity[0].metadata.historicalPartners[0].price, 100); // wick
    assert.notStrictEqual(res.equalLiquidity[0].metadata.historicalPartners[0].price, 99999);
});

test('B4 strict cross uses wick (price), not selectorPrice', function () {
    var st = producer.createState({ symbol: 'X', timeframe: '5m' });
    st.fiveMinuteAtrValue = 1000;
    var anchor = mkAnchor('HIGH', 0, 100, { selectorPrice: 50 });
    st.dynamicD.recentSurvivalPoints.push(anchor);
    var piv = mkPivot('HIGH', 5, 200); // wick 200 > anchor wick 100 -> strict cross
    var res = producer.step(st, c(0, 100), 0, [c(0, 100)], [piv]);
    assert.strictEqual(res.equalLiquidity.length, 0);
    assert.strictEqual(anchor.state, 'INACTIVE');
    assert.strictEqual(anchor.inactivatedBy, 'STRICT_CROSS');
});

// ---- C. Lifecycle -------------------------------------------------------

test('C1 anchor starts ACTIVE', function () {
    var p = mkAnchor('HIGH', 0, 100);
    assert.strictEqual(p.state, 'ACTIVE');
});

test('C2 markInactive transitions ACTIVE -> INACTIVE with reason', function () {
    var p = mkAnchor('HIGH', 0, 100);
    var ok = dynamicD.markInactive(p, 'STRICT_CROSS', 123);
    assert.strictEqual(ok, true);
    assert.strictEqual(p.state, 'INACTIVE');
    assert.strictEqual(p.inactivatedBy, 'STRICT_CROSS');
    assert.strictEqual(p.inactivatedAt, 123);
});

test('C3 markInactive is terminal: second call is a no-op (NO RETROACTIVE REWRITE)', function () {
    var p = mkAnchor('HIGH', 0, 100);
    dynamicD.markInactive(p, 'STRICT_CROSS', 123);
    var ok = dynamicD.markInactive(p, 'AGE_EXPIRY', 999);
    assert.strictEqual(ok, false);
    assert.strictEqual(p.state, 'INACTIVE');
    assert.strictEqual(p.inactivatedBy, 'STRICT_CROSS'); // unchanged
    assert.strictEqual(p.inactivatedAt, 123);
});

test('C4 isAgeExpired: within 5 days -> false', function () {
    var p = mkAnchor('HIGH', 0, 100, { confirmedAt: 1000 * BAR });
    assert.strictEqual(dynamicD.isAgeExpired(p, 1000 * BAR + FIVE_DAYS_MS - 1), false);
});

test('C5 isAgeExpired: beyond 5 days -> true', function () {
    var p = mkAnchor('HIGH', 0, 100, { confirmedAt: 1000 * BAR });
    assert.strictEqual(dynamicD.isAgeExpired(p, 1000 * BAR + FIVE_DAYS_MS + 1), true);
});

test('C6 isAgeExpired boundary: exactly 5 days -> false (strict >)', function () {
    var p = mkAnchor('HIGH', 0, 100, { confirmedAt: 1000 * BAR });
    assert.strictEqual(dynamicD.isAgeExpired(p, 1000 * BAR + FIVE_DAYS_MS), false);
});

test('C7 strictCrosses HIGH: pivot>anchor true; equal false; pivot<anchor false', function () {
    var a = mkAnchor('HIGH', 0, 100);
    assert.strictEqual(dynamicD.strictCrosses(a, mkPivot('HIGH', 5, 101)), true);
    assert.strictEqual(dynamicD.strictCrosses(a, mkPivot('HIGH', 5, 100)), false);
    assert.strictEqual(dynamicD.strictCrosses(a, mkPivot('HIGH', 5, 99)), false);
});

test('C8 strictCrosses LOW: pivot<anchor true; equal false; pivot>anchor false', function () {
    var a = mkAnchor('LOW', 0, 100);
    assert.strictEqual(dynamicD.strictCrosses(a, mkPivot('LOW', 5, 99)), true);
    assert.strictEqual(dynamicD.strictCrosses(a, mkPivot('LOW', 5, 100)), false);
    assert.strictEqual(dynamicD.strictCrosses(a, mkPivot('LOW', 5, 101)), false);
});

test('C9 AGE_EXPIRY_PRECEDES_EQ: aged anchor excluded even within tolerance', function () {
    var st = producer.createState({ symbol: 'X', timeframe: '5m' });
    st.fiveMinuteAtrValue = 1000;
    // contrived: recent occurredBarIndex but confirmedAt far in past -> aged
    var anchor = mkAnchor('HIGH', 10, 100, { confirmedAt: -(FIVE_DAYS_MS + 1000) });
    st.dynamicD.recentSurvivalPoints.push(anchor);
    var piv = mkPivot('HIGH', 20, 100, { occurredAt: 20 * BAR });
    var res = producer.step(st, c(0, 100), 0, [c(0, 100)], [piv]);
    assert.strictEqual(res.equalLiquidity.length, 0);
    assert.strictEqual(anchor.state, 'INACTIVE');
    assert.strictEqual(anchor.inactivatedBy, 'AGE_EXPIRY');
});

test('C10 STRICT_INVALIDATION priority: strict-cross candidate marks INACTIVE, no EQ', function () {
    var st = producer.createState({ symbol: 'X', timeframe: '5m' });
    st.fiveMinuteAtrValue = 1000;
    var anchor = mkAnchor('HIGH', 0, 100);
    st.dynamicD.recentSurvivalPoints.push(anchor);
    var piv = mkPivot('HIGH', 5, 200); // strict cross (200 > 100)
    var res = producer.step(st, c(0, 100), 0, [c(0, 100)], [piv]);
    assert.strictEqual(res.equalLiquidity.length, 0);
    assert.strictEqual(anchor.state, 'INACTIVE');
    assert.strictEqual(anchor.inactivatedBy, 'STRICT_CROSS');
});

test('C11 INACTIVE anchor cannot be revived by a later within-tolerance candidate', function () {
    var st = producer.createState({ symbol: 'X', timeframe: '5m' });
    st.fiveMinuteAtrValue = 1000;
    var anchor = mkAnchor('HIGH', 0, 100, { state: 'INACTIVE', inactivatedBy: 'STRICT_CROSS' });
    st.dynamicD.recentSurvivalPoints.push(anchor);
    var piv = mkPivot('HIGH', 5, 100); // within tolerance but anchor already INACTIVE
    var res = producer.step(st, c(0, 100), 0, [c(0, 100)], [piv]);
    assert.strictEqual(res.equalLiquidity.length, 0);
    assert.strictEqual(anchor.state, 'INACTIVE');
});

test('C12 ACTIVE within-tolerance anchor pairs (EQ emitted)', function () {
    var st = producer.createState({ symbol: 'X', timeframe: '5m' });
    st.fiveMinuteAtrValue = 1000;
    st.dynamicD.recentSurvivalPoints.push(mkAnchor('HIGH', 0, 100));
    var piv = mkPivot('HIGH', 5, 100);
    var res = producer.step(st, c(0, 100), 0, [c(0, 100)], [piv]);
    assert.strictEqual(res.equalLiquidity.length, 1);
    assert.strictEqual(res.equalLiquidity[0].type, 'EQH');
});

test('C13 eligibility requires state ACTIVE', function () {
    var anchor = mkAnchor('HIGH', 0, 100, { state: 'INACTIVE' });
    assert.strictEqual(dynamicD.wasEligibleAtCandidateOccurrence(anchor, 5 * BAR, 5), false);
});

test('C14 eligibility: confirmedAt <= candidateOccurredAt', function () {
    var anchor = mkAnchor('HIGH', 0, 100, { confirmedAt: 6 * BAR });
    assert.strictEqual(dynamicD.wasEligibleAtCandidateOccurrence(anchor, 5 * BAR, 5), false);
    var ok = mkAnchor('HIGH', 0, 100, { confirmedAt: 5 * BAR });
    assert.strictEqual(dynamicD.wasEligibleAtCandidateOccurrence(ok, 5 * BAR, 5), true);
});

test('C15 eligibility: occurredAt < candidateOccurredAt', function () {
    var anchor = mkAnchor('HIGH', 5, 100, { occurredAt: 5 * BAR });
    assert.strictEqual(dynamicD.wasEligibleAtCandidateOccurrence(anchor, 5 * BAR, 5), false);
});

test('C16 eligibility: barsBetween >= 1', function () {
    var anchor = mkAnchor('HIGH', 5, 100, { occurredAt: 5 * BAR });
    assert.strictEqual(dynamicD.wasEligibleAtCandidateOccurrence(anchor, 5 * BAR + 1, 5), false); // barsBetween 0
    var ok = mkAnchor('HIGH', 4, 100, { occurredAt: 4 * BAR });
    assert.strictEqual(dynamicD.wasEligibleAtCandidateOccurrence(ok, 5 * BAR, 5), true);
});

test('C17 eligibility: barsBetween <= 432 inclusive', function () {
    var ok = mkAnchor('HIGH', 0, 100, { occurredAt: 0 });
    assert.strictEqual(dynamicD.wasEligibleAtCandidateOccurrence(ok, 432 * BAR, 432), true);
    var far = mkAnchor('HIGH', 0, 100, { occurredAt: 0 });
    assert.strictEqual(dynamicD.wasEligibleAtCandidateOccurrence(far, 433 * BAR, 433), false);
});

test('C18 eligibility purity: does not mutate anchor lifecycle fields', function () {
    var anchor = mkAnchor('HIGH', 0, 100, { confirmedAt: 0 });
    var snap = { state: anchor.state, confirmedAt: anchor.confirmedAt, occurredAt: anchor.occurredAt };
    dynamicD.wasEligibleAtCandidateOccurrence(anchor, 5 * BAR, 5);
    assert.strictEqual(anchor.state, snap.state);
    assert.strictEqual(anchor.confirmedAt, snap.confirmedAt);
    assert.strictEqual(anchor.occurredAt, snap.occurredAt);
});

test('C19 NO_RETROACTIVE_REWRITE across repeated evaluation', function () {
    var st = producer.createState({ symbol: 'X', timeframe: '5m' });
    st.fiveMinuteAtrValue = 1000;
    st.dynamicD.recentSurvivalPoints.push(mkAnchor('HIGH', 0, 100, { state: 'INACTIVE' }));
    var piv = mkPivot('HIGH', 5, 100);
    producer.evaluatePivot(st, piv);
    producer.evaluatePivot(st, mkPivot('HIGH', 6, 100)); // another candidate
    assert.strictEqual(st.dynamicD.recentSurvivalPoints[0].state, 'INACTIVE');
});

test('C20 pruneSurvivalBeforeBar removes old anchors by occurredBarIndex', function () {
    var s = dynamicD.createState({});
    s.recentSurvivalPoints.push(mkAnchor('HIGH', 0, 100));
    s.recentSurvivalPoints.push(mkAnchor('HIGH', 500, 100));
    dynamicD.pruneSurvivalBeforeBar(s, 400);
    assert.strictEqual(s.recentSurvivalPoints.length, 1);
    assert.strictEqual(s.recentSurvivalPoints[0].occurredBarIndex, 500);
});

// ---- D. Integration ------------------------------------------------------

test('D1 full producer.step emits EQ when anchor within frozen tolerance', function () {
    var st = producer.createState({ symbol: 'X', timeframe: '5m' });
    st.fiveMinuteAtrValue = 10; // tolerance = 7
    st.dynamicD.recentSurvivalPoints.push(mkAnchor('HIGH', 0, 100));
    var piv = mkPivot('HIGH', 5, 100); // equal price; not a strict cross (100 > 100 false)
    var res = producer.step(st, c(0, 100), 0, [c(0, 100)], [piv]);
    assert.strictEqual(res.equalLiquidity.length, 1);
    assert.strictEqual(res.equalLiquidity[0].type, 'EQH');
});

test('D2 full producer.step: outside frozen tolerance -> no EQ', function () {
    var st = producer.createState({ symbol: 'X', timeframe: '5m' });
    st.fiveMinuteAtrValue = 10; // tolerance = 7
    st.dynamicD.recentSurvivalPoints.push(mkAnchor('HIGH', 0, 100));
    var piv = mkPivot('HIGH', 5, 108); // |108-100|=8 > 7
    var res = producer.step(st, c(0, 100), 0, [c(0, 100)], [piv]);
    assert.strictEqual(res.equalLiquidity.length, 0);
});

test('D3 replayState registers replacement EQ as Narrative Liquidity', function () {
    var candles = [90, 95, 100, 95, 90].map(function (h, i) {
        return candle(i, 80, h, 70, 80);
    });
    var s = replayState.createReplayState({ symbol: 'X', timeframe: '5m' });
    for (var i = 0; i < 4; i++) replayState.incrementalLiquidity(s, candles, i, null, candles[i].closeTime);
    s.productionEq.fiveMinuteAtrValue = 10;
    var z = mkAnchor('HIGH', 0, 100, { confirmedAt: candles[1].closeTime });
    s.productionEq.dynamicD.recentSurvivalPoints.push(z);
    replayState.incrementalLiquidity(s, candles, 4, null, candles[4].closeTime);
    var eq = s.registry.getByType('X', 'EQH');
    assert.strictEqual(eq.length, 1);
    assert.strictEqual(eq[0].price, 100);
    assert.strictEqual(eq[0].metadata.eqModelVersion, producer.VERSION);
});

test('D4 evaluatePivot is idempotent for the same pivot', function () {
    var st = producer.createState({ symbol: 'X', timeframe: '5m' });
    st.fiveMinuteAtrValue = 1000;
    st.dynamicD.recentSurvivalPoints.push(mkAnchor('HIGH', 0, 100));
    var piv = mkPivot('HIGH', 5, 100);
    var a = producer.evaluatePivot(st, piv);
    var b = producer.evaluatePivot(st, piv);
    assert.ok(a);
    assert.strictEqual(b, null);
    assert.strictEqual(st.events.length, 1);
});

test('D5 provenance.fromLiquidity reads new MODEL + HISTORICAL_SOURCE', function () {
    var st = producer.createState({ symbol: 'X', timeframe: '5m' });
    st.fiveMinuteAtrValue = 1000;
    st.dynamicD.recentSurvivalPoints.push(mkAnchor('HIGH', 0, 100));
    var ev = producer.step(st, c(0, 100), 0, [c(0, 100)], [mkPivot('HIGH', 5, 100)]).equalLiquidity[0];
    var prov = provenance.fromLiquidity(ev);
    assert.ok(prov);
    assert.strictEqual(prov.eqModelVersion, provenance.MODEL);
    assert.strictEqual(prov.historicalSource, provenance.HISTORICAL_SOURCE);
    assert.strictEqual(prov.partnerCount, 1);
});

test('D6 provenance rejects a non-matching MODEL', function () {
    var ev = { type: 'EQH', metadata: { eqModelVersion: 'OLD_MODEL', historicalPartners: [] } };
    assert.strictEqual(provenance.fromLiquidity(ev), null);
});

test('D7 buildEvent historicalPartners[].source === dynamicD.VERSION', function () {
    var st = producer.createState({ symbol: 'X', timeframe: '5m' });
    st.fiveMinuteAtrValue = 1000;
    st.dynamicD.recentSurvivalPoints.push(mkAnchor('HIGH', 0, 100));
    var ev = producer.step(st, c(0, 100), 0, [c(0, 100)], [mkPivot('HIGH', 5, 100)]).equalLiquidity[0];
    assert.strictEqual(ev.metadata.historicalPartners[0].source, dynamicD.VERSION);
    assert.strictEqual(ev.metadata.historicalSource, dynamicD.VERSION);
    assert.strictEqual(ev.metadata.eqModelVersion, producer.VERSION);
});

test('D8 EQ tolerance equals 5m Wilder ATR * priceStrongMaxATR (frozen 0.7)', function () {
    var thresholds = require('../config/thresholds');
    assert.strictEqual(thresholds.equalLiquidity.priceStrongMaxATR, 0.7);
    var st = producer.createState({ symbol: 'X', timeframe: '5m' });
    st.fiveMinuteAtrValue = 10;
    st.dynamicD.recentSurvivalPoints.push(mkAnchor('HIGH', 0, 100));
    // boundary (low side, so it is NOT a strict cross):
    // tolerance = 10*0.7 = 6.999... (float). |94-100| = 6 <= tolerance -> included.
    assert.strictEqual(producer.step(st, c(0, 100), 0, [c(0, 100)], [mkPivot('HIGH', 5, 94)]).equalLiquidity.length, 1);
    var st2 = producer.createState({ symbol: 'X', timeframe: '5m' });
    st2.fiveMinuteAtrValue = 10;
    st2.dynamicD.recentSurvivalPoints.push(mkAnchor('HIGH', 0, 100));
    // |92-100| = 8 > tolerance -> excluded (and 92 is not a strict cross of HIGH 100).
    assert.strictEqual(producer.step(st2, c(0, 100), 0, [c(0, 100)], [mkPivot('HIGH', 5, 92)]).equalLiquidity.length, 0);
});

// ---- E. Causality / future-leak guards ----------------------------------

test('E1 no future-data: anchor confirmed AFTER candidate occurrence excluded', function () {
    var anchor = mkAnchor('HIGH', 0, 100, { confirmedAt: 6 * BAR });
    assert.strictEqual(dynamicD.wasEligibleAtCandidateOccurrence(anchor, 5 * BAR, 5), false);
});

test('E2 EQ event price is the pivot wick, never selectorPrice', function () {
    var st = producer.createState({ symbol: 'X', timeframe: '5m' });
    st.fiveMinuteAtrValue = 1000;
    st.dynamicD.recentSurvivalPoints.push(mkAnchor('HIGH', 0, 100));
    var piv = mkPivot('HIGH', 5, 100);
    var ev = producer.step(st, c(0, 100), 0, [c(0, 100)], [piv]).equalLiquidity[0];
    assert.strictEqual(ev.price, 100); // pivot wick
});

test('E3 wick-to-wick comparison: EQ partner price is the anchor wick', function () {
    var st = producer.createState({ symbol: 'X', timeframe: '5m' });
    st.fiveMinuteAtrValue = 1000;
    st.dynamicD.recentSurvivalPoints.push(mkAnchor('HIGH', 0, 100, { selectorPrice: 99999 }));
    var ev = producer.step(st, c(0, 100), 0, [c(0, 100)], [mkPivot('HIGH', 5, 100)]).equalLiquidity[0];
    assert.strictEqual(ev.metadata.historicalPartners[0].price, 100);
    assert.notStrictEqual(ev.metadata.historicalPartners[0].price, 99999);
});

test('E4 id determinism across module reload', function () {
    delete require.cache[require.resolve('../liquidity/causalDynamicDHistoricalExtremes')];
    var reloaded = require('../liquidity/causalDynamicDHistoricalExtremes');
    assert.strictEqual(reloaded.VERSION, dynamicD.VERSION);
    assert.strictEqual(reloaded.LOOKBACK_BARS, dynamicD.LOOKBACK_BARS);
    assert.strictEqual(reloaded.LOOKBACK, dynamicD.LOOKBACK);
    assert.strictEqual(reloaded.THETA_FLOOR, dynamicD.THETA_FLOOR);
});

test('E5 frozen Dynamic D parameters are byte-fixed', function () {
    assert.strictEqual(dynamicD.LOOKBACK, 288);
    assert.strictEqual(dynamicD.K, 1.0);
    assert.strictEqual(dynamicD.THETA_FLOOR, 0.003);
    assert.strictEqual(Math.round(dynamicD.SQRT12 * 1000) / 1000, Math.round(Math.sqrt(12) * 1000) / 1000);
});

test('E6 no production dependency on legacy ZigZag module string', function () {
    assert.notStrictEqual(producer.VERSION, 'ATR50_36H_UNVIOLATED_CROSS_SOURCE_V1');
    assert.notStrictEqual(dynamicD.VERSION, 'CAUSAL_ATR50_ZIGZAG_V2');
});

test('A14 volatility READY exactly at 288 returns (candle 288), not at 287', function () {
    var s = dynamicD.createState({});
    var i;
    for (i = 0; i <= 287; i++) dynamicD.step(s, c(i, 100), i, []);
    assert.strictEqual(s.volatilityReady, false); // 287 returns
    dynamicD.step(s, c(288, 100), 288, []);
    assert.strictEqual(s.volatilityReady, true);  // 288 returns
});

test('A15 LOW detection id mirrors HIGH scheme (type+occurredAt+confirmedAt)', function () {
    var s = dynamicD.createState({});
    var candles = [];
    for (var i = 0; i < 289; i++) candles.push(c(i, 100));
    candles.push(c(289, 90));
    candles.push(c(290, 100));
    var point = null;
    for (var j = 0; j < candles.length; j++) {
        var r = dynamicD.step(s, candles[j], j, candles);
        if (r.dynamicDPoints.length) point = r.dynamicDPoints[0];
    }
    assert.ok(point);
    var seg = ['DYND', 'UNKNOWN', '5m', 'LOW', String(289 * BAR), String(290 * BAR + BAR - 1)].join(':');
    assert.strictEqual(point.id, seg);
});

test('B5 HIGH anchor wick is the extreme candle HIGH (not close, not low)', function () {
    var s = dynamicD.createState({});
    var candles = [];
    for (var i = 0; i < 289; i++) candles.push(c(i, 100));
    candles.push(c(289, 110)); // high = 111, low = 109, close = 110
    candles.push(c(290, 100));
    var point = null;
    for (var j = 0; j < candles.length; j++) {
        var r = dynamicD.step(s, candles[j], j, candles);
        if (r.dynamicDPoints.length) point = r.dynamicDPoints[0];
    }
    assert.ok(point);
    assert.strictEqual(point.price, 111);   // high wick
    assert.notStrictEqual(point.price, 110); // not close
    assert.notStrictEqual(point.price, 109); // not low wick
});

test('B6 LOW anchor wick is the extreme candle LOW (not close, not high)', function () {
    var s = dynamicD.createState({});
    var candles = [];
    for (var i = 0; i < 289; i++) candles.push(c(i, 100));
    candles.push(c(289, 90)); // high = 91, low = 89, close = 90
    candles.push(c(290, 100));
    var point = null;
    for (var j = 0; j < candles.length; j++) {
        var r = dynamicD.step(s, candles[j], j, candles);
        if (r.dynamicDPoints.length) point = r.dynamicDPoints[0];
    }
    assert.ok(point);
    assert.strictEqual(point.price, 89);    // low wick
    assert.notStrictEqual(point.price, 90); // not close
    assert.notStrictEqual(point.price, 91); // not high wick
});

test('C21 eligibleHistoricalPoints filters by pointSide (HIGH anchor vs LOW pivot excluded)', function () {
    var s = dynamicD.createState({});
    s.recentSurvivalPoints.push(mkAnchor('HIGH', 0, 100));
    assert.strictEqual(dynamicD.eligibleHistoricalPoints(s, mkPivot('LOW', 5, 100)).length, 0);
    assert.strictEqual(dynamicD.eligibleHistoricalPoints(s, mkPivot('HIGH', 5, 100)).length, 1);
});

test('C22 multiple ACTIVE anchors within tolerance all pair into one EQ', function () {
    var st = producer.createState({ symbol: 'X', timeframe: '5m' });
    st.fiveMinuteAtrValue = 1000;
    st.dynamicD.recentSurvivalPoints.push(mkAnchor('HIGH', 0, 100));
    st.dynamicD.recentSurvivalPoints.push(mkAnchor('HIGH', 1, 100, { id: 'A_HIGH_1_100' }));
    var res = producer.step(st, c(0, 100), 0, [c(0, 100)], [mkPivot('HIGH', 5, 100)]);
    assert.strictEqual(res.equalLiquidity.length, 1);
    assert.strictEqual(res.equalLiquidity[0].metadata.historicalPartners.length, 2);
});

test('C23 INACTIVE anchor stays in survival list until pruned by bar window', function () {
    var st = producer.createState({ symbol: 'X', timeframe: '5m' });
    st.fiveMinuteAtrValue = 1000;
    var anchor = mkAnchor('HIGH', 0, 100);
    st.dynamicD.recentSurvivalPoints.push(anchor);
    producer.step(st, c(0, 100), 0, [c(0, 100)], [mkPivot('HIGH', 5, 200)]); // strict cross
    assert.strictEqual(anchor.state, 'INACTIVE');
    assert.strictEqual(st.dynamicD.recentSurvivalPoints.length, 1); // still present
    dynamicD.pruneSurvivalBeforeBar(st.dynamicD, 1);
    assert.strictEqual(st.dynamicD.recentSurvivalPoints.length, 0); // pruned (occurredBarIndex 0 < 1)
});

test('D9 producer.step returns { dynamicDPoints, equalLiquidity } shape', function () {
    var st = producer.createState({ symbol: 'X', timeframe: '5m' });
    st.fiveMinuteAtrValue = 1000;
    st.dynamicD.recentSurvivalPoints.push(mkAnchor('HIGH', 0, 100));
    var res = producer.step(st, c(0, 100), 0, [c(0, 100)], [mkPivot('HIGH', 5, 100)]);
    assert.ok(res.hasOwnProperty('dynamicDPoints'));
    assert.ok(res.hasOwnProperty('equalLiquidity'));
    assert.strictEqual(Array.isArray(res.dynamicDPoints), true);
    assert.strictEqual(res.equalLiquidity.length, 1);
});

test('D10 evaluatePivot returns null (no event) when no historical anchors exist', function () {
    var st = producer.createState({ symbol: 'X', timeframe: '5m' });
    st.fiveMinuteAtrValue = 1000;
    assert.strictEqual(producer.evaluatePivot(st, mkPivot('HIGH', 5, 100)), null);
    assert.strictEqual(st.events.length, 0);
});

test('E7 volatility-adaptive theta: a 10% jump extreme inflates sigma, floorActive=false', function () {
    var s = dynamicD.createState({});
    var candles = [];
    for (var i = 0; i < 289; i++) candles.push(c(i, 100));
    candles.push(c(289, 110)); // +10% jump inflates trailing volatility
    candles.push(c(290, 100));
    var point = null;
    for (var j = 0; j < candles.length; j++) {
        var r = dynamicD.step(s, candles[j], j, candles);
        if (r.dynamicDPoints.length) point = r.dynamicDPoints[0];
    }
    assert.ok(point);
    assert.strictEqual(point.floorActive, false);
    assert.ok(point.thetaAtExtreme > 0.003);
});

test('E8 thetaFor unit: max(THETA_FLOOR, sigma1h * K)', function () {
    assert.strictEqual(dynamicD.thetaFor(0), 0.003);       // floor when sigma1h = 0
    assert.strictEqual(dynamicD.thetaFor(0.0005), 0.003);   // sigma1h 0.001732 < floor -> floor
    assert.ok(dynamicD.thetaFor(0.01) > 0.003);            // above floor -> value
});

test('E9 sampleStd uses ddof=1 (n-1) denominator', function () {
    var s = dynamicD.sampleStd([2, 4, 4, 4, 5, 5, 7, 9]); // sample std = 2.13809
    assert.ok(Math.abs(s - 2.138089935) < 1e-6);
});

// ---- helpers ------------------------------------------------------------

function mkAnchor(side, index, price, options) {
    var opts = options || {};
    return {
        id: 'A_' + side + '_' + index + '_' + price,
        source: dynamicD.VERSION,
        symbol: 'X',
        timeframe: '5m',
        pointSide: side,
        type: side === 'HIGH' ? 'DYNAMIC_D_HIGH' : 'DYNAMIC_D_LOW',
        selectorPrice: opts.selectorPrice === undefined ? price : opts.selectorPrice,
        price: price,
        priceSource: 'CLOSE_SELECTOR_WICK_BUSINESS',
        occurredAt: opts.occurredAt === undefined ? index * BAR : opts.occurredAt,
        confirmedAt: opts.confirmedAt === undefined ? index * BAR : opts.confirmedAt,
        occurredBarIndex: index,
        confirmationBarIndex: index,
        thetaAtExtreme: 0.003,
        sigma5mAtExtreme: null,
        sigma1hAtExtreme: null,
        floorActive: true,
        state: opts.state || 'ACTIVE',
        inactivatedAt: null,
        inactivatedBy: null
    };
}

function mkPivot(side, index, price, options) {
    var opts = options || {};
    var type = side === 'HIGH' ? 'SWING_HIGH' : 'SWING_LOW';
    return {
        id: 'P_' + side + '_' + index + '_' + price,
        symbol: 'X',
        timeframe: '5m',
        type: type,
        side: side === 'HIGH' ? 'BSL' : 'SSL',
        pointSide: side, // also supplied so the module-level eligibleHistoricalPoints works
        price: price,
        sourceOpenTime: opts.occurredAt === undefined ? index * BAR : opts.occurredAt,
        sourceCloseTime: (index + 1) * BAR - 1,
        occurredAt: opts.occurredAt === undefined ? index * BAR : opts.occurredAt,
        confirmedAt: opts.confirmedAt === undefined ? (index + 3) * BAR : opts.confirmedAt,
        metadata: { index: index, right: 2 }
    };
}

console.log('\nProduction Historical Extreme Dynamic D V1: ' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
