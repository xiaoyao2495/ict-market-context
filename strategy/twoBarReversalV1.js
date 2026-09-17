'use strict';

/**
 * TWO_BAR_REVERSAL_V1 - the new production setup source.
 *
 * Replaces the 2L/2R Current Point provider. This module is deterministic and
 * knows nothing about pivots, FVG, WATCH or the EQ-FVG semantic gate.
 *
 * It reuses:
 *   - the verified two-bar broad prefilter (research/reversalPatternSemanticAuditV1.js)
 *   - the Causal Dynamic-D historical extremes (liquidity/causalDynamicDHistoricalExtremes.js)
 *
 * Causality: a two-bar setup exists only from K2.closeTime. Nothing derived from
 * K3 or later may enter any field of this module's output.
 */

var LIB = require('../research/reversalPatternSemanticAuditV1');
var dynamicD = require('../liquidity/causalDynamicDHistoricalExtremes');

var VERSION = 'TWO_BAR_REVERSAL_V1';
var SOURCE = 'TWO_BAR_REVERSAL_V1';

function round(x, d) {
    var m = Math.pow(10, d === undefined ? 6 : d);
    return Math.round(x * m) / m;
}

/** Broad deterministic candidate scan over closed candles (both directions). */
function detectCandidates(candles) {
    var facts = candles.map(function (c) { return LIB.candleFacts(c); });
    return LIB.dedupe(LIB.twoBarCandidates(facts), candles).map(function (c) {
        return Object.assign({}, c, {
            windowBars: candles.slice(c.startIndex, c.endIndex + 1),
            windowFacts: facts.slice(c.startIndex, c.endIndex + 1)
        });
    });
}

/**
 * §8 canonical extreme with a deterministic tie rule: on an exact price tie K1 wins.
 * Bullish -> the lower side of the two bars; bearish -> the higher side.
 */
function canonicalExtreme(k1, k2, direction) {
    var bullish = direction === 'BULLISH';
    var a = bullish ? k1.low : k1.high;
    var b = bullish ? k2.low : k2.high;
    var k1Wins = bullish ? (a <= b) : (a >= b);
    var bar = k1Wins ? k1 : k2;
    return {
        price: round(bullish ? Math.min(k1.low, k2.low) : Math.max(k1.high, k2.high), 6),
        extremeBar: k1Wins ? 'K1' : 'K2',
        extremeBarOpenTime: bar.openTime,
        twoBarHigh: round(Math.max(k1.high, k2.high), 6),
        twoBarLow: round(Math.min(k1.low, k2.low), 6)
    };
}

/**
 * §9 Two-Bar Current Point. A clean object with new semantics - never a fake pivot.
 */
function buildCurrentPoint(candidate, opts) {
    var o = opts || {};
    var k1 = candidate.windowBars[0];
    var k2 = candidate.windowBars[1];
    var geo = canonicalExtreme(k1, k2, candidate.direction);
    var side = candidate.direction === 'BULLISH' ? 'LOW' : 'HIGH';
    return {
        id: [SOURCE, candidate.direction, candidate.symbol || o.symbol || 'UNKNOWN', k1.openTime, k2.closeTime].join(':'),
        source: SOURCE,
        symbol: candidate.symbol || o.symbol || null,
        timeframe: '5m',
        direction: candidate.direction,
        side: side,
        k1OpenTime: k1.openTime,
        k2OpenTime: k2.openTime,
        k2CloseTime: k2.closeTime,
        twoBarHigh: geo.twoBarHigh,
        twoBarLow: geo.twoBarLow,
        price: geo.price,
        extremeBar: geo.extremeBar,
        occurredAt: geo.extremeBarOpenTime,
        confirmedAt: k2.closeTime,
        patternConfidence: o.patternConfidence || null,
        contextConfidence: o.contextConfidence || null,
        contextDetectedDirection: o.contextDetectedDirection || null,
        contextEstimatedLegBars: o.contextEstimatedLegBars || null
    };
}

/** Pivot-shaped view used only by the Dynamic-D strict-cross helper. */
function crossView(currentPoint) {
    return { pointSide: currentPoint.side, price: currentPoint.price };
}

