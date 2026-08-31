'use strict';

var crypto = require('crypto');

var LIFECYCLE_RANK = { ACTIVE: 0, TOUCHED: 1, SWEPT: 2, BROKEN: 3, UNRESOLVED: -1 };
var PRIMARY_SELECTION_SEMANTIC = 'CURRENT_PRODUCTION_RECENCY_HEURISTIC';

/**
 * Audit-only SwingState -> WATCH evidence adapter.
 *
 * This module cannot create a WATCH or change a WATCH decision.  It only
 * exposes facts that were legally available at evaluationTime and separates
 * policy-independent facts from unresolved reaction-policy evidence.
 */

function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function expectedDirection(side) {
    if (side === 'SWING_LOW') return 'BULLISH';
    if (side === 'SWING_HIGH') return 'BEARISH';
    return null;
}

function expectedLiquiditySide(side) {
    if (side === 'SWING_LOW') return 'SSL';
    if (side === 'SWING_HIGH') return 'BSL';
    return null;
}

function stable(value) {
    if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(function (key) {
        return JSON.stringify(key) + ':' + stable(value[key]);
    }).join(',') + '}';
    return JSON.stringify(value);
}

function evidenceHash(value) {
    return crypto.createHash('sha256').update(stable(value)).digest('hex');
}

function normalizeBiasDirection(bias) {
    var value = bias && (bias.direction || bias.bias) || bias;
    if (value === 'BULLISH' || value === 'LEAN_BULLISH') return 'BULLISH';
    if (value === 'BEARISH' || value === 'LEAN_BEARISH') return 'BEARISH';
    if (value === 'NEUTRAL') return 'NEUTRAL';
    return 'UNKNOWN';
}

function alignBiasToLiquidity(bias, liquiditySide) {
    var direction = normalizeBiasDirection(bias);
    if (direction === 'NEUTRAL') return 'NEUTRAL';
    if (direction === 'UNKNOWN' || (liquiditySide !== 'SSL' && liquiditySide !== 'BSL')) return 'NOT_APPLICABLE';
    if ((direction === 'BULLISH' && liquiditySide === 'SSL') ||
        (direction === 'BEARISH' && liquiditySide === 'BSL')) return 'MATCH';
    return 'OPPOSITE';
}

function eventTime(event) {
    return event && (event.availableAt !== undefined ? event.availableAt :
        event.confirmedAt !== undefined ? event.confirmedAt : event.at);
}

function temporalEventOrder(a, b) {
    var at = eventTime(a), bt = eventTime(b);
    if (at !== bt) return at - bt;
    if ((a.sequence || 0) !== (b.sequence || 0)) return (a.sequence || 0) - (b.sequence || 0);
    return String(a.eventId || a.id || '').localeCompare(String(b.eventId || b.id || ''));
}

function projectTemporalEvidence(events, evaluationTime) {
    var state = { evaluationTime: evaluationTime, lifecycle: null, eqMemberships: [], provenanceEventIds: [] };
    return advanceTemporalEvidence(state, events, evaluationTime);
}

function advanceTemporalEvidence(previous, events, evaluationTime) {
    if (previous && previous.evaluationTime > evaluationTime) throw new Error('INCREMENTAL_EVALUATION_TIME_REGRESSION');
    var state = clone(previous || { lifecycle: null, eqMemberships: [], provenanceEventIds: [] });
    state.evaluationTime = evaluationTime;
    var seen = {};
    (state.provenanceEventIds || []).forEach(function (id) { seen[id] = true; });
    (events || []).filter(function (event) {
        var id = event.eventId || event.id;
        return eventTime(event) <= evaluationTime && !seen[id];
    }).slice().sort(temporalEventOrder).forEach(function (event) {
        var id = event.eventId || event.id;
        var type = event.eventType || event.type;
        if (/MEMBER/.test(type)) {
            if (!state.eqMemberships.some(function (item) { return item.eventId === id; })) state.eqMemberships.push(clone(event));
        }
        var next = event.nextState || event.status ||
            (type === 'LIQUIDITY_TOUCHED' ? 'TOUCHED' : type === 'LIQUIDITY_SWEPT' || type === 'EQ_LIFECYCLE_SWEPT' ? 'SWEPT' :
                type === 'LIQUIDITY_BROKEN' || type === 'EQ_LIFECYCLE_BROKEN' ? 'BROKEN' : null);
        if (next && LIFECYCLE_RANK[next] !== undefined && (!state.lifecycle || LIFECYCLE_RANK[next] >= LIFECYCLE_RANK[state.lifecycle.status])) {
            state.lifecycle = {
                status: next,
                transitionEventId: id,
                transitionType: type,
                transitionAt: eventTime(event),
                provenance: clone(event.provenance || event.source || null)
            };
        }
        state.provenanceEventIds.push(id);
    });
    state.eqMemberships.sort(temporalEventOrder);
    state.provenanceEventIds = state.provenanceEventIds.filter(function (id, i, all) { return all.indexOf(id) === i; });
    return state;
}

