'use strict';

/** Audit-only SwingStateV1 temporal projector. No detector logic lives here. */
var crypto = require('crypto');
var boundaryPolicy = require('./reactionBoundaryPolicyV1');
var LIFECYCLE_RANK = { ACTIVE: 0, TOUCHED: 1, SWEPT: 2, BROKEN: 3 };

function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function stable(value) {
    if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(function (key) { return JSON.stringify(key) + ':' + stable(value[key]); }).join(',') + '}';
    return JSON.stringify(value);
}
function stateHash(value) { return crypto.createHash('sha256').update(stable(value)).digest('hex'); }
function normalizePolicy(policy) {
    if (!policy) return null;
    var value = policy.reactionBoundaryPolicy || policy;
    var registered = boundaryPolicy.getReactionBoundaryPolicy(value.policyId, value.policyVersion);
    return clone(registered.reactionBoundaryPolicy);
}
function policyIdentity(policy) {
    return policy ? boundaryPolicy.canonicalReactionBoundaryPolicyIdentity(policy.policyId, policy.policyVersion) : null;
}
function eventOrder(a, b) {
    if (a.availableAt !== b.availableAt) return a.availableAt - b.availableAt;
    if ((a.sequence || 0) !== (b.sequence || 0)) return (a.sequence || 0) - (b.sequence || 0);
    return String(a.id).localeCompare(String(b.id));
}

function notConfirmed(base, evaluationTime) {
    return {
        schemaVersion: 'SwingStateV1', projectionTime: evaluationTime,
        status: 'NOT_CONFIRMED', identity: clone(base.identity),
        availableAt: base.identity.confirmedAt
    };
}

function initialState(base, evaluationTime, policy) {
    var projectionPolicy = normalizePolicy(policy);
    return {
        schemaVersion: 'SwingStateV1', projectionTime: evaluationTime, status: 'CONFIRMED',
        projectionPolicy: projectionPolicy,
        projectionPolicyIdentity: policyIdentity(projectionPolicy),
        identity: clone(base.identity),
        formation: clone(base.formation),
        topology: clone(base.topology),
        liquidityRoles: clone(base.liquidityRoles),
        context: clone(base.context),
        reaction: {
            status: 'NOT_STARTED', availableAt: base.identity.confirmedAt,
            updatedAt: base.identity.confirmedAt, reactionLegId: null,
            direction: base.identity.side === 'SWING_HIGH' ? 'BEARISH' : 'BULLISH',
            observationStartAt: null, initiatedAt: null, endAt: null, endReason: null,
            frontier: base.identity.price, evidence: null, fixedWindowObservations: {},
            parameterDependent: null, policy: projectionPolicy, provenanceEventIds: []
        },
        structuralImpact: {
            status: 'NONE', availableAt: base.identity.confirmedAt,
            updatedAt: base.identity.confirmedAt, reference: null, mss: null,
            displacement: null, followThrough: {}, attributionReactionLegId: null,
            sourceSwingId: null, sourceReactionLegId: null,
            reactionBoundaryPolicy: projectionPolicy ? {
                policyId: projectionPolicy.policyId,
                policyVersion: projectionPolicy.policyVersion
            } : null,
            provenanceEventIds: []
        },
        lifecycle: {
            status: 'ACTIVE', availableAt: base.identity.confirmedAt,
            updatedAt: base.identity.confirmedAt, touchedAt: null, sweptAt: null,
            brokenAt: null, provenanceEventIds: []
        },
        provenance: {
            swingDetectorId: base.identity.canonicalSwingId,
            eqObjectIds: [], structuralEventIds: [], lifecycleEventIds: [],
            projectedEventIds: []
        },
        timestamps: {
            occurredAt: base.identity.occurredAt,
            confirmedAt: base.identity.confirmedAt,
            projectedAt: evaluationTime
        },
        derivedAtEvaluationTime: {
            ageBars: Math.max(0, Math.floor((evaluationTime - base.identity.occurredAt) / 300000)),
            barsSinceConfirmed: Math.max(0, Math.floor((evaluationTime - base.identity.confirmedAt) / 300000)),
            currentDistanceATR: null,
            currentDistanceAvailable: false,
            sourceOfTruth: 'QUERY_TIME_MARKET_CONTEXT',
            updatedAt: evaluationTime
        }
    };
}

