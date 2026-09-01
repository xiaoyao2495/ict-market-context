'use strict';

/**
 * WATCH Narrative Identity & Lifecycle V1.
 *
 * Pure classification/ownership layer over an already-qualified FIRST_TOUCH.
 * It does not create WATCHes, detect touches, change delivery eligibility, or
 * suppress notifications. State is fully reconstructable from touched WATCHes.
 */

var SCHEMA_VERSION = 'V1';
var ACTIVE = 'ACTIVE';
var SUPERSEDED = 'SUPERSEDED';
var NEW = 'NEW';
var CONTINUATION = 'CONTINUATION';
var REACTIVATION = 'REACTIVATION';

function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function enc(value) { return encodeURIComponent(String(value)); }

function primaryTaken(watch) {
    return watch && watch.liquidityTaken && watch.liquidityTaken.primary || null;
}

function timeframeOf(watch, taken) {
    return taken && (taken.sourceTimeframe || taken.timeframe) || watch && watch.timeframe || '5m';
}

function scopeKey(symbol, timeframe) {
    return enc(symbol) + ':' + enc(timeframe);
}

function buildNarrativeId(fields) {
    if (!fields || !fields.symbol || !fields.timeframe || !fields.direction || !fields.exactTakenEventId) return null;
    return 'WATCH_NARRATIVE:' + SCHEMA_VERSION + ':' + enc(fields.symbol) + ':' + enc(fields.timeframe) + ':' +
        fields.direction + ':' + enc(fields.exactTakenEventId);
}

function buildObservationId(fields) {
    if (!fields || !fields.narrativeId || !fields.watchId || !fields.primaryNativeFvgId) return null;
    return 'WATCH_OBSERVATION:' + SCHEMA_VERSION + ':' + enc(fields.narrativeId) + ':' +
        enc(fields.watchId) + ':' + enc(fields.primaryNativeFvgId);
}

function identityForWatch(watch) {
    var taken = primaryTaken(watch);
    var timeframe = timeframeOf(watch, taken);
    var narrativeId = buildNarrativeId({
        symbol: watch && watch.symbol,
        timeframe: timeframe,
        direction: watch && watch.direction,
        exactTakenEventId: taken && taken.id
    });
    var observationId = buildObservationId({
        narrativeId: narrativeId,
        watchId: watch && watch.id,
        primaryNativeFvgId: watch && watch.nativeFvg && watch.nativeFvg.id
    });
    return {
        narrativeId: narrativeId,
        observationId: observationId,
        symbol: watch && watch.symbol,
        timeframe: timeframe,
        direction: watch && watch.direction,
        taken: taken
    };
}

function validateFirstTouch(watch) {
    var identity = identityForWatch(watch);
    var taken = identity.taken;
    var firstTouchAt = watch && watch.firstTouchAt;
    if (!watch || !watch.id) return { ok:false, reason:'WATCH_ID_MISSING' };
    if (watch.state !== 'FVG_TOUCHED' && watch.state !== 'NOTIFIED') return { ok:false, reason:'NOT_FIRST_TOUCH_TERMINAL' };
    if (typeof firstTouchAt !== 'number') return { ok:false, reason:'FIRST_TOUCH_AT_MISSING' };
    if (typeof watch.updatedAt !== 'number' || watch.updatedAt > firstTouchAt) {
        return { ok:false, reason:'WATCH_NOT_AVAILABLE_AT_FIRST_TOUCH' };
    }
    if (!watch.notificationKey) return { ok:false, reason:'NOTIFICATION_KEY_MISSING' };
    if (!watch.nativeFvg || !watch.nativeFvg.id) return { ok:false, reason:'NATIVE_FVG_ID_MISSING' };
    if (typeof watch.nativeFvg.confirmedAt === 'number' && watch.nativeFvg.confirmedAt > firstTouchAt) {
        return { ok:false, reason:'FVG_CONFIRMED_AFTER_FIRST_TOUCH' };
    }
    if (!taken || taken.eventType !== 'LIQUIDITY_TAKEN' || !taken.id) return { ok:false, reason:'EXACT_TAKEN_ID_MISSING' };
    if (typeof taken.confirmedAt !== 'number' || taken.confirmedAt > firstTouchAt) {
        return { ok:false, reason:'TAKEN_NOT_CONFIRMED_AT_FIRST_TOUCH' };
    }
    if (!identity.narrativeId || !identity.observationId) return { ok:false, reason:'IDENTITY_UNRESOLVED' };
    var expectedSide = watch.direction === 'BULLISH' ? 'SSL' : watch.direction === 'BEARISH' ? 'BSL' : null;
    if (!expectedSide || taken.side !== expectedSide) return { ok:false, reason:'DIRECTION_TAKEN_SIDE_MISMATCH' };
    return { ok:true, identity:identity };
}

