/** Read-only BTCUSDT 30d audit of production produced-frontier replacement semantics. */
'use strict';
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var pivot = require('../structure/pivotDetector');
var structural = require('../structure/structuralProvenance5m');

var ROOT = path.join(__dirname, '..');
var OUT = process.argv[2] || '.audit-produced-frontier-replacement-v1';
var SYMBOL = 'BTCUSDT';
var BAR = 300000;
var DAY = 86400000;
var END = 1787416799999;
var START = END - 30 * DAY + 1;
var ENGINE_START = START - 30 * DAY;
var PRODUCTION_FILES = [
    'structure/structuralProvenance5m.js', 'structure/pivotDetector.js',
    'replay/replayState.js', 'replay/replayEngine.js', 'live/liveEngine.js',
    'config/thresholds.js', 'stats/opportunityQuality.js'
];

function iso(t) { return t == null ? null : new Date(t).toISOString(); }
function inWindow(t) { return t >= START && t <= END; }
function hashes() {
    var out = {};
    PRODUCTION_FILES.forEach(function (f) {
        out[f] = crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, f))).digest('hex');
    });
    return out;
}
function load5m() {
    var dir = path.join(ROOT, 'data-cache');
    var byOpen = {};
    fs.readdirSync(dir).filter(function (f) {
        return f.indexOf(SYMBOL + '_5m_') === 0 && /\.json$/.test(f);
    }).forEach(function (f) {
        var rows;
        try { rows = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { return; }
        (rows || []).forEach(function (c) {
            if (c && c.source === 'futures' && c.closed !== false &&
                c.openTime >= ENGINE_START && c.closeTime <= END) byOpen[c.openTime] = c;
        });
    });
    return Object.keys(byOpen).map(function (k) { return byOpen[k]; })
        .sort(function (a, b) { return a.openTime - b.openTime; });
}
function makeSwing(candles, side, pivotIndex, confirmIndex) {
    return {
        id: SYMBOL + ':5m:SWING_' + side + ':' + candles[pivotIndex].openTime,
        symbol: SYMBOL, timeframe: '5m', type: 'SWING_' + side,
        price: side === 'HIGH' ? candles[pivotIndex].high : candles[pivotIndex].low,
        sourceOpenTime: candles[pivotIndex].openTime,
        confirmedAt: candles[confirmIndex].closeTime,
        metadata: { index: pivotIndex }
    };
}
function intersect(a, b) {
    return (a || []).filter(function (x) { return (b || []).indexOf(x) >= 0; });
}
function seededSample(list, max, seed) {
    var x = seed >>> 0;
    var copy = list.slice();
    function rnd() { x = (x * 1664525 + 1013904223) >>> 0; return x / 4294967296; }
    for (var i = copy.length - 1; i > 0; i--) {
        var j = Math.floor(rnd() * (i + 1));
        var t = copy[i]; copy[i] = copy[j]; copy[j] = t;
    }
    return copy.slice(0, max);
}
function render(r) {
    return [
        '# Produced Frontier Replacement Audit V1', '',
        'BTCUSDT fixed 30d closed-candle replay: `' + r.audit.startIso + '` → `' + r.audit.endIso + '`.', '',
        '## Production definition', '',
        'A newly confirmed pivot is eligible for the pending produced frontier when it has the pending side, occurred no earlier than the lineage break candle, and remains beyond the lineage parent (`HIGH > parentPrice`, `LOW < parentPrice`). Among eligible pivots, the later `occurredAt` replaces the current frontier. Production does not require the replacement to extend beyond the current frontier price.', '',
        '## Counts', '',
        '- all LOW frontier replacements: ' + r.counts.lowReplacements,
        '- LOW replaced by higher LOW: ' + r.counts.lowHigherLowReplacements,
        '- all HIGH frontier replacements: ' + r.counts.highReplacements,
        '- HIGH replaced by lower HIGH: ' + r.counts.highLowerHighReplacements,
        '- unresolved replacement pairs: ' + r.counts.unresolvedPairs, '',
        '`PRODUCTION_CHANGED = ' + r.invariants.PRODUCTION_CHANGED + '`  ',
        '`FUTURE_LEAK_VIOLATIONS = ' + r.invariants.FUTURE_LEAK_VIOLATIONS + '`', ''
    ].join('\n');
}

function run() {
    var before = hashes();
    var candles = load5m();
    var state = structural.createState({ symbol: SYMBOL, timeframe: '5m' });
    candles.forEach(function (c, i) {
        var confirmed = [];
        var p = i - 2;
        if (p >= 2) {
            if (pivot.detectPivotHigh(candles, p, 2, 2)) confirmed.push(makeSwing(candles, 'HIGH', p, i));
            if (pivot.detectPivotLow(candles, p, 2, 2)) confirmed.push(makeSwing(candles, 'LOW', p, i));
        }
        structural.step(state, c, i, confirmed);
    });

    var eventById = {};
    state.events.forEach(function (e) { eventById[e.id] = e; });
    var promotedAt = {};
    state.swings.forEach(function (s) {
        (s.history || []).forEach(function (h) {
            if (h.role === 'CONTROLLING_SWING' && h.reason === 'PRODUCED_BY_STRUCTURAL_BREAK') {
                if (!promotedAt[h.confirmedAt]) promotedAt[h.confirmedAt] = [];
                promotedAt[h.confirmedAt].push(s);
            }
        });
    });
    var records = [];
    var unresolved = [];
    state.swings.forEach(function (old) {
        (old.history || []).forEach(function (h) {
            if (h.role !== 'INTERNAL' || h.reason !== 'PRODUCED_LEVEL_REPLACED_BEFORE_BREAK' || !inWindow(h.confirmedAt)) return;
            var candidates = (promotedAt[h.confirmedAt] || []).filter(function (s) {
                return s.side === old.side && s.id !== old.id && intersect(old.producedCandidateFor, s.producedCandidateFor).length > 0;
            }).sort(function (a, b) { return b.occurredAt - a.occurredAt; });
            var replacement = candidates[0] || null;
            if (!replacement) {
                unresolved.push({ oldId: old.id, transitionTime: h.confirmedAt });
                return;
            }
            var lineageIds = intersect(old.producedCandidateFor, replacement.producedCandidateFor);
            var lineage = lineageIds.map(function (id) { return eventById[id]; }).filter(Boolean)
                .sort(function (a, b) { return b.confirmedAt - a.confirmedAt; })[0] || null;
            var parentPrice = lineage ? lineage.referenceLevel : null;
            var nonExtending = old.side === 'LOW'
                ? replacement.price > old.price
                : replacement.price < old.price;
            records.push({
                side: old.side,
                replacementTime: h.confirmedAt,
                replacementTimeIso: iso(h.confirmedAt),
                oldFrontier: { id: old.id, price: old.price, occurredAt: old.occurredAt,
                    occurredAtIso: iso(old.occurredAt), confirmedAt: old.confirmedAt, confirmedAtIso: iso(old.confirmedAt) },
                newFrontier: { id: replacement.id, price: replacement.price, occurredAt: replacement.occurredAt,
                    occurredAtIso: iso(replacement.occurredAt), confirmedAt: replacement.confirmedAt,
                    confirmedAtIso: iso(replacement.confirmedAt) },
                lineageEventId: lineage && lineage.id,
                lineageDirection: lineage && lineage.direction,
                lineageParentPrice: parentPrice,
                oldBeyondParent: parentPrice == null ? null : (old.side === 'LOW' ? old.price < parentPrice : old.price > parentPrice),
                newBeyondParent: parentPrice == null ? null : (old.side === 'LOW' ? replacement.price < parentPrice : replacement.price > parentPrice),
                priceDeltaNewMinusOld: replacement.price - old.price,
                nonExtendingReplacement: nonExtending,
                replacementRuleObserved: 'LATER_OCCURRED_CONFIRMED_PIVOT_WITHIN_SAME_PENDING_LINEAGE'
            });
        });
    });
    records.sort(function (a, b) { return a.replacementTime - b.replacementTime; });
    var low = records.filter(function (r) { return r.side === 'LOW'; });
    var high = records.filter(function (r) { return r.side === 'HIGH'; });
    var lowHigher = low.filter(function (r) { return r.nonExtendingReplacement; });
    var highLower = high.filter(function (r) { return r.nonExtendingReplacement; });
    var nonExtending = lowHigher.concat(highLower).sort(function (a, b) { return a.replacementTime - b.replacementTime; });
    var future = records.filter(function (r) {
        return r.oldFrontier.confirmedAt > r.replacementTime || r.newFrontier.confirmedAt > r.replacementTime ||
            r.newFrontier.occurredAt >= r.replacementTime;
    });
    var after = hashes();
    var result = {
        audit: { version: 'Produced Frontier Replacement Audit V1', symbol: SYMBOL, days: 30,
            startTime: START, endTime: END, startIso: iso(START), endIso: iso(END),
            closedCandlesOnly: true, replay: 'production structuralProvenance5m.step + production 2L/2R pivot detector' },
        formalDefinition: {
            eligibility: 'same side; confirmedAt <= evaluationTime; occurredAt >= lineage break candle; HIGH > lineage parent or LOW < lineage parent',
            replacement: 'new occurredAt > current occurredAt (confirmed pivots are processed at new.confirmedAt)',
            currentFrontierPriceExtensionRequired: false,
            lineageRequired: true
        },
        counts: { lowReplacements: low.length, lowHigherLowReplacements: lowHigher.length,
            highReplacements: high.length, highLowerHighReplacements: highLower.length,
            totalNonExtendingReplacements: nonExtending.length, unresolvedPairs: unresolved.length },
        hr02: records.filter(function (r) {
            return r.oldFrontier.price === 63318.1 && r.newFrontier.price === 63414.4;
        })[0] || null,
        allReplacementRecords: records,
        nonExtendingReplacementRecords: nonExtending,
        randomSamples: seededSample(nonExtending, 10, 0x46524f4e),
        unresolvedPairs: unresolved,
        invariants: { PRODUCTION_CHANGED: JSON.stringify(before) !== JSON.stringify(after),
            FUTURE_LEAK_VIOLATIONS: future.length },
        futureLeakDetails: future,
        productionHashesBefore: before,
        productionHashesAfter: after
    };
    fs.mkdirSync(path.join(ROOT, OUT), { recursive: true });
    fs.writeFileSync(path.join(ROOT, OUT, 'produced-frontier-replacement-audit.json'), JSON.stringify(result, null, 2));
    fs.writeFileSync(path.join(ROOT, OUT, 'non-extending-replacement-samples.json'), JSON.stringify(result.randomSamples, null, 2));
    fs.writeFileSync(path.join(ROOT, OUT, 'PRODUCED_FRONTIER_REPLACEMENT_REPORT.md'), render(result));
    console.log(JSON.stringify({ counts: result.counts, hr02: result.hr02,
        samples: result.randomSamples, invariants: result.invariants }, null, 2));
    return result;
}

if (require.main === module) run();
module.exports = { run: run };
