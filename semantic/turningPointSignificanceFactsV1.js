'use strict';

/**
 * HISTORICAL_TURNING_POINT_SIGNIFICANCE_FACTS_V1 — canonical fact builder.
 *
 * Builds the ONLY input the semantic layer ever sees. Every value is
 * deterministic, and every value is read from the closed-5m prefix that ends at
 * candidate.confirmedAt. Nothing after confirmedAt is touched:
 *
 *   FUTURE_LEAK = false   (enforced structurally + asserted at validate time)
 *
 * Because the candidate is a FROZEN Dynamic-D object, this module never
 * re-detects, re-localizes, or re-times a turning point. It re-reads only:
 *   - the SHARED_PROCESS_WICK_V1 indices/prices already frozen on the candidate
 *   - Wilder ATR14 as of the selector bar
 *   - the production structure engine, replayed over the same prefix
 *   - the canonical displacement store, projected to confirmedAt
 *
 * NULL POLICY: an unavailable fact is null, never 0. A count that is genuinely
 * zero is 0. The two must stay distinguishable (spec §28).
 */

var atrIndicator = require('../indicators/atr');
var structuralProvenance5m = require('../structure/structuralProvenance5m');

var VERSION = 'HISTORICAL_TURNING_POINT_SIGNIFICANCE_FACTS_V1';
var SEMANTIC_TASK = 'HISTORICAL_TURNING_POINT_SIGNIFICANCE_V1';
var WILDER_ATR_PERIOD = 14;
var TOP_LEVEL_KEYS = ['semanticTask', 'turningPoint', 'incomingProcess', 'volatility',
    'reversalProcess', 'displacement', 'pivots', 'structure'];

function coded(code, message) { var error = new Error(message || code); error.code = code; return error; }
function iso(value) { return value == null ? null : new Date(value).toISOString(); }
function round(value) { return value == null || !isFinite(value) ? null : Math.round(value * 1000000) / 1000000; }
function finite(value) { return typeof value === 'number' && isFinite(value); }

/** Net move over a closed path, divided by the summed absolute close changes. */
function efficiencyOf(candles, startIndex, endIndex) {
    var rows = candles.slice(startIndex, endIndex + 1);
    if (rows.length < 2) return null;
    var gross = 0;
    for (var i = 1; i < rows.length; i++) gross += Math.abs(rows[i].close - rows[i - 1].close);
    if (!(gross > 0)) return 0;
    return Math.abs(rows[rows.length - 1].close - rows[0].close) / gross;
}

/**
 * Production Wilder ATR14 as of a bar index, replayed from the prefix only.
 * Byte-equivalent to productionEqualLiquidityV1.updateFiveMinuteAtr: index 0
 * contributes no true range, the seed is the mean of TR[1..14] published at
 * index 14, then Wilder smoothing. Returns null before the seed exists.
 */
function wilderAtr14At(candles, endIndex) {
    var seedSum = 0;
    var value = null;
    for (var i = 0; i <= endIndex; i++) {
        if (i <= 0) continue;
        var tr = atrIndicator.trueRange(candles[i], candles[i - 1]);
        if (!finite(tr)) return value;
        if (i <= WILDER_ATR_PERIOD) seedSum += tr;
        if (i === WILDER_ATR_PERIOD) value = seedSum / WILDER_ATR_PERIOD;
        else if (i > WILDER_ATR_PERIOD && value !== null) {
            value = (value * (WILDER_ATR_PERIOD - 1) + tr) / WILDER_ATR_PERIOD;
        }
    }
    return value;
}

/**
 * Replay the production 5m structure engine over the same prefix. Returns the
 * direction observed after every bar plus the final state, so an as-of read at
 * any index is available without re-running. Prefix-only by construction: the
 * loop stops at endIndex.
 */
