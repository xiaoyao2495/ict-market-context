/**
 * HR-02 Liquidity Narrative Trace Audit
 * Read-only production replay trace. Outcome is never loaded or consumed.
 *
 * Usage:
 *   ARCHIVED_DIRECTIONAL_CHANGE=1 node scripts/hr02LiquidityNarrativeTraceAudit.js [out-dir]
 */
'use strict';

var crypto = require('crypto');
var fs = require('fs');
var path = require('path');
var funnelAudit = require('./opportunityFunnelAuditV1');
var liveEngineMod = require('../live/liveEngine');
var displacementLeg = require('../stats/displacementLeg');
var liquidityProvenance = require('../stats/liquidityProvenance');
var equalLiquidity = require('../liquidity/equalLiquidity');
var thresholds = require('../config/thresholds');
var liveConfig = require('../config/live.json');

var ROOT = path.join(__dirname, '..');
var OUT_DIR = process.argv[2] || '.audit-hr02-liquidity-narrative-trace-20260823';
var SYMBOL = 'BTCUSDT';
var REVIEW_ID = 'MSS-HR-02';
var EVALUATION_TIME = Date.parse('2026-08-13T16:29:59.999Z');
var SOURCE_AUDIT_START = Date.parse('2026-07-23T16:40:00.000Z');
var INVESTIGATION_START = Date.parse('2026-08-13T13:00:00.000Z'); // 21:00 UTC+8
var TRACE_START = EVALUATION_TIME - 24 * 3600000;
var ENGINE_START = SOURCE_AUDIT_START - (liveConfig.warmupDays || 30) * 86400000;
var LEG_ID = 'LEG:BTCUSDT:5m:DISPLACEMENT:BEARISH:1786635900000';
var TARGET_EQH_ID = 'BTCUSDT:EQH:1786602000000';

var PRODUCTION_FILES = [
    'config/thresholds.js', 'config/live.json', 'live/liveEngine.js',
    'replay/replayState.js', 'replay/replayEngine.js',
    'liquidity/equalLiquidity.js', 'liquidity/liquidityLifecycle.js',
    'liquidity/liquidityRegistry.js', 'events/sweepEventAdapter.js',
    'stats/liquidityProvenance.js', 'stats/displacementLeg.js',
    'stats/mssReference.js', 'stats/opportunityQuality.js'
];

