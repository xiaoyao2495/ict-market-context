/**
 * Displacement-Centric Watch V1.
 *
 * Trigger semantics are intentionally one-way:
 *   valid production Displacement -> look backward for matching production
 *   sweep provenance -> WATCH. Liquidity never opens a pending pre-displacement
 *   watch, and structure/bias never gate watch existence.
 *
 * Native FVG ownership is local to each K2 inside the immutable canonical
 * formation window. K1/K2/K3 are read directly from the closed 5m candle
 * stream. The global FVG registry is not an input to this module.
 */
'use strict';
var liquidityProvenance = require('./liquidityProvenance');
var narrativeLiquidityV1 = require('../events/sweepNarrativeEligibilityV1');

function pickNarrativePrimary(watch, candidates) {
    var startIndex = watch && watch.displacement && watch.displacement.startIndex;
    var best = null, bestDistance = Infinity, bestConfirmedAt = -Infinity;
    (candidates || []).forEach(function (candidate) {
        var distance = typeof startIndex === 'number' && typeof candidate.candleIndex === 'number'
            ? Math.abs(startIndex - candidate.candleIndex) : Infinity;
        var confirmedAt = typeof candidate.confirmedAt === 'number' ? candidate.confirmedAt : -Infinity;
        if (distance < bestDistance || (distance === bestDistance && confirmedAt > bestConfirmedAt)) {
            best = candidate; bestDistance = distance; bestConfirmedAt = confirmedAt;
        }
    });
    return best;
}

function normalizeNarrativeLiquidityV1Watch(watch) {
    if (!watch || !watch.liquidityTaken) return null;
    var candidates = (watch.liquidityTaken.allCandidates || []).filter(function (candidate) {
        return !narrativeLiquidityV1.isStructuralPrimitive(candidate && candidate.sourceType);
    });
    if (!candidates.length) return null;
    var normalized = JSON.parse(JSON.stringify(watch));
    normalized.liquidityTaken.allCandidates = candidates.map(function (candidate) { return JSON.parse(JSON.stringify(candidate)); });
    normalized.liquidityTaken.primary = JSON.parse(JSON.stringify(pickNarrativePrimary(normalized, normalized.liquidityTaken.allCandidates)));
    normalized.liquidityTaken.matched = true;
    // The additive envelope is derived from liquidityTaken. Rebuild it from the
    // normalized WATCH so it cannot retain an ineligible Swing primary.
    delete normalized.liquidityEvidenceV1;
    return normalized;
}

function nativeFvgAt(displacement, candles, k2i) {
    var k1 = candles && candles[k2i - 1];
    var k2 = candles && candles[k2i];
    var k3 = candles && candles[k2i + 1];
    if (!k1 || !k2 || !k3 || k1.closed === false || k2.closed === false || k3.closed === false) return null;
    var low = null, high = null;
    if (displacement.direction === 'BULLISH' && k3.low > k1.high) {
        low = k1.high; high = k3.low;
    } else if (displacement.direction === 'BEARISH' && k3.high < k1.low) {
        low = k3.high; high = k1.low;
    } else {
        return null;
    }
    return {
        id: 'NATIVE_FVG:' + displacement.id + ':' + k2.openTime,
        displacementEventId: displacement.id,
        direction: displacement.direction,
        low: low,
        high: high,
        midpoint: (low + high) / 2,
        k1OpenTime: k1.openTime,
        k2OpenTime: k2.openTime,
        k3OpenTime: k3.openTime,
        confirmedAt: k3.closeTime
    };
}

function nativeFvgsForDisplacement(displacement, candles, evaluationTime) {
    if (!displacement || typeof displacement.startIndex !== 'number' || typeof displacement.endIndex !== 'number') return [];
    var out = [];
    for (var i = displacement.startIndex; i <= displacement.endIndex; i++) {
        var fvg = nativeFvgAt(displacement, candles, i);
        if (fvg && (evaluationTime === undefined || fvg.confirmedAt <= evaluationTime)) out.push(fvg);
    }
    out.sort(function (a, b) { return a.confirmedAt - b.confirmedAt || a.id.localeCompare(b.id); });
    return out;
}

function nativeFvgForDisplacement(displacement, candles, evaluationTime) {
    return nativeFvgsForDisplacement(displacement, candles, evaluationTime)[0] || null;
}

function buildWatch(opts) {
    var displacement = opts && opts.displacement;
    if (!displacement || !displacement.id || displacement.type !== 'DISPLACEMENT') return null;
    var evaluationTime = opts.evaluationTime;
    var association = liquidityProvenance.associateSweeps({
        direction: displacement.direction,
        displacement: displacement,
        availableAt: evaluationTime,
        sweepEvents: opts.sweepEvents || [],
        maxLookbackBars: null,
        // Narrative Liquidity V1: 2/2 Swing remains a raw Sweep/structural
        // primitive, but cannot independently support a WATCH narrative.
        excludeStructuralPrimitives: true
    });
    if (!association || !association.allCandidates || association.allCandidates.length === 0) return null;

    var nativeFvgs = nativeFvgsForDisplacement(displacement, opts.candles || [], evaluationTime);
    var primary = nativeFvgs[0] || null;
    var existing = opts.existing || null;
    var createdAt = existing ? existing.createdAt : evaluationTime;
    var id = 'WATCH:' + (opts.symbol || 'UNKNOWN') + ':' + displacement.direction + ':DISPLACEMENT:' + displacement.id;
    return {
        id: id,
        symbol: opts.symbol || 'UNKNOWN',
        direction: displacement.direction,
        watchDirection: displacement.direction === 'BULLISH' ? 'WATCH_LONG' : 'WATCH_SHORT',
        canonicalDisplacementId: displacement.id,
        displacement: {
            id: displacement.id,
            direction: displacement.direction,
            formationType: displacement.formationType,
            startIndex: displacement.startIndex,
            endIndex: displacement.endIndex,
            startAt: displacement.startAt,
            endAt: displacement.endAt,
            confirmedAt: displacement.confirmedAt,
            quality: 'QUALIFIED',
            sourceDetections: displacement.sourceDetections
        },
        liquidityTaken: {
            matched: true,
            primary: association.immediateSweep,
            allCandidates: association.allCandidates
        },
        nativeFvg: primary,
        nativeFvgs: nativeFvgs,
        primaryFvgPolicy: 'EARLIEST_CONFIRMED_NATIVE_FVG_IN_CANONICAL_FORMATION',
        state: primary ? 'WATCH_WAIT_FVG' : 'WATCH_NO_FVG',
        noFvgReason: primary ? null : 'NO_NATIVE_FVG',
        createdAt: createdAt,
        updatedAt: evaluationTime,
        notificationKey: primary ? id + ':' + primary.id + ':FIRST_TOUCH' : null,
        firstTouchAt: existing && existing.firstTouchAt || null,
        firstTouchPrice: existing && existing.firstTouchPrice || null,
        notifiedAt: existing && existing.notifiedAt || null,
        invalidatedAt: existing && existing.invalidatedAt || null,
        invalidationReason: existing && existing.invalidationReason || null,
        dailyBias: opts.dailyBias || null,
        formationOnly: true
    };
}

