/**
 * Production 5m Structural Provenance V1.
 *
 * The only inputs are closed 5m candles and confirmed 2L/2R pivots. Liquidity
 * objects are copied into an independent structural state: liquidity lifecycle
 * never promotes or demotes a structural swing.
 */
'use strict';
var mssSignalDetector = require('../events/mssSignalDetector');
function createState(options) {
    var o = options || {};
    return {
        symbol: o.symbol || 'UNKNOWN',
        timeframe: o.timeframe || '5m',
        structuralState: 'UNKNOWN',
        swings: [],
        swingBySourceId: {},
        activeProtected: { HIGH: null, LOW: null },
        frontier: { HIGH: null, LOW: null },
        pendingProduced: { HIGH: null, LOW: null },
        retiredProduced: [],
        events: [],
        eventIds: {},
        mssSignals: [],
        mssSignalConsumedRefs: {},
        penetrations: [],
        penetrationIds: {}
    };
}

function sideOf(swing) {
    return swing.type === 'SWING_HIGH' ? 'HIGH' : 'LOW';
}

function transition(swing, role, status, confirmedAt, reason) {
    swing.role = role;
    swing.status = status;
    swing.history.push({ role: role, status: status, confirmedAt: confirmedAt, reason: reason });
}

function addConfirmedPivots(state, swings, evaluationTime) {
    var added = [];
    (swings || []).forEach(function (s) {
        if (s.confirmedAt == null || s.confirmedAt > evaluationTime) return;
        if (state.swingBySourceId[s.id]) return;
        var side = sideOf(s);
        var rec = {
            id: state.symbol + ':' + state.timeframe + ':STRUCTURAL_SWING:' + side + ':' + s.sourceOpenTime,
            sourceSwingId: s.id,
            symbol: state.symbol,
            timeframe: state.timeframe,
            side: side,
            price: s.price,
            occurredAt: s.sourceOpenTime,
            confirmedAt: s.confirmedAt,
            index: s.metadata && s.metadata.index != null ? s.metadata.index : null,
            role: 'LOCAL_SWING',
            status: 'CANDIDATE',
            provenance: null,
            protectedConfirmedAt: null,
            supersededBy: null,
            brokenAt: null,
            brokenConfirmedAt: null,
            producedCandidateFor: [],
            retiredProducedCandidateFor: [],
            history: [{ role: 'LOCAL_SWING', status: 'CANDIDATE', confirmedAt: s.confirmedAt,
                reason: 'CONFIRMED_2L2R_PIVOT' }]
        };
        state.swings.push(rec);
        state.swingBySourceId[s.id] = rec;
        added.push(rec);
    });
    return added;
}

function latestControl(state, side, parent, candle) {
    var eligible = state.swings.filter(function (s) {
        return s.side === side &&
            s.confirmedAt <= candle.closeTime &&
            s.occurredAt > parent.occurredAt &&
            s.occurredAt < candle.openTime;
    });
    eligible.sort(function (a, b) {
        if (b.occurredAt !== a.occurredAt) return b.occurredAt - a.occurredAt;
        return b.confirmedAt - a.confirmedAt;
    });
    return eligible[0] || null;
}

function bodyFacts(candle, direction, referencePrice) {
    var range = candle.high - candle.low;
    var body = Math.abs(candle.close - candle.open);
    var distance = direction === 'BULLISH'
        ? candle.close - referencePrice : referencePrice - candle.close;
    return {
        breakDistance: distance,
        breakPct: referencePrice > 0 ? distance / referencePrice : 0,
        bodyRatio: range > 0 ? body / range : 0,
        closeStrength: range > 0 ? (direction === 'BULLISH'
            ? (candle.close - candle.low) / range
            : (candle.high - candle.close) / range) : 0
    };
}

function sourceSummary(s) {
    return s ? {
        id: s.id,
        sourceSwingId: s.sourceSwingId,
        side: s.side,
        price: s.price,
        occurredAt: s.occurredAt,
        confirmedAt: s.confirmedAt,
        role: s.role,
        status: s.status,
        protectedConfirmedAt: s.protectedConfirmedAt
    } : null;
}

