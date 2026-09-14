'use strict';

/**
 * EQ_ANCHOR_INTEGRATION_TESTS — HISTORICAL_TURNING_POINT_SIGNIFICANCE_V1 inside
 * the production EQ pipeline (spec §44-§47, §68).
 *
 * The eligibility layer may only narrow the historical-anchor candidate universe.
 * The Current Point (causal 2L/2R), the Wilders ATR14 x 0.7 tolerance, the
 * ordinary-2/2 strict-cross rule and the deterministic partner selection must all
 * be untouched.
 */

var assert = require('assert');
var contract = require('../semantic/turningPointSignificanceSemanticV1');
var eq = require('../liquidity/productionEqualLiquidityV1');
var eligibilityModule = require('../liquidity/historicalAnchorEligibilityV1');
var fixtures = require('./fixtures/turningPointSignificanceV1');

var passed = 0;
function check(name, fn) { fn(); passed += 1; console.log('PASS ' + name); }

var T0 = fixtures.BASE_TIME;
function at(index) { return T0 + index * fixtures.BAR_MS; }

var CONFIG = Object.freeze({
    semanticEnabled: true, liveFilterEnabled: true, failClosed: true,
    minimumConfidence: 'MEDIUM', allowedLabels: Object.freeze(['SIGNIFICANT', 'VALID'])
});

function result(significance, confidence, eligible) {
    return {
        status: 'AVAILABLE', eligible: eligible,
        decision: { significance: significance, confidence: confidence,
            primaryReason: 'INDEPENDENT_DIRECTIONAL_TURN', evidence: ['fact based'], counterEvidence: [] },
        factsHash: 'a'.repeat(64), promptHash: contract.PROMPT_SHA256,
        decisionKey: 'b'.repeat(64), semanticVersion: contract.VERSION,
        gateResult: eligible ? 'PASS' : 'BLOCK',
        gateReason: eligible ? null : 'TURNING_SIGNIFICANCE_' + significance
    };
}

function registryWith(entries) {
    var registry = eligibilityModule.createRegistry({ config: CONFIG });
    entries.forEach(function (entry) { registry.publish(entry.point, entry.result); });
    return registry;
}

// A valid HIGH EQ needs the anchor at or above the pivot wick, otherwise the
// existing ordinary-2/2 strict-cross rule invalidates it before tolerance is read.
function anchors() {
    return [
        fixtures.anchorPoint({ pointSide: 'HIGH', price: 100.4, occurredAt: at(400),
            confirmedAt: at(401), occurredBarIndex: 400 }),
        fixtures.anchorPoint({ pointSide: 'HIGH', price: 100.6, occurredAt: at(300),
            confirmedAt: at(301), occurredBarIndex: 300 })
    ];
}
var NEAR = anchors()[0];
var FAR = anchors()[1];

/** Fresh clones each time: evaluatePivot mutates anchor lifecycle. */
function eqState(registry, points) {
    var state = eq.createState({ symbol: 'TESTUSDT', anchorEligibility: registry });
    state.fiveMinuteAtrValue = 10;   // tolerance = 10 * 0.7 = 7
    state.dynamicD.recentSurvivalPoints = points || anchors();
    return state;
}
function pivot(index, price) {
    return fixtures.pivotPoint({ type: 'SWING_HIGH', price: price, occurredAt: at(index),
        confirmedAt: at(index + 2), index: index });
}
var PIVOT = pivot(500, 100.2);