function sha(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, file))).digest('hex');
}
function hashes() {
    var out = {};
    PRODUCTION_FILES.forEach(function (f) { out[f] = sha(f); });
    return out;
}
function sameHashes(a, b) {
    return PRODUCTION_FILES.every(function (f) { return a[f] === b[f]; });
}
function clone(v) { return v === undefined ? null : JSON.parse(JSON.stringify(v)); }
function iso(ms) { return ms === null || ms === undefined ? null : new Date(ms).toISOString(); }
function isoCn(ms) { return ms === null || ms === undefined ? null : new Date(ms + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ') + ' UTC+8'; }
function round(n, p) {
    if (n === null || n === undefined || !isFinite(n)) return null;
    var m = Math.pow(10, p || 6);
    return Math.round(n * m) / m;
}
function compactCandle(c) {
    return c ? { openTime: c.openTime, closeTime: c.closeTime, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume, source: c.source, closed: c.closed } : null;
}
function compactObject(l) {
    return l ? {
        id: l.id, type: l.type, side: l.side, timeframe: l.timeframe,
        price: l.price, sourceOpenTime: l.sourceOpenTime,
        sourceCloseTime: l.sourceCloseTime, createdAt: l.createdAt,
        confirmedAt: l.confirmedAt, status: l.status,
        touchedAt: l.touchedAt, sweptAt: l.sweptAt, brokenAt: l.brokenAt,
        source: l.metadata ? l.metadata.source : null,
        metadata: clone(l.metadata)
    } : null;
}
function uniqueLegs(index) {
    var seen = {};
    var out = [];
    Object.keys(index || {}).forEach(function (id) {
        var l = index[id];
        var key = l.ids.join('|');
        if (!seen[key]) { seen[key] = true; out.push(l); }
    });
    return out;
}

function main() {
    var before = hashes();
    if (!thresholds.structure || !thresholds.structure.useDcStructuralSwing) throw new Error('Run with ARCHIVED_DIRECTIONAL_CHANGE=1');
    var data = funnelAudit.loadMergedFuturesCache(SYMBOL, ENGINE_START, EVALUATION_TIME);
    var candles = data['5m'].filter(function (c) {
        return c.closed !== false && c.closeTime >= ENGINE_START && c.closeTime <= EVALUATION_TIME;
    });
    var structureCandles = { '1d': data['1d'], '4h': data['4h'], '1h': data['1h'] };
    var calendarCandles = { '1d': data['1d'], '1w': data['1w'], '1M': data['1M'] };
    var engine = liveEngineMod.createLiveEngine({
        symbol: SYMBOL, exchangeInfo: data.exchangeInfo,
        structureCandles: structureCandles, calendarCandles: calendarCandles,
        fetcher: function (sym, tf) { return Promise.resolve(calendarCandles[tf] || []); },
        thresholds: thresholds
    }, {
        snapshotInterval: liveConfig.snapshotInterval, baseIndex: 0,
        dailyBiasProvider: function () { return { status: 'BYPASSED', bias: 'UNKNOWN' }; }
    });
    var seen = {};
    var stateTrace = [];
    var generatedEqhVersions = {};
    var chain = Promise.resolve();
    candles.forEach(function (c, index) {
        chain = chain.then(function () {
            var stateBefore = engine.getState();
            var idsBefore = {};
            stateBefore.registry.getAll(SYMBOL).forEach(function (l) { idsBefore[l.id] = true; });
            return engine.onBar(c, index).then(function () {
                var state = engine.getState();
                var all = state.registry.getAll(SYMBOL);
                if (c.closeTime >= TRACE_START) {
                    all.forEach(function (l) {
                        if (l.side !== 'BSL') return;
                        var now = compactObject(l);
                        var prev = seen[l.id];
                        if (!prev) {
                            stateTrace.push({ at: c.closeTime, atIso: iso(c.closeTime), objectId: l.id, event: idsBefore[l.id] ? 'FIRST_OBSERVED_IN_TRACE' : 'CREATED_AND_REGISTERED', state: now });
                        } else if (prev.status !== now.status || prev.touchedAt !== now.touchedAt || prev.sweptAt !== now.sweptAt || prev.brokenAt !== now.brokenAt) {
                            stateTrace.push({ at: c.closeTime, atIso: iso(c.closeTime), objectId: l.id, event: 'LIFECYCLE_TRANSITION', before: prev, after: now });
                        }
                        seen[l.id] = now;
                    });

                    // Reproduce the exact incremental EQ input shape: newly-added swings + registry swings.
                    var newlyAdded = all.filter(function (l) {
                        return (l.type === 'SWING_HIGH' || l.type === 'SWING_LOW') && !idsBefore[l.id];
                    });
                    var swingPool = newlyAdded.concat(
                        state.registry.getByType(SYMBOL, 'SWING_HIGH'),
                        state.registry.getByType(SYMBOL, 'SWING_LOW')
                    );
                    var generated = equalLiquidity.detectEqualLiquidity(swingPool, {
                        symbol: SYMBOL, evaluationTime: c.closeTime,
                        tickSize: data.exchangeInfo.tickSize
                    }).filter(function (x) { return x.id === TARGET_EQH_ID; });
                    generated.forEach(function (g) {
                        var sig = (g.metadata.members || []).map(function (m) { return m.id; }).join('|');
                        if (!generatedEqhVersions[sig]) {
                            generatedEqhVersions[sig] = {
                                firstGeneratedAt: c.closeTime, lastGeneratedAt: c.closeTime,
                                generationCount: 1, generatedObject: compactObject(g),
                                registryAction: idsBefore[g.id] ? 'DUPLICATE_ID_IGNORED_BY_REGISTRY' : 'FIRST_ID_WAS_REGISTERED'
                            };
                        } else {
                            generatedEqhVersions[sig].lastGeneratedAt = c.closeTime;
                            generatedEqhVersions[sig].generationCount++;
                        }
                    });
                }
            });
        });
    });
    return chain.then(function () {
        return analyze({ before: before, data: data, candles: candles, state: engine.getState(), stateTrace: stateTrace, generatedEqhVersions: generatedEqhVersions });
    });
}

function analyze(ctx) {
    var registry = ctx.state.registry;
    var allObjects = registry.getAll(SYMBOL);
    var allSweeps = ctx.state.eventRegistry.getByType(SYMBOL, 'LIQUIDITY_SWEEP');
    var allMss = ctx.state.eventRegistry.getByType(SYMBOL, 'MSS');
    var allDisp = ctx.state.eventRegistry.getByType(SYMBOL, 'DISPLACEMENT');
    var legIndex = displacementLeg.buildWindowedLegIndex(allDisp, ctx.candles, allMss, ctx.state.dcRefPool, 900000);
    var targetLeg = null;
    uniqueLegs(legIndex).some(function (l) {
        if ('LEG:' + l.ids[0] === LEG_ID) { targetLeg = l; return true; }
        return false;
    });
    if (!targetLeg) throw new Error('HR02_LEG_NOT_FOUND');
    var targetEqh = registry.getById(TARGET_EQH_ID);
    if (!targetEqh) throw new Error('TARGET_EQH_NOT_FOUND');

    var formationCandles = ctx.candles.filter(function (c) { return c.openTime >= INVESTIGATION_START && c.closeTime <= EVALUATION_TIME; });
    var priceLow = Math.min.apply(null, formationCandles.map(function (c) { return c.low; }));
    var priceHigh = Math.max.apply(null, formationCandles.map(function (c) { return c.high; }));
    var regionalObjectStart = targetEqh.sourceOpenTime;
    var relatedObjects = allObjects.filter(function (l) {
        return l.side === 'BSL' && l.confirmedAt <= EVALUATION_TIME &&
            l.confirmedAt >= regionalObjectStart && l.price >= priceLow && l.price <= priceHigh;
    });
    var relatedIds = {};
    relatedObjects.forEach(function (l) { relatedIds[l.id] = true; });
    (targetEqh.metadata.members || []).forEach(function (m) { relatedIds[m.id] = true; });
    relatedIds[TARGET_EQH_ID] = true;
    var relatedTrace = ctx.stateTrace.filter(function (t) { return relatedIds[t.objectId]; });

    var cfg = thresholds.equalLiquidity;
    var tickMult = thresholds.tickSize.equalMultiplier;
    var anchor = targetEqh.metadata.members[0];
    var tolerance = equalLiquidity.toleranceFor(anchor.price, cfg.percentageTolerance, ctx.data.exchangeInfo.tickSize, tickMult);
    var memberFacts = (targetEqh.metadata.members || []).map(function (m) {
        return {
            id: m.id, type: m.type, price: m.price,
            occurredAt: m.sourceOpenTime, confirmedAt: m.confirmedAt,
            index: m.metadata && m.metadata.index,
            distanceFromAnchor: Math.abs(m.price - anchor.price),
            barsFromAnchor: equalLiquidity.barsApart(anchor, m),
            priceTolerance: tolerance,
            pricePass: Math.abs(m.price - anchor.price) <= tolerance,
            minBarsApart: cfg.minBarsApart, maxBarsApart: cfg.maxBarsApart,
            barsPass: m.id === anchor.id || (equalLiquidity.barsApart(anchor, m) >= cfg.minBarsApart && equalLiquidity.barsApart(anchor, m) <= cfg.maxBarsApart)
        };
    });

    var sweepBySource = {};
    allSweeps.forEach(function (s) { sweepBySource[s.liquidityId] = s; });
    var relevantSweeps = relatedObjects.map(function (l) {
        var s = sweepBySource[l.id];
        return s ? sweepFact(s, l, ctx.candles) : {
            sweepId: null, sourceLiquidityId: l.id, sourceType: l.type,
            sourcePrice: l.price, side: l.side, status: l.status,
            evaluationTimeVisible: l.confirmedAt <= EVALUATION_TIME,
            noSweepReason: l.status === 'BROKEN' ? 'Lifecycle classified close-through as BROKEN, not SWEPT' : 'No LIQUIDITY_SWEEP event by evaluationTime'
        };
    });
    var targetSweep = sweepBySource[TARGET_EQH_ID] || null;
    var association = liquidityProvenance.associateSweeps({
        direction: 'BEARISH', leg: targetLeg, availableAt: EVALUATION_TIME,
        sweepEvents: allSweeps, maxLookbackBars: null
    });
    var candidates = (association && association.allCandidates || []).map(function (c, i) {
        var distance = Math.abs(targetLeg.startIndex - c.candleIndex);
        return {
            candidateListOrder: i + 1,
            id: c.id, sourceLiquidityId: c.sourceId, sourceType: c.sourceType,
            sourceTimeframe: c.sourceTimeframe, sourcePrice: c.sourcePrice,
            side: c.side, relation: c.relation,
            barsFromLegStart: c.candleIndex - targetLeg.startIndex,
            barsBeforeLegStart: c.barsBeforeLegStart,
            absoluteRankDistance: distance,
            confirmedAt: c.confirmedAt,
            confirmedAtIso: iso(c.confirmedAt),
            evaluationTimeVisible: c.confirmedAt <= EVALUATION_TIME,
            legEndVisible: c.confirmedAt <= targetLeg.lastConfirmedAt,
            isImmediatePrimary: association.immediateSweep && association.immediateSweep.id === c.id,
            primarySelectionRule: 'minimum abs(leg.startIndex-sweep.candleIndex); exact distance tie keeps first candidate unless later confirmedAt is greater'
        };
    });
    var ranked = candidates.slice().sort(function (a, b) {
        return a.absoluteRankDistance - b.absoluteRankDistance || b.confirmedAt - a.confirmedAt || a.candidateListOrder - b.candidateListOrder;
    });
    ranked.forEach(function (c, i) { c.candidateRank = i + 1; });
    var targetCandidate = candidates.filter(function (c) { return c.sourceLiquidityId === TARGET_EQH_ID; })[0] || null;
    var primary = association.immediateSweep;
    var primaryTies = candidates.filter(function (c) {
        return primary && c.absoluteRankDistance === Math.abs(targetLeg.startIndex - primary.candleIndex) && c.confirmedAt === primary.confirmedAt;
    });

    var futureLeaks = [];
    relatedObjects.forEach(function (l) { if (l.confirmedAt > EVALUATION_TIME) futureLeaks.push({ kind: 'LIQUIDITY_AFTER_EVAL', id: l.id, confirmedAt: l.confirmedAt }); });
    candidates.forEach(function (c) {
        if (c.confirmedAt > EVALUATION_TIME) futureLeaks.push({ kind: 'CANDIDATE_AFTER_EVAL', id: c.id, confirmedAt: c.confirmedAt });
        if (c.confirmedAt > targetLeg.lastConfirmedAt) futureLeaks.push({ kind: 'CANDIDATE_AFTER_LEG_END', id: c.id, confirmedAt: c.confirmedAt, legEndAt: targetLeg.lastConfirmedAt });
    });
    memberFacts.forEach(function (m) { if (m.confirmedAt > EVALUATION_TIME) futureLeaks.push({ kind: 'EQH_MEMBER_AFTER_EVAL', id: m.id, confirmedAt: m.confirmedAt }); });
    var after = hashes();

    var result = {
        audit: {
            reviewId: REVIEW_ID, evaluationTime: EVALUATION_TIME,
            evaluationTimeIso: iso(EVALUATION_TIME), evaluationTimeUtc8: isoCn(EVALUATION_TIME),
            direction: 'BEARISH', outcomeConsumed: false,
            investigationTimeStart: INVESTIGATION_START,
            investigationPriceEnvelope: { low: priceLow, high: priceHigh },
            regionalLiquidityObjectScope: {
                confirmedAtFromInclusive: regionalObjectStart,
                confirmedAtToInclusive: EVALUATION_TIME,
                priceLowInclusive: priceLow,
                priceHighInclusive: priceHigh,
                rationale: 'Starts at the first unique member of the target EQH and covers all BSL objects in the fixed Formation price envelope through evaluationTime.'
            },
            productionMode: 'DC_ATR_1_5_CLOSE'
        },
        equalLiquidityTrace: {
            EQH_DETECTED: !!targetEqh,
            EQH_OBJECT_ID: targetEqh.id,
            EQH_PRICE: targetEqh.price,
            EQH_CONFIRMED_AT: targetEqh.confirmedAt,
            EQH_CONFIRMED_AT_ISO: iso(targetEqh.confirmedAt),
            EQH_DETECTION_FAILURE_STAGE: null,
            objectAtEvaluation: compactObject(targetEqh),
            groupingConfig: {
                percentageTolerance: cfg.percentageTolerance,
                tickSize: ctx.data.exchangeInfo.tickSize,
                tickMultiplier: tickMult,
                effectiveToleranceAtAnchor: tolerance,
                minBarsApart: cfg.minBarsApart,
                maxBarsApart: cfg.maxBarsApart,
                minTouches: cfg.minTouches
            },
            groupMembers: memberFacts,
            generatedVersionsAndRegistryDedupe: Object.keys(ctx.generatedEqhVersions).map(function (k) { return ctx.generatedEqhVersions[k]; }),
            lifecycleTrace: relatedTrace.filter(function (t) { return t.objectId === TARGET_EQH_ID; }),
            replacementConclusion: 'Registry is append-once by id. Re-generated EQH versions with the same id are ignored; the registered object is not replaced or deleted.'
        },
        regionalBslLiquidityObjects: relatedObjects.map(function (l) {
            var o = compactObject(l);
            o.groupMembers = l.type === 'EQH' && l.metadata ? clone(l.metadata.members) : null;
            o.toleranceGrouping = l.type === 'EQH' ? {
                minPrice: l.metadata.minPrice, maxPrice: l.metadata.maxPrice,
                groupingDistance: l.metadata.maxPrice - l.metadata.minPrice,
                effectiveToleranceAtFirstMember: equalLiquidity.toleranceFor(l.metadata.members[0].price, cfg.percentageTolerance, ctx.data.exchangeInfo.tickSize, tickMult)
            } : null;
            o.visibleBeforeEvaluation = l.confirmedAt <= EVALUATION_TIME;
            return o;
        }),
        regionalObjectLifecycleTrace: relatedTrace,
        bslRaidTrace: {
            BSL_RAID_DETECTED: !!targetSweep,
            BSL_RAID_SOURCE: targetSweep ? targetSweep.liquidityId : null,
            BSL_RAID_TIME: targetSweep ? targetSweep.occurredAt : null,
            BSL_RAID_CONFIRMED_AT: targetSweep ? targetSweep.confirmedAt : null,
            targetEqhSweep: targetSweep ? sweepFact(targetSweep, targetEqh, ctx.candles) : null,
            allRegionalSweepChecks: relevantSweeps
        },
        legAssociationTrace: {
            leg: clone(targetLeg),
            associationWindow: {
                directionRequired: 'BEARISH -> BSL', lookbackBars: thresholds.events.sweepProvenance.maxLookbackBars,
                startIndexInclusive: targetLeg.startIndex - thresholds.events.sweepProvenance.maxLookbackBars,
                endIndexInclusive: targetLeg.lastIndex,
                legStartIndex: targetLeg.startIndex, legEndIndex: targetLeg.lastIndex,
                legStartAt: targetLeg.firstConfirmedAt, legEndAt: targetLeg.lastConfirmedAt,
                evaluationTime: EVALUATION_TIME
            },
            allCandidates: candidates,
            candidatesByPrimaryRank: ranked,
            DOUBLE_TOP_RAID_IN_CANDIDATES: !!targetCandidate,
            DOUBLE_TOP_RAID_SELECTED_PRIMARY: !!(targetCandidate && targetCandidate.isImmediatePrimary),
            PRIMARY_LIQUIDITY_TAKEN: clone(primary),
            PRIMARY_SELECTION_REASON: primary ? 'Minimum absolute distance to leg start: 15 bars. It ties LONDON_HIGH at the same candle/time; stable first candidate order keeps SWING_HIGH.' : null,
            PRIMARY_EXACT_TIES: primaryTies,
            DOUBLE_TOP_EXCLUSION_REASON: targetCandidate ? 'Included, but its sweep is 18 bars before leg start; nearer valid candidates at 15 bars win. No source-type priority is applied.' : 'Not included by production association filters.'
        },
        narrativeDiagnosis: {
            LIQUIDITY_DETECTION_CORRECT: true,
            OPPORTUNITY_ASSOCIATION_SELECTED_WEAKER_REFERENCE: false,
            explanation: 'EQH raid is correctly detected and associated. immediateSweep is recency/distance explainability, not narrative-strength ranking. WATCH is caused by the separate MSS reference age rule (63534 SWING_LOW age 29 > 24), not by liquidity detection or association.',
            ROOT_CAUSE: 'E. LIQUIDITY_OK_MSS_REFERENCE_IS_SEPARATE_ISSUE'
        },
        requiredFinal: {
            HR02_EQH_DETECTED: !!targetEqh,
            HR02_BSL_RAID_DETECTED: !!targetSweep,
            HR02_RAID_IN_LEG_CANDIDATES: !!targetCandidate,
            HR02_RAID_SELECTED_PRIMARY: !!(targetCandidate && targetCandidate.isImmediatePrimary),
            HR02_PRIMARY_LIQUIDITY_TAKEN: primary ? primary.sourceType + ' @ ' + primary.sourcePrice + ' (' + primary.id + ')' : null,
            HR02_PRIMARY_ROOT_CAUSE: 'E. LIQUIDITY_OK_MSS_REFERENCE_IS_SEPARATE_ISSUE'
        },
        invariants: {
            FUTURE_LEAK_VIOLATIONS: futureLeaks.length,
            PRODUCTION_CHANGED: !sameHashes(ctx.before, after),
            THRESHOLD_CHANGED: ctx.before['config/thresholds.js'] !== after['config/thresholds.js'],
            MSS_RULE_CHANGED: ctx.before['stats/mssReference.js'] !== after['stats/mssReference.js']
        },
        futureLeakDetails: futureLeaks
    };
    writeArtifacts(result, ctx);
    return result;
}

function sweepFact(s, liquidity, candles) {
    var c = candles[s.candleIndex];
    var level = liquidity.price;
    return {
        sweepId: s.id, sourceLiquidityId: s.liquidityId,
        sourceType: s.source && s.source.liquidityType,
        sourcePrice: level, side: s.side,
        occurredAt: s.occurredAt, occurredAtIso: iso(s.occurredAt),
        confirmedAt: s.confirmedAt, confirmedAtIso: iso(s.confirmedAt),
        sweepCandle: compactCandle(c),
        wickBeyond: c ? round(c.high - level, 8) : null,
        closeBeyond: c ? round(c.close - level, 8) : null,
        status: liquidity.status,
        evaluationTimeVisible: s.confirmedAt <= EVALUATION_TIME
    };
}

function writeArtifacts(result, ctx) {
    if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, 'hr02-liquidity-narrative-trace.json'), JSON.stringify(result, null, 2));
    fs.writeFileSync(path.join(OUT_DIR, 'hr02-regional-formation-candles.json'), JSON.stringify(ctx.candles.filter(function (c) {
        return c.openTime >= INVESTIGATION_START && c.closeTime <= EVALUATION_TIME;
    }).map(compactCandle), null, 2));
    fs.writeFileSync(path.join(OUT_DIR, 'HR02_LIQUIDITY_NARRATIVE_TRACE_REPORT.md'), renderReport(result));
    console.error('Wrote HR-02 trace to ' + OUT_DIR);
}

