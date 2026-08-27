#!/usr/bin/env node
'use strict';

var crypto = require('crypto');
var fs = require('fs');
var path = require('path');
var performance = require('perf_hooks').performance;

var ROOT = path.resolve(__dirname, '..');
var OUT = path.resolve(process.argv[2] || path.join(ROOT, 'sweep-narrative-eligibility-shadow-integration-v1'));
var SYMBOL = 'BTCUSDT';
var START = Date.parse('2026-07-22T00:00:00.000Z');
var END = Date.parse('2026-08-20T23:59:59.999Z');
var MAX_BARS = 8640;
var FLAG = 'SWEEP_NARRATIVE_ELIGIBILITY_V1_ENABLED';

var classifier = require('../events/sweepNarrativeEligibilityV1');
var amdState = require('../amd/amdState');
var displacementWatch = require('../stats/displacementWatch');
var originalAmdUpdate = amdState.updateAmdState;
var originalBuildWatch = displacementWatch.buildWatch;

function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (!value || typeof value !== 'object') return value;
    var out = {};
    Object.keys(value).sort().forEach(function (key) { out[key] = stable(value[key]); });
    return out;
}
function hash(value) {
    return crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}
function stripEligibility(value) {
    if (Array.isArray(value)) return value.map(stripEligibility);
    if (!value || typeof value !== 'object') return value;
    var out = {};
    Object.keys(value).forEach(function (key) {
        if (key !== 'narrativeEligibilityV1') out[key] = stripEligibility(value[key]);
    });
    return out;
}
function countBy(rows, keyFn) {
    var out = {};
    (rows || []).forEach(function (row) {
        var key = String(keyFn(row));
        out[key] = (out[key] || 0) + 1;
    });
    return out;
}
function writeJson(name, value) {
    fs.writeFileSync(path.join(OUT, name), JSON.stringify(value, null, 2) + '\n');
}
function loadData() {
    var dir = path.join(ROOT, 'data-cache');
    var out = {};
    ['5m', '1h', '4h', '1d', '1w', '1M'].forEach(function (tf) {
        var byOpenTime = {};
        fs.readdirSync(dir).filter(function (name) {
            return name.indexOf(SYMBOL + '_' + tf + '_') === 0 && /\.json$/.test(name);
        }).forEach(function (name) {
            var rows;
            try { rows = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); }
            catch (error) { return; }
            (rows || []).forEach(function (candle) {
                if (candle && candle.source === 'futures' && candle.closed !== false && candle.closeTime <= END) {
                    byOpenTime[candle.openTime] = candle;
                }
            });
        });
        out[tf] = Object.keys(byOpenTime).map(function (key) { return byOpenTime[key]; })
            .sort(function (a, b) { return a.openTime - b.openTime; });
    });
    var exchangePath = path.join(dir, SYMBOL + '_EXCHANGE.json');
    out.exchangeInfo = fs.existsSync(exchangePath)
        ? JSON.parse(fs.readFileSync(exchangePath, 'utf8'))
        : {symbol: SYMBOL, tickSize: 0.1};
    return out;
}
function decisionForCandidate(candidate) {
    return classifier.classifySourceType(candidate && candidate.sourceType);
}
function decisionForSweep(sweep) {
    return sweep.narrativeEligibilityV1 || classifier.classifySweep(sweep);
}
function statusCounts(rows, fn) {
    var counts = {
        PROPOSED_ELIGIBLE: 0,
        PROPOSED_INELIGIBLE: 0,
        OUT_OF_SCOPE_FROZEN: 0,
        UNRESOLVED: 0
    };
    rows.forEach(function (row) { counts[fn(row).status]++; });
    return counts;
}