function fail(code, message) {
    var error = new Error(message || code);
    error.code = code;
    throw error;
}

function validatePolicyEvent(state, event) {
    if (!state.projectionPolicy) return;
    var isReaction = /^REACTION_/.test(event.type);
    var isStructural = event.type === 'STRUCTURAL_MSS_ATTRIBUTED' ||
        event.type === 'DISPLACEMENT_ATTRIBUTED' || event.type === 'FOLLOW_THROUGH_UPDATED';
    if (!isReaction && !isStructural) return;
    var eventPolicy = event.payload && event.payload.reactionBoundaryPolicy;
    if (!eventPolicy) fail('MISSING_REACTION_BOUNDARY_POLICY_PROVENANCE');
    var result = boundaryPolicy.validateReactionBoundaryPolicyConsistency(
        { reactionBoundaryPolicy: state.projectionPolicy },
        { reactionBoundaryPolicy: eventPolicy }
    );
    if (!result.valid) fail(result.code);
}

function applyEvent(state, event) {
    if (!event || event.availableAt > state.projectionTime) return state;
    validatePolicyEvent(state, event);
    state.provenance.projectedEventIds.push(event.id);
    if (event.type === 'EQ_MEMBERSHIP_ASSIGNED') {
        state.topology.eqMemberships.push(clone(event.payload));
        state.topology.status = 'EQ_MEMBER';
        state.topology.updatedAt = event.availableAt;
        state.liquidityRoles.assignments.push({
            role: event.payload.eqRole, sourceId: event.payload.eqObjectId,
            availableAt: event.availableAt, sourceOfTruth: 'EQH_EQL_REGISTRY'
        });
        state.liquidityRoles.updatedAt = event.availableAt;
        state.provenance.eqObjectIds.push(event.payload.eqObjectId);
        return state;
    }
    if (event.type === 'EQ_MEMBERSHIP_LIFECYCLE_UPDATED') {
        var membership = state.topology.eqMemberships.filter(function (item) { return item.eqObjectId === event.payload.eqObjectId; })[0];
        if (!membership) fail('EQ_LIFECYCLE_WITHOUT_MEMBERSHIP');
        membership.objectLifecycleState = event.payload.objectLifecycleState;
        membership.lifecycleAvailableAt = event.availableAt;
        membership.lifecycleProvenanceEventId = event.id;
        state.topology.updatedAt = event.availableAt;
        return state;
    }
    if (event.type === 'REACTION_OBSERVATION_STARTED') {
        state.reaction.status = 'OBSERVING';
        state.reaction.observationStartAt = event.availableAt;
        state.reaction.reactionLegId = event.payload.reactionLegId;
        state.reaction.policy = clone(event.payload.reactionBoundaryPolicy || state.projectionPolicy);
        state.reaction.parameterDependent = event.payload.parameterDependent === true;
    } else if (event.type === 'REACTION_STARTED') {
        state.reaction.status = 'DEVELOPING';
        state.reaction.initiatedAt = event.availableAt;
        state.reaction.reactionLegId = event.payload.reactionLegId;
    } else if (event.type === 'REACTION_EVIDENCE_UPDATED') {
        state.reaction.evidence = clone(event.payload.evidence);
        state.reaction.frontier = event.payload.frontier;
    } else if (event.type === 'REACTION_WINDOW_OBSERVED') {
        state.reaction.fixedWindowObservations[String(event.payload.horizonBars)] = clone(event.payload.observation);
    } else if (event.type === 'REACTION_TERMINATED') {
        state.reaction.status = 'TERMINATED';
        state.reaction.endAt = event.availableAt;
        state.reaction.endReason = event.payload.endReason;
    } else if (event.type === 'REACTION_CAPPED') {
        state.reaction.status = 'CAPPED';
        state.reaction.endAt = event.availableAt;
        state.reaction.endReason = 'AUDIT_SAFETY_CAP';
    } else if (event.type === 'REACTION_DATA_END') {
        state.reaction.status = 'DATA_END';
        state.reaction.endAt = event.availableAt;
        state.reaction.endReason = 'DATA_END';
    } else if (event.type === 'STRUCTURAL_MSS_ATTRIBUTED') {
        if (state.projectionPolicy && (!event.payload.sourceSwingId || !event.payload.sourceReactionLegId ||
            !event.payload.reference || !event.payload.reference.swingId ||
            !event.payload.mss || !event.payload.mss.id)) {
            fail('MISSING_STRUCTURAL_IMPACT_PROVENANCE');
        }
        if (state.projectionPolicy && event.payload.sourceSwingId !== state.identity.canonicalSwingId) fail('STRUCTURAL_IMPACT_SOURCE_SWING_MISMATCH');
        if (state.projectionPolicy && state.reaction.reactionLegId && event.payload.sourceReactionLegId !== state.reaction.reactionLegId) fail('STRUCTURAL_IMPACT_SOURCE_REACTION_LEG_MISMATCH');
        state.structuralImpact.status = 'STRUCTURAL_MSS_CONFIRMED';
        state.structuralImpact.reference = clone(event.payload.reference);
        state.structuralImpact.mss = clone(event.payload.mss);
        state.structuralImpact.attributionReactionLegId = event.payload.sourceReactionLegId;
        state.structuralImpact.sourceSwingId = event.payload.sourceSwingId;
        state.structuralImpact.sourceReactionLegId = event.payload.sourceReactionLegId;
        state.structuralImpact.reactionBoundaryPolicy = clone(event.payload.reactionBoundaryPolicy || null);
        state.structuralImpact.provenanceEventIds.push(event.id);
        state.provenance.structuralEventIds.push(event.payload.mss.id);
        state.structuralImpact.updatedAt = event.availableAt;
        state.structuralImpact.availableAt = event.availableAt;
        return state;
    } else if (event.type === 'DISPLACEMENT_ATTRIBUTED') {
        if (state.projectionPolicy && (!state.structuralImpact.mss || event.payload.sourceMssId !== state.structuralImpact.mss.id ||
            event.payload.sourceReactionLegId !== state.structuralImpact.sourceReactionLegId ||
            event.payload.sourceSwingId !== state.identity.canonicalSwingId || !event.payload.displacementId)) {
            fail('MISSING_STRUCTURAL_IMPACT_PROVENANCE');
        }
        state.structuralImpact.status = 'SAME_DELIVERY_DISPLACEMENT_CONFIRMED';
        state.structuralImpact.displacement = clone(event.payload);
        state.structuralImpact.provenanceEventIds.push(event.id);
        state.provenance.structuralEventIds.push(event.payload.displacementId);
        state.structuralImpact.updatedAt = event.availableAt;
        return state;
    } else if (event.type === 'FOLLOW_THROUGH_UPDATED') {
        if (state.projectionPolicy && (!state.structuralImpact.displacement || event.payload.sourceDisplacementId !== state.structuralImpact.displacement.displacementId)) {
            fail('MISSING_STRUCTURAL_IMPACT_PROVENANCE');
        }
        state.structuralImpact.status = 'DELIVERY_FOLLOW_THROUGH_OBSERVED';
        state.structuralImpact.followThrough[String(event.payload.horizonBars)] = clone(event.payload);
        state.structuralImpact.provenanceEventIds.push(event.id);
        state.structuralImpact.updatedAt = event.availableAt;
        return state;
    } else if (event.type === 'LIQUIDITY_TOUCHED' || event.type === 'LIQUIDITY_SWEPT' || event.type === 'LIQUIDITY_BROKEN') {
        var next = event.type === 'LIQUIDITY_TOUCHED' ? 'TOUCHED' : event.type === 'LIQUIDITY_SWEPT' ? 'SWEPT' : 'BROKEN';
        if (LIFECYCLE_RANK[next] < LIFECYCLE_RANK[state.lifecycle.status]) throw new Error('Lifecycle regression for '+state.identity.canonicalSwingId);
        state.lifecycle.status = next;
        state.lifecycle.updatedAt = event.availableAt;
        if (next === 'TOUCHED' && state.lifecycle.touchedAt == null) state.lifecycle.touchedAt = event.availableAt;
        if (next === 'SWEPT') { if (state.lifecycle.touchedAt == null) state.lifecycle.touchedAt = event.availableAt; state.lifecycle.sweptAt = event.availableAt; }
        if (next === 'BROKEN') { if (state.lifecycle.touchedAt == null) state.lifecycle.touchedAt = event.availableAt; state.lifecycle.brokenAt = event.availableAt; }
        state.lifecycle.provenanceEventIds.push(event.id);
        state.provenance.lifecycleEventIds.push(event.id);
        return state;
    }
    if (/^REACTION_/.test(event.type)) {
        state.reaction.updatedAt = event.availableAt;
        state.reaction.provenanceEventIds.push(event.id);
    }
    return state;
}

