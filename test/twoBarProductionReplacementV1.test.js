'use strict';

// TWO_BAR_PRODUCTION_REPLACEMENT_V1 - deterministic core tests.
// Network-free: the LLM is never called here. Covers the setup geometry, the
// direction-only HTF gate, the breakout entry contract, causality and the
// dynamic SL/TP rules.

var assert = require('assert');
var fs = require('fs');
var path = require('path');

var L = require('../research/reversalPatternSemanticAuditV1');
var twoBar = require('../strategy/twoBarReversalV1');
var rules = require('../execution/breakoutEntryRulesV1');
var pm = require('../execution/positionManagementV1');

var passed = 0;
var failed = 0;
function test(name, fn) {
    try {
        fn();
        passed += 1;
        console.log('PASS ' + name);
    } catch (e) {
        failed += 1;
        console.log('FAIL ' + name);
        console.log('  ' + (e && e.message));
    }
}

var BAR = 300000;
function bar(i, o, h, l, c) {
    return { openTime: i * BAR, closeTime: (i + 1) * BAR - 1, open: o, high: h, low: l, close: c,
        closed: true, source: 'futures' };
}

var RULES = { source: 'futures', tickSize: 0.1, stepSize: 0.001, minQty: 0.001, maxQty: 1000,
    minNotional: 5, minPrice: 0.1, maxPrice: 1000000 };

function candidate(direction, k1, k2) {
    return { pattern: 'TWO_BAR_REVERSAL', direction: direction, startIndex: 0, endIndex: 1,
        windowBars: [k1, k2], windowFacts: L ? [] : [], symbol: 'BTCUSDT' };
}

// §50 long setup
function longFixture() {
    var k1 = bar(0, 105, 106, 100, 101);   // bear
    var k2 = bar(1, 101, 103, 99, 102.5);  // bull
    var cp = twoBar.buildCurrentPoint(candidate('BULLISH', k1, k2),
        { symbol: 'BTCUSDT', patternConfidence: 'HIGH', contextConfidence: 'HIGH' });
    var setup = twoBar.buildEqSetup(cp, [{ id: 'DYN_LOW_1', price: 98.5, confirmedAt: 1000,
        occurredAt: 900, occurredBarIndex: 2, eqDistance: 0.5 }], 1.5);
    return { k1: k1, k2: k2, cp: cp, setup: setup };
}

function shortFixture() {
    var k1 = bar(0, 100, 105, 99, 104);    // bull
    var k2 = bar(1, 104, 106, 101, 101.5); // bear
    var cp = twoBar.buildCurrentPoint(candidate('BEARISH', k1, k2),
        { symbol: 'BTCUSDT', patternConfidence: 'HIGH', contextConfidence: 'HIGH' });
    var setup = twoBar.buildEqSetup(cp, [{ id: 'DYN_HIGH_1', price: 106.5, confirmedAt: 1000,
        occurredAt: 900, occurredBarIndex: 2, eqDistance: 0.5 }], 1.5);
    return { k1: k1, k2: k2, cp: cp, setup: setup };
}

test('S50 long: EQL, trigger = two-bar high, SL = min(twoBarLow, D low), TP = nearest high D', function () {
    var f = longFixture();
    assert.strictEqual(f.setup.type, 'EQL');
    assert.strictEqual(f.setup.direction, 'LONG');
    assert.strictEqual(rules.rawEntryTrigger(f.setup), Math.max(f.k1.high, f.k2.high));
    assert.strictEqual(rules.initialStopRaw(f.setup), Math.min(f.cp.twoBarLow, 98.5));
    var plan = rules.buildBreakoutPlan(f.setup, {
        symbolRules: RULES,
        bias: { status: 'AVAILABLE', closedAt: 1000, expectedClosedAt: 1000,
            semantic: { direction: 'BULLISH', strength: 'WEAK', confidence: 'LOW' } },
        currentContractPrice: 101,
        dynamicDPoints: [{ id: 'TP_1', state: 'ACTIVE', pointSide: 'HIGH', price: 120,
            confirmedAt: 900, occurredAt: 800, occurredBarIndex: 5 }],
        candles: [bar(0, 100, 101, 99, 100)]
    });
    assert.strictEqual(plan.ok, true, plan.reasonCode);
    assert.strictEqual(plan.plan.entryPrice, 106);
    assert.strictEqual(plan.plan.initialSL, 98.5);
    assert.strictEqual(plan.plan.initialTP, 120);
    assert.ok(plan.plan.initialRR > 1);
});