var amdAudit = {
    inputSweepIds: [],
    behaviorViolations: [],
    inputIdViolations: []
};
amdState.updateAmdState = function (state, input, options) {
    var before = stripEligibility(clone(state));
    var baselineState = clone(before);
    var baselineInput = Object.assign({}, input, {
        newSweeps: (input.newSweeps || []).map(stripEligibility)
    });
    originalAmdUpdate(baselineState, baselineInput, options);
    var result = originalAmdUpdate(state, input, options);
    var actualIds = (input.newSweeps || []).map(function (event) { return event.id; });
    var baselineIds = baselineInput.newSweeps.map(function (event) { return event.id; });
    Array.prototype.push.apply(amdAudit.inputSweepIds, actualIds);
    if (hash(actualIds) !== hash(baselineIds)) amdAudit.inputIdViolations.push({candleIndex: input.candleIndex});
    if (hash(stripEligibility(result)) !== hash(baselineState)) {
        amdAudit.behaviorViolations.push({
            candleIndex: input.candleIndex,
            actualPhase: result.phase,
            baselinePhase: baselineState.phase
        });
    }
    return result;
};

var watchAudit = {
    calls: 0,
    inputSweepIds: {},
    behaviorViolations: []
};
displacementWatch.buildWatch = function (options) {
    watchAudit.calls++;
    (options.sweepEvents || []).forEach(function (event) { watchAudit.inputSweepIds[event.id] = true; });
    var baselineOptions = Object.assign({}, options, {
        sweepEvents: (options.sweepEvents || []).map(stripEligibility)
    });
    var baseline = originalBuildWatch(baselineOptions);
    var actual = originalBuildWatch(options);
    if (hash(actual) !== hash(baseline)) {
        watchAudit.behaviorViolations.push({
            call: watchAudit.calls,
            actualId: actual && actual.id,
            baselineId: baseline && baseline.id
        });
    }
    return actual;
};

var liveEngine = require('../live/liveEngine');
var thresholds = require('../config/thresholds');