/**
 * §10/§11 EQ matching: same-side ACTIVE Causal Dynamic-D anchor that was already
 * causally available at the Two-Bar confirmation, inside the frozen 432-bar
 * window, not age-expired, not strict-crossed, within the frozen tolerance.
 *
 * `dynamicDState` is the production Dynamic-D state; `barsBetweenIndex` is the
 * current 5m bar index used only for the frozen lookback window.
 */
function matchDynamicDPartners(dynamicDState, currentPoint, tolerance, currentBarIndex) {
    var points = (dynamicDState && dynamicDState.recentSurvivalPoints) || [];
    var occurredBarIndex = currentPoint.extremeBar === 'K1'
        ? currentBarIndex - 1
        : currentBarIndex;
    var out = [];
    points.forEach(function (point) {
        if (!point || point.pointSide !== currentPoint.side) return;
        if (point.state !== 'ACTIVE') return;
        if (typeof point.occurredAt !== 'number' || typeof point.confirmedAt !== 'number') return;
        if (point.confirmedAt > currentPoint.confirmedAt) return;
        if (typeof point.occurredBarIndex !== 'number') return;
        var barsBetween = occurredBarIndex - point.occurredBarIndex;
        if (barsBetween < 1 || barsBetween > dynamicD.LOOKBACK_BARS) return;
        if (dynamicD.isAgeExpired(point, currentPoint.confirmedAt)) {
            dynamicD.markInactive(point, 'AGE_EXPIRY', currentPoint.confirmedAt);
            return;
        }
        if (dynamicD.strictCrosses(point, crossView(currentPoint))) {
            dynamicD.markInactive(point, 'STRICT_CROSS', currentPoint.confirmedAt);
            return;
        }
        if (Math.abs(currentPoint.price - point.price) > tolerance) return;
        out.push({
            id: point.id,
            processId: point.processId,
            side: point.pointSide,
            price: point.price,
            occurredAt: point.occurredAt,
            confirmedAt: point.confirmedAt,
            occurredBarIndex: point.occurredBarIndex,
            localizedExtremePrice: point.localizedExtremePrice,
            localizationMode: point.localizationMode,
            barsBetween: barsBetween,
            eqDistance: round(Math.abs(currentPoint.price - point.price), 6)
        });
    });
    out.sort(function (a, b) { return a.confirmedAt - b.confirmedAt || String(a.id).localeCompare(String(b.id)); });
    return out;
}

/**
 * §12/§13 EQ setup. `availableAt` is never earlier than the Two-Bar confirmation.
 */
function buildEqSetup(currentPoint, partners, tolerance) {
    if (!partners || partners.length === 0) return null;
    var type = currentPoint.direction === 'BULLISH' ? 'EQL' : 'EQH';
    var direction = currentPoint.direction === 'BULLISH' ? 'LONG' : 'SHORT';
    return {
        id: ['EQSETUP', VERSION, type, currentPoint.id].join(':'),
        source: VERSION,
        symbol: currentPoint.symbol,
        timeframe: '5m',
        type: type,
        liquidityType: type,
        direction: direction,
        twoBarId: currentPoint.id,
        twoBarDirection: currentPoint.direction,
        twoBarHigh: currentPoint.twoBarHigh,
        twoBarLow: currentPoint.twoBarLow,
        canonicalExtreme: currentPoint.price,
        side: currentPoint.side,
        k1OpenTime: currentPoint.k1OpenTime,
        k2OpenTime: currentPoint.k2OpenTime,
        occurredAt: currentPoint.occurredAt,
        confirmedAt: currentPoint.confirmedAt,
        availableAt: currentPoint.confirmedAt,
        partnerCount: partners.length,
        partners: partners,
        nearestPartnerId: partners[0].id,
        eqDistance: partners[0].eqDistance,
        eqTolerance: round(tolerance, 6),
        patternConfidence: currentPoint.patternConfidence,
        contextConfidence: currentPoint.contextConfidence
    };
}

module.exports = {
    VERSION: VERSION,
    SOURCE: SOURCE,
    detectCandidates: detectCandidates,
    canonicalExtreme: canonicalExtreme,
    buildCurrentPoint: buildCurrentPoint,
    crossView: crossView,
    matchDynamicDPartners: matchDynamicDPartners,
    buildEqSetup: buildEqSetup
};