test('S51 short mirror: EQH, trigger = two-bar low, SL = max(twoBarHigh, D high)', function () {
    var f = shortFixture();
    assert.strictEqual(f.setup.type, 'EQH');
    assert.strictEqual(f.setup.direction, 'SHORT');
    assert.strictEqual(rules.rawEntryTrigger(f.setup), Math.min(f.k1.low, f.k2.low));
    assert.strictEqual(rules.initialStopRaw(f.setup), Math.max(f.cp.twoBarHigh, 106.5));
    var plan = rules.buildBreakoutPlan(f.setup, {
        symbolRules: RULES,
        bias: { status: 'AVAILABLE', closedAt: 1000, expectedClosedAt: 1000,
            semantic: { direction: 'BEARISH', strength: 'WEAK', confidence: 'LOW' } },
        currentContractPrice: 104,
        dynamicDPoints: [{ id: 'TP_2', state: 'ACTIVE', pointSide: 'LOW', price: 88,
            confirmedAt: 900, occurredAt: 800, occurredBarIndex: 5 }],
        candles: [bar(0, 100, 101, 99, 100)]
    });
    assert.strictEqual(plan.ok, true, plan.reasonCode);
    assert.strictEqual(plan.plan.entryPrice, 99);
    assert.strictEqual(plan.plan.initialSL, 106.5);
    assert.strictEqual(plan.plan.initialTP, 88);
});

test('S49 HTF gate depends on DIRECTION only, never strength or confidence', function () {
    function gate(direction, bias) { return rules.htfDirectionGate(direction, bias); }
    function bias(d, strength, confidence) {
        return { status: 'AVAILABLE', closedAt: 1, expectedClosedAt: 1,
            semantic: { direction: d, strength: strength, confidence: confidence } };
    }
    assert.strictEqual(gate('LONG', bias('BULLISH', 'WEAK', 'LOW')).ok, true);
    assert.strictEqual(gate('LONG', bias('BULLISH', 'MODERATE', 'MEDIUM')).ok, true);
    assert.strictEqual(gate('LONG', bias('BEARISH', 'STRONG', 'HIGH')).reasonCode, 'HTF_NOT_ALIGNED');
    assert.strictEqual(gate('LONG', bias('NO_PRIORITY', 'STRONG', 'HIGH')).reasonCode, 'HTF_NEUTRAL');
    assert.strictEqual(gate('SHORT', bias('BEARISH', 'WEAK', 'LOW')).ok, true);
    assert.strictEqual(gate('SHORT', bias('BULLISH', 'STRONG', 'HIGH')).reasonCode, 'HTF_NOT_ALIGNED');
    assert.strictEqual(gate('LONG', { status: 'PARTIAL' }).reasonCode, 'HTF_UNAVAILABLE');
    assert.strictEqual(gate('LONG', null).reasonCode, 'HTF_UNAVAILABLE');
    assert.strictEqual(gate('LONG', { status: 'AVAILABLE', closedAt: 2, expectedClosedAt: 1,
        semantic: { direction: 'BULLISH' } }).reasonCode, 'HTF_UNAVAILABLE');
});

