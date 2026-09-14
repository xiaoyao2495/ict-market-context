'use strict';

var contract = require('./eqFvgAssociationSemanticV1');
var BAR_MS = 300000;
var VERSION = 'EQ_FVG_ASSOCIATION_FACTS_V1';
var TOP_LEVEL_KEYS = ['semanticTask', 'direction', 'eq', 'fvg', 'temporalDistance', 'pricePath',
    'pivots', 'structure', 'displacement', 'interveningEq', 'levelInteraction'];

function coded(code) { var error = new Error(code); error.code = code; return error; }
function iso(value) { return value == null ? null : new Date(value).toISOString(); }
function round(value) { return value == null || !isFinite(value) ? null : Math.round(value * 1000000) / 1000000; }
function validate(facts) {
    if (!facts || typeof facts !== 'object' || Array.isArray(facts) ||
            Object.keys(facts).sort().join('|') !== TOP_LEVEL_KEYS.slice().sort().join('|')) throw coded('EQ_FVG_INPUT_SCHEMA_INVALID');
    if (facts.semanticTask !== 'EQ_FVG_ASSOCIATION_V1' || ['LONG', 'SHORT'].indexOf(facts.direction) < 0) {
        throw coded('EQ_FVG_INPUT_VALUE_INVALID');
    }
    var cutoff = Date.parse(facts.fvg.confirmedAt);
    if (!isFinite(cutoff)) throw coded('EQ_FVG_CUTOFF_INVALID');
    var times = [];
    function walk(value, key) {
        if (value && typeof value === 'object') Object.keys(value).forEach(function (child) { walk(value[child], child); });
        else if (typeof value === 'string' && /(At|Time)$/.test(key || '') && /^\d{4}-/.test(value)) {
            var parsed = Date.parse(value); if (isFinite(parsed)) times.push(parsed);
        }
    }
    walk(facts, '');
    if (times.some(function (time) { return time > cutoff; })) throw coded('EQ_FVG_FACT_AFTER_FVG_CUTOFF');
    return contract.canonicalize(facts);
}

