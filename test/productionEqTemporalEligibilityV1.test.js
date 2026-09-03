'use strict';

/**
 * PRODUCTION_EQ_TEMPORAL_ELIGIBILITY_V1 — point-in-time anchor eligibility
 * under the Causal Dynamic D replacement contract.
 *
 * A historical anchor's eligibility to pair with a current ordinary 2/2 is
 * decided at the candidate's OCCURRENCE instant (candidate.occurredAt), never
 * at its later confirmation (candidate.confirmedAt) and never by mutable
 * future state. The pure function under test is
 * wasEligibleAtCandidateOccurrence(anchor, candidateOccurredAt,
 * candidateOccurredBarIndex). It reads only the anchor's immutable fields:
 * confirmedAt, occurredAt, occurredBarIndex, state.
 *
 * Lifecycle is terminal: an anchor is ACTIVE on confirmation, then INACTIVE
 * (on STRICT_CROSS or AGE_EXPIRY). An INACTIVE anchor is NEVER eligible and
 * NEVER revives — this is the deliberate change from the legacy
 * `violatedAt >= occurrence` admission rule (FULL_REPLACEMENT=true;
 * BACKWARD_COMPATIBILITY=false).
 *
 * Eligibility boundary on the 432-bar lookback (measured at occurrence index):
 *   barsBetween (candidateIndex - anchorIndex) in [1, 432] inclusive.
 */

var assert = require('assert');
var producer = require('../liquidity/productionEqualLiquidityV1');
var dynamicD = require('../liquidity/causalDynamicDHistoricalExtremes');
var thresholds = require('../config/thresholds');

var BAR = 300000; // 5m in ms
var LOOKBACK_BARS = producer.LOOKBACK_BARS; // 432
var EQ_ATR_MULT = thresholds.equalLiquidity.priceStrongMaxATR; // 0.7

var passed = 0, failed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log('PASS  ' + name); }
    catch (error) { failed++; console.log('FAIL  ' + name + ' -> ' + error.stack); }
}

// Build a production EQ state with the given historical anchors preloaded.
function state(points) {
    var value = producer.createState({ symbol: 'X', timeframe: '5m' });
    value.fiveMinuteAtrValue = 10;
    value.dynamicD.recentSurvivalPoints = points || [];
    return value;
}

// Build a Causal Dynamic D historical anchor (new-contract field set).
function point(id, side, index, price, options) {
    var opts = options || {};
    return {
        id: id, pointSide: side, price: price, selectorPrice: price,
        occurredAt: index * BAR,
        confirmedAt: opts.confirmedAt === undefined ? (index + 3) * BAR : opts.confirmedAt,
        occurredBarIndex: index,
        state: opts.state || 'ACTIVE',
        inactivatedBy: opts.inactivatedBy || null,
        inactivatedAt: opts.inactivatedAt || null
    };
}

// Build a current ordinary 2/2 candidate pivot (matches swingLiquidity output).
function pivot(id, side, index, price, confirmedAt) {
    var type = side === 'HIGH' ? 'SWING_HIGH' : 'SWING_LOW';
    return {
        id: id, symbol: 'X', timeframe: '5m', type: type,
        side: side === 'HIGH' ? 'BSL' : 'SSL', price: price,
        sourceOpenTime: index * BAR, sourceCloseTime: (index + 1) * BAR - 1,
        occurredAt: index * BAR,
        confirmedAt: confirmedAt === undefined ? (index + 3) * BAR : confirmedAt,
        metadata: { index: index, right: 2 }
    };
}

var OCC = 20 * BAR; // a canonical candidate occurrence instant

// ---- T01: INACTIVE (inactivated before occurrence) -> not eligible ----
test('T01 anchor INACTIVE before candidate occurrence -> not eligible', function () {
    var p = pivot('P', 'LOW', 20, 100);
    var z = point('Z', 'LOW', 10, 100, { state: 'INACTIVE', inactivatedBy: 'STRICT_CROSS', inactivatedAt: OCC - BAR });
    assert.strictEqual(producer.wasEligibleAtCandidateOccurrence(z, p.occurredAt, p.metadata.index), false);
});

// ---- T02: INACTIVE EXACTLY AT occurrence -> NOT eligible (terminal, no revival) ----
test('T02 anchor INACTIVE exactly at candidate occurrence -> NOT eligible (terminal)', function () {
    var p = pivot('P', 'LOW', 20, 100);
    var z = point('Z', 'LOW', 10, 100, { state: 'INACTIVE', inactivatedBy: 'STRICT_CROSS', inactivatedAt: OCC });
    assert.strictEqual(producer.wasEligibleAtCandidateOccurrence(z, p.occurredAt, p.metadata.index), false);
});

