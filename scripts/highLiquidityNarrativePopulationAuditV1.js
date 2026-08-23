#!/usr/bin/env node
'use strict';

/**
 * HIGH Liquidity Narrative Population Audit V1
 *
 * Read-only formation audit. Replays the exact OQNR V1 BTCUSDT window through
 * the production live path and classifies the official 483 HIGH cohort without
 * changing tier, notification, liquidity, or equal-liquidity rules.
 */
var crypto = require('crypto');
var fs = require('fs');
var path = require('path');
var liveEngine = require('../live/liveEngine');
var thresholds = require('../config/thresholds');
var displacementLeg = require('../stats/displacementLeg');
var liquidityProvenance = require('../stats/liquidityProvenance');
var equalLiquidity = require('../liquidity/equalLiquidity');

var ROOT = path.resolve(__dirname, '..');
var OUT = path.resolve(process.argv[2] || path.join(ROOT, '.audit-high-liquidity-narrative-population-v1'));
var LEDGER_PATH = path.join(ROOT, '.audit-opportunity-quality-narrative-refactor-v1/after-replay/evaluation-ledger.json');
var SYMBOL = 'BTCUSDT';
var START = Date.parse('2026-07-23T16:40:00.000Z');
var END = Date.parse('2026-08-22T16:39:59.999Z');
var ENGINE_START = Date.parse('2026-06-23T16:40:00.000Z');
var BAR_MS = 300000;
var productionFiles = [
    'structure/pivotDetector.js', 'liquidity/equalLiquidity.js', 'liquidity/liquidityLifecycle.js',
    'liquidity/liquidityRegistry.js', 'events/sweepEventAdapter.js', 'events/mssSignalDetector.js',
    'events/displacementDetector.js', 'stats/liquidityProvenance.js', 'stats/opportunityQuality.js',
    'live/liveEngine.js', 'config/thresholds.js'
];

var hashesBefore = hashes();
var sourceLedger = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
// OQNR V1's published population deliberately excludes no-FVG diagnostic rows.
var cohort = sourceLedger.filter(function (e) { return e.fvgCount > 0 && e.tier === 'HIGH_QUALITY'; });
if (cohort.length !== 483) throw new Error('EXPECTED_483_HIGH_GOT_' + cohort.length);

var data = loadData();
var candles = data['5m'].filter(function (c) { return c.closeTime >= ENGINE_START && c.closeTime <= END; });
var engine = liveEngine.createLiveEngine({
    symbol: SYMBOL,
    exchangeInfo: data.exchangeInfo,
    structureCandles: { '1d': data['1d'], '4h': data['4h'], '1h': data['1h'] },
    calendarCandles: { '1d': data['1d'], '1w': data['1w'], '1M': data['1M'] },
    fetcher: function (symbol, interval) { return Promise.resolve(data[interval] || []); },
    thresholds: thresholds
}, {
    snapshotInterval: 12,
    baseIndex: 0,
    dailyBiasProvider: function () {
        return { bias: 'UNKNOWN', confidence: null, alignment: 'UNKNOWN', status: 'BYPASSED', evaluationTime: null, ageMs: null };
    }
});
var state = engine.getState();
var chain = Promise.resolve();
candles.forEach(function (c, i) { chain = chain.then(function () { return engine.onBar(c, i); }); });
chain.then(build).catch(function (err) {
    console.error(err && err.stack ? err.stack : err);
    process.exitCode = 1;
});