test('S52 an already-crossed trigger is refused (no chasing, no market order)', function () {
    var f = longFixture();
    var ctx = {
        symbolRules: RULES,
        bias: { status: 'AVAILABLE', closedAt: 1000, expectedClosedAt: 1000,
            semantic: { direction: 'BULLISH', strength: 'WEAK', confidence: 'LOW' } },
        currentContractPrice: 106.5,
        dynamicDPoints: [{ id: 'TP_1', state: 'ACTIVE', pointSide: 'HIGH', price: 120,
            confirmedAt: 900, occurredAt: 800, occurredBarIndex: 5 }],
        candles: [bar(0, 100, 101, 99, 100)]
    };
    var plan = rules.buildBreakoutPlan(f.setup, ctx);
    assert.strictEqual(plan.ok, false);
    assert.strictEqual(plan.reasonCode, 'ENTRY_TRIGGER_ALREADY_CROSSED');
    var g = shortFixture();
    var plan2 = rules.buildBreakoutPlan(g.setup, Object.assign({}, ctx, { currentContractPrice: 98.5,
        bias: { status: 'AVAILABLE', closedAt: 1000, expectedClosedAt: 1000,
            semantic: { direction: 'BEARISH', strength: 'WEAK', confidence: 'LOW' } },
        dynamicDPoints: [{ id: 'TP_2', state: 'ACTIVE', pointSide: 'LOW', price: 88,
            confirmedAt: 900, occurredAt: 800, occurredBarIndex: 5 }] }));
    assert.strictEqual(plan2.reasonCode, 'ENTRY_TRIGGER_ALREADY_CROSSED');
});

test('S53 no future: setup timestamps and EQ availability are causal', function () {
    var f = longFixture();
    assert.strictEqual(f.cp.confirmedAt, f.k2.closeTime);
    assert.strictEqual(f.cp.occurredAt, f.k2.openTime);
    assert.ok(f.cp.occurredAt <= f.cp.confirmedAt);
    assert.strictEqual(f.setup.availableAt, f.k2.closeTime);
    assert.ok(f.setup.availableAt >= f.setup.confirmedAt);
    // a partner confirmed AFTER the two-bar confirmation must not pair
    var late = twoBar.matchDynamicDPartners(
        { recentSurvivalPoints: [{ id: 'LATE', pointSide: 'LOW', price: 98.5, state: 'ACTIVE',
            occurredAt: f.k2.closeTime + BAR, confirmedAt: f.k2.closeTime + 2 * BAR,
            occurredBarIndex: 9 }] },
        f.cp, 2, 1);
    assert.strictEqual(late.length, 0);
});

test('S53b the entry plan decisionTime is the two-bar confirmation, not the trigger time', function () {
    var f = longFixture();
    var plan = rules.buildBreakoutPlan(f.setup, {
        symbolRules: RULES,
        bias: { status: 'AVAILABLE', closedAt: 1000, expectedClosedAt: 1000,
            semantic: { direction: 'BULLISH', strength: 'WEAK', confidence: 'LOW' } },
        currentContractPrice: 101,
        dynamicDPoints: [{ id: 'TP_1', state: 'ACTIVE', pointSide: 'HIGH', price: 110,
            confirmedAt: 900, occurredAt: 800, occurredBarIndex: 5 }],
        candles: [bar(0, 100, 101, 99, 100)]
    });
    assert.strictEqual(plan.plan.decisionTime, f.k2.closeTime);
    assert.strictEqual(plan.plan.entryWorkingType, 'CONTRACT_PRICE');
    assert.strictEqual(plan.plan.protectionWorkingType, 'MARK_PRICE');
});

test('S54 long SL may only tighten upward and never loosens', function () {
    assert.deepStrictEqual(pm.nextStop('LONG', 98, 101, 105), { action: 'UPDATE', newStop: 101, reason: 'TIGHTEN_UP' });
    assert.strictEqual(pm.nextStop('LONG', 101, 99, 105).action, 'IGNORE');
    assert.strictEqual(pm.nextStop('LONG', 101, 106, 105).reason, 'CANDIDATE_NOT_BELOW_MARK');
    assert.deepStrictEqual(pm.nextStop('SHORT', 110, 106, 100), pm.nextStop('SHORT', 110, 106, 100));
    assert.deepStrictEqual(pm.nextStop('SHORT', 110, 106, 100), { action: 'UPDATE', newStop: 106, reason: 'TIGHTEN_DOWN' });
    assert.strictEqual(pm.nextStop('SHORT', 106, 108, 100).action, 'IGNORE');
    // 102 would still be a legal tightening (above the mark); only a candidate at
    // or below the mark is refused
    assert.strictEqual(pm.nextStop('SHORT', 106, 102, 100).action, 'UPDATE');
    assert.strictEqual(pm.nextStop('SHORT', 106, 99, 100).reason, 'CANDIDATE_NOT_ABOVE_MARK');
});