function canonicalIdentity(candidate, memberships) {
    var type = candidate.sourceType;
    if (type === 'SWING_HIGH' || type === 'SWING_LOW') {
        return { resolution: candidate.sourceId ? 'RESOLVED' : 'UNRESOLVED', canonicalSwingId: candidate.sourceId || null,
            canonicalSwingIds: candidate.sourceId ? [candidate.sourceId] : [], eqObjectId: null, registryIdentity: candidate.sourceId || null };
    }
    if (type === 'EQH' || type === 'EQL') {
        var ids = (memberships || []).map(function (event) { return event.canonicalSwingId; }).filter(Boolean);
        ids = ids.filter(function (id, i) { return ids.indexOf(id) === i; }).sort();
        return { resolution: candidate.sourceId ? 'REGISTRY_IDENTITY_RESOLVED' : 'UNRESOLVED', canonicalSwingId: null,
            canonicalSwingIds: ids, eqObjectId: candidate.sourceId || null, registryIdentity: candidate.sourceId || null };
    }
    return { resolution: candidate.sourceId ? 'REGISTRY_IDENTITY_RESOLVED' : 'UNRESOLVED', canonicalSwingId: null,
        canonicalSwingIds: [], eqObjectId: null, registryIdentity: candidate.sourceId || null };
}

function candidateOrder(a, b) {
    if (a.confirmedAt !== b.confirmedAt) return a.confirmedAt - b.confirmedAt;
    if ((a.candleIndex || 0) !== (b.candleIndex || 0)) return (a.candleIndex || 0) - (b.candleIndex || 0);
    if (String(a.id) !== String(b.id)) return String(a.id).localeCompare(String(b.id));
    return String(a.sourceId).localeCompare(String(b.sourceId));
}

function mapSweepCandidate(candidate, evaluationTime, temporalEvents) {
    if (!candidate || typeof candidate.confirmedAt !== 'number' || candidate.confirmedAt > evaluationTime) return null;
    var projection = projectTemporalEvidence(temporalEvents || [], evaluationTime);
    var identity = canonicalIdentity(candidate, projection.eqMemberships);
    var missing = [];
    ['id','sourceId','sourceType','side','confirmedAt'].forEach(function (field) { if (candidate[field] == null) missing.push(field); });
    return {
        sweepEventId: candidate.id || null,
        sourceId: candidate.sourceId || null,
        sourceType: candidate.sourceType || 'UNKNOWN',
        sourceTimeframe: candidate.sourceTimeframe || 'UNKNOWN',
        sourcePrice: candidate.sourcePrice,
        side: candidate.side || null,
        direction: candidate.side === 'SSL' ? 'BULLISH' : candidate.side === 'BSL' ? 'BEARISH' : null,
        confirmedAt: candidate.confirmedAt,
        relation: candidate.relation || null,
        barsBeforeLegStart: candidate.barsBeforeLegStart,
        identity: identity,
        liquidityRole: candidate.sourceType || 'UNKNOWN',
        eqMemberships: clone(projection.eqMemberships),
        lifecycle: projection.lifecycle || {
            status: 'UNRESOLVED', transitionEventId: null, transitionType: null,
            transitionAt: null, provenance: null
        },
        provenance: {
            sweepEventId: candidate.id || null,
            sourceLiquidityId: candidate.sourceId || null,
            temporalEventIds: clone(projection.provenanceEventIds),
            complete: missing.length === 0,
            missingFields: missing
        }
    };
}

