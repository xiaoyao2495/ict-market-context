'use strict';

/**
 * Audit/shadow-only Reaction Boundary Policy contract.
 *
 * This module records the frozen B/C research result without selecting either
 * policy for production. It contains no market-data or reaction calculations.
 */

var SCHEMA_VERSION = 'ReactionBoundaryPolicyV1';
var STATUS = Object.freeze({
    ELIGIBLE_SHADOW: 'ELIGIBLE_SHADOW',
    PRODUCTION_SELECTED: 'PRODUCTION_SELECTED'
});
var POLICY_ID = Object.freeze({
    RETURN_TO_SWING_ORIGIN: 'RETURN_TO_SWING_ORIGIN',
    OPPOSITE_STRUCTURAL_RESET: 'OPPOSITE_STRUCTURAL_RESET'
});

function freezePolicy(policy) {
    Object.freeze(policy.reactionBoundaryPolicy);
    return Object.freeze(policy);
}

var REGISTRY = Object.freeze({
    'RETURN_TO_SWING_ORIGIN:v1': freezePolicy({
        schemaVersion: SCHEMA_VERSION,
        canonicalPolicyIdentity: 'RETURN_TO_SWING_ORIGIN:v1',
        reactionBoundaryPolicy: {
            policyId: POLICY_ID.RETURN_TO_SWING_ORIGIN,
            policyVersion: 'v1',
            terminationSemantic: 'TERMINATE_WHEN_PRICE_RETURNS_TO_OR_CROSSES_SWING_ORIGIN',
            status: STATUS.ELIGIBLE_SHADOW
        }
    }),
    'OPPOSITE_STRUCTURAL_RESET:v1': freezePolicy({
        schemaVersion: SCHEMA_VERSION,
        canonicalPolicyIdentity: 'OPPOSITE_STRUCTURAL_RESET:v1',
        reactionBoundaryPolicy: {
            policyId: POLICY_ID.OPPOSITE_STRUCTURAL_RESET,
            policyVersion: 'v1',
            terminationSemantic: 'TERMINATE_ON_CONFIRMED_OPPOSITE_PRODUCTION_MSS',
            status: STATUS.ELIGIBLE_SHADOW
        }
    })
});

function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function contractError(code, message) {
    var error = new Error(message || code);
    error.code = code;
    return error;
}

function canonicalReactionBoundaryPolicyIdentity(policyId, policyVersion) {
    if (typeof policyId !== 'string' || !policyId) {
        throw contractError('UNKNOWN_REACTION_BOUNDARY_POLICY_ID');
    }
    if (typeof policyVersion !== 'string' || !policyVersion) {
        throw contractError('UNKNOWN_REACTION_BOUNDARY_POLICY_VERSION');
    }
    return policyId + ':' + policyVersion;
}

function getReactionBoundaryPolicy(policyId, policyVersion) {
    if (policyId !== POLICY_ID.RETURN_TO_SWING_ORIGIN &&
        policyId !== POLICY_ID.OPPOSITE_STRUCTURAL_RESET) {
        throw contractError('UNKNOWN_REACTION_BOUNDARY_POLICY_ID', 'Unknown Reaction Boundary Policy: ' + policyId);
    }
    var identity = canonicalReactionBoundaryPolicyIdentity(policyId, policyVersion);
    if (!REGISTRY[identity]) {
        throw contractError('UNKNOWN_REACTION_BOUNDARY_POLICY_VERSION', 'Unknown Reaction Boundary Policy version: ' + identity);
    }
    return clone(REGISTRY[identity]);
}

function listEligibleReactionBoundaryPolicies() {
    return Object.keys(REGISTRY).sort().map(function (identity) {
        return clone(REGISTRY[identity]);
    }).filter(function (entry) {
        return entry.reactionBoundaryPolicy.status === STATUS.ELIGIBLE_SHADOW;
    });
}

function getProductionReactionBoundaryPolicy() {
    return null;
}

function requireProductionReactionBoundaryPolicy() {
    var policy = getProductionReactionBoundaryPolicy();
    if (!policy) {
        throw contractError(
            'NO_PRODUCTION_REACTION_BOUNDARY_POLICY_SELECTED',
            'No production Reaction Boundary Policy has been selected'
        );
    }
    return policy;
}

function serializeReactionBoundaryPolicy(policyId, policyVersion) {
    var entry = getReactionBoundaryPolicy(policyId, policyVersion);
    return JSON.stringify({
        schemaVersion: entry.schemaVersion,
        canonicalPolicyIdentity: entry.canonicalPolicyIdentity,
        reactionBoundaryPolicy: {
            policyId: entry.reactionBoundaryPolicy.policyId,
            policyVersion: entry.reactionBoundaryPolicy.policyVersion,
            terminationSemantic: entry.reactionBoundaryPolicy.terminationSemantic,
            status: entry.reactionBoundaryPolicy.status
        }
    });
}

function requireString(value, field) {
    if (typeof value !== 'string' || !value) {
        throw contractError('INVALID_REACTION_BOUNDARY_CONTRACT', 'Missing ' + field);
    }
}

function requireTime(value, field) {
    if (!Number.isFinite(value)) {
        throw contractError('INVALID_REACTION_BOUNDARY_CONTRACT', 'Invalid ' + field);
    }
}

