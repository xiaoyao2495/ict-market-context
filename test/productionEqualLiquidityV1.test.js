'use strict';

/**
 * PRODUCTION_EQUAL_LIQUIDITY_V1 — replacement contract tests.
 *
 * The historical-anchor source is now the CC CLOSE-based Causal Dynamic D
 * (liquidity/causalDynamicDHistoricalExtremes.js), which FULLY REPLACES the
 * legacy ATR50 ZigZag (FULL_REPLACEMENT=true; BACKWARD_COMPATIBILITY=false).
 *
 * Lifecycle contract under test:
 *   - Each historical anchor is ACTIVE on confirmation, then terminal
 *     INACTIVE (markInactive) on either an ordinary causal 2/2 STRICT CROSS
 *     (wick-to-wick) or AGE_EXPIRY (5 calendar days after confirmedAt).
 *   - evaluatePivot applies, in order: AGE_EXPIRY -> STRICT_CROSS -> tolerance.
 *   - STRICT_INVALIDATION takes priority over EQ tolerance: a strict cross
 *     precludes pairing and sets inactivatedBy='STRICT_CROSS'.
 *   - AGE_EXPIRY_PRECEDES_EQ: an aged anchor is excluded even within tolerance.
 *   - NO RETROACTIVE REWRITE: an INACTIVE anchor never revives.
 *   - Comparison domains: EQ_COMPARISON = WICK_TO_WICK, INVALIDATION = WICK_TO_WICK.
 *   - Tolerance is frozen: 5m Wilder ATR14 * priceStrongMaxATR (0.7).
 */

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var producer = require('../liquidity/productionEqualLiquidityV1');
var dynamicD = require('../liquidity/causalDynamicDHistoricalExtremes');
var replayState = require('../replay/replayState');

var BAR = 300000;
var passed = 0, failed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log('PASS  ' + name); }
    catch (error) { failed++; console.log('FAIL  ' + name + ' -> ' + error.stack); }
}
function state(points) {
    var value = producer.createState({ symbol: 'X', timeframe: '5m' });
    value.fiveMinuteAtrValue = 10;
    value.dynamicD.recentSurvivalPoints = points || [];
    return value;
}
// New-contract historical anchor: selectorPrice (close) carried but only
// price (wick) is ever compared; lifecycle is state/INACTIVE.
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
function evaluate(points, current) { return producer.evaluatePivot(state(points), current); }

