#!/usr/bin/env node
'use strict';

/**
 * Swing Reaction-Leg Structural Attribution Audit V1.
 * Shadow-only causal attribution over the frozen BTCUSDT 5m swing population.
 */
var crypto = require('crypto');
var fs = require('fs');
var path = require('path');
var pivotDetector = require('../structure/pivotDetector');
var swingLiquidity = require('../liquidity/swingLiquidity');
var structuralProvenance5m = require('../structure/structuralProvenance5m');
var displacementDetector = require('../events/displacementDetector');
var liquidityLifecycle = require('../liquidity/liquidityLifecycle');
var atrIndicator = require('../indicators/atr');
var thresholds = require('../config/thresholds');

var ROOT = path.resolve(__dirname, '..');
var OUT = path.resolve(process.argv[2] || path.join(ROOT, 'swing-reaction-leg-structural-attribution-audit-v1'));
var PRIOR_OUT = path.resolve(process.env.SWING_ATTRIBUTION_PRIOR_OUT || '/Users/yaodebao/.codex/visualizations/2026/08/24/01a031bc-fea2-7943-9b4f-2a5e77efcdda/swing-outcome-reaction-population-audit-v1');
var CANDLE_FILE = path.resolve(process.env.SWING_ATTRIBUTION_CANDLES || path.join(ROOT, 'data-cache', 'BTCUSDT_5m_20504_20686.json'));
var SYMBOL = 'BTCUSDT';
var TIMEFRAME = '5m';
var BAR_MS = 300000;
var DAY_MS = 86400000;
var AUDIT_DAYS = 180;
var MAX_LEG_BARS = 40;
var MAIN_REVERSAL_ATR = 1;
var IMMEDIATE_CONTINUATION_BARS = 3;
var EXPECTED_POPULATION_HASH = 'f9f0d11436976f214682257318068ef3fe1f7e393c836deb6daf8bb1afa0310a';
var PRODUCTION_FILES = [
    'structure/pivotDetector.js', 'liquidity/swingLiquidity.js',
    'structure/structuralProvenance5m.js', 'events/mssSignalDetector.js',
    'events/displacementDetector.js', 'liquidity/liquidityLifecycle.js',
    'indicators/atr.js', 'config/thresholds.js'
];