function policyProvenance(policyId, policyVersion, includeSemantic) {
    var policy = getReactionBoundaryPolicy(policyId, policyVersion).reactionBoundaryPolicy;
    var provenance = {
        policyId: policy.policyId,
        policyVersion: policy.policyVersion
    };
    if (includeSemantic) provenance.terminationSemantic = policy.terminationSemantic;
    return provenance;
}

function createReactionLegContract(input) {
    input = input || {};
    requireString(input.reactionLegId, 'reactionLegId');
    requireString(input.sourceSwingId, 'sourceSwingId');
    requireString(input.terminationReason, 'terminationReason');
    requireTime(input.startedAt, 'startedAt');
    requireTime(input.terminatedAt, 'terminatedAt');
    requireTime(input.availableAt, 'availableAt');
    if (input.startedAt > input.terminatedAt || input.terminatedAt > input.availableAt) {
        throw contractError('INVALID_REACTION_BOUNDARY_TEMPORAL_ORDER');
    }
    return {
        contractVersion: 'ReactionLegPolicyProvenanceV1',
        reactionLegId: input.reactionLegId,
        sourceSwingId: input.sourceSwingId,
        reactionBoundaryPolicy: policyProvenance(input.policyId, input.policyVersion, true),
        startedAt: input.startedAt,
        terminatedAt: input.terminatedAt,
        terminationReason: input.terminationReason,
        availableAt: input.availableAt
    };
}

function createStructuralImpactContract(input) {
    input = input || {};
    requireString(input.sourceSwingId, 'sourceSwingId');
    requireString(input.sourceReactionLegId, 'sourceReactionLegId');
    requireString(input.referenceSwingId, 'referenceSwingId');
    requireString(input.mssId, 'mssId');
    if (input.displacementId != null) requireString(input.displacementId, 'displacementId');
    return {
        contractVersion: 'StructuralImpactPolicyProvenanceV1',
        sourceSwingId: input.sourceSwingId,
        sourceReactionLegId: input.sourceReactionLegId,
        reactionBoundaryPolicy: policyProvenance(input.policyId, input.policyVersion, false),
        referenceSwingId: input.referenceSwingId,
        mssId: input.mssId,
        displacementId: input.displacementId == null ? null : input.displacementId
    };
}

function policyFrom(value) {
    return value && value.reactionBoundaryPolicy;
}

function validateReactionBoundaryPolicyConsistency(reactionLeg, structuralImpact) {
    var legPolicy = policyFrom(reactionLeg);
    var impactPolicy = policyFrom(structuralImpact);
    if (!legPolicy || !impactPolicy || !legPolicy.policyId || !legPolicy.policyVersion ||
        !impactPolicy.policyId || !impactPolicy.policyVersion) {
        return {
            valid: false,
            policySafe: false,
            code: 'MISSING_REACTION_BOUNDARY_POLICY_PROVENANCE'
        };
    }
    if (legPolicy.policyId !== impactPolicy.policyId ||
        legPolicy.policyVersion !== impactPolicy.policyVersion) {
        return {
            valid: false,
            policySafe: false,
            code: 'REACTION_BOUNDARY_POLICY_MISMATCH',
            reactionLegPolicyIdentity: canonicalReactionBoundaryPolicyIdentity(legPolicy.policyId, legPolicy.policyVersion),
            structuralImpactPolicyIdentity: canonicalReactionBoundaryPolicyIdentity(impactPolicy.policyId, impactPolicy.policyVersion)
        };
    }
    try {
        getReactionBoundaryPolicy(legPolicy.policyId, legPolicy.policyVersion);
        getReactionBoundaryPolicy(impactPolicy.policyId, impactPolicy.policyVersion);
    } catch (error) {
        return {
            valid: false,
            policySafe: false,
            code: error.code || 'UNKNOWN_REACTION_BOUNDARY_POLICY'
        };
    }
    return {
        valid: true,
        policySafe: true,
        code: null,
        canonicalPolicyIdentity: canonicalReactionBoundaryPolicyIdentity(legPolicy.policyId, legPolicy.policyVersion)
    };
}

function assertReactionBoundaryPolicyConsistency(reactionLeg, structuralImpact) {
    var result = validateReactionBoundaryPolicyConsistency(reactionLeg, structuralImpact);
    if (!result.valid) throw contractError(result.code);
    return result;
}

module.exports = {
    SCHEMA_VERSION: SCHEMA_VERSION,
    STATUS: STATUS,
    POLICY_ID: POLICY_ID,
    canonicalReactionBoundaryPolicyIdentity: canonicalReactionBoundaryPolicyIdentity,
    getReactionBoundaryPolicy: getReactionBoundaryPolicy,
    listEligibleReactionBoundaryPolicies: listEligibleReactionBoundaryPolicies,
    getProductionReactionBoundaryPolicy: getProductionReactionBoundaryPolicy,
    requireProductionReactionBoundaryPolicy: requireProductionReactionBoundaryPolicy,
    serializeReactionBoundaryPolicy: serializeReactionBoundaryPolicy,
    createReactionLegContract: createReactionLegContract,
    createStructuralImpactContract: createStructuralImpactContract,
    validateReactionBoundaryPolicyConsistency: validateReactionBoundaryPolicyConsistency,
    assertReactionBoundaryPolicyConsistency: assertReactionBoundaryPolicyConsistency
};
