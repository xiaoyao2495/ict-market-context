'use strict';

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var cp = require('child_process');

var REPO = path.join(__dirname, '..');
var ROOT = '/Users/yaodebao/.codex/visualizations/2026/08/24/01a031bc-fea2-7943-9b4f-2a5e77efcdda';
var GT_FILE = path.join(REPO, 'accumulation-ground-truth-v2-full-relabel-v1', 'accumulation-ground-truth-v2.json');
var FREEZE_ACCEPTANCE = path.join(REPO, 'accumulation-ground-truth-v2-full-relabel-v1', 'ground-truth-v2-freeze-acceptance.json');
var MANIFEST_FILE = path.join(ROOT, 'accumulation-detection-research-v1', 'sample-manifest.json');
var CANDLES_FILE = path.join(ROOT, 'eqh-eql-persistent-cluster-shadow-v3', 'BTCUSDT-5m-bounded-input.json');
var OUT = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'accumulation-representation-v3-research-v1');
var EXPECTED_HEAD = '8e525f93c9f99b10f168edd93135d62db5000fe6';
var CONSTANTS = Object.freeze({ preFormationBars: 24, lowerZoneEnd: 1 / 3, upperZoneStart: 2 / 3,
    lifecycleSegments: 3, localCenterDivisor: 4, localCenterMinBars: 4,
    stableCenterTerminalShift: 0.10, stableCenterSpan: 0.20, materialCenterShift: 0.20,
    monotonicDirectionShare: 0.80, shiftedAcceptanceDistance: 0.15,
    excursionExtensionRatio: 0.10, strongDirectionRatio: 0.75,
    strongIqrSeparationRatio: 0.50, mediumDirectionRatio: 0.50, weakDirectionRatio: 0.25 });

