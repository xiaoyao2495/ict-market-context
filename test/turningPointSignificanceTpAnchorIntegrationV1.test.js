'use strict';

/**
 * TP_ANCHOR_INTEGRATION_TESTS — HISTORICAL_TURNING_POINT_SIGNIFICANCE_V1 inside
 * the production Dynamic-D target selection (spec §48-§49, §69).
 *
 * Only the eligible anchor universe may narrow. The ACTIVE semantics, the
 * opposite-side rule, the profitability-side rule, the trade-through rule, the
 * nearest ordering, the single-target rule, the Entry/SL geometry, the RR gate
 * and position sizing must all be untouched.
 */

var assert = require('assert');
var contract = require('../semantic/turningPointSignificanceSemanticV1');
var rules = require('../execution/executionRulesV1');
var eligibilityModule = require('../liquidity/historicalAnchorEligibilityV1');
var fixtures = require('./fixtures/turningPointSignificanceV1');

var passed = 0;
function check(name, fn) { fn(); passed += 1; console.log('PASS ' + name); }

var T0 = fixtures.BASE_TIME;
function at(index) { return T0 + index * fixtures.BAR_MS; }
var DECISION_TIME = at(900);

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

function target(id, price, options) {
    var opts = options || {};
    return fixtures.anchorPoint({
        id: id, pointSide: opts.side || 'HIGH', price: price,
        occurredAt: opts.occurredAt || at(700), confirmedAt: opts.confirmedAt || at(701),
        occurredBarIndex: opts.occurredBarIndex || 700, state: opts.state || 'ACTIVE'
    });
}

var NEAR_TARGET = target('TGT_NEAR', 110, { occurredBarIndex: 700 });
var FAR_TARGET = target('TGT_FAR', 130, { occurredBarIndex: 600 });

var BIAS = Object.freeze({
    status: 'AVAILABLE', closedAt: 1000,
    semantic: { direction: 'BULLISH', strength: 'STRONG', confidence: 'HIGH' }
});
var SYMBOL_RULES = Object.freeze({
    source: 'futures', tickSize: 0.1, stepSize: 0.001, minQty: 0.001, maxQty: 1000,
    minNotional: 0, minPrice: 0.01, maxPrice: 0
});

function event() {
    return {
        symbol: 'TESTUSDT', watchId: 'W1', liquidityId: 'EQ1', liquidityType: 'EQL',
        rawFvg: { id: 'FVG1', k3Index: 890, low: 99, high: 101, confirmedAt: DECISION_TIME,
            direction: 'BULLISH' },
        eqSourceContext: {
            status: 'AVAILABLE',
            currentPivot: { id: 'CP1', price: 95, occurredAt: at(880), confirmedAt: at(882) },
            historicalPartners: [fixtures.anchorPoint({ pointSide: 'HIGH', price: 96,
                occurredAt: at(700), confirmedAt: at(701), occurredBarIndex: 700 })]
        }
    };
}

function context(registry, points) {
    return {
        tradeId: 'TRADE1', liveTradingEnabled: false, bias: BIAS, expected4hClosedAt: 1000,
        dynamicDPoints: points || [NEAR_TARGET, FAR_TARGET], candles: [],
        symbolRules: SYMBOL_RULES, anchorEligibility: registry || undefined
    };
}

check('A. a blocked nearest target is skipped for the next eligible anchor', function () {
    // Legacy (no filter): nearest is 110.
    var legacy = rules.buildEntryPlan(event(), context(null));
    assert.strictEqual(legacy.ok, true);
    var legacyTarget = rules.selectTarget('LONG', 100, [NEAR_TARGET, FAR_TARGET], [], DECISION_TIME);
    assert.strictEqual(legacyTarget.id, 'TGT_NEAR');
    assert.strictEqual(legacy.plan.targetDynamicDId, 'TGT_NEAR');
    assert.strictEqual(legacy.plan.targetPrice, 110);
    assert.strictEqual(legacy.plan.initialRR, 2);   // risk 5, reward 10

    // NEAR blocked, FAR eligible -> the selector must move on, never fall back.
    var registry = registryWith([
        { point: NEAR_TARGET, result: result('WEAK', 'HIGH', false) },
        { point: FAR_TARGET, result: result('SIGNIFICANT', 'HIGH', true) }
    ]);
    var filteredTarget = rules.selectTarget('LONG', 100, [NEAR_TARGET, FAR_TARGET], [], DECISION_TIME, registry);
    assert.strictEqual(filteredTarget.id, 'TGT_FAR');
    var filtered = rules.buildEntryPlan(event(), context(registry));
    assert.strictEqual(filtered.ok, true);
    assert.strictEqual(filtered.plan.targetDynamicDId, 'TGT_FAR');
    assert.strictEqual(filtered.plan.targetPrice, 130);
    assert.strictEqual(filtered.plan.initialRR, 6); // risk 5, reward 30
    assert.strictEqual(filtered.plan.targetAnchorSignificance.significance, 'SIGNIFICANT');
    assert.strictEqual(filtered.plan.targetAnchorSignificance.confidence, 'HIGH');
    assert.strictEqual(filtered.plan.targetAnchorSignificance.eligible, true);
});