test('S55 target repricing may move in BOTH directions', function () {
    assert.strictEqual(pm.nextTarget('LONG', 110, 106.5, 104).newTarget, 106.5);
    assert.strictEqual(pm.nextTarget('LONG', 106.5, 112, 104).newTarget, 112);
    assert.strictEqual(pm.nextTarget('LONG', 110, 103, 104).reason, 'TARGET_NOT_ABOVE_MARK');
    assert.strictEqual(pm.nextTarget('SHORT', 90, 94, 100).newTarget, 94);
    assert.strictEqual(pm.nextTarget('SHORT', 94, 88, 100).newTarget, 88);
    assert.strictEqual(pm.nextTarget('SHORT', 90, 101, 100).reason, 'TARGET_NOT_BELOW_MARK');
});

test('S37 dynamic updates consume only causally confirmed Dynamic-D points', function () {
    var point = { confirmedAt: 2000, occurredAt: 1000 };
    assert.strictEqual(pm.isEligibleUpdate(point, 1500, 2000), true);
    assert.strictEqual(pm.isEligibleUpdate(point, 1500, 1999), false);
    assert.strictEqual(pm.isEligibleUpdate(point, 2000, 3000), false);
    assert.strictEqual(pm.isEligibleUpdate({ occurredAt: 1 }, 0, 10), false);
});

test('S27 pending breakout invalidation: SL traded before breakout, or opposite two-bar', function () {
    var plan = { direction: 'LONG', initialSL: 98 };
    assert.strictEqual(pm.pendingEntryInvalidation(plan, { currentContractPrice: 100 }).cancel, false);
    assert.strictEqual(pm.pendingEntryInvalidation(plan, { currentContractPrice: 97 }).reason,
        'INITIAL_SL_TRADED_BEFORE_BREAKOUT');
    assert.strictEqual(pm.pendingEntryInvalidation(plan, { currentContractPrice: 100,
        oppositeTwoBarConfirmed: true }).reason, 'OPPOSITE_TWO_BAR_CONFIRMED');
    assert.strictEqual(pm.pendingEntryInvalidation({ direction: 'SHORT', initialSL: 106 },
        { currentContractPrice: 107 }).reason, 'INITIAL_SL_TRADED_BEFORE_BREAKOUT');
});

test('S39 protection replacement is new-first: place, confirm, then cancel the old order', function () {
    assert.deepStrictEqual(pm.REPLACEMENT_SEQUENCE, ['PLACE_NEW', 'CONFIRM_NEW', 'CANCEL_OLD', 'RECONCILE']);
    assert.strictEqual(pm.replacementDecision({ ok: true }).action, 'CANCEL_OLD');
    assert.strictEqual(pm.replacementDecision({ ok: false }).action, 'KEEP_OLD_AND_HALT_NEW_ENTRIES');
    assert.strictEqual(pm.replacementDecision({ ok: false }).reason, 'NEW_PROTECTION_FAILED');
});

test('S24 TP must be a causal ACTIVE opposite-side Dynamic-D in front of the entry', function () {
    var points = [
        { id: 'A', state: 'ACTIVE', pointSide: 'HIGH', price: 110, confirmedAt: 900, occurredAt: 800, occurredBarIndex: 1 },
        { id: 'B', state: 'INACTIVE', pointSide: 'HIGH', price: 108, confirmedAt: 900, occurredAt: 800, occurredBarIndex: 1 },
        { id: 'C', state: 'ACTIVE', pointSide: 'HIGH', price: 112, confirmedAt: 5000, occurredAt: 4900, occurredBarIndex: 30 },
        { id: 'D', state: 'ACTIVE', pointSide: 'LOW', price: 90, confirmedAt: 900, occurredAt: 800, occurredBarIndex: 1 },
        { id: 'E', state: 'ACTIVE', pointSide: 'HIGH', price: 104, confirmedAt: 950, occurredAt: 900, occurredBarIndex: 1 }
    ];
    var t = rules.selectTarget('LONG', 106, points, [], 1000, null);
    assert.strictEqual(t.id, 'A');
    // a candle between the point's confirmation (900) and the decision time (1000)
    // that trades through the level disqualifies A and E
    var candles = [{ openTime: 900, closeTime: 999, open: 100, high: 111, low: 99, close: 110,
        closed: true, source: 'futures' }];
    var t2 = rules.selectTarget('LONG', 106, points, candles, 1000, null);
    assert.strictEqual(t2, null);
});

