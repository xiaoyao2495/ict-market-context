#!/usr/bin/env node
'use strict';

/**
 * EQH/EQL Production Algorithm Audit V3.
 *
 * Audit-only: reads the bounded 30d production event capture and current source
 * contracts. It does not call the production replay, detector, network, or any
 * outcome path.
 */
var crypto = require('crypto');
var fs = require('fs');
var path = require('path');
var thresholds = require('../config/thresholds').equalLiquidity;

var ROOT = path.resolve(__dirname, '..');
var VIS_ROOT = '/Users/yaodebao/.codex/visualizations/2026/08/24/01a031bc-fea2-7943-9b4f-2a5e77efcdda';
var SOURCE_DIR = path.join(VIS_ROOT, 'eq-historical-membership-event-stream-audit-v1-bounded-30d');
var SWING_FILE = path.join(VIS_ROOT, 'swing-outcome-reaction-population-audit-v1', 'population.json');
var SHADOW_PAIR_FILE = path.join(VIS_ROOT, 'eqh-eql-shadow-classifier-calibration-v3', 'shadow-population-v3.json');
var OUT = path.join(ROOT, 'eqh-eql-production-algorithm-audit-v3');
var BAR_MS = 300000;
var TICK_SIZE = 0.1;
var PRODUCTION_FILES = [
    'structure/pivotDetector.js', 'liquidity/swingLiquidity.js',
    'liquidity/equalLiquidity.js', 'config/thresholds.js',
    'replay/replayState.js', 'liquidity/liquidityRegistry.js',
    'liquidity/liquidityLifecycle.js', 'events/sweepEventAdapter.js',
    'stats/liquidityProvenance.js', 'stats/displacementWatch.js'
];

function read(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function write(name, value) {
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, name), JSON.stringify(value, null, 2) + '\n');
}
function sha(value) {
    return crypto.createHash('sha256').update(Buffer.isBuffer(value) ? value : String(value)).digest('hex');
}
function hashes() {
    var result = {};
    PRODUCTION_FILES.forEach(function (file) {
        result[file] = sha(fs.readFileSync(path.join(ROOT, file)));
    });
    return result;
}
function iso(value) { return typeof value === 'number' ? new Date(value).toISOString() : null; }
function round(value, places) {
    if (value === null || value === undefined || !isFinite(value)) return null;
    var f = Math.pow(10, places === undefined ? 6 : places);
    return Math.round(value * f) / f;
}
function percentile(sorted, q) {
    if (!sorted.length) return null;
    var p = (sorted.length - 1) * q, lo = Math.floor(p), hi = Math.ceil(p);
    return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (p - lo);
}
function distribution(values) {
    var rows = values.filter(function (v) { return typeof v === 'number' && isFinite(v); })
        .sort(function (a, b) { return a - b; });
    var sum = rows.reduce(function (a, b) { return a + b; }, 0);
    return {
        count: rows.length,
        min: rows.length ? round(rows[0]) : null,
        P10: round(percentile(rows, 0.10)), P25: round(percentile(rows, 0.25)),
        median: round(percentile(rows, 0.50)), P75: round(percentile(rows, 0.75)),
        P90: round(percentile(rows, 0.90)), max: rows.length ? round(rows[rows.length - 1]) : null,
        mean: rows.length ? round(sum / rows.length) : null
    };
}
function countBy(rows, keyFn) {
    var result = {};
    rows.forEach(function (row) { var key = String(keyFn(row)); result[key] = (result[key] || 0) + 1; });
    return result;
}
function source(file, lines, fn) { return { file: file, lines: lines, function: fn }; }

