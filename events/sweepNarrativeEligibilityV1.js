'use strict';

/**
 * Read-only V1 ontology for an already-created LIQUIDITY_SWEEP event.
 *
 * This classification is descriptive shadow metadata only. It must never be
 * used here to create, suppress, reorder, or otherwise alter Sweep events or
 * any downstream consumer decision.
 */
var VERSION = 'v1';

var CONTRACT = {
    SWING_HIGH: {
        sourceClass: 'STRUCTURAL_PRIMITIVE',
        status: 'PROPOSED_INELIGIBLE',
        narrativeEligible: false,
        reason: 'RAW_SWING_PRIMITIVE_NOT_PROPOSED_AS_INDEPENDENT_NARRATIVE_LIQUIDITY'
    },
    SWING_LOW: {
        sourceClass: 'STRUCTURAL_PRIMITIVE',
        status: 'PROPOSED_INELIGIBLE',
        narrativeEligible: false,
        reason: 'RAW_SWING_PRIMITIVE_NOT_PROPOSED_AS_INDEPENDENT_NARRATIVE_LIQUIDITY'
    },
    EQH: {
        sourceClass: 'EQUAL_LIQUIDITY',
        status: 'PROPOSED_ELIGIBLE',
        narrativeEligible: true,
        reason: 'INDEPENDENT_EQUAL_LIQUIDITY_IDENTITY'
    },
    EQL: {
        sourceClass: 'EQUAL_LIQUIDITY',
        status: 'PROPOSED_ELIGIBLE',
        narrativeEligible: true,
        reason: 'INDEPENDENT_EQUAL_LIQUIDITY_IDENTITY'
    },
    PDH: {
        sourceClass: 'CALENDAR_LIQUIDITY',
        status: 'PROPOSED_ELIGIBLE',
        narrativeEligible: true,
        reason: 'INDEPENDENT_PREVIOUS_DAY_LIQUIDITY_IDENTITY'
    },
    PDL: {
        sourceClass: 'CALENDAR_LIQUIDITY',
        status: 'PROPOSED_ELIGIBLE',
        narrativeEligible: true,
        reason: 'INDEPENDENT_PREVIOUS_DAY_LIQUIDITY_IDENTITY'
    },
    PWH: {
        sourceClass: 'CALENDAR_LIQUIDITY',
        status: 'PROPOSED_ELIGIBLE',
        narrativeEligible: true,
        reason: 'INDEPENDENT_PREVIOUS_WEEK_LIQUIDITY_IDENTITY'
    },
    PWL: {
        sourceClass: 'CALENDAR_LIQUIDITY',
        status: 'PROPOSED_ELIGIBLE',
        narrativeEligible: true,
        reason: 'INDEPENDENT_PREVIOUS_WEEK_LIQUIDITY_IDENTITY'
    },
    PMH: {
        sourceClass: 'CALENDAR_LIQUIDITY',
        status: 'PROPOSED_ELIGIBLE',
        narrativeEligible: true,
        reason: 'INDEPENDENT_PREVIOUS_MONTH_LIQUIDITY_IDENTITY'
    },
    PML: {
        sourceClass: 'CALENDAR_LIQUIDITY',
        status: 'PROPOSED_ELIGIBLE',
        narrativeEligible: true,
        reason: 'INDEPENDENT_PREVIOUS_MONTH_LIQUIDITY_IDENTITY'
    },
    ASIA_HIGH: frozenSession(),
    ASIA_LOW: frozenSession(),
    LONDON_HIGH: frozenSession(),
    LONDON_LOW: frozenSession(),
    NEW_YORK_HIGH: frozenSession(),
    NEW_YORK_LOW: frozenSession()
};

function frozenSession() {
    return {
        sourceClass: 'SESSION_LIQUIDITY',
        status: 'OUT_OF_SCOPE_FROZEN',
        narrativeEligible: null,
        reason: 'SESSION_ELIGIBILITY_POLICY_FROZEN_OUT_OF_SCOPE'
    };
}

function classifySourceType(sourceType) {
    var rule = CONTRACT[sourceType];
    if (!rule) {
        rule = {
            sourceClass: 'UNRESOLVED',
            status: 'UNRESOLVED',
            narrativeEligible: null,
            reason: sourceType ? 'SOURCE_TYPE_NOT_IN_V1_CONTRACT' : 'SOURCE_TYPE_MISSING'
        };
    }
    return {
        version: VERSION,
        sourceClass: rule.sourceClass,
        status: rule.status,
        narrativeEligible: rule.narrativeEligible,
        reason: rule.reason,
        shadowOnly: true
    };
}

function classifySweep(sweep) {
    var sourceType = sweep && sweep.source && sweep.source.liquidityType;
    return classifySourceType(sourceType);
}

function isNarrativeLiquiditySourceV1(sourceType) {
    return classifySourceType(sourceType).narrativeEligible === true;
}

function isStructuralPrimitive(sourceType) {
    return classifySourceType(sourceType).sourceClass === 'STRUCTURAL_PRIMITIVE';
}

module.exports = {
    VERSION: VERSION,
    classifySourceType: classifySourceType,
    classifySweep: classifySweep,
    isNarrativeLiquiditySourceV1: isNarrativeLiquiditySourceV1,
    isStructuralPrimitive: isStructuralPrimitive
};