test('A HIGH match emits EQH at current 2/2 price (within tolerance, no strict cross)', function () {
    var event = evaluate([point('Z', 'HIGH', 10, 100)], pivot('P', 'HIGH', 20, 97));
    assert.ok(event); assert.strictEqual(event.type, 'EQH'); assert.strictEqual(event.price, 97);
});
test('B LOW match emits EQL at current 2/2 price', function () {
    assert.strictEqual(evaluate([point('Z', 'LOW', 10, 100)], pivot('P', 'LOW', 20, 103)).type, 'EQL');
});
test('C opposite side cannot pair', function () {
    assert.strictEqual(evaluate([point('Z', 'LOW', 10, 100)], pivot('P', 'HIGH', 20, 100)), null);
});
test('D 433 bars is outside the inclusive window', function () {
    assert.strictEqual(evaluate([point('Z', 'HIGH', 1, 100)], pivot('P', 'HIGH', 434, 100)), null);
});
test('E exactly 432 bars is eligible', function () {
    assert.ok(evaluate([point('Z', 'HIGH', 1, 100)], pivot('P', 'HIGH', 433, 100)));
});
test('F historical point confirmed after current pivot occurrence is excluded', function () {
    var p = pivot('P', 'HIGH', 20, 100);
    assert.strictEqual(evaluate([point('Z', 'HIGH', 10, 100, { confirmedAt: p.occurredAt + 1 })], p), null);
});
test('G HIGH anchor already INACTIVE excludes partner (terminal lifecycle)', function () {
    var p = pivot('P', 'HIGH', 20, 100);
    assert.strictEqual(evaluate([point('Z', 'HIGH', 10, 100, { state: 'INACTIVE', inactivatedBy: 'STRICT_CROSS', inactivatedAt: p.occurredAt - 1 })], p), null);
});
test('H HIGH equality is NOT a strict cross (no invalidation)', function () {
    var anchor = point('Z', 'HIGH', 10, 100);
    assert.strictEqual(dynamicD.strictCrosses(anchor, pivot('P', 'HIGH', 20, 100)), false);
});
test('I LOW anchor already INACTIVE excludes partner (terminal lifecycle)', function () {
    var p = pivot('P', 'LOW', 20, 100);
    assert.strictEqual(evaluate([point('Z', 'LOW', 10, 100, { state: 'INACTIVE', inactivatedBy: 'STRICT_CROSS', inactivatedAt: p.occurredAt - 1 })], p), null);
});
test('J LOW equality is NOT a strict cross (no invalidation)', function () {
    var anchor = point('Z', 'LOW', 10, 100);
    assert.strictEqual(dynamicD.strictCrosses(anchor, pivot('P', 'LOW', 20, 100)), false);
});
test('K pivot within tolerance and not a strict cross pairs (currentTradesThroughHistorical false)', function () {
    var p = pivot('P', 'HIGH', 20, 97);
    var event = evaluate([point('Z', 'HIGH', 10, 100)], p);
    assert.ok(event);
    assert.strictEqual(event.metadata.historicalPartners[0].currentTradesThroughHistorical, false);
});
test('L one current pivot emits one event retaining all matching partners', function () {
    var event = evaluate([point('A', 'HIGH', 10, 100), point('B', 'HIGH', 12, 103)], pivot('P', 'HIGH', 20, 100));
    assert.strictEqual(event.metadata.partnerCount, 2);
    assert.deepStrictEqual(event.metadata.historicalPartners.map(function (x) { return x.id; }), ['A', 'B']);
});
test('M evaluating the same current pivot twice emits once', function () {
    var s = state([point('Z', 'HIGH', 10, 100)]), p = pivot('P', 'HIGH', 20, 100);
    assert.ok(producer.evaluatePivot(s, p)); assert.strictEqual(producer.evaluatePivot(s, p), null); assert.strictEqual(s.events.length, 1);
});
test('two current observations do not merge or mutate the first event', function () {
    var s = state([point('Z', 'HIGH', 10, 100)]), first = producer.evaluatePivot(s, pivot('P1', 'HIGH', 20, 100));
    var before = JSON.stringify(first), second = producer.evaluatePivot(s, pivot('P2', 'HIGH', 21, 100));
    assert.ok(second); assert.notStrictEqual(first.id, second.id); assert.strictEqual(JSON.stringify(first), before);
    assert.strictEqual(first.metadata.persistentIdentity, false); assert.strictEqual(first.metadata.clusterLifecycle, false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(first.metadata, 'members'), false);
});
test('a strict cross of the anchor invalidates it for all later candidates (terminal)', function () {
    var s = state([point('Z', 'HIGH', 10, 100)]);
    var p1 = pivot('P1', 'HIGH', 20, 104); // 104 > 100 strict cross
    assert.strictEqual(producer.evaluatePivot(s, p1), null);
    assert.strictEqual(s.dynamicD.recentSurvivalPoints[0].state, 'INACTIVE');
    assert.strictEqual(s.dynamicD.recentSurvivalPoints[0].inactivatedBy, 'STRICT_CROSS');
    // a later within-tolerance candidate cannot revive it
    assert.strictEqual(producer.evaluatePivot(s, pivot('P2', 'HIGH', 21, 100)), null);
});
test('frozen price tolerance is 0.7 times current 5m Wilder ATR14', function () {
    var event = evaluate([point('Z', 'LOW', 10, 100)], pivot('P', 'LOW', 20, 106)); // |6| <= 10*0.7
    assert.ok(event);
    assert.strictEqual(event.metadata.pairwiseToleranceAtrPeriod, 14);
    assert.strictEqual(event.metadata.pairwiseToleranceAtrMultiplier, 0.7);
    assert.strictEqual(evaluate([point('Z', 'LOW', 10, 100)], pivot('Q', 'LOW', 20, 107.000001)), null);
});
test('age expiry precedes EQ pairing: a 5-day-old anchor is excluded', function () {
    var anchor = point('Z', 'HIGH', 10, 100, { confirmedAt: -(dynamicD.FIVE_DAYS_MS + 1000) });
    var s = state([anchor]);
    var ev = producer.evaluatePivot(s, pivot('P', 'HIGH', 20, 100, 20 * BAR));
    assert.strictEqual(ev, null);
    assert.strictEqual(s.dynamicD.recentSurvivalPoints[0].state, 'INACTIVE');
    assert.strictEqual(s.dynamicD.recentSurvivalPoints[0].inactivatedBy, 'AGE_EXPIRY');
});
test('production replay imports no old V2/V3 EQ producer or qualified source', function () {
    var text = fs.readFileSync(path.join(__dirname, '../replay/replayState.js'), 'utf8');
    ['persistentEqualLiquidityV3', 'equalLiquidity.js', 'eqProductionVersion', 'eqSwingSource', 'standardCausalSwingSegmentation'].forEach(function (token) {
        assert.strictEqual(text.includes(token), false, token);
    });
});
test('ReplayState registers the replacement EQ as Narrative Liquidity', function () {
    var candles = [90, 95, 100, 95, 90].map(function (high, i) {
        return { openTime: i * BAR, closeTime: (i + 1) * BAR - 1, open: 80, high: high, low: 70, close: 80, closed: true };
    });
    var s = replayState.createReplayState({ symbol: 'X', timeframe: '5m' });
    for (var i = 0; i < 4; i++) replayState.incrementalLiquidity(s, candles, i, null, candles[i].closeTime);
    s.productionEq.fiveMinuteAtrValue = 10;
    var z = point('Z', 'HIGH', 0, 100, { confirmedAt: candles[1].closeTime });
    s.productionEq.dynamicD.recentSurvivalPoints.push(z);
    replayState.incrementalLiquidity(s, candles, 4, null, candles[4].closeTime);
    var eq = s.registry.getByType('X', 'EQH');
    assert.strictEqual(eq.length, 1); assert.strictEqual(eq[0].price, 100);
    assert.strictEqual(eq[0].metadata.eqModelVersion, producer.VERSION);
});
test('live and inspect entrypoints identify only the replacement production model', function () {
    var live = fs.readFileSync(path.join(__dirname, '../scripts/live.js'), 'utf8');
    var inspect = fs.readFileSync(path.join(__dirname, '../scripts/inspectLiquidity.js'), 'utf8');
    assert.strictEqual(live.includes("require('../config/eqProductionVersion')"), false);
    assert.strictEqual(live.includes("require('../liquidity/productionEqualLiquidityV1')"), true);
    assert.strictEqual(inspect.includes("require('../liquidity/equalLiquidity')"), false);
    assert.strictEqual(inspect.includes('partners='), true);
});

console.log('\nProduction Equal Liquidity V1: ' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