check('A. a blocked nearest candidate leaves the universe and the eligible next one is used', function () {
    // Baseline: with no eligibility filter both anchors pair (legacy universe).
    var legacy = eq.evaluatePivot(eqState(null), PIVOT);
    assert.strictEqual(legacy.metadata.historicalPartners.length, 2);

    // Only the WEAK anchor is known -> universe narrows to nothing.
    var blockedOnly = registryWith([{ point: NEAR, result: result('WEAK', 'HIGH', false) }]);
    assert.strictEqual(eq.evaluatePivot(eqState(blockedOnly), PIVOT), null);

    // WEAK blocked, VALID eligible -> exactly the eligible anchor remains, and it
    // is never silently replaced by the blocked one.
    var mixed = registryWith([
        { point: NEAR, result: result('WEAK', 'HIGH', false) },
        { point: FAR, result: result('VALID', 'HIGH', true) }
    ]);
    var narrowed = eq.evaluatePivot(eqState(mixed), PIVOT);
    assert.strictEqual(narrowed.metadata.historicalPartners.length, 1);
    assert.strictEqual(narrowed.metadata.historicalPartners[0].id, FAR.id);
    assert.strictEqual(narrowed.metadata.historicalPartners[0].price, 100.6);

    // Ordering of the surviving partner set is the legacy chronological order.
    var allEligible = registryWith([
        { point: NEAR, result: result('SIGNIFICANT', 'HIGH', true) },
        { point: FAR, result: result('VALID', 'HIGH', true) }
    ]);
    var both = eq.evaluatePivot(eqState(allEligible), PIVOT);
    assert.strictEqual(both.metadata.historicalPartners.length, 2);
    assert.strictEqual(both.metadata.primaryPartnerSelection, false);
});

check('B. every candidate blocked yields no partner, no EQ, and the pipeline continues', function () {
    var allBlocked = registryWith([
        { point: NEAR, result: result('WEAK', 'HIGH', false) },
        { point: FAR, result: result('UNCLEAR', 'HIGH', false) }
    ]);
    var state = eqState(allBlocked);
    assert.strictEqual(eq.evaluatePivot(state, PIVOT), null);
    assert.strictEqual(state.events.length, 0);

    // The SAME engine state keeps working: hydrate one anchor to eligible and the
    // next pivot produces an EQ. No symbol pause, no state corruption.
    allBlocked.publish(FAR, result('SIGNIFICANT', 'HIGH', true));
    var second = eq.evaluatePivot(state, pivot(600, 100.5));
    assert.ok(second, 'the pipeline must continue after a fully blocked universe');
    assert.strictEqual(second.metadata.historicalPartners.length, 1);
    assert.strictEqual(second.metadata.historicalPartners[0].id, FAR.id);
    assert.strictEqual(state.events.length, 1);
});

check('C. the Current Point stays causal 2L/2R and is never significance filtered', function () {
    var mixed = registryWith([{ point: FAR, result: result('VALID', 'HIGH', true) }]);
    var event = eq.evaluatePivot(eqState(mixed), PIVOT);
    assert.strictEqual(event.metadata.currentPivot.source, 'ORDINARY_CAUSAL_2X2');
    assert.strictEqual(event.metadata.currentPivot.price, PIVOT.price);
    assert.strictEqual(event.metadata.currentPivot.occurredAt, PIVOT.occurredAt);
    assert.strictEqual(event.metadata.currentPivot.confirmedAt, PIVOT.confirmedAt);
    assert.strictEqual(event.metadata.currentPivot.side, 'HIGH');
    assert.strictEqual(event.metadata.currentPivot.sourceIndex, PIVOT.metadata.index);
    // The Current Point is deliberately not a historical partner.
    assert.ok(event.metadata.historicalPartners.every(function (p) { return p.id !== PIVOT.id; }));
});

check('D. the EQ tolerance remains Wilders ATR14 x 0.7 and other EQ semantics are unchanged', function () {
    var thresholds = require('../config/thresholds');
    var mixed = registryWith([{ point: FAR, result: result('VALID', 'HIGH', true) }]);
    var event = eq.evaluatePivot(eqState(mixed), PIVOT);
    assert.strictEqual(event.metadata.historicalPartners[0].eqTolerance, 10 * 0.7);
    assert.strictEqual(thresholds.equalLiquidity.priceStrongMaxATR, 0.7);
    assert.strictEqual(thresholds.equalLiquidity.atrPeriod, 14);
    assert.strictEqual(event.metadata.pairwiseToleranceAtrMultiplier, 0.7);
    assert.strictEqual(event.metadata.pairwiseToleranceAtrPeriod, 14);
    assert.strictEqual(event.metadata.historicalAnchorMustRemainActive, true);
    assert.strictEqual(event.metadata.strictInequalityForViolation, true);
    assert.strictEqual(event.metadata.touchCountsAsViolation, false);
    assert.strictEqual(event.metadata.primaryPartnerSelection, false);
    assert.strictEqual(event.metadata.historicalSource, 'CAUSAL_DYNAMIC_D_V1');
    assert.strictEqual(event.metadata.historicalExtremeLocalization, 'SAME_PROCESS_WICK_V1');
});