function projectSwingState(base, events, evaluationTime, policy) {
    if (evaluationTime < base.identity.confirmedAt) return notConfirmed(base, evaluationTime);
    var state = initialState(base, evaluationTime, policy);
    (events || []).filter(function (e) { return e.swingId === base.identity.canonicalSwingId && e.availableAt <= evaluationTime; }).slice().sort(eventOrder).forEach(function (e) { applyEvent(state, e); });
    return state;
}

function advanceSwingState(previousState, newEvents, evaluationTime, policy) {
    if (!previousState || previousState.status === 'NOT_CONFIRMED') fail('INCREMENTAL_STATE_NOT_CONFIRMED');
    if (evaluationTime < previousState.projectionTime) fail('INCREMENTAL_EVALUATION_TIME_REGRESSION');
    var expectedPolicy = normalizePolicy(policy || previousState.projectionPolicy);
    if (policyIdentity(expectedPolicy) !== previousState.projectionPolicyIdentity) fail('REACTION_BOUNDARY_POLICY_MISMATCH');
    var state = clone(previousState), seen = {};
    state.provenance.projectedEventIds.forEach(function (id) { seen[id] = true; });
    state.projectionTime = evaluationTime;
    state.timestamps.projectedAt = evaluationTime;
    state.derivedAtEvaluationTime.ageBars = Math.max(0, Math.floor((evaluationTime - state.identity.occurredAt) / 300000));
    state.derivedAtEvaluationTime.barsSinceConfirmed = Math.max(0, Math.floor((evaluationTime - state.identity.confirmedAt) / 300000));
    state.derivedAtEvaluationTime.updatedAt = evaluationTime;
    (newEvents || []).filter(function (event) {
        return event.swingId === state.identity.canonicalSwingId && event.availableAt <= evaluationTime && !seen[event.id];
    }).slice().sort(eventOrder).forEach(function (event) { applyEvent(state, event); });
    return state;
}