// ---- T03: INACTIVE AFTER occurrence -> NOT eligible (terminal) ----
test('T03 anchor INACTIVE after candidate occurrence -> NOT eligible', function () {
    var p = pivot('P', 'LOW', 20, 100);
    var z = point('Z', 'LOW', 10, 100, { state: 'INACTIVE', inactivatedBy: 'AGE_EXPIRY', inactivatedAt: OCC + BAR });
    assert.strictEqual(producer.wasEligibleAtCandidateOccurrence(z, p.occurredAt, p.metadata.index), false);
});

// ---- T04: ACTIVE -> eligible ----
test('T04 active anchor -> eligible', function () {
    var p = pivot('P', 'LOW', 20, 100);
    var z = point('Z', 'LOW', 10, 100);
    assert.strictEqual(producer.wasEligibleAtCandidateOccurrence(z, p.occurredAt, p.metadata.index), true);
});

// ---- T05: anchor confirmed AFTER candidate occurrence -> not eligible ----
// (old code used confirmedAt <= candidate.confirmedAt, which would wrongly admit it)
test('T05 anchor confirmed AFTER candidate occurrence -> not eligible', function () {
    var p = pivot('P', 'LOW', 20, 100); // occurredAt = 20*BAR
    var z = point('Z', 'LOW', 10, 100, { confirmedAt: 21 * BAR }); // 21*BAR > 20*BAR
    assert.strictEqual(producer.wasEligibleAtCandidateOccurrence(z, p.occurredAt, p.metadata.index), false);
});

// ---- T06: anchor confirmed EXACTLY at candidate occurrence -> eligible ----
test('T06 anchor confirmed EXACTLY at candidate occurrence -> eligible', function () {
    var p = pivot('P', 'LOW', 20, 100);
    var z = point('Z', 'LOW', 10, 100, { confirmedAt: OCC }); // exactly at occurrence
    assert.strictEqual(producer.wasEligibleAtCandidateOccurrence(z, p.occurredAt, p.metadata.index), true);
});

// ---- T07: anchor outside 432-bar lookback at occurrence -> not eligible ----
test('T07 anchor outside 432-bar lookback at occurrence -> not eligible', function () {
    var p = pivot('P', 'LOW', 500, 100);
    var z = point('Z', 'LOW', 10, 100); // barsBetween = 490 > 432
    assert.strictEqual(producer.wasEligibleAtCandidateOccurrence(z, p.occurredAt, p.metadata.index), false);
});

// ---- T08: inside lookback at occurrence but outside by confirmation -> eligible ----
// Demonstrates the lookback is measured at occurrence index, not confirmation index.
test('T08 inside lookback at occurrence but outside by confirmation -> eligible', function () {
    var occIdx = 440;
    var p = pivot('P', 'LOW', occIdx, 100);
    var zIdx = occIdx - LOOKBACK_BARS; // exactly 432 bars before occurrence -> inside
    var z = point('Z', 'LOW', zIdx, 100);
    assert.strictEqual(producer.wasEligibleAtCandidateOccurrence(z, p.occurredAt, p.metadata.index), true);
    // at confirmation index (occIdx+2) the same anchor would be OUTSIDE (434 bars)
    assert.strictEqual((occIdx + 2) - zIdx > LOOKBACK_BARS, true);
});

// ---- T09: INACTIVE at occurrence -> NOT eligible (replaces old violatedAt>=occurrence rule) ----
test('T09 anchor INACTIVE at candidate occurrence -> NOT eligible (terminal lifecycle)', function () {
    var p = pivot('P', 'LOW', 20, 100);
    var z = point('Z', 'LOW', 10, 100, { state: 'INACTIVE', inactivatedBy: 'STRICT_CROSS', inactivatedAt: OCC });
    assert.strictEqual(producer.wasEligibleAtCandidateOccurrence(z, p.occurredAt, p.metadata.index), false);
});

// ---- T10: INACTIVE before occurrence -> not eligible ----
test('T10 anchor INACTIVE before candidate occurrence -> not eligible', function () {
    var p = pivot('P', 'LOW', 20, 100);
    var z = point('Z', 'LOW', 10, 100, { state: 'INACTIVE', inactivatedBy: 'STRICT_CROSS', inactivatedAt: OCC - BAR });
    assert.strictEqual(producer.wasEligibleAtCandidateOccurrence(z, p.occurredAt, p.metadata.index), false);
});

// ---- T11: eligibility evaluation must NOT mutate the anchor lifecycle ----
test('T11 eligibility evaluation does not mutate anchor lifecycle', function () {
    var p = pivot('P', 'LOW', 20, 100);
    var z = point('Z', 'LOW', 10, 100); // ACTIVE
    var snapState = z.state, snapBy = z.inactivatedBy, snapAt = z.inactivatedAt, snapConfirmed = z.confirmedAt;
    var eligible = producer.eligibleHistoricalPoints(state([z]), p);
    assert.strictEqual(z.state, snapState);
    assert.strictEqual(z.inactivatedBy, snapBy);
    assert.strictEqual(z.inactivatedAt, snapAt);
    assert.strictEqual(z.confirmedAt, snapConfirmed);
    assert.strictEqual(eligible.length, 1);
    assert.strictEqual(eligible[0].id, z.id);
});

