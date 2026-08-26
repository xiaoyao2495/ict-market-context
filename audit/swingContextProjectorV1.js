'use strict';

var crypto = require('crypto');

var TIMEFRAMES = ['5m', '15m', '1h', '4h'];

function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (!value || typeof value !== 'object') return value;
    var out = {};
    Object.keys(value).sort().forEach(function (key) { out[key] = stable(value[key]); });
    return out;
}
function hash(value) { return crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex'); }
function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function transitionId(transition) {
    return ['SWING_CONTEXT_V1', 'STRUCTURAL_TRANSITION', transition.sourceSwingId,
        transition.confirmedAt, transition.sequence, transition.role, transition.status].join(':');
}
function canonicalTransitions(transitions) {
    return (transitions || []).map(function (transition) {
        var copy = clone(transition);
        copy.sequence = Number.isFinite(copy.sequence) ? copy.sequence : 0;
        copy.id = copy.id || transitionId(copy);
        return copy;
    }).sort(function (a, b) {
        return String(a.sourceSwingId).localeCompare(String(b.sourceSwingId)) ||
            a.confirmedAt - b.confirmedAt || a.sequence - b.sequence || a.id.localeCompare(b.id);
    });
}
function createSwingContextProjectorV1(options) {
    var opts = options || {}, swingById = {}, transitionsById = {};
    (opts.swings || []).slice().sort(function (a, b) { return a.canonicalSwingId.localeCompare(b.canonicalSwingId); }).forEach(function (swing) {
        swingById[swing.canonicalSwingId] = clone(swing);
    });
    canonicalTransitions(opts.structuralTransitions).forEach(function (transition) {
        (transitionsById[transition.sourceSwingId] || (transitionsById[transition.sourceSwingId] = [])).push(transition);
    });

    function structuralAsOf(canonicalSwingId, evaluationTime) {
        var eligible = (transitionsById[canonicalSwingId] || []).filter(function (transition) {
            return transition.confirmedAt <= evaluationTime;
        });
        var current = eligible.length ? eligible[eligible.length - 1] : null;
        if (!current) return null;
        return {
            currentRole: current.role,
            currentStatus: current.status,
            roleAsOf: current.confirmedAt,
            provenance: {
                sourceSwingId: canonicalSwingId,
                roleSource: opts.structuralRoleSource || 'production structural5m.swingBySourceId history',
                transitionId: current.id,
                transitionSequence: current.sequence,
                transitionRole: current.role,
                transitionStatus: current.status,
                effectiveAt: current.confirmedAt,
                authoritativeStateCopied: false
            }
        };
    }

    function membershipAsOf(swing, timeframe, evaluationTime) {
        var finalMembership = swing.timeframeMembership[timeframe] || { member: false };
        if (!finalMembership.member || finalMembership.confirmedAt > evaluationTime) {
            return { confirmed: false, swingId: null, occurredAt: null, confirmedAt: null, provenance: null };
        }
        return {
            confirmed: true,
            swingId: finalMembership.htfSwingId,
            occurredAt: finalMembership.occurredAt,
            confirmedAt: finalMembership.confirmedAt,
            provenance: timeframe === '5m' ? {
                source: 'production confirmed 5m Swing identity',
                underlying5mCanonicalSwingId: swing.canonicalSwingId
            } : {
                source: opts.mtfMembershipSource || 'validated confirmed MTF identity mapping',
                timeframe: timeframe,
                htfSwingId: finalMembership.htfSwingId,
                underlying5mCanonicalSwingId: swing.canonicalSwingId,
                htfOccurredAt: finalMembership.occurredAt,
                htfConfirmedAt: finalMembership.confirmedAt,
                mapping: clone(finalMembership.mappingProvenance || null)
            }
        };
    }

    function projectSwingContextV1(input) {
        var request = input || {}, swing = swingById[request.canonicalSwingId], evaluationTime = request.evaluationTime;
        if (!swing || !Number.isFinite(evaluationTime) || swing.confirmedAt > evaluationTime) return null;
        var memberships = {};
        TIMEFRAMES.forEach(function (timeframe) { memberships[timeframe] = membershipAsOf(swing, timeframe, evaluationTime); });
        var structural = structuralAsOf(swing.canonicalSwingId, evaluationTime);
        if (!structural) return null;
        return {
            schemaVersion: 'SwingContextV1',
            canonicalSwingId: swing.canonicalSwingId,
            side: swing.side,
            price: swing.price,
            occurredAt: swing.occurredAt,
            confirmedAt: swing.confirmedAt,
            structural: structural,
            timeframeMembership: memberships,
            evaluationTime: evaluationTime,
            provenance: {
                projectionType: 'READ_MODEL_AS_OF',
                swingIdentitySource: opts.swingIdentitySource || 'production Swing detector frozen population',
                structuralSource: opts.structuralRoleSource || 'production structural5m.swingBySourceId history',
                mtfSource: opts.mtfMembershipSource || 'validated confirmed MTF identity mapping',
                projectorVersion: 'SwingContextV1',
                authoritativeRegistry: false
            }
        };
    }

    function projectSwingContextsV1(input) {
        var request = input || {};
        return (request.canonicalSwingIds || []).slice().sort().map(function (canonicalSwingId) {
            return projectSwingContextV1({ canonicalSwingId: canonicalSwingId, evaluationTime: request.evaluationTime });
        }).filter(Boolean);
    }

    return {
        projectSwingContextV1: projectSwingContextV1,
        projectSwingContextsV1: projectSwingContextsV1,
        structuralAsOf: structuralAsOf,
        canonicalSwingIds: Object.keys(swingById).sort()
    };
}

module.exports = {
    TIMEFRAMES: TIMEFRAMES,
    stable: stable,
    hash: hash,
    transitionId: transitionId,
    canonicalTransitions: canonicalTransitions,
    createSwingContextProjectorV1: createSwingContextProjectorV1
};