/** Exact V3 serializer boundary. The row is deterministic evidence, never a label. */
function buildFromAuditRow(a, p) {
    var partners = p.historicalPartners || [], one = partners.length === 1 ? partners[0] : null;
    var atr = p.tolerance / 0.7;
    return validate({ semanticTask: 'EQ_FVG_ASSOCIATION_V1', direction: a.direction === 'BULLISH' ? 'LONG' : 'SHORT', eq: {
        eqConfirmedAt: a.eqConfirmedAtUtc, historicalExtremeSide: a.eqType === 'EQL' ? 'LOW' : 'HIGH',
        historicalExtremePrice: one ? one.price : null, historicalExtremeTime: one ? iso(one.occurredAt) : null,
        currentPointPrice: a.currentPivotPrice, currentPointTime: iso(a.currentPivotOccurredAt),
        currentPointConfirmedAt: a.eqConfirmedAtUtc, eqDistanceAtr: one && atr ? Math.abs(a.currentPivotPrice - one.price) / atr : null
    }, fvg: { direction: a.direction, confirmedAt: a.fvgConfirmedAtUtc, low: a.fvgLow, high: a.fvgHigh, midpoint: a.fvgMidpoint },
    temporalDistance: { barsFromEqConfirmationToFvg: a.barsToFirstMatchingFvg, minutesFromEqConfirmationToFvg: a.minutesToFirstMatchingFvg },
    pricePath: { distanceCurrentPointToFvgMidAtr: a.distanceFromCurrentPointToFvgMidAtr,
        signedMoveEqToFvgAtr: a.signedMoveFromEqToFvgAtr, signedNetMoveAtr: a.signedNetMoveAtr,
        maxFavorableExcursionBeforeFvgAtr: a.maxFavorableExcursionBeforeFvgAtr,
        maxAdverseExcursionBeforeFvgAtr: a.maxAdverseExcursionBeforeFvgAtr, pathEfficiency: a.pathEfficiency },
    pivots: { interveningPivotCount: a.interveningPivotCount, interveningHighPivotCount: a.interveningHighPivotCount,
        interveningLowPivotCount: a.interveningLowPivotCount, sameSidePivotCount: a.newSameSidePivotCount,
        oppositeSidePivotCount: a.oppositeSidePivotCount, newSameSidePivotBeforeFvg: a.newSameSidePivotBeforeFvg,
        newSameSidePivotCount: a.newSameSidePivotCount, firstNewSameSidePivotTime: iso(a.firstNewSameSidePivotTime),
        firstNewSameSidePivotPrice: a.firstNewSameSidePivotPrice },
    structure: { originalCurrentPointRoleAtEq: a.originalCurrentPointRoleAtEq,
        originalCurrentPointRoleAtFvg: a.originalCurrentPointRoleAtFvg,
        currentPointRoleChangedBeforeFvg: a.currentPointRoleChangedBeforeFvg },
    displacement: { sameDirectionDisplacementCount: a.sameDirectionDisplacementCount,
        oppositeDirectionDisplacementCount: a.oppositeDisplacementCount,
        firstSameDirectionDisplacementAt: iso(a.firstSameDirectionDisplacementAt),
        firstOppositeDirectionDisplacementAt: iso(a.firstOppositeDirectionDisplacementAt),
        fvgOnFirstSameDirectionDisplacementAfterEq: null, fvgDisplacementLegId: a.fvgDisplacementLegId,
        fvgLegDirection: a.fvgLegDirection, legDirectionSequence: a.legDirectionSequence },
    interveningEq: { newSameDirectionEqCount: a.newSameDirectionEqCount, newOppositeDirectionEqCount: a.newOppositeEqCount,
        firstNewSameDirectionEqAt: iso(a.firstNewSameDirectionEqAt), firstNewOppositeDirectionEqAt: iso(a.firstNewOppositeDirectionEqAt) },
    levelInteraction: { currentPointCrossCount: a.currentPointStrictCrossCount,
        historicalAnchorCrossCount: a.historicalAnchorStrictCrossCount } });
}

function interaction(candles, start, end, level) {
    var strict = 0;
    candles.slice(start, end + 1).forEach(function (candle) {
        if (candle.low < level && candle.high > level) strict += 1;
    });
    return strict;
}
function pathFacts(candles, start, end, direction, atr) {
    var rows = candles.slice(start, end + 1), sign = direction === 'BULLISH' ? 1 : -1;
    if (!rows.length) throw coded('EQ_FVG_PRICE_PATH_UNAVAILABLE');
    var gross = 0;
    for (var i = 1; i < rows.length; i++) gross += Math.abs(rows[i].close - rows[i - 1].close);
    var first = rows[0].close, last = rows[rows.length - 1].close;
    var high = Math.max.apply(null, rows.map(function (c) { return c.high; }));
    var low = Math.min.apply(null, rows.map(function (c) { return c.low; }));
    return { signedNetMoveAtr: atr ? round(sign * (last - first) / atr) : null,
        maxFavorableExcursionBeforeFvgAtr: atr ? round(direction === 'BULLISH' ? (high - first) / atr : (first - low) / atr) : null,
        maxAdverseExcursionBeforeFvgAtr: atr ? round(direction === 'BULLISH' ? (first - low) / atr : (high - first) / atr) : null,
        pathEfficiency: gross ? round(Math.abs(last - first) / gross) : 0 };
}
function roleAt(structural, sourceId, cutoff) {
    var record = structural && structural.swingBySourceId && structural.swingBySourceId[sourceId];
    if (!record) return 'UNAVAILABLE';
    var history = (record.history || []).filter(function (item) { return item.confirmedAt <= cutoff; });
    history.sort(function (a, b) { return a.confirmedAt - b.confirmedAt; });
    return history.length ? history[history.length - 1].role : 'UNAVAILABLE';
}