function createState() {
    return {
        schemaVersion: SCHEMA_VERSION,
        narrativesById: {},
        observationsById: {},
        observationOrder: [],
        activeByScope: {},
        transitions: [],
        activeNarrativeCardinalityViolations: 0
    };
}

function transition(state, narrative, type, from, to, at, observationId, otherNarrativeId) {
    var item = {
        type: type,
        narrativeId: narrative.id,
        from: from,
        to: to,
        at: at,
        observationId: observationId,
        otherNarrativeId: otherNarrativeId || null
    };
    narrative.transitions.push(item);
    state.transitions.push(item);
    narrative.state = to;
    return item;
}

function supersedeActive(state, activeId, at, observationId, byNarrativeId) {
    if (!activeId || activeId === byNarrativeId) return;
    var active = state.narrativesById[activeId];
    if (!active || active.state !== ACTIVE) return;
    transition(state, active, 'NARRATIVE_SUPERSEDED', ACTIVE, SUPERSEDED, at, observationId, byNarrativeId);
    active.supersededAt = at;
    active.supersededByNarrativeId = byNarrativeId;
}

function compactDisplacement(watch) {
    return clone({
        canonicalDisplacementId: watch && watch.canonicalDisplacementId || null,
        displacement: watch && watch.displacement || null
    });
}

function observeFirstTouch(state, watch) {
    var target = state || createState();
    var valid = validateFirstTouch(watch);
    if (!valid.ok) return { accepted:false, duplicate:false, reason:valid.reason, state:target };
    var identity = valid.identity;
    var existingObservation = target.observationsById[identity.observationId];
    if (existingObservation) {
        return {
            accepted:false, duplicate:true, reason:'DUPLICATE_OBSERVATION', state:target,
            observation:existingObservation,
            narrative:target.narrativesById[existingObservation.narrativeId]
        };
    }

    var scope = scopeKey(identity.symbol, identity.timeframe);
    var activeId = target.activeByScope[scope] || null;
    var narrative = target.narrativesById[identity.narrativeId] || null;
    var type;
    if (!narrative) {
        type = NEW;
        narrative = {
            id: identity.narrativeId,
            schemaVersion: SCHEMA_VERSION,
            symbol: identity.symbol,
            timeframe: identity.timeframe,
            direction: identity.direction,
            anchor: {
                takenEventId: identity.taken.id,
                liquidityId: identity.taken.sourceId || identity.taken.liquidityId || null,
                occurredAt: identity.taken.occurredAt === undefined ? null : identity.taken.occurredAt,
                confirmedAt: identity.taken.confirmedAt
            },
            state: SUPERSEDED,
            createdAt: watch.firstTouchAt,
            lastObservedAt: null,
            observationCount: 0,
            supersededAt: null,
            supersededByNarrativeId: null,
            reactivatedAt: null,
            transitions: []
        };
        target.narrativesById[narrative.id] = narrative;
    } else if (narrative.state === ACTIVE && activeId === narrative.id) {
        type = CONTINUATION;
    } else if (narrative.state === SUPERSEDED) {
        type = REACTIVATION;
    } else {
        target.activeNarrativeCardinalityViolations++;
        return { accepted:false, duplicate:false, reason:'INCONSISTENT_ACTIVE_OWNER', state:target };
    }

    var observation = {
        id: identity.observationId,
        schemaVersion: SCHEMA_VERSION,
        narrativeId: narrative.id,
        watchId: watch.id,
        notificationKey: watch.notificationKey,
        direction: watch.direction,
        canonicalDisplacementId: watch.canonicalDisplacementId || null,
        primaryNativeFvgId: watch.nativeFvg.id,
        observedAt: watch.firstTouchAt,
        type: type,
        narrativeState: ACTIVE,
        biasSnapshot: clone(watch.dailyBias || null),
        displacementSnapshot: compactDisplacement(watch),
        fvgSnapshot: clone(watch.nativeFvg)
    };

    target.transitions.push({
        type:'OBSERVATION_APPENDED', narrativeId:narrative.id, from:null, to:null,
        at:watch.firstTouchAt, observationId:observation.id, otherNarrativeId:null
    });

    if (activeId && activeId !== narrative.id) {
        supersedeActive(target, activeId, watch.firstTouchAt, observation.id, narrative.id);
    }
    if (type === NEW) {
        transition(target, narrative, 'NARRATIVE_ACTIVATED', null, ACTIVE,
            watch.firstTouchAt, observation.id, activeId);
    } else if (type === REACTIVATION) {
        transition(target, narrative, 'NARRATIVE_REACTIVATED', SUPERSEDED, ACTIVE,
            watch.firstTouchAt, observation.id, activeId);
        narrative.reactivatedAt = watch.firstTouchAt;
    }
    narrative.supersededAt = null;
    narrative.supersededByNarrativeId = null;
    narrative.lastObservedAt = watch.firstTouchAt;
    narrative.observationCount++;
    target.activeByScope[scope] = narrative.id;
    target.observationsById[observation.id] = observation;
    target.observationOrder.push(observation.id);

    if (activeCount(target, identity.symbol, identity.timeframe) > 1) {
        target.activeNarrativeCardinalityViolations++;
    }
    return { accepted:true, duplicate:false, state:target, observation:observation, narrative:narrative };
}

