'use strict';

/**
 * REMOVE_CALENDAR_NAMED_LIQUIDITY_V1 — cleanup contract tests.
 *
 * Verifies the 6 calendar-named liquidity types
 *   PDH / PDL / PWH / PWL / PMH / PML
 * are fully removed from the CURRENT PRODUCTION architecture:
 *   - not a supported registry type
 *   - cannot produce a production LIQUIDITY_TAKEN
 *   - cannot originate a production WATCH
 *   - absent from every production type-domain allowlist
 *
 * And that the KEEP set is preserved & unchanged:
 *   - EQH / EQL remain supported (registry, Taken, WATCH)
 *   - Production EQ still uses Causal Dynamic D (CC arm)
 *   - selectorPrice stays excluded from EQ comparison
 *   - 2/2 wick-to-wick invalidation, 5-day ACTIVE expiry, INACTIVE-terminal
 *     lifecycle all remain intact.
 *
 * BACKWARD_COMPATIBILITY = none. No fallback, no compatibility branch.
 */

var assert = require('assert');
var registryMod = require('../liquidity/liquidityRegistry');
var takenAdapter = require('../events/liquidityTakenEventAdapter');
var association = require('../stats/liquidityTakenAssociation');
var producer = require('../liquidity/productionEqualLiquidityV1');
var dynamicD = require('../liquidity/causalDynamicDHistoricalExtremes');

var REMOVED = ['PDH', 'PDL', 'PWH', 'PWL', 'PMH', 'PML'];
var BAR = 300000;

var failures = [];
function test(name, fn) {
    try {
        fn();
        console.log('PASS  ' + name);
    } catch (e) {
        failures.push(name + ' :: ' + (e && e.message));
        console.log('FAIL  ' + name + ' :: ' + (e && e.message));
    }
}

// ---- fixtures ----
function liq(id, type, side, price, extra) {
    var l = {
        id: id, symbol: 'BTCUSDT', type: type, side: side, price: price,
        status: 'ACTIVE', occurredAt: 0, confirmedAt: BAR
    };
    if (extra) Object.keys(extra).forEach(function (k) { l[k] = extra[k]; });
    return l;
}
function candle(i, high, low, close, closed) {
    return {
        openTime: i * BAR, closeTime: i * BAR + BAR - 1,
        open: close, high: high, low: low, close: close,
        closed: closed === undefined ? true : closed
    };
}
function mkRegistry() { return registryMod.createRegistry(); }

// ---- EQ harness (inject a synthetic but schema-correct Dynamic D anchor) ----
function pushAnchor(state, side, price, selectorPrice, occurredAt, confirmedAt, occurredBarIndex, st) {
    state.dynamicD.recentSurvivalPoints.push({
        id: 'DYND:BTCUSDT:5m:' + side + ':' + occurredAt + ':' + confirmedAt,
        source: dynamicD.VERSION, symbol: 'BTCUSDT', timeframe: '5m',
        pointSide: side,
        type: side === 'HIGH' ? 'DYNAMIC_D_HIGH' : 'DYNAMIC_D_LOW',
        selectorPrice: selectorPrice,
        price: price,
        priceSource: 'CLOSE_SELECTOR_WICK_BUSINESS',
        occurredAt: occurredAt, confirmedAt: confirmedAt,
        occurredBarIndex: occurredBarIndex, confirmationBarIndex: occurredBarIndex,
        state: st || 'ACTIVE', inactivatedAt: null, inactivatedBy: null
    });
}
function mkPivot(side, price, occurredAt, confirmedAt, index) {
    return {
        id: 'P:' + side + ':' + occurredAt,
        type: side === 'HIGH' ? 'SWING_HIGH' : 'SWING_LOW',
        price: price, occurredAt: occurredAt, confirmedAt: confirmedAt,
        metadata: { index: index }
    };
}
function eqState() {
    var s = producer.createState({ symbol: 'BTCUSDT', timeframe: '5m' });
    s.fiveMinuteAtrValue = 1; // tolerance = 1 * priceStrongMaxATR(0.7) > 0
    return s;
}