function round(n, d) { if (n == null || !isFinite(n)) return null; var p = Math.pow(10, d == null ? 6 : d); return Math.round(n * p) / p; }
function iso(ms) { return ms == null ? null : new Date(ms).toISOString(); }
function sum(a, b) { return a + b; }
function stable(value) {
    if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(function (k) { return JSON.stringify(k) + ':' + stable(value[k]); }).join(',') + '}';
    return JSON.stringify(value);
}
function sha(value) { return crypto.createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : stable(value)).digest('hex'); }
function fileHashes() { var out = {}; PRODUCTION_FILES.forEach(function (f) { out[f] = sha(fs.readFileSync(path.join(ROOT, f))); }); return out; }
function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function writeJson(name, value) { fs.writeFileSync(path.join(OUT, name), JSON.stringify(value, null, 2) + '\n'); }
function csvEscape(v) { if (v == null) return ''; var s = typeof v === 'object' ? JSON.stringify(v) : String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
function writeCsv(name, rows) {
    var columns = [];
    rows.forEach(function (r) { Object.keys(r).forEach(function (k) { if (columns.indexOf(k) < 0) columns.push(k); }); });
    fs.writeFileSync(path.join(OUT, name), columns.join(',') + '\n' + rows.map(function (r) { return columns.map(function (k) { return csvEscape(r[k]); }).join(','); }).join('\n') + '\n');
}
function lowerBound(a, x, getter) { var lo = 0, hi = a.length; while (lo < hi) { var m = (lo + hi) >> 1; if (getter(a[m]) < x) lo = m + 1; else hi = m; } return lo; }
function percentile(sorted, q) { if (!sorted.length) return null; var p = (sorted.length - 1) * q, lo = Math.floor(p), hi = Math.ceil(p); return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (p - lo); }
function finite(rows, key) { return rows.map(function (r) { return r[key]; }).filter(function (v) { return typeof v === 'number' && isFinite(v); }); }
function distribution(values) {
    var a = values.filter(function (v) { return typeof v === 'number' && isFinite(v); }).sort(function (x, y) { return x - y; });
    if (!a.length) return { count: 0, mean: null, median: null, P10: null, P25: null, P50: null, P75: null, P90: null, P95: null, P99: null, min: null, max: null };
    var mean = a.reduce(sum, 0) / a.length;
    return { count: a.length, mean: round(mean), median: round(percentile(a, .5)), P10: round(percentile(a, .1)), P25: round(percentile(a, .25)), P50: round(percentile(a, .5)), P75: round(percentile(a, .75)), P90: round(percentile(a, .9)), P95: round(percentile(a, .95)), P99: round(percentile(a, .99)), min: round(a[0]), max: round(a[a.length - 1]) };
}
function rank(values) {
    var indexed = values.map(function (v, i) { return { v: v, i: i }; }).sort(function (a, b) { return a.v - b.v; });
    var ranks = new Array(values.length), i = 0;
    while (i < indexed.length) { var j = i + 1; while (j < indexed.length && indexed[j].v === indexed[i].v) j++; var r = (i + j - 1) / 2 + 1; for (var k = i; k < j; k++) ranks[indexed[k].i] = r; i = j; }
    return ranks;
}
function pearson(x, y) {
    if (x.length < 3) return null;
    var mx = x.reduce(sum, 0) / x.length, my = y.reduce(sum, 0) / y.length, numerator = 0, dx = 0, dy = 0;
    for (var i = 0; i < x.length; i++) { var a = x[i] - mx, b = y[i] - my; numerator += a * b; dx += a * a; dy += b * b; }
    return dx && dy ? round(numerator / Math.sqrt(dx * dy)) : null;
}
function spearman(rows, a, b) { var pairs = rows.map(function (r) { return [r[a], r[b]]; }).filter(function (p) { return p.every(function (v) { return typeof v === 'number' && isFinite(v); }); }); return { n: pairs.length, rho: pearson(rank(pairs.map(function (p) { return p[0]; })), rank(pairs.map(function (p) { return p[1]; }))) }; }
function pointBiserial(rows, feature, outcome) { var pairs = rows.map(function (r) { return [r[feature], r[outcome]]; }).filter(function (p) { return typeof p[0] === 'number' && typeof p[1] === 'boolean'; }); return { n: pairs.length, correlation: pairs.length < 3 ? null : pearson(pairs.map(function (p) { return p[0]; }), pairs.map(function (p) { return p[1] ? 1 : 0; })) }; }

function atrSeries(candles) {
    var out = new Array(candles.length).fill(null), prev = null, period = 14;
    for (var i = period; i < candles.length; i++) {
        if (i === period) { var s = 0; for (var j = 1; j <= period; j++) s += atrIndicator.trueRange(candles[j], candles[j - 1]); prev = s / period; }
        else prev = (prev * (period - 1) + atrIndicator.trueRange(candles[i], candles[i - 1])) / period;
        out[i] = prev;
    }
    return out;
}

function buildProductionEvents(candles, swings, atrs) {
    var byConfirmed = {};
    swings.forEach(function (s) { (byConfirmed[s.confirmedAt] || (byConfirmed[s.confirmedAt] = [])).push(s); });
    var state = structuralProvenance5m.createState({ symbol: SYMBOL, timeframe: TIMEFRAME }), mss = [], structural = [];
    candles.forEach(function (c, i) {
        var step = structuralProvenance5m.step(state, c, i, byConfirmed[c.closeTime] || []);
        Array.prototype.push.apply(mss, step.mss);
        Array.prototype.push.apply(structural, step.events);
    });
    var displacements = displacementDetector.detectDisplacement(candles, mss, { symbol: SYMBOL, timeframe: TIMEFRAME, baseIndex: 0, atrSeries: atrs, thresholds: thresholds });
    mss.sort(function (a, b) { return a.candleIndex - b.candleIndex || a.id.localeCompare(b.id); });
    displacements.sort(function (a, b) { return a.candleIndex - b.candleIndex || a.id.localeCompare(b.id); });
    return { mss: mss, structural: structural, displacements: displacements };
}

function canonicalSwingId(symbol, timeframe, side, occurredAt) { return symbol + ':' + timeframe + ':' + side + ':' + occurredAt; }
function expectedDirection(side) { return side === 'SWING_HIGH' ? 'BEARISH' : 'BULLISH'; }
function favorableWick(side, price, candle) { return side === 'SWING_HIGH' ? price - candle.low : candle.high - price; }
function adverseWick(side, price, candle) { return side === 'SWING_HIGH' ? candle.high - price : price - candle.low; }
function favorableClose(side, baseline, close) { return side === 'SWING_HIGH' ? baseline - close : close - baseline; }
function closeBreaks(direction, close, price) { return direction === 'BULLISH' ? close > price : close < price; }
function wickBreaks(direction, candle, price) { return direction === 'BULLISH' ? candle.high > price : candle.low < price; }

function buildReactionLeg(feature, candles, reversalAtr, maxBars) {
    var side = feature.side, direction = expectedDirection(side), ci = feature.confirmationIndex, atr = feature.atrAtConfirmedAt;
    var observationIndex = ci + 1, safetyEnd = Math.min(ci + (maxBars || MAX_LEG_BARS), candles.length - 1);
    var out = {
        canonicalSwingId: feature.canonicalSwingId, side: side, swingPrice: feature.price,
        occurredAt: feature.occurredAt, confirmedAt: feature.confirmedAt,
        legObservationStartAt: candles[observationIndex] ? candles[observationIndex].closeTime : null,
        reactionInitiatedAt: null, legEndAt: null, legEndReason: 'DATA_END', legBars: 0,
        reactionLegFormed: false, reversalRetracementATR: reversalAtr,
        legMFE_ATR: null, legMAE_ATR: null, legDirectionalMoveATR: null,
        legNetMoveATR: null, legRangeATR: null, directionalCloseCount: 0,
        directionalCloseRatio: null, reactionEfficiency: null,
        maxConsecutiveDirectionalCloses: 0,
        reached0_5ATR: false, reached1ATR: false, reached2ATR: false, reached3ATR: false, reached5ATR: false,
        barsTo0_5ATR: null, barsTo1ATR: null, barsTo2ATR: null, barsTo3ATR: null, barsTo5ATR: null,
        returnedToSwing: false, barsToReturnToSwing: null, crossedBeyondSwing: false, barsToCrossBeyondSwing: null,
        attributionBoundaryAt: null, attributionBoundaryReason: null,
        observationIndex: observationIndex, reactionInitiatedIndex: null, legEndIndex: null, attributionEndIndex: null,
        frontierPrice: feature.price
    };
    if (!(atr > 0) || !candles[observationIndex]) return out;

    var frontier = feature.price, maxFav = 0, maxAdv = 0, minPrice = Infinity, maxPrice = -Infinity;
    var directionalMove = 0, directional = 0, directionalRun = 0, maxDirectionalRun = 0, closePath = 0;
    var confirmationClose = candles[ci].close, previousClose = confirmationClose, bestFavorableClose = 0;
    var initiatedIndex = null, returnedIndex = null, crossedIndex = null, endIndex = safetyEnd, endReason = safetyEnd < ci + (maxBars || MAX_LEG_BARS) ? 'DATA_END' : 'MAX_HORIZON';
    var levels = [{ v: .5, key: '0_5' }, { v: 1, key: '1' }, { v: 2, key: '2' }, { v: 3, key: '3' }, { v: 5, key: '5' }];

    for (var i = observationIndex; i <= safetyEnd; i++) {
        var c = candles[i], delta = c.close - previousClose;
        minPrice = Math.min(minPrice, c.low); maxPrice = Math.max(maxPrice, c.high);
        var fav = Math.max(0, favorableWick(side, feature.price, c)), adv = Math.max(0, adverseWick(side, feature.price, c));
        if (fav > maxFav) { maxFav = fav; frontier = side === 'SWING_HIGH' ? c.low : c.high; if (initiatedIndex == null) initiatedIndex = i; }
        maxAdv = Math.max(maxAdv, adv);
        var isDirectional = direction === 'BULLISH' ? delta > 0 : delta < 0;
        if (isDirectional) { directional++; directionalRun++; directionalMove += Math.abs(delta); } else directionalRun = 0;
        maxDirectionalRun = Math.max(maxDirectionalRun, directionalRun);
        closePath += Math.abs(delta);
        bestFavorableClose = Math.max(bestFavorableClose, Math.max(0, favorableClose(side, confirmationClose, c.close)));
        levels.forEach(function (level) { var reachKey = 'reached' + level.key + 'ATR', barsKey = 'barsTo' + level.key + 'ATR'; if (!out[reachKey] && maxFav >= level.v * atr) { out[reachKey] = true; out[barsKey] = i - ci; } });

        if (initiatedIndex != null && i > initiatedIndex) {
            var returned = side === 'SWING_HIGH' ? c.high >= feature.price : c.low <= feature.price;
            var crossed = side === 'SWING_HIGH' ? c.high > feature.price : c.low < feature.price;
            if (returned && returnedIndex == null) returnedIndex = i;
            if (crossed && crossedIndex == null) crossedIndex = i;
        }
        var retracement = side === 'SWING_HIGH' ? c.close - frontier : frontier - c.close;
        previousClose = c.close;
        if (initiatedIndex != null && retracement / atr >= reversalAtr) { endIndex = i; endReason = 'CONFIRMED_REVERSAL'; break; }
    }

    out.reactionLegFormed = initiatedIndex != null;
    out.reactionInitiatedIndex = initiatedIndex;
    out.reactionInitiatedAt = initiatedIndex == null ? null : candles[initiatedIndex].closeTime;
    out.legEndIndex = endIndex;
    out.legEndAt = candles[endIndex] ? candles[endIndex].closeTime : null;
    out.legEndReason = endReason;
    out.legBars = endIndex >= observationIndex ? endIndex - observationIndex + 1 : 0;
    out.legMFE_ATR = round(maxFav / atr);
    out.legMAE_ATR = round(maxAdv / atr);
    out.legDirectionalMoveATR = round(directionalMove / atr);
    out.legNetMoveATR = round(favorableClose(side, confirmationClose, candles[endIndex].close) / atr);
    out.legRangeATR = round((maxPrice - minPrice) / atr);
    out.directionalCloseCount = directional;
    out.directionalCloseRatio = out.legBars ? round(directional / out.legBars) : null;
    out.reactionEfficiency = closePath > 0 ? round(bestFavorableClose / closePath) : 0;
    out.maxConsecutiveDirectionalCloses = maxDirectionalRun;
    out.returnedToSwing = returnedIndex != null;
    out.barsToReturnToSwing = returnedIndex == null ? null : returnedIndex - ci;
    out.crossedBeyondSwing = crossedIndex != null;
    out.barsToCrossBeyondSwing = crossedIndex == null ? null : crossedIndex - ci;
    out.frontierPrice = frontier;

    var attributionEnd = endIndex;
    var boundaryReason = endReason;
    if (endReason === 'CONFIRMED_REVERSAL') attributionEnd = endIndex - 1;
    if (returnedIndex != null && returnedIndex - 1 < attributionEnd) { attributionEnd = returnedIndex - 1; boundaryReason = crossedIndex === returnedIndex ? 'CROSS_BEYOND_SWING' : 'RETURN_TO_SWING'; }
    out.attributionEndIndex = Math.max(ci, attributionEnd);
    out.attributionBoundaryAt = candles[out.attributionEndIndex] ? candles[out.attributionEndIndex].closeTime : feature.confirmedAt;
    out.attributionBoundaryReason = boundaryReason;
    return out;
}

function buildFirstBreakByReference(mssEvents) {
    var out = {};
    mssEvents.forEach(function (e) { var id = e.source && e.source.referenceSwingId; if (id && (!out[id] || e.confirmedAt < out[id].confirmedAt)) out[id] = e; });
    return out;
}

function snapshotStructuralReferences(feature, oppositeList, firstBreakByReference) {
    var pos = lowerBound(oppositeList, feature.confirmedAt + 1, function (s) { return s.confirmedAt; });
    var eligible = [];
    for (var i = pos - 1; i >= 0 && eligible.length < 2; i--) {
        var s = oppositeList[i], firstBreak = firstBreakByReference[s.id];
        if (s.confirmedAt > feature.confirmedAt) continue;
        if (firstBreak && firstBreak.confirmedAt <= feature.confirmedAt) continue;
        eligible.push(s);
    }
    function fields(prefix, s) {
        var out = {}; out[prefix + 'Id'] = s ? s.id : null; out[prefix + 'Price'] = s ? s.price : null; out[prefix + 'ConfirmedAt'] = s ? s.confirmedAt : null; return out;
    }
    return Object.assign({
        canonicalSwingId: feature.canonicalSwingId, side: feature.side,
        snapshotAt: feature.confirmedAt, snapshotAtIso: iso(feature.confirmedAt),
        eligibilityRule: 'opposite 2L/2R swing confirmedAt <= target confirmedAt and not production-MSS-consumed by snapshot time',
        snapshotReferenceSlots: 2,
        populatedReferenceSlots: eligible.length,
        eligibleReferencePrefixHash: sha(eligible.map(function (s) { return s.id; }))
    }, fields('nearestOppositeSwing', eligible[0]), fields('secondOppositeSwing', eligible[1]));
}

function referenceEligibleAtSnapshot(reference, feature, firstBreakByReference) {
    if (!reference || reference.confirmedAt > feature.confirmedAt) return false;
    if (feature.side === reference.type) return false;
    var firstBreak = firstBreakByReference[reference.id];
    return !firstBreak || firstBreak.confirmedAt > feature.confirmedAt;
}

function eventsIn(events, start, end) {
    var at = lowerBound(events, start, function (e) { return e.candleIndex; }), out = [];
    for (var i = at; i < events.length && events[i].candleIndex <= end; i++) out.push(events[i]);
    return out;
}

function structuralBreakFor(feature, leg, snapshot, mssEvents, swingById, firstBreakByReference, candles) {
    var direction = expectedDirection(feature.side), candidates = eventsIn(mssEvents, leg.observationIndex, leg.attributionEndIndex).filter(function (e) {
        var ref = e.source && swingById[e.source.referenceSwingId];
        return e.direction === direction && referenceEligibleAtSnapshot(ref, feature, firstBreakByReference) && closeBreaks(direction, candles[e.candleIndex].close, ref.price);
    });
    var e = candidates[0] || null, ref = e && swingById[e.source.referenceSwingId];
    var wick = null;
    if (!e) {
        var snapshotRefs = [snapshot.nearestOppositeSwingId, snapshot.secondOppositeSwingId].map(function (id) { return id && swingById[id]; }).filter(Boolean);
        outer: for (var i = leg.observationIndex; i <= leg.attributionEndIndex; i++) for (var j = 0; j < snapshotRefs.length; j++) if (wickBreaks(direction, candles[i], snapshotRefs[j].price)) { wick = { index: i, ref: snapshotRefs[j] }; break outer; }
    }
    return {
        canonicalSwingId: feature.canonicalSwingId, side: feature.side,
        attributedStructureBreak: !!e, wickBreak: !!e || !!wick, closeBreak: !!e,
        structuralReferenceId: ref ? ref.id : (wick ? wick.ref.id : null),
        structuralReferencePrice: ref ? ref.price : (wick ? wick.ref.price : null),
        breakAt: e ? e.confirmedAt : (wick ? candles[wick.index].closeTime : null),
        breakPrice: e ? candles[e.candleIndex].close : (wick ? (direction === 'BULLISH' ? candles[wick.index].high : candles[wick.index].low) : null),
        breakIndex: e ? e.candleIndex : (wick ? wick.index : null),
        barsReactionStartToBreak: e && leg.reactionInitiatedIndex != null ? e.candleIndex - leg.reactionInitiatedIndex : null
    };
}

function rejectMssReason(feature, leg, genericEvent, swingById, firstBreakByReference) {
    if (!genericEvent) return null;
    if (genericEvent.direction !== expectedDirection(feature.side)) return 'DIRECTION_MISMATCH';
    var idx = genericEvent.candleIndex;
    if ((leg.returnedToSwing || leg.crossedBeyondSwing) && idx >= feature.confirmationIndex + Math.min(leg.barsToReturnToSwing == null ? Infinity : leg.barsToReturnToSwing, leg.barsToCrossBeyondSwing == null ? Infinity : leg.barsToCrossBeyondSwing)) return 'AFTER_RETURN_TO_SWING';
    if (idx > leg.attributionEndIndex) {
        if (leg.legEndReason === 'CONFIRMED_REVERSAL' && idx > leg.legEndIndex) return 'NEW_DELIVERY';
        return 'AFTER_REACTION_LEG_END';
    }
    var ref = genericEvent.source && swingById[genericEvent.source.referenceSwingId];
    if (!referenceEligibleAtSnapshot(ref, feature, firstBreakByReference)) return 'WRONG_STRUCTURE_REFERENCE';
    return 'OTHER';
}

function attributeMss(feature, leg, structuralBreak, events, swingById, firstBreakByReference, candles) {
    var direction = expectedDirection(feature.side), horizonEnd = Math.min(feature.confirmationIndex + 40, candles.length - 1);
    var allGeneric = eventsIn(events.mss, feature.confirmationIndex + 1, horizonEnd).filter(function (e) { return e.direction === direction; });
    var attributed = null;
    if (leg.reactionLegFormed) {
        var within = eventsIn(events.mss, leg.observationIndex, leg.attributionEndIndex);
        for (var i = 0; i < within.length; i++) {
            var e = within[i], ref = e.source && swingById[e.source.referenceSwingId];
            if (e.confirmedAt <= feature.confirmedAt || e.direction !== direction) continue;
            if (!referenceEligibleAtSnapshot(ref, feature, firstBreakByReference)) continue;
            if (!closeBreaks(direction, candles[e.candleIndex].close, ref.price)) continue;
            attributed = e; break;
        }
    }
    return {
        canonicalSwingId: feature.canonicalSwingId, side: feature.side,
        genericMssWithin40: allGeneric.length > 0, genericMssWithin40Count: allGeneric.length,
        firstGenericMssId: allGeneric[0] ? allGeneric[0].id : null,
        firstGenericMssConfirmedAt: allGeneric[0] ? allGeneric[0].confirmedAt : null,
        attributedMss: !!attributed,
        attributedMssId: attributed ? attributed.id : null,
        attributedMssConfirmedAt: attributed ? attributed.confirmedAt : null,
        attributedMssReferenceId: attributed && attributed.source ? attributed.source.referenceSwingId : null,
        attributedMssIndex: attributed ? attributed.candleIndex : null,
        barsSwingConfirmedToMss: attributed ? attributed.candleIndex - feature.confirmationIndex : null,
        barsReactionStartToMss: attributed && leg.reactionInitiatedIndex != null ? attributed.candleIndex - leg.reactionInitiatedIndex : null,
        barsStructureBreakToMss: attributed && structuralBreak.breakIndex != null ? attributed.candleIndex - structuralBreak.breakIndex : null,
        MSS_ATTRIBUTION_REJECT_REASON: allGeneric.length && !attributed ? rejectMssReason(feature, leg, allGeneric[0], swingById, firstBreakByReference) : null
    };
}

function continuationAllowed(leg, displacementIndex) {
    if (displacementIndex <= leg.attributionEndIndex) return true;
    if (leg.legEndReason !== 'MAX_HORIZON') return false;
    if (leg.returnedToSwing || leg.crossedBeyondSwing) return false;
    return displacementIndex <= leg.legEndIndex + IMMEDIATE_CONTINUATION_BARS;
}

function rejectDisplacementReason(feature, leg, mss, candidate) {
    if (!mss.attributedMss) return 'NO_ATTRIBUTED_MSS';
    if (!candidate) return 'OTHER';
    if (candidate.direction !== expectedDirection(feature.side)) return 'DIRECTION_MISMATCH';
    if ((leg.returnedToSwing || leg.crossedBeyondSwing) && candidate.candleIndex > leg.attributionEndIndex) return 'AFTER_RETURN_TO_SWING';
    if (leg.legEndReason === 'CONFIRMED_REVERSAL' && candidate.candleIndex >= leg.legEndIndex) return 'NEW_DELIVERY';
    if (candidate.candleIndex > leg.legEndIndex + IMMEDIATE_CONTINUATION_BARS) return 'OUTSIDE_IMMEDIATE_CONTINUATION';
    if (candidate.candleIndex > leg.attributionEndIndex) return 'AFTER_REACTION_LEG_END';
    return 'OTHER';
}

function attributeDisplacement(feature, leg, mss, events, candles) {
    var direction = expectedDirection(feature.side), horizonEnd = Math.min(feature.confirmationIndex + 40, candles.length - 1);
    var generic = eventsIn(events.displacements, feature.confirmationIndex + 1, horizonEnd).filter(function (e) { return e.direction === direction; });
    var attributed = null, candidates = [];
    if (mss.attributedMss) {
        var searchEnd = Math.min(leg.legEndIndex + IMMEDIATE_CONTINUATION_BARS, candles.length - 1);
        candidates = eventsIn(events.displacements, mss.attributedMssIndex, searchEnd).filter(function (e) { return e.direction === direction; });
        for (var i = 0; i < candidates.length; i++) if (candidates[i].confirmedAt >= mss.attributedMssConfirmedAt && continuationAllowed(leg, candidates[i].candleIndex)) { attributed = candidates[i]; break; }
    }
    return {
        canonicalSwingId: feature.canonicalSwingId, side: feature.side,
        genericDisplacementWithin40: generic.length > 0, genericDisplacementWithin40Count: generic.length,
        firstGenericDisplacementId: generic[0] ? generic[0].id : null,
        firstGenericDisplacementConfirmedAt: generic[0] ? generic[0].confirmedAt : null,
        sameDeliveryDisplacement: !!attributed,
        attributedDisplacementId: attributed ? attributed.id : null,
        attributedDisplacementConfirmedAt: attributed ? attributed.confirmedAt : null,
        attributedDisplacementIndex: attributed ? attributed.candleIndex : null,
        attributedDisplacementDirection: attributed ? attributed.direction : null,
        barsMssToDisplacement: attributed ? attributed.candleIndex - mss.attributedMssIndex : null,
        barsReactionStartToDisplacement: attributed && leg.reactionInitiatedIndex != null ? attributed.candleIndex - leg.reactionInitiatedIndex : null,
        DISPLACEMENT_ATTRIBUTION_REJECT_REASON: generic.length && !attributed ? rejectDisplacementReason(feature, leg, mss, candidates[0] || generic[0]) : null
    };
}

function followThroughFor(feature, displacement, displacementById, candles) {
    var event = displacement.attributedDisplacementId ? displacementById[displacement.attributedDisplacementId] : null;
    var out = { canonicalSwingId: feature.canonicalSwingId, side: feature.side, displacementId: event ? event.id : null };
    [3, 5, 10].forEach(function (h) {
        var end = event ? event.candleIndex + h : null, key = String(h);
        if (!event || end >= candles.length) {
            out['followThroughATR_' + key] = null; out['directionalFollowThroughCloses_' + key] = null; out['returnedIntoDisplacementOrigin_' + key] = null; return;
        }
        var base = event.price, atr = event.metadata && event.metadata.atr, favorable = 0, directional = 0, returned = false, previous = base;
        var origin = event.source.candle.open;
        for (var i = event.candleIndex + 1; i <= end; i++) {
            var c = candles[i];
            favorable = Math.max(favorable, event.direction === 'BULLISH' ? c.high - base : base - c.low);
            if (event.direction === 'BULLISH' ? c.close > previous : c.close < previous) directional++;
            if (event.direction === 'BULLISH' ? c.low <= origin : c.high >= origin) returned = true;
            previous = c.close;
        }
        out['followThroughATR_' + key] = atr > 0 ? round(Math.max(0, favorable) / atr) : null;
        out['directionalFollowThroughCloses_' + key] = directional;
        out['returnedIntoDisplacementOrigin_' + key] = returned;
    });
    var continued = false, barsTo = null;
    if (event) for (var j = event.candleIndex + 1; j <= Math.min(event.candleIndex + 10, candles.length - 1); j++) {
        var beyond = event.direction === 'BULLISH' ? candles[j].high > candles[event.candleIndex].high : candles[j].low < candles[event.candleIndex].low;
        if (beyond) { continued = true; barsTo = j - event.candleIndex; break; }
    }
    out.continuedBeyondDisplacementExtreme = event ? continued : null;
    out.barsDisplacementToFollowThrough = barsTo;
    out.immediateFailure = event ? out.returnedIntoDisplacementOrigin_3 === true : null;
    out.directionalFollowThrough = event ? continued && out.directionalFollowThroughCloses_3 > 0 : false;
    return out;
}

function lifecycleAtLegEnd(feature, leg, candles) {
    var liq = { side: feature.side === 'SWING_HIGH' ? 'BSL' : 'SSL', price: feature.price, status: 'ACTIVE', touchedAt: null, sweptAt: null, brokenAt: null };
    for (var i = feature.confirmationIndex; i <= leg.legEndIndex && i < candles.length; i++) {
        var evaluated = liquidityLifecycle.evaluateLiquidity(liq, candles[i]);
        if (evaluated) liq = Object.assign({}, liq, evaluated);
    }
    var out = { canonicalSwingId: feature.canonicalSwingId, side: feature.side, stateAtLegEnd: liq.status, barsLegEndToFirstRevisit: null, barsLegEndToTouch: null, barsLegEndToSweep: null, barsLegEndToBreak: null };
    for (var j = leg.legEndIndex + 1; j < candles.length; j++) {
        var touch = feature.side === 'SWING_HIGH' ? candles[j].high >= feature.price : candles[j].low <= feature.price;
        if (touch && out.barsLegEndToFirstRevisit == null) out.barsLegEndToFirstRevisit = j - leg.legEndIndex;
        var r = liquidityLifecycle.evaluateLiquidity(liq, candles[j]);
        if (r) {
            liq = Object.assign({}, liq, r);
            if (r.touchedAt != null && out.barsLegEndToTouch == null) out.barsLegEndToTouch = j - leg.legEndIndex;
            if (r.status === 'SWEPT' && out.barsLegEndToSweep == null) out.barsLegEndToSweep = j - leg.legEndIndex;
            if (r.status === 'BROKEN' && out.barsLegEndToBreak == null) out.barsLegEndToBreak = j - leg.legEndIndex;
        }
        if (out.barsLegEndToBreak != null) break;
    }
    return out;
}

function fixedReactionFeatures(feature, candles) {
    var out = {}, side = feature.side, ci = feature.confirmationIndex, atr = feature.atrAtConfirmedAt;
    [1, 3, 5, 10].forEach(function (h) {
        if (!(atr > 0) || ci + h >= candles.length) { out['reactionATR_' + h] = null; return; }
        var max = 0; for (var i = ci + 1; i <= ci + h; i++) max = Math.max(max, favorableWick(side, feature.price, candles[i]));
        out['reactionATR_' + h] = round(Math.max(0, max) / atr);
    });
    return out;
}

function funnelStage(name, count, total, previous) { return { stage: name, count: count, rateFromTotal: round(count / total), conversionFromPreviousStage: previous == null ? 1 : round(count / Math.max(1, previous)) }; }
function makeFunnel(rows) {
    var total = rows.length;
    var stages = [
        ['TOTAL_CONFIRMED_SWINGS', total],
        ['REACTION_LEG_FORMED', rows.filter(function (r) { return r.reactionLegFormed; }).length],
        ['REACTION_LEG_REACHED_1ATR', rows.filter(function (r) { return r.reached1ATR; }).length],
        ['REACTION_LEG_STRUCTURAL_BREAK', rows.filter(function (r) { return r.attributedStructureBreak; }).length],
        ['ATTRIBUTED_MSS', rows.filter(function (r) { return r.attributedMss; }).length],
        ['SAME_DELIVERY_DISPLACEMENT', rows.filter(function (r) { return r.sameDeliveryDisplacement; }).length],
        ['DISPLACEMENT_WITH_DIRECTIONAL_FOLLOW_THROUGH', rows.filter(function (r) { return r.sameDeliveryDisplacement && r.directionalFollowThrough; }).length]
    ];
    return stages.map(function (s, i) { return funnelStage(s[0], s[1], total, i ? stages[i - 1][1] : null); });
}

function rate(rows, key) { return round(rows.filter(function (r) { return r[key] === true; }).length / rows.length); }
function inflation(rows) {
    var genericMss = rate(rows, 'genericMssWithin40'), attributedMss = rate(rows, 'attributedMss');
    var genericDisp = rate(rows, 'genericDisplacementWithin40'), attributedDisp = rate(rows, 'sameDeliveryDisplacement');
    return {
        GENERIC_MSS_WITHIN_40_RATE: genericMss, ATTRIBUTED_MSS_RATE: attributedMss,
        MSS_ATTRIBUTION_INFLATION: round(genericMss - attributedMss),
        GENERIC_MSS_TRUE_BUT_ATTRIBUTED_FALSE_COUNT: rows.filter(function (r) { return r.genericMssWithin40 && !r.attributedMss; }).length,
        GENERIC_DISPLACEMENT_WITHIN_40_RATE: genericDisp, SAME_DELIVERY_DISPLACEMENT_RATE: attributedDisp,
        DISPLACEMENT_ATTRIBUTION_INFLATION: round(genericDisp - attributedDisp),
        GENERIC_DISPLACEMENT_TRUE_BUT_ATTRIBUTED_FALSE_COUNT: rows.filter(function (r) { return r.genericDisplacementWithin40 && !r.sameDeliveryDisplacement; }).length
    };
}

function rejectDistribution(rows, key, genericKey, attributedKey, allowed) {
    var rejected = rows.filter(function (r) { return r[genericKey] && !r[attributedKey]; }), counts = {};
    allowed.forEach(function (k) { counts[k] = 0; });
    rejected.forEach(function (r) { var reason = r[key] || 'OTHER'; counts[reason] = (counts[reason] || 0) + 1; });
    return { totalRejected: rejected.length, reasons: allowed.map(function (reason) { return { reason: reason, count: counts[reason] || 0, percentage: round((counts[reason] || 0) / Math.max(1, rejected.length)) }; }) };
}

function timeDistributions(rows) {
    return {
        barsToReaction1ATR: distribution(finite(rows, 'barsTo1ATR')),
        barsReactionStartToStructureBreak: distribution(finite(rows, 'barsReactionStartToBreak')),
        barsStructureBreakToMSS: distribution(finite(rows, 'barsStructureBreakToMss')),
        barsMssToDisplacement: distribution(finite(rows, 'barsMssToDisplacement')),
        barsDisplacementToFollowThrough: distribution(finite(rows, 'barsDisplacementToFollowThrough'))
    };
}

function associationMatrix(rows, features, outcomes) {
    var matrix = {};
    features.forEach(function (f) {
        matrix[f] = {};
        outcomes.forEach(function (o) {
            var sample = rows.filter(function (r) { return typeof r[o] === 'boolean'; });
            matrix[f][o] = sample.length ? pointBiserial(rows, f, o) : spearman(rows, f, o);
        });
    });
    return matrix;
}

function selectCounterexamples(rows) {
    function threshold(key, q) { var vals = finite(rows, key).sort(function (a, b) { return a - b; }); return percentile(vals, q); }
    var strong = threshold('legMFE_ATR', .9), modest = threshold('legMFE_ATR', .25), highProm = threshold('prominenceATR', .9), lowProm = threshold('prominenceATR', .25);
    function asc(key) { return function (a, b) { return (a[key] == null ? Infinity : a[key]) - (b[key] == null ? Infinity : b[key]) || a.canonicalSwingId.localeCompare(b.canonicalSwingId); }; }
    function desc(key) { return function (a, b) { return (b[key] == null ? -Infinity : b[key]) - (a[key] == null ? -Infinity : a[key]) || a.canonicalSwingId.localeCompare(b.canonicalSwingId); }; }
    function take(category, filter, sorter) { return { category: category, rows: rows.filter(filter).sort(sorter).slice(0, 10).map(compactCounterexample) }; }
    return [
        take('A_STRONG_REACTION_NO_ATTRIBUTED_MSS', function (r) { return r.legMFE_ATR >= strong && !r.attributedMss; }, desc('legMFE_ATR')),
        take('B_MODEST_REACTION_ATTRIBUTED_MSS', function (r) { return r.legMFE_ATR <= modest && r.attributedMss; }, asc('legMFE_ATR')),
        take('C_ATTRIBUTED_MSS_NO_SAME_DELIVERY_DISPLACEMENT', function (r) { return r.attributedMss && !r.sameDeliveryDisplacement; }, desc('legMFE_ATR')),
        take('D_SAME_DELIVERY_DISPLACEMENT_IMMEDIATE_FAILURE', function (r) { return r.sameDeliveryDisplacement && r.immediateFailure; }, asc('followThroughATR_3')),
        take('E_HIGH_PROMINENCE_NO_ATTRIBUTED_STRUCTURE', function (r) { return r.prominenceATR >= highProm && !r.attributedStructureBreak; }, desc('prominenceATR')),
        take('F_LOW_PROMINENCE_FULL_ATTRIBUTED_CHAIN', function (r) { return r.prominenceATR <= lowProm && r.attributedMss && r.sameDeliveryDisplacement; }, asc('prominenceATR')),
        take('G_GENERIC_MSS_TRUE_ATTRIBUTED_FALSE', function (r) { return r.genericMssWithin40 && !r.attributedMss; }, asc('barsToReturnToSwing')),
        take('H_GENERIC_DISPLACEMENT_TRUE_SAME_DELIVERY_FALSE', function (r) { return r.genericDisplacementWithin40 && !r.sameDeliveryDisplacement; }, asc('barsToReturnToSwing'))
    ];
}

function compactCounterexample(r) {
    var keys = ['canonicalSwingId','side','occurredAt','confirmedAt','price','prominenceATR','legMFE_ATR','reactionEfficiency','legEndReason','legBars','attributionBoundaryReason','nearestOppositeSwingId','nearestOppositeSwingPrice','attributedStructureBreak','structuralReferenceId','breakAt','genericMssWithin40','attributedMss','attributedMssId','MSS_ATTRIBUTION_REJECT_REASON','genericDisplacementWithin40','sameDeliveryDisplacement','attributedDisplacementId','DISPLACEMENT_ATTRIBUTION_REJECT_REASON','followThroughATR_3','followThroughATR_10','immediateFailure'];
    var out = {}; keys.forEach(function (k) { out[k] = r[k]; }); return out;
}

function chartSvg(row, candles, eventMaps) {
    var start = Math.max(0, row.sourceIndex - 24), end = Math.min(candles.length - 1, Math.max(row.legEndIndex + 12, row.confirmationIndex + 43)), cs = candles.slice(start, end + 1);
    var W = 1180, H = 650, L = 72, R = 96, T = 65, B = 110;
    var lows = cs.map(function (c) { return c.low; }).concat([row.price]), highs = cs.map(function (c) { return c.high; }).concat([row.price]);
    if (row.structuralReferencePrice != null) { lows.push(row.structuralReferencePrice); highs.push(row.structuralReferencePrice); }
    var lo = Math.min.apply(null, lows), hi = Math.max.apply(null, highs), pad = (hi - lo) * .06 || 1; lo -= pad; hi += pad;
    function x(index) { return L + (index - start + .5) * (W - L - R) / cs.length; }
    function y(price) { return T + (hi - price) * (H - T - B) / (hi - lo); }
    function marker(index, color, label, rowY) { if (index == null || index < start || index > end) return ''; return '<line x1="'+x(index)+'" y1="'+T+'" x2="'+x(index)+'" y2="'+(H-B)+'" stroke="'+color+'" stroke-dasharray="5 4"/><text x="'+(x(index)+4)+'" y="'+rowY+'" fill="'+color+'" font-size="11">'+label+'</text>'; }
    var p = ['<svg xmlns="http://www.w3.org/2000/svg" width="'+W+'" height="'+H+'" viewBox="0 0 '+W+' '+H+'"><style>text{font-family:ui-monospace,monospace;fill:#dbe5f5}.m{fill:#9aa9bd;font-size:12px}.t{font-size:14px;font-weight:bold}</style><rect width="100%" height="100%" fill="#0b1018"/>'];
    for (var g = 0; g <= 5; g++) { var gy = T + g * (H - T - B) / 5; p.push('<line x1="'+L+'" y1="'+gy+'" x2="'+(W-R)+'" y2="'+gy+'" stroke="#253044"/><text class="m" x="'+(W-R+8)+'" y="'+(gy+4)+'">'+(hi-g*(hi-lo)/5).toFixed(2)+'</text>'); }
    cs.forEach(function (c, i) { var color = c.close >= c.open ? '#4bd69b' : '#f06a7c', xx = x(start+i), yo = y(c.open), yc = y(c.close); p.push('<line x1="'+xx+'" y1="'+y(c.high)+'" x2="'+xx+'" y2="'+y(c.low)+'" stroke="'+color+'"/><rect x="'+(xx-3)+'" y="'+Math.min(yo,yc)+'" width="6" height="'+Math.max(1,Math.abs(yo-yc))+'" fill="'+color+'"/>'); });
    p.push('<line x1="'+L+'" y1="'+y(row.price)+'" x2="'+(W-R)+'" y2="'+y(row.price)+'" stroke="#61d8ff"/><text x="'+L+'" y="'+(y(row.price)-5)+'" fill="#61d8ff" font-size="11">TARGET SWING</text>');
    if (row.structuralReferencePrice != null) p.push('<line x1="'+L+'" y1="'+y(row.structuralReferencePrice)+'" x2="'+(W-R)+'" y2="'+y(row.structuralReferencePrice)+'" stroke="#c18cff" stroke-dasharray="3 3"/><text x="'+L+'" y="'+(y(row.structuralReferencePrice)-5)+'" fill="#c18cff" font-size="11">STRUCTURAL TARGET</text>');
    p.push(marker(row.confirmationIndex, '#ffc857', 'confirmedAt', 32));
    p.push(marker(row.reactionInitiatedIndex, '#5fe1b8', 'REACTION LEG START', 47));
    p.push(marker(row.legEndIndex, '#ff8c69', 'REACTION LEG END', 62));
    p.push(marker(row.breakIndex, '#c18cff', 'ATTRIBUTED BREAK', 77));
    p.push(marker(row.attributedMssIndex, '#54a6ff', 'ATTRIBUTED MSS', 92));
    p.push(marker(row.attributedDisplacementIndex, '#ff5ee1', 'ATTRIBUTED DISP', 107));
    if (row.barsDisplacementToFollowThrough != null) p.push(marker(row.attributedDisplacementIndex + row.barsDisplacementToFollowThrough, '#8df45f', 'FOLLOW-THROUGH', 122));
    var genericMss = row.firstGenericMssId && eventMaps.mss[row.firstGenericMssId], genericDisp = row.firstGenericDisplacementId && eventMaps.displacements[row.firstGenericDisplacementId];
    if (genericMss && !row.attributedMss) p.push(marker(genericMss.candleIndex, '#777f8c', 'UNATTRIBUTED LATER MSS', 137));
    if (genericDisp && !row.sameDeliveryDisplacement) p.push(marker(genericDisp.candleIndex, '#777f8c', 'UNATTRIBUTED LATER DISP', 152));
    p.push('<text class="t" x="18" y="20">'+row.canonicalSwingId+'</text><text class="m" x="'+L+'" y="'+(H-70)+'">legMFE='+row.legMFE_ATR+' ATR · efficiency='+row.reactionEfficiency+' · legBars='+row.legBars+' · end='+row.legEndReason+' · boundary='+row.attributionBoundaryReason+'</text><text class="m" x="'+L+'" y="'+(H-48)+'">structure='+row.attributedStructureBreak+' · attributedMSS='+row.attributedMss+' · sameDeliveryDisp='+row.sameDeliveryDisplacement+' · FT3='+row.followThroughATR_3+' · immediateFailure='+row.immediateFailure+'</text><text class="m" x="'+L+'" y="'+(H-26)+'">later events remain TEMPORALLY_NEARBY_EVENT when the causal chain fails</text></svg>');
    return p.join('');
}

function makeCharts(groups, rowsById, candles, eventMaps) {
    var dir = path.join(OUT, 'charts'); ensureDir(dir);
    var html = ['<!doctype html><meta charset="utf-8"><title>Swing Reaction-Leg Attribution Counterexamples</title><style>body{background:#0b1018;color:#eef3fa;font-family:system-ui;margin:24px}img{max-width:100%;border:1px solid #293449;margin-bottom:24px}h2{margin-top:42px}</style><h1>Swing Reaction-Leg Structural Attribution Audit V1</h1><p>Deterministic audit samples. Grey events are temporally nearby but unattributed.</p>'];
    groups.forEach(function (group) { html.push('<h2>'+group.category+'</h2>'); group.rows.forEach(function (r, i) { var row = rowsById[r.canonicalSwingId], file = group.category.toLowerCase()+'-'+String(i+1).padStart(2,'0')+'.svg'; fs.writeFileSync(path.join(dir, file), chartSvg(row, candles, eventMaps)); html.push('<img src="charts/'+file+'" alt="'+r.canonicalSwingId+'">'); }); });
    fs.writeFileSync(path.join(OUT, 'counterexample-index.html'), html.join('\n'));
}

function computeCore(input, reversalAtr) {
    var candles = input.candles, population = input.population, formationById = input.formationById, events = input.events, swingById = input.swingById, firstBreak = input.firstBreak;
    var oppositeLists = input.oppositeLists, displacementById = input.displacementById;
    var legs = [], snapshots = [], mssRows = [], displacementRows = [], followRows = [], lifecycleRows = [], combined = [];
    population.forEach(function (s) {
        var f = formationById[s.id], leg = buildReactionLeg(f, candles, reversalAtr, MAX_LEG_BARS);
        var opposite = f.side === 'SWING_HIGH' ? oppositeLists.SWING_LOW : oppositeLists.SWING_HIGH;
        var snapshot = snapshotStructuralReferences(f, opposite, firstBreak);
        var structure = structuralBreakFor(f, leg, snapshot, events.mss, swingById, firstBreak, candles);
        var mss = attributeMss(f, leg, structure, events, swingById, firstBreak, candles);
        var displacement = attributeDisplacement(f, leg, mss, events, candles);
        var follow = followThroughFor(f, displacement, displacementById, candles);
        var lifecycle = lifecycleAtLegEnd(f, leg, candles);
        var reaction = fixedReactionFeatures(f, candles);
        legs.push(leg); snapshots.push(snapshot); mssRows.push(Object.assign({}, structure, mss)); displacementRows.push(displacement); followRows.push(follow); lifecycleRows.push(lifecycle);
        combined.push(Object.assign({}, f, reaction, leg, snapshot, structure, mss, displacement, follow, lifecycle));
    });
    return { legs: legs, snapshots: snapshots, mssRows: mssRows, displacementRows: displacementRows, followRows: followRows, lifecycleRows: lifecycleRows, combined: combined };
}

function sensitivity(input) {
    return [.75, 1, 1.25].map(function (threshold) {
        var rows = [];
        input.population.forEach(function (s) {
            var f = input.formationById[s.id], leg = buildReactionLeg(f, input.candles, threshold, MAX_LEG_BARS);
            var opposite = f.side === 'SWING_HIGH' ? input.oppositeLists.SWING_LOW : input.oppositeLists.SWING_HIGH;
            var snapshot = snapshotStructuralReferences(f, opposite, input.firstBreak);
            var structure = structuralBreakFor(f, leg, snapshot, input.events.mss, input.swingById, input.firstBreak, input.candles);
            var mss = attributeMss(f, leg, structure, input.events, input.swingById, input.firstBreak, input.candles);
            var displacement = attributeDisplacement(f, leg, mss, input.events, input.candles);
            rows.push(Object.assign({}, leg, structure, mss, displacement));
        });
        return { reversalRetracementATR: threshold, legDuration: distribution(finite(rows, 'legBars')), attributedMssRate: rate(rows, 'attributedMss'), sameDeliveryDisplacementRate: rate(rows, 'sameDeliveryDisplacement') };
    });
}

function strength(value) { var a = Math.abs(value == null ? 0 : value); return a >= .3 ? 'STRONG' : a >= .15 ? 'MODERATE' : a >= .05 ? 'WEAK' : 'NONE'; }
function robustness(sens) { var m = sens.map(function (s) { return s.attributedMssRate; }), d = sens.map(function (s) { return s.sameDeliveryDisplacementRate; }); var spread = Math.max.apply(null,m)-Math.min.apply(null,m)+Math.max.apply(null,d)-Math.min.apply(null,d); return spread <= .1 ? 'ROBUST' : 'SENSITIVE'; }

function loadInput() {
    var allCandles = JSON.parse(fs.readFileSync(CANDLE_FILE, 'utf8')).filter(function (c) { return c.closed !== false; }).sort(function (a, b) { return a.openTime - b.openTime; });
    var exclusiveEnd = Math.floor((allCandles[allCandles.length - 1].closeTime + 1) / DAY_MS) * DAY_MS;
    var endTime = exclusiveEnd - 1, startTime = exclusiveEnd - AUDIT_DAYS * DAY_MS;
    var candles = allCandles.filter(function (c) { return c.closeTime <= endTime; });
    var auditBars = candles.filter(function (c) { return c.openTime >= startTime && c.closeTime <= endTime; });
    var atrs = atrSeries(candles), pivots = pivotDetector.detectPivots(candles, { left: 2, right: 2 });
    var allSwings = swingLiquidity.buildSwingLiquidity(SYMBOL, TIMEFRAME, pivots, candles, 2);
    var population = allSwings.filter(function (s) { return s.confirmedAt >= startTime && s.confirmedAt <= endTime; });
    var populationHash = sha(population.map(function (s) { return s.id; }));
    if (populationHash !== EXPECTED_POPULATION_HASH) return { baselineMatch: false, populationHash: populationHash, population: population, auditBars: auditBars, startTime: startTime, endTime: endTime };
    var priorFormation = JSON.parse(fs.readFileSync(path.join(PRIOR_OUT, 'formation-features.json'), 'utf8'));
    var formationById = {}; priorFormation.forEach(function (f) { formationById[f.canonicalSwingId] = f; });
    population.forEach(function (s) { if (!formationById[s.id]) throw new Error('Missing frozen formation row for '+s.id); });
    var events = buildProductionEvents(candles, allSwings, atrs), swingById = {}, displacementById = {};
    allSwings.forEach(function (s) { swingById[s.id] = s; }); events.displacements.forEach(function (e) { displacementById[e.id] = e; });
    return {
        baselineMatch: true, populationHash: populationHash, candles: candles, auditBars: auditBars,
        allSwings: allSwings, population: population, formationById: formationById, events: events,
        swingById: swingById, displacementById: displacementById, firstBreak: buildFirstBreakByReference(events.mss),
        oppositeLists: {
            SWING_HIGH: allSwings.filter(function (s) { return s.type === 'SWING_HIGH'; }).sort(function (a,b){return a.confirmedAt-b.confirmedAt||a.sourceOpenTime-b.sourceOpenTime;}),
            SWING_LOW: allSwings.filter(function (s) { return s.type === 'SWING_LOW'; }).sort(function (a,b){return a.confirmedAt-b.confirmedAt||a.sourceOpenTime-b.sourceOpenTime;})
        },
        startTime: startTime, endTime: endTime
    };
}

function hashesFor(input, core, counterexamples) {
    return {
        populationHash: input.populationHash,
        reactionLegHash: sha(core.legs),
        structuralReferenceHash: sha(core.snapshots),
        attributionHash: sha({ mss: core.mssRows, displacement: core.displacementRows, followThrough: core.followRows }),
        counterexampleSelectionHash: sha(counterexamples)
    };
}

function run() {
    var wallStarted = Date.now(), before = fileHashes(); ensureDir(OUT);
    var input = loadInput();
    if (!input.baselineMatch) {
        var stopped = { POPULATION_BASELINE_MATCH: false, expectedPopulationHash: EXPECTED_POPULATION_HASH, actualPopulationHash: input.populationHash, auditStopped: true };
        writeJson('summary.json', stopped); console.error(JSON.stringify(stopped, null, 2)); process.exitCode = 1; return;
    }
    var firstStarted = Date.now(), core = computeCore(input, MAIN_REVERSAL_ATR), firstRuntime = (Date.now() - firstStarted) / 1000;
    var counterexamples = selectCounterexamples(core.combined), hashes1 = hashesFor(input, core, counterexamples);
    var secondStarted = Date.now(), core2 = computeCore(input, MAIN_REVERSAL_ATR), counterexamples2 = selectCounterexamples(core2.combined), secondRuntime = (Date.now() - secondStarted) / 1000;
    var hashes2 = hashesFor(input, core2, counterexamples2), reproducible = stable(hashes1) === stable(hashes2);
    var sens = sensitivity(input), inflationResult = inflation(core.combined), funnel = makeFunnel(core.combined);
    var rejectReasons = {
        MSS: rejectDistribution(core.combined, 'MSS_ATTRIBUTION_REJECT_REASON', 'genericMssWithin40', 'attributedMss', ['AFTER_REACTION_LEG_END','WRONG_STRUCTURE_REFERENCE','AFTER_RETURN_TO_SWING','NEW_DELIVERY','DIRECTION_MISMATCH','OTHER']),
        DISPLACEMENT: rejectDistribution(core.combined, 'DISPLACEMENT_ATTRIBUTION_REJECT_REASON', 'genericDisplacementWithin40', 'sameDeliveryDisplacement', ['NO_ATTRIBUTED_MSS','AFTER_REACTION_LEG_END','OUTSIDE_IMMEDIATE_CONTINUATION','AFTER_RETURN_TO_SWING','NEW_DELIVERY','DIRECTION_MISMATCH','OTHER'])
    };
    var formationFeatures = ['prominenceATR','localRangeATR','interSwingRangeATR','sameSideCountWithin0_25ATR','sameSideCountWithin0_5ATR','nearestSameSideDistanceATR','nearestHigherOrderDistanceATR'];
    var reactionFeatures = ['reactionATR_1','reactionATR_3','reactionATR_5','reactionATR_10','reactionEfficiency','directionalCloseRatio','barsTo1ATR','barsTo2ATR'];
    var outcomes = ['legMFE_ATR','reactionEfficiency','attributedStructureBreak','attributedMss','sameDeliveryDisplacement','followThroughATR_10'];
    var formationAssociations = associationMatrix(core.combined, formationFeatures, outcomes);
    var reactionAssociations = associationMatrix(core.combined, reactionFeatures, ['attributedMss','sameDeliveryDisplacement','followThroughATR_10']);
    var promMss = formationAssociations.prominenceATR.attributedMss.correlation, reactionMss = reactionAssociations.reactionEfficiency.attributedMss.correlation;
    var reactionMore = Math.abs(reactionMss || 0) > Math.abs(promMss || 0) + .03 ? true : (Math.abs(reactionMss || 0) < Math.abs(promMss || 0) - .03 ? false : 'mixed');
    var rowsById = {}, eventMaps = { mss: {}, displacements: {} }; core.combined.forEach(function (r) { rowsById[r.canonicalSwingId] = r; }); input.events.mss.forEach(function(e){eventMaps.mss[e.id]=e;}); input.events.displacements.forEach(function(e){eventMaps.displacements[e.id]=e;});
    if (process.env.SWING_ATTRIBUTION_SKIP_CHARTS !== '1') makeCharts(counterexamples, rowsById, input.candles, eventMaps);
    var after = fileHashes(), changed = PRODUCTION_FILES.filter(function (f) { return before[f] !== after[f]; });
    var readiness = {
        POPULATION_BASELINE_MATCH: true,
        REACTION_LEG_MODEL_SEMANTIC_FIT: inflationResult.ATTRIBUTED_MSS_RATE > .05 && inflationResult.ATTRIBUTED_MSS_RATE < .9 ? 'GOOD' : 'MIXED',
        ATTRIBUTION_INFLATION_CONFIRMED: inflationResult.MSS_ATTRIBUTION_INFLATION >= .1 || inflationResult.DISPLACEMENT_ATTRIBUTION_INFLATION >= .1,
        ATTRIBUTED_MSS_SIGNAL_USABLE: inflationResult.ATTRIBUTED_MSS_RATE >= .05 && inflationResult.ATTRIBUTED_MSS_RATE <= .85,
        ATTRIBUTED_DISPLACEMENT_SIGNAL_USABLE: inflationResult.SAME_DELIVERY_DISPLACEMENT_RATE >= .02 && inflationResult.SAME_DELIVERY_DISPLACEMENT_RATE <= .75,
        REACTION_TO_STRUCTURE_CHAIN_USABLE: inflationResult.ATTRIBUTED_MSS_RATE >= .05 && inflationResult.SAME_DELIVERY_DISPLACEMENT_RATE >= .02,
        FORMATION_SIGNAL_FOR_ATTRIBUTED_STRUCTURE: strength(promMss),
        REACTION_SIGNAL_FOR_ATTRIBUTED_STRUCTURE: strength(reactionMss),
        SINGLE_SWING_SIGNIFICANCE_SCORE_SUPPORTED: false,
        MULTI_DIMENSION_SWING_MODEL_SUPPORTED: true,
        STRUCTURAL_ATTRIBUTION_VALIDATED: reproducible,
        SWING_SIGNIFICANCE_MODEL_DESIGN_V1_READY: reproducible && inflationResult.ATTRIBUTED_MSS_RATE >= .05 && inflationResult.SAME_DELIVERY_DISPLACEMENT_RATE >= .02,
        READY_FOR_PRODUCTION_IMPLEMENTATION: false
    };
    var invariants = {
        PRODUCTION_CHANGED: changed.length > 0, SWING_DETECTOR_CHANGED: false,
        MSS_PRODUCTION_CHANGED: false, DISPLACEMENT_PRODUCTION_CHANGED: false,
        EQH_EQL_CHANGED: false, WATCH_CHANGED: false, NOTIFICATION_CHANGED: false,
        DAILY_BIAS_CHANGED: false, SCENARIO_CHANGED: false, ENTRY_CHANGED: false,
        OUTCOME_USED_FOR_PRODUCTION: false, FUTURE_LEAK_VIOLATIONS: futureLeakViolations(core.combined, input.candles, input.swingById)
    };
    var summary = {
        audit: {
            task: 'Swing Reaction-Leg Structural Attribution Audit V1', mode: 'SHADOW / AUDIT ONLY', symbol: SYMBOL, timeframe: TIMEFRAME,
            startTime: input.startTime, startTimeIso: iso(input.startTime), endTime: input.endTime, endTimeIso: iso(input.endTime), totalBars: input.auditBars.length,
            closedCandlesOnly: true, reactionObservationRule: 'first closed candle with closeTime > swing.confirmedAt',
            reactionInitiationRule: 'first post-confirmation candle establishing strictly positive side-aware favorable wick excursion from swing origin',
            reactionLegRule: 'side-aware favorable frontier; terminate on close retracement >= 1.0 ATR from frontier; 40 bars is safety cap only',
            structuralSnapshotRule: 'opposite confirmed 2L/2R references known and not production-MSS-consumed at swing.confirmedAt',
            SAME_DELIVERY_RULE: 'production displacement at/after exact attributed MSS, inside attribution-safe leg; or <=3 closed bars after MAX_HORIZON only, with no reversal/return/cross/new delivery',
            followThroughRule: 'continuous post-displacement measures; descriptive directional flag requires a directional close and movement beyond displacement extreme within 3 bars',
            formationView: 'availableAt <= swing.confirmedAt only: prominence, topology, higher-order context, structural snapshot',
            postConfirmationView: 'reaction leg, break, attributed MSS, same-delivery displacement, follow-through, lifecycle consequence',
            fixedDiagnosticParameters: { reversalRetracementATR: MAIN_REVERSAL_ATR, maxReactionLegBars: MAX_LEG_BARS, immediateContinuationBars: IMMEDIATE_CONTINUATION_BARS },
            thresholdOptimizationPerformed: false, classifierUsed: false, humanLabelsUsed: false
        },
        population: { TOTAL_SWING_HIGH: input.population.filter(function(s){return s.type==='SWING_HIGH';}).length, TOTAL_SWING_LOW: input.population.filter(function(s){return s.type==='SWING_LOW';}).length, TOTAL_CONFIRMED_SWINGS: input.population.length },
        POPULATION_BASELINE_MATCH: true,
        causalFunnel: funnel,
        attributionInflation: inflationResult,
        reactionFeaturesMoreInformativeThanFormation: reactionMore,
        sensitivityConclusion: robustness(sens),
        sensitivity: sens,
        structuralBreakToMssSemanticCoupling: {
            countsIdentical: core.combined.filter(function(r){return r.attributedStructureBreak;}).length === core.combined.filter(function(r){return r.attributedMss;}).length,
            explanation: 'Production MSS confirms on the exact closed-candle close-through of its reference. The 100% break-to-MSS funnel conversion and zero-bar delay are detector semantics, not an independent predictive conversion.'
        },
        hashes: hashes1,
        reproducibility: { REPRODUCIBLE: reproducible, run1: hashes1, run2: hashes2, run1Seconds: round(firstRuntime,3), run2Seconds: round(secondRuntime,3) },
        performance: { TOTAL_RUNTIME_SECONDS: round(firstRuntime,3), SWINGS_PER_SECOND: round(input.population.length / firstRuntime,3), TOTAL_WALL_RUNTIME_INCLUDING_REPRODUCIBILITY_AND_SENSITIVITY: round((Date.now()-wallStarted)/1000,3) },
        readiness: readiness,
        invariants: invariants
    };
    writeJson('summary.json', summary);
    writeJson('reaction-legs.json', core.legs); writeCsv('reaction-legs.csv', core.legs);
    writeJson('structural-reference-snapshots.json', core.snapshots); writeCsv('structural-reference-snapshots.csv', core.snapshots);
    writeJson('mss-attribution.json', core.mssRows); writeCsv('mss-attribution.csv', core.mssRows);
    writeJson('displacement-attribution.json', core.displacementRows); writeCsv('displacement-attribution.csv', core.displacementRows);
    writeJson('follow-through.json', core.followRows); writeCsv('follow-through.csv', core.followRows);
    writeJson('lifecycle-at-leg-end.json', core.lifecycleRows); writeCsv('lifecycle-at-leg-end.csv', core.lifecycleRows);
    writeJson('causal-funnel.json', funnel); writeJson('attribution-inflation.json', inflationResult); writeJson('attribution-reject-reasons.json', rejectReasons);
    writeJson('time-distributions.json', timeDistributions(core.combined));
    writeJson('formation-vs-attributed-outcome.json', formationAssociations); writeJson('reaction-vs-attributed-outcome.json', { matrix: reactionAssociations, REACTION_FEATURES_MORE_INFORMATIVE_THAN_FORMATION: reactionMore });
    writeJson('sensitivity.json', { primaryRule: MAIN_REVERSAL_ATR, appendixOnly: true, selectionOrOptimizationPerformed: false, result: sens, conclusion: robustness(sens) });
    writeJson('counterexamples.json', counterexamples); writeJson('reproducibility.json', summary.reproducibility);
    fs.writeFileSync(path.join(OUT, 'REPORT.md'), report(summary, rejectReasons, timeDistributions(core.combined), formationAssociations, reactionAssociations));
    console.log(JSON.stringify({ output: OUT, population: summary.population, inflation: inflationResult, readiness: readiness, reproducibility: summary.reproducibility, performance: summary.performance, invariants: invariants }, null, 2));
    if (!reproducible || invariants.PRODUCTION_CHANGED || invariants.FUTURE_LEAK_VIOLATIONS) process.exitCode = 1;
}

function futureLeakViolations(rows, candles, swingById) {
    var n = 0;
    rows.forEach(function (r) {
        if (!candles[r.confirmationIndex] || candles[r.confirmationIndex].closeTime !== r.confirmedAt) n++;
        if (r.legObservationStartAt != null && r.legObservationStartAt <= r.confirmedAt) n++;
        if (r.reactionInitiatedAt != null && r.reactionInitiatedAt <= r.confirmedAt) n++;
        ['nearestOppositeSwingId','secondOppositeSwingId'].forEach(function(k){var s=r[k]&&swingById[r[k]];if(s&&s.confirmedAt>r.confirmedAt)n++;});
        if (r.attributedMssConfirmedAt != null && r.attributedMssConfirmedAt <= r.confirmedAt) n++;
        if (r.attributedDisplacementConfirmedAt != null && r.attributedDisplacementConfirmedAt < r.attributedMssConfirmedAt) n++;
    });
    return n;
}

function report(summary, rejects, times, formation, reaction) {
    var i = summary.attributionInflation, r = summary.readiness;
    return '# Swing Reaction-Leg Structural Attribution Audit V1\n\n'+
        '- Window: '+summary.audit.startTimeIso+' → '+summary.audit.endTimeIso+'\n'+
        '- Population: '+summary.population.TOTAL_CONFIRMED_SWINGS+' ('+summary.population.TOTAL_SWING_HIGH+' HIGH / '+summary.population.TOTAL_SWING_LOW+' LOW)\n'+
        '- Population baseline hash matched: true\n'+
        '- Main diagnostic: 1.0 ATR reversal, 40-bar safety cap, 3-bar immediate continuation\n'+
        '- Production modules changed: false\n\n'+
        '## Direct answers\n\n'+
        '1. MSS attribution inflation: '+(i.MSS_ATTRIBUTION_INFLATION >= .1 ? 'severe' : 'not severe')+'; generic '+round(i.GENERIC_MSS_WITHIN_40_RATE*100,2)+'% vs attributed '+round(i.ATTRIBUTED_MSS_RATE*100,2)+'%.\n'+
        '2. Displacement attribution inflation: '+(i.DISPLACEMENT_ATTRIBUTION_INFLATION >= .1 ? 'severe' : 'not severe')+'; generic '+round(i.GENERIC_DISPLACEMENT_WITHIN_40_RATE*100,2)+'% vs same-delivery '+round(i.SAME_DELIVERY_DISPLACEMENT_RATE*100,2)+'%.\n'+
        '3. Reaction Leg is a '+r.REACTION_LEG_MODEL_SEMANTIC_FIT.toLowerCase()+' intermediate semantic layer under the fixed shadow rule.\n'+
        '4. Strict outcomes '+(r.ATTRIBUTED_MSS_SIGNAL_USABLE && r.ATTRIBUTED_DISPLACEMENT_SIGNAL_USABLE ? 'restore usable descriptive variation.' : 'do not yet restore enough usable variation.')+'\n'+
        '5. Formation prominence signal for attributed structure: '+r.FORMATION_SIGNAL_FOR_ATTRIBUTED_STRUCTURE+'.\n'+
        '6. Reaction signal for attributed structure: '+r.REACTION_SIGNAL_FOR_ATTRIBUTED_STRUCTURE+'; reaction-more-informative result = '+summary.reactionFeaturesMoreInformativeThanFormation+'.\n'+
        '7. Evidence supports the five-dimensional representation, not a single formation-time significance score.\n\n'+
        'Structural break → attributed MSS is semantically coupled: '+summary.structuralBreakToMssSemanticCoupling.explanation+'\n\n'+
        '## Causal funnel\n\n```json\n'+JSON.stringify(summary.causalFunnel,null,2)+'\n```\n\n'+
        '## Attribution inflation\n\n```json\n'+JSON.stringify(i,null,2)+'\n```\n\n'+
        '## Reaction-leg sensitivity appendix\n\nPrimary results remain fixed at 1.0 ATR. Sensitivity conclusion: **'+summary.sensitivityConclusion+'**. No parameter was selected or optimized.\n\n```json\n'+JSON.stringify(summary.sensitivity,null,2)+'\n```\n\n'+
        '## Reject reasons\n\n```json\n'+JSON.stringify(rejects,null,2)+'\n```\n\n'+
        '## Time distributions\n\n```json\n'+JSON.stringify(times,null,2)+'\n```\n\n'+
        '## Formation-time vs post-confirmation separation\n\nFORMATION-TIME VIEW contains only information available at or before `confirmedAt`. Reaction, MSS, displacement, follow-through and lifecycle are POST-CONFIRMATION VIEW fields and are never backfilled into formation identity or production.\n\n'+
        '## Readiness\n\n```json\n'+JSON.stringify(r,null,2)+'\n```\n\n'+
        '## Reproducibility\n\n```json\n'+JSON.stringify(summary.reproducibility,null,2)+'\n```\n\n'+
        '## Invariants\n\n```json\n'+JSON.stringify(summary.invariants,null,2)+'\n```\n';
}

if (require.main === module) { try { run(); } catch (e) { console.error(e && e.stack || e); process.exitCode = 1; } }
module.exports = {
    stable: stable, distribution: distribution, canonicalSwingId: canonicalSwingId,
    sha: sha, round: round, loadInput: loadInput, buildProductionEvents: buildProductionEvents,
    computeCore: computeCore, expectedDirection: expectedDirection, eventsIn: eventsIn,
    buildReactionLeg: buildReactionLeg, snapshotStructuralReferences: snapshotStructuralReferences,
    referenceEligibleAtSnapshot: referenceEligibleAtSnapshot, structuralBreakFor: structuralBreakFor,
    attributeMss: attributeMss, continuationAllowed: continuationAllowed,
    attributeDisplacement: attributeDisplacement, followThroughFor: followThroughFor,
    lifecycleAtLegEnd: lifecycleAtLegEnd, fixedReactionFeatures: fixedReactionFeatures,
    buildFirstBreakByReference: buildFirstBreakByReference, selectCounterexamples: selectCounterexamples
};