function addEvent(state, event) {
    if (state.eventIds[event.id]) return false;
    state.eventIds[event.id] = true;
    state.events.push(event);
    return true;
}

function promoteProtected(state, control, direction, parent, candle) {
    var side = direction === 'BULLISH' ? 'LOW' : 'HIGH';
    var old = state.activeProtected[side];
    var protectedConfirmedAt = Math.max(parent.confirmedAt, control.confirmedAt, candle.closeTime);
    control.provenance = {
        direction: direction,
        parentStructuralLevelId: parent.id,
        parentStructuralLevel: parent.price,
        parentStructuralLevelConfirmedAt: parent.confirmedAt,
        controllingSwingId: control.id,
        controllingSwingConfirmedAt: control.confirmedAt,
        bosCandleOpenTime: candle.openTime,
        bosCandleCloseTime: candle.closeTime,
        protectedConfirmedAt: protectedConfirmedAt
    };
    // A pivot that occurred while it was still a causal child of the
    // superseded opposite state cannot later protect the new state merely
    // because its 2R confirmation arrived after the state change.
    var unresolvedProducedRole = control.producedCandidateFor &&
        control.producedCandidateFor.length > 0;
    if (unresolvedProducedRole) {
        transition(control, 'INTERNAL', 'CANDIDATE', protectedConfirmedAt,
            'CONFLICTING_PRODUCED_AND_CONTROLLING_ROLES');
        return control;
    }
    if (old && old.id !== control.id && old.status === 'ACTIVE_PROTECTED') {
        transition(old, 'SUPERSEDED_PROTECTED', 'SUPERSEDED_PROTECTED',
            protectedConfirmedAt, 'NEW_CONFIRMED_PROVENANCE');
        old.supersededBy = control.id;
    }
    transition(control, 'ACTIVE_PROTECTED', 'ACTIVE_PROTECTED',
        protectedConfirmedAt, 'BOS_PROVENANCE_CONFIRMED');
    control.protectedConfirmedAt = protectedConfirmedAt;
    state.activeProtected[side] = control;
    return control;
}

function makeBreakEvent(state, type, direction, reference, control, candle, index, before) {
    var facts = bodyFacts(candle, direction, reference.price);
    var after = type === 'STRUCTURAL_MSS' ? direction : state.structuralState;
    return {
        id: state.symbol + ':' + state.timeframe + ':' + type + ':' + direction + ':' + reference.id + ':' + candle.openTime,
        symbol: state.symbol,
        timeframe: state.timeframe,
        type: type,
        direction: direction,
        occurredAt: candle.openTime,
        confirmedAt: candle.closeTime,
        candleIndex: index,
        price: reference.price,
        referenceLevel: reference.price,
        referenceRole: reference.role,
        structuralStateBefore: before,
        structuralStateAfter: after,
        stateChanged: type === 'STRUCTURAL_MSS',
        source: {
            referenceSwingId: reference.sourceSwingId,
            structuralSwingId: reference.id,
            referencePrice: reference.price,
            controllingSwingId: control ? control.sourceSwingId : null,
            breakDistance: facts.breakDistance,
            breakPct: facts.breakPct,
            candle: { open: candle.open, high: candle.high, low: candle.low, close: candle.close }
        },
        metadata: {
            structuralEventType: type,
            referenceRole: reference.role,
            bodyRatio: round4(facts.bodyRatio),
            closeStrength: round4(facts.closeStrength),
            protectedConfirmedAt: reference.protectedConfirmedAt
        }
    };
}