check('B. with no eligible target the existing no-target semantics apply and no TP is invented', function () {
    var allBlocked = registryWith([
        { point: NEAR_TARGET, result: result('WEAK', 'HIGH', false) },
        { point: FAR_TARGET, result: result('UNCLEAR', 'HIGH', false) }
    ]);
    assert.strictEqual(rules.selectTarget('LONG', 100, [NEAR_TARGET, FAR_TARGET], [], DECISION_TIME, allBlocked), null);
    var built = rules.buildEntryPlan(event(), context(allBlocked));
    assert.strictEqual(built.ok, false);
    assert.strictEqual(built.reasonCode, 'NO_VALID_DYNAMIC_D_TARGET');
    assert.strictEqual(built.plan.targetPrice, undefined);
    assert.strictEqual(built.plan.targetDynamicDId, undefined);
    assert.strictEqual(built.plan.initialRR, undefined);

    // An empty eligible universe behaves exactly like an empty candidate list.
    var empty = rules.selectTarget('LONG', 100, [], [], DECISION_TIME, allBlocked);
    assert.strictEqual(empty, null);
});

check('C. an already-frozen plan is never retroactively re-targeted', function () {
    var frozen = rules.buildEntryPlan(event(), context(null));
    assert.strictEqual(frozen.plan.targetDynamicDId, 'TGT_NEAR');
    assert.strictEqual(frozen.plan.targetConfirmedAt, NEAR_TARGET.confirmedAt);

    // The semantic layer later blocks the anchor that plan already committed to.
    var registry = registryWith([{ point: NEAR_TARGET, result: result('WEAK', 'HIGH', false) }]);
    var future = rules.buildEntryPlan(event(), context(registry));

    assert.strictEqual(frozen.plan.targetDynamicDId, 'TGT_NEAR',
        'the existing lifecycle keeps its frozen plan');
    assert.strictEqual(frozen.plan.targetPrice, 110);
    assert.strictEqual(frozen.plan.initialRR, 2);
    assert.notStrictEqual(frozen.plan.targetDynamicDId, future.plan.targetDynamicDId,
        'only plans created after the filter applies may differ');
});

check('D. the filter is inert when every candidate is eligible', function () {
    var allEligible = registryWith([
        { point: NEAR_TARGET, result: result('SIGNIFICANT', 'HIGH', true) },
        { point: FAR_TARGET, result: result('VALID', 'HIGH', true) }
    ]);
    var legacy = rules.buildEntryPlan(event(), context(null)).plan;
    var filtered = rules.buildEntryPlan(event(), context(allEligible)).plan;

    // Every execution-affecting field must be identical.
    ['entryPrice', 'stopPrice', 'targetPrice', 'targetDynamicDId', 'targetConfirmedAt',
        'targetAnchorPrice', 'initialRR', 'requestedQty', 'targetNotional', 'initialRiskPrice',
        'initialRewardPrice', 'eqPrice', 'eqOccurredAt', 'eqConfirmedAt'].forEach(function (key) {
        assert.deepStrictEqual(filtered[key], legacy[key], 'execution field drifted: ' + key);
    });

    // The only permitted difference is the ADDED semantic provenance. Nothing
    // execution-relevant may change when every candidate is eligible.
    var differing = Object.keys(legacy).filter(function (key) {
        return JSON.stringify(legacy[key]) !== JSON.stringify(filtered[key]);
    });
    assert.deepStrictEqual(differing, ['targetAnchorSignificance'],
        'the only diff must be the added significance provenance, got: ' + differing.join(','));
    assert.strictEqual(legacy.targetAnchorSignificance, null);
    assert.strictEqual(filtered.targetAnchorSignificance.turningPointId, NEAR_TARGET.id);
    assert.strictEqual(filtered.targetAnchorSignificance.eligible, true);
});