function buildProduction(input) {
    var event = input.event, state = input.state, candles = input.candles || [];
    if (!event || !event.rawFvg || !state) throw coded('EQ_FVG_FACT_SOURCE_MISSING');
    var cutoff = event.rawFvg.confirmedAt;
    var eq = (state.productionEq.events || []).filter(function (row) { return row.id === event.liquidityId; })[0];
    if (!eq || eq.confirmedAt > cutoff) throw coded('EQ_FVG_EQ_SOURCE_UNAVAILABLE');
    var indexByClose = {};
    candles.forEach(function (c, index) { if (c.closed !== false && c.closeTime <= cutoff) indexByClose[c.closeTime] = index; });
    var eqIndex = indexByClose[eq.confirmedAt], fvgIndex = indexByClose[cutoff];
    if (eqIndex == null || fvgIndex == null || fvgIndex < eqIndex) throw coded('EQ_FVG_CANDLE_PREFIX_UNAVAILABLE');
    var direction = event.rawFvg.direction;
    var current = eq.metadata && eq.metadata.currentPivot;
    var partners = eq.metadata && eq.metadata.historicalPartners || [];
    if (!current || !partners.length) throw coded('EQ_FVG_PROVENANCE_UNAVAILABLE');
    var one = partners.length === 1 ? partners[0] : null;
    var tolerance = partners[0].eqTolerance;
    var atr = tolerance && tolerance / 0.7;
    if (!(atr > 0)) throw coded('EQ_FVG_ATR_UNAVAILABLE');
    var pivots = (state.swings || []).filter(function (pivot) { return pivot.confirmedAt > eq.confirmedAt && pivot.confirmedAt <= cutoff; });
    var sameSide = pivots.filter(function (pivot) {
        return direction === 'BULLISH' ? pivot.type === 'SWING_LOW' : pivot.type === 'SWING_HIGH';
    });
    sameSide.sort(function (a, b) { return a.confirmedAt - b.confirmedAt || String(a.id).localeCompare(String(b.id)); });
    var displacements = state.displacementStore.getAsOf(cutoff, event.symbol).filter(function (row) {
        return row.confirmedAt > eq.confirmedAt && row.confirmedAt <= cutoff;
    }).sort(function (a, b) { return a.confirmedAt - b.confirmedAt || String(a.id).localeCompare(String(b.id)); });
    var sameDisp = displacements.filter(function (row) { return row.direction === direction; });
    var oppositeDisp = displacements.filter(function (row) { return row.direction !== direction; });
    var newEqs = (state.productionEq.events || []).filter(function (row) {
        return row.id !== eq.id && row.confirmedAt > eq.confirmedAt && row.confirmedAt <= cutoff;
    }).sort(function (a, b) { return a.confirmedAt - b.confirmedAt || String(a.id).localeCompare(String(b.id)); });
    var canonical = state.fvgReg.getAll(event.symbol).filter(function (row) {
        return row.direction === direction && row.confirmedAt === cutoff;
    })[0] || null;
    var associated = canonical && canonical.displacementEventId ? state.displacementStore.getProjectedById(canonical.displacementEventId, cutoff) : null;
    var midpoint = (Number(event.rawFvg.low) + Number(event.rawFvg.high)) / 2;
    var path = pathFacts(candles, Math.min(eqIndex + 1, fvgIndex), fvgIndex, direction, atr);
    var roleEq = roleAt(state.structural5m, current.id, eq.confirmedAt);
    var roleFvg = roleAt(state.structural5m, current.id, cutoff);
    var signMove = direction === 'BULLISH' ? midpoint - current.price : current.price - midpoint;
    var sameEq = newEqs.filter(function (row) { return row.type === eq.type; });
    var oppositeEq = newEqs.filter(function (row) { return row.type !== eq.type; });
    return validate({ semanticTask: 'EQ_FVG_ASSOCIATION_V1', direction: direction === 'BULLISH' ? 'LONG' : 'SHORT', eq: {
        eqConfirmedAt: iso(eq.confirmedAt), historicalExtremeSide: eq.type === 'EQL' ? 'LOW' : 'HIGH',
        historicalExtremePrice: one ? one.price : null, historicalExtremeTime: one ? iso(one.occurredAt) : null,
        currentPointPrice: current.price, currentPointTime: iso(current.occurredAt), currentPointConfirmedAt: iso(eq.confirmedAt),
        eqDistanceAtr: one ? Math.abs(current.price - one.price) / atr : null
    }, fvg: { direction: direction, confirmedAt: iso(cutoff), low: event.rawFvg.low,
        high: event.rawFvg.high, midpoint: midpoint },
    temporalDistance: { barsFromEqConfirmationToFvg: Math.round((cutoff - eq.confirmedAt) / BAR_MS),
        minutesFromEqConfirmationToFvg: Math.round((cutoff - eq.confirmedAt) / 60000) },
    pricePath: { distanceCurrentPointToFvgMidAtr: round(Math.abs(midpoint - current.price) / atr),
        signedMoveEqToFvgAtr: round(signMove / atr), signedNetMoveAtr: path.signedNetMoveAtr,
        maxFavorableExcursionBeforeFvgAtr: path.maxFavorableExcursionBeforeFvgAtr,
        maxAdverseExcursionBeforeFvgAtr: path.maxAdverseExcursionBeforeFvgAtr, pathEfficiency: path.pathEfficiency },
    pivots: { interveningPivotCount: pivots.length,
        interveningHighPivotCount: pivots.filter(function (p) { return p.type === 'SWING_HIGH'; }).length,
        interveningLowPivotCount: pivots.filter(function (p) { return p.type === 'SWING_LOW'; }).length,
        sameSidePivotCount: sameSide.length, oppositeSidePivotCount: pivots.length - sameSide.length,
        newSameSidePivotBeforeFvg: sameSide.length > 0, newSameSidePivotCount: sameSide.length,
        firstNewSameSidePivotTime: sameSide[0] ? iso(sameSide[0].sourceOpenTime) : null,
        firstNewSameSidePivotPrice: sameSide[0] ? sameSide[0].price : null },
    structure: { originalCurrentPointRoleAtEq: roleEq, originalCurrentPointRoleAtFvg: roleFvg,
        currentPointRoleChangedBeforeFvg: roleEq !== roleFvg },
    displacement: { sameDirectionDisplacementCount: sameDisp.length,
        oppositeDirectionDisplacementCount: oppositeDisp.length,
        firstSameDirectionDisplacementAt: sameDisp[0] ? iso(sameDisp[0].confirmedAt) : null,
        firstOppositeDirectionDisplacementAt: oppositeDisp[0] ? iso(oppositeDisp[0].confirmedAt) : null,
        fvgOnFirstSameDirectionDisplacementAfterEq: null,
        fvgDisplacementLegId: associated ? associated.id : null,
        fvgLegDirection: associated ? associated.direction : null,
        legDirectionSequence: displacements.map(function (row) { return row.direction; }) },
    interveningEq: { newSameDirectionEqCount: sameEq.length, newOppositeDirectionEqCount: oppositeEq.length,
        firstNewSameDirectionEqAt: sameEq[0] ? iso(sameEq[0].confirmedAt) : null,
        firstNewOppositeDirectionEqAt: oppositeEq[0] ? iso(oppositeEq[0].confirmedAt) : null },
    levelInteraction: { currentPointCrossCount: interaction(candles, Math.min(eqIndex + 1, fvgIndex), fvgIndex, current.price),
        historicalAnchorCrossCount: partners.reduce(function (sum, partner) {
            return sum + interaction(candles, Math.min(eqIndex + 1, fvgIndex), fvgIndex, partner.price);
        }, 0) } });
}

module.exports = { VERSION: VERSION, validate: validate, buildFromAuditRow: buildFromAuditRow,
    buildProduction: buildProduction, roleAt: roleAt };
