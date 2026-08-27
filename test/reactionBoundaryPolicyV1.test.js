'use strict';

var assert = require('assert');
var contract = require('../audit/reactionBoundaryPolicyV1');
var B = contract.POLICY_ID.RETURN_TO_SWING_ORIGIN;
var C = contract.POLICY_ID.OPPOSITE_STRUCTURAL_RESET;

function leg(policyId, version) {
    return contract.createReactionLegContract({
        reactionLegId: 'LEG:1', sourceSwingId: 'SWING:1',
        policyId: policyId, policyVersion: version || 'v1',
        startedAt: 20, terminatedAt: 30,
        terminationReason: policyId, availableAt: 30
    });
}

function impact(policyId, version) {
    return contract.createStructuralImpactContract({
        sourceSwingId: 'SWING:1', sourceReactionLegId: 'LEG:1',
        policyId: policyId, policyVersion: version || 'v1',
        referenceSwingId: 'SWING:REF', mssId: 'MSS:1', displacementId: 'DISP:1'
    });
}

(function policyBResolves() {
    var policy = contract.getReactionBoundaryPolicy(B, 'v1');
    assert.equal(policy.reactionBoundaryPolicy.policyId, B);
    assert.equal(policy.reactionBoundaryPolicy.status, 'ELIGIBLE_SHADOW');
})();

(function policyCResolves() {
    assert.equal(contract.getReactionBoundaryPolicy(C, 'v1').canonicalPolicyIdentity, C + ':v1');
})();

(function eligibleListIsExactlyBAndC() {
    assert.deepStrictEqual(contract.listEligibleReactionBoundaryPolicies().map(function (x) {
        return x.reactionBoundaryPolicy.policyId;
    }).sort(), [C, B].sort());
})();

(function productionPolicyIsNull() {
    assert.strictEqual(contract.getProductionReactionBoundaryPolicy(), null);
})();

(function productionRequestFailsClosed() {
    assert.throws(contract.requireProductionReactionBoundaryPolicy, function (error) {
        return error.code === 'NO_PRODUCTION_REACTION_BOUNDARY_POLICY_SELECTED';
    });
})();

(function unknownPolicyIdRejected() {
    assert.throws(function () { contract.getReactionBoundaryPolicy('FRONTIER_1_ATR', 'v1'); }, function (error) {
        return error.code === 'UNKNOWN_REACTION_BOUNDARY_POLICY_ID';
    });
})();

(function unknownVersionRejected() {
    assert.throws(function () { contract.getReactionBoundaryPolicy(B, 'v2'); }, function (error) {
        return error.code === 'UNKNOWN_REACTION_BOUNDARY_POLICY_VERSION';
    });
})();

(function canonicalIdentityIsDeterministic() {
    assert.equal(contract.canonicalReactionBoundaryPolicyIdentity(B, 'v1'), B + ':v1');
    assert.equal(contract.canonicalReactionBoundaryPolicyIdentity(B, 'v1'), B + ':v1');
})();

(function serializationIsDeterministic() {
    var first = contract.serializeReactionBoundaryPolicy(C, 'v1');
    var second = contract.serializeReactionBoundaryPolicy(C, 'v1');
    assert.equal(first, second);
    assert.equal(/timestamp|uuid/i.test(first), false);
})();

(function reactionLegPreservesPolicyProvenance() {
    var value = leg(B);
    assert.equal(value.reactionBoundaryPolicy.policyId, B);
    assert.equal(value.reactionBoundaryPolicy.policyVersion, 'v1');
    assert.ok(value.reactionBoundaryPolicy.terminationSemantic);
})();

(function structuralImpactPreservesPolicyProvenance() {
    var value = impact(C);
    assert.deepStrictEqual(value.reactionBoundaryPolicy, { policyId: C, policyVersion: 'v1' });
    assert.equal(value.sourceReactionLegId, 'LEG:1');
})();

(function matchingBIsValid() {
    assert.equal(contract.validateReactionBoundaryPolicyConsistency(leg(B), impact(B)).valid, true);
})();

(function matchingCIsValid() {
    assert.equal(contract.validateReactionBoundaryPolicyConsistency(leg(C), impact(C)).valid, true);
})();

(function bAndCProduceControlledMismatch() {
    var result = contract.validateReactionBoundaryPolicyConsistency(leg(B), impact(C));
    assert.equal(result.valid, false);
    assert.equal(result.code, 'REACTION_BOUNDARY_POLICY_MISMATCH');
    assert.throws(function () { contract.assertReactionBoundaryPolicyConsistency(leg(B), impact(C)); }, function (error) {
        return error.code === 'REACTION_BOUNDARY_POLICY_MISMATCH';
    });
})();

(function sameIdDifferentVersionIsMismatch() {
    var changedVersion = impact(B);
    changedVersion.reactionBoundaryPolicy.policyVersion = 'v2';
    assert.equal(contract.validateReactionBoundaryPolicyConsistency(leg(B), changedVersion).code, 'REACTION_BOUNDARY_POLICY_MISMATCH');
})();

(function missingPolicyProvenanceIsNotPolicySafe() {
    var unsafe = impact(B);
    delete unsafe.reactionBoundaryPolicy;
    var result = contract.validateReactionBoundaryPolicyConsistency(leg(B), unsafe);
    assert.equal(result.policySafe, false);
    assert.equal(result.code, 'MISSING_REACTION_BOUNDARY_POLICY_PROVENANCE');
})();

(function matchingButUnregisteredVersionIsNotPolicySafe() {
    var unsafeLeg = leg(B);
    var unsafeImpact = impact(B);
    unsafeLeg.reactionBoundaryPolicy.policyVersion = 'v2';
    unsafeImpact.reactionBoundaryPolicy.policyVersion = 'v2';
    var result = contract.validateReactionBoundaryPolicyConsistency(unsafeLeg, unsafeImpact);
    assert.equal(result.policySafe, false);
    assert.equal(result.code, 'UNKNOWN_REACTION_BOUNDARY_POLICY_VERSION');
})();

console.log('Reaction Boundary Policy Contract V1 tests passed (17/17)');