// =================== §17.01–06 : 6 types unsupported ===================
REMOVED.forEach(function (type) {
    test('01-' + type + ' unsupported (registry rejects)', function () {
        var r = mkRegistry();
        assert.strictEqual(r.add(liq('X:' + type + ':1', type, 'BSL', 100)), false,
            type + ' must not be accepted by the liquidity registry');
    });
});

// =================== §17.07–08 : EQH/EQL remain supported ===================
test('07 EQH remains supported', function () {
    var r = mkRegistry();
    assert.strictEqual(r.add(liq('X:EQH:1', 'EQH', 'BSL', 100)), true);
});
test('08 EQL remains supported', function () {
    var r = mkRegistry();
    assert.strictEqual(r.add(liq('X:EQL:1', 'EQL', 'SSL', 90)), true);
});

// =================== §17.09–14 : Registry rejects each of the 6 ===================
REMOVED.forEach(function (type) {
    test('09-' + type + ' registry does not support', function () {
        var r = mkRegistry();
        assert.strictEqual(r.add(liq('Y:' + type + ':1', type, 'BSL', 100)), false);
        assert.strictEqual(r.getByType('BTCUSDT', type).length, 0);
    });
});

// =================== §17.15–16 : EQH/EQL registry works ===================
test('15 EQH registry works', function () {
    var r = mkRegistry();
    r.add(liq('E1', 'EQH', 'BSL', 100));
    assert.strictEqual(r.getByType('BTCUSDT', 'EQH').length, 1);
});
test('16 EQL registry works', function () {
    var r = mkRegistry();
    r.add(liq('E1', 'EQL', 'SSL', 90));
    assert.strictEqual(r.getByType('BTCUSDT', 'EQL').length, 1);
});

// =================== §17.17–22 : 6 types cannot generate production Taken ===================
REMOVED.forEach(function (type) {
    test('17-' + type + ' cannot generate production Taken', function () {
        var side = (type === 'PDH' || type === 'PWH' || type === 'PMH') ? 'BSL' : 'SSL';
        var l = liq(type + ':A', type, side, 100);
        // candle that would strictly trade through the liquidity
        var c = side === 'BSL' ? candle(1, 100.01, 99, 100) : candle(1, 101, 99.99, 100);
        assert.strictEqual(takenAdapter.buildTakenEvent(l, c, 1, '5m'), null,
            type + ' must not produce a LIQUIDITY_TAKEN event');
    });
});

// =================== §17.23–24 : EQH/EQL Taken still works ===================
test('23 EQH Taken still works', function () {
    var l = liq('EQH:A', 'EQH', 'BSL', 100);
    var ev = takenAdapter.buildTakenEvent(l, candle(1, 100.01, 99, 100), 1, '5m');
    assert.ok(ev && ev.type === 'LIQUIDITY_TAKEN' && ev.source.liquidityType === 'EQH');
});
test('24 EQL Taken still works', function () {
    var l = liq('EQL:A', 'EQL', 'SSL', 100);
    var ev = takenAdapter.buildTakenEvent(l, candle(1, 101, 99.99, 100), 1, '5m');
    assert.ok(ev && ev.type === 'LIQUIDITY_TAKEN' && ev.source.liquidityType === 'EQL');
});

// =================== §17.25–30 : 6 types cannot originate WATCH ===================
function handTaken(type, side, price, candleIndex, confirmedAt) {
    return {
        id: 'T:' + type + ':' + candleIndex, type: 'LIQUIDITY_TAKEN',
        symbol: 'BTCUSDT', timeframe: '5m', side: side,
        liquidityId: type + ':A', occurredAt: confirmedAt - BAR + 1,
        confirmedAt: confirmedAt, candleIndex: candleIndex, price: price,
        source: { liquidityId: type + ':A', liquidityType: type, liquidityPrice: price, side: side },
        metadata: {}
    };
}
REMOVED.forEach(function (type) {
    test('25-' + type + ' cannot originate WATCH', function () {
        var side = (type === 'PDH' || type === 'PWH' || type === 'PMH') ? 'BSL' : 'SSL';
        var taken = handTaken(type, side, 100, 1, BAR);
        var res = association.associateTaken({
            displacement: { startIndex: 10, confirmedAt: 20 * BAR },
            direction: side === 'BSL' ? 'BEARISH' : 'BULLISH',
            takenEvents: [taken], availableAt: 30 * BAR
        });
        assert.strictEqual(res, null, type + ' Taken must not satisfy WATCH eligibility');
    });
});