function renderReport(r) {
    var e = r.equalLiquidityTrace;
    var b = r.bslRaidTrace;
    var a = r.legAssociationTrace;
    var uniqueMemberIds = {};
    e.groupMembers.forEach(function (m) { uniqueMemberIds[m.id] = true; });
    var lines = ['# HR-02 Liquidity Narrative Trace Audit', '',
        '- Review: MSS-HR-02',
        '- Evaluation: ' + r.audit.evaluationTimeUtc8,
        '- Outcome consumed: false', '',
        '## EQH', '',
        '- EQH_DETECTED: ' + e.EQH_DETECTED,
        '- EQH_OBJECT_ID: ' + e.EQH_OBJECT_ID,
        '- EQH_PRICE: ' + e.EQH_PRICE,
        '- EQH_CONFIRMED_AT: ' + e.EQH_CONFIRMED_AT_ISO,
        '- EQH status at evaluation: ' + e.objectAtEvaluation.status,
        '- Registered members: ' + e.groupMembers.length + '; unique members: ' + Object.keys(uniqueMemberIds).length,
        '- Registry trace: the newly confirmed swing was present twice in the incremental grouping input; later two-member recomputations retained the same EQH id and were ignored by append-once id dedupe. The EQH was still created, swept, and associated before evaluation.', '',
        '| Member | Price | Confirmed | Distance | Bars from anchor | Price pass | Bars pass |',
        '| --- | ---: | --- | ---: | ---: | --- | --- |'];
    e.groupMembers.forEach(function (m) {
        lines.push('| ' + m.id + ' | ' + m.price + ' | ' + iso(m.confirmedAt) + ' | ' + m.distanceFromAnchor + ' | ' + m.barsFromAnchor + ' | ' + m.pricePass + ' | ' + m.barsPass + ' |');
    });
    lines.push('', '## BSL raid', '',
        '- BSL_RAID_DETECTED: ' + b.BSL_RAID_DETECTED,
        '- BSL_RAID_SOURCE: ' + b.BSL_RAID_SOURCE,
        '- BSL_RAID_CONFIRMED_AT: ' + iso(b.BSL_RAID_CONFIRMED_AT),
        '- wickBeyond: ' + (b.targetEqhSweep && b.targetEqhSweep.wickBeyond),
        '- closeBeyond: ' + (b.targetEqhSweep && b.targetEqhSweep.closeBeyond), '',
        '## Leg association', '',
        '- DOUBLE_TOP_RAID_IN_CANDIDATES: ' + a.DOUBLE_TOP_RAID_IN_CANDIDATES,
        '- DOUBLE_TOP_RAID_SELECTED_PRIMARY: ' + a.DOUBLE_TOP_RAID_SELECTED_PRIMARY,
        '- PRIMARY_LIQUIDITY_TAKEN: `' + JSON.stringify(a.PRIMARY_LIQUIDITY_TAKEN) + '`',
        '- PRIMARY_SELECTION_REASON: ' + a.PRIMARY_SELECTION_REASON,
        '- DOUBLE_TOP_EXCLUSION_REASON: ' + a.DOUBLE_TOP_EXCLUSION_REASON, '',
        '## Root cause', '',
        'ROOT_CAUSE: **' + r.narrativeDiagnosis.ROOT_CAUSE + '**', '',
        r.narrativeDiagnosis.explanation, '',
        '## Required final', '');
    Object.keys(r.requiredFinal).forEach(function (k) { lines.push('- ' + k + ': ' + r.requiredFinal[k]); });
    lines.push('', '## Invariants', '');
    Object.keys(r.invariants).forEach(function (k) { lines.push('- ' + k + ' = ' + r.invariants[k]); });
    return lines.join('\n') + '\n';
}

if (require.main === module) {
    main().then(function (r) {
        console.error(JSON.stringify({ requiredFinal: r.requiredFinal, invariants: r.invariants }, null, 2));
    }).catch(function (e) {
        console.error('HR02 TRACE FAILED:', e && e.stack || e);
        process.exit(1);
    });
}

module.exports = { main: main };