function build() {
    var liquidity = state.registry.getAll(SYMBOL);
    var sweeps = state.eventRegistry.getByType(SYMBOL, 'LIQUIDITY_SWEEP');
    var mss = state.eventRegistry.getByType(SYMBOL, 'MSS');
    var disp = state.eventRegistry.getByType(SYMBOL, 'DISPLACEMENT');
    var legs = displacementLeg.buildWindowedLegIndex(disp, candles, mss, state.swings, 900000);
    var lookback = thresholds.events.sweepProvenance.maxLookbackBars;
    var leaks = [];

    var records = cohort.map(function (e) {
        var firstDispId = String(e.legId || '').replace(/^LEG:/, '');
        var leg = legs[firstDispId];
        if (!leg) throw new Error('LEG_NOT_FOUND ' + e.legId);
        var endIndex = leg.endIndex !== undefined ? leg.endIndex : leg.lastIndex;
        var association = liquidityProvenance.associateSweeps({
            direction: e.direction, leg: leg, availableAt: e.evaluationTime,
            sweepEvents: sweeps, maxLookbackBars: null
        });
        var aligned = association && association.allCandidates ? association.allCandidates : [];
        var startBound = leg.startIndex - lookback;
        var windowSweeps = sweeps.filter(function (s) {
            return typeof s.confirmedAt === 'number' && s.confirmedAt <= e.evaluationTime &&
                typeof s.candleIndex === 'number' && s.candleIndex >= startBound && s.candleIndex <= endIndex;
        });
        var wantedSide = e.direction === 'BULLISH' ? 'SSL' : 'BSL';
        var allOppositeWindowSweeps = windowSweeps.filter(function (s) { return s.side !== wantedSide; });
        // B uses the opportunity's already-produced narrative raid fact. Merely having an
        // unrelated opposite-side sweep somewhere in the 48-bar time window must not steal
        // classification from an unraided same-side liquidity narrative (HR-01 is the guard).
        var narrativeMisaligned = !!e.raidId && e.raidDirectionMatch !== true;
        var narrativeRaidEvent = e.raidId ? sweeps.filter(function (s) { return s.id === e.raidId; })[0] : null;
        var formationIndex = Math.min(e.availableIndex == null ? endIndex : e.availableIndex, candles.length - 1);
        var formationTime = e.evaluationTime;
        var preLeg = candles[Math.max(0, leg.startIndex - 1)] || candles[leg.startIndex];
        var referencePrice = preLeg.close;
        var visibleRelevant = liquidity.filter(function (l) {
            return allowedType(l.type) && l.side === wantedSide && l.confirmedAt <= formationTime &&
                isPresentAt(l, formationTime) && priceOnExpectedSide(l.price, referencePrice, e.direction);
        });
        visibleRelevant.sort(function (a, b) {
            return Math.abs(a.price - referencePrice) - Math.abs(b.price - referencePrice) || b.confirmedAt - a.confirmedAt;
        });
        var category;
        if (aligned.length) category = 'A. RAID_ALIGNED';
        else if (narrativeMisaligned) category = 'B. RAID_PRESENT_BUT_MISALIGNED';
        else if (visibleRelevant.length) category = 'C. LIQUIDITY_PRESENT_NOT_RAIDED';
        else category = 'D. NO_RELEVANT_LIQUIDITY_CONTEXT';

        aligned.forEach(function (s) {
            if (s.confirmedAt > formationTime || s.confirmedAt > leg.lastConfirmedAt) {
                leaks.push({ opportunityId: e.id, sweepId: s.id, reason: 'ASSOCIATED_SWEEP_AFTER_FORMATION_OR_LEG_END' });
            }
        });
        var nearest = visibleRelevant[0] || null;
        if (nearest && nearest.confirmedAt > formationTime) leaks.push({ opportunityId: e.id, liquidityId: nearest.id, reason: 'LIQUIDITY_CONFIRMED_AFTER_FORMATION' });
        var nearMiss = category.indexOf('C.') === 0
            ? findNearEqualNearMiss(e.direction, formationTime, referencePrice, liquidity, leg)
            : null;
        return {
            opportunityId: e.id,
            legId: e.legId,
            evaluationTime: formationTime,
            evaluationTimeIso: iso(formationTime),
            direction: e.direction,
            tier: e.tier,
            category: category,
            classificationEvidence: {
                productionAlignedCandidateCount: aligned.length,
                productionAlignedCandidates: aligned.map(compactAssociation),
                opportunityNarrativeRaid: narrativeRaidEvent ? compactSweep(narrativeRaidEvent) : (e.raidId ? {
                    sweepId: e.raidId, direction: e.raidDirection, side: e.raidSide,
                    directionMatch: e.raidDirectionMatch, source: 'OQNR_EVALUATION_LEDGER'
                } : null),
                opportunityNarrativeRaidDirectionMatch: e.raidDirectionMatch,
                oppositeSideRaidCountInProductionTimeWindowDiagnostic: allOppositeWindowSweeps.length,
                oppositeSideRaidsInProductionTimeWindowDiagnostic: allOppositeWindowSweeps.map(compactSweep),
                relevantUnraidedLiquidityCount: visibleRelevant.length,
                window: { startIndex: startBound, legStartIndex: leg.startIndex, legEndIndex: endIndex, maxLookbackBars: lookback }
            },
            nearestRelevantLiquidity: nearest ? compactNearest(nearest, referencePrice, leg, formationIndex) : null,
            nearEqualNearMiss: nearMiss,
            formationOnly: true,
            outcomeIncluded: false
        };
    });

    var counts = countBy(records, function (r) { return r.category; });
    var noAlignedRaidCount = records.filter(function (r) { return r.category.indexOf('A.') !== 0; }).length;
    var noRaidCount = records.filter(function (r) {
        return r.category.indexOf('C.') === 0 || r.category.indexOf('D.') === 0;
    }).length;
    var cRecords = records.filter(function (r) { return r.category.indexOf('C.') === 0; });
    var nearMissRecords = cRecords.filter(function (r) { return !!r.nearEqualNearMiss; });
    var bands = { '<=1.25x': 0, '>1.25x_to_<=1.5x': 0, '>1.5x_to_<=2.0x': 0, '>2.0x_to_<=2.5x': 0, '>2.5x_to_<=3.0x': 0, '>3.0x': 0 };
    nearMissRecords.forEach(function (r) { bands[bandOf(r.nearEqualNearMiss.toleranceRatio)]++; });
    var uniquePairs = {};
    nearMissRecords.forEach(function (r) { uniquePairs[r.nearEqualNearMiss.pairKey] = r.nearEqualNearMiss; });
    var uniqueBands = { '<=1.25x': 0, '>1.25x_to_<=1.5x': 0, '>1.5x_to_<=2.0x': 0, '>2.0x_to_<=2.5x': 0, '>2.5x_to_<=3.0x': 0, '>3.0x': 0 };
    Object.keys(uniquePairs).forEach(function (k) { uniqueBands[bandOf(uniquePairs[k].toleranceRatio)]++; });
    var hr01 = buildHr01(liquidity);
    var hrPairKey = [hr01.memberA.id, hr01.memberB.id].sort().join('|');
    var hrAlreadySelected = !!uniquePairs[hrPairKey];
    var hrBandPopulation = bands[bandOf(hr01.toleranceRatio)] + (hrAlreadySelected ? 0 : 1);
    var hrBandUniquePopulation = uniqueBands[bandOf(hr01.toleranceRatio)] + (hrAlreadySelected ? 0 : 1);
    var hashesAfter = hashes();
    var changed = Object.keys(hashesBefore).filter(function (f) { return hashesBefore[f] !== hashesAfter[f]; });
    var result = {
        audit: {
            version: 'HIGH Liquidity Narrative Population Audit V1', symbol: SYMBOL,
            sourceReplay: '.audit-opportunity-quality-narrative-refactor-v1/after-replay',
            productionReplayPath: 'live/liveEngine.createLiveEngine().onBar',
            start: START, startIso: iso(START), end: END, endIso: iso(END),
            engineStart: ENGINE_START, engineStartIso: iso(ENGINE_START), barsProcessed: candles.length,
            closedCandlesOnly: true, outcomeUsed: false,
            classificationPrecedence: ['A RAID_ALIGNED', 'B RAID_PRESENT_BUT_MISALIGNED', 'C LIQUIDITY_PRESENT_NOT_RAIDED', 'D NO_RELEVANT_LIQUIDITY_CONTEXT'],
            categoryNotes: {
                A: 'At least one direction-matched production association candidate in leg.startIndex-48 through leg.endIndex.',
                B: 'No A candidate; the opportunity own OQNR narrative raid exists and its direction mismatches the opportunity. Unrelated opposite-side window sweeps are diagnostic only.',
                C: 'No A/B; at evaluationTime at least one direction-corresponding ACTIVE/TOUCHED production liquidity object remains on the expected price side.',
                D: 'No A/B and no such formation-visible liquidity object. No arbitrary distance/age threshold was introduced.'
            }
        },
        summary: {
            HIGH_TOTAL: records.length,
            RAID_ALIGNED_COUNT: counts['A. RAID_ALIGNED'] || 0,
            RAID_PRESENT_BUT_MISALIGNED_COUNT: counts['B. RAID_PRESENT_BUT_MISALIGNED'] || 0,
            LIQUIDITY_PRESENT_NOT_RAIDED_COUNT: counts['C. LIQUIDITY_PRESENT_NOT_RAIDED'] || 0,
            NO_RELEVANT_LIQUIDITY_CONTEXT_COUNT: counts['D. NO_RELEVANT_LIQUIDITY_CONTEXT'] || 0,
            HIGH_WITHOUT_RAID_COUNT: noRaidCount,
            HIGH_WITHOUT_RAID_PERCENT: round(noRaidCount / records.length * 100),
            HIGH_WITHOUT_ALIGNED_PRODUCTION_RAID_COUNT: noAlignedRaidCount,
            HIGH_WITHOUT_ALIGNED_PRODUCTION_RAID_PERCENT: round(noAlignedRaidCount / records.length * 100),
            EQL_NEAR_MISS_COUNT: nearMissRecords.length,
            EQL_NEAR_MISS_UNIQUE_PAIR_COUNT: Object.keys(uniquePairs).length,
            EQL_NEAR_MISS_BANDS_OPPORTUNITY_LEVEL: bands,
            EQL_NEAR_MISS_BANDS_UNIQUE_PAIR_LEVEL: uniqueBands
        },
        hr01: Object.assign(hr01, {
            populationBand: bandOf(hr01.toleranceRatio),
            opportunityNearMissesInSameBand: hrBandPopulation,
            uniqueNearMissPairsInSameBand: hrBandUniquePopulation,
            populationInterpretation: hrBandUniquePopulation > 1 ? 'REPRESENTATIVE_BAND_NOT_ISOLATED' : 'ISOLATED_IN_SELECTED_UNIQUE_PAIR_POPULATION'
        }),
        answers: {
            RAID_AS_OPPORTUNITY_EXISTENCE_PREREQUISITE: noRaidCount > 0 ? 'NO' : 'NOT_DISPROVEN_BY_THIS_POPULATION',
            RAID_AS_NARRATIVE_QUALITY_ENRICHMENT: 'YES',
            EQL_TOLERANCE_POPULATION_EVIDENCE_OVERLY_STRICT: 'NEEDS_HUMAN_REVIEW',
            EQL_TOLERANCE_INTERPRETATION: 'Formation-only density can show boundary pressure but cannot establish signal validity or justify a threshold change without Outcome/human review.',
            HR01_ISOLATED_OR_REPRESENTATIVE: hrBandUniquePopulation > 1 ? 'REPRESENTATIVE_POPULATION_BAND' : 'ISOLATED_IN_SELECTED_UNIQUE_PAIR_POPULATION'
        },
        invariants: {
            FUTURE_LEAK_VIOLATIONS: leaks.length,
            PRODUCTION_CHANGED: changed.length > 0,
            OUTCOME_USED: false
        },
        futureLeakDetails: leaks,
        productionHashChanges: changed,
        productionHashesBefore: hashesBefore,
        productionHashesAfter: hashesAfter
    };

    if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'high-liquidity-narrative-ledger.json'), JSON.stringify(records, null, 2));
    fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(result, null, 2));
    fs.writeFileSync(path.join(OUT, 'eql-near-miss-population.json'), JSON.stringify({
        definition: 'One closest production-tolerance failure pair per C opportunity; both confirmed and ACTIVE/TOUCHED at evaluationTime, correct side/price side, production bar-distance passes, ratio > 1.',
        opportunityRecords: nearMissRecords.map(function (r) { return { opportunityId: r.opportunityId, evaluationTime: r.evaluationTime, direction: r.direction, pair: r.nearEqualNearMiss }; }),
        uniquePairs: uniquePairs,
        bandsOpportunityLevel: bands,
        bandsUniquePairLevel: uniqueBands,
        hr01: result.hr01,
        outcomeIncluded: false
    }, null, 2));
    fs.writeFileSync(path.join(OUT, 'HIGH_LIQUIDITY_NARRATIVE_POPULATION_AUDIT_V1_REPORT.md'), render(result));
    console.log(JSON.stringify({ summary: result.summary, hr01: result.hr01, answers: result.answers, invariants: result.invariants, output: OUT }, null, 2));
    if (leaks.length || changed.length) process.exitCode = 1;
}

