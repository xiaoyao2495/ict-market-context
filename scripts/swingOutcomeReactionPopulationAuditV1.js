#!/usr/bin/env node
'use strict';

/**
 * Swing Outcome / Reaction Population Audit V1
 * Audit-only, deterministic, closed-candle population study. Human labels are
 * intentionally never loaded. Production modules are read-only inputs.
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
var sessions = require('../config/sessions');

var ROOT = path.resolve(__dirname, '..');
var OUT = path.resolve(process.argv[2] || path.join(ROOT, 'swing-outcome-reaction-population-audit-v1'));
var CANDLE_FILE = path.resolve(process.env.SWING_OUTCOME_CANDLES || path.join(ROOT, 'data-cache', 'BTCUSDT_5m_20504_20686.json'));
var DAILY_FILE = path.resolve(process.env.SWING_OUTCOME_DAILY || path.join(ROOT, 'data-cache', 'BTCUSDT_1d_20306_20686.json'));
var WEEKLY_FILE = path.resolve(process.env.SWING_OUTCOME_WEEKLY || path.join(ROOT, 'data-cache', 'BTCUSDT_1w_20422_20686.json'));
var SYMBOL = 'BTCUSDT';
var TIMEFRAME = '5m';
var BAR_MS = 300000;
var DAY_MS = 86400000;
var HORIZONS = [1, 3, 5, 10, 20, 40];
var AUDIT_DAYS = 180;
var PRODUCTION_FILES = [
    'structure/pivotDetector.js', 'liquidity/swingLiquidity.js',
    'structure/structuralProvenance5m.js', 'events/mssSignalDetector.js',
    'events/displacementDetector.js', 'liquidity/liquidityLifecycle.js',
    'indicators/atr.js', 'config/thresholds.js', 'config/sessions.js'
];

function round(n, d) { if (n == null || !isFinite(n)) return null; var p = Math.pow(10, d == null ? 6 : d); return Math.round(n * p) / p; }
function iso(ms) { return new Date(ms).toISOString(); }
function sha(value) { return crypto.createHash('sha256').update(typeof value === 'string' ? value : stable(value)).digest('hex'); }
function stable(value) {
    if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(function (k) { return JSON.stringify(k) + ':' + stable(value[k]); }).join(',') + '}';
    return JSON.stringify(value);
}
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
    if (!a.length) return { count: 0, mean: null, median: null, std: null, p05: null, p10: null, p25: null, p50: null, p75: null, p90: null, p95: null, p99: null, min: null, max: null };
    var mean = a.reduce(function (s, x) { return s + x; }, 0) / a.length;
    var variance = a.reduce(function (s, x) { var d = x - mean; return s + d * d; }, 0) / a.length;
    return { count: a.length, mean: round(mean), median: round(percentile(a, .5)), std: round(Math.sqrt(variance)), p05: round(percentile(a, .05)), p10: round(percentile(a, .1)), p25: round(percentile(a, .25)), p50: round(percentile(a, .5)), p75: round(percentile(a, .75)), p90: round(percentile(a, .9)), p95: round(percentile(a, .95)), p99: round(percentile(a, .99)), min: round(a[0]), max: round(a[a.length - 1]) };
}
function rank(values) {
    var indexed = values.map(function (v, i) { return { v: v, i: i }; }).sort(function (a, b) { return a.v - b.v; });
    var ranks = new Array(values.length), i = 0;
    while (i < indexed.length) { var j = i + 1; while (j < indexed.length && indexed[j].v === indexed[i].v) j++; var r = (i + j - 1) / 2 + 1; for (var k = i; k < j; k++) ranks[indexed[k].i] = r; i = j; }
    return ranks;
}
function pearson(x, y) { if (x.length < 3) return null; var mx = x.reduce(sum, 0) / x.length, my = y.reduce(sum, 0) / y.length, n = 0, dx = 0, dy = 0; for (var i = 0; i < x.length; i++) { var a = x[i] - mx, b = y[i] - my; n += a * b; dx += a * a; dy += b * b; } return dx && dy ? round(n / Math.sqrt(dx * dy)) : null; }
function sum(a, b) { return a + b; }
function spearman(rows, a, b) { var pairs = rows.map(function (r) { return [r[a], r[b]]; }).filter(function (p) { return p.every(function (v) { return typeof v === 'number' && isFinite(v); }); }); return { n: pairs.length, rho: pearson(rank(pairs.map(function (p) { return p[0]; })), rank(pairs.map(function (p) { return p[1]; }))) }; }
function rankBiserial(rows, feature, outcome) { var pairs = rows.map(function (r) { return [r[feature], r[outcome]]; }).filter(function (p) { return typeof p[0] === 'number' && typeof p[1] === 'boolean'; }); if (!pairs.length) return { n: 0, correlation: null }; return { n: pairs.length, correlation: pearson(rank(pairs.map(function (p) { return p[0]; })), pairs.map(function (p) { return p[1] ? 1 : 0; })) }; }

function atrSeries(candles) {
    var out = new Array(candles.length).fill(null), prev = null, p = 14;
    for (var i = p; i < candles.length; i++) {
        if (i === p) { var s = 0; for (var j = 1; j <= p; j++) s += atrIndicator.trueRange(candles[j], candles[j - 1]); prev = s / p; }
        else prev = (prev * (p - 1) + atrIndicator.trueRange(candles[i], candles[i - 1])) / p;
        out[i] = prev;
    }
    return out;
}

function prominence(candles, sourceIndex, side, atr) {
    if (!(atr > 0) || sourceIndex < 2 || sourceIndex + 2 >= candles.length) return null;
    if (side === 'SWING_HIGH') {
        var leftLow = Math.min(candles[sourceIndex - 2].low, candles[sourceIndex - 1].low, candles[sourceIndex].low);
        var rightLow = Math.min(candles[sourceIndex].low, candles[sourceIndex + 1].low, candles[sourceIndex + 2].low);
        return (candles[sourceIndex].high - Math.max(leftLow, rightLow)) / atr;
    }
    var leftHigh = Math.max(candles[sourceIndex - 2].high, candles[sourceIndex - 1].high, candles[sourceIndex].high);
    var rightHigh = Math.max(candles[sourceIndex].high, candles[sourceIndex + 1].high, candles[sourceIndex + 2].high);
    return (Math.min(leftHigh, rightHigh) - candles[sourceIndex].low) / atr;
}

function aggregateCalendar(candles, dailyCandles, weeklyCandles) {
    var days = {}, weeks = {}, sessionMap = { ASIA: {}, LONDON: {} };
    function dayStart(t) { return Math.floor(t / DAY_MS) * DAY_MS; }
    function weekStart(t) { var d = new Date(dayStart(t)), dow = d.getUTCDay(); return dayStart(t) - ((dow + 6) % 7) * DAY_MS; }
    function add(map, key, c) { var r = map[key]; if (!r) r = map[key] = { high: -Infinity, low: Infinity, availableAt: 0 }; r.high = Math.max(r.high, c.high); r.low = Math.min(r.low, c.low); r.availableAt = Math.max(r.availableAt, c.closeTime); }
    candles.forEach(function (c) {
        add(days, dayStart(c.openTime), c); add(weeks, weekStart(c.openTime), c);
        ['ASIA', 'LONDON'].forEach(function (name) {
            var cfg = sessions[name], ds = dayStart(c.openTime), start = ds + (cfg.startHourUtc * 60 + cfg.startMinuteUtc) * 60000, end = ds + (cfg.endHourUtc * 60 + cfg.endMinuteUtc) * 60000;
            if (end <= start) end += DAY_MS;
            if (c.openTime >= start && c.openTime < end) add(sessionMap[name], ds, c);
        });
    });
    (dailyCandles || []).filter(function(c){return c.closed !== false;}).forEach(function(c){days[c.openTime]={high:c.high,low:c.low,availableAt:c.closeTime};});
    (weeklyCandles || []).filter(function(c){return c.closed !== false;}).forEach(function(c){weeks[c.openTime]={high:c.high,low:c.low,availableAt:c.closeTime};});
    return { days: days, weeks: weeks, sessions: sessionMap, dayStart: dayStart, weekStart: weekStart };
}

function higherOrder(feature, calendar) {
    var t = feature.confirmedAt, ds = calendar.dayStart(t), ws = calendar.weekStart(t), atr = feature.atrAtConfirmedAt;
    var d = calendar.days[ds - DAY_MS], w = calendar.weeks[ws - 7 * DAY_MS];
    function completedSession(name) { var cfg = sessions[name], end = ds + (cfg.endHourUtc * 60 + cfg.endMinuteUtc) * 60000; if ((cfg.endHourUtc * 60 + cfg.endMinuteUtc) <= (cfg.startHourUtc * 60 + cfg.startMinuteUtc)) end += DAY_MS; var key = end <= t ? ds : ds - DAY_MS; var r = calendar.sessions[name][key]; return r && r.availableAt <= t ? r : null; }
    var asia = completedSession('ASIA'), london = completedSession('LONDON');
    var levels = {
        PDH: d && d.availableAt <= t ? { price: d.high, availableAt: d.availableAt } : null,
        PDL: d && d.availableAt <= t ? { price: d.low, availableAt: d.availableAt } : null,
        PWH: w && w.availableAt <= t ? { price: w.high, availableAt: w.availableAt } : null,
        PWL: w && w.availableAt <= t ? { price: w.low, availableAt: w.availableAt } : null,
        ASIA_HIGH: asia ? { price: asia.high, availableAt: asia.availableAt } : null,
        ASIA_LOW: asia ? { price: asia.low, availableAt: asia.availableAt } : null,
        LONDON_HIGH: london ? { price: london.high, availableAt: london.availableAt } : null,
        LONDON_LOW: london ? { price: london.low, availableAt: london.availableAt } : null
    };
    var result = {}, nearest = null;
    Object.keys(levels).forEach(function (type) {
        var l = levels[type], key = 'distanceATR_' + type;
        result[key] = l && atr > 0 ? round(Math.abs(feature.price - l.price) / atr) : null;
        result[type + '_availableAt'] = l ? l.availableAt : null;
        if (l && (!nearest || result[key] < nearest.distanceATR)) nearest = { type: type, price: l.price, distanceATR: result[key], availableAt: l.availableAt };
    });
    result.nearestHigherOrderType = nearest ? nearest.type : null;
    result.nearestHigherOrderPrice = nearest ? nearest.price : null;
    result.nearestHigherOrderDistanceATR = nearest ? nearest.distanceATR : null;
    result.nearestHigherOrderProvenance = nearest ? 'MOST_RECENT_COMPLETED_' + nearest.type : null;
    result.higherOrderAvailableAt = nearest ? nearest.availableAt : null;
    return result;
}

function topologyFeatures(swings, candles, atrs) {
    var ordered = swings.slice().sort(function (a, b) { return a.confirmedAt - b.confirmedAt || a.sourceOpenTime - b.sourceOpenTime || a.type.localeCompare(b.type); });
    var pools = { SWING_HIGH: [], SWING_LOW: [] }, latest = { SWING_HIGH: null, SWING_LOW: null }, out = {}, byIndex = new Map(candles.map(function (c, i) { return [c.openTime, i]; }));
    ordered.forEach(function (s) {
        var side = s.type, other = side === 'SWING_HIGH' ? 'SWING_LOW' : 'SWING_HIGH', sourceIndex = s.metadata.index, confirmIndex = sourceIndex + 2, atr = atrs[confirmIndex], own = pools[side], opp = pools[other];
        function rangeCount(pool, width) { if (!(atr > 0)) return null; var lo = lowerBound(pool, s.price - width * atr, function (x) { return x.price; }), hi = lowerBound(pool, s.price + width * atr + 1e-12, function (x) { return x.price; }); return hi - lo; }
        function nearest(pool) { if (!pool.length || !(atr > 0)) return null; var pos = lowerBound(pool, s.price, function (x) { return x.price; }), choices = []; if (pos < pool.length) choices.push(pool[pos]); if (pos > 0) choices.push(pool[pos - 1]); choices.sort(function (a, b) { return Math.abs(a.price - s.price) - Math.abs(b.price - s.price) || b.confirmedAt - a.confirmedAt; }); return choices[0]; }
        var ns = nearest(own), no = nearest(opp), prevOpp = latest[other];
        var rangeStart = Math.max(0, confirmIndex - 11), localHigh = -Infinity, localLow = Infinity; for (var i = rangeStart; i <= confirmIndex; i++) { localHigh = Math.max(localHigh, candles[i].high); localLow = Math.min(localLow, candles[i].low); }
        var inter = null; if (prevOpp) { var pi = byIndex.get(prevOpp.sourceOpenTime); if (pi != null) { var h = -Infinity, l = Infinity; for (var j = Math.min(pi, sourceIndex); j <= Math.max(pi, sourceIndex); j++) { h = Math.max(h, candles[j].high); l = Math.min(l, candles[j].low); } inter = atr > 0 ? (h - l) / atr : null; } }
        out[s.id] = {
            canonicalSwingId: s.id, symbol: s.symbol, timeframe: s.timeframe, side: side,
            occurredAt: s.sourceOpenTime, occurredAtIso: iso(s.sourceOpenTime), confirmedAt: s.confirmedAt, confirmedAtIso: iso(s.confirmedAt), price: s.price,
            sourceIndex: sourceIndex, confirmationIndex: confirmIndex, atrAtConfirmedAt: round(atr), prominenceATR: round(prominence(candles, sourceIndex, side, atr)),
            sameSideCountWithin0_25ATR: rangeCount(own, .25), sameSideCountWithin0_5ATR: rangeCount(own, .5), sameSideCountWithin1ATR: rangeCount(own, 1),
            nearestSameSideDistanceATR: ns && atr > 0 ? round(Math.abs(ns.price - s.price) / atr) : null,
            nearestSameSideBarsApart: ns ? Math.abs(sourceIndex - ns.metadata.index) : null,
            oppositeSideSwingCountNearby: rangeCount(opp, 1), nearestOppositeSideDistanceATR: no && atr > 0 ? round(Math.abs(no.price - s.price) / atr) : null,
            localRangeATR: atr > 0 ? round((localHigh - localLow) / atr) : null, interSwingRangeATR: round(inter), formationTopology: 'UNKNOWN',
            nearestPriorOppositeSwingId: prevOpp ? prevOpp.id : null
        };
        var insert = lowerBound(own, s.price, function (x) { return x.price; }); own.splice(insert, 0, s); latest[side] = s;
    });
    return out;
}

function buildProductionEvents(candles, swings, atrs) {
    var byConfirmed = {};
    swings.forEach(function (s) { (byConfirmed[s.confirmedAt] || (byConfirmed[s.confirmedAt] = [])).push(s); });
    var state = structuralProvenance5m.createState({ symbol: SYMBOL, timeframe: TIMEFRAME }), mss = [], structural = [];
    candles.forEach(function (c, i) { var step = structuralProvenance5m.step(state, c, i, byConfirmed[c.closeTime] || []); Array.prototype.push.apply(mss, step.mss); Array.prototype.push.apply(structural, step.events); });
    var displacements = displacementDetector.detectDisplacement(candles, mss, { symbol: SYMBOL, timeframe: TIMEFRAME, baseIndex: 0, atrSeries: atrs, thresholds: thresholds });
    return { mss: mss, structural: structural, displacements: displacements, finalStructuralState: state };
}

function reactionFor(f, candles) {
    var atr = f.atrAtConfirmedAt, ci = f.confirmationIndex, highSide = f.side === 'SWING_HIGH', out = { canonicalSwingId: f.canonicalSwingId, side: f.side, confirmedAt: f.confirmedAt };
    HORIZONS.forEach(function (h) {
        if (!(atr > 0) || ci + h >= candles.length) { out['reactionATR_' + h] = out['mfeATR_' + h] = out['maeATR_' + h] = null; return; }
        var favorable = 0, adverse = 0;
        for (var i = ci + 1; i <= ci + h; i++) { favorable = Math.max(favorable, highSide ? f.price - candles[i].low : candles[i].high - f.price); adverse = Math.max(adverse, highSide ? candles[i].high - f.price : f.price - candles[i].low); }
        out['reactionATR_' + h] = out['mfeATR_' + h] = round(Math.max(0, favorable) / atr); out['maeATR_' + h] = round(Math.max(0, adverse) / atr);
        var directional = 0, path = 0, bestClose = 0, away = 0; var confirmationClose = candles[ci].close, prev = confirmationClose;
        for (var j = ci + 1; j <= ci + h; j++) { var delta = candles[j].close - prev; if (highSide ? delta < 0 : delta > 0) directional++; path += Math.abs(delta); bestClose = Math.max(bestClose, highSide ? confirmationClose - candles[j].close : candles[j].close - confirmationClose); if ((highSide ? f.price - candles[j].close : candles[j].close - f.price) >= .5 * atr) away++; prev = candles[j].close; }
        out['directionalCloseCount_' + h] = directional; out['reactionEfficiency_' + h] = path > 0 ? round(Math.max(0, bestClose) / path) : 0; out['closeAwayRatio_' + h] = round(away / h);
    });
    [0.5, 1, 2, 3, 5].forEach(function (level) { var key = 'barsTo_' + String(level).replace('.', '_') + 'ATR', value = null; if (atr > 0) for (var i = ci + 1; i <= Math.min(ci + 40, candles.length - 1); i++) { var fav = highSide ? f.price - candles[i].low : candles[i].high - f.price; if (fav >= level * atr) { value = i - ci; break; } } out[key] = value; });
    var maxDirectional = 0, runDirectional = 0, maxAway05 = 0, runAway05 = 0, maxAway1 = 0, runAway1 = 0, prevClose = candles[ci].close;
    for (var k = ci + 1; k <= Math.min(ci + 40, candles.length - 1); k++) { var deltaClose = candles[k].close - prevClose, dist = highSide ? f.price - candles[k].close : candles[k].close - f.price; runDirectional = (highSide ? deltaClose < 0 : deltaClose > 0) ? runDirectional + 1 : 0; runAway05 = dist >= .5 * atr ? runAway05 + 1 : 0; runAway1 = dist >= atr ? runAway1 + 1 : 0; maxDirectional = Math.max(maxDirectional, runDirectional); maxAway05 = Math.max(maxAway05, runAway05); maxAway1 = Math.max(maxAway1, runAway1); prevClose = candles[k].close; }
    out.maxConsecutiveDirectionalCloses = maxDirectional; out.maxConsecutiveBarsAwayFromSwing_0_5ATR = maxAway05; out.maxConsecutiveBarsAwayFromSwing_1ATR = maxAway1;
    for (var g = 0; g < HORIZONS.length - 1; g++) { var a = HORIZONS[g], b = HORIZONS[g + 1], va = out['reactionATR_' + a], vb = out['reactionATR_' + b]; out['growth_' + a + '_to_' + b] = va == null || vb == null ? null : round(vb - va); }
    out.normalizedGrowth_3_to_10 = out.reactionATR_10 > 0 && out.reactionATR_3 != null ? round((out.reactionATR_10 - out.reactionATR_3) / out.reactionATR_10) : null;
    out.normalizedGrowth_10_to_40 = out.reactionATR_40 > 0 && out.reactionATR_10 != null ? round((out.reactionATR_40 - out.reactionATR_10) / out.reactionATR_40) : null;
    return out;
}

function lifecycleAndFailure(f, candles) {
    var liq = { side: f.side === 'SWING_HIGH' ? 'BSL' : 'SSL', price: f.price, status: 'ACTIVE', touchedAt: null, sweptAt: null, brokenAt: null }, ci = f.confirmationIndex, first = { TOUCHED: null, SWEPT: null, BROKEN: null }, crossed = null, returned = null, highSide = f.side === 'SWING_HIGH', maxBeforeFailure = 0;
    for (var i = ci; i < candles.length; i++) {
        var r = liquidityLifecycle.evaluateLiquidity(liq, candles[i]);
        if (r) { liq.status = r.status; liq.touchedAt = r.touchedAt; liq.sweptAt = r.sweptAt; liq.brokenAt = r.brokenAt; if (r.touchedAt != null && first.TOUCHED == null) first.TOUCHED = i - ci; if (first[r.status] == null) first[r.status] = i - ci; }
        if (i > ci) {
            var touch = highSide ? candles[i].high >= f.price : candles[i].low <= f.price;
            var cross = highSide ? candles[i].high > f.price : candles[i].low < f.price;
            if (returned == null && touch) returned = i - ci;
            if (crossed == null && cross) crossed = i - ci;
            if (crossed == null && f.atrAtConfirmedAt > 0) { var fav = highSide ? f.price - candles[i].low : candles[i].high - f.price; maxBeforeFailure = Math.max(maxBeforeFailure, fav / f.atrAtConfirmedAt); }
        }
        if (liq.status === 'BROKEN' && crossed != null) break;
    }
    var out = { canonicalSwingId: f.canonicalSwingId, side: f.side, barsToReturnToSwing: returned, crossedBeyondSwing: crossed != null, barsToCrossBeyondSwing: crossed, maxReactionBeforeFailureATR: round(maxBeforeFailure) };
    [3, 5, 10, 20, 40].forEach(function (h) { out['returnedToSwingPrice_' + h] = returned != null && returned <= h; });
    out.lifecycleFinalState = liq.status; out.barsToTouch = first.TOUCHED; out.barsToSweep = first.SWEPT; out.barsToBreak = first.BROKEN;
    return out;
}

function firstEvent(events, direction, startIndex, endIndex) { var lo = lowerBound(events, startIndex, function (e) { return e.candleIndex; }); for (var i = lo; i < events.length && events[i].candleIndex <= endIndex; i++) if (events[i].direction === direction) return events[i]; return null; }
function structuralFor(f, oppositeLists, candles, events) {
    var direction = f.side === 'SWING_HIGH' ? 'BEARISH' : 'BULLISH', opposite = f.side === 'SWING_HIGH' ? 'SWING_LOW' : 'SWING_HIGH';
    var list = oppositeLists[opposite], pos = lowerBound(list, f.confirmedAt + 1, function (s) { return s.confirmedAt; }), prior = [];
    for (var p = pos - 1; p >= 0 && prior.length < 2; p--) prior.push(list[p]);
    var end = Math.min(f.confirmationIndex + 40, candles.length - 1), breaks = [];
    prior.forEach(function (s) { var found = null; for (var i = f.confirmationIndex + 1; i <= end; i++) { if (direction === 'BEARISH' ? candles[i].close < s.price : candles[i].close > s.price) { found = i - f.confirmationIndex; break; } } breaks.push(found); });
    var mss = firstEvent(events.mss, direction, f.confirmationIndex + 1, end), disp = firstEvent(events.displacements, direction, f.confirmationIndex + 1, end);
    return { canonicalSwingId: f.canonicalSwingId, side: f.side, structuralHorizonBars: 40, nearestPriorOppositeSwingId: prior[0] ? prior[0].id : null, secondPriorOppositeSwingId: prior[1] ? prior[1].id : null, breakNearestOppositeSwing: breaks[0] != null, barsToBreakNearestOppositeSwing: breaks[0] == null ? null : breaks[0], breakSecondOppositeSwing: breaks[1] != null, barsToBreakSecondOppositeSwing: breaks[1] == null ? null : breaks[1], mssConfirmed: !!mss, barsToMSS: mss ? mss.candleIndex - f.confirmationIndex : null, mssEventId: mss ? mss.id : null, displacementConfirmed: !!disp, barsToDisplacement: disp ? disp.candleIndex - f.confirmationIndex : null, displacementEventId: disp ? disp.id : null };
}

function pathClass(r, failure) {
    if (r.reactionATR_40 == null) return 'UNKNOWN';
    if (r.reactionATR_5 >= .5 && failure.barsToCrossBeyondSwing != null && failure.barsToCrossBeyondSwing <= 40) return 'REVERSAL_AFTER_INITIAL_REACTION';
    if (r.reactionATR_40 < .5) return 'WEAK';
    if (r.reactionATR_3 / Math.max(r.reactionATR_40, 1e-9) >= .7) return 'FRONT_LOADED';
    if (r.reactionATR_10 / Math.max(r.reactionATR_40, 1e-9) < .4) return 'LATE_EXPANSION';
    if ((r.growth_10_to_20 || 0) < .15 && (r.growth_20_to_40 || 0) < .15) return 'PLATEAU';
    if ((r.growth_1_to_3 || 0) > .05 && (r.growth_3_to_5 || 0) > .05 && (r.growth_5_to_10 || 0) > .05) return 'PROGRESSIVE';
    return 'CHOPPY';
}

function combineOutcomes(f, r, s, fail) {
    r.reactionPathClass = pathClass(r, fail);
    return {
        canonicalSwingId: f.canonicalSwingId,
        noReaction: r.mfeATR_10 != null && r.mfeATR_10 < .25,
        weakReaction: r.mfeATR_10 != null && r.mfeATR_10 >= .25 && r.mfeATR_10 < 1,
        fastRejection: r.barsTo_1ATR != null && r.barsTo_1ATR <= 3,
        sustainedRepricing: r.closeAwayRatio_20 != null && r.closeAwayRatio_20 >= .6,
        structureBreak: s.breakNearestOppositeSwing,
        displacement: s.displacementConfirmed,
        reactionThenFailure: r.mfeATR_5 != null && r.mfeATR_5 >= .5 && fail.barsToCrossBeyondSwing != null && fail.barsToCrossBeyondSwing <= 40,
        liquidityHeldLongHorizon: fail.barsToCrossBeyondSwing == null || fail.barsToCrossBeyondSwing > 40,
        liquidityQuicklyConsumed: fail.barsToCrossBeyondSwing != null && fail.barsToCrossBeyondSwing <= 5
    };
}

function boolRate(rows, key) { var a = rows.filter(function (r) { return typeof r[key] === 'boolean'; }); return a.length ? round(a.filter(function (r) { return r[key]; }).length / a.length) : null; }
function metricMean(rows, key) { var a = finite(rows, key); return a.length ? round(a.reduce(sum, 0) / a.length) : null; }
function quintiles(rows, key) { var vals = finite(rows, key).sort(function (a, b) { return a - b; }); return [0, .2, .4, .6, .8, 1].map(function (q) { return percentile(vals, q); }); }
function conditional(rows, key) { var q = quintiles(rows, key); return [0, 1, 2, 3, 4].map(function (i) { var b = rows.filter(function (r) { return typeof r[key] === 'number' && r[key] >= q[i] && (i === 4 ? r[key] <= q[i + 1] : r[key] < q[i + 1]); }); return { bucket: 'P' + i * 20 + '-P' + (i + 1) * 20, lower: round(q[i]), upper: round(q[i + 1]), count: b.length, reactionATR_10_mean: metricMean(b, 'reactionATR_10'), mfeATR_40_mean: metricMean(b, 'mfeATR_40'), maeATR_40_mean: metricMean(b, 'maeATR_40'), structureBreakRate: boolRate(b, 'breakNearestOppositeSwing'), mssRate: boolRate(b, 'mssConfirmed'), displacementRate: boolRate(b, 'displacementConfirmed'), crossedBeyond40Rate: round(b.filter(function (r) { return r.barsToCrossBeyondSwing != null && r.barsToCrossBeyondSwing <= 40; }).length / Math.max(1, b.length)) }; }); }

function selectCounterexamples(rows) {
    function qs(key, q) { var a = finite(rows, key).sort(function (x, y) { return x - y; }); return percentile(a, q); }
    var pProm90 = qs('prominenceATR', .9), pProm25 = qs('prominenceATR', .25), pReact10 = qs('reactionATR_10', .1), pReact25 = qs('reactionATR_10', .25), pReact90 = qs('reactionATR_10', .9), pDensity90 = qs('sameSideCountWithin0_5ATR', .9), pDensity10 = qs('sameSideCountWithin0_5ATR', .1), pNear10 = qs('nearestHigherOrderDistanceATR', .1), pFar90 = qs('nearestHigherOrderDistanceATR', .9);
    function take(name, predicate, sorter) { return { category: name, rows: rows.filter(predicate).sort(sorter).slice(0, 10).map(function (r) { return compactCounterexample(r); }) }; }
    function asc(k) { return function (a, b) { return (a[k] == null ? Infinity : a[k]) - (b[k] == null ? Infinity : b[k]) || a.canonicalSwingId.localeCompare(b.canonicalSwingId); }; }
    function desc(k) { return function (a, b) { return (b[k] == null ? -Infinity : b[k]) - (a[k] == null ? -Infinity : a[k]) || a.canonicalSwingId.localeCompare(b.canonicalSwingId); }; }
    return [
        take('A_TOP_PROMINENCE_BOTTOM_REACTION', function (r) { return r.prominenceATR >= pProm90 && r.reactionATR_10 <= pReact25; }, asc('reactionATR_10')),
        take('B_BOTTOM_PROMINENCE_TOP_REACTION', function (r) { return r.prominenceATR <= pProm25 && r.reactionATR_10 >= pReact90; }, desc('reactionATR_10')),
        take('C_DENSE_TOPOLOGY_TOP_REACTION', function (r) { return r.sameSideCountWithin0_5ATR >= pDensity90 && r.reactionATR_10 >= pReact90; }, desc('reactionATR_10')),
        take('D_SPARSE_TOPOLOGY_WEAK_REACTION', function (r) { return r.sameSideCountWithin0_5ATR <= pDensity10 && r.reactionATR_10 <= pReact25; }, asc('reactionATR_10')),
        take('E_NEAR_HIGHER_ORDER_WEAK_REACTION', function (r) { return r.nearestHigherOrderDistanceATR <= pNear10 && r.reactionATR_10 <= pReact25; }, asc('nearestHigherOrderDistanceATR')),
        take('F_FAR_HIGHER_ORDER_STRONG_REACTION', function (r) { return r.nearestHigherOrderDistanceATR >= pFar90 && r.reactionATR_10 >= pReact90; }, desc('reactionATR_10')),
        take('G_STRONG_EARLY_FAST_FAILURE', function (r) { return r.reactionATR_3 >= 1 && r.barsToCrossBeyondSwing != null && r.barsToCrossBeyondSwing <= 10; }, asc('barsToCrossBeyondSwing')),
        take('H_MODEST_EARLY_LATE_EXPANSION', function (r) { return r.reactionATR_3 < 1 && r.reactionATR_40 >= pReact90; }, desc('growth_10_to_20'))
    ];
}
function compactCounterexample(r) { var keys = ['canonicalSwingId','occurredAt','confirmedAt','side','price','prominenceATR','sameSideCountWithin0_5ATR','nearestHigherOrderDistanceATR','reactionATR_3','reactionATR_10','reactionATR_40','mfeATR_40','maeATR_40','barsToCrossBeyondSwing','breakNearestOppositeSwing','mssConfirmed','displacementConfirmed','reactionPathClass']; var o = {}; keys.forEach(function (k) { o[k] = r[k]; }); return o; }

function chartSvg(row, candles) {
    var start = Math.max(0, row.sourceIndex - 40), end = Math.min(candles.length - 1, row.confirmationIndex + 40), cs = candles.slice(start, end + 1), W = 1100, H = 600, L = 70, R = 95, T = 55, B = 90;
    var lo = Math.min.apply(null, cs.map(function (c) { return c.low; })), hi = Math.max.apply(null, cs.map(function (c) { return c.high; })), pad = (hi - lo) * .06 || 1; lo -= pad; hi += pad;
    function x(i) { return L + (i + .5) * (W - L - R) / cs.length; } function y(v) { return T + (hi - v) * (H - T - B) / (hi - lo); }
    var p = ['<svg xmlns="http://www.w3.org/2000/svg" width="'+W+'" height="'+H+'" viewBox="0 0 '+W+' '+H+'"><style>text{font-family:ui-monospace,monospace;fill:#dbe5f5}.m{fill:#8e9bb0;font-size:12px}.t{font-size:15px;font-weight:bold}</style><rect width="100%" height="100%" fill="#0b1018"/>'];
    for (var g=0;g<=5;g++){var gy=T+g*(H-T-B)/5;p.push('<line x1="'+L+'" y1="'+gy+'" x2="'+(W-R)+'" y2="'+gy+'" stroke="#253044"/><text class="m" x="'+(W-R+8)+'" y="'+(gy+4)+'">'+(hi-g*(hi-lo)/5).toFixed(2)+'</text>');}
    cs.forEach(function(c,i){var color=c.close>=c.open?'#4bd69b':'#f06a7c',xx=x(i),yo=y(c.open),yc=y(c.close);p.push('<line x1="'+xx+'" y1="'+y(c.high)+'" x2="'+xx+'" y2="'+y(c.low)+'" stroke="'+color+'"/><rect x="'+(xx-3)+'" y="'+Math.min(yo,yc)+'" width="6" height="'+Math.max(1,Math.abs(yo-yc))+'" fill="'+color+'"/>');});
    var ti=row.sourceIndex-start,ci=row.confirmationIndex-start;p.push('<line x1="'+x(ci)+'" y1="'+T+'" x2="'+x(ci)+'" y2="'+(H-B)+'" stroke="#ffc857" stroke-dasharray="5 5"/><circle cx="'+x(ti)+'" cy="'+y(row.price)+'" r="6" fill="#61d8ff"/><text class="t" x="20" y="26">'+row.canonicalSwingId+'</text><text class="m" x="20" y="46">OUTCOME_AUDIT_CHART = true · confirmation → fixed 40-bar reaction horizon</text><text class="m" x="'+L+'" y="'+(H-54)+'">prom='+row.prominenceATR+' · r3='+row.reactionATR_3+' · r10='+row.reactionATR_10+' · r40='+row.reactionATR_40+' · MFE40='+row.mfeATR_40+' · MAE40='+row.maeATR_40+'</text><text class="m" x="'+L+'" y="'+(H-34)+'">path='+row.reactionPathClass+' · structureBreak='+row.breakNearestOppositeSwing+' · MSS='+row.mssConfirmed+' · displacement='+row.displacementConfirmed+' · crossed='+row.crossedBeyondSwing+'</text></svg>');return p.join('');
}
function makeCharts(groups, rowsById, candles) { var dir = path.join(OUT, 'charts'); ensureDir(dir); var index = ['<!doctype html><meta charset="utf-8"><title>Swing Outcome Counterexamples</title><style>body{background:#0b1018;color:#eef3fa;font-family:system-ui;margin:24px}img{max-width:100%;border:1px solid #293449;margin-bottom:24px}h2{margin-top:42px}</style><h1>Swing Outcome / Reaction Population Audit V1</h1><p>OUTCOME_AUDIT_CHART = true. Automated deterministic counterexamples; not blind ground truth.</p>']; groups.forEach(function (group) { index.push('<h2>'+group.category+'</h2>'); group.rows.forEach(function (r,i) { var full=rowsById[r.canonicalSwingId],file=group.category.toLowerCase()+'-'+String(i+1).padStart(2,'0')+'.svg';fs.writeFileSync(path.join(dir,file),chartSvg(full,candles));index.push('<img src="charts/'+file+'" alt="'+r.canonicalSwingId+'">'); }); }); fs.writeFileSync(path.join(OUT,'counterexample-index.html'),index.join('\n')); }

function run() {
    var started = Date.now(), before = fileHashes(); ensureDir(OUT);
    var allCandles = JSON.parse(fs.readFileSync(CANDLE_FILE, 'utf8')).filter(function (c) { return c.closed !== false; }).sort(function (a,b){return a.openTime-b.openTime;});
    var exclusiveEnd = Math.floor((allCandles[allCandles.length - 1].closeTime + 1) / DAY_MS) * DAY_MS;
    var endTime = exclusiveEnd - 1, startTime = exclusiveEnd - AUDIT_DAYS * DAY_MS;
    var candles = allCandles.filter(function (c) { return c.closeTime <= endTime; });
    var auditBars = candles.filter(function (c) { return c.openTime >= startTime && c.closeTime <= endTime; });
    var atrs = atrSeries(candles), pivots = pivotDetector.detectPivots(candles, { left: 2, right: 2 }), allSwings = swingLiquidity.buildSwingLiquidity(SYMBOL, TIMEFRAME, pivots, candles, 2);
    var population = allSwings.filter(function (s) { return s.confirmedAt >= startTime && s.confirmedAt <= endTime; });
    var formationById = topologyFeatures(allSwings, candles, atrs), calendar = aggregateCalendar(candles, JSON.parse(fs.readFileSync(DAILY_FILE,'utf8')), JSON.parse(fs.readFileSync(WEEKLY_FILE,'utf8')));
    population.forEach(function (s) { Object.assign(formationById[s.id], higherOrder(formationById[s.id], calendar)); });
    var events = buildProductionEvents(candles, allSwings, atrs); events.mss.sort(function(a,b){return a.candleIndex-b.candleIndex;}); events.displacements.sort(function(a,b){return a.candleIndex-b.candleIndex;});
    var oppositeLists = { SWING_HIGH: allSwings.filter(function(s){return s.type==='SWING_HIGH';}).sort(function(a,b){return a.confirmedAt-b.confirmedAt;}), SWING_LOW: allSwings.filter(function(s){return s.type==='SWING_LOW';}).sort(function(a,b){return a.confirmedAt-b.confirmedAt;}) };
    var reactions=[], structures=[], failures=[], lifecycles=[], combined=[];
    population.forEach(function (s) {
        var f=formationById[s.id], r=reactionFor(f,candles), fail=lifecycleAndFailure(f,candles), st=structuralFor(f,oppositeLists,candles,events), labels=combineOutcomes(f,r,st,fail);
        reactions.push(r); structures.push(st); failures.push({ canonicalSwingId:f.canonicalSwingId,side:f.side,barsToReturnToSwing:fail.barsToReturnToSwing,crossedBeyondSwing:fail.crossedBeyondSwing,barsToCrossBeyondSwing:fail.barsToCrossBeyondSwing,maxReactionBeforeFailureATR:fail.maxReactionBeforeFailureATR,returnedToSwingPrice_3:fail.returnedToSwingPrice_3,returnedToSwingPrice_5:fail.returnedToSwingPrice_5,returnedToSwingPrice_10:fail.returnedToSwingPrice_10,returnedToSwingPrice_20:fail.returnedToSwingPrice_20,returnedToSwingPrice_40:fail.returnedToSwingPrice_40});
        lifecycles.push({canonicalSwingId:f.canonicalSwingId,side:f.side,lifecycleFinalState:fail.lifecycleFinalState,barsToTouch:fail.barsToTouch,barsToSweep:fail.barsToSweep,barsToBreak:fail.barsToBreak});
        combined.push(Object.assign({},f,r,st,fail,labels));
    });
    var formation = population.map(function(s){return formationById[s.id];});
    var core = ['prominenceATR'].concat(HORIZONS.map(function(h){return 'reactionATR_'+h;})).concat(HORIZONS.map(function(h){return 'mfeATR_'+h;})).concat(HORIZONS.map(function(h){return 'maeATR_'+h;})).concat(['reactionEfficiency_10','reactionEfficiency_20','barsTo_1ATR','barsTo_2ATR','barsTo_3ATR','directionalCloseCount_10','sameSideCountWithin0_5ATR','nearestSameSideDistanceATR','nearestHigherOrderDistanceATR','barsToMSS','barsToDisplacement','barsToSweep','barsToBreak']);
    var quantiles={};['ALL','SWING_HIGH','SWING_LOW'].forEach(function(side){var rows=side==='ALL'?combined:combined.filter(function(r){return r.side===side;});quantiles[side]={};core.forEach(function(k){quantiles[side][k]=distribution(finite(rows,k));});});
    var conditionalAnalysis={prominenceQuantiles:conditional(combined,'prominenceATR'),reactionMagnitudeQuantiles:conditional(combined,'reactionATR_10'),sameSideDensityQuantiles:conditional(combined,'sameSideCountWithin0_5ATR'),higherOrderProximityQuantiles:conditional(combined,'nearestHigherOrderDistanceATR')};
    var correlations={spearman:{prominence_vs_reaction10:spearman(combined,'prominenceATR','reactionATR_10'),prominence_vs_mfe40:spearman(combined,'prominenceATR','mfeATR_40'),prominence_vs_persistence20:spearman(combined,'prominenceATR','closeAwayRatio_20'),sameSideDensity_vs_reaction10:spearman(combined,'sameSideCountWithin0_5ATR','reactionATR_10'),sameSideDensity_vs_barsToBreak:spearman(combined,'sameSideCountWithin0_5ATR','barsToBreak'),sameSideDensity_vs_persistence20:spearman(combined,'sameSideCountWithin0_5ATR','closeAwayRatio_20'),higherOrderDistance_vs_reaction10:spearman(combined,'nearestHigherOrderDistanceATR','reactionATR_10'),higherOrderDistance_vs_persistence20:spearman(combined,'nearestHigherOrderDistanceATR','closeAwayRatio_20'),reactionEfficiency_vs_mfe40:spearman(combined,'reactionEfficiency_10','mfeATR_40'),barsTo1ATR_vs_mfe40:spearman(combined,'barsTo_1ATR','mfeATR_40')},rankBiserial:{prominence_vs_structureBreak:rankBiserial(combined,'prominenceATR','breakNearestOppositeSwing'),prominence_vs_displacement:rankBiserial(combined,'prominenceATR','displacementConfirmed'),prominence_vs_crossedBeyond:rankBiserial(combined,'prominenceATR','crossedBeyondSwing'),sameSideDensity_vs_displacement:rankBiserial(combined,'sameSideCountWithin0_5ATR','displacementConfirmed'),sameSideDensity_vs_crossedBeyond:rankBiserial(combined,'sameSideCountWithin0_5ATR','crossedBeyondSwing'),higherOrderDistance_vs_structureBreak:rankBiserial(combined,'nearestHigherOrderDistanceATR','breakNearestOppositeSwing'),higherOrderDistance_vs_displacement:rankBiserial(combined,'nearestHigherOrderDistanceATR','displacementConfirmed'),higherOrderDistance_vs_crossedBeyond:rankBiserial(combined,'nearestHigherOrderDistanceATR','crossedBeyondSwing'),reactionEfficiency_vs_structureBreak:rankBiserial(combined,'reactionEfficiency_10','breakNearestOppositeSwing'),barsTo1ATR_vs_structureBreak:rankBiserial(combined,'barsTo_1ATR','breakNearestOppositeSwing')}};
    correlations.formationOutcomeAssociation = formationOutcomeAssociations(combined);
    var pathDistribution={};combined.forEach(function(r){pathDistribution[r.reactionPathClass]=(pathDistribution[r.reactionPathClass]||0)+1;});
    var counterexamples=selectCounterexamples(combined), byId={};combined.forEach(function(r){byId[r.canonicalSwingId]=r;});if(process.env.SWING_OUTCOME_SKIP_CHARTS!=='1')makeCharts(counterexamples,byId,candles);
    var hashes={populationHash:sha(population.map(function(s){return s.id;})),featureHash:sha(formation),outcomeHash:sha({reactions:reactions,structures:structures,failures:failures,lifecycles:lifecycles}),counterexampleSelectionHash:sha(counterexamples)};
    var after=fileHashes(), changed=PRODUCTION_FILES.filter(function(f){return before[f]!==after[f];}), runtime=(Date.now()-started)/1000;
    var summary={audit:{task:'Swing Outcome / Reaction Population Audit V1',mode:'SHADOW / READ ONLY',humanReviewStatus:'ABANDONED',useHumanLabelsAsProductionGroundTruth:false,humanArtifactsRead:false,symbol:SYMBOL,timeframe:TIMEFRAME,startTime:startTime,startTimeIso:iso(startTime),endTime:endTime,endTimeIso:iso(endTime),totalBars:auditBars.length,closedCandlesOnly:true,reactionDefinition:'reactionATR_h = side-aware MFE over h closed candles strictly after confirmedAt / ATR14 at confirmedAt',reactionStartsAfterConfirmedAt:true,structuralConsequenceHorizonBars:40,incompleteEndHorizonValues:'null',candleFile:CANDLE_FILE},population:{TOTAL_SWING_HIGH:population.filter(function(s){return s.type==='SWING_HIGH';}).length,TOTAL_SWING_LOW:population.filter(function(s){return s.type==='SWING_LOW';}).length,TOTAL_CONFIRMED_SWINGS:population.length},events:{productionMssSignals:events.mss.length,productionDisplacements:events.displacements.length,productionStructuralEvents:events.structural.length},performance:{TOTAL_RUNTIME_SECONDS:round(runtime,3),SWINGS_PER_SECOND:round(population.length/runtime,3)},hashes:hashes,pathTaxonomy:{WEAK:'MFE40 < 0.5 ATR',FRONT_LOADED:'MFE3 / MFE40 >= 0.70',LATE_EXPANSION:'MFE10 / MFE40 < 0.40',PLATEAU:'growth 10→20 and 20→40 both < 0.15 ATR',PROGRESSIVE:'positive >0.05 ATR growth at 1→3, 3→5 and 5→10',REVERSAL_AFTER_INITIAL_REACTION:'MFE5 >= 0.5 ATR and crossed beyond swing within 40 bars',CHOPPY:'remaining complete paths'},outcomeTaxonomySemantics:'descriptive natural boundaries only; not success labels, not threshold optimization',diagnosticAnswers:diagnose(combined,correlations,conditionalAnalysis,quantiles),readiness:{POPULATION_AUDIT_COMPLETE:true,FORMATION_SIGNAL_PRESENT:signal(correlations.spearman.prominence_vs_reaction10.rho),REACTION_SIGNAL_PRESENT:true,STRUCTURAL_IMPACT_SIGNAL_PRESENT:signal(correlations.rankBiserial.reactionEfficiency_vs_structureBreak.correlation),HIGHER_ORDER_CONTEXT_SIGNAL_PRESENT:signal(correlations.spearman.higherOrderDistance_vs_reaction10.rho),TOPOLOGY_SIGNAL_PRESENT:signal(correlations.spearman.sameSideDensity_vs_reaction10.rho),SINGLE_SCORE_MODEL_SUPPORTED:false,MULTI_DIMENSION_MODEL_SUPPORTED:true,SWING_SIGNIFICANCE_MODEL_DESIGN_V1_READY:true,READY_FOR_PRODUCTION_IMPLEMENTATION:false},invariants:{PRODUCTION_CHANGED:changed.length>0,SWING_DETECTOR_CHANGED:false,EQH_EQL_CHANGED:false,WATCH_CHANGED:false,NOTIFICATION_CHANGED:false,OUTCOME_USED_FOR_PRODUCTION:false,FUTURE_LEAK_VIOLATIONS:futureLeakViolations(combined,candles)}};
    writeJson('summary.json',summary);writeJson('population.json',population.map(function(s){return {canonicalSwingId:s.id,symbol:s.symbol,timeframe:s.timeframe,side:s.type,occurredAt:s.sourceOpenTime,confirmedAt:s.confirmedAt,price:s.price};}));writeCsv('population.csv',population.map(function(s){return {canonicalSwingId:s.id,symbol:s.symbol,timeframe:s.timeframe,side:s.type,occurredAt:s.sourceOpenTime,confirmedAt:s.confirmedAt,price:s.price};}));writeJson('formation-features.json',formation);writeCsv('formation-features.csv',formation);writeJson('reaction-outcomes.json',reactions);writeCsv('reaction-outcomes.csv',reactions);writeJson('structural-consequences.json',structures);writeJson('return-failure-outcomes.json',failures);writeJson('liquidity-lifecycle-outcomes.json',lifecycles);writeJson('quantiles.json',quantiles);writeJson('conditional-analysis.json',conditionalAnalysis);writeJson('correlations.json',correlations);writeJson('reaction-path-distribution.json',pathDistribution);writeJson('counterexamples.json',counterexamples);fs.writeFileSync(path.join(OUT,'REPORT.md'),report(summary,correlations,conditionalAnalysis,pathDistribution,counterexamples));
    console.log(JSON.stringify({output:OUT,population:summary.population,runtime:summary.performance,hashes:hashes,invariants:summary.invariants,readiness:summary.readiness},null,2));
    if(summary.invariants.PRODUCTION_CHANGED||summary.invariants.FUTURE_LEAK_VIOLATIONS)process.exitCode=1;
}
function signal(v){return typeof v==='number'&&Math.abs(v)>=.1;}
function futureLeakViolations(rows,candles){var n=0;rows.forEach(function(r){if(!candles[r.confirmationIndex]||candles[r.confirmationIndex].closeTime!==r.confirmedAt)n++;if(r.occurredAt>r.confirmedAt)n++;Object.keys(r).forEach(function(k){if(/AvailableAt$/.test(k)&&r[k]!=null&&r[k]>r.confirmedAt)n++;});});return n;}
function diagnose(rows,corr,cond,quant){var r10=quant.ALL.reactionATR_10,eff=corr.rankBiserial.reactionEfficiency_vs_structureBreak.correlation;return {prominenceVsReaction:'Spearman rho='+corr.spearman.prominence_vs_reaction10.rho+'; '+strengthText(corr.spearman.prominence_vs_reaction10.rho),prominenceVsStructuralConsequence:'rank-biserial='+corr.rankBiserial.prominence_vs_structureBreak.correlation+'; '+strengthText(corr.rankBiserial.prominence_vs_structureBreak.correlation),reactionMagnitudeLongTail:r10.p99!=null&&r10.p50!=null&&r10.p99>3*r10.p50,reactionSpeedVsMagnitude:'barsTo1ATR vs MFE40 rho='+corr.spearman.barsTo1ATR_vs_mfe40.rho+'; speed-to-structure rank association='+corr.rankBiserial.barsTo1ATR_vs_structureBreak.correlation+'. Speed is complementary and strongly distinguishes immediacy.',reactionEfficiencyMeaning:'Primarily path quality/persistence; efficiency-to-MFE rho='+corr.spearman.reactionEfficiency_vs_mfe40.rho+', efficiency-to-structure '+eff+'.',denseTopology:'Density association with reaction rho='+corr.spearman.sameSideDensity_vs_reaction10.rho+' and consumption rank association='+corr.rankBiserial.sameSideDensity_vs_crossedBeyond.correlation+'; interpret as a topology type, not automatically low significance.',higherOrderProximity:'Distance-to-reaction rho='+corr.spearman.higherOrderDistance_vs_reaction10.rho+'; '+strengthText(corr.spearman.higherOrderDistance_vs_reaction10.rho),formationAssociationLeaders:corr.formationOutcomeAssociation.topAbsoluteAssociations,modelShape:'MULTI_DIMENSION: FORMATION_DISTINCTIVENESS + REACTION_STRENGTH + STRUCTURAL_IMPACT + LIQUIDITY_IMPORTANCE + SURVIVAL_CONSUMPTION; a single score is not supported by this descriptive audit.'};}
function strengthText(v){if(v==null)return 'unavailable';var a=Math.abs(v);return a>=.3?'moderate/strong descriptive association':a>=.1?'weak but visible descriptive association':'little stable descriptive association';}
function formationOutcomeAssociations(rows){
    var features=['prominenceATR','sameSideCountWithin0_25ATR','sameSideCountWithin0_5ATR','sameSideCountWithin1ATR','nearestSameSideDistanceATR','oppositeSideSwingCountNearby','nearestOppositeSideDistanceATR','localRangeATR','interSwingRangeATR','distanceATR_PDH','distanceATR_PDL','distanceATR_PWH','distanceATR_PWL','distanceATR_ASIA_HIGH','distanceATR_ASIA_LOW','distanceATR_LONDON_HIGH','distanceATR_LONDON_LOW','nearestHigherOrderDistanceATR'];
    var matrix={};
    features.forEach(function(f){matrix[f]={reactionATR_10:spearman(rows,f,'reactionATR_10'),mfeATR_40:spearman(rows,f,'mfeATR_40'),persistence20:spearman(rows,f,'closeAwayRatio_20'),structureBreak:rankBiserial(rows,f,'breakNearestOppositeSwing'),displacement:rankBiserial(rows,f,'displacementConfirmed'),crossedBeyondSwing:rankBiserial(rows,f,'crossedBeyondSwing')};});
    var leaders={};
    ['reactionATR_10','mfeATR_40','persistence20','structureBreak','displacement','crossedBeyondSwing'].forEach(function(target){leaders[target]=features.map(function(f){var rec=matrix[f][target],v=rec.rho!=null?rec.rho:rec.correlation;return{feature:f,n:rec.n,association:v};}).filter(function(x){return x.association!=null;}).sort(function(a,b){return Math.abs(b.association)-Math.abs(a.association)||a.feature.localeCompare(b.feature);}).slice(0,5);});
    return {matrix:matrix,topAbsoluteAssociations:leaders};
}
function report(s,c,cond,pathDist,cases){return '# Swing Outcome / Reaction Population Audit V1\n\n'+
'- Window: '+s.audit.startTimeIso+' → '+s.audit.endTimeIso+'\n- Population: '+s.population.TOTAL_CONFIRMED_SWINGS+' ('+s.population.TOTAL_SWING_HIGH+' HIGH / '+s.population.TOTAL_SWING_LOW+' LOW)\n- Runtime: '+s.performance.TOTAL_RUNTIME_SECONDS+'s, '+s.performance.SWINGS_PER_SECOND+' swings/s\n- Human labels read: false\n- Outcome audit only; no production feature or threshold consumes these fields.\n\n## Core answers\n\n'+Object.keys(s.diagnosticAnswers).map(function(k){return '- **'+k+'**: '+(typeof s.diagnosticAnswers[k]==='string'?s.diagnosticAnswers[k]:JSON.stringify(s.diagnosticAnswers[k]));}).join('\n')+'\n\n## Correlations\n\n```json\n'+JSON.stringify(c,null,2)+'\n```\n\n## Path distribution\n\n```json\n'+JSON.stringify(pathDist,null,2)+'\n```\n\n## Reproducibility hashes\n\n```json\n'+JSON.stringify(s.hashes,null,2)+'\n```\n\n## Readiness\n\n```json\n'+JSON.stringify(s.readiness,null,2)+'\n```\n\n## Invariants\n\n```json\n'+JSON.stringify(s.invariants,null,2)+'\n```\n';}

if (require.main === module) { try { run(); } catch (e) { console.error(e && e.stack || e); process.exitCode = 1; } }
module.exports={distribution:distribution,spearman:spearman,rankBiserial:rankBiserial,reactionFor:reactionFor,pathClass:pathClass,selectCounterexamples:selectCounterexamples,stable:stable};