check('D2. an eligible but out-of-tolerance candidate still never enters the universe', function () {
    var farOut = fixtures.anchorPoint({ pointSide: 'HIGH', price: 140, occurredAt: at(350),
        confirmedAt: at(351), occurredBarIndex: 350 });
    var registry = registryWith([{ point: farOut, result: result('SIGNIFICANT', 'HIGH', true) }]);
    assert.strictEqual(eq.evaluatePivot(eqState(registry, [farOut]), PIVOT), null);
});

check('D3. an eligible candidate above the wick is still invalidated by ordinary strict cross', function () {
    // Anchor below the pivot wick: price was traded through, so it is INACTIVE
    // regardless of how significant the semantic layer found it.
    var crossed = fixtures.anchorPoint({ pointSide: 'HIGH', price: 99.0, occurredAt: at(400),
        confirmedAt: at(401), occurredBarIndex: 400 });
    var registry = registryWith([{ point: crossed, result: result('SIGNIFICANT', 'HIGH', true) }]);
    var state = eqState(registry, [crossed]);
    assert.strictEqual(eq.evaluatePivot(state, PIVOT), null);
    assert.strictEqual(crossed.state, 'INACTIVE');
    assert.strictEqual(crossed.inactivatedBy, 'STRICT_CROSS');
});

check('D4. age expiry can never fire inside the 432-bar window, so it never competes with significance', function () {
    var dynamicD = require('../liquidity/causalDynamicDHistoricalExtremes');
    // Worst case inside the window: the anchor sits at the far edge of the
    // 432-bar lookback, which is still only ~36h of calendar age.
    var maxAgeMs = (dynamicD.LOOKBACK_BARS + 1) * fixtures.BAR_MS;
    assert.ok(maxAgeMs < dynamicD.FIVE_DAYS_MS,
        'age expiry must be unreachable within the frozen lookback window');
    // And the production expiry predicate agrees for the widest legal pair.
    var anchor = fixtures.anchorPoint({ pointSide: 'HIGH', price: 100.4, occurredAt: at(68),
        confirmedAt: at(69), occurredBarIndex: 68 });
    assert.strictEqual(dynamicD.isAgeExpired(anchor, at(500)), false);
    assert.strictEqual(500 - 68, dynamicD.LOOKBACK_BARS);
});

check('E. the filter applies to the historical side only, never the opposite side', function () {
    var opposite = fixtures.anchorPoint({ pointSide: 'LOW', price: 100.4, occurredAt: at(300),
        confirmedAt: at(301), occurredBarIndex: 300 });
    var registry = registryWith([{ point: opposite, result: result('SIGNIFICANT', 'HIGH', true) }]);
    // A LOW anchor is never in a SWING_HIGH pivot's universe, eligible or not.
    assert.strictEqual(eq.evaluatePivot(eqState(registry, [opposite]), PIVOT), null);
    assert.strictEqual(eq.evaluatePivot(eqState(null, [opposite]), PIVOT), null,
        'the legacy path must exclude it for the same reason');
});

check('F. enabling the filter is inert when every candidate is eligible', function () {
    var allEligible = registryWith([
        { point: NEAR, result: result('SIGNIFICANT', 'HIGH', true) },
        { point: FAR, result: result('VALID', 'HIGH', true) }
    ]);
    var filtered = eq.evaluatePivot(eqState(allEligible), PIVOT);
    var legacy = eq.evaluatePivot(eqState(null), PIVOT);
    assert.deepStrictEqual(
        filtered.metadata.historicalPartners.map(function (p) { return p.id; }),
        legacy.metadata.historicalPartners.map(function (p) { return p.id; }),
        'an all-eligible universe must reproduce the legacy partner set exactly');
    assert.deepStrictEqual(
        filtered.metadata.historicalPartners.map(function (p) { return p.eqTolerance; }),
        legacy.metadata.historicalPartners.map(function (p) { return p.eqTolerance; }));
});