test('S26 the plan carries the full provenance needed for recovery', function () {
    var f = longFixture();
    var plan = rules.buildBreakoutPlan(f.setup, {
        symbolRules: RULES, liveTradingEnabled: false,
        bias: { status: 'AVAILABLE', closedAt: 1000, expectedClosedAt: 1000,
            semantic: { direction: 'BULLISH', strength: 'WEAK', confidence: 'LOW' } },
        currentContractPrice: 101,
        dynamicDPoints: [{ id: 'TP_1', state: 'ACTIVE', pointSide: 'HIGH', price: 110,
            confirmedAt: 900, occurredAt: 800, occurredBarIndex: 5 }],
        candles: [bar(0, 100, 101, 99, 100)]
    }).plan;
    ['setupId', 'symbol', 'direction', 'twoBarId', 'dynamicDPartnerId', 'entryTrigger',
        'entryWorkingType', 'initialSL', 'initialTP', 'initialRR', 'decisionTime', 'htfDirection',
        'requestedQty', 'targetNotional'].forEach(function (k) {
        assert.ok(Object.prototype.hasOwnProperty.call(plan, k), 'plan missing ' + k);
    });
});

test('S3 the new-opportunity universe is TOP 5 and is config-consistent', function () {
    var universe = require('../live/dynamicContractUniverseV1');
    var config = require('../config/live.json');
    assert.strictEqual(config.dynamicUniverse.topN, 5);
    assert.strictEqual(universe.configMatchesContract(config.dynamicUniverse), true);
});

test('S47/S48 the new entry modules never reference FVG, WATCH, the EQ-FVG gate or 2L/2R', function () {
    var files = ['strategy/twoBarReversalV1.js', 'strategy/twoBarSetupV1.js',
        'execution/breakoutEntryRulesV1.js', 'execution/positionManagementV1.js'];
    var forbidden = [
        'eqFvgCountWatch', 'eqFvgAssociationSemantic', 'rawFvg', 'rawFvgAt', 'FIRST_TOUCH',
        'firstTouch', 'eqFvgSemantic', 'pivotDetector', '2L2R', 'ORDINARY_CAUSAL_2X2',
        'swingLiquidity', 'productionEqualLiquidityV1', 'WATCH_V1'
    ];
    files.forEach(function (rel) {
        var text = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
        forbidden.forEach(function (token) {
            assert.strictEqual(text.indexOf(token) >= 0, false, rel + ' references ' + token);
        });
    });
});

test('S66 the two-bar setup pipeline uses exactly two LLM stages', function () {
    var text = fs.readFileSync(path.join(__dirname, '..', 'strategy', 'twoBarSetupV1.js'), 'utf8');
    assert.ok(text.indexOf('LIB.SYSTEM_PROMPT') >= 0, 'pattern prompt');
    assert.ok(text.indexOf('LIB.CONTEXT_SYSTEM_PROMPT') >= 0, 'context prompt');
    // exactly two ask(...) call sites: pattern and context
    assert.strictEqual((text.match(/return ask\(/g) || []).length, 2); // pattern + context only
    assert.strictEqual((text.match(/ask\(/g) || []).length, 3); // declaration + 2 call sites
});

console.log('CHECKS PASSED: ' + passed);
console.log('CHECKS FAILED: ' + failed);
console.log('TWO_BAR_PRODUCTION_REPLACEMENT_V1_TESTS=' + (failed === 0 ? 'PASS' : 'FAIL')
    + ' (' + passed + ' checks, ' + failed + ' failed)');
if (failed > 0) process.exitCode = 1;
