'use strict';

/**
 * CROSS_SOURCE_PATH_INTEGRITY_V1
 *
 * Geometric path integrity between a Dynamic-D historical endpoint (the localized
 * wick of a surviving Causal Dynamic-D anchor) and the CURRENT Two-Bar endpoint.
 *
 * This is NOT an ACTIVE/INACTIVE lifecycle, NOT a "liquidity taken" detector, NOT
 * FVG semantics and NOT a sweep detector. It answers exactly one question:
 *
 *   between the Dynamic-D anchor bar and the Two-Bar K1, did the 5m path ever trade
 *   BEYOND the EQ boundary the pair is claiming?
 *
 * LONG / EQL   D = partner wick low,  T = Two-Bar low  (min of K1.low, K2.low)
 *              boundary = min(D, T); FAIL when some intermediate bar.low  < boundary
 * SHORT / EQH  D = partner wick high, T = Two-Bar high (max of K1.high, K2.high)
 *              boundary = max(D, T); FAIL when some intermediate bar.high > boundary
 *
 * Scan window (strictly):
 *   bar.openTime > anchorOccurredAt  AND  bar.openTime < twoBar.k1OpenTime
 * which excludes the anchor bar itself and both Two-Bar bars, so the Two-Bar's own
 * wick can never invalidate its own partner.
 *
 * Equality is always VALID: only a STRICT cross ( < / > ) fails.
 * Missing / gapped intermediate history is fail-closed: UNKNOWN, never PASS.
 *
 * Pure deterministic function: no LLM, no clock, no state mutation.
 */

var VERSION = 'CROSS_SOURCE_PATH_INTEGRITY_V1';
var TIMEFRAME_MS = 5 * 60 * 1000;

function finite(value) { return typeof value === 'number' && Number.isFinite(value); }

/** LONG/EQL vs SHORT/EQH from either the Two-Bar direction or the position side. */
function resolveSide(direction) {
    var value = String(direction || '').toUpperCase();
    if (value === 'BULLISH' || value === 'LONG' || value === 'LOW' || value === 'EQL') return 'LOW';
    if (value === 'BEARISH' || value === 'SHORT' || value === 'HIGH' || value === 'EQH') return 'HIGH';
    return null;
}

/**
 * The Dynamic-D anchor provenance: the openTime of the bar that owns the localized
 * wick. NEVER the process range (processStart/processEnd) and never parsed out of an id.
 */
function anchorOccurredAtOf(partner) {
    if (!partner) return null;
    var value = finite(partner.anchorOccurredAt) ? partner.anchorOccurredAt
        : (finite(partner.occurredAt) ? partner.occurredAt : null);
    return value;
}

/** T: the Two-Bar extreme in the EQ direction (canonicalExtreme semantics). */
function twoBarExtremeOf(twoBar) {
    if (!twoBar) return null;
    if (finite(twoBar.price)) return twoBar.price;
    if (finite(twoBar.canonicalExtreme)) return twoBar.canonicalExtreme;
    if (finite(twoBar.twoBarLow) && finite(twoBar.twoBarHigh)) {
        return resolveSide(twoBar.direction) === 'LOW' ? twoBar.twoBarLow : twoBar.twoBarHigh;
    }
    return null;
}

function base(direction, side) {
    return { version: VERSION, ok: false, status: 'UNKNOWN', side: side, direction: direction || null,
        partnerPrice: null, twoBarExtreme: null, boundary: null, anchorOccurredAt: null,
        k1OpenTime: null, intermediateBarCount: 0, minIntermediateLow: null,
        maxIntermediateHigh: null, violatingBar: null, reason: 'MISSING_INTERMEDIATE_BARS' };
}

/**
 * @param {{direction:string, partner:object, twoBar:object, bars:Array}} input
 *   partner: Dynamic-D survival point ({ price, occurredAt | anchorOccurredAt, ... })
 *   twoBar:  Two-Bar current point ({ direction, price, k1OpenTime, k2OpenTime, confirmedAt })
 *   bars:    closed 5m bars ({ openTime, closeTime, high, low }) - order independent
 * @returns §8 result object; status PASS/FAIL/UNKNOWN, ok === (status === 'PASS')
 */