function buildShadowWatchEvidenceSnapshot(opts) {
    opts = opts || {};
    var watch = opts.watch;
    if (!watch || !watch.liquidityTaken) throw new Error('WATCH_WITH_LIQUIDITY_REQUIRED');
    var evaluationTime = opts.evaluationTime !== undefined ? opts.evaluationTime : watch.updatedAt;
    var eventMap = opts.temporalEventsBySourceId || {};
    var candidates = (watch.liquidityTaken.allCandidates || []).map(function (candidate) {
        return mapSweepCandidate(candidate, evaluationTime, eventMap[candidate.sourceId] || []);
    }).filter(Boolean).sort(candidateOrder);
    var currentPrimary = watch.liquidityTaken.primary || null;
    var primary = currentPrimary ? candidates.filter(function (candidate) {
        return candidate.sweepEventId === currentPrimary.id && candidate.sourceId === currentPrimary.sourceId;
    })[0] || null : null;
    var biasSource = opts.dailyBias || watch.dailyBias || null;
    var biasDirection = normalizeBiasDirection(biasSource);
    var missingProvenance = candidates.reduce(function (n, item) { return n + (item.provenance.complete ? 0 : 1); }, 0);
    var snapshot = {
        schemaVersion: 'ShadowWatchEvidenceSnapshotV1',
        auditOnly: true,
        productionDecisionFeedbackAllowed: false,
        productionWatchId: watch.id,
        evaluationTime: evaluationTime,
        swing: primary ? {
            canonicalSwingId: primary.identity.canonicalSwingId,
            canonicalSwingIds: clone(primary.identity.canonicalSwingIds),
            identityResolution: primary.identity.resolution,
            side: primary.sourceType === 'SWING_HIGH' ? 'SWING_HIGH' : primary.sourceType === 'SWING_LOW' ? 'SWING_LOW' : null,
            liquiditySide: primary.side
        } : { canonicalSwingId:null, canonicalSwingIds:[], identityResolution:'UNRESOLVED', side:null, liquiditySide:null },
        liquidity: {
            primaryRole: primary && primary.liquidityRole || null,
            primaryRegistryIdentity: primary && primary.identity.registryIdentity || null,
            primaryEqObjectId: primary && primary.identity.eqObjectId || null,
            eqMemberships: primary ? clone(primary.eqMemberships) : [],
            lifecycleStatus: primary && primary.lifecycle.status || 'UNRESOLVED',
            lifecycleTransition: primary && primary.lifecycle.transitionType || null,
            lifecycleTransitionAt: primary && primary.lifecycle.transitionAt || null
        },
        sweep: primary ? {
            eventId: primary.sweepEventId, sourceId: primary.sourceId, sourceType: primary.sourceType,
            side: primary.side, direction: primary.direction, confirmedAt: primary.confirmedAt
        } : null,
        allDirectionMatchingSweepCandidates: candidates,
        productionPrimaryMirror: primary,
        primarySelectionSemantic: PRIMARY_SELECTION_SEMANTIC,
        causalPrimaryClaim: false,
        bias: {
            direction: biasDirection,
            eventAlignment: alignBiasToLiquidity(biasSource, primary && primary.side),
            sourceEvaluationTime: biasSource && biasSource.evaluationTime != null ? biasSource.evaluationTime : null,
            provenance: clone(biasSource)
        },
        blockedCausalEvidence: {
            reactionPolicyDependent: true,
            reactionLegProductionAllowed: false,
            attributedMssProductionAllowed: false,
            sameDeliveryDisplacementProductionAllowed: false,
            followThroughProductionAllowed: false,
            productionPolicySelected: false
        },
        provenance: {
            productionWatchId: watch.id,
            productionPrimarySweepEventId: currentPrimary && currentPrimary.id || null,
            candidateSweepEventIds: candidates.map(function (candidate) { return candidate.sweepEventId; }),
            safeNowMissingProvenance: missingProvenance
        }
    };
    snapshot.serialization = stable(snapshot);
    snapshot.evidenceHash = evidenceHash(snapshot.serialization);
    return snapshot;
}

function collectFutureTimes(value, evaluationTime, path, violations) {
    if (!value || typeof value !== 'object') return;
    Object.keys(value).forEach(function (key) {
        var item = value[key];
        var itemPath = path ? path + '.' + key : key;
        var isAvailability = /^(availableAt|updatedAt|confirmedAt|initiatedAt|endAt|touchedAt|sweptAt|brokenAt|projectedAt)$/.test(key);
        if (isAvailability && typeof item === 'number' && item > evaluationTime) {
            violations.push({ path: itemPath, value: item, evaluationTime: evaluationTime });
        }
        if (item && typeof item === 'object') collectFutureTimes(item, evaluationTime, itemPath, violations);
    });
}

function assertTemporalSafety(state, evaluationTime) {
    if (!state || !state.identity) throw new Error('SWINGSTATE_REQUIRED');
    if (typeof evaluationTime !== 'number') throw new Error('EVALUATION_TIME_REQUIRED');
    if (state.identity.confirmedAt > evaluationTime) throw new Error('SWING_NOT_CONFIRMED_AT_EVALUATION_TIME');
    if (typeof state.projectionTime === 'number' && state.projectionTime > evaluationTime) {
        throw new Error('PROJECTION_FROM_FUTURE');
    }
    var violations = [];
    collectFutureTimes(state, evaluationTime, '', violations);
    if (violations.length) {
        var error = new Error('FUTURE_EVIDENCE_IN_SWINGSTATE');
        error.violations = violations;
        throw error;
    }
}