function makeBosEvent(state, type, direction, parent, control, candle, index, before) {
    var facts = bodyFacts(candle, direction, parent.price);
    return {
        id: state.symbol + ':' + state.timeframe + ':' + type + ':' + direction + ':' + parent.id + ':' + candle.openTime,
        symbol: state.symbol,
        timeframe: state.timeframe,
        type: type,
        direction: direction,
        occurredAt: candle.openTime,
        confirmedAt: candle.closeTime,
        candleIndex: index,
        price: parent.price,
        referenceLevel: parent.price,
        referenceRole: parent.role,
        structuralStateBefore: before,
        structuralStateAfter: before === 'UNKNOWN' ? direction : before,
        stateChanged: before === 'UNKNOWN',
        source: {
            referenceSwingId: parent.sourceSwingId,
            structuralSwingId: parent.id,
            referencePrice: parent.price,
            controllingSwingId: control.sourceSwingId,
            breakDistance: facts.breakDistance,
            breakPct: facts.breakPct,
            candle: { open: candle.open, high: candle.high, low: candle.low, close: candle.close }
        },
        metadata: {
            structuralEventType: type,
            bodyRatio: round4(facts.bodyRatio),
            closeStrength: round4(facts.closeStrength),
            protectedConfirmedAt: Math.max(parent.confirmedAt, control.confirmedAt, candle.closeTime)
        }
    };
}

function selectBootstrapParent(state, direction, candle) {
    var side = direction === 'BULLISH' ? 'HIGH' : 'LOW';
    var eligible = state.swings.filter(function (s) {
        if (s.side !== side || s.confirmedAt > candle.closeTime || s.occurredAt >= candle.openTime) return false;
        return direction === 'BULLISH' ? candle.close > s.price : candle.close < s.price;
    });
    eligible.sort(function (a, b) {
        if (direction === 'BULLISH' && b.price !== a.price) return b.price - a.price;
        if (direction === 'BEARISH' && a.price !== b.price) return a.price - b.price;
        return b.confirmedAt - a.confirmedAt;
    });
    return eligible[0] || null;
}

function registerWickPenetrations(state, candle, index, emitted) {
    ['HIGH', 'LOW'].forEach(function (side) {
        var s = state.activeProtected[side];
        if (!s || s.status !== 'ACTIVE_PROTECTED' || s.protectedConfirmedAt > candle.closeTime) return;
        var wickOnly = side === 'HIGH'
            ? candle.high > s.price && candle.close <= s.price
            : candle.low < s.price && candle.close >= s.price;
        if (!wickOnly) return;
        var id = state.symbol + ':' + state.timeframe + ':STRUCTURAL_PENETRATION:' + s.id + ':' + candle.openTime;
        if (state.penetrationIds[id]) return;
        state.penetrationIds[id] = true;
        var p = {
            id: id, symbol: state.symbol, timeframe: state.timeframe,
            type: 'STRUCTURAL_PENETRATION', side: side,
            direction: side === 'HIGH' ? 'BULLISH' : 'BEARISH',
            referenceLevel: s.price, referenceSwingId: s.sourceSwingId,
            occurredAt: candle.openTime, confirmedAt: candle.closeTime,
            candleIndex: index, closeBreak: false
        };
        state.penetrations.push(p);
        emitted.push(p);
    });
}

function updateProducedFrontiers(state, added) {
    added.forEach(function (s) {
        (state.retiredProduced || []).forEach(function (retired) {
            if (retired.consumed || retired.side !== s.side || s.occurredAt < retired.breakCandleOpenTime) return;
            var retiredBeyond = s.side === 'HIGH' ? s.price > retired.parentPrice : s.price < retired.parentPrice;
            if (!retiredBeyond) return;
            if (s.producedCandidateFor.indexOf(retired.eventId) < 0) s.producedCandidateFor.push(retired.eventId);
            s.retiredProducedCandidateFor.push(retired.eventId);
            retired.consumed = true;
            retired.consumedBy = s.id;
        });
        var p = state.pendingProduced[s.side];
        if (!p || s.occurredAt < p.breakCandleOpenTime) return;
        var beyond = s.side === 'HIGH' ? s.price > p.parentPrice : s.price < p.parentPrice;
        if (!beyond) return;
        s.producedCandidateFor.push(p.eventId);
        var cur = state.frontier[s.side];
        if (!cur || s.occurredAt > cur.occurredAt) {
            if (cur && cur.status === 'CANDIDATE' && cur.role === 'CONTROLLING_SWING') {
                transition(cur, 'INTERNAL', 'CANDIDATE', s.confirmedAt, 'PRODUCED_LEVEL_REPLACED_BEFORE_BREAK');
            }
            transition(s, 'CONTROLLING_SWING', 'CANDIDATE', s.confirmedAt, 'PRODUCED_BY_STRUCTURAL_BREAK');
            state.frontier[s.side] = s;
        }
    });
}