function replayStructure(candles, swings, endIndex, symbol) {
    var state = structuralProvenance5m.createState({ symbol: symbol, timeframe: '5m' });
    var directionByIndex = [];
    var events = [];
    var cursor = 0;
    var ordered = (swings || []).slice().sort(function (a, b) {
        return a.confirmedAt - b.confirmedAt || String(a.id).localeCompare(String(b.id));
    });
    for (var i = 0; i <= endIndex; i++) {
        var candle = candles[i];
        if (!candle || candle.closed === false) {
            directionByIndex.push(null);
            continue;
        }
        var due = [];
        while (cursor < ordered.length && ordered[cursor].confirmedAt <= candle.closeTime) {
            due.push(ordered[cursor]); cursor += 1;
        }
        var step = structuralProvenance5m.step(state, candle, i, due);
        (step.events || []).forEach(function (event) { events.push(event); });
        directionByIndex.push(state.structuralState);
    }
    return { directionByIndex: directionByIndex, state: state, events: events };
}

/** Role as of a cutoff. Mirrors the frozen EQ_FVG as-of provenance projection. */
function roleAt(structural, sourceSwingId, cutoff) {
    var record = structural && structural.swingBySourceId && structural.swingBySourceId[sourceSwingId];
    if (!record) return null;
    var history = (record.history || []).filter(function (item) { return item.confirmedAt <= cutoff; });
    history.sort(function (a, b) { return a.confirmedAt - b.confirmedAt; });
    return history.length ? history[history.length - 1].role : null;
}

/**
 * Enforce FUTURE_LEAK = false over the whole fact object: every ISO timestamp
 * must be at or before candidate.confirmedAt.
 */
function assertNoFutureTimestamps(facts, cutoff) {
    if (!finite(cutoff)) throw coded('TURNING_SIGNIFICANCE_CUTOFF_INVALID');
    var violations = [];
    function walk(value, key, path) {
        if (value && typeof value === 'object') {
            Object.keys(value).forEach(function (child) { walk(value[child], child, path + '.' + child); });
            return;
        }
        if (typeof value === 'string' && /(At|Time)$/.test(key || '') && /^\d{4}-/.test(value)) {
            var parsed = Date.parse(value);
            if (isFinite(parsed) && parsed > cutoff) violations.push(path);
        }
    }
    walk(facts, '', '');
    if (violations.length) throw coded('TURNING_SIGNIFICANCE_FACT_AFTER_CONFIRMED_AT');
}

function assertShape(facts) {
    if (!facts || typeof facts !== 'object' || Array.isArray(facts) ||
            Object.keys(facts).sort().join('|') !== TOP_LEVEL_KEYS.slice().sort().join('|')) {
        throw coded('TURNING_SIGNIFICANCE_INPUT_SCHEMA_INVALID');
    }
    if (facts.semanticTask !== SEMANTIC_TASK) throw coded('TURNING_SIGNIFICANCE_INPUT_TASK_INVALID');
    if (['HIGH', 'LOW'].indexOf(facts.turningPoint.side) < 0) throw coded('TURNING_SIGNIFICANCE_SIDE_INVALID');
}

function validate(facts) {
    assertShape(facts);
    assertNoFutureTimestamps(facts, Date.parse(facts.turningPoint.confirmedAt));
    return facts;
}

/**
 * @param {Object} input
 *   candidate     frozen Dynamic-D point (identity + SAME_PROCESS_WICK_V1 fields)
 *   candles       closed 5m series; only [0..candidate.confirmationBarIndex] read
 *   swings        causal 2L/2R pivots (any superset; filtered by confirmedAt)
 *   displacements canonical displacement events already projected as of
 *                 candidate.confirmedAt (defensively re-filtered here)
 * @returns {Object} canonical facts (ready for stableSerialize)
 */