function mapSwingStateToWatchEvidence(state, evaluationTime) {
    assertTemporalSafety(state, evaluationTime);
    var side = state.identity.side;
    var lifecycle = state.lifecycle || {};
    var reaction = state.reaction || {};
    var structural = state.structuralImpact || {};
    var policyIdentity = state.projectionPolicyIdentity || null;
    return {
        schemaVersion: 'ShadowWatchConsumableEvidenceV1',
        auditOnly: true,
        decisionProduced: false,
        evaluationTime: evaluationTime,
        safeNow: {
            canonicalSwingId: state.identity.canonicalSwingId,
            side: side,
            expectedWatchDirection: expectedDirection(side),
            baseLiquiditySide: expectedLiquiditySide(side),
            price: state.identity.price,
            confirmedAt: state.identity.confirmedAt,
            liquidityRoles: clone(state.liquidityRoles || null),
            eqMemberships: clone(state.topology && state.topology.eqMemberships || []),
            lifecycle: clone(lifecycle)
        },
        contextOnly: {
            formationDistinctiveness: clone(state.formation || null),
            topology: clone(state.topology || null),
            contextAtConfirmation: clone(state.context || null),
            fixedWindowReactionObservations: clone(reaction.fixedWindowObservations || {})
        },
        safeShadowOnly: {
            policyIdentity: policyIdentity,
            reactionCausalState: clone(reaction),
            attributedStructuralImpact: clone(structural),
            productionBlockedReason: policyIdentity ? 'REACTION_POLICY_UNRESOLVED' : 'NO_FROZEN_PRODUCTION_CAUSAL_SOURCE'
        },
        debugOnly: {
            provenance: clone(state.provenance || null),
            projectionPolicy: clone(state.projectionPolicy || null),
            projectionTime: state.projectionTime
        },
        temporalSafety: {
            swingConfirmedAtOrBeforeEvaluation: state.identity.confirmedAt <= evaluationTime,
            projectionAtOrBeforeEvaluation: typeof state.projectionTime !== 'number' || state.projectionTime <= evaluationTime,
            futureLeakViolations: 0
        }
    };
}

function mapCurrentWatchEvidence(watch) {
    if (!watch) throw new Error('WATCH_REQUIRED');
    var primary = watch.liquidityTaken && watch.liquidityTaken.primary;
    var expectedSide = watch.direction === 'BULLISH' ? 'SSL' : watch.direction === 'BEARISH' ? 'BSL' : null;
    return {
        watchId: watch.id,
        evaluationTime: watch.updatedAt,
        direction: watch.direction,
        liquidityIdentity: primary ? {
            sweepEventId: primary.id,
            sourceId: primary.sourceId,
            sourceType: primary.sourceType,
            side: primary.side,
            confirmedAt: primary.confirmedAt,
            relation: primary.relation
        } : null,
        lifecycleEvidence: primary ? 'SWEPT_EVENT_CONFIRMED' : 'NONE',
        directionConsistent: !!primary && primary.side === expectedSide,
        mssEvidence: watch.mss && watch.mss.exists ? {
            id: watch.mss.id,
            direction: watch.mss.direction,
            confirmedAt: watch.mss.confirmedAt,
            legLinked: true,
            sourceSwingAttributed: false,
            sourceReactionLegAttributed: false
        } : null,
        displacementEvidence: {
            canonicalDisplacementId: watch.canonicalDisplacementId || null,
            direction: watch.displacement && watch.displacement.direction,
            confirmedAt: watch.displacement && watch.displacement.confirmedAt,
            productionTrigger: true,
            sourceSwingAttributed: false,
            sourceReactionLegAttributed: false
        },
        associationSemantic: 'DIRECTION_MATCHING_SWEEP_WITHIN_PRODUCTION_LOOKBACK; PRIMARY_IS_NEAREST_NOT_CAUSAL_RANKING'
    };
}

module.exports = {
    LIFECYCLE_RANK: LIFECYCLE_RANK,
    PRIMARY_SELECTION_SEMANTIC: PRIMARY_SELECTION_SEMANTIC,
    stable: stable,
    evidenceHash: evidenceHash,
    expectedDirection: expectedDirection,
    expectedLiquiditySide: expectedLiquiditySide,
    normalizeBiasDirection: normalizeBiasDirection,
    alignBiasToLiquidity: alignBiasToLiquidity,
    temporalEventOrder: temporalEventOrder,
    projectTemporalEvidence: projectTemporalEvidence,
    advanceTemporalEvidence: advanceTemporalEvidence,
    canonicalIdentity: canonicalIdentity,
    candidateOrder: candidateOrder,
    mapSweepCandidate: mapSweepCandidate,
    buildShadowWatchEvidenceSnapshot: buildShadowWatchEvidenceSnapshot,
    assertTemporalSafety: assertTemporalSafety,
    mapSwingStateToWatchEvidence: mapSwingStateToWatchEvidence,
    mapCurrentWatchEvidence: mapCurrentWatchEvidence
};