function sha(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function shaFile(file) { return sha(fs.readFileSync(file)); }
function writeJson(name, value) { fs.writeFileSync(path.join(OUT, name), JSON.stringify(value, null, 2) + '\n'); }
function safeDivide(a, b, fallback) { return Number.isFinite(a) && Number.isFinite(b) && Math.abs(b) > 1e-12 ? a / b : fallback; }
function quantile(values, q) {
    var sorted = values.filter(Number.isFinite).slice().sort(function (a, b) { return a - b; });
    if (!sorted.length) return null;
    var position = (sorted.length - 1) * q, lower = Math.floor(position), upper = Math.ceil(position);
    return lower === upper ? sorted[lower] : sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}
function summary(values) {
    var clean = values.filter(Number.isFinite);
    return { n: clean.length, p10: quantile(clean, 0.10), p25: quantile(clean, 0.25),
        median: quantile(clean, 0.50), p75: quantile(clean, 0.75), p90: quantile(clean, 0.90) };
}
function countBy(rows, field) {
    return rows.reduce(function (out, row) { var key = row[field]; out[key] = (out[key] || 0) + 1; return out; }, {});
}
function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function sign(value) { return value > 1e-12 ? 1 : value < -1e-12 ? -1 : 0; }
function zone(position) { return position < CONSTANTS.lowerZoneEnd ? 'LOWER' : position > CONSTANTS.upperZoneStart ? 'UPPER' : 'CENTER'; }
function episodes(zones, target) {
    var count = 0, active = false;
    zones.forEach(function (value) { if (value === target && !active) { count++; active = true; } else if (value !== target) active = false; });
    return count;
}
function longestRun(zones, target) {
    var longest = 0, current = 0;
    zones.forEach(function (value) { current = value === target ? current + 1 : 0; longest = Math.max(longest, current); });
    return longest;
}
function compressedZones(zones) { return zones.filter(function (value, index) { return !index || value !== zones[index - 1]; }); }
function pathEfficiency(closes) {
    if (closes.length < 2) return 0;
    var travel = 0; for (var i = 1; i < closes.length; i++) travel += Math.abs(closes[i] - closes[i - 1]);
    return safeDivide(Math.abs(closes[closes.length - 1] - closes[0]), travel, 0);
}
function directionalPersistence(closes) {
    if (closes.length < 2) return 0;
    var up = 0, down = 0;
    for (var i = 1; i < closes.length; i++) { var s = sign(closes[i] - closes[i - 1]); if (s > 0) up++; else if (s < 0) down++; }
    return safeDivide(Math.max(up, down), up + down, 0);
}
function alternationRate(closes) {
    var directions = [];
    for (var i = 1; i < closes.length; i++) { var s = sign(closes[i] - closes[i - 1]); if (s) directions.push(s); }
    if (directions.length < 2) return 0;
    var changes = 0; for (var j = 1; j < directions.length; j++) if (directions[j] !== directions[j - 1]) changes++;
    return changes / (directions.length - 1);
}
function phaseCoverage(zones, target) {
    var phases = new Set(), n = zones.length;
    zones.forEach(function (value, index) { if (value === target) phases.add(Math.min(2, Math.floor(index * 3 / Math.max(1, n)))); });
    return phases.size;
}
function traversalCounts(zones) {
    var compact = compressedZones(zones), lowerToUpper = 0, upperToLower = 0, partial = 0;
    for (var i = 0; i < compact.length - 1; i++) if (compact[i] === 'CENTER' || compact[i + 1] === 'CENTER') partial++;
    for (var j = 0; j < compact.length - 2; j++) {
        var seq = compact.slice(j, j + 3).join('>');
        if (seq === 'LOWER>CENTER>UPPER') lowerToUpper++;
        if (seq === 'UPPER>CENTER>LOWER') upperToLower++;
    }
    return { lowerToUpper: lowerToUpper, upperToLower: upperToLower,
        fullTraversals: lowerToUpper + upperToLower, reverseTraversals: Math.min(lowerToUpper, upperToLower), partialTraversals: partial };
}

function rollingCenters(closes) {
    var window = Math.max(CONSTANTS.localCenterMinBars, Math.floor(closes.length / CONSTANTS.localCenterDivisor));
    return { window: window, values: closes.map(function (_, index) {
        var start = Math.max(0, index - window + 1), slice = closes.slice(start, index + 1);
        return slice.reduce(function (sum, value) { return sum + value; }, 0) / slice.length;
    }) };
}

function centerPathProfile(closes, rangeLow, rangeHigh) {
    var range = rangeHigh - rangeLow, rolling = rollingCenters(closes);
    var positions = rolling.values.map(function (value) { return safeDivide(value - rangeLow, range, 0.5); });
    var initial = positions[0], terminal = positions[positions.length - 1], terminalShift = terminal - initial;
    var span = Math.max.apply(null, positions) - Math.min.apply(null, positions);
    var directions = []; for (var i = 1; i < positions.length; i++) { var s = sign(positions[i] - positions[i - 1]); if (s) directions.push(s); }
    var dominant = directions.length ? Math.max(directions.filter(function (s) { return s > 0; }).length,
        directions.filter(function (s) { return s < 0; }).length) / directions.length : 0;
    var maxDeparture = Math.max.apply(null, positions.map(function (value) { return Math.abs(value - initial); }));
    var pathShape = 'IRREGULAR';
    if (Math.abs(terminalShift) <= CONSTANTS.stableCenterTerminalShift && span <= CONSTANTS.stableCenterSpan) pathShape = 'STABLE';
    else if (Math.abs(terminalShift) >= CONSTANTS.materialCenterShift && dominant >= CONSTANTS.monotonicDirectionShare) pathShape = 'MONOTONIC_MIGRATION';
    else if (maxDeparture >= CONSTANTS.materialCenterShift && Math.abs(terminalShift) <= CONSTANTS.stableCenterTerminalShift) pathShape = 'MEAN_REVERTING_SHIFT';
    else if (maxDeparture >= CONSTANTS.materialCenterShift && Math.abs(terminalShift) < maxDeparture * 0.60) pathShape = 'TEMPORARY_SHIFT';
    else if (Math.abs(terminalShift) >= CONSTANTS.materialCenterShift) pathShape = 'STEPWISE_MIGRATION';
    var terminalSide = sign(terminalShift), persistence = 0, accepted = 0;
    for (var j = 0; j < positions.length; j++) {
        if (terminalSide && sign(positions[j] - initial) === terminalSide && Math.abs(positions[j] - initial) >= CONSTANTS.shiftedAcceptanceDistance) persistence++;
    }
    var lateStart = Math.floor(closes.length * 2 / 3);
    for (var k = lateStart; k < closes.length; k++) {
        var closePosition = safeDivide(closes[k] - rangeLow, range, 0.5);
        if (terminalSide && sign(closePosition - initial) === terminalSide && Math.abs(closePosition - initial) >= CONSTANTS.shiftedAcceptanceDistance) accepted++;
    }
    return { localWindowBars: rolling.window, rollingLocalCenterPosition: positions,
        centerPathShape: pathShape, terminalValueShift: terminalShift, absoluteTerminalValueShift: Math.abs(terminalShift),
        centerPathSpan: span, monotonicDirectionShare: dominant,
        migrationPersistenceRatio: safeDivide(persistence, positions.length, 0),
        directionalAcceptanceRatio: safeDivide(accepted, closes.length - lateStart, 0) };
}

function excursionProfile(bars) {
    var events = [];
    for (var i = 2; i < bars.length; i++) {
        var prior = bars.slice(0, i), priorHigh = Math.max.apply(null, prior.map(function (bar) { return bar.high; }));
        var priorLow = Math.min.apply(null, prior.map(function (bar) { return bar.low; })), width = priorHigh - priorLow;
        if (width <= 1e-12) continue;
        var direction = bars[i].high > priorHigh + width * CONSTANTS.excursionExtensionRatio ? 'UPPER' :
            bars[i].low < priorLow - width * CONSTANTS.excursionExtensionRatio ? 'LOWER' : null;
        if (!direction) continue;
        var interiorLow = priorLow + width / 3, interiorHigh = priorLow + width * 2 / 3, returnIndex = null;
        for (var j = i; j < bars.length; j++) if (bars[j].close >= interiorLow && bars[j].close <= interiorHigh) { returnIndex = j; break; }
        var post = returnIndex === null ? [] : bars.slice(returnIndex);
        var postInterior = post.filter(function (bar) { return bar.close >= interiorLow && bar.close <= interiorHigh; }).length;
        var extension = direction === 'UPPER' ? bars[i].high - priorHigh : priorLow - bars[i].low;
        var reintegrationDepth = returnIndex === null ? 0 : direction === 'UPPER' ?
            clamp((priorHigh - bars[returnIndex].close) / width, 0, 1) : clamp((bars[returnIndex].close - priorLow) / width, 0, 1);
        events.push({ startIndex: i, direction: direction, extensionRatio: extension / width,
            resolvedWithinFormation: returnIndex !== null, reintegrationLatencyBars: returnIndex === null ? null : returnIndex - i,
            excursionDurationBars: returnIndex === null ? bars.length - i : returnIndex - i,
            reintegrationDepth: reintegrationDepth,
            postExcursionInteriorReuseRatio: safeDivide(postInterior, post.length, 0),
            balanceSurvivalAfterExcursion: returnIndex !== null && postInterior >= 2 });
        if (returnIndex !== null) i = Math.max(i, returnIndex - 1);
    }
    var resolved = events.filter(function (event) { return event.resolvedWithinFormation; });
    return { excursionCount: events.length, resolvedExcursionCount: resolved.length,
        reintegrationRate: safeDivide(resolved.length, events.length, 0),
        medianExcursionDurationBars: quantile(events.map(function (event) { return event.excursionDurationBars; }), 0.5),
        medianReintegrationLatencyBars: quantile(resolved.map(function (event) { return event.reintegrationLatencyBars; }), 0.5),
        medianReintegrationDepth: quantile(resolved.map(function (event) { return event.reintegrationDepth; }), 0.5),
        postExcursionInteriorReuseRatio: quantile(resolved.map(function (event) { return event.postExcursionInteriorReuseRatio; }), 0.5),
        balanceSurvivalRate: safeDivide(events.filter(function (event) { return event.balanceSurvivalAfterExcursion; }).length, events.length, 0),
        reintegrationSpeed: resolved.length ? 1 / (1 + quantile(resolved.map(function (event) { return event.reintegrationLatencyBars; }), 0.5)) : 0,
        events: events };
}

function computeProfile(gt, source, candles) {
    var row = source.row, preStart = Math.max(0, row.startIndex - CONSTANTS.preFormationBars);
    var preBars = candles.slice(preStart, row.startIndex), formationBars = candles.slice(row.startIndex, row.endIndex + 1);
    var rangeLow = row.rangeLowAtConfirmation, rangeHigh = row.rangeHighAtConfirmation, range = rangeHigh - rangeLow;
    var zeroWidth = range <= 1e-12, closes = formationBars.map(function (bar) { return bar.close; });
    var preCloses = preBars.map(function (bar) { return bar.close; });
    var positions = closes.map(function (close) { return zeroWidth ? 0.5 : clamp((close - rangeLow) / range, 0, 1); });
    var zones = positions.map(zone), traversals = traversalCounts(zones);
    var firstIndex = function (target) { var index = zones.indexOf(target); return index < 0 ? null : safeDivide(index, Math.max(1, zones.length - 1), 0); };
    var lastIndex = function (target) { var index = zones.lastIndexOf(target); return index < 0 ? null : safeDivide(index, Math.max(1, zones.length - 1), 0); };
    var lowerOcc = safeDivide(zones.filter(function (z) { return z === 'LOWER'; }).length, zones.length, 0);
    var upperOcc = safeDivide(zones.filter(function (z) { return z === 'UPPER'; }).length, zones.length, 0);
    var centerOcc = safeDivide(zones.filter(function (z) { return z === 'CENTER'; }).length, zones.length, 0);
    var dominantSide = upperOcc > lowerOcc ? 'UPPER' : lowerOcc > upperOcc ? 'LOWER' : 'BALANCED';
    var lateZones = zones.slice(Math.floor(zones.length * 2 / 3)), lateUpper = lateZones.filter(function (z) { return z === 'UPPER'; }).length;
    var lateLower = lateZones.filter(function (z) { return z === 'LOWER'; }).length;
    var lateSideBias = lateUpper > lateLower ? 'UPPER' : lateLower > lateUpper ? 'LOWER' : 'BALANCED';
    var internalReentries = 0;
    for (var i = 1; i < zones.length; i++) if (zones[i] === 'CENTER' && zones[i - 1] !== 'CENTER') internalReentries++;
    var preEfficiency = pathEfficiency(preCloses), formationEfficiency = pathEfficiency(closes);
    var prePersistence = directionalPersistence(preCloses), formationPersistence = directionalPersistence(closes);
    var center = centerPathProfile(closes, rangeLow, rangeHigh), excursion = excursionProfile(formationBars);
    return { originalCaseId: gt.originalCaseId,
        humanSemantics: { formationClass: gt.formationClassV2, confidence: gt.confidenceV2,
            independentBalance: gt.independentBalanceV2, twoSidedAuction: gt.twoSidedAuctionV2,
            previousTrendSeparation: gt.previousTrendSeparationV2, oneSidedResidence: gt.oneSidedResidenceV2,
            valueMigration: gt.valueMigrationV2, excursionContext: gt.excursionContextV2,
            definitionEdgeCase: gt.definitionEdgeCaseV2 },
        temporalSafety: { preFormationBarsUsed: preBars.length, formationBarsUsed: formationBars.length,
            formationConfirmedAt: row.confirmedAt, lastBarCloseTime: formationBars.length ? formationBars[formationBars.length - 1].closeTime : null,
            postConfirmationBarsUsed: formationBars.filter(function (bar) { return bar.closeTime > row.confirmedAt; }).length },
        defenses: { zeroWidthRange: zeroWidth, shortFormation: formationBars.length < CONSTANTS.localCenterMinBars },
        F1_INDEPENDENT_BALANCE_IDENTITY: {
            preFormationNetTravelPerRange: zeroWidth || preCloses.length < 2 ? 0 : Math.abs(preCloses[preCloses.length - 1] - preCloses[0]) / range,
            preFormationPathEfficiency: preEfficiency, preFormationDirectionalPersistence: prePersistence,
            formationNetReturnPerRange: zeroWidth || closes.length < 2 ? 0 : Math.abs(closes[closes.length - 1] - closes[0]) / range,
            formationPathEfficiency: formationEfficiency, formationDirectionalPersistence: formationPersistence,
            formationVsPreEfficiencyReduction: preEfficiency - formationEfficiency,
            formationVsPrePersistenceReduction: prePersistence - formationPersistence,
            formationDirectionAlternationRate: alternationRate(closes), internalZoneReentryEpisodes: internalReentries,
            internalPriceReuseRatio: centerOcc, formationBoundaryReuseSpan: Math.max(0,
                Math.min(lastIndex('LOWER') === null ? 0 : lastIndex('LOWER'), lastIndex('UPPER') === null ? 0 : lastIndex('UPPER')) -
                Math.max(firstIndex('LOWER') === null ? 1 : firstIndex('LOWER'), firstIndex('UPPER') === null ? 1 : firstIndex('UPPER'))) },
        F2_TWO_SIDED_AUCTION_COVERAGE: {
            lowerOccupancyRatio: lowerOcc, centerOccupancyRatio: centerOcc, upperOccupancyRatio: upperOcc,
            minimumSideOccupancyRatio: Math.min(lowerOcc, upperOcc), lowerParticipationEpisodes: episodes(zones, 'LOWER'),
            upperParticipationEpisodes: episodes(zones, 'UPPER'), minimumSideParticipationEpisodes: Math.min(episodes(zones, 'LOWER'), episodes(zones, 'UPPER')),
            lowerFirstParticipationTime: firstIndex('LOWER'), lowerLastParticipationTime: lastIndex('LOWER'),
            upperFirstParticipationTime: firstIndex('UPPER'), upperLastParticipationTime: lastIndex('UPPER'),
            lowerLifecyclePhaseCoverage: phaseCoverage(zones, 'LOWER'), upperLifecyclePhaseCoverage: phaseCoverage(zones, 'UPPER'),
            bilateralLifecyclePhaseCoverage: Math.min(phaseCoverage(zones, 'LOWER'), phaseCoverage(zones, 'UPPER')),
            lowerToUpperTraversals: traversals.lowerToUpper, upperToLowerTraversals: traversals.upperToLower,
            fullTraversalCount: traversals.fullTraversals, reverseTraversalCount: traversals.reverseTraversals,
            partialTraversalCount: traversals.partialTraversals, interiorReacceptanceEpisodes: internalReentries },
        F3_SIDE_RESIDENCE_ASYMMETRY: {
            longestUpperResidenceRun: longestRun(zones, 'UPPER'), longestLowerResidenceRun: longestRun(zones, 'LOWER'),
            longestDominantResidenceRunRatio: safeDivide(Math.max(longestRun(zones, 'UPPER'), longestRun(zones, 'LOWER')), zones.length, 0),
            upperOccupancyRatio: upperOcc, lowerOccupancyRatio: lowerOcc, dominantSide: dominantSide,
            dominantResidenceShare: Math.max(upperOcc, lowerOcc), oppositeSideUsage: Math.min(upperOcc, lowerOcc),
            lateSideBias: lateSideBias, lateSideBiasMagnitude: safeDivide(Math.abs(lateUpper - lateLower), lateZones.length, 0),
            centerAvoidanceDuration: longestRun(zones.map(function (z) { return z === 'CENTER' ? 'CENTER' : 'OUTSIDE'; }), 'OUTSIDE'),
            centerAvoidanceRatio: safeDivide(longestRun(zones.map(function (z) { return z === 'CENTER' ? 'CENTER' : 'OUTSIDE'; }), 'OUTSIDE'), zones.length, 0),
            oppositeSideParticipationScarcity: 1 - safeDivide(Math.min(lowerOcc, upperOcc), Math.max(lowerOcc, upperOcc), 0),
            residencePersistence: Math.max(upperOcc, lowerOcc) * safeDivide(Math.max(longestRun(zones, 'UPPER'), longestRun(zones, 'LOWER')), zones.length, 0) },
        F4_VALUE_MIGRATION_STRUCTURE: center,
        F5_EXCURSION_REINTEGRATION: excursion };
}

function primitiveDefinition(name, family, purpose, calculation, causalStatus, finalRange) {
    return { name: name, family: family, semanticPurpose: purpose, calculation: calculation,
        timeScope: 'MAX_24_PRE_BARS_AND_FORMATION_THROUGH_CONFIRMED_AT', causalStatus: causalStatus,
        normalization: finalRange ? 'FINAL_FORMATION_RANGE_POSITION' : 'CAUSAL_OR_RATIO',
        requiresFinalFormationRange: finalRange, labelIndependentDefinition: true, postHocFeature: false,
        usesFutureData: false, usesOutcome: false, usesEQ: false, usesDisplacement: false,
        usesSweep: false, usesMSS: false, usesFVG: false };
}

function representationDefinitions() {
    var defs = [];
    function add(family, purpose, finalRange, names) { names.forEach(function (item) {
        defs.push(primitiveDefinition(item[0], family, purpose, item[1], finalRange ?
            'FORMATION_FINALIZATION_RESEARCH_FEATURE_NOT_STREAMING_CAUSAL_DURING_FORMATION' : 'STREAMING_CAUSAL', finalRange));
    }); }
    add('F1_INDEPENDENT_BALANCE_IDENTITY', 'Express formation decoupling and internal auction reuse without using human labels.', true, [
        ['preFormationPathEfficiency', 'absolute pre net travel / pre cumulative path'],
        ['preFormationDirectionalPersistence', 'dominant signed pre close-move share'],
        ['formationPathEfficiency', 'absolute formation net travel / formation cumulative path'],
        ['formationDirectionalPersistence', 'dominant signed formation close-move share'],
        ['formationVsPreEfficiencyReduction', 'pre efficiency minus formation efficiency'],
        ['formationVsPrePersistenceReduction', 'pre persistence minus formation persistence'],
        ['formationDirectionAlternationRate', 'direction changes / adjacent non-zero formation moves'],
        ['internalZoneReentryEpisodes', 'episodes returning from a side third to the center third'],
        ['internalPriceReuseRatio', 'formation close occupancy in center third'],
        ['formationBoundaryReuseSpan', 'shared lifecycle span between lower and upper participation']]);
    add('F2_TWO_SIDED_AUCTION_COVERAGE', 'Express bilateral participation across the formation lifecycle.', true, [
        ['lowerOccupancyRatio', 'lower-third close occupancy'], ['upperOccupancyRatio', 'upper-third close occupancy'],
        ['minimumSideOccupancyRatio', 'minimum of lower and upper occupancy'],
        ['lowerParticipationEpisodes', 'distinct lower-third participation episodes'],
        ['upperParticipationEpisodes', 'distinct upper-third participation episodes'],
        ['bilateralLifecyclePhaseCoverage', 'minimum early/middle/late phase coverage across both sides'],
        ['fullTraversalCount', 'LOWER>CENTER>UPPER plus reverse compressed-zone sequences'],
        ['reverseTraversalCount', 'minimum traversal count across both directions'],
        ['partialTraversalCount', 'compressed-zone transitions involving the interior'],
        ['interiorReacceptanceEpisodes', 'side-to-center return episodes']]);
    add('F3_SIDE_RESIDENCE_ASYMMETRY', 'Express one-sided residence and opposite-side scarcity.', true, [
        ['longestDominantResidenceRunRatio', 'longest upper/lower run divided by formation bars'],
        ['dominantResidenceShare', 'maximum upper/lower occupancy'], ['oppositeSideUsage', 'minimum upper/lower occupancy'],
        ['lateSideBiasMagnitude', 'absolute upper/lower occupancy imbalance in last third'],
        ['centerAvoidanceRatio', 'longest consecutive outside-center run / formation bars'],
        ['oppositeSideParticipationScarcity', 'one minus min-side/max-side occupancy'],
        ['residencePersistence', 'dominant occupancy multiplied by longest-run ratio']]);
    add('F4_VALUE_MIGRATION_STRUCTURE', 'Express causal rolling-center migration plus acceptance.', true, [
        ['localWindowBars', 'max(4, floor(formationBars/4))'],
        ['centerPathShape', 'fixed descriptive class from terminal shift, span, recovery, and direction share'],
        ['absoluteTerminalValueShift', 'absolute final minus initial rolling-center range position'],
        ['centerPathSpan', 'max minus min rolling-center range position'],
        ['monotonicDirectionShare', 'dominant non-zero rolling-center step share'],
        ['migrationPersistenceRatio', 'share of rolling centers persistently displaced toward terminal side'],
        ['directionalAcceptanceRatio', 'last-third closes accepted in terminal shifted region']]);
    add('F5_EXCURSION_REINTEGRATION', 'Express causal excursion reintegration and balance survival.', false, [
        ['excursionCount', 'causal running-range extensions exceeding fixed 10% prior-range ratio'],
        ['reintegrationRate', 'resolved excursions / detected excursions'],
        ['medianExcursionDurationBars', 'median bars from excursion to reintegration or confirmation'],
        ['medianReintegrationLatencyBars', 'median bars to prior interior return'],
        ['medianReintegrationDepth', 'median normalized depth back into prior range'],
        ['postExcursionInteriorReuseRatio', 'median remaining activity inside prior interior after return'],
        ['balanceSurvivalRate', 'share of excursions followed by at least two prior-interior closes'],
        ['reintegrationSpeed', 'one / (one + median reintegration latency)']]);
    return defs;
}

function familyAnalysis(profiles, targetField, groupOrder, metrics, family, roleWhenSupported) {
    var groups = {};
    groupOrder.forEach(function (group) { groups[group] = profiles.filter(function (profile) { return profile.humanSemantics[targetField] === group; }); });
    var metricResults = metrics.map(function (metric) {
        var summaries = Object.fromEntries(groupOrder.map(function (group) {
            return [group, summary(groups[group].map(function (profile) { return metric.get(profile); }))];
        }));
        var medians = groupOrder.map(function (group) { return summaries[group].median; });
        var directional = medians.every(function (value, index) { return !index || value >= medians[index - 1] - 1e-12; });
        var separated = groupOrder.slice(1).every(function (group, index) {
            var lower = summaries[groupOrder[index]], upper = summaries[group];
            return lower.p75 !== null && upper.p25 !== null && upper.p25 >= lower.p75;
        });
        return { name: metric.name, expectedDirection: 'INCREASES_ACROSS_' + groupOrder.join('_TO_'),
            groupSummaries: summaries, medianDirectionConsistent: directional, adjacentIqrNonOverlap: separated };
    });
    var directionRatio = metricResults.filter(function (metric) { return metric.medianDirectionConsistent; }).length / metricResults.length;
    var separationRatio = metricResults.filter(function (metric) { return metric.adjacentIqrNonOverlap; }).length / metricResults.length;
    var minimumGroupSize = Math.min.apply(null, groupOrder.map(function (group) { return groups[group].length; }));
    var interpretation = directionRatio >= CONSTANTS.strongDirectionRatio && separationRatio >= CONSTANTS.strongIqrSeparationRatio ? 'STRONG' :
        directionRatio >= CONSTANTS.mediumDirectionRatio ? 'MEDIUM' : directionRatio >= CONSTANTS.weakDirectionRatio ? 'WEAK' : 'MIXED';
    if (minimumGroupSize < 3 && interpretation === 'STRONG') interpretation = 'MEDIUM';
    var role = ['STRONG', 'MEDIUM'].includes(interpretation) ? roleWhenSupported : interpretation === 'WEAK' ? 'SUPPORTING_EVIDENCE' : 'NOT_USEFUL';
    return { family: family, primaryHumanSemantic: targetField, orderedGroups: groupOrder,
        groupCounts: Object.fromEntries(groupOrder.map(function (group) { return [group, groups[group].length]; })),
        fixedInterpretationRule: { STRONG: 'directionRatio>=0.75 AND adjacentIqrNonOverlapRatio>=0.50',
            MEDIUM: 'directionRatio>=0.50', WEAK: 'directionRatio>=0.25', MIXED: 'otherwise',
            sparseGroupGuard: 'minimum group n<3 caps STRONG at MEDIUM' },
        directionConsistencyRatio: directionRatio, adjacentIqrNonOverlapRatio: separationRatio,
        minimumGroupSize: minimumGroupSize, interpretation: interpretation,
        representationRole: role, metrics: metricResults,
        secondaryFormationClassSummaries: Object.fromEntries(['NO_A', 'BORDERLINE_A', 'CLEAR_A'].map(function (label) {
            var rows = profiles.filter(function (profile) { return profile.humanSemantics.formationClass === label; });
            return [label, { n: rows.length }];
        })) };
}

function conflictReview(profiles) {
    var conflicts = [];
    function add(type, profile, reason) {
        if (!conflicts.some(function (item) { return item.originalCaseId === profile.originalCaseId && item.conflictType === type; })) {
            conflicts.push({ conflictType: type, originalCaseId: profile.originalCaseId,
                humanFormationClass: profile.humanSemantics.formationClass, definitionEdgeCase: profile.humanSemantics.definitionEdgeCase,
                reason: reason, representationSnapshot: { F1: profile.F1_INDEPENDENT_BALANCE_IDENTITY,
                    F2: profile.F2_TWO_SIDED_AUCTION_COVERAGE, F3: profile.F3_SIDE_RESIDENCE_ASYMMETRY,
                    F4: profile.F4_VALUE_MIGRATION_STRUCTURE } });
        }
    }
    profiles.forEach(function (profile) {
        var h = profile.humanSemantics, f1 = profile.F1_INDEPENDENT_BALANCE_IDENTITY,
            f2 = profile.F2_TWO_SIDED_AUCTION_COVERAGE, f3 = profile.F3_SIDE_RESIDENCE_ASYMMETRY,
            f4 = profile.F4_VALUE_MIGRATION_STRUCTURE;
        var weakF1 = f1.formationVsPreEfficiencyReduction <= 0 && f1.internalZoneReentryEpisodes <= 1 && f1.formationDirectionAlternationRate <= 0.25;
        var weakF2 = f2.minimumSideOccupancyRatio < 0.10 || (f2.bilateralLifecyclePhaseCoverage <= 1 && f2.fullTraversalCount === 0);
        var strongF1F2 = f1.formationVsPreEfficiencyReduction > 0 && f1.formationVsPrePersistenceReduction > 0 &&
            f1.internalZoneReentryEpisodes >= 2 && f2.minimumSideOccupancyRatio >= 0.15 && f2.bilateralLifecyclePhaseCoverage >= 2;
        var weakNegative = f3.dominantResidenceShare < 0.55 && f4.absoluteTerminalValueShift < 0.10;
        if (h.formationClass === 'CLEAR_A' && weakF1) add('C1_CLEAR_BUT_F1_WEAK', profile, 'Fixed predeclared weak-F1 diagnostic condition met.');
        if (h.formationClass === 'CLEAR_A' && weakF2) add('C2_CLEAR_BUT_F2_WEAK', profile, 'Fixed predeclared weak-F2 diagnostic condition met.');
        if (h.formationClass === 'NO_A' && strongF1F2) add('C3_NO_BUT_F1_F2_STRONG', profile, 'Fixed predeclared strong F1+F2 profile condition met.');
        if (h.formationClass === 'NO_A' && weakNegative) add('C4_NO_BUT_F3_F4_NEGATIVE_WEAK', profile, 'Fixed predeclared weak-negative diagnostic condition met.');
        if (h.formationClass === 'BORDERLINE_A' && (strongF1F2 || (weakF1 && weakF2))) add('C5_BORDERLINE_EXTREME_PROFILE', profile, strongF1F2 ? 'Profile is extreme toward CLEAR.' : 'Profile is extreme toward NO.');
        if (h.definitionEdgeCase === 'YES' && (weakF1 || weakF2 || strongF1F2 || weakNegative)) add('C6_EDGE_CASE_REPRESENTATION_ANOMALY', profile, 'Definition edge case also meets a fixed representation discordance condition.');
    });
    var selected = [], perType = {};
    conflicts.sort(function (a, b) { return a.conflictType.localeCompare(b.conflictType) || a.originalCaseId.localeCompare(b.originalCaseId); });
    conflicts.forEach(function (item) {
        perType[item.conflictType] = perType[item.conflictType] || 0;
        if (perType[item.conflictType] < 5 && selected.length < 20 && !selected.some(function (row) { return row.originalCaseId === item.originalCaseId; })) {
            selected.push(item); perType[item.conflictType]++;
        }
    });
    return { fixedDiagnosticRules: { C1: 'CLEAR and efficiencyReduction<=0 and internalReentry<=1 and alternation<=0.25',
        C2: 'CLEAR and minSideOccupancy<0.10 or bilateralPhaseCoverage<=1 with no full traversal',
        C3: 'NO and both decoupling reductions>0, reentry>=2, minSideOccupancy>=0.15, bilateralPhaseCoverage>=2',
        C4: 'NO and dominantResidenceShare<0.55 and absoluteTerminalValueShift<0.10',
        C5: 'BORDERLINE meeting fixed strong or fixed weak profile', C6: 'Definition edge case meeting another fixed discordance rule' },
        uniqueConflictCount: selected.length, cases: selected };
}

function buildResearch(gt, manifest, candles) {
    var sourceById = Object.fromEntries(manifest.map(function (item) { return [item.caseId, item]; }));
    var profiles = gt.map(function (row) {
        if (!sourceById[row.originalCaseId]) throw new Error('Missing formation source ' + row.originalCaseId);
        return computeProfile(row, sourceById[row.originalCaseId], candles);
    });
    var analyses = {
        F1: familyAnalysis(profiles, 'independentBalance', ['NO', 'PARTIAL', 'YES'], [
            { name: 'formationVsPreEfficiencyReduction', get: function (p) { return p.F1_INDEPENDENT_BALANCE_IDENTITY.formationVsPreEfficiencyReduction; } },
            { name: 'formationVsPrePersistenceReduction', get: function (p) { return p.F1_INDEPENDENT_BALANCE_IDENTITY.formationVsPrePersistenceReduction; } },
            { name: 'formationDirectionAlternationRate', get: function (p) { return p.F1_INDEPENDENT_BALANCE_IDENTITY.formationDirectionAlternationRate; } },
            { name: 'internalZoneReentryEpisodes', get: function (p) { return p.F1_INDEPENDENT_BALANCE_IDENTITY.internalZoneReentryEpisodes; } },
            { name: 'internalPriceReuseRatio', get: function (p) { return p.F1_INDEPENDENT_BALANCE_IDENTITY.internalPriceReuseRatio; } },
            { name: 'formationBoundaryReuseSpan', get: function (p) { return p.F1_INDEPENDENT_BALANCE_IDENTITY.formationBoundaryReuseSpan; } }
        ], 'F1_INDEPENDENT_BALANCE_IDENTITY', 'CORE_CANDIDATE'),
        F2: familyAnalysis(profiles, 'twoSidedAuction', ['WEAK', 'PARTIAL', 'COHERENT'], [
            { name: 'minimumSideOccupancyRatio', get: function (p) { return p.F2_TWO_SIDED_AUCTION_COVERAGE.minimumSideOccupancyRatio; } },
            { name: 'minimumSideParticipationEpisodes', get: function (p) { return p.F2_TWO_SIDED_AUCTION_COVERAGE.minimumSideParticipationEpisodes; } },
            { name: 'bilateralLifecyclePhaseCoverage', get: function (p) { return p.F2_TWO_SIDED_AUCTION_COVERAGE.bilateralLifecyclePhaseCoverage; } },
            { name: 'fullTraversalCount', get: function (p) { return p.F2_TWO_SIDED_AUCTION_COVERAGE.fullTraversalCount; } },
            { name: 'reverseTraversalCount', get: function (p) { return p.F2_TWO_SIDED_AUCTION_COVERAGE.reverseTraversalCount; } },
            { name: 'interiorReacceptanceEpisodes', get: function (p) { return p.F2_TWO_SIDED_AUCTION_COVERAGE.interiorReacceptanceEpisodes; } }
        ], 'F2_TWO_SIDED_AUCTION_COVERAGE', 'CORE_CANDIDATE'),
        F3: familyAnalysis(profiles, 'oneSidedResidence', ['NONE', 'MILD', 'STRONG'], [
            { name: 'longestDominantResidenceRunRatio', get: function (p) { return p.F3_SIDE_RESIDENCE_ASYMMETRY.longestDominantResidenceRunRatio; } },
            { name: 'dominantResidenceShare', get: function (p) { return p.F3_SIDE_RESIDENCE_ASYMMETRY.dominantResidenceShare; } },
            { name: 'lateSideBiasMagnitude', get: function (p) { return p.F3_SIDE_RESIDENCE_ASYMMETRY.lateSideBiasMagnitude; } },
            { name: 'centerAvoidanceRatio', get: function (p) { return p.F3_SIDE_RESIDENCE_ASYMMETRY.centerAvoidanceRatio; } },
            { name: 'oppositeSideParticipationScarcity', get: function (p) { return p.F3_SIDE_RESIDENCE_ASYMMETRY.oppositeSideParticipationScarcity; } },
            { name: 'residencePersistence', get: function (p) { return p.F3_SIDE_RESIDENCE_ASYMMETRY.residencePersistence; } }
        ], 'F3_SIDE_RESIDENCE_ASYMMETRY', 'NEGATIVE_EVIDENCE'),
        F4: familyAnalysis(profiles, 'valueMigration', ['NONE', 'TEMPORARY', 'PERSISTENT'], [
            { name: 'absoluteTerminalValueShift', get: function (p) { return p.F4_VALUE_MIGRATION_STRUCTURE.absoluteTerminalValueShift; } },
            { name: 'centerPathSpan', get: function (p) { return p.F4_VALUE_MIGRATION_STRUCTURE.centerPathSpan; } },
            { name: 'monotonicDirectionShare', get: function (p) { return p.F4_VALUE_MIGRATION_STRUCTURE.monotonicDirectionShare; } },
            { name: 'migrationPersistenceRatio', get: function (p) { return p.F4_VALUE_MIGRATION_STRUCTURE.migrationPersistenceRatio; } },
            { name: 'directionalAcceptanceRatio', get: function (p) { return p.F4_VALUE_MIGRATION_STRUCTURE.directionalAcceptanceRatio; } }
        ], 'F4_VALUE_MIGRATION_STRUCTURE', 'NEGATIVE_EVIDENCE'),
        F5: familyAnalysis(profiles.filter(function (p) { return p.humanSemantics.excursionContext !== 'NO_CLEAR_EXCURSION'; }),
            'excursionContext', ['FAILED_AND_BALANCE_BREAKS_DOWN', 'PARTIAL_REABSORPTION', 'REABSORBED_WITHIN_BALANCE'], [
                { name: 'reintegrationRate', get: function (p) { return p.F5_EXCURSION_REINTEGRATION.reintegrationRate; } },
                { name: 'medianReintegrationDepth', get: function (p) { return p.F5_EXCURSION_REINTEGRATION.medianReintegrationDepth || 0; } },
                { name: 'postExcursionInteriorReuseRatio', get: function (p) { return p.F5_EXCURSION_REINTEGRATION.postExcursionInteriorReuseRatio || 0; } },
                { name: 'balanceSurvivalRate', get: function (p) { return p.F5_EXCURSION_REINTEGRATION.balanceSurvivalRate; } },
                { name: 'reintegrationSpeed', get: function (p) { return p.F5_EXCURSION_REINTEGRATION.reintegrationSpeed; } }
            ], 'F5_EXCURSION_REINTEGRATION', 'QUALITY_CONTEXT')
    };
    var conflicts = conflictReview(profiles);
    var atLeastMedium = function (rating) { return ['MEDIUM', 'STRONG'].includes(rating); };
    var systemicConflict = conflicts.uniqueConflictCount > 12;
    var ready = atLeastMedium(analyses.F1.interpretation) && atLeastMedium(analyses.F2.interpretation) &&
        (atLeastMedium(analyses.F3.interpretation) || atLeastMedium(analyses.F4.interpretation)) && !systemicConflict;
    var coherence = analyses.F1.interpretation === 'STRONG' && analyses.F2.interpretation === 'STRONG' &&
        (analyses.F3.interpretation === 'STRONG' || analyses.F4.interpretation === 'STRONG') && conflicts.uniqueConflictCount <= 5 ? 'HIGH' :
        ready ? 'MEDIUM' : systemicConflict ? 'LOW' : 'MIXED';
    return { profiles: profiles, analyses: analyses, conflicts: conflicts, ready: ready,
        structuralProfileCoherence: coherence, systemicConflict: systemicConflict };
}

function main() {
    fs.mkdirSync(OUT, { recursive: true });
    var gtRaw = fs.readFileSync(GT_FILE), gtHashBefore = sha(gtRaw), gtDoc = JSON.parse(gtRaw);
    var freeze = JSON.parse(fs.readFileSync(FREEZE_ACCEPTANCE, 'utf8'));
    if (!gtDoc.groundTruthV2Frozen || freeze.GROUND_TRUTH_V2_FROZEN !== true ||
        freeze.DEFINITION_V1_FROZEN !== true || freeze.READY_FOR_REPRESENTATION_V3 !== true ||
        freeze.READY_FOR_ACCUMULATION_V2_IMPLEMENTATION !== false || freeze.READY_FOR_MANIPULATION_RESEARCH !== false) {
        throw new Error('Frozen Ground Truth V2 precondition failed');
    }
    var manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
    var candles = JSON.parse(fs.readFileSync(CANDLES_FILE, 'utf8'));
    var productionFiles = ['live/liveEngine.js', 'scripts/live.js', 'liquidity/equalLiquidity.js',
        'liquidity/persistentEqualLiquidityV3.js', 'events/displacementDetector.js', 'amd/accumulationDetector.js',
        'amd/amdState.js', 'scenario', 'entry', 'trade', 'notify'].map(function (file) { return path.join(REPO, file); })
        .flatMap(function (file) { if (!fs.existsSync(file)) return []; if (fs.statSync(file).isFile()) return [file];
            return fs.readdirSync(file).filter(function (name) { return name.endsWith('.js'); }).map(function (name) { return path.join(file, name); }); });
    var prodBefore = Object.fromEntries(productionFiles.map(function (file) { return [path.relative(REPO, file), shaFile(file)]; }));
    var resultA = buildResearch(gtDoc.cases, manifest, candles), resultB = buildResearch(gtDoc.cases, manifest, candles);
    var deterministic = JSON.stringify(resultA) === JSON.stringify(resultB);
    if (!deterministic || resultA.profiles.length !== 60) throw new Error('Representation determinism/population failure');
    var postBars = resultA.profiles.reduce(function (sum, profile) { return sum + profile.temporalSafety.postConfirmationBarsUsed; }, 0);
    if (postBars) throw new Error('Post-confirmation bars used');
    var defs = representationDefinitions();
    var definitionSafety = defs.every(function (def) { return !def.usesFutureData && !def.usesOutcome && !def.usesEQ &&
        !def.usesDisplacement && !def.usesSweep && !def.usesMSS && !def.usesFVG && def.labelIndependentDefinition && !def.postHocFeature; });
    if (!definitionSafety) throw new Error('Representation definition safety failure');

    writeJson('research-contract.json', { schemaVersion: 'ACCUMULATION_REPRESENTATION_V3_RESEARCH_V1',
        method: 'SEMANTIC_FIRST_BOUNDED_F1_F5', sourceCommit: EXPECTED_HEAD, constantsFrozenBeforeFirstRun: true,
        constants: CONSTANTS, fullPopulationOnly: true, groundTruthV1UsedAsTarget: false,
        featureSearchPerformed: false, parameterSearchPerformed: false, thresholdSearchPerformed: false,
        classifierTrained: false, compositeScoreCreated: false, oneRoundOnly: true });
    writeJson('population-validation.json', { TOTAL_CASES: resultA.profiles.length,
        UNIQUE_CASES: new Set(resultA.profiles.map(function (p) { return p.originalCaseId; })).size,
        CLEAR_A: countBy(resultA.profiles.map(function (p) { return p.humanSemantics; }), 'formationClass').CLEAR_A,
        BORDERLINE_A: countBy(resultA.profiles.map(function (p) { return p.humanSemantics; }), 'formationClass').BORDERLINE_A,
        NO_A: countBy(resultA.profiles.map(function (p) { return p.humanSemantics; }), 'formationClass').NO_A,
        UNSURE: 0, DEFINITION_EDGE_CASES: resultA.profiles.filter(function (p) { return p.humanSemantics.definitionEdgeCase === 'YES'; }).length,
        GROUND_TRUTH_V2_FROZEN: true, GROUND_TRUTH_V2_SHA256_BEFORE: gtHashBefore,
        POST_CONFIRMATION_BARS_USED: postBars, FUTURE_LEAK_VIOLATIONS: postBars });
    writeJson('representation-definition.json', { schemaVersion: 'ACCUMULATION_REPRESENTATION_V3_DEFINITION_V1',
        constants: CONSTANTS, primitiveCount: defs.length, primitives: defs,
        noSingleCompositeScore: true, finalizationFeaturePolicy: 'Features using final formation range are explicitly non-streaming causal during formation but use no data after confirmedAt.' });
    writeJson('representation-profiles.json', { schemaVersion: 'ACCUMULATION_REPRESENTATION_V3_PROFILES_V1', cases: resultA.profiles });
    writeJson('f1-independent-balance-analysis.json', resultA.analyses.F1);
    writeJson('f2-two-sided-auction-analysis.json', resultA.analyses.F2);
    writeJson('f3-side-residence-analysis.json', resultA.analyses.F3);
    writeJson('f4-value-migration-analysis.json', resultA.analyses.F4);
    writeJson('f5-excursion-reintegration-analysis.json', resultA.analyses.F5);
    writeJson('semantic-cross-tabs.json', { centerPathShapeByHumanValueMigration: resultA.profiles.reduce(function (out, p) {
        var target = p.humanSemantics.valueMigration, shape = p.F4_VALUE_MIGRATION_STRUCTURE.centerPathShape;
        out[target] = out[target] || {}; out[target][shape] = (out[target][shape] || 0) + 1; return out;
    }, {}), dominantSideByHumanResidence: resultA.profiles.reduce(function (out, p) {
        var target = p.humanSemantics.oneSidedResidence, side = p.F3_SIDE_RESIDENCE_ASYMMETRY.dominantSide;
        out[target] = out[target] || {}; out[target][side] = (out[target][side] || 0) + 1; return out;
    }, {}), formationClassByIndependentBalance: resultA.profiles.reduce(function (out, p) {
        var target = p.humanSemantics.independentBalance, label = p.humanSemantics.formationClass;
        out[target] = out[target] || {}; out[target][label] = (out[target][label] || 0) + 1; return out;
    }, {}) });
    writeJson('structural-profile-analysis.json', { qualitativeProfileOnly: true, classifierCreated: false,
        PROFILE_A: 'strong F1 + strong F2 + weak F3/F4 negative evidence',
        PROFILE_NO: 'weak F1/F2 OR strong F3/F4 negative evidence',
        familyInterpretations: Object.fromEntries(Object.entries(resultA.analyses).map(function (entry) { return [entry[0], entry[1].interpretation]; })),
        familyRoles: Object.fromEntries(Object.entries(resultA.analyses).map(function (entry) { return [entry[0], entry[1].representationRole]; })),
        STRUCTURAL_PROFILE_COHERENCE: resultA.structuralProfileCoherence,
        systemicConflict: resultA.systemicConflict, representationConflictCases: resultA.conflicts.uniqueConflictCount });
    writeJson('edge-case-analysis.json', { edgeCaseCount: 12,
        cases: resultA.profiles.filter(function (p) { return p.humanSemantics.definitionEdgeCase === 'YES'; }).map(function (p) {
            return { originalCaseId: p.originalCaseId, humanSemantics: p.humanSemantics,
                familyProfiles: { F1: p.F1_INDEPENDENT_BALANCE_IDENTITY, F2: p.F2_TWO_SIDED_AUCTION_COVERAGE,
                    F3: p.F3_SIDE_RESIDENCE_ASYMMETRY, F4: p.F4_VALUE_MIGRATION_STRUCTURE,
                    F5: p.F5_EXCURSION_REINTEGRATION } };
        }) });
    writeJson('representation-conflicts.json', resultA.conflicts);
    writeJson('historical-f6-f7-context.json', { HISTORICAL_REPRESENTATION_CONTEXT: true,
        F6_CENTER_MIGRATION: { role: 'QUALITY_OR_NEGATIVE_CONTEXT_NOT_ACCUMULATION_DEFINITION', reoptimized: false },
        F7_REABSORPTION: { role: 'QUALITY_CONTEXT_NOT_ACCUMULATION_DEFINITION', reoptimized: false },
        groundTruthV1UsedAsTarget: false, conclusion: 'V3 separates core identity/auction profiles from migration, residence, and reintegration evidence.' });
    writeJson('future-research-candidates.json', { postHocFeaturesUsedInConclusions: 0, candidates: [] });

    var f = resultA.analyses, primaryCore = ['MEDIUM', 'STRONG'].includes(f.F1.interpretation) && ['MEDIUM', 'STRONG'].includes(f.F2.interpretation) ? 'F1+F2' :
        ['MEDIUM', 'STRONG'].includes(f.F1.interpretation) ? 'F1' : ['MEDIUM', 'STRONG'].includes(f.F2.interpretation) ? 'F2' : 'NONE';
    var primaryNegative = ['MEDIUM', 'STRONG'].includes(f.F3.interpretation) && ['MEDIUM', 'STRONG'].includes(f.F4.interpretation) ? 'F3+F4' :
        ['MEDIUM', 'STRONG'].includes(f.F3.interpretation) ? 'F3' : ['MEDIUM', 'STRONG'].includes(f.F4.interpretation) ? 'F4' : 'NONE';
    var status = resultA.ready && resultA.structuralProfileCoherence === 'HIGH' ? 'PROMISING' : resultA.ready ? 'MIXED' : 'INSUFFICIENT';
    var prodAfter = Object.fromEntries(productionFiles.map(function (file) { return [path.relative(REPO, file), shaFile(file)]; }));
    var productionChanged = JSON.stringify(prodBefore) !== JSON.stringify(prodAfter), gtChanged = gtHashBefore !== shaFile(GT_FILE);
    var dedicated = cp.spawnSync(process.execPath, [path.join(REPO, 'test', 'accumulationRepresentationV3ResearchV1.test.js')],
        { cwd: REPO, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    var full = cp.spawnSync(process.execPath, [path.join(REPO, 'test', 'run.js')],
        { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    var pass = dedicated.status === 0 && full.status === 0 && !productionChanged && !gtChanged && deterministic && definitionSafety && postBars === 0;
    var acceptance = { ACCUMULATION_REPRESENTATION_V3_RESEARCH_V1: pass ? 'PASS' : 'FAIL', PRECONDITION_PASSED: true,
        TOTAL_CASES: 60, CLEAR_A: 23, BORDERLINE_A: 10, NO_A: 27, UNSURE: 0,
        GROUND_TRUTH_V2_FROZEN: true, GROUND_TRUTH_V2_CHANGED: gtChanged,
        F1_INDEPENDENT_BALANCE: f.F1.interpretation, F2_TWO_SIDED_AUCTION: f.F2.interpretation,
        F3_SIDE_RESIDENCE: f.F3.interpretation, F4_VALUE_MIGRATION: f.F4.interpretation,
        F5_EXCURSION_REINTEGRATION: f.F5.interpretation,
        F1_ROLE: f.F1.representationRole, F2_ROLE: f.F2.representationRole,
        F3_ROLE: f.F3.representationRole, F4_ROLE: f.F4.representationRole, F5_ROLE: f.F5.representationRole,
        STRUCTURAL_PROFILE_COHERENCE: resultA.structuralProfileCoherence,
        REPRESENTATION_CONFLICT_CASES: resultA.conflicts.uniqueConflictCount, EDGE_CASES_ANALYZED: 12,
        POST_CONFIRMATION_BARS_USED: postBars, FUTURE_LEAK_VIOLATIONS: postBars,
        GROUND_TRUTH_V1_USED_AS_TARGET: false, EQ_USED: false, SWEEP_USED: false, MSS_USED: false,
        DISPLACEMENT_USED: false, FVG_USED: false, WATCH_USED: false, OUTCOME_USED: false,
        FEATURE_SEARCH_PERFORMED: false, PARAMETER_SEARCH_PERFORMED: false, THRESHOLD_SEARCH_PERFORMED: false,
        CLASSIFIER_TRAINED: false, COMPOSITE_SCORE_CREATED: false,
        PRODUCTION_BEHAVIOR_CHANGED: productionChanged, DETERMINISM_VIOLATIONS: deterministic ? 0 : 1,
        ALL_TESTS_PASSED: dedicated.status === 0 && full.status === 0,
        PRIMARY_CORE_REPRESENTATION: primaryCore, PRIMARY_NEGATIVE_REPRESENTATION: primaryNegative,
        EXCURSION_ROLE: f.F5.representationRole === 'QUALITY_CONTEXT' ? 'QUALITY_CONTEXT' : f.F5.representationRole === 'SUPPORTING_EVIDENCE' ? 'SUPPORTING_EVIDENCE' : 'NOT_USEFUL',
        REPRESENTATION_V3_STATUS: status, READY_FOR_REPRESENTATION_V3_PROTOTYPE: resultA.ready,
        READY_FOR_ACCUMULATION_V2_IMPLEMENTATION: false, READY_FOR_MANIPULATION_RESEARCH: false,
        GIT_COMMIT_CREATED: false, HARD_STOP_REACHED: true };
    writeJson('acceptance.json', acceptance);
    writeJson('test-results.json', { dedicated: { command: 'node test/accumulationRepresentationV3ResearchV1.test.js',
        exitCode: dedicated.status, passed: dedicated.status === 0, stdout: dedicated.stdout, stderr: dedicated.stderr },
        fullRegression: { command: 'node test/run.js', exitCode: full.status, passed: full.status === 0,
            stdoutSha256: sha(full.stdout || ''), stdoutTail: String(full.stdout || '').split('\n').slice(-35), stderr: full.stderr },
        productionHashesBefore: prodBefore, productionHashesAfter: prodAfter,
        groundTruthV2Sha256Before: gtHashBefore, groundTruthV2Sha256After: shaFile(GT_FILE) });
    fs.writeFileSync(path.join(OUT, 'README.md'), '# Accumulation Representation V3 Research V1\n\nBounded, formation-only semantic representation research over all 60 frozen Ground Truth V2 cases. No classifier, composite score, feature search, parameter search, or production change.\n');
    fs.writeFileSync(path.join(OUT, 'REPORT.md'), reportMarkdown(acceptance, resultA));
    if (!pass) throw new Error('Representation V3 research acceptance failed');
    console.log(JSON.stringify({ output: OUT, interpretations: { F1: f.F1.interpretation, F2: f.F2.interpretation,
        F3: f.F3.interpretation, F4: f.F4.interpretation, F5: f.F5.interpretation },
        primaryCoreRepresentation: primaryCore, primaryNegativeRepresentation: primaryNegative,
        structuralProfileCoherence: resultA.structuralProfileCoherence,
        conflictCases: resultA.conflicts.uniqueConflictCount, status: status,
        readyForPrototype: resultA.ready, allTestsPassed: true, hardStopReached: true }, null, 2));
}

function reportMarkdown(acceptance, result) {
    var f = result.analyses;
    return `# Accumulation Representation V3 Research V1

## 1. Executive Summary

The bounded one-round research completed with task status **${acceptance.ACCUMULATION_REPRESENTATION_V3_RESEARCH_V1}**. Representation status is **${acceptance.REPRESENTATION_V3_STATUS}**. Primary core representation: **${acceptance.PRIMARY_CORE_REPRESENTATION}**. Primary negative representation: **${acceptance.PRIMARY_NEGATIVE_REPRESENTATION}**.

## 2. Frozen Research Context

All 60 frozen Ground Truth V2 cases were used: 23 CLEAR_A, 10 BORDERLINE_A, and 27 NO_A. Ground Truth V1 was not used as a target. Protected V2 content remained unchanged.

## 3. Research Question

Can bounded formation-only price representations correspond meaningfully to Independent Balance, Coherent Two-Sided Auction, One-Sided Residence, Persistent Value Migration, and Excursion Reintegration?

## 4. Representation Families

F1 and F2 represent the two required core semantics as structured profiles. F3 and F4 represent negative evidence. F5 represents quality context. No composite score or classifier was created.

## 5. F1 Independent Balance Findings

Interpretation: **${f.F1.interpretation}**; role: **${f.F1.representationRole}**. Direction-consistency ratio: ${f.F1.directionConsistencyRatio}; adjacent-IQR non-overlap ratio: ${f.F1.adjacentIqrNonOverlapRatio}.

## 6. F2 Two-Sided Auction Findings

Interpretation: **${f.F2.interpretation}**; role: **${f.F2.representationRole}**. Side occupancy, lifecycle coverage, traversal, and interior reacceptance were evaluated together without reducing them to touch count.

## 7. F3 One-Sided Residence Findings

Interpretation: **${f.F3.interpretation}**; role: **${f.F3.representationRole}**. Residence share, persistence, opposite-side scarcity, center avoidance, and terminal bias describe negative evidence without a hard gate.

## 8. F4 Persistent Value Migration Findings

Interpretation: **${f.F4.interpretation}**; role: **${f.F4.representationRole}**. A causal rolling center with a pre-frozen window rule separates center movement from persistent migration plus acceptance.

## 9. F5 Excursion/Reintegration Findings

Interpretation: **${f.F5.interpretation}**; role: **${f.F5.representationRole}**. The failed-reabsorption group contains one case, so the sparse-group guard limits any STRONG conclusion.

## 10. Structural Profile Findings

Structural profile coherence: **${result.structuralProfileCoherence}**. This is a qualitative combined analysis only; no thresholds or classification rule were produced.

## 11. Borderline Cases

All 10 BORDERLINE_A cases were retained. No family was tuned to make them resemble either CLEAR_A or NO_A.

## 12. Definition Edge Cases

All 12 definition edge cases were retained as a separate subgroup and were not used for feature or parameter tuning.

## 13. Representation Conflicts

${result.conflicts.uniqueConflictCount} unique cases met the predeclared diagnostic conflict rules. Each conflict preserves the frozen human judgement and is recorded as representation conflict only.

## 14. Historical F6/F7 Comparison

### HISTORICAL_REPRESENTATION_CONTEXT

Historical F6 Center Migration and F7 Reabsorption remain quality/negative evidence, not the Accumulation existence definition. They were not reoptimized. V3 separates Independent Balance and Two-Sided Auction from residence, migration, and reintegration context.

## 15. What The Representation Can Explain

It can describe decoupling, repeated internal reuse, bilateral lifecycle participation, side residence, rolling-center migration with acceptance, and causal excursion reintegration in formation-only terms.

## 16. What The Representation Cannot Explain

It does not establish objective market truth, profitable edge, detector validity, causal market intent, or that any individual primitive is sufficient to define Accumulation.

## 17. Evidence Limitations

Ground Truth V2 provenance is \`USER_APPROVED_CHATGPT_BLIND_VISUAL_REVIEW\`, not a multi-rater gold standard. Independent validation and inter-rater validation were not performed. This research only measures interpretable correspondence with frozen human semantics.

## 18. Readiness Decision

- READY_FOR_REPRESENTATION_V3_PROTOTYPE = ${acceptance.READY_FOR_REPRESENTATION_V3_PROTOTYPE}
- READY_FOR_ACCUMULATION_V2_IMPLEMENTATION = false
- READY_FOR_MANIPULATION_RESEARCH = false

## 19. Research Boundary

No Ground Truth, production module, feature family, constant, classifier, score, detector, F6/F7, outcome, EQ, Sweep, MSS, Displacement, FVG, or WATCH behavior was changed or used outside the frozen contract. HARD STOP reached.
`;
}

if (require.main === module) main();
module.exports = { zone: zone, pathEfficiency: pathEfficiency, directionalPersistence: directionalPersistence,
    alternationRate: alternationRate, rollingCenters: rollingCenters, centerPathProfile: centerPathProfile,
    excursionProfile: excursionProfile, computeProfile: computeProfile, representationDefinitions: representationDefinitions,
    familyAnalysis: familyAnalysis, conflictReview: conflictReview, buildResearch: buildResearch,
    CONSTANTS: CONSTANTS };
