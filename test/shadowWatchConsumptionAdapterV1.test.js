'use strict';
var assert = require('assert');
var adapter = require('../audit/shadowWatchConsumptionAdapterV1');
var passed = 0;
function test(name, fn) { fn(); passed++; console.log('PASS  ' + name); }
function state(side, policy) {
    return {
        projectionTime: 200, projectionPolicyIdentity: policy,
        identity: { canonicalSwingId: 'S', side: side, price: 100, confirmedAt: 100 },
        formation: { availableAt: 100, prominenceATR: 1.2 },
        topology: { availableAt: 100, eqMemberships: [] },
        liquidityRoles: { availableAt: 100, atConfirmation: [] },
        context: { availableAt: 100 },
        reaction: { status: 'TERMINATED', availableAt: 100, updatedAt: 180, fixedWindowObservations: {} },
        structuralImpact: { status: 'NONE', availableAt: 100, updatedAt: 100 },
        lifecycle: { status: 'SWEPT', availableAt: 100, updatedAt: 170, sweptAt: 170 },
        provenance: { projectedEventIds: [] }
    };
}
test('bull and bear mapping is symmetric', function () {
    assert.deepStrictEqual([adapter.expectedDirection('SWING_LOW'), adapter.expectedLiquiditySide('SWING_LOW')], ['BULLISH','SSL']);
    assert.deepStrictEqual([adapter.expectedDirection('SWING_HIGH'), adapter.expectedLiquiditySide('SWING_HIGH')], ['BEARISH','BSL']);
});
test('adapter separates policy-independent and policy-dependent evidence', function () {
    var out = adapter.mapSwingStateToWatchEvidence(state('SWING_LOW','RETURN_TO_SWING_ORIGIN:v1'), 200);
    assert.strictEqual(out.safeNow.lifecycle.status, 'SWEPT');
    assert.strictEqual(out.contextOnly.formationDistinctiveness.prominenceATR, 1.2);
    assert.strictEqual(out.safeShadowOnly.policyIdentity, 'RETURN_TO_SWING_ORIGIN:v1');
    assert.strictEqual(out.decisionProduced, false);
});
test('future projection fails closed', function () {
    var s = state('SWING_LOW', null); s.projectionTime = 201;
    assert.throws(function () { adapter.mapSwingStateToWatchEvidence(s, 200); }, /PROJECTION_FROM_FUTURE/);
});
test('nested future evidence fails closed', function () {
    var s = state('SWING_LOW', null); s.lifecycle.sweptAt = 201;
    assert.throws(function () { adapter.mapSwingStateToWatchEvidence(s, 200); }, /FUTURE_EVIDENCE/);
});
test('current watch mapping exposes non-causal provenance gap', function () {
    var out = adapter.mapCurrentWatchEvidence({ id:'W',direction:'BULLISH',updatedAt:200,
        liquidityTaken:{primary:{id:'E',sourceId:'S',sourceType:'SWING_LOW',side:'SSL',confirmedAt:150,relation:'BEFORE_LEG'}},
        mss:{exists:true,id:'M',direction:'BULLISH',confirmedAt:190},displacement:{direction:'BULLISH',lastConfirmedAt:200},displacementIds:['D'] });
    assert.strictEqual(out.directionConsistent, true);
    assert.strictEqual(out.mssEvidence.sourceSwingAttributed, false);
    assert.strictEqual(out.displacementEvidence.productionTrigger, true);
});
console.log('Shadow Watch Consumption Adapter V1 ' + passed + '/' + passed);