function allowedType(type) {
    var t = String(type || '').toUpperCase();
    return t === 'SWING_HIGH' || t === 'SWING_LOW' || t === 'EQH' || t === 'EQL' ||
        t === 'PDH' || t === 'PDL' || t.indexOf('ASIA_') === 0 ||
        t.indexOf('LONDON_') === 0 || t.indexOf('NEW_YORK_') === 0;
}
function isPresentAt(l, t) {
    if (l.brokenAt && l.brokenAt <= t) return false;
    if (l.sweptAt && l.sweptAt <= t) return false;
    return true;
}
function stateAt(l, t) {
    if (l.brokenAt && l.brokenAt <= t) return 'BROKEN';
    if (l.sweptAt && l.sweptAt <= t) return 'SWEPT';
    if (l.touchedAt && l.touchedAt <= t) return 'TOUCHED';
    return 'ACTIVE';
}
function priceOnExpectedSide(price, reference, direction) {
    return direction === 'BULLISH' ? price <= reference : price >= reference;
}
function findNearEqualNearMiss(direction, evaluationTime, referencePrice, liquidity, leg) {
    var side = direction === 'BULLISH' ? 'SSL' : 'BSL';
    var type = direction === 'BULLISH' ? 'SWING_LOW' : 'SWING_HIGH';
    var swings = liquidity.filter(function (l) {
        return l.type === type && l.side === side && l.confirmedAt <= evaluationTime &&
            isPresentAt(l, evaluationTime) && priceOnExpectedSide(l.price, referencePrice, direction);
    }).sort(function (a, b) { return a.price - b.price || a.sourceOpenTime - b.sourceOpenTime; });
    if (swings.length < 2) return null;
    var nearestIndex = 0;
    for (var n = 1; n < swings.length; n++) {
        if (Math.abs(swings[n].price - referencePrice) < Math.abs(swings[nearestIndex].price - referencePrice)) nearestIndex = n;
    }
    // Production clustering is price-sorted. Audit only the immediate price neighbours
    // of the nearest formation-visible directional swing, rather than mining any remote
    // historical pair for the smallest ratio.
    var pairIndexes = [];
    if (nearestIndex > 0) pairIndexes.push([nearestIndex - 1, nearestIndex]);
    if (nearestIndex + 1 < swings.length) pairIndexes.push([nearestIndex, nearestIndex + 1]);
    var candidates = [];
    pairIndexes.forEach(function (pair) {
        var a = swings[pair[0]], b = swings[pair[1]];
        var bars = equalLiquidity.barsApart(a, b);
        if (bars < thresholds.equalLiquidity.minBarsApart || bars > thresholds.equalLiquidity.maxBarsApart) return;
        var anchor = Math.min(a.price, b.price);
        var tol = equalLiquidity.toleranceFor(anchor, thresholds.equalLiquidity.percentageTolerance, data.exchangeInfo.tickSize, thresholds.tickSize.equalMultiplier);
        var diff = Math.abs(a.price - b.price);
        if (!(diff > tol)) return;
        var avg = (a.price + b.price) / 2;
        candidates.push({
            pairKey: [a.id, b.id].sort().join('|'), side: side,
            memberA: compactPairMember(a, evaluationTime), memberB: compactPairMember(b, evaluationTime),
            absolutePriceDifference: round(diff), percentageDifference: round(diff / anchor * 100),
            atrNormalizedDifference: round(diff / atrAtTime(Math.max(a.confirmedAt, b.confirmedAt))),
            productionTolerance: round(tol), toleranceRatio: round(diff / tol),
            barsApart: bars, productionBarDistancePass: true,
            distanceFromPreLegPrice: round(Math.abs(avg - referencePrice)),
            latestMemberBarsFromLegStart: round((Math.max(a.sourceOpenTime, b.sourceOpenTime) - candles[leg.startIndex].openTime) / BAR_MS)
        });
    });
    candidates.sort(function (a, b) { return a.toleranceRatio - b.toleranceRatio || a.distanceFromPreLegPrice - b.distanceFromPreLegPrice; });
    return candidates[0] || null;
}
function buildHr01(liquidity) {
    var a = liquidity.filter(function (l) { return l.id === 'BTCUSDT:5m:SWING_LOW:1786386900000'; })[0];
    var b = liquidity.filter(function (l) { return l.id === 'BTCUSDT:5m:SWING_LOW:1786431000000'; })[0];
    if (!a || !b) throw new Error('HR01_SWINGS_NOT_FOUND');
    var diff = Math.abs(a.price - b.price);
    var tol = equalLiquidity.toleranceFor(Math.min(a.price, b.price), thresholds.equalLiquidity.percentageTolerance, data.exchangeInfo.tickSize, thresholds.tickSize.equalMultiplier);
    return {
        reviewId: 'OQNR-HR-01', memberA: compactPairMember(a, Date.parse('2026-08-11T08:44:59.999Z')),
        memberB: compactPairMember(b, Date.parse('2026-08-11T08:44:59.999Z')),
        absolutePriceDifference: round(diff), percentageDifference: round(diff / Math.min(a.price, b.price) * 100),
        atrNormalizedDifference: round(diff / atrAtTime(Math.max(a.confirmedAt, b.confirmedAt))),
        productionTolerance: round(tol), toleranceRatio: round(diff / tol),
        barsApart: equalLiquidity.barsApart(a, b), priceTolerancePass: diff <= tol,
        barDistancePass: equalLiquidity.barsApart(a, b) >= thresholds.equalLiquidity.minBarsApart && equalLiquidity.barsApart(a, b) <= thresholds.equalLiquidity.maxBarsApart,
        outcomeIncluded: false
    };
}
function compactPairMember(l, t) {
    return { id: l.id, type: l.type, price: l.price, occurredAt: l.sourceOpenTime, occurredAtIso: iso(l.sourceOpenTime), confirmedAt: l.confirmedAt, confirmedAtIso: iso(l.confirmedAt), statusAtEvaluation: stateAt(l, t) };
}
function compactNearest(l, referencePrice, leg, formationIndex) {
    var atr = state.atrSeries[leg.startIndex - 1] || state.atrSeries[leg.startIndex] || null;
    var distance = Math.abs(l.price - referencePrice);
    return {
        id: l.id, sourceType: l.type, side: l.side, price: l.price,
        occurredAt: l.sourceOpenTime, occurredAtIso: iso(l.sourceOpenTime),
        confirmedAt: l.confirmedAt, confirmedAtIso: iso(l.confirmedAt),
        statusAtEvaluation: stateAt(l, candles[formationIndex].closeTime),
        distance: {
            reference: 'PRE_LEG_CANDLE_CLOSE', referencePrice: referencePrice,
            absolutePriceDistance: round(distance), percentageDistance: round(distance / referencePrice * 100),
            atrAtPreLeg: round(atr), atrNormalizedDistance: atr ? round(distance / atr) : null,
            barsFromLegStart: round((l.sourceOpenTime - candles[leg.startIndex].openTime) / BAR_MS)
        }
    };
}
function compactAssociation(c) {
    return { sweepId: c.id, sourceLiquidityId: c.sourceId, sourceType: c.sourceType, sourcePrice: c.sourcePrice, side: c.side, confirmedAt: c.confirmedAt, confirmedAtIso: iso(c.confirmedAt), candleIndex: c.candleIndex, relation: c.relation, barsBeforeLegStart: c.barsBeforeLegStart };
}
function compactSweep(s) {
    return { sweepId: s.id, sourceLiquidityId: s.liquidityId, sourceType: s.source && s.source.liquidityType, sourcePrice: s.price, side: s.side, direction: s.direction, confirmedAt: s.confirmedAt, confirmedAtIso: iso(s.confirmedAt), candleIndex: s.candleIndex };
}
function atrAtTime(t) {
    var i = lastIndexAtOrBefore(candles, t);
    return state.atrSeries[i] || null;
}
function lastIndexAtOrBefore(list, t) {
    var lo = 0, hi = list.length - 1, ans = 0;
    while (lo <= hi) { var m = (lo + hi) >> 1; if (list[m].closeTime <= t) { ans = m; lo = m + 1; } else hi = m - 1; }
    return ans;
}
function bandOf(ratio) {
    if (ratio <= 1.25) return '<=1.25x';
    if (ratio <= 1.5) return '>1.25x_to_<=1.5x';
    if (ratio <= 2) return '>1.5x_to_<=2.0x';
    if (ratio <= 2.5) return '>2.0x_to_<=2.5x';
    if (ratio <= 3) return '>2.5x_to_<=3.0x';
    return '>3.0x';
}
function countBy(rows, fn) { var out = {}; rows.forEach(function (x) { var k = fn(x); out[k] = (out[k] || 0) + 1; }); return out; }
function round(n) { return typeof n === 'number' && isFinite(n) ? Math.round(n * 1e8) / 1e8 : null; }
function iso(t) { return typeof t === 'number' ? new Date(t).toISOString() : null; }
function hashes() {
    var out = {};
    productionFiles.forEach(function (f) { out[f] = crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, f))).digest('hex'); });
    return out;
}
function loadData() {
    var dir = path.join(ROOT, 'data-cache');
    var intervals = ['5m', '1h', '4h', '1d', '1w', '1M'];
    var result = {};
    intervals.forEach(function (tf) {
        var byOpen = {};
        fs.readdirSync(dir).filter(function (f) { return f.indexOf(SYMBOL + '_' + tf + '_') === 0 && /\.json$/.test(f); }).forEach(function (f) {
            var rows;
            try { rows = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { return; }
            (rows || []).forEach(function (c) {
                if (c && c.source === 'futures' && c.closed !== false && c.closeTime >= ENGINE_START && c.closeTime <= END) byOpen[c.openTime] = c;
            });
        });
        result[tf] = Object.keys(byOpen).map(function (k) { return byOpen[k]; }).sort(function (a, b) { return a.openTime - b.openTime; });
    });
    var exchange = path.join(dir, SYMBOL + '_EXCHANGE.json');
    result.exchangeInfo = fs.existsSync(exchange) ? JSON.parse(fs.readFileSync(exchange, 'utf8')) : { symbol: SYMBOL, tickSize: 0.1 };
    return result;
}
function render(r) {
    var s = r.summary;
    return [
        '# HIGH Liquidity Narrative Population Audit V1', '',
        '- Fixed window: ' + r.audit.startIso + ' → ' + r.audit.endIso,
        '- Production replay path: `' + r.audit.productionReplayPath + '`',
        '- Closed candles only: true', '- Outcome used: false', '',
        '## Mutually exclusive population', '',
        '| Category | Count |', '| --- | ---: |',
        '| RAID_ALIGNED | ' + s.RAID_ALIGNED_COUNT + ' |',
        '| RAID_PRESENT_BUT_MISALIGNED | ' + s.RAID_PRESENT_BUT_MISALIGNED_COUNT + ' |',
        '| LIQUIDITY_PRESENT_NOT_RAIDED | ' + s.LIQUIDITY_PRESENT_NOT_RAIDED_COUNT + ' |',
        '| NO_RELEVANT_LIQUIDITY_CONTEXT | ' + s.NO_RELEVANT_LIQUIDITY_CONTEXT_COUNT + ' |',
        '| **HIGH_TOTAL** | **' + s.HIGH_TOTAL + '** |', '',
        '- HIGH_WITHOUT_RAID_COUNT = ' + s.HIGH_WITHOUT_RAID_COUNT,
        '- HIGH_WITHOUT_RAID_PERCENT = ' + s.HIGH_WITHOUT_RAID_PERCENT + '%', '',
        '## EQL/EQH tolerance near-misses', '',
        '- EQL_NEAR_MISS_COUNT (opportunity-level) = ' + s.EQL_NEAR_MISS_COUNT,
        '- EQL_NEAR_MISS_UNIQUE_PAIR_COUNT = ' + s.EQL_NEAR_MISS_UNIQUE_PAIR_COUNT, '',
        '| Tolerance ratio band | Opportunities | Unique pairs |', '| --- | ---: | ---: |',
        Object.keys(s.EQL_NEAR_MISS_BANDS_OPPORTUNITY_LEVEL).map(function (k) { return '| ' + k + ' | ' + s.EQL_NEAR_MISS_BANDS_OPPORTUNITY_LEVEL[k] + ' | ' + s.EQL_NEAR_MISS_BANDS_UNIQUE_PAIR_LEVEL[k] + ' |'; }).join('\n'), '',
        '## HR-01', '',
        '- 63788 / 63820 difference = ' + r.hr01.absolutePriceDifference,
        '- Production tolerance = ' + r.hr01.productionTolerance,
        '- Tolerance ratio = ' + r.hr01.toleranceRatio + ' (' + r.hr01.populationBand + ')',
        '- Population interpretation = ' + r.hr01.populationInterpretation, '',
        '## Diagnostic answers', '',
        '- Raid as Opportunity existence prerequisite: ' + r.answers.RAID_AS_OPPORTUNITY_EXISTENCE_PREREQUISITE,
        '- Raid as Narrative Quality enrichment: ' + r.answers.RAID_AS_NARRATIVE_QUALITY_ENRICHMENT,
        '- EQL tolerance overly strict: ' + r.answers.EQL_TOLERANCE_POPULATION_EVIDENCE_OVERLY_STRICT,
        '- HR-01: ' + r.answers.HR01_ISOLATED_OR_REPRESENTATIVE, '',
        '## Invariants', '',
        '- FUTURE_LEAK_VIOLATIONS = ' + r.invariants.FUTURE_LEAK_VIOLATIONS,
        '- PRODUCTION_CHANGED = ' + r.invariants.PRODUCTION_CHANGED,
        '- OUTCOME_USED = ' + r.invariants.OUTCOME_USED, ''
    ].join('\n');
}