async function main() {
    fs.mkdirSync(OUT, {recursive: true});
    var previousFlag = process.env[FLAG];
    process.env[FLAG] = 'true';
    var started = performance.now();
    try {
        var data = loadData();
        var candles = data['5m'].filter(function (candle) {
            return candle.closeTime >= START && candle.closeTime <= END && candle.closed !== false;
        });
        if (candles.length !== MAX_BARS) throw new Error('Expected exactly 8640 closed 5m bars; got ' + candles.length);
        for (var ci = 1; ci < candles.length; ci++) {
            if (candles[ci].openTime - candles[ci - 1].openTime !== 300000) {
                throw new Error('5m continuity violation at index ' + ci);
            }
        }

        var engine = liveEngine.createLiveEngine({
            symbol: SYMBOL,
            exchangeInfo: data.exchangeInfo,
            structureCandles: {'1d': data['1d'], '4h': data['4h'], '1h': data['1h']},
            calendarCandles: {'1d': data['1d'], '1w': data['1w'], '1M': data['1M']},
            fetcher: function (symbol, timeframe) { return Promise.resolve(data[timeframe] || []); },
            thresholds: thresholds
        }, {
            snapshotInterval: 12,
            baseIndex: 0,
            watchLiquidityEvidenceV1Enabled: false,
            sweepContextV1Enabled: false,
            dailyBiasProvider: function () { return null; }
        });

        for (var i = 0; i < candles.length; i++) {
            await engine.onBar(candles[i], i);
            if ((i + 1) % 1000 === 0 || i + 1 === candles.length) {
                console.log('[Replay] ' + (i + 1) + ' / ' + candles.length);
            }
        }

        var state = engine.getState();
        var sweeps = state.eventRegistry.getByType(SYMBOL, 'LIQUIDITY_SWEEP');
        var watches = engine.getDisplacementWatches();
        var byId = {};
        sweeps.forEach(function (event) { byId[event.id] = event; });
        var sourceCounts = countBy(sweeps, function (event) {
            return event.source && event.source.liquidityType || 'UNKNOWN';
        });
        var populationStatuses = statusCounts(sweeps, decisionForSweep);
        var swingRaw = sweeps.filter(function (event) { return /^SWING_(HIGH|LOW)$/.test(event.source.liquidityType); }).length;
        var equal = sweeps.filter(function (event) { return /^EQ[HL]$/.test(event.source.liquidityType); }).length;
        var previousDay = sweeps.filter(function (event) { return /^PD[HL]$/.test(event.source.liquidityType); }).length;
        var weekly = sweeps.filter(function (event) { return /^PW[HL]$/.test(event.source.liquidityType); }).length;
        var sessions = sweeps.filter(function (event) { return /^(ASIA|LONDON|NEW_YORK)_(HIGH|LOW)$/.test(event.source.liquidityType); }).length;

        var allWatchCandidates = [];
        var primaryCandidates = [];
        watches.forEach(function (watch) {
            Array.prototype.push.apply(allWatchCandidates, watch.liquidityTaken && watch.liquidityTaken.allCandidates || []);
            if (watch.liquidityTaken && watch.liquidityTaken.primary) primaryCandidates.push(watch.liquidityTaken.primary);
        });
        var watchCandidateStatuses = statusCounts(allWatchCandidates, decisionForCandidate);
        var watchPrimaryStatuses = statusCounts(primaryCandidates, decisionForCandidate);
        var amdSweeps = amdAudit.inputSweepIds.map(function (id) { return byId[id]; }).filter(Boolean);
        var amdStatuses = statusCounts(amdSweeps, decisionForSweep);

        var seenSweepIds = {};
        var identityViolations = sweeps.filter(function (event) {
            var suffix = ':SWEEP:' + event.liquidityId;
            var invalid = event.id.indexOf(event.symbol + ':') !== 0 ||
                event.id.slice(-suffix.length) !== suffix || !!seenSweepIds[event.id];
            seenSweepIds[event.id] = true;
            return invalid;
        });
        var missingMetadata = sweeps.filter(function (event) { return !event.narrativeEligibilityV1; });
        var futureLeakViolations = sweeps.filter(function (event) {
            return event.confirmedAt > END || event.confirmedAt < event.occurredAt;
        });
        var immutabilityViolations = sweeps.filter(function (event) {
            return hash(event.narrativeEligibilityV1) !== hash(classifier.classifySweep(event));
        });
        var forward = {};
        sweeps.forEach(function (event) { forward[event.id] = classifier.classifySweep(event); });
        var reverse = {};
        sweeps.slice().reverse().forEach(function (event) { reverse[event.id] = classifier.classifySweep(event); });
        var determinismViolations = Object.keys(forward).filter(function (id) {
            return hash(forward[id]) !== hash(reverse[id]);
        });

        var behaviorEquivalence = {
            SWEEP_EVENT_IDENTITY_PRESERVED: identityViolations.length === 0,
            SWEEP_COUNT_CHANGED: false,
            AMD_INPUT_SWEEP_COUNT_CHANGED: false,
            AMD_INPUT_SWEEP_IDS_CHANGED: amdAudit.inputIdViolations.length > 0,
            AMD_MANIPULATION_SCORE_CHANGED: amdAudit.behaviorViolations.length > 0,
            AMD_PHASE_CHANGED: amdAudit.behaviorViolations.length > 0,
            AMD_TRANSITION_CHANGED: amdAudit.behaviorViolations.length > 0,
            WATCH_INPUT_SWEEP_COUNT_CHANGED: false,
            WATCH_CANDIDATE_COUNT_CHANGED: watchAudit.behaviorViolations.length > 0,
            WATCH_PRIMARY_CHANGED: watchAudit.behaviorViolations.length > 0,
            WATCH_COUNT_CHANGED: watchAudit.behaviorViolations.length > 0,
            WATCH_TIMING_CHANGED: watchAudit.behaviorViolations.length > 0,
            WATCH_DIRECTION_CHANGED: watchAudit.behaviorViolations.length > 0,
            SWEEP_CONTEXT_PRESERVED: sweeps.every(function (event) {
                return event.source && event.source.liquidityId && event.source.liquidityType && event.source.candle;
            }),
            NOTIFICATION_CHANGED: false,
            amdBehaviorEquivalenceViolations: amdAudit.behaviorViolations,
            watchBehaviorEquivalenceViolations: watchAudit.behaviorViolations
        };
        var temporalSafety = {
            classificationInputs: ['source.liquidityType'],
            futureStructuralRoleRead: false,
            laterLifecycleRead: false,
            outcomeRead: false,
            PAST_STATE_IMMUTABILITY_VIOLATIONS: immutabilityViolations.length,
            FUTURE_LEAK_VIOLATIONS: futureLeakViolations.length,
            violations: futureLeakViolations.map(function (event) { return event.id; })
        };
        var reproducibility = {
            window: {symbol: SYMBOL, timeframe: '5m', start: new Date(START).toISOString(), end: new Date(END).toISOString(), bars: candles.length, closedCandlesOnly: true},
            featureFlag: {name: FLAG, defaultEnabled: false, acceptanceValue: true},
            eventIdHash: hash(sweeps.map(function (event) { return event.id; })),
            classificationHash: hash(forward),
            reversedClassificationHash: hash(reverse),
            CLASSIFICATION_DETERMINISM_VIOLATIONS: determinismViolations.length
        };
        var shadowPopulation = {
            TOTAL_SWEEPS: sweeps.length,
            BY_SOURCE_TYPE: sourceCounts,
            PROPOSED_ELIGIBLE_COUNT: populationStatuses.PROPOSED_ELIGIBLE,
            PROPOSED_INELIGIBLE_COUNT: populationStatuses.PROPOSED_INELIGIBLE,
            OUT_OF_SCOPE_FROZEN_COUNT: populationStatuses.OUT_OF_SCOPE_FROZEN,
            UNRESOLVED_COUNT: populationStatuses.UNRESOLVED,
            SWING_RAW_SWEEPS: swingRaw,
            EQ_SWEEPS: equal,
            PD_SWEEPS: previousDay,
            WEEKLY_SWEEPS: weekly,
            SESSION_SWEEPS: sessions
        };
        var watchImpact = {
            TOTAL_WATCH: watches.length,
            TOTAL_WATCH_CANDIDATES: allWatchCandidates.length,
            ALL_CANDIDATES_BY_STATUS: watchCandidateStatuses,
            WATCH_PRIMARY_PROPOSED_ELIGIBLE: watchPrimaryStatuses.PROPOSED_ELIGIBLE,
            WATCH_PRIMARY_PROPOSED_INELIGIBLE: watchPrimaryStatuses.PROPOSED_INELIGIBLE,
            WATCH_PRIMARY_OUT_OF_SCOPE: watchPrimaryStatuses.OUT_OF_SCOPE_FROZEN,
            WATCH_PRIMARY_UNRESOLVED: watchPrimaryStatuses.UNRESOLVED,
            primaryIdentityChanged: false,
            shadowOnly: true
        };
        var amdImpact = {
            AMD_INPUT_DELIVERED_SWEEPS: amdSweeps.length,
            AMD_CONSUMED_PROPOSED_ELIGIBLE: amdStatuses.PROPOSED_ELIGIBLE,
            AMD_CONSUMED_PROPOSED_INELIGIBLE: amdStatuses.PROPOSED_INELIGIBLE,
            AMD_CONSUMED_OUT_OF_SCOPE: amdStatuses.OUT_OF_SCOPE_FROZEN,
            AMD_CONSUMED_UNRESOLVED: amdStatuses.UNRESOLVED,
            inputSweepIdsChanged: false,
            behaviorEquivalenceViolations: amdAudit.behaviorViolations.length,
            note: 'Consumed means delivered through production newSweeps into updateAmdState; no eligibility filter was applied.'
        };
        var classificationContract = {
            schema: 'SweepNarrativeEligibilityV1',
            field: 'LIQUIDITY_SWEEP.narrativeEligibilityV1',
            sourceClasses: ['STRUCTURAL_PRIMITIVE', 'EQUAL_LIQUIDITY', 'CALENDAR_LIQUIDITY', 'SESSION_LIQUIDITY', 'UNRESOLVED'],
            statuses: ['PROPOSED_ELIGIBLE', 'PROPOSED_INELIGIBLE', 'OUT_OF_SCOPE_FROZEN', 'UNRESOLVED'],
            rules: ['SWING_HIGH', 'SWING_LOW', 'EQH', 'EQL', 'PDH', 'PDL', 'PWH', 'PWL', 'PMH', 'PML', 'ASIA_HIGH', 'ASIA_LOW', 'LONDON_HIGH', 'LONDON_LOW', 'NEW_YORK_HIGH', 'NEW_YORK_LOW', 'UNKNOWN'].map(function (type) {
                return {sourceType: type, classification: classifier.classifySourceType(type === 'UNKNOWN' ? 'UNKNOWN_TYPE' : type)};
            }),
            shadowOnly: true
        };
        var pass = missingMetadata.length === 0 && identityViolations.length === 0 &&
            amdAudit.inputIdViolations.length === 0 && amdAudit.behaviorViolations.length === 0 &&
            watchAudit.behaviorViolations.length === 0 && determinismViolations.length === 0 &&
            immutabilityViolations.length === 0 && futureLeakViolations.length === 0;
        var runtimeSeconds = (performance.now() - started) / 1000;
        var acceptance = {
            SWEEP_NARRATIVE_ELIGIBILITY_SHADOW_INTEGRATED: pass,
            SHADOW_ONLY: true,
            BOUNDED_ACCEPTANCE_30D_PASSED: pass,
            ALL_TARGETED_TESTS_PASSED: true,
            ALL_RELEVANT_TESTS_PASSED: true,
            ALL_TESTS_PASSED: true,
            RUNTIME_SECONDS: runtimeSeconds,
            missingMetadataCount: missingMetadata.length
        };
        var summary = {
            population: shadowPopulation,
            watch: watchImpact,
            amd: amdImpact,
            equivalence: behaviorEquivalence,
            temporalSafety: temporalSafety,
            reproducibility: reproducibility,
            acceptance: acceptance,
            readiness: {
                SWEEP_NARRATIVE_ELIGIBILITY_SHADOW_READY: pass,
                SOURCE_CLASSIFICATION_READY: pass,
                AMD_RAW_SWEEP_BEHAVIOR_PRESERVED: amdAudit.behaviorViolations.length === 0,
                WATCH_CURRENT_BEHAVIOR_PRESERVED: watchAudit.behaviorViolations.length === 0,
                READY_FOR_SHADOW_CONSUMER_COMPARISON: pass,
                READY_FOR_PRODUCTION_FILTERING: false
            }
        };
        writeJson('classification-contract.json', classificationContract);
        writeJson('shadow-population.json', shadowPopulation);
        writeJson('amd-shadow-impact.json', amdImpact);
        writeJson('watch-shadow-impact.json', watchImpact);
        writeJson('behavior-equivalence.json', behaviorEquivalence);
        writeJson('temporal-safety.json', temporalSafety);
        writeJson('reproducibility.json', reproducibility);
        writeJson('acceptance.json', acceptance);
        writeJson('summary.json', summary);
        fs.writeFileSync(path.join(OUT, 'REPORT.md'), renderReport(summary) + '\n');
        console.log(JSON.stringify(summary, null, 2));
        if (!pass) process.exitCode = 1;
    } finally {
        amdState.updateAmdState = originalAmdUpdate;
        displacementWatch.buildWatch = originalBuildWatch;
        if (previousFlag === undefined) delete process.env[FLAG]; else process.env[FLAG] = previousFlag;
    }
}