check('G. a candidate with no resolved decision is fail-closed and does not throw', function () {
    var unresolved = fixtures.anchorPoint({ pointSide: 'HIGH', price: 100.6, occurredAt: at(300),
        confirmedAt: at(301), occurredBarIndex: 300 });
    var registry = eligibilityModule.createRegistry({ config: CONFIG });
    assert.strictEqual(eq.evaluatePivot(eqState(registry, [unresolved]), PIVOT), null,
        'an unresolved anchor must never be treated as eligible');
});

check('H. the rollback restores the legacy Dynamic-D universe immediately', function () {
    var mixed = registryWith([
        { point: NEAR, result: result('WEAK', 'HIGH', false) },
        { point: FAR, result: result('VALID', 'HIGH', true) }
    ]);
    var state = eqState(mixed);
    assert.strictEqual(eq.evaluatePivot(state, PIVOT).metadata.historicalPartners.length, 1);

    // TURNING_SIGNIFICANCE_LIVE_FILTER_ENABLED=false equivalent: detach the filter.
    eq.setAnchorEligibility(state, null);
    state.dynamicD.recentSurvivalPoints = anchors();
    var restored = eq.evaluatePivot(state, pivot(700, 100.2));
    assert.strictEqual(restored.metadata.historicalPartners.length, 2,
        'rollback must restore the full legacy anchor universe');
    assert.deepStrictEqual(restored.metadata.historicalPartners.map(function (p) { return p.id; }),
        anchors().map(function (p) { return p.id; }));
});

check('I. eligibility narrows the universe without mutating anchor identity or lifecycle', function () {
    var mixed = registryWith([{ point: FAR, result: result('VALID', 'HIGH', true) }]);
    var points = anchors();
    var before = JSON.stringify(points[1]);
    var event = eq.evaluatePivot(eqState(mixed, points), PIVOT);
    assert.strictEqual(JSON.stringify(points[1]), before, 'the anchor must not be mutated');
    assert.strictEqual(points[1].state, 'ACTIVE');
    var partner = event.metadata.historicalPartners[0];
    assert.strictEqual(partner.processId, points[1].processId);
    assert.strictEqual(partner.side, 'HIGH');
    assert.strictEqual(partner.localizedExtremePrice, points[1].localizedExtremePrice);
    assert.strictEqual(partner.localizationMode, 'SAME_PROCESS_WICK_V1');
    assert.strictEqual(partner.occurredAt, points[1].occurredAt);
    assert.strictEqual(partner.confirmedAt, points[1].confirmedAt);
    assert.strictEqual(partner.unviolated, true);
    assert.strictEqual(partner.selectorPrice, points[1].selectorPrice);
});

check('J. a blocked anchor consulted as an EQ partner candidate is archived once per context', function () {
    var archived = [];
    var registry = eligibilityModule.createRegistry({
        config: CONFIG,
        archiveBlock: function (record, context) { archived.push({ record: record, context: context }); }
    });
    registry.publish(NEAR, result('WEAK', 'HIGH', false));
    registry.isEligible(NEAR, 'EQ_PARTNER_CANDIDATE');
    registry.isEligible(NEAR, 'EQ_PARTNER_CANDIDATE');
    registry.isEligible(NEAR, 'TP_TARGET_CANDIDATE');
    assert.strictEqual(archived.length, 2, 'one record per distinct candidate context');
    assert.strictEqual(archived[0].context, 'EQ_PARTNER_CANDIDATE');
    assert.strictEqual(archived[1].context, 'TP_TARGET_CANDIDATE');
    assert.deepStrictEqual(archived[1].record.candidateContext,
        ['EQ_PARTNER_CANDIDATE', 'TP_TARGET_CANDIDATE']);
    // An eligible anchor never produces a block archive.
    var eligibleArchive = [];
    var other = eligibilityModule.createRegistry({
        config: CONFIG,
        archiveBlock: function (record, context) { eligibleArchive.push(context); }
    });
    other.publish(FAR, result('VALID', 'HIGH', true));
    assert.strictEqual(other.isEligible(FAR, 'EQ_PARTNER_CANDIDATE'), true);
    assert.strictEqual(eligibleArchive.length, 0);
});

console.log('\nEQ_ANCHOR_INTEGRATION_TESTS=PASS (' + passed + ' checks)');