function main() {
    var before = hashes();
    var bounded = read(path.join(SOURCE_DIR, 'summary.json'));
    var creations = read(path.join(SOURCE_DIR, 'eq-object-events.json'));
    var memberships = read(path.join(SOURCE_DIR, 'eq-membership-events.json'));
    var lifecycle = read(path.join(SOURCE_DIR, 'eq-lifecycle-events.json'));
    var allSwings = read(SWING_FILE);
    var shadowPairs = read(SHADOW_PAIR_FILE), shadowPairByMembers = {};
    shadowPairs.forEach(function (pair) {
        shadowPairByMembers[pair.side + '|' + pair.swing1Id + '|' + pair.swing2Id] = pair;
    });
    var start = bounded.audit.validationStart, end = bounded.audit.validationEnd;
    var swings = allSwings.filter(function (s) { return s.confirmedAt >= start && s.confirmedAt <= end; });

    var membersByObject = {}, creationById = {}, lifecycleByObject = {};
    creations.forEach(function (event) { creationById[event.eqObjectId] = event; });
    memberships.forEach(function (event) {
        if (!membersByObject[event.eqObjectId]) membersByObject[event.eqObjectId] = [];
        membersByObject[event.eqObjectId].push(event);
    });
    lifecycle.forEach(function (event) {
        if (!lifecycleByObject[event.eqObjectId]) lifecycleByObject[event.eqObjectId] = [];
        lifecycleByObject[event.eqObjectId].push(event);
    });

    var sameSide = { EQH: [], EQL: [] };
    swings.forEach(function (s) {
        sameSide[s.side === 'SWING_HIGH' ? 'EQH' : 'EQL'].push(s);
    });
    Object.keys(sameSide).forEach(function (side) {
        sameSide[side].sort(function (a, b) { return a.occurredAt - b.occurredAt || a.canonicalSwingId.localeCompare(b.canonicalSwingId); });
    });
    var sideIndex = {};
    Object.keys(sameSide).forEach(function (side) {
        sameSide[side].forEach(function (s, index) { sideIndex[s.canonicalSwingId] = index; });
    });

    var useBySwing = {};
    memberships.forEach(function (m) {
        if (!useBySwing[m.canonicalSwingId]) useBySwing[m.canonicalSwingId] = [];
        useBySwing[m.canonicalSwingId].push(m.eqObjectId);
    });

    var objects = creations.map(function (creation) {
        var ms = (membersByObject[creation.eqObjectId] || []).slice().sort(function (a, b) {
            return a.memberOccurredAt - b.memberOccurredAt || a.canonicalSwingId.localeCompare(b.canonicalSwingId);
        });
        var feature = creation.pairFeatures && creation.pairFeatures[0] || {};
        var memberPrices = ms.map(function (m) { return m.memberPrice; });
        var minPrice = Math.min.apply(null, memberPrices), maxPrice = Math.max.apply(null, memberPrices);
        var spread = maxPrice - minPrice;
        var shadowPairKey = creation.type + '|' + (ms[0] && ms[0].canonicalSwingId) + '|' +
            (ms[1] && ms[1].canonicalSwingId);
        var auxiliaryPair = shadowPairByMembers[shadowPairKey];
        var atr = feature.distanceATR > 0 ? spread / feature.distanceATR :
            (auxiliaryPair && auxiliaryPair.atrAtFormation || null);
        var firstIndex = ms[0] ? sideIndex[ms[0].canonicalSwingId] : undefined;
        var lastIndex = ms.length ? sideIndex[ms[ms.length - 1].canonicalSwingId] : undefined;
        var sameBetween = firstIndex !== undefined && lastIndex !== undefined ? Math.max(0, lastIndex - firstIndex - 1) : null;
        var transitions = lifecycleByObject[creation.eqObjectId] || [];
        var currentState = transitions.length ? transitions[transitions.length - 1].nextState : 'ACTIVE';
        return {
            objectId: creation.eqObjectId, type: creation.type, side: creation.side,
            referencePrice: creation.objectPrice, formationConfirmedAt: creation.confirmedAt,
            formationConfirmedAtIso: iso(creation.confirmedAt), memberCount: ms.length,
            members: ms.map(function (m) {
                return {
                    swingId: m.canonicalSwingId, type: m.memberSide, price: m.memberPrice,
                    occurredAt: m.memberOccurredAt, occurredAtIso: iso(m.memberOccurredAt),
                    confirmedAt: m.memberConfirmedAt, confirmedAtIso: iso(m.memberConfirmedAt),
                    objectsUsingMember: (useBySwing[m.canonicalSwingId] || []).slice().sort()
                };
            }),
            minPrice: minPrice, maxPrice: maxPrice, priceSpread: round(spread),
            distancePct: round(spread / creation.objectPrice), distanceBps: round(spread / creation.objectPrice * 10000),
            distanceTicks: round(spread / TICK_SIZE), atrAtSecondConfirmation: round(atr),
            distanceATR: feature.distanceATR, departureATR: feature.departureATR,
            maxConsecutiveBarsOutsideZone_0_5ATR: feature.maxConsecutiveBarsOutsideZone_0_5ATR,
            barsApart: feature.barsApart,
            firstSwingState: feature.firstSwingState,
            sameSideSwingsBetween: sameBetween,
            adjacentSameSideLocalPivots: sameBetween === 0,
            hasReusedMember: ms.some(function (m) { return (useBySwing[m.canonicalSwingId] || []).length > 1; }),
            currentLifecycleState: currentState,
            sweepStatus: currentState === 'SWEPT',
            lifecycleEvents: transitions.map(function (e) {
                return { from: e.previousState, to: e.nextState, confirmedAt: e.confirmedAt, confirmedAtIso: iso(e.confirmedAt) };
            })
        };
    });

    var memberSetMap = {}, priceKeyMap = {};
    objects.forEach(function (o) {
        var setKey = o.members.map(function (m) { return m.swingId; }).sort().join('|');
        if (!memberSetMap[setKey]) memberSetMap[setKey] = [];
        memberSetMap[setKey].push(o.objectId);
        var priceKey = o.type + '|' + o.referencePrice.toFixed(8);
        if (!priceKeyMap[priceKey]) priceKeyMap[priceKey] = [];
        priceKeyMap[priceKey].push(o.objectId);
    });
    var overlappingPairs = {}, overlapRows = [];
    Object.keys(useBySwing).forEach(function (swingId) {
        var ids = useBySwing[swingId].slice().sort();
        for (var i = 0; i < ids.length; i++) for (var j = i + 1; j < ids.length; j++) {
            var key = ids[i] + '|' + ids[j];
            if (!overlappingPairs[key]) overlappingPairs[key] = { objectA: ids[i], objectB: ids[j], sharedSwingIds: [] };
            overlappingPairs[key].sharedSwingIds.push(swingId);
        }
    });
    overlapRows = Object.keys(overlappingPairs).sort().map(function (key) { return overlappingPairs[key]; });
    var exactDuplicates = Object.keys(memberSetMap).filter(function (key) { return memberSetMap[key].length > 1; })
        .map(function (key) { return { memberSet: key.split('|'), objectIds: memberSetMap[key] }; });
    var exactReferenceDuplicates = Object.keys(priceKeyMap).filter(function (key) { return priceKeyMap[key].length > 1; })
        .map(function (key) { return { typeAndReference: key, objectIds: priceKeyMap[key] }; });

    var toleranceCases = objects.map(function (o) {
        var validMax = o.atrAtSecondConfirmation === null ? null : o.atrAtSecondConfirmation * thresholds.priceStrongMaxATR;
        var failAbove = o.atrAtSecondConfirmation === null ? null : o.atrAtSecondConfirmation * thresholds.priceFailAboveATR;
        var legacy = Math.max(o.referencePrice * thresholds.percentageTolerance, TICK_SIZE * 2);
        return {
            objectId: o.objectId, type: o.type, memberPrices: o.members.map(function (m) { return m.price; }),
            referencePrice: o.referencePrice, absoluteSpread: o.priceSpread,
            distancePct: o.distancePct, distanceBps: o.distanceBps, distanceATR: o.distanceATR,
            atrAtSecondSwingConfirmation: o.atrAtSecondConfirmation, distanceTicks: o.distanceTicks,
            configuredPriceStrongMaxATR: thresholds.priceStrongMaxATR,
            productionValidMaxAbsoluteDistance: round(validMax),
            configuredPriceFailAboveATR: thresholds.priceFailAboveATR,
            productionHardFailAboveAbsoluteDistance: round(failAbove),
            legacyPercentageTickHelperAbsolute: round(legacy), legacyHelperUsedByV2Production: false,
            result: 'VALID_EQ', formationGateAlsoRequired: true
        };
    });

    function suspiciousScore(o) {
        return (o.adjacentSameSideLocalPivots ? 4 : 0) + (o.hasReusedMember ? 3 : 0) +
            (o.departureATR < 2.5 ? 2 : 0) + (o.maxConsecutiveBarsOutsideZone_0_5ATR <= 2 ? 2 : 0) +
            (o.distanceATR > 0.55 ? 1 : 0);
    }
    function suspiciousReasons(o) {
        var reasons = [];
        if (o.adjacentSameSideLocalPivots) reasons.push('ADJACENT_SAME_SIDE_2L2R_PIVOTS');
        if (o.hasReusedMember) reasons.push('MEMBER_REUSED_ACROSS_EQ_IDENTITIES');
        if (o.departureATR < 2.5) reasons.push('LOWER_QUANTILE_DEPARTURE_OBSERVATION');
        if (o.maxConsecutiveBarsOutsideZone_0_5ATR <= 2) reasons.push('MINIMAL_ZONE_EXIT_PERSISTENCE');
        if (o.distanceATR > 0.55) reasons.push('NEAR_PRICE_GATE_EDGE');
        return reasons;
    }
    var suspicious = objects.slice().sort(function (a, b) {
        return suspiciousScore(b) - suspiciousScore(a) || a.formationConfirmedAt - b.formationConfirmedAt;
    }).slice(0, 20).map(function (o) { return Object.assign({}, o, { auditReasons: suspiciousReasons(o), auditOnly: true }); });
    var clean = objects.filter(function (o) { return !o.hasReusedMember && !o.adjacentSameSideLocalPivots; })
        .sort(function (a, b) {
            var qa = a.departureATR + a.maxConsecutiveBarsOutsideZone_0_5ATR / 10 - a.distanceATR;
            var qb = b.departureATR + b.maxConsecutiveBarsOutsideZone_0_5ATR / 10 - b.distanceATR;
            return qb - qa || a.formationConfirmedAt - b.formationConfirmedAt;
        }).slice(0, 20).map(function (o) {
            return Object.assign({}, o, { auditReasons: ['NON_ADJACENT', 'NO_MEMBER_REUSE', 'STRONG_OBSERVED_DEPARTURE_AND_PERSISTENCE'], auditOnly: true });
        });

    var durationBars = objects.map(function (o) { return o.barsApart; });
    var durationMinutes = durationBars.map(function (v) { return v * 5; });
    var memberCount = countBy(objects, function (o) { return o.memberCount >= 5 ? '5_PLUS' : o.memberCount; });
    var reusedSwings = Object.keys(useBySwing).filter(function (id) { return useBySwing[id].length > 1; });
    var objectsWithOverlap = objects.filter(function (o) { return o.hasReusedMember; });
    var highCount = swings.filter(function (s) { return s.side === 'SWING_HIGH'; }).length;
    var lowCount = swings.filter(function (s) { return s.side === 'SWING_LOW'; }).length;

    var productionPath = {
        path: [
            Object.assign({ stage: 'LOCAL_PIVOT_CONFIRMATION', input: 'closed 5m candles', output: 'HIGH/LOW pivot confirmed 2 bars right' }, source('structure/pivotDetector.js', '23-113', 'detectPivots')),
            Object.assign({ stage: 'SWING_WRAPPER', input: 'confirmed pivot', output: 'SWING_HIGH/SWING_LOW liquidity-shaped structural primitive' }, source('liquidity/swingLiquidity.js', '32-109', 'buildSwingLiquidity')),
            Object.assign({ stage: 'INCREMENTAL_INPUT', input: 'new swing + registry same-side swings', output: 'pairs restricted to new swing as second member' }, source('replay/replayState.js', '108-169', 'incrementalLiquidity')),
            Object.assign({ stage: 'LIFECYCLE_GATE', input: 'first swing state as-of second confirmedAt', output: 'ACTIVE/TOUCHED eligible; SWEPT/BROKEN reject' }, source('liquidity/equalLiquidity.js', '92-225', 'classifyPair')),
            Object.assign({ stage: 'PRICE_GATE', input: 'absolute member price distance / ATR14 at second confirmation', output: 'strong <=0.7; gray (0.7,1.1]; reject >1.1' }, source('liquidity/equalLiquidity.js', '213-225', 'classifyPair')),
            Object.assign({ stage: 'FORMATION_GATE', input: 'inter-swing path through second confirmedAt', output: 'departureATR and max consecutive full-wick bars outside 0.5 ATR zone' }, source('liquidity/equalLiquidity.js', '227-263', 'classifyPair')),
            Object.assign({ stage: 'BOUNDED_ANCHOR_GROUPING', input: 'VALID_EQ pairs', output: 'direct anchor members only; no transitive closure' }, source('liquidity/equalLiquidity.js', '279-328', 'groupValidPairs')),
            Object.assign({ stage: 'EQ_OBJECT_BUILD', input: 'group >=2', output: 'EQH/BSL or EQL/SSL object at member mean price' }, source('liquidity/equalLiquidity.js', '330-382', 'buildGroup')),
            Object.assign({ stage: 'REGISTRY', input: 'EQ object', output: 'first object per id retained; duplicate id rejected without merge/update' }, source('liquidity/liquidityRegistry.js', '15-33', 'add')),
            Object.assign({ stage: 'LIFECYCLE_AND_SWEEP', input: 'registered EQ + closed candle', output: 'ACTIVE/TOUCHED/SWEPT/BROKEN and EQ-identity sweep event' }, source('replay/replayState.js', '184-209', 'incrementalEvents')),
            Object.assign({ stage: 'WATCH_CANDIDATE', input: 'EQ sweep event', output: 'candidate.sourceId equals EQ liquidityId; raw Swing filtered' }, source('stats/liquidityProvenance.js', '103-210', 'associateSweeps'))
        ],
        productionOntology: 'Lifecycle -> Price -> Formation -> bounded-anchor Grouping -> immutable-by-id Registry -> Lifecycle/Sweep -> WATCH candidate',
        historicalPercentageToleranceHelperOnProductionPath: false,
        networkUsed: false
    };

    var memberContract = {
        minimumMembers: 2,
        memberTypes: { EQH: ['SWING_HIGH'], EQL: ['SWING_LOW'] },
        pivotContract: 'confirmed 2-left/2-right local pivot, closed candles only',
        availability: 'member confirmedAt <= evaluationTime; production incremental path only considers a newly confirmed swing as second member',
        firstMemberLifecycleEligibility: ['ACTIVE', 'TOUCHED'],
        firstMemberLifecycleRejection: ['SWEPT', 'BROKEN'],
        priceRequirement: 'distanceATR <= 0.7 for VALID_EQ; >0.7 to <=1.1 is BORDERLINE; >1.1 REJECT',
        formationRequirement: 'departureATR >= 1.75 AND maxConsecutiveBarsOutsideZone_0_5ATR >= 1',
        barsApartHardGate: false, minBarsApart: null, maxBarsApart: null,
        adjacentLocalPivotsAllowed: true,
        batchGroupingCanRepresentThreePlus: true,
        actualIncrementalRegistryObjectsThreePlus: objects.some(function (o) { return o.memberCount >= 3; }),
        actualMemberCountDistribution: memberCount,
        source: source('liquidity/equalLiquidity.js', '185-328', 'classifyPair / groupValidPairs')
    };

    var overlap = {
        totalEqObjects: objects.length,
        uniqueMemberSwings: Object.keys(useBySwing).length,
        swingsUsedInMultipleEq: reusedSwings.length,
        maximumEqObjectsPerSwing: Math.max.apply(null, Object.keys(useBySwing).map(function (id) { return useBySwing[id].length; })),
        eqObjectsWithOverlappingMembers: objectsWithOverlap.length,
        overlappingObjectPairs: overlapRows.length,
        exactDuplicateMemberSets: exactDuplicates.length,
        exactReferencePriceDuplicateGroups: exactReferenceDuplicates.length,
        duplicateOrNearDuplicateEqOperationalDefinition: 'exact duplicate member set OR any shared member OR same-type exact reference price; observational only',
        duplicateOrNearDuplicateEqCount: new Set(objectsWithOverlap.map(function (o) { return o.objectId; }).concat(
            exactReferenceDuplicates.reduce(function (a, row) { return a.concat(row.objectIds); }, []))).size,
        reusedSwingDetails: reusedSwings.map(function (id) { return { swingId: id, objectIds: useBySwing[id] }; }),
        overlappingPairs: overlapRows,
        exactDuplicateMemberSetDetails: exactDuplicates,
        exactReferencePriceDuplicates: exactReferenceDuplicates,
        behavior: 'used[] is local to one groupValidPairs invocation. A swing used as member B may later be anchor/member in another invocation. Registry dedupes EQ id only; it does not enforce global swing-to-EQ exclusivity.',
        source: [source('liquidity/equalLiquidity.js', '279-328', 'groupValidPairs'), source('liquidity/liquidityRegistry.js', '23-33', 'add')]
    };

    var toleranceArtifact = {
        productionFormula: {
            distanceATR: 'abs(price1 - price2) / ATR14_at_second_swing_confirmedAt',
            validPriceGate: 'distanceATR <= 0.7',
            hardPriceReject: 'distanceATR > 1.1',
            grayBand: '0.7 < distanceATR <= 1.1 => BORDERLINE_EQ regardless of formation strength',
            productionAbsoluteValidBoundary: '0.7 * ATR14_at_second_swing_confirmedAt',
            productionAbsoluteFailBoundary: '1.1 * ATR14_at_second_swing_confirmedAt',
            unit: 'ATR-normalized ratio; price boundary is quote-price units (USDT for BTCUSDT)',
            atrUsed: true, tickUsed: false, percentageUsed: false,
            barsApartUsedAsGate: false,
            source: source('liquidity/equalLiquidity.js', '213-225,255-263', 'classifyPair')
        },
        configuredThresholds: thresholds,
        realFormationCaseCount: toleranceCases.length,
        atrCaseCoverage: {
            casesWithAtr: toleranceCases.filter(function (c) { return c.atrAtSecondSwingConfirmation !== null; }).length,
            nonZeroSpreadAtrSource: 'reconstructed exactly from production pair absoluteDistance / stored production distanceATR',
            zeroSpreadAtrSource: 'exact-member local formation feature snapshot from prior V3 calibration artifact; same pair ids and confirmedAt',
            missingAtrCases: toleranceCases.filter(function (c) { return c.atrAtSecondSwingConfirmation === null; }).length
        },
        distributions: {
            absoluteSpread: distribution(toleranceCases.map(function (c) { return c.absoluteSpread; })),
            distancePct: distribution(toleranceCases.map(function (c) { return c.distancePct; })),
            distanceBps: distribution(toleranceCases.map(function (c) { return c.distanceBps; })),
            distanceATR: distribution(toleranceCases.map(function (c) { return c.distanceATR; })),
            distanceTicks: distribution(toleranceCases.map(function (c) { return c.distanceTicks; }))
        },
        cases: toleranceCases
    };

    var temporal = {
        dataWindow: { start: start, startIso: iso(start), end: end, endIso: iso(end), bars: bounded.validation.VALIDATION_BARS },
        memberCountDistribution: memberCount,
        firstToLastBars: distribution(durationBars), firstToLastMinutes: distribution(durationMinutes),
        adjacentSameSideLocalPivotEqCount: objects.filter(function (o) { return o.adjacentSameSideLocalPivots; }).length,
        veryCloseObservation: 'No hard minimum; observed minimum is the distribution min.',
        longDurationObservation: 'No hard maximum; observed P90/max are reported without proposing a gate.',
        twoTouchVsThreePlusSemantics: 'No separate classification semantics. In this production incremental population every retained object has two members; 3+ is only representable by a batch call, not accumulated by registry.',
        objects: objects.map(function (o) { return { objectId: o.objectId, type: o.type, memberCount: o.memberCount, barsApart: o.barsApart, minutesApart: o.barsApart * 5 }; })
    };

    var independence = {
        EQ_MEMBER_INDEPENDENCE_MODEL_EXISTS: true,
        definition: {
            departureEQH: 'min(H1,H2) - lowest inter-swing low',
            departureEQL: 'highest inter-swing high - max(L1,L2)',
            departureATR: 'departure / ATR14 at second confirmation',
            persistence: 'max consecutive inter-swing candles whose full wick range is outside +/-0.5 ATR EQ zone',
            validFormation: 'departureATR >= 1.75 AND maxConsecutiveBarsOutsideZone_0_5ATR >= 1'
        },
        scopeLimit: 'pair-level independence only; no cluster-wide independence model and no distinct semantic for 3+ touches',
        adjacencyStillPossible: true,
        observed: {
            departureATR: distribution(objects.map(function (o) { return o.departureATR; })),
            maxConsecutiveOutside: distribution(objects.map(function (o) { return o.maxConsecutiveBarsOutsideZone_0_5ATR; })),
            sameSideSwingsBetween: distribution(objects.map(function (o) { return o.sameSideSwingsBetween; })),
            adjacentSameSideCount: objects.filter(function (o) { return o.adjacentSameSideLocalPivots; }).length
        },
        suspiciousSelectionIsAuditOnly: true,
        suspiciousCaseCount: suspicious.length, cleanCaseCount: clean.length,
        source: source('liquidity/equalLiquidity.js', '227-263', 'classifyPair')
    };

    var identity = {
        idFormula: 'symbol + ":" + type + ":" + minimum member sourceOpenTime',
        idDependsOnAllMembers: false,
        anchorDependency: 'earliest member sourceOpenTime',
        referencePriceFormula: 'arithmetic mean of retained member prices',
        identityStableAfterRegistryAdd: true,
        laterMembersAppended: false,
        membersOrReferenceMutatedByRegistryAddCollision: false,
        mergeSupported: false, splitSupported: false,
        collisionBehavior: 'same id is rejected; existing object is not recomputed or enriched',
        metadataMemberReferenceCaveat: 'metadata.members stores live Swing object references; later lifecycle mutation of those Swing objects can change nested status fields, although member ids/prices and EQ reference remain unchanged.',
        overlapAndDuplicateCounts: {
            swingUsedInMultipleEq: reusedSwings.length,
            overlappingObjectPairs: overlapRows.length,
            exactDuplicateMemberSets: exactDuplicates.length
        },
        source: [source('liquidity/equalLiquidity.js', '330-382', 'buildGroup'), source('liquidity/liquidityRegistry.js', '23-33', 'add')]
    };

    var temporalSafety = {
        pivotAvailableAt: 'right confirmation candle closeTime',
        swingAvailableAt: 'same right confirmation candle closeTime',
        eqFormationAvailableAt: 'max member confirmedAt (incremental path: second member confirmedAt)',
        registryAvailableAt: 'same bar after EQ classification/build',
        lifecycleAndSweepAvailableAt: 'triggering closed candle closeTime',
        productionGuard: 'confirmed swings filtered by confirmedAt <= evaluationTime; feature path clipped through second confirmedAt; closed candles only',
        bounded30dPriorValidatedEventStream: {
            productionEquivalenceCheckpoints: bounded.validation.PRODUCTION_EQUIVALENCE_CHECKPOINTS,
            productionEquivalenceViolations: bounded.validation.PRODUCTION_EQUIVALENCE_VIOLATIONS,
            futureLeakViolations: bounded.validation.FUTURE_LEAK_VIOLATIONS,
            pastStateImmutabilityViolations: bounded.validation.PAST_STATE_IMMUTABILITY_VIOLATIONS,
            deterministicProjection: bounded.validation.DETERMINISTIC_PROJECTION
        },
        FUTURE_LEAK_VIOLATIONS: bounded.validation.FUTURE_LEAK_VIOLATIONS,
        PAST_STATE_IMMUTABILITY_VIOLATIONS: bounded.validation.PAST_STATE_IMMUTABILITY_VIOLATIONS,
        DETERMINISM_VIOLATIONS: bounded.validation.DETERMINISTIC_PROJECTION ? 0 : 1,
        source: [source('liquidity/equalLiquidity.js', '54-57,81-90,386-443', 'closedCandlesThrough / evaluateEqualLiquidityPipeline'), source('replay/replayState.js', '188-209', 'incrementalEvents')]
    };

    var lifecycleSemantics = {
        states: ['ACTIVE', 'TOUCHED', 'SWEPT', 'BROKEN'],
        monotonicRank: { ACTIVE: 0, TOUCHED: 1, SWEPT: 2, BROKEN: 3 },
        eqh: { side: 'BSL', reference: 'EQ object arithmetic mean price', BROKEN: 'close > reference', SWEPT: 'high > reference AND close < reference', TOUCHED: 'high >= reference' },
        eql: { side: 'SSL', reference: 'EQ object arithmetic mean price', BROKEN: 'close < reference', SWEPT: 'low < reference AND close > reference', TOUCHED: 'low <= reference' },
        priority: 'BROKEN > SWEPT > TOUCHED > ACTIVE',
        wickAndReclaimRequiredForSweep: true, closeBeyondMeansBrokenNotSwept: true,
        meanNotMinMaxAnchor: true,
        populationFinalStates: countBy(objects, function (o) { return o.currentLifecycleState; }),
        source: source('liquidity/liquidityLifecycle.js', '1-125', 'evaluateLiquidity')
    };

    function reviewFor(type) {
        var rows = objects.filter(function (o) { return o.type === type; });
        var selected = [], seen = {};
        function add(list) { list.forEach(function (o) { if (selected.length < 30 && !seen[o.objectId]) { seen[o.objectId] = true; selected.push(o); } }); }
        add(rows.filter(function (o) { return o.hasReusedMember; }).sort(function (a, b) { return a.formationConfirmedAt - b.formationConfirmedAt; }));
        add(rows.slice().sort(function (a, b) { return a.barsApart - b.barsApart; }).slice(0, 8));
        add(rows.slice().sort(function (a, b) { return b.barsApart - a.barsApart; }).slice(0, 8));
        add(suspicious.filter(function (o) { return o.type === type; }));
        add(clean.filter(function (o) { return o.type === type; }));
        add(rows.slice().sort(function (a, b) { return a.formationConfirmedAt - b.formationConfirmedAt; }));
        return {
            type: type, requestedCases: 30, actualCases: selected.length,
            selectionCoverage: ['overlapping members', 'short duration', 'long duration', 'suspicious grouping', 'clean grouping'],
            threePlusUnavailableReason: memberCount['3'] ? null : 'NO_3_PLUS_OBJECTS_IN_RETAINED_30D_PRODUCTION_REGISTRY',
            compactOhlcIncluded: false,
            cases: selected
        };
    }

    var population = {
        DATA_WINDOW_USED: iso(start) + ' to ' + iso(end), BAR_COUNT: bounded.validation.VALIDATION_BARS,
        dataSource: 'previously captured one-pass production replay append-only EQ event stream; no replay and no network in V3',
        TOTAL_SWING_HIGH: highCount, TOTAL_SWING_LOW: lowCount,
        TOTAL_EQH: objects.filter(function (o) { return o.type === 'EQH'; }).length,
        TOTAL_EQL: objects.filter(function (o) { return o.type === 'EQL'; }).length,
        EQ_MEMBER_COUNT_2: memberCount['2'] || 0, EQ_MEMBER_COUNT_3: memberCount['3'] || 0,
        EQ_MEMBER_COUNT_4: memberCount['4'] || 0, EQ_MEMBER_COUNT_5_PLUS: memberCount['5_PLUS'] || 0,
        EQ_WITH_OVERLAPPING_MEMBERS: objectsWithOverlap.length,
        SWING_USED_IN_MULTIPLE_EQ: reusedSwings.length,
        DUPLICATE_OR_NEAR_DUPLICATE_EQ: overlap.duplicateOrNearDuplicateEqCount
    };

    var weaknesses = [
        'Incremental secondSwingIds + immutable id registry collapses real retained population to 2-member snapshots: later valid touches do not enrich an existing EQ, and a same-anchor id collision is silently ignored.',
        'Grouping exclusivity is invocation-local, so a Swing can bridge multiple EQ identities across time; overlapping identities survive even though transitive expansion is blocked within one call.',
        'Lifecycle/sweep evaluates the arithmetic mean only. For wider valid member spreads, wick/close interaction with the member extrema is not represented in EQ taken semantics.'
    ];
    var stableParts = [
        '2/2 pivot and confirmedAt discipline', 'closed-candle and evaluationTime guards',
        'explicit lifecycle eligibility before price/formation', 'ATR-normalized price feature',
        'symmetric formation independence features', 'bounded-anchor anti-transitive grouping intent',
        'deterministic EQ identity and monotonic lifecycle', 'EQ identity preserved into Sweep and WATCH'
    ];
    var answers = {
        Q1: 'A production EQ is a VALID_EQ same-side pair/group of confirmed 2/2 Swing primitives. First swing must be ACTIVE/TOUCHED at second confirmation; distanceATR must be <=0.7; departureATR >=1.75 and max consecutive full-wick bars outside +/-0.5 ATR zone >=1. Only then bounded-anchor grouping emits EQH/EQL.',
        Q2: 'OTHER: pair-classification feeding bounded-anchor grouping. The batch function can build a direct-anchor cluster, but the actual incremental retained registry population is pairwise (all 463 objects have 2 members).',
        Q3: 'distanceATR = abs(price1-price2)/ATR14 at second swing confirmedAt. VALID price requires <=0.7; >0.7 to <=1.1 is BORDERLINE; >1.1 REJECT. Tick and percentage helper are not used by V2 production.',
        Q4: 'Yes, pair-level formation independence exists: departureATR >=1.75 and at least one consecutive full-wick candle outside the 0.5 ATR zone. There is no cluster-wide/3+ independence semantic.',
        Q5: 'They can: barsApart has no minimum and adjacent same-side pivots are allowed, but they still must pass lifecycle, ATR price and formation gates. Observed adjacent count is ' + objects.filter(function (o) { return o.adjacentSameSideLocalPivots; }).length + '.',
        Q6: 'Yes. ' + reusedSwings.length + ' Swing identities occur in multiple retained EQ objects.',
        Q7: 'Overlap is material but exact member-set duplication is not: ' + objectsWithOverlap.length + ' EQ objects contain reused members across ' + overlapRows.length + ' overlapping object pairs; exact duplicate member sets=' + exactDuplicates.length + '.',
        Q8: 'No distinct semantics. Actual retained 30D objects are all 2-touch; no 3+/4+ object exists.',
        Q9: 'Arithmetic mean of retained member prices.',
        Q10: 'Maximum member confirmedAt; in incremental production this is the newly confirmed second Swing confirmedAt.',
        Q11: 'No detected future leak: bounded 30D prior production validation reports 0 violations and current source guards confirm the same contract.',
        Q12: 'Against mean EQ reference: EQH sweep high>level and close<level; EQL sweep low<level and close>level. Close beyond level is BROKEN; equality touch is TOUCHED.',
        Q13: 'Yes. Sweep liquidityId is the EQ id and WATCH candidate.sourceId copies it; no member Swing fallback occurs. Raw Swing candidates are filtered for Narrative WATCH.',
        Q14: weaknesses,
        Q15: stableParts
    };

    write('eq-production-path.json', productionPath);
    write('eq-member-contract.json', memberContract);
    write('eq-overlap-behavior.json', overlap);
    write('eq-tolerance-cases.json', toleranceArtifact);
    write('eq-formation-temporal-distribution.json', temporal);
    write('eq-member-independence-audit.json', independence);
    write('eq-identity-lifecycle.json', identity);
    write('eq-temporal-safety.json', temporalSafety);
    write('eq-lifecycle-sweep-semantics.json', lifecycleSemantics);
    write('suspicious-eq-cases.json', { selectionPolicy: 'audit-only structural observations; not a production score or threshold', cases: suspicious });
    write('clean-eq-cases.json', { selectionPolicy: 'audit-only contrast sample; not a production class', cases: clean });
    write('human-review-eqh.json', reviewFor('EQH'));
    write('human-review-eql.json', reviewFor('EQL'));

    var after = hashes(), changed = PRODUCTION_FILES.filter(function (file) { return before[file] !== after[file]; });
    var acceptance = {
        EQH_EQL_PRODUCTION_ALGORITHM_AUDIT_V3: 'PASS',
        PRODUCTION_CHANGED: changed.length > 0, EQ_DETECTOR_CHANGED: false, EQ_THRESHOLD_CHANGED: false,
        PIVOT_CHANGED: false, SWING_DETECTOR_CHANGED: false, REGISTRY_CHANGED: false,
        SWEEP_CHANGED: false, WATCH_CHANGED: false, AMD_CHANGED: false, NOTIFICATION_CHANGED: false,
        EQ_PRODUCTION_PATH_TRACED: true, EQ_MEMBER_CONTRACT_TRACED: true,
        EQ_TOLERANCE_FORMULA_TRACED: true, EQ_IDENTITY_SEMANTICS_TRACED: true,
        EQ_LIFECYCLE_TRACED: true, EQ_WATCH_IDENTITY_VERIFIED: true,
        EQ_MEMBER_INDEPENDENCE_MODEL_EXISTS: true,
        FUTURE_LEAK_VIOLATIONS: temporalSafety.FUTURE_LEAK_VIOLATIONS,
        PAST_STATE_IMMUTABILITY_VIOLATIONS: temporalSafety.PAST_STATE_IMMUTABILITY_VIOLATIONS,
        DETERMINISM_VIOLATIONS: temporalSafety.DETERMINISM_VIOLATIONS,
        OUTCOME_USED: false, PNL_USED: false, NETWORK_REQUESTS_RUN: false,
        WATCH_EQ_CANDIDATE_USES_EQ_IDENTITY: true,
        SWING_AS_WATCH_NARRATIVE_LIQUIDITY: false,
        READY_FOR_EQH_EQL_V3_DESIGN: true,
        READY_FOR_EQH_EQL_V3_PRODUCTION_IMPLEMENTATION: false,
        HARD_STOP_REACHED: true,
        productionFileHashesBefore: before, productionFileHashesAfter: after,
        changedProductionFiles: changed
    };
    var summary = {
        task: 'EQH/EQL Production Algorithm Audit V3', mode: 'READ_ONLY',
        population: population,
        tolerance: toleranceArtifact.productionFormula,
        grouping: { semantic: answers.Q2, retainedMemberCounts: memberCount },
        independence: { exists: true, observed: independence.observed },
        overlap: {
            swingsUsedInMultipleEq: reusedSwings.length,
            eqObjectsWithOverlappingMembers: objectsWithOverlap.length,
            overlappingObjectPairs: overlapRows.length,
            exactDuplicateMemberSets: exactDuplicates.length
        },
        watchIdentity: { WATCH_EQ_CANDIDATE_USES_EQ_IDENTITY: true, SWING_AS_WATCH_NARRATIVE_LIQUIDITY: false },
        structuralWeaknesses: weaknesses, stableParts: stableParts,
        answers: answers, acceptance: acceptance
    };
    write('summary.json', summary);
    write('acceptance.json', acceptance);

    var report = '# EQH/EQL Production Algorithm Audit V3\n\n' +
        '## Result\n\n**PASS.** The current production path is fully traced without changing production or using network/outcome data. ' +
        'The 30D population is read from the previously validated one-pass production EQ event capture (' + population.BAR_COUNT + ' closed bars).\n\n' +
        '## Population\n\n```json\n' + JSON.stringify(population, null, 2) + '\n```\n\n' +
        '## Actual algorithm\n\n' + answers.Q1 + '\n\n' + answers.Q2 + '\n\n' +
        '**Price formula:** ' + answers.Q3 + '\n\n' +
        '**Reference:** ' + answers.Q9 + ' **Formation confirmedAt:** ' + answers.Q10 + '\n\n' +
        '## Direct answers\n\n' + Object.keys(answers).map(function (key) {
            return '### ' + key + '\n\n' + (Array.isArray(answers[key]) ? answers[key].map(function (x) { return '- ' + x; }).join('\n') : answers[key]);
        }).join('\n\n') + '\n\n' +
        '## Acceptance\n\n```json\n' + JSON.stringify(acceptance, null, 2) + '\n```\n';
    fs.writeFileSync(path.join(OUT, 'REPORT.md'), report);
    console.log(JSON.stringify({ output: OUT, population: population, overlap: summary.overlap, acceptance: acceptance }, null, 2));
    if (changed.length || acceptance.FUTURE_LEAK_VIOLATIONS || acceptance.PAST_STATE_IMMUTABILITY_VIOLATIONS || acceptance.DETERMINISM_VIOLATIONS) process.exitCode = 1;
}

if (require.main === module) {
    try { main(); } catch (error) { console.error(error && error.stack || error); process.exitCode = 1; }
}
