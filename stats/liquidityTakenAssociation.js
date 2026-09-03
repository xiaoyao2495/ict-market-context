'use strict';

/**
 * Production WATCH association for already-emitted LIQUIDITY_TAKEN facts.
 * This module never recomputes a trade-through and never accepts Sweep events.
 */
var WATCH_TAKEN_LOOKBACK_BARS = 24;
var ELIGIBLE_TYPES = {
    EQH:true, EQL:true
};

function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function buildCandidate(event, displacement) {
    var sourceType = event.source && event.source.liquidityType || 'UNKNOWN';
    var distance = displacement.startIndex - event.candleIndex;
    var candidate = {
        id:event.id,
        eventType:'LIQUIDITY_TAKEN',
        side:event.side,
        sourceType:sourceType,
        sourceTimeframe:event.timeframe || 'UNKNOWN',
        sourcePrice:event.price,
        sourceId:event.liquidityId || null,
        occurredAt:event.occurredAt,
        confirmedAt:event.confirmedAt,
        candleIndex:event.candleIndex,
        relation:distance === 0 ? 'INSIDE_LEG' : 'BEFORE_LEG',
        barsBeforeLegStart:distance
    };
    if (event.source && event.source.eqPartnerProvenance) {
        candidate.eqPartnerProvenance = clone(event.source.eqPartnerProvenance);
    }
    return candidate;
}

function pickPrimary(displacement, events) {
    var best = null, bestDistance = Infinity, bestConfirmedAt = -Infinity;
    events.forEach(function (event) {
        var distance = displacement.startIndex - event.candleIndex;
        if (distance < bestDistance || (distance === bestDistance && event.confirmedAt > bestConfirmedAt)) {
            best = event;
            bestDistance = distance;
            bestConfirmedAt = event.confirmedAt;
        }
    });
    return best ? buildCandidate(best, displacement) : null;
}

function associateTaken(opts) {
    if (!opts || !opts.displacement || !opts.direction) return null;
    var displacement = opts.displacement;
    if (typeof displacement.startIndex !== 'number') return null;
    var availableAt = opts.availableAt;
    var displacementConfirmedAt = typeof displacement.confirmedAt === 'number'
        ? displacement.confirmedAt : displacement.endAt;
    var wantSide = opts.direction === 'BULLISH' ? 'SSL' : 'BSL';
    var candidates = (opts.takenEvents || []).filter(function (event) {
        if (!event || event.type !== 'LIQUIDITY_TAKEN' || event.side !== wantSide) return false;
        var sourceType = event.source && event.source.liquidityType;
        if (!ELIGIBLE_TYPES[sourceType]) return false;
        if (typeof event.candleIndex !== 'number' || typeof event.confirmedAt !== 'number') return false;
        if (typeof availableAt === 'number' && event.confirmedAt > availableAt) return false;
        if (typeof displacementConfirmedAt === 'number' && event.confirmedAt > displacementConfirmedAt) return false;
        var distance = displacement.startIndex - event.candleIndex;
        return distance >= 0 && distance <= WATCH_TAKEN_LOOKBACK_BARS;
    });
    if (!candidates.length) return null;
    candidates.sort(function (a, b) {
        return a.confirmedAt - b.confirmedAt || String(a.id).localeCompare(String(b.id));
    });
    return {
        allCandidates:candidates.map(function (event) { return buildCandidate(event, displacement); }),
        immediateTaken:pickPrimary(displacement, candidates)
    };
}

module.exports = {
    WATCH_TAKEN_LOOKBACK_BARS:WATCH_TAKEN_LOOKBACK_BARS,
    WATCH_TAKEN_LOOKBACK_TIME_MINUTES:120,
    ELIGIBLE_TYPES:ELIGIBLE_TYPES,
    buildCandidate:buildCandidate,
    pickPrimary:pickPrimary,
    associateTaken:associateTaken
};