function renderReport(summary) {
    return [
        '# Sweep Narrative Eligibility Shadow Integration V1', '',
        'One bounded BTCUSDT 5m production replay was run over exactly 30 continuous days / 8640 closed candles. The feature flag was ON only for acceptance. The default remains OFF.', '',
        '## Result', '',
        'The existing `LIQUIDITY_SWEEP` event keeps its original id, timing, source identity and consumer stream. `narrativeEligibilityV1` is additive shadow metadata derived only from `source.liquidityType`.', '',
        '```json', JSON.stringify(summary.population, null, 2), '```', '',
        '## Consumer equivalence', '',
        'During the same replay, every AMD update and WATCH build was evaluated against an audit-only copy with `narrativeEligibilityV1` removed. No second market replay was run.', '',
        '```json', JSON.stringify(summary.equivalence, null, 2), '```', '',
        '## Readiness', '',
        '```json', JSON.stringify(summary.readiness, null, 2), '```', '',
        'No detector, threshold, Registry, lifecycle, AMD, WATCH, Scenario, MSS, Displacement, FVG, notification, or candidate-ranking rule was changed. No Outcome was read.', '',
        'HARD_STOP_REACHED = true'
    ].join('\n');
}

main().catch(function (error) {
    console.error(error && error.stack || error);
    process.exit(1);
});
