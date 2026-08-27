'use strict';

var liquidityLifecycle = require('../liquidity/liquidityLifecycle');
var sweepEventAdapter = require('../events/sweepEventAdapter');

var STRUCTURAL_ROLES = {
    CONTROLLING_SWING: true,
    ACTIVE_PROTECTED: true,
    SUPERSEDED_PROTECTED: true,
    BROKEN: true
};

function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function structuralQualification(record) {
    if (!record) return null;
    var rows = (record.history || []).filter(function (h) {
        return h && STRUCTURAL_ROLES[h.role] && typeof h.confirmedAt === 'number';
    }).sort(function (a, b) {
        return a.confirmedAt - b.confirmedAt || String(a.role).localeCompare(String(b.role));
    });
    if (!rows.length) return null;
    return {
        availableAt: rows[0].confirmedAt,
        role: rows[0].role,
        reason: rows[0].reason || null,
        structuralSwingId: record.id || null,
        sourceSwingId: record.sourceSwingId || null
    };
}

function roleAt(record, evaluationTime) {
    if (!record || typeof evaluationTime !== 'number') return null;
    var visible = (record.history || []).filter(function (h) {
        return h && typeof h.confirmedAt === 'number' && h.confirmedAt <= evaluationTime;
    }).sort(function (a, b) { return a.confirmedAt - b.confirmedAt; });
    return visible.length ? visible[visible.length - 1].role : null;
}

function qualificationAt(record, evaluationTime) {
    var q = structuralQualification(record);
    return !!(q && q.availableAt <= evaluationTime);
}

function isSwing(object) {
    return object && (object.type === 'SWING_HIGH' || object.type === 'SWING_LOW');
}

function isEqual(object) {
    return object && (object.type === 'EQH' || object.type === 'EQL');
}

function memberIds(eq) {
    return (((eq || {}).metadata || {}).members || []).map(function (m) {
        return m && m.id;
    }).filter(Boolean);
}

function eqStructurallyFormed(eq, structuralBySourceId) {
    var ids = memberIds(eq);
    return ids.length >= 2 && ids.every(function (id) {
        var q = structuralQualification(structuralBySourceId[id]);
        return !!(q && q.availableAt <= eq.confirmedAt);
    });
}

function projectObjectIds(objects, structuralBySourceId, policy) {
    var ids = {};
    (objects || []).forEach(function (object) {
        if (isSwing(object)) {
            if (policy === 'A_LEGACY' || structuralQualification(structuralBySourceId[object.id])) {
                ids[object.id] = true;
            }
            return;
        }
        if (isEqual(object)) {
            if (policy === 'B_STRUCTURAL_ONLY') {
                if (eqStructurallyFormed(object, structuralBySourceId)) ids[object.id] = true;
            } else {
                ids[object.id] = true;
            }
            return;
        }
        ids[object.id] = true;
    });
    return ids;
}

function simulateQualifiedSwing(swing, qualification, candles, endTime) {
    if (!swing || !qualification) return null;
    var projected = clone(swing);
    projected.createdAt = qualification.availableAt;
    projected.confirmedAt = qualification.availableAt;
    projected.status = 'ACTIVE';
    projected.touchedAt = null;
    projected.sweptAt = null;
    projected.brokenAt = null;
    projected.metadata = projected.metadata || {};
    projected.metadata.shadowQualification = clone(qualification);
    var sweep = null;
    (candles || []).some(function (candle, index) {
        if (!candle || candle.closed === false || candle.closeTime <= qualification.availableAt || candle.closeTime > endTime) return false;
        if (projected.status !== 'ACTIVE' && projected.status !== 'TOUCHED') return true;
        var transition = liquidityLifecycle.evaluateLiquidity(projected, candle);
        if (!transition) return false;
        projected.status = transition.status;
        projected.touchedAt = transition.touchedAt;
        projected.sweptAt = transition.sweptAt;
        projected.brokenAt = transition.brokenAt;
        if (transition.status === 'SWEPT') {
            sweep = sweepEventAdapter.buildSweepEvent(projected, candle, index, projected.timeframe);
        }
        return projected.status === 'SWEPT' || projected.status === 'BROKEN';
    });
    return { object: projected, sweepEvent: sweep };
}

function projectPolicy(options) {
    var opts = options || {};
    var policy = opts.policy;
    var structural = opts.structuralBySourceId || {};
    var keep = projectObjectIds(opts.objects, structural, policy);
    var objects = [];
    var replacementSweeps = {};
    (opts.objects || []).forEach(function (object) {
        if (!keep[object.id]) return;
        if (policy !== 'A_LEGACY' && isSwing(object)) {
            var simulated = simulateQualifiedSwing(
                object,
                structuralQualification(structural[object.id]),
                opts.candles || [],
                opts.endTime
            );
            if (simulated) {
                objects.push(simulated.object);
                if (simulated.sweepEvent) replacementSweeps[object.id] = simulated.sweepEvent;
            }
        } else {
            objects.push(clone(object));
        }
    });
    var sweeps = [];
    (opts.sweepEvents || []).forEach(function (event) {
        if (!event || !keep[event.liquidityId]) return;
        if (policy !== 'A_LEGACY' && structural[event.liquidityId]) return;
        sweeps.push(clone(event));
    });
    Object.keys(replacementSweeps).forEach(function (id) { sweeps.push(replacementSweeps[id]); });
    sweeps.sort(function (a, b) {
        return a.confirmedAt - b.confirmedAt || String(a.id).localeCompare(String(b.id));
    });
    return { policy: policy, objectIds: keep, objects: objects, sweepEvents: sweeps };
}

function futureLeakViolations(projection) {
    var violations = [];
    (projection.objects || []).forEach(function (object) {
        var q = object.metadata && object.metadata.shadowQualification;
        if (q && object.confirmedAt < q.availableAt) {
            violations.push({ id: object.id, reason: 'OBJECT_BEFORE_QUALIFICATION' });
        }
    });
    (projection.sweepEvents || []).forEach(function (event) {
        if (typeof event.confirmedAt !== 'number') {
            violations.push({ id: event.id, reason: 'SWEEP_MISSING_CONFIRMED_AT' });
        }
    });
    return violations;
}

module.exports = {
    STRUCTURAL_ROLES: STRUCTURAL_ROLES,
    structuralQualification: structuralQualification,
    roleAt: roleAt,
    qualificationAt: qualificationAt,
    memberIds: memberIds,
    eqStructurallyFormed: eqStructurallyFormed,
    projectObjectIds: projectObjectIds,
    simulateQualifiedSwing: simulateQualifiedSwing,
    projectPolicy: projectPolicy,
    futureLeakViolations: futureLeakViolations,
    isSwing: isSwing,
    isEqual: isEqual
};