function processProtectedBreak(state, side, candle, index, emitted) {
    var ref = state.activeProtected[side];
    if (!ref || ref.status !== 'ACTIVE_PROTECTED' || ref.protectedConfirmedAt > candle.closeTime) return false;
    var direction = side === 'LOW' ? 'BEARISH' : 'BULLISH';
    var closedThrough = direction === 'BULLISH' ? candle.close > ref.price : candle.close < ref.price;
    if (!closedThrough) return false;
    var before = state.structuralState;
    // ACTIVE_PROTECTED is, by lifecycle construction, the protected side of
    // the current state. Its first closed-candle close-through is therefore
    // always the opposite state transition: confirm MSS immediately. A new
    // controlling swing/provenance is established later by the independent
    // produced-frontier -> BOS/continuation path.
    var event = makeBreakEvent(state, 'STRUCTURAL_MSS', direction, ref, null, candle, index, before);
    transition(ref, 'BROKEN', 'BROKEN', candle.closeTime, 'CLOSE_THROUGH_ACTIVE_PROTECTED');
    ref.brokenAt = candle.openTime;
    ref.brokenConfirmedAt = candle.closeTime;
    state.structuralState = direction;
    // Produced frontiers are directional causal children. Once an MSS
    // changes state, candidates produced by the superseded state retire.
    ['HIGH', 'LOW'].forEach(function (retiredSide) {
        var pending = state.pendingProduced[retiredSide];
        if (!pending) return;
        state.retiredProduced.push({
            side: retiredSide,
            parentPrice: pending.parentPrice,
            breakCandleOpenTime: pending.breakCandleOpenTime,
            eventId: pending.eventId,
            retiredAt: candle.closeTime,
            consumed: false,
            consumedBy: null
        });
    });
    state.pendingProduced.HIGH = null;
    state.pendingProduced.LOW = null;
    state.frontier.HIGH = null;
    state.frontier.LOW = null;
    event.structuralStateAfter = state.structuralState;
    addEvent(state, event);
    emitted.push(event);
    state.pendingProduced[direction === 'BULLISH' ? 'HIGH' : 'LOW'] = {
        parentPrice: ref.price, breakCandleOpenTime: candle.openTime, eventId: event.id
    };
    state.frontier[direction === 'BULLISH' ? 'HIGH' : 'LOW'] = null;
    return true;
}

function processBos(state, direction, candle, index, emitted) {
    // Once structure has a direction, an opposite state transition is only
    // authoritative when an ACTIVE_PROTECTED swing is closed through.  A
    // local/frontier close in the opposite direction cannot silently flip
    // state and manufacture another same-direction MSS later.
    if (state.structuralState !== 'UNKNOWN' && state.structuralState !== direction) return false;
    var side = direction === 'BULLISH' ? 'HIGH' : 'LOW';
    var parent = state.frontier[side];
    if (!parent && state.structuralState === 'UNKNOWN') parent = selectBootstrapParent(state, direction, candle);
    if (!parent || parent.confirmedAt > candle.closeTime || parent.occurredAt >= candle.openTime) return false;
    var closedThrough = direction === 'BULLISH' ? candle.close > parent.price : candle.close < parent.price;
    if (!closedThrough) return false;
    var control = latestControl(state, direction === 'BULLISH' ? 'LOW' : 'HIGH', parent, candle);
    if (!control) return false;
    var before = state.structuralState;
    var type = before === 'UNKNOWN' ? 'STRUCTURAL_BOS' : 'STRUCTURAL_CONTINUATION';
    transition(parent, 'CONTROLLING_SWING', 'BROKEN', candle.closeTime, 'CLOSE_THROUGH_STRUCTURAL_LEVEL');
    parent.brokenAt = candle.openTime;
    parent.brokenConfirmedAt = candle.closeTime;
    promoteProtected(state, control, direction, parent, candle);
    if (before === 'UNKNOWN') state.structuralState = direction;
    var event = makeBosEvent(state, type, direction, parent, control, candle, index, before);
    addEvent(state, event);
    emitted.push(event);
    state.pendingProduced[side] = {
        parentPrice: parent.price, breakCandleOpenTime: candle.openTime, eventId: event.id
    };
    state.frontier[side] = null;
    return true;
}