// =================== §17.31–32 : EQH/EQL Taken can satisfy WATCH ===================
test('31 EQH Taken can still satisfy WATCH', function () {
    var ev = takenAdapter.buildTakenEvent(liq('EQH:A', 'EQH', 'BSL', 100), candle(1, 100.01, 99, 100), 1, '5m');
    var res = association.associateTaken({
        displacement: { startIndex: 10, confirmedAt: 20 * BAR },
        direction: 'BEARISH', takenEvents: [ev], availableAt: 30 * BAR
    });
    assert.ok(res && res.allCandidates.length >= 1, 'EQH Taken must be WATCH-eligible');
});
test('32 EQL Taken can still satisfy WATCH', function () {
    var ev = takenAdapter.buildTakenEvent(liq('EQL:A', 'EQL', 'SSL', 100), candle(1, 101, 99.99, 100), 1, '5m');
    var res = association.associateTaken({
        displacement: { startIndex: 10, confirmedAt: 20 * BAR },
        direction: 'BULLISH', takenEvents: [ev], availableAt: 30 * BAR
    });
    assert.ok(res && res.allCandidates.length >= 1, 'EQL Taken must be WATCH-eligible');
});

// =================== §17.33 : production type domain contains no calendar liquidity ===================
test('33 production type domain contains no calendar named liquidity', function () {
    var r = mkRegistry();
    REMOVED.forEach(function (type) {
        assert.strictEqual(r.add(liq('Z:' + type, type, 'BSL', 100)), false,
            type + ' must be absent from the production type domain');
    });
});

// =================== §17.34 : production runtime has no calendar generator dependency ===================
test('34 production runtime has no calendar generator dependency', function () {
    assert.throws(function () { require('../liquidity/dailyLiquidity'); }, /Cannot find module/);
    assert.throws(function () { require('../liquidity/weeklyLiquidity'); }, /Cannot find module/);
    assert.throws(function () { require('../liquidity/monthlyLiquidity'); }, /Cannot find module/);
    // type-domain allowlists must not enumerate the 6 types
    REMOVED.forEach(function (type) {
        assert.strictEqual(takenAdapter.NARRATIVE_TYPES[type], undefined,
            'NARRATIVE_TYPES must not include ' + type);
        assert.strictEqual(association.ELIGIBLE_TYPES[type], undefined,
            'WATCH ELIGIBLE_TYPES must not include ' + type);
    });
});

// =================== §17.35 : Production EQ still uses Dynamic D ===================
test('35 Production EQ still uses Causal Dynamic D', function () {
    assert.strictEqual(producer.LOOKBACK_BARS, dynamicD.LOOKBACK_BARS);
    assert.strictEqual(dynamicD.LOOKBACK_BARS, 432);
    assert.strictEqual(dynamicD.VERSION, 'CAUSAL_DYNAMIC_D_V1');
});

// =================== §17.36 : Production EQ still creates EQH/EQL ===================
test('36 Production EQ still creates EQH/EQL', function () {
    var sH = eqState();
    pushAnchor(sH, 'HIGH', 100, 100, 1000, 1000 + BAR - 1, 10);
    var eqh = producer.evaluatePivot(sH, mkPivot('HIGH', 100, 1000 + 5 * BAR, 1000 + 6 * BAR - 1, 15));
    assert.ok(eqh && eqh.liquidityType === 'EQH', 'EQH must be produced');

    var sL = eqState();
    pushAnchor(sL, 'LOW', 90, 90, 1000, 1000 + BAR - 1, 10);
    var eql = producer.evaluatePivot(sL, mkPivot('LOW', 90, 1000 + 5 * BAR, 1000 + 6 * BAR - 1, 15));
    assert.ok(eql && eql.liquidityType === 'EQL', 'EQL must be produced');
});