function watchFingerprint(w) {
    return JSON.stringify({
        canonicalDisplacementId: w.canonicalDisplacementId,
        liquidityIds: (w.liquidityTaken.allCandidates || []).map(function (c) { return c.id; }),
        nativeFvgIds: (w.nativeFvgs || []).map(function (f) { return f.id; }),
        biasEvaluationTime: w.dailyBias && w.dailyBias.evaluationTime
    });
}

function createWatchStore(initialWatches, deliveredKeys) {
    var byId = {};
    var delivered = deliveredKeys || {};
    (initialWatches || []).forEach(function (w) {
        if (!w || !w.canonicalDisplacementId) return;
        var normalized = normalizeNarrativeLiquidityV1Watch(w);
        if (normalized && normalized.id) byId[normalized.id] = normalized;
    });

    function upsert(incoming) {
        if (!incoming || !incoming.id) return null;
        var old = byId[incoming.id];
        if (old && (old.state === 'NOTIFIED' || old.state === 'FVG_TOUCHED' || old.state === 'INVALIDATED' || old.state === 'EXPIRED')) {
            // Formation freezes at terminal transition. Later evidence must not
            // backfill liquidity/bias facts into an already touched/notified watch.
            return old;
        }
        byId[incoming.id] = incoming;
        return incoming;
    }

    function onPrice(price, at) {
        var touched = [];
        var changed = false;
        Object.keys(byId).forEach(function (id) {
            var w = byId[id];
            if (w.state !== 'WATCH_WAIT_FVG' || !w.nativeFvg || !w.notificationKey || delivered[w.notificationKey]) return;
            var f = w.nativeFvg;
            if (price >= f.low && price <= f.high) {
                w.state = 'FVG_TOUCHED';
                w.firstTouchAt = at;
                w.firstTouchPrice = price;
                touched.push(w);
                changed = true;
                return;
            }
            var penetrated = w.direction === 'BULLISH' ? price < f.low : price > f.high;
            if (penetrated) {
                w.state = 'INVALIDATED';
                w.invalidatedAt = at;
                w.invalidationReason = 'FVG_FULLY_PENETRATED_BEFORE_FIRST_TOUCH';
                changed = true;
            }
        });
        touched.changed = changed;
        return touched;
    }

    function onCandle(candle) {
        var touched = [];
        var changed = false;
        Object.keys(byId).forEach(function (id) {
            var w = byId[id];
            if (w.state !== 'WATCH_WAIT_FVG' || !w.nativeFvg || candle.closeTime <= w.updatedAt || delivered[w.notificationKey]) return;
            var f = w.nativeFvg;
            var overlap = candle.high >= f.low && candle.low <= f.high;
            if (overlap) {
                var syntheticPrice = Math.max(f.low, Math.min(f.high, candle.open));
                w.state = 'FVG_TOUCHED'; w.firstTouchAt = candle.closeTime; w.firstTouchPrice = syntheticPrice;
                touched.push(w); changed = true; return;
            }
            var penetrated = w.direction === 'BULLISH' ? candle.high < f.low : candle.low > f.high;
            if (penetrated) {
                w.state = 'INVALIDATED'; w.invalidatedAt = candle.closeTime;
                w.invalidationReason = 'FVG_FULLY_PENETRATED_BEFORE_FIRST_TOUCH';
                changed = true;
            }
        });
        touched.changed = changed;
        return touched;
    }

    function markNotified(watchId, at) {
        var w = byId[watchId];
        if (!w || !w.notificationKey) return null;
        delivered[w.notificationKey] = at;
        w.state = 'NOTIFIED'; w.notifiedAt = at;
        return w;
    }
    return {
        upsert: upsert,
        onPrice: onPrice,
        onCandle: onCandle,
        markNotified: markNotified,
        get: function (id) { return byId[id] || null; },
        getAll: function () { return Object.keys(byId).map(function (id) { return byId[id]; }); },
        getDelivered: function () { return delivered; }
    };
}

module.exports = {
    nativeFvgForDisplacement: nativeFvgForDisplacement,
    nativeFvgsForDisplacement: nativeFvgsForDisplacement,
    buildWatch: buildWatch,
    watchFingerprint: watchFingerprint,
    createWatchStore: createWatchStore,
    normalizeNarrativeLiquidityV1Watch: normalizeNarrativeLiquidityV1Watch
};