check('E. ACTIVE and side semantics are unchanged by the filter', function () {
    var inactive = target('TGT_INACTIVE', 105, { occurredBarIndex: 800, state: 'INACTIVE' });
    var opposite = target('TGT_OPPOSITE', 108, { side: 'LOW', occurredBarIndex: 820 });
    var wrongSide = rules.selectTarget('LONG', 100, [inactive, opposite], [], DECISION_TIME, null);
    assert.strictEqual(wrongSide, null, 'INACTIVE and wrong-side candidates must always be excluded');
    // Even an eligible INACTIVE anchor must not be selected.
    var registry = registryWith([{ point: inactive, result: result('SIGNIFICANT', 'HIGH', true) }]);
    assert.strictEqual(rules.selectTarget('LONG', 100, [inactive], [], DECISION_TIME, registry), null);
    // And a fully eligible candidate below entry is still not a LONG target.
    var below = target('TGT_BELOW', 90, { occurredBarIndex: 830 });
    var belowRegistry = registryWith([{ point: below, result: result('SIGNIFICANT', 'HIGH', true) }]);
    assert.strictEqual(rules.selectTarget('LONG', 100, [below], [], DECISION_TIME, belowRegistry), null);
    // A candidate confirmed after the decision time is excluded regardless.
    var future = target('TGT_FUTURE', 115, { occurredBarIndex: 880, confirmedAt: DECISION_TIME + 1,
        occurredAt: DECISION_TIME - 1000 });
    var futureRegistry = registryWith([{ point: future, result: result('SIGNIFICANT', 'HIGH', true) }]);
    assert.strictEqual(rules.selectTarget('LONG', 100, [future], [], DECISION_TIME, futureRegistry), null);
});

check('F. trade-through semantics are unchanged by the filter', function () {
    var point = target('TGT_THROUGH', 110, { occurredBarIndex: 700 });
    var candles = [{ openTime: 0, open: 110, high: 120, low: 109, close: 115,
        closeTime: DECISION_TIME - 1, closed: true, source: 'futures' }];
    var registry = registryWith([{ point: point, result: result('SIGNIFICANT', 'HIGH', true) }]);
    assert.strictEqual(rules.selectTarget('LONG', 100, [point], candles, DECISION_TIME, null), null);
    assert.strictEqual(rules.selectTarget('LONG', 100, [point], candles, DECISION_TIME, registry), null,
        'an eligible anchor is still rejected once it has been traded through');
});

check('G. nearest ordering is preserved among eligible anchors', function () {
    var registry = registryWith([
        { point: NEAR_TARGET, result: result('VALID', 'HIGH', true) },
        { point: FAR_TARGET, result: result('SIGNIFICANT', 'HIGH', true) }
    ]);
    var selected = rules.selectTarget('LONG', 100, [FAR_TARGET, NEAR_TARGET], [], DECISION_TIME, registry);
    assert.strictEqual(selected.id, 'TGT_NEAR', 'input order must not override nearest-first');
    assert.strictEqual(rules.selectTarget('LONG', 100, [NEAR_TARGET, FAR_TARGET], [], DECISION_TIME, registry).id,
        'TGT_NEAR');
});

check('H. a single target, all-or-nothing, is unchanged', function () {
    var registry = registryWith([
        { point: NEAR_TARGET, result: result('VALID', 'HIGH', true) },
        { point: FAR_TARGET, result: result('VALID', 'HIGH', true) }
    ]);
    var selected = rules.selectTarget('LONG', 100, [NEAR_TARGET, FAR_TARGET], [], DECISION_TIME, registry);
    assert.strictEqual(Array.isArray(selected), false, 'a single target object is returned');
    var plan = rules.buildEntryPlan(event(), context(registry)).plan;
    assert.strictEqual(plan.targetPrice, 110);
    assert.strictEqual(plan.targetAnchorPrice, 110);
});

check('I. the Entry, SL, RR and sizing rules are untouched by the filter', function () {
    var registry = registryWith([
        { point: NEAR_TARGET, result: result('WEAK', 'HIGH', false) },
        { point: FAR_TARGET, result: result('SIGNIFICANT', 'HIGH', true) }
    ]);
    var legacy = rules.buildEntryPlan(event(), context(null)).plan;
    var filtered = rules.buildEntryPlan(event(), context(registry)).plan;

    assert.strictEqual(rules.MIN_INITIAL_RR, 1);
    // ENTRY = matching FVG midpoint LIMIT.
    assert.strictEqual(filtered.entryPrice, 100);
    assert.strictEqual(legacy.entryPrice, 100);
    // SL = original EQ invalidation wick, derived from the Current Point.
    assert.strictEqual(filtered.stopPrice, 95);
    assert.strictEqual(legacy.stopPrice, 95);
    assert.strictEqual(filtered.eqPrice, 95);
    // Position sizing depends on entry only, so it must not move.
    assert.strictEqual(filtered.requestedQty, legacy.requestedQty);
    assert.strictEqual(filtered.targetNotional, legacy.targetNotional);
    // Only the reward side follows the newly selected anchor.
    assert.strictEqual(filtered.initialRiskPrice, legacy.initialRiskPrice);
    assert.ok(filtered.initialRR >= rules.MIN_INITIAL_RR);
    assert.ok(legacy.initialRR >= rules.MIN_INITIAL_RR);
    // HTF gate carries through unchanged.
    assert.strictEqual(filtered.htfDirection, 'BULLISH');
    assert.strictEqual(filtered.htfStrength, 'STRONG');
    assert.strictEqual(filtered.htfConfidence, 'HIGH');
});