// =================== §17.37 : selectorPrice remains excluded from EQ comparison ===================
test('37 selectorPrice remains excluded from EQ comparison', function () {
    // wick (price=100) matches the pivot wick -> EQ forms (selectorPrice=90 ignored)
    var s1 = eqState();
    pushAnchor(s1, 'HIGH', 100, 90, 1000, 1000 + BAR - 1, 10);
    var ok = producer.evaluatePivot(s1, mkPivot('HIGH', 100, 1000 + 5 * BAR, 1000 + 6 * BAR - 1, 15));
    assert.ok(ok, 'EQ must compare WICK price, not selectorPrice(close)');

    // pivot wick (90) matches selectorPrice only -> NO EQ (proves selectorPrice unused)
    var s2 = eqState();
    pushAnchor(s2, 'HIGH', 100, 90, 1000, 1000 + BAR - 1, 10);
    var none = producer.evaluatePivot(s2, mkPivot('HIGH', 90, 1000 + 5 * BAR, 1000 + 6 * BAR - 1, 15));
    assert.strictEqual(none, null, 'selectorPrice(close) must NOT drive EQ pairing');
});

// =================== §17.38 : 2/2 wick-to-wick invalidation remains intact ===================
test('38 2/2 wick-to-wick invalidation remains intact', function () {
    var s = eqState();
    pushAnchor(s, 'HIGH', 100, 100, 1000, 1000 + BAR - 1, 10);
    var none = producer.evaluatePivot(s, mkPivot('HIGH', 101, 1000 + 5 * BAR, 1000 + 6 * BAR - 1, 15));
    assert.strictEqual(none, null, 'strict wick cross must invalidate the anchor');
    var anchor = s.dynamicD.recentSurvivalPoints[0];
    assert.strictEqual(anchor.state, 'INACTIVE');
    assert.strictEqual(anchor.inactivatedBy, 'STRICT_CROSS');
});

// =================== §17.39 : 5-day ACTIVE expiry remains intact ===================
test('39 5-day ACTIVE expiry remains intact', function () {
    var s = eqState();
    var confirmedAt = 1000 + BAR - 1;
    pushAnchor(s, 'HIGH', 100, 100, 1000, confirmedAt, 10);
    // pivot occurs just beyond 5 calendar days after confirmedAt
    var occurredAt = confirmedAt + dynamicD.FIVE_DAYS_MS + 1;
    var none = producer.evaluatePivot(s, mkPivot('HIGH', 100, occurredAt, occurredAt + BAR - 1, 15));
    assert.strictEqual(none, null, 'aged anchor must not pair');
    var anchor = s.dynamicD.recentSurvivalPoints[0];
    assert.strictEqual(anchor.state, 'INACTIVE');
    assert.strictEqual(anchor.inactivatedBy, 'AGE_EXPIRY');
});

// =================== §17.40 : INACTIVE remains terminal ===================
test('40 INACTIVE remains terminal', function () {
    var s = eqState();
    pushAnchor(s, 'HIGH', 100, 100, 1000, 1000 + BAR - 1, 10, 'INACTIVE');
    var none = producer.evaluatePivot(s, mkPivot('HIGH', 100, 1000 + 5 * BAR, 1000 + 6 * BAR - 1, 15));
    assert.strictEqual(none, null, 'INACTIVE anchor must never revive');
    var anchor = s.dynamicD.recentSurvivalPoints[0];
    // markInactive is idempotent (terminal)
    assert.strictEqual(dynamicD.markInactive(anchor, 'STRICT_CROSS', 99999), false);
    assert.strictEqual(anchor.state, 'INACTIVE');
});

if (failures.length) {
    console.error('\n' + failures.length + ' FAILURE(S) in calendarNamedLiquidityRemovalV1');
    process.exit(1);
}
console.log('\nALL ' + (REMOVED.length * 2 + 2 + 6 + 2 + 6 + 2 + 2 + 8) + ' removal contract checks passed');
