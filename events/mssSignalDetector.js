/**
 * 5m MSS Signal Coverage V1.
 *
 * MSS existence is intentionally independent from Structural Provenance:
 * a confirmed 2L/2R opposing swing plus a closed-candle close-through is
 * sufficient. Structural state is read only to enrich the emitted signal.
 */
'use strict';

function roleOf(structuralSwing) {
    if (!structuralSwing) return 'LOCAL';
    if (structuralSwing.status === 'ACTIVE_PROTECTED' || structuralSwing.role === 'ACTIVE_PROTECTED') return 'ACTIVE_PROTECTED';
    if (structuralSwing.status === 'SUPERSEDED_PROTECTED' || structuralSwing.role === 'SUPERSEDED_PROTECTED') return 'SUPERSEDED_PROTECTED';
    if (structuralSwing.role === 'CONTROLLING_SWING') return 'CONTROLLING';
    if (structuralSwing.role === 'INTERNAL') return 'INTERNAL';
    if (structuralSwing.role === 'LOCAL_SWING') return 'LOCAL';
    return 'UNKNOWN';
}

function provenanceId(structuralSwing) {
    var p = structuralSwing && structuralSwing.provenance;
    if (!p) return null;
    return [
        structuralSwing.symbol, structuralSwing.timeframe, 'STRUCTURAL_PROVENANCE',
        p.direction || 'UNKNOWN', p.parentStructuralLevelId || 'UNKNOWN',
        p.bosCandleOpenTime != null ? p.bosCandleOpenTime : 'UNKNOWN'
    ].join(':');
}

function candidates(swings, type, evaluationTime, consumed) {
    return (swings || []).filter(function (s) {
        return s.type === type && s.confirmedAt != null && s.confirmedAt <= evaluationTime && !consumed[s.id];
    }).sort(function (a, b) {
        if (b.confirmedAt !== a.confirmedAt) return b.confirmedAt - a.confirmedAt;
        return (b.sourceOpenTime || 0) - (a.sourceOpenTime || 0);
    });
}

function closeThrough(candle, direction, price) {
    return direction === 'BULLISH' ? candle.close > price : candle.close < price;
}

function activeProtectedReference(list, structuralState, side, candle, direction) {
    var active = structuralState && structuralState.activeProtected && structuralState.activeProtected[side];
    if (!active || active.status !== 'ACTIVE_PROTECTED' || active.protectedConfirmedAt > candle.closeTime) return null;
    if (!closeThrough(candle, direction, active.price)) return null;
    for (var i = 0; i < list.length; i++) {
        if (list[i].id === active.sourceSwingId) return list[i];
    }
    return null;
}

function build(candle, index, ref, direction, structuralState) {
    var structuralSwing = structuralState && structuralState.swingBySourceId
        ? structuralState.swingBySourceId[ref.id] : null;
    var referenceRole = roleOf(structuralSwing);
    var protectedBreak = referenceRole === 'ACTIVE_PROTECTED' &&
        structuralSwing.protectedConfirmedAt <= candle.closeTime &&
        closeThrough(candle, direction, structuralSwing.price);
    var range = candle.high - candle.low;
    var body = Math.abs(candle.close - candle.open);
    var breakDistance = direction === 'BULLISH' ? candle.close - ref.price : ref.price - candle.close;
    var pId = provenanceId(structuralSwing);
    var grade = protectedBreak ? 'PROTECTED'
        : (referenceRole === 'CONTROLLING' || referenceRole === 'SUPERSEDED_PROTECTED' ? 'STRUCTURAL' : 'LOCAL');
    var before = structuralState ? structuralState.structuralState : 'UNKNOWN';
    return {
        id: ref.symbol + ':' + ref.timeframe + ':MSS:' + direction + ':' + ref.id,
        symbol: ref.symbol,
        timeframe: ref.timeframe,
        type: 'MSS',
        direction: direction,
        occurredAt: candle.openTime,
        confirmedAt: candle.closeTime,
        candleIndex: index,
        price: ref.price,
        referenceLevel: ref.price,
        referenceRole: referenceRole,
        referenceStructuralRole: referenceRole,
        protectedBreak: protectedBreak,
        mssGrade: grade,
        structuralStateBefore: before,
        structuralStateAfter: protectedBreak ? direction : before,
        provenanceAvailable: !!pId,
        provenanceId: pId,
        source: {
            referenceSwingId: ref.id,
            structuralSwingId: structuralSwing ? structuralSwing.id : null,
            referencePrice: ref.price,
            referenceOccurredAt: ref.sourceOpenTime,
            referenceConfirmedAt: ref.confirmedAt,
            referenceStructuralRole: referenceRole,
            protectedBreak: protectedBreak,
            provenanceAvailable: !!pId,
            provenanceId: pId,
            breakDistance: breakDistance,
            breakPct: ref.price > 0 ? breakDistance / ref.price : 0,
            candle: { open: candle.open, high: candle.high, low: candle.low, close: candle.close }
        },
        metadata: {
            mssGrade: grade,
            referenceStructuralRole: referenceRole,
            protectedBreak: protectedBreak,
            provenanceAvailable: !!pId,
            provenanceId: pId,
            bodyRatio: range > 0 ? round4(body / range) : 0,
            closeStrength: range > 0 ? round4(direction === 'BULLISH'
                ? (candle.close - candle.low) / range
                : (candle.high - candle.close) / range) : 0
        }
    };
}

function detect(input) {
    var candle = input.candle;
    if (!candle || candle.closed === false) return [];
    var consumed = input.consumedRefs || {};
    var out = [];
    [
        { type: 'SWING_HIGH', side: 'HIGH', direction: 'BULLISH' },
        { type: 'SWING_LOW', side: 'LOW', direction: 'BEARISH' }
    ].forEach(function (spec) {
        var list = candidates(input.swings, spec.type, candle.closeTime, consumed);
        var ref = activeProtectedReference(list, input.structuralState, spec.side, candle, spec.direction);
        if (!ref) {
            ref = list.filter(function (s) { return closeThrough(candle, spec.direction, s.price); })[0] || null;
        }
        if (!ref) return;
        var event = build(candle, input.candleIndex, ref, spec.direction, input.structuralState);
        consumed[ref.id] = candle.closeTime;
        out.push(event);
    });
    return out;
}

function linkStructuralContext(signals, structuralEvents) {
    (signals || []).forEach(function (signal) {
        var match = (structuralEvents || []).filter(function (e) {
            return e.type === 'STRUCTURAL_MSS' && e.direction === signal.direction &&
                e.source && e.source.referenceSwingId === signal.source.referenceSwingId &&
                e.confirmedAt === signal.confirmedAt;
        })[0] || null;
        if (!match) return;
        signal.protectedBreak = true;
        signal.mssGrade = 'PROTECTED';
        signal.referenceRole = 'ACTIVE_PROTECTED';
        signal.referenceStructuralRole = 'ACTIVE_PROTECTED';
        signal.structuralStateAfter = match.structuralStateAfter;
        signal.provenanceAvailable = true;
        signal.provenanceId = match.id;
        signal.metadata.mssGrade = 'PROTECTED';
        signal.metadata.referenceStructuralRole = 'ACTIVE_PROTECTED';
        signal.metadata.protectedBreak = true;
        signal.metadata.provenanceAvailable = true;
        signal.metadata.provenanceId = match.id;
        signal.metadata.structuralMssEventId = match.id;
    });
    return signals;
}

function round4(n) { return Math.round(n * 10000) / 10000; }

module.exports = { detect: detect, linkStructuralContext: linkStructuralContext, roleOf: roleOf };