check('J. an eligible target below the RR floor is still rejected by the RR gate', function () {
    // stop 95 -> risk 5; a 104 target gives reward 4 -> RR 0.8 < 1.
    var thin = target('TGT_THIN', 104, { occurredBarIndex: 850 });
    var registry = registryWith([{ point: thin, result: result('SIGNIFICANT', 'HIGH', true) }]);
    var built = rules.buildEntryPlan(event(), context(registry, [thin]));
    assert.strictEqual(built.ok, false);
    assert.strictEqual(built.reasonCode, 'TRADE_SPACE_INSUFFICIENT');
    assert.strictEqual(built.plan.targetPrice, 104, 'the rejected geometry is still reported for audit');
});

check('K. the 4H bias gate still blocks before any target is considered', function () {
    var registry = registryWith([{ point: NEAR_TARGET, result: result('VALID', 'HIGH', true) }]);
    var weakBias = Object.assign({}, context(registry), {
        bias: { status: 'AVAILABLE', closedAt: 1000,
            semantic: { direction: 'BULLISH', strength: 'WEAK', confidence: 'HIGH' } }
    });
    var built = rules.buildEntryPlan(event(), weakBias);
    assert.strictEqual(built.ok, false);
    assert.strictEqual(built.reasonCode, 'HTF_NOT_STRONG');
});

check('L. the EQ historical anchor significance is recorded separately from the TP anchor', function () {
    var eqAnchor = fixtures.anchorPoint({ pointSide: 'HIGH', price: 96, occurredAt: at(700),
        confirmedAt: at(701), occurredBarIndex: 700 });
    var registry = registryWith([
        { point: eqAnchor, result: result('VALID', 'HIGH', true) },
        { point: FAR_TARGET, result: result('SIGNIFICANT', 'HIGH', true) }
    ]);
    var ctx = context(registry, [FAR_TARGET]);
    ctx.event = null;
    var e = event();
    e.eqSourceContext.historicalPartners = [eqAnchor];
    var plan = rules.buildEntryPlan(e, ctx).plan;
    assert.strictEqual(plan.eqHistoricalAnchorSignificance.length, 1);
    assert.strictEqual(plan.eqHistoricalAnchorSignificance[0].turningPointId, eqAnchor.id);
    assert.strictEqual(plan.eqHistoricalAnchorSignificance[0].significance, 'VALID');
    assert.strictEqual(plan.targetAnchorSignificance.turningPointId, FAR_TARGET.id);
    assert.strictEqual(plan.targetAnchorSignificance.significance, 'SIGNIFICANT');
    assert.notStrictEqual(plan.eqHistoricalAnchorSignificance[0].turningPointId,
        plan.targetAnchorSignificance.turningPointId,
        'two different turning points must be reported separately');
    // The Current Point is never significance filtered.
    assert.strictEqual(plan.eqCurrentPoint.source, undefined);
    assert.strictEqual(plan.eqCurrentPoint.price, 95);
});

check('M. a candidate with no resolved decision is fail-closed for TP as well', function () {
    var unresolved = target('TGT_UNRESOLVED', 110, { occurredBarIndex: 700 });
    var empty = eligibilityModule.createRegistry({ config: CONFIG });
    assert.strictEqual(rules.selectTarget('LONG', 100, [unresolved], [], DECISION_TIME, empty), null);
});

check('N. the rollback restores the legacy target universe immediately', function () {
    var registry = registryWith([
        { point: NEAR_TARGET, result: result('WEAK', 'HIGH', false) },
        { point: FAR_TARGET, result: result('VALID', 'HIGH', true) }
    ]);
    assert.strictEqual(rules.selectTarget('LONG', 100, [NEAR_TARGET, FAR_TARGET], [], DECISION_TIME, registry).id,
        'TGT_FAR');
    // TURNING_SIGNIFICANCE_LIVE_FILTER_ENABLED=false equivalent: no filter passed.
    assert.strictEqual(rules.selectTarget('LONG', 100, [NEAR_TARGET, FAR_TARGET], [], DECISION_TIME, null).id,
        'TGT_NEAR');
});

console.log('\nTP_ANCHOR_INTEGRATION_TESTS=PASS (' + passed + ' checks)');