function buildCanonicalFacts(input) {
    var candidate = input && input.candidate;
    var candles = input && input.candles || [];
    if (!candidate || !candidate.processId || !candidate.pointSide) {
        throw coded('TURNING_SIGNIFICANCE_CANDIDATE_INVALID');
    }
    var side = candidate.pointSide;
    var selectorIndex = candidate.selectorOccurredBarIndex;
    var localizedIndex = candidate.occurredBarIndex;
    var confirmationIndex = candidate.confirmationBarIndex;
    var processStartIndex = candidate.processStartBarIndex;
    if (![selectorIndex, localizedIndex, confirmationIndex, processStartIndex].every(function (i) {
        return typeof i === 'number' && i >= 0;
    })) throw coded('TURNING_SIGNIFICANCE_CANDIDATE_INDEX_INVALID');
    if (confirmationIndex >= candles.length) throw coded('TURNING_SIGNIFICANCE_CANDLE_PREFIX_UNAVAILABLE');
    if (!(processStartIndex <= selectorIndex && selectorIndex < confirmationIndex)) {
        throw coded('TURNING_SIGNIFICANCE_WINDOW_INVALID');
    }
    if (!(localizedIndex >= processStartIndex && localizedIndex <= confirmationIndex)) {
        throw coded('TURNING_SIGNIFICANCE_LOCALIZED_INDEX_INVALID');
    }

    var selectorCandle = candles[selectorIndex];
    var localizedCandle = candles[localizedIndex];
    var confirmationCandle = candles[confirmationIndex];
    var processStartCandle = candles[processStartIndex];
    if (!selectorCandle || !localizedCandle || !confirmationCandle || !processStartCandle) {
        throw coded('TURNING_SIGNIFICANCE_CANDLE_MISSING');
    }
    // Integrity: the frozen candidate provenance must agree with the candles we
    // are reading. A mismatch means the prefix is not the prefix it claims.
    if (Number(selectorCandle.close) !== Number(candidate.selectorPrice) ||
            Number(localizedCandle.openTime) !== Number(candidate.localizedExtremeOpenTime) ||
            Number(confirmationCandle.closeTime) !== Number(candidate.confirmedAt)) {
        throw coded('TURNING_SIGNIFICANCE_CANDLE_ALIGNMENT_INVALID');
    }

    var confirmedAt = Number(candidate.confirmedAt);
    var selectorClose = Number(selectorCandle.close);
    var confirmationClose = Number(confirmationCandle.close);
    var processStartClose = Number(processStartCandle.close);
    var atr14AtSelector = wilderAtr14At(candles, selectorIndex);

    // ---- incoming process: processStart -> selector (spec §11-§14) ----
    var incomingDirectionalMove = side === 'HIGH'
        ? selectorClose - processStartClose
        : processStartClose - selectorClose;
    var incomingDurationBars = selectorIndex - processStartIndex + 1;
    var incomingMoveAtr = atr14AtSelector > 0 ? incomingDirectionalMove / atr14AtSelector : null;
    var incomingEfficiency = efficiencyOf(candles, processStartIndex, selectorIndex);

    // ---- volatility (spec §15). theta stays frozen at its Dynamic-D value. ----
    var volatility = {
        atr14AtSelector: round(atr14AtSelector),
        atr14PctPrice: atr14AtSelector > 0 ? round(atr14AtSelector / selectorClose) : null,
        sigma1hAtSelector: candidate.sigma1hAtExtreme == null ? null : round(candidate.sigma1hAtExtreme),
        thetaAtExtreme: candidate.thetaAtExtreme == null ? null : round(candidate.thetaAtExtreme)
    };

    // ---- reversal process: selector -> confirmedAt (spec §16-§20) ----
    var reversalCloseMove = side === 'HIGH'
        ? selectorClose - confirmationClose
        : confirmationClose - selectorClose;
    var reversalDurationBars = confirmationIndex - selectorIndex + 1;
    var reversalCloseMoveAtr = atr14AtSelector > 0 ? reversalCloseMove / atr14AtSelector : null;
    var reversalEfficiency = efficiencyOf(candles, selectorIndex, confirmationIndex);
    var excursionRows = candles.slice(localizedIndex, confirmationIndex + 1);
    var oppositeExcursion = null;
    if (excursionRows.length) {
        if (side === 'HIGH') {
            var lowest = Math.min.apply(null, excursionRows.map(function (c) { return Number(c.low); }));
            oppositeExcursion = Number(candidate.localizedExtremePrice) - lowest;
        } else {
            var highest = Math.max.apply(null, excursionRows.map(function (c) { return Number(c.high); }));
            oppositeExcursion = highest - Number(candidate.localizedExtremePrice);
        }
    }

    // ---- displacement: canonical events inside the turning window (spec §21) ----
    var incomingDirection = side === 'HIGH' ? 'BULLISH' : 'BEARISH';
    var oppositeDirection = side === 'HIGH' ? 'BEARISH' : 'BULLISH';
    var windowLowerBound = Number(selectorCandle.closeTime);
    var displacements = (input.displacements || []).filter(function (row) {
        return row && finite(row.confirmedAt) && row.confirmedAt > windowLowerBound && row.confirmedAt <= confirmedAt;
    }).sort(function (a, b) {
        return a.confirmedAt - b.confirmedAt || String(a.id).localeCompare(String(b.id));
    });
    var sameDirectionDisplacements = displacements.filter(function (row) { return row.direction === incomingDirection; });
    var oppositeDisplacements = displacements.filter(function (row) { return row.direction === oppositeDirection; });

    // ---- pivots + structure: production engines replayed over the prefix ----
    var structure = replayStructure(candles, input.swings, confirmationIndex, candidate.symbol);
    var pivots = structure.state.swings;
    var extremeOpenTime = Number(candidate.localizedExtremeOpenTime);
    var prePivots = pivots.filter(function (p) { return p.occurredAt < extremeOpenTime; });
    var turnPivots = pivots.filter(function (p) { return p.occurredAt >= extremeOpenTime; });
    var oppositeSide = side === 'HIGH' ? 'LOW' : 'HIGH';
    var exactPivot = pivots.filter(function (p) {
        return p.occurredAt === extremeOpenTime && p.side === side;
    })[0] || null;
    // Never substitute a nearby pivot for the exact localized extreme.
    var pivotRoleAtConfirmation = exactPivot ? roleAt(structure.state, exactPivot.sourceSwingId, confirmedAt) : null;
    var directionBeforeExtreme = localizedIndex > 0 ? structure.directionByIndex[localizedIndex - 1] : null;
    var structureEvents = structure.events.filter(function (event) { return finite(event.confirmedAt) && event.confirmedAt <= confirmedAt; });
    var oppositeBreaks = structureEvents.filter(function (event) {
        return event.type === 'STRUCTURAL_BOS' && event.direction === oppositeDirection;
    }).sort(function (a, b) { return a.confirmedAt - b.confirmedAt || String(a.id).localeCompare(String(b.id)); });
    var sameDirectionContinuation = structureEvents.some(function (event) {
        return event.type === 'STRUCTURAL_CONTINUATION' && event.direction === incomingDirection &&
            event.candleIndex >= selectorIndex && event.candleIndex <= confirmationIndex;
    });

    var facts = {
        semanticTask: SEMANTIC_TASK,
        turningPoint: {
            processId: candidate.processId,
            side: side,
            processStartOpenTime: iso(Number(processStartCandle.openTime)),
            selectorOccurredAt: iso(Number(selectorCandle.openTime)),
            selectorClose: round(selectorClose),
            localizedExtremeOpenTime: iso(Number(localizedCandle.openTime)),
            localizedExtremePrice: round(Number(candidate.localizedExtremePrice)),
            confirmedAt: iso(confirmedAt),
            confirmationClose: round(confirmationClose)
        },
        incomingProcess: {
            moveAtr: round(incomingMoveAtr),
            efficiency: round(incomingEfficiency),
            speedAtrPerBar: round(incomingMoveAtr == null ? null : incomingMoveAtr / incomingDurationBars),
            durationBars: incomingDurationBars
        },
        volatility: volatility,
        reversalProcess: {
            closeMoveAtr: round(reversalCloseMoveAtr),
            excursionAtr: atr14AtSelector > 0 ? round(oppositeExcursion / atr14AtSelector) : null,
            efficiency: round(reversalEfficiency),
            speedAtrPerBar: round(reversalCloseMoveAtr == null ? null : reversalCloseMoveAtr / reversalDurationBars),
            durationBars: reversalDurationBars
        },
        displacement: {
            sameDirectionCount: sameDirectionDisplacements.length,
            oppositeDirectionCount: oppositeDisplacements.length,
            firstSameDirectionAt: sameDirectionDisplacements.length ? iso(sameDirectionDisplacements[0].confirmedAt) : null,
            firstOppositeDirectionAt: oppositeDisplacements.length ? iso(oppositeDisplacements[0].confirmedAt) : null,
            // Canonical Displacement V1 carries no score. null, never 0, and no
            // threshold is invented here.
            strongestSameDirectionScore: null,
            strongestOppositeDirectionScore: null
        },
        pivots: {
            extremeIsCausalPivot: !!exactPivot,
            pivotRoleAtConfirmation: pivotRoleAtConfirmation,
            prePivotHighCount: prePivots.filter(function (p) { return p.side === 'HIGH'; }).length,
            prePivotLowCount: prePivots.filter(function (p) { return p.side === 'LOW'; }).length,
            turnPivotHighCount: turnPivots.filter(function (p) { return p.side === 'HIGH'; }).length,
            turnPivotLowCount: turnPivots.filter(function (p) { return p.side === 'LOW'; }).length,
            newOppositePivotCount: turnPivots.filter(function (p) { return p.side === oppositeSide; }).length,
            newSameDirectionPivotCount: turnPivots.filter(function (p) { return p.side === side; }).length
        },
        structure: {
            directionBeforeExtreme: directionBeforeExtreme == null ? null : directionBeforeExtreme,
            directionAtConfirmation: structure.directionByIndex[confirmationIndex] == null
                ? null : structure.directionByIndex[confirmationIndex],
            oppositeStructureBreakOccurred: oppositeBreaks.length > 0,
            oppositeStructureBreakConfirmedAt: oppositeBreaks.length ? iso(oppositeBreaks[0].confirmedAt) : null,
            // The spec explicitly forbids pre-answering "did directional delivery
            // change" here; that semantic judgement belongs to the LLM.
            sameDirectionContinuationObservedBeforeConfirmation: sameDirectionContinuation
        }
    };
    return validate(facts);
}