function markInternalCandidates(state, candle) {
    state.swings.forEach(function (s) {
        if (s.status !== 'CANDIDATE' || s.role !== 'LOCAL_SWING') return;
        if (s.confirmedAt > candle.closeTime) return;
        var active = state.activeProtected[s.side];
        if (!active) return;
        // This is descriptive only: a local pivot inside the active protected boundary
        // stays usable by liquidity but is not a structural reference.
        var internal = s.side === 'LOW' ? s.price > active.price : s.price < active.price;
        if (internal) transition(s, 'INTERNAL', 'CANDIDATE', candle.closeTime, 'INSIDE_ACTIVE_PROTECTED_BOUNDARY');
    });
}

function step(state, candle, index, newConfirmedSwings) {
    if (!candle || candle.closed === false) return { events: [], mss: [], structuralMss: [], bos: [], continuations: [], penetrations: [] };
    var emitted = [];
    var added = addConfirmedPivots(state, newConfirmedSwings, candle.closeTime);
    updateProducedFrontiers(state, added);
    // Signal coverage is evaluated from every confirmed 2L/2R swing before
    // structural lifecycle mutation. Provenance enriches the signal but cannot
    // suppress its existence.
    var signalMss = mssSignalDetector.detect({
        candle: candle, candleIndex: index, swings: state.swings.map(function (s) {
            return {
                id: s.sourceSwingId, symbol: s.symbol, timeframe: s.timeframe,
                type: 'SWING_' + s.side, price: s.price, sourceOpenTime: s.occurredAt,
                confirmedAt: s.confirmedAt
            };
        }),
        structuralState: state, consumedRefs: state.mssSignalConsumedRefs
    });
    registerWickPenetrations(state, candle, index, emitted);

    var brokeLow = processProtectedBreak(state, 'LOW', candle, index, emitted);
    var brokeHigh = processProtectedBreak(state, 'HIGH', candle, index, emitted);
    if (!brokeLow && !brokeHigh) {
        var preferred = candle.close >= candle.open ? 'BULLISH' : 'BEARISH';
        if (!processBos(state, preferred, candle, index, emitted)) {
            processBos(state, preferred === 'BULLISH' ? 'BEARISH' : 'BULLISH', candle, index, emitted);
        }
    }
    markInternalCandidates(state, candle);
    mssSignalDetector.linkStructuralContext(signalMss, emitted);
    Array.prototype.push.apply(state.mssSignals, signalMss);

    return {
        events: emitted,
        mss: signalMss,
        structuralMss: emitted.filter(function (e) { return e.type === 'STRUCTURAL_MSS'; }),
        bos: emitted.filter(function (e) { return e.type === 'STRUCTURAL_BOS'; }),
        continuations: emitted.filter(function (e) { return e.type === 'STRUCTURAL_CONTINUATION'; }),
        penetrations: emitted.filter(function (e) { return e.type === 'STRUCTURAL_PENETRATION'; })
    };
}

function qualityForMss(event) {
    if (!event || (event.type !== 'MSS' && event.type !== 'STRUCTURAL_MSS')) return 'NO_MSS';
    var protectedBreak = event.protectedBreak === true ||
        (event.metadata && event.metadata.protectedBreak === true) ||
        event.referenceRole === 'ACTIVE_PROTECTED' ||
        (event.metadata && event.metadata.referenceRole === 'ACTIVE_PROTECTED');
    return protectedBreak ? 'PROTECTED_SWING' : 'INTERNAL';
}

function round4(n) { return Math.round(n * 10000) / 10000; }

module.exports = {
    createState: createState,
    step: step,
    qualityForMss: qualityForMss
};
