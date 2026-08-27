'use strict';

/** Audit-only temporal read model for production EQ registry facts. */
var crypto = require('crypto');
var RANK = { ACTIVE: 0, TOUCHED: 1, SWEPT: 2, BROKEN: 3 };

function stable(value) {
    if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(function (k) { return JSON.stringify(k) + ':' + stable(value[k]); }).join(',') + '}';
    return JSON.stringify(value);
}
function hash(value) { return crypto.createHash('sha256').update(typeof value === 'string' ? value : stable(value)).digest('hex'); }
function eventId(type, eqObjectId, canonicalSwingId, effectiveAt) {
    return 'EQEV1:' + hash({ type: type, eqObjectId: eqObjectId, canonicalSwingId: canonicalSwingId || null, effectiveAt: effectiveAt }).slice(0, 32);
}
function order(a, b) { if (a.effectiveAt !== b.effectiveAt) return a.effectiveAt - b.effectiveAt; if ((a.sequence || 0) !== (b.sequence || 0)) return (a.sequence || 0) - (b.sequence || 0); return a.eventId.localeCompare(b.eventId); }
function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }

function applyEvent(store, event) {
    var id = event.eqObjectId, obj = store[id];
    if (event.eventType === 'EQ_OBJECT_CREATED') {
        if (obj) return store;
        store[id] = {
            eqObjectId: id, type: event.type, side: event.side,
            createdAt: event.eqObjectCreatedAt, formationAvailableAt: event.formationAvailableAt,
            anchor: clone(event.anchor), members: [], currentLifecycleState: 'ACTIVE',
            lastLifecycleTransitionAt: null,
            provenance: { objectCreationEventId: event.eventId, membershipEventIds: [], lifecycleEventIds: [], source: 'PRODUCTION_EQ_REGISTRY' }
        };
        return store;
    }
    if (!obj) throw new Error('Event before EQ object creation: ' + event.eventId);
    if (event.eventType === 'EQ_MEMBER_ATTACHED') {
        if (!obj.members.some(function (m) { return m.canonicalSwingId === event.canonicalSwingId; })) {
            obj.members.push({
                canonicalSwingId: event.canonicalSwingId, memberSide: event.memberSide,
                memberPrice: event.memberPrice, memberOccurredAt: event.memberOccurredAt,
                memberConfirmedAt: event.memberConfirmedAt, attachedAt: event.attachedAt,
                availableAt: event.availableAt
            });
            obj.members.sort(function (a, b) { return a.memberOccurredAt - b.memberOccurredAt || a.canonicalSwingId.localeCompare(b.canonicalSwingId); });
            obj.provenance.membershipEventIds.push(event.eventId);
        }
        return store;
    }
    if (/^EQ_LIFECYCLE_/.test(event.eventType)) {
        if (RANK[event.nextState] < RANK[obj.currentLifecycleState]) throw new Error('Lifecycle regression: ' + event.eventId);
        obj.currentLifecycleState = event.nextState;
        obj.lastLifecycleTransitionAt = event.effectiveAt;
        obj.provenance.lifecycleEventIds.push(event.eventId);
    }
    return store;
}

function projectEqState(events, evaluationTime) {
    var store = {};
    (events || []).filter(function (e) { return e.effectiveAt <= evaluationTime; }).slice().sort(order).forEach(function (e) { applyEvent(store, e); });
    return Object.keys(store).sort().map(function (id) { var out = clone(store[id]); out.evaluationTime = evaluationTime; return out; });
}
function getEqObjectStateAt(eqObjectId, events, evaluationTime) {
    return projectEqState((events || []).filter(function (e) { return e.eqObjectId === eqObjectId; }), evaluationTime)[0] || null;
}
function getEqMembershipAt(canonicalSwingId, events, evaluationTime) {
    var states = projectEqState(events, evaluationTime), out = [];
    states.forEach(function (state) {
        state.members.filter(function (m) { return m.canonicalSwingId === canonicalSwingId && m.availableAt <= evaluationTime; }).forEach(function (m) {
            out.push({ eqObjectId: state.eqObjectId, type: state.type, membership: clone(m), objectLifecycleState: state.currentLifecycleState, evaluationTime: evaluationTime, provenance: clone(state.provenance) });
        });
    });
    return out;
}
function incrementalProject(events) {
    var store = {};
    (events || []).slice().sort(order).forEach(function (e) { applyEvent(store, e); });
    return Object.keys(store).sort().map(function (id) { return clone(store[id]); });
}

module.exports = { RANK: RANK, stable: stable, hash: hash, eventId: eventId, order: order, applyEvent: applyEvent, projectEqState: projectEqState, getEqObjectStateAt: getEqObjectStateAt, getEqMembershipAt: getEqMembershipAt, incrementalProject: incrementalProject };