/**
 * Production adapter. Mirrors the frozen EQ_FVG service boundary:
 * `{ candidate, source: { state, candles } }`.
 */
function buildProduction(input) {
    var candidate = input && input.candidate;
    var source = input && input.source || {};
    var candles = source.candles || [];
    var state = source.state || {};
    if (!candidate || !state.displacementStore || !Array.isArray(state.swings)) {
        throw coded('TURNING_SIGNIFICANCE_FACT_SOURCE_MISSING');
    }
    if (candidate.confirmationBarIndex >= candles.length) {
        throw coded('TURNING_SIGNIFICANCE_CANDLE_PREFIX_UNAVAILABLE');
    }
    return buildCanonicalFacts({
        candidate: candidate,
        candles: candles,
        swings: state.swings.filter(function (s) { return s.confirmedAt <= candidate.confirmedAt; }),
        displacements: state.displacementStore.getAsOf(candidate.confirmedAt, candidate.symbol)
    });
}

module.exports = {
    VERSION: VERSION,
    SEMANTIC_TASK: SEMANTIC_TASK,
    WILDER_ATR_PERIOD: WILDER_ATR_PERIOD,
    TOP_LEVEL_KEYS: TOP_LEVEL_KEYS,
    validate: validate,
    wilderAtr14At: wilderAtr14At,
    efficiencyOf: efficiencyOf,
    replayStructure: replayStructure,
    roleAt: roleAt,
    buildCanonicalFacts: buildCanonicalFacts,
    buildProduction: buildProduction
};