function projectIncrementally(base, events, evaluationTime, policy) {
    if (evaluationTime < base.identity.confirmedAt) return notConfirmed(base, evaluationTime);
    var state = initialState(base, base.identity.confirmedAt, policy);
    return advanceSwingState(state, events, evaluationTime, policy);
}

function getSwingFormationState(base, evaluationTime) {
    if (evaluationTime < base.identity.confirmedAt) return notConfirmed(base, evaluationTime);
    return {
        schemaVersion: 'SwingFormationStateV1', status: 'CONFIRMED', projectionTime: evaluationTime,
        identity: clone(base.identity), formation: clone(base.formation),
        formationTopologySnapshot: clone(base.topology.formationSnapshot),
        contextAtConfirmation: clone(base.context.atConfirmation),
        liquidityRoleAtConfirmation: clone(base.liquidityRoles.atConfirmation)
    };
}

function getSwingStateAt(base, events, evaluationTime) {
    return projectSwingState(base, events, evaluationTime, arguments[3]);
}

module.exports = {
    LIFECYCLE_RANK: LIFECYCLE_RANK,
    eventOrder: eventOrder,
    applyEvent: applyEvent,
    initialState: initialState,
    projectSwingState: projectSwingState,
    getSwingStateAt: getSwingStateAt,
    projectIncrementally: projectIncrementally,
    advanceSwingState: advanceSwingState,
    stable: stable,
    stateHash: stateHash,
    getSwingFormationState: getSwingFormationState
};