// ---- T12: deterministic across repeated independent runs ----
test('T12 deterministic eligibility across repeated independent runs', function () {
    function run() {
        var p = pivot('P', 'LOW', 20, 100);
        var z = point('Z', 'LOW', 10, 100);
        return producer.evaluatePivot(state([z]), p);
    }
    var a = run(), b = run(), c = run();
    assert.ok(a); assert.ok(b); assert.ok(c);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
    assert.deepStrictEqual(JSON.parse(JSON.stringify(b)), JSON.parse(JSON.stringify(c)));
});

// ---- T13: eligibility consults no post-occurrence state (no future data) ----
test('T13 eligibility consults only immutable fields, no future candle state', function () {
    var p = pivot('P', 'LOW', 20, 100);
    // an anchor with a far-future inactivation timestamp is still NOT eligible:
    // eligibility reads only occurredAt/confirmedAt/occurredBarIndex/state.
    var z = point('Z', 'LOW', 10, 100, { state: 'INACTIVE', inactivatedBy: 'AGE_EXPIRY', inactivatedAt: 30 * BAR });
    assert.strictEqual(producer.wasEligibleAtCandidateOccurrence(z, p.occurredAt, p.metadata.index), false);
    var keys = Object.keys(z);
    assert.strictEqual(keys.indexOf('violatedAt') === -1, true); // legacy field removed
    assert.strictEqual(keys.indexOf('state') !== -1, true);       // new lifecycle field
});

// ---- T14: replacement contract uses Causal Dynamic D lifecycle (no legacy ZigZag) ----
test('T14 replacement uses Causal Dynamic D anchors (state lifecycle), no ZigZag version', function () {
    assert.strictEqual(dynamicD.VERSION, 'CAUSAL_DYNAMIC_D_V1');
    assert.strictEqual(producer.VERSION, 'DYNAMIC_D_36H_CROSS_SOURCE_V1');
    assert.notStrictEqual(producer.VERSION, 'ATR50_36H_UNVIOLATED_CROSS_SOURCE_V1');
});

// ---- INTEGRATION: ACTIVE anchor within frozen tolerance pairs at occurrence ----
test('INTEGRATION ACTIVE anchor pairs within frozen tolerance (replaces old violatedAt>=occurrence admission)', function () {
    // anchor LOW 4.651 @ 09:05 confirmed ~09:25 (ACTIVE); candidate LOW 4.657 @ 17:10
    var anchorOccurredAt = Date.UTC(2026, 8, 2, 1, 5, 0);  // 09:05 +8
    var anchorConfirmedAt = Date.UTC(2026, 8, 2, 1, 25, 0); // 09:25 +8
    var candOccurredAt = Date.UTC(2026, 8, 2, 9, 10, 0);    // 17:10 +8
    var candConfirmedAt = Date.UTC(2026, 8, 2, 9, 25, 0);   // 17:25 +8
    var anchorIdx = 108, candIdx = 206; // 09:05 and 17:10 from 00:00, 5m spacing

    var z = {
        id: 'A', pointSide: 'LOW', price: 4.651, selectorPrice: 4.651,
        occurredAt: anchorOccurredAt, confirmedAt: anchorConfirmedAt,
        occurredBarIndex: anchorIdx, state: 'ACTIVE',
        inactivatedBy: null, inactivatedAt: null
    };
    var p = {
        id: 'P', symbol: 'X', timeframe: '5m', type: 'SWING_LOW', side: 'SSL',
        price: 4.657, sourceOpenTime: candOccurredAt, sourceCloseTime: candOccurredAt + BAR - 1,
        occurredAt: candOccurredAt, confirmedAt: candConfirmedAt,
        metadata: { index: candIdx, right: 2 }
    };
    // eligibility at candidate occurrence
    assert.strictEqual(producer.wasEligibleAtCandidateOccurrence(z, candOccurredAt, candIdx), true);
    // evaluate full pairing (tolerance uses state.fiveMinuteAtrValue * 0.7)
    var s = state([z]);
    s.fiveMinuteAtrValue = 0.01; // tolerance = 0.007 >= |4.657 - 4.651| = 0.006
    var ev = producer.evaluatePivot(s, p);
    assert.ok(ev, 'EQL should be created when within frozen tolerance');
    assert.strictEqual(ev.type, 'EQL');
    // within tolerance and not a strict cross -> currentTradesThroughHistorical false
    assert.strictEqual(ev.metadata.historicalPartners[0].currentTradesThroughHistorical, false);
});

console.log('\nProduction EQ Temporal Eligibility V1: ' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