function metadataOf(result) {
    if (!result || !result.observation || !result.narrative) return null;
    return {
        narrativeId: result.observation.narrativeId,
        observationId: result.observation.id,
        observationType: result.observation.type,
        narrativeStateSnapshot: result.observation.narrativeState
    };
}

function attachMetadata(watch, result) {
    var metadata = metadataOf(result);
    if (!watch || !metadata) return watch;
    Object.keys(metadata).forEach(function (key) { watch[key] = metadata[key]; });
    return watch;
}

function compareTouchOrder(a, b) {
    var atA = typeof a.firstTouchAt === 'number' ? a.firstTouchAt : Infinity;
    var atB = typeof b.firstTouchAt === 'number' ? b.firstTouchAt : Infinity;
    if (atA !== atB) return atA - atB;
    var idA = identityForWatch(a).observationId || '';
    var idB = identityForWatch(b).observationId || '';
    return idA < idB ? -1 : idA > idB ? 1 : 0;
}

function reconstructFromWatches(watches) {
    var state = createState();
    var results = [];
    (watches || []).filter(function (watch) {
        return watch && (watch.state === 'FVG_TOUCHED' || watch.state === 'NOTIFIED') &&
            typeof watch.firstTouchAt === 'number';
    }).slice().sort(compareTouchOrder).forEach(function (watch) {
        var result = observeFirstTouch(state, watch);
        if (result.observation) results.push({ watchId:watch.id, result:result });
    });
    return { state:state, results:results };
}

function activeCount(state, symbol, timeframe) {
    return Object.keys(state && state.narrativesById || {}).filter(function (id) {
        var narrative = state.narrativesById[id];
        return narrative.symbol === symbol && narrative.timeframe === timeframe && narrative.state === ACTIVE;
    }).length;
}

function projection(state) {
    var narrativeIds = Object.keys(state.narrativesById).sort();
    return clone({
        schemaVersion: state.schemaVersion,
        narratives: narrativeIds.map(function (id) { return state.narrativesById[id]; }),
        observations: state.observationOrder.map(function (id) { return state.observationsById[id]; }),
        activeByScope: state.activeByScope,
        transitions: state.transitions,
        activeNarrativeCardinalityViolations: state.activeNarrativeCardinalityViolations
    });
}

module.exports = {
    SCHEMA_VERSION: SCHEMA_VERSION,
    ACTIVE: ACTIVE,
    SUPERSEDED: SUPERSEDED,
    NEW: NEW,
    CONTINUATION: CONTINUATION,
    REACTIVATION: REACTIVATION,
    buildNarrativeId: buildNarrativeId,
    buildObservationId: buildObservationId,
    identityForWatch: identityForWatch,
    validateFirstTouch: validateFirstTouch,
    createState: createState,
    observeFirstTouch: observeFirstTouch,
    reconstructFromWatches: reconstructFromWatches,
    compareTouchOrder: compareTouchOrder,
    attachMetadata: attachMetadata,
    metadataOf: metadataOf,
    activeCount: activeCount,
    projection: projection
};