function evaluateCrossSourcePathIntegrity(input) {
    var opts = input || {};
    var direction = (opts.twoBar && opts.twoBar.direction) || opts.direction || null;
    var side = resolveSide(direction) || resolveSide(opts.side);
    var out = base(direction, side);
    var bars = Array.isArray(opts.bars) ? opts.bars : null;
    if (!side || !bars) return out;

    var partner = opts.partner || null;
    var twoBar = opts.twoBar || null;
    var anchorOccurredAt = anchorOccurredAtOf(partner);
    var k1OpenTime = twoBar && finite(twoBar.k1OpenTime) ? twoBar.k1OpenTime : null;
    var confirmedAt = twoBar && finite(twoBar.confirmedAt) ? twoBar.confirmedAt : null;
    var partnerPrice = partner && finite(partner.price) ? partner.price : null;
    var twoBarExtreme = twoBarExtremeOf(twoBar);
    out.anchorOccurredAt = anchorOccurredAt;
    out.k1OpenTime = k1OpenTime;
    out.partnerPrice = partnerPrice;
    out.twoBarExtreme = twoBarExtreme;
    // §5/§6 fail-closed: without the real anchor provenance or the Two-Bar window we can
    // not prove the path - never PASS.
    if (anchorOccurredAt === null || k1OpenTime === null ||
            partnerPrice === null || twoBarExtreme === null) return out;
    if (!(anchorOccurredAt < k1OpenTime)) return out;

    var boundary = side === 'LOW' ? Math.min(partnerPrice, twoBarExtreme)
        : Math.max(partnerPrice, twoBarExtreme);
    out.boundary = boundary;

    // §6 continuity: the window must be a complete 5m sequence (no gap, no future bar).
    var expectedCount = Math.round((k1OpenTime - anchorOccurredAt) / TIMEFRAME_MS) - 1;
    if (expectedCount < 0) return out;
    var byOpenTime = {};
    bars.forEach(function (bar) {
        if (!bar || !finite(bar.openTime)) return;
        byOpenTime[bar.openTime] = bar;
    });
    var intermediate = [];
    for (var i = 1; i <= expectedCount; i++) {
        var openTime = anchorOccurredAt + i * TIMEFRAME_MS;
        var bar = byOpenTime[openTime];
        if (!bar) return out;                                  // MISSING_INTERMEDIATE_BARS
        if (!finite(bar.low) || !finite(bar.high)) return out;  // incomplete bar
        if (confirmedAt !== null && finite(bar.closeTime) && bar.closeTime > confirmedAt) return out;
        if (!finite(bar.closeTime) || bar.closeTime <= bar.openTime) return out;
        intermediate.push(bar);
    }
    out.intermediateBarCount = intermediate.length;
    if (intermediate.length === 0) {
        out.status = 'PASS';
        out.ok = true;
        out.reason = 'PASS';
        return out;
    }
    var minLow = Infinity, maxHigh = -Infinity, violating = null;
    intermediate.forEach(function (bar) {
        if (bar.low < minLow) minLow = bar.low;
        if (bar.high > maxHigh) maxHigh = bar.high;
        var crossed = side === 'LOW' ? bar.low < boundary : bar.high > boundary;
        if (crossed && !violating) {
            violating = { openTime: bar.openTime, closeTime: bar.closeTime, low: bar.low, high: bar.high };
        }
    });
    out.minIntermediateLow = minLow;
    out.maxIntermediateHigh = maxHigh;
    if (violating) {
        out.status = 'FAIL';
        out.ok = false;
        out.violatingBar = violating;
        out.reason = side === 'LOW' ? 'LOW_BELOW_BOUNDARY' : 'HIGH_ABOVE_BOUNDARY';
        return out;
    }
    out.status = 'PASS';
    out.ok = true;
    out.reason = 'PASS';
    return out;
}

module.exports = {
    VERSION: VERSION,
    TIMEFRAME_MS: TIMEFRAME_MS,
    evaluateCrossSourcePathIntegrity: evaluateCrossSourcePathIntegrity,
    resolveSide: resolveSide,
    anchorOccurredAtOf: anchorOccurredAtOf
};
