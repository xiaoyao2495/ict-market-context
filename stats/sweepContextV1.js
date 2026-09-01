'use strict';

/**
 * Production read-side adapter for SweepContextV1.
 *
 * It never mutates a liquidity object, Sweep event, WATCH, registry, or the
 * supplied SwingContextV1 projector. Candidate order and primary identity are
 * deliberately outside this module's decision surface.
 */
var crypto = require('crypto');

var SCHEMA_VERSION = 'SweepContextV1';
var PRIMARY_SELECTION_SEMANTIC = 'CURRENT_PRODUCTION_RECENCY_HEURISTIC';
var SWING_TYPES = ['SWING_HIGH', 'SWING_LOW'];
var EQ_TYPES = ['EQH', 'EQL'];
var EXPLICIT_TYPES = [
    'PDH', 'PDL', 'PWH', 'PWL', 'PMH', 'PML',
    'SESSION_HIGH', 'SESSION_LOW',
    'ASIA_HIGH', 'ASIA_LOW', 'LONDON_HIGH', 'LONDON_LOW',
    'NEW_YORK_HIGH', 'NEW_YORK_LOW'
];

function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (!value || typeof value !== 'object') return value;
    var out = {};
    Object.keys(value).sort().forEach(function (key) { out[key] = stable(value[key]); });
    return out;
}
function hash(value) { return crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex'); }
function uniqueSorted(values) {
    return values.filter(function (value, index) { return value && values.indexOf(value) === index; }).sort();
}
function sourceClass(sourceType) {
    if (SWING_TYPES.indexOf(sourceType) >= 0) return 'SWING_DERIVED';
    if (EQ_TYPES.indexOf(sourceType) >= 0) return 'EQ_POINT_IN_TIME_CROSS_SOURCE';
    if (EXPLICIT_TYPES.indexOf(sourceType) >= 0) return 'NON_SWING_LIQUIDITY';
    return 'UNRESOLVED';
}
function compactSwingContext(context) {
    if (!context) return null;
    return {
        canonicalSwingId: context.canonicalSwingId,
        side: context.side,
        price: context.price,
        occurredAt: context.occurredAt,
        confirmedAt: context.confirmedAt,
        structural: clone(context.structural),
        timeframeMembership: clone(context.timeframeMembership),
        evaluationTime: context.evaluationTime,
        provenance: clone(context.provenance)
    };
}
function baseLiquidity(candidate) {
    return {
        sourceId: candidate && candidate.sourceId || null,
        sourceType: candidate && candidate.sourceType || 'UNKNOWN',
        sourceTimeframe: candidate && candidate.sourceTimeframe || 'UNKNOWN',
        side: candidate && candidate.side || null,
        price: candidate && Number.isFinite(candidate.sourcePrice) ? candidate.sourcePrice : null,
        confirmedAt: candidate && Number.isFinite(candidate.confirmedAt) ? candidate.confirmedAt : null,
        lifecycle: candidate && Number.isFinite(candidate.confirmedAt) ? {
            stateAtEvaluation: 'SWEPT',
            transition: 'LIQUIDITY_SWEPT',
            transitionAt: candidate.confirmedAt,
            structuralRoleIsSeparateDimension: true
        } : null
    };
}
function unresolved(candidate, reason, sourceCategory) {
    return {
        schemaVersion: SCHEMA_VERSION,
        sweepId: candidate && candidate.id || null,
        evaluationTime: candidate && Number.isFinite(candidate.confirmedAt) ? candidate.confirmedAt : null,
        liquidity: baseLiquidity(candidate),
        contextApplicability: 'UNRESOLVED',
        sourceCategory: sourceCategory || sourceClass(candidate && candidate.sourceType),
        canonicalSwingId: null,
        swingContext: null,
        memberSwingContexts: [],
        unresolvedReason: reason,
        provenance: {
            projectionMode: 'AUDIT_ONLY_READ_MODEL_AS_OF',
            sourceIdentityPreserved: !!(candidate && candidate.sourceId),
            primarySelectionSemantic: PRIMARY_SELECTION_SEMANTIC,
            candidateRankingAdded: false
        }
    };
}

function buildSweepContextV1(candidate, options) {
    var opts = options || {}, category = sourceClass(candidate && candidate.sourceType);
    if (!candidate || !candidate.sourceId || !Number.isFinite(candidate.confirmedAt)) {
        return unresolved(candidate, 'MISSING_SWEEP_SOURCE_ID_OR_CONFIRMED_AT', category);
    }
    var evaluationTime = candidate.confirmedAt;
    var base = {
        schemaVersion: SCHEMA_VERSION,
        sweepId: candidate.id || null,
        evaluationTime: evaluationTime,
        liquidity: baseLiquidity(candidate),
        contextApplicability: category,
        sourceCategory: category,
        canonicalSwingId: null,
        swingContext: null,
        memberSwingContexts: [],
        unresolvedReason: null,
        provenance: {
            projectionMode: 'AUDIT_ONLY_READ_MODEL_AS_OF',
            evaluationTimeSource: 'sweep.confirmedAt',
            sourceIdentityPreserved: true,
            swingContextProjector: 'projectSwingContextV1',
            primarySelectionSemantic: PRIMARY_SELECTION_SEMANTIC,
            candidateRankingAdded: false
        }
    };

    if (category === 'SWING_DERIVED') {
        var context = opts.projectSwingContextV1 && opts.projectSwingContextV1({
            canonicalSwingId: candidate.sourceId,
            evaluationTime: evaluationTime
        });
        if (!context) return unresolved(candidate, 'SWING_CONTEXT_NOT_AVAILABLE_AS_OF_SWEEP', category);
        base.canonicalSwingId = candidate.sourceId;
        base.swingContext = compactSwingContext(context);
        return base;
    }

    if (category === 'EQ_POINT_IN_TIME_CROSS_SOURCE') {
        var frozen = candidate.eqPartnerProvenance;
        if (!frozen && opts.registry && opts.registry.getById) {
            var eqObject = opts.registry.getById(candidate.sourceId);
            var metadata = eqObject && eqObject.metadata;
            if (metadata && metadata.pointInTimeObservation) {
                frozen = { currentPivot:metadata.currentPivot, historicalPartners:metadata.historicalPartners || [] };
            }
        }
        if (!frozen || !frozen.currentPivot || !Array.isArray(frozen.historicalPartners)) {
            return unresolved(candidate, 'EQ_PARTNER_PROVENANCE_UNAVAILABLE', category);
        }
        base.provenance.eqObjectId = candidate.sourceId;
        base.provenance.eqSemantic = 'POINT_IN_TIME_2X2_VS_ATR50_PARTNERS';
        base.provenance.currentPivotId = frozen.currentPivot.id || null;
        base.provenance.historicalPartnerIds = uniqueSorted(frozen.historicalPartners.map(function (partner) { return partner.id; }));
        base.provenance.clusterIdentity = false;
        base.provenance.memberEvolution = false;
        return base;
    }

    if (category === 'NON_SWING_LIQUIDITY') {
        base.provenance.nativeLiquidityIdentity = candidate.sourceId;
        base.provenance.nearestSwingGuessing = false;
        return base;
    }
    return unresolved(candidate, 'UNSUPPORTED_LIQUIDITY_SOURCE_TYPE', category);
}

function attachCandidateContextsShadow(watch, options) {
    var original = clone(watch), candidates = original && original.liquidityTaken && original.liquidityTaken.allCandidates || [];
    var primary = original && original.liquidityTaken && original.liquidityTaken.primary || null;
    var contexts = candidates.map(function (candidate) { return buildSweepContextV1(candidate, options); });
    var primaryAfter = primary ? { id: primary.id || null, sourceId: primary.sourceId || null } : null;
    return {
        watchId: original && original.id || null,
        createdAt: original && original.createdAt || null,
        updatedAt: original && original.updatedAt || null,
        direction: original && original.direction || null,
        primaryBefore: primaryAfter && clone(primaryAfter),
        primaryAfter: primaryAfter,
        primarySelectionSemantic: PRIMARY_SELECTION_SEMANTIC,
        candidateCountBefore: candidates.length,
        candidateCountAfter: contexts.length,
        candidateContexts: contexts,
        originalWatchHashBefore: hash(original),
        originalWatchHashAfter: hash(watch)
    };
}

module.exports = {
    SCHEMA_VERSION: SCHEMA_VERSION,
    PRIMARY_SELECTION_SEMANTIC: PRIMARY_SELECTION_SEMANTIC,
    SWING_TYPES: SWING_TYPES,
    EQ_TYPES: EQ_TYPES,
    EXPLICIT_TYPES: EXPLICIT_TYPES,
    sourceClass: sourceClass,
    compactSwingContext: compactSwingContext,
    buildSweepContextV1: buildSweepContextV1,
    attachCandidateContextsShadow: attachCandidateContextsShadow,
    hash: hash
};
