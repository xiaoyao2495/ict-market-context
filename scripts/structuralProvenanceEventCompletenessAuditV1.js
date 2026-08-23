/** Read-only BTCUSDT 30d Structural Provenance event completeness audit. */
'use strict';
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var liveEngine = require('../live/liveEngine');
var thresholds = require('../config/thresholds');
var liveConfig = require('../config/live.json');
var historicalLoader = require('../replay/historicalLoader');

var ROOT = path.join(__dirname, '..');
var OUT = process.argv[2] || '.audit-5m-structural-provenance-event-completeness-v1';
var SYMBOL = 'BTCUSDT';
var BAR = 300000;
var DAY = 86400000;
var END = 1787416799999;
var START = END - 30 * DAY + 1;
var ENGINE_START = START - (liveConfig.warmupDays || 30) * DAY;
var PRODUCTION_FILES = [
    'config/thresholds.js', 'config/live.json', 'live/liveEngine.js',
    'replay/replayState.js', 'replay/replayEngine.js',
    'structure/structuralProvenance5m.js', 'events/eventRegistry.js',
    'events/displacementDetector.js', 'stats/displacementLeg.js',
    'stats/opportunityQuality.js'
];

function clone(x) { return JSON.parse(JSON.stringify(x)); }
function iso(t) { return t == null ? null : new Date(t).toISOString(); }
function inWindow(t) { return t >= START && t <= END; }
function hashes() {
    var out = {};
    PRODUCTION_FILES.forEach(function (f) {
        out[f] = crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, f))).digest('hex');
    });
    return out;
}
function sameHashes(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function loadCache() {
    var dir = path.join(ROOT, 'data-cache');
    var intervals = ['5m', '1h', '4h', '1d', '1w', '1M'];
    var intervalMs = { '5m': BAR, '1h': 3600000, '4h': 14400000, '1d': DAY, '1w': 604800000, '1M': 2592000000 };
    var data = {};
    intervals.forEach(function (tf) {
        var prefix = SYMBOL + '_' + tf + '_';
        var byOpen = {};
        fs.readdirSync(dir).filter(function (f) { return f.indexOf(prefix) === 0 && /\.json$/.test(f); })
            .forEach(function (f) {
                var rows;
                try { rows = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { return; }
                (rows || []).forEach(function (c) {
                    if (c && c.source === 'futures' && c.closed !== false && c.closeTime <= END) byOpen[c.openTime] = c;
                });
            });
        var min = ENGINE_START - (historicalLoader.WARMUP_BARS[tf] || 100) * intervalMs[tf];
        data[tf] = Object.keys(byOpen).map(function (k) { return byOpen[k]; })
            .filter(function (c) { return c.closeTime >= min; })
            .sort(function (a, b) { return a.openTime - b.openTime; });
    });
    data.exchangeInfo = JSON.parse(fs.readFileSync(path.join(dir, SYMBOL + '_EXCHANGE.json'), 'utf8'));
    return data;
}
function compactSwing(s) {
    return s ? {
        id: s.id, sourceSwingId: s.sourceSwingId, side: s.side, price: s.price,
        occurredAt: s.occurredAt, confirmedAt: s.confirmedAt, role: s.role,
        status: s.status, protectedConfirmedAt: s.protectedConfirmedAt
    } : null;
}
function compactCandle(c, index) {
    return { index: index, openTime: c.openTime, closeTime: c.closeTime,
        open: c.open, high: c.high, low: c.low, close: c.close,
        volume: c.volume, closed: c.closed, source: c.source };
}
function closeBreak(side, price, candle) {
    return side === 'LOW' ? candle.close < price : candle.close > price;
}
function breakDirection(side) { return side === 'LOW' ? 'BEARISH' : 'BULLISH'; }
function expectedClassification(stateBefore, direction) {
    return stateBefore === direction ? 'STRUCTURAL_CONTINUATION' : 'STRUCTURAL_MSS';
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
function formationFor(record, candles) {
    var idx = record.candleIndex;
    return {
        protectedSwingId: record.protectedSwingId,
        expectedClassification: record.expectedClassification,
        evaluationTime: record.breakTime,
        formationCandles: candles.slice(Math.max(0, idx - 20), idx + 1).map(function (c, offset) {
            return compactCandle(c, Math.max(0, idx - 20) + offset);
        })
    };
}
function render(result) {
    var c = result.counts;
    var q = result.specialChecks;
    return [
        '# 5m Structural Provenance V1 Event Completeness Audit', '',
        'BTCUSDT fixed 30d, closed candles only: `' + result.audit.startIso + '` → `' + result.audit.endIso + '`.', '',
        '| Metric | Count |', '|---|---:|',
        '| STRUCTURAL_BOS | ' + c.STRUCTURAL_BOS_COUNT + ' |',
        '| ACTIVE_PROTECTED close breaks | ' + c.ACTIVE_PROTECTED_CLOSE_BREAK_COUNT + ' |',
        '| expected MSS | ' + c.EXPECTED_MSS_COUNT + ' |',
        '| expected continuation | ' + c.EXPECTED_CONTINUATION_COUNT + ' |',
        '| actual MSS | ' + c.ACTUAL_MSS_COUNT + ' |',
        '| actual continuation | ' + c.ACTUAL_CONTINUATION_COUNT + ' |',
        '| classification mismatches | ' + c.CLASSIFICATION_MISMATCH_COUNT + ' |',
        '| exact-time mismatches | ' + c.EXACT_TIME_MISMATCH_COUNT + ' |', '',
        '## Diagnosis', '',
        '`EVENT_SEMANTICS_STATUS = ' + result.diagnosis.EVENT_SEMANTICS_STATUS + '`', '',
        result.diagnosis.explanation, '',
        '- MSS state persistence violations: ' + q.mssStatePersistenceViolations.length,
        '- BOS state overwrite violations: ' + q.bosStateOverwriteViolations.length,
        '- premature supersessions: ' + q.prematureSupersessions.length,
        '- close breaks missing an event: ' + q.closeBreaksMissingEvent.length,
        '- first-close breaks deferred to a later event: ' + q.delayedBreakEvents.length,
        '- structural events missing from EventRegistry: ' + q.eventsMissingFromRegistry.length,
        '- duplicate structural event ids: ' + q.duplicateEventIds.length,
        '- valid active-side snapshots: bullish→LOW ' + q.activeSideLifecycle.bullishExpectedOnly +
            ', bearish→HIGH ' + q.activeSideLifecycle.bearishExpectedOnly,
        '- same-direction active-side snapshots: ' + q.activeSideLifecycle.sameDirectionActiveSide, '',
        '- Opportunity consumes only STRUCTURAL_MSS: ' + q.opportunityConsumesOnlyStructuralMss,
        '- state/eventRegistry counts: ' + JSON.stringify(q.stateEventCounts) + ' / ' + JSON.stringify(q.registryCounts), '',
        '`PRODUCTION_CHANGED = ' + result.invariants.PRODUCTION_CHANGED + '`  ',
        '`FUTURE_LEAK_VIOLATIONS = ' + result.invariants.FUTURE_LEAK_VIOLATIONS + '`', ''
    ].join('\n');
}

function run() {
    var beforeHashes = hashes();
    var data = loadCache();
    var candles = data['5m'].filter(function (c) { return c.closeTime >= ENGINE_START && c.closeTime <= END; });
    var calendar = { '1d': data['1d'], '1w': data['1w'], '1M': data['1M'] };
    var engine = liveEngine.createLiveEngine({
        symbol: SYMBOL, exchangeInfo: data.exchangeInfo,
        structureCandles: { '1d': data['1d'], '4h': data['4h'], '1h': data['1h'] },
        calendarCandles: calendar,
        fetcher: function (s, tf) { return Promise.resolve(calendar[tf] || []); }, thresholds: thresholds
    }, { snapshotInterval: liveConfig.snapshotInterval, baseIndex: 0,
        dailyBiasProvider: function () { return null; } });

    var bosLedger = [];
    var breakLedger = [];
    var firstCloseSeen = {};
    var stateTrace = [];
    var activeSide = { bullishExpectedOnly: 0, bearishExpectedOnly: 0,
        sameDirectionActiveSide: 0, bothSidesActive: 0, noActiveSide: 0, samples: [] };
    var persistenceViolations = [];
    var pendingPersistence = null;
    var chain = Promise.resolve();

    candles.forEach(function (c, i) {
        chain = chain.then(function () {
            var pre = engine.getState();
            var preState = pre.structural5m.structuralState;
            if (pendingPersistence && preState !== pendingPersistence.expectedState) {
                persistenceViolations.push({ expectedFromMssId: pendingPersistence.eventId,
                    nextBarTime: c.closeTime, expected: pendingPersistence.expectedState, actual: preState });
            }
            pendingPersistence = null;
            var preEvents = pre.structural5m.events.length;
            var preActive = { HIGH: compactSwing(pre.structural5m.activeProtected.HIGH),
                LOW: compactSwing(pre.structural5m.activeProtected.LOW) };
            var validHigh = preActive.HIGH && preActive.HIGH.status === 'ACTIVE_PROTECTED';
            var validLow = preActive.LOW && preActive.LOW.status === 'ACTIVE_PROTECTED';
            if (inWindow(c.closeTime)) {
                if (validHigh && validLow) activeSide.bothSidesActive++;
                else if (!validHigh && !validLow) activeSide.noActiveSide++;
                else if (preState === 'BULLISH' && validLow) activeSide.bullishExpectedOnly++;
                else if (preState === 'BEARISH' && validHigh) activeSide.bearishExpectedOnly++;
                else {
                    activeSide.sameDirectionActiveSide++;
                    if (activeSide.samples.length < 20) activeSide.samples.push({ time: c.closeTime, state: preState,
                        activeHigh: preActive.HIGH, activeLow: preActive.LOW });
                }
            }
            return engine.onBar(c, i).then(function () {
                var post = engine.getState();
                var newEvents = post.structural5m.events.slice(preEvents);
                var actualBreakEvents = newEvents.filter(function (e) {
                    return e.type === 'STRUCTURAL_MSS' || e.type === 'STRUCTURAL_CONTINUATION';
                });
                if (inWindow(c.closeTime)) {
                    var simulatedState = preState;
                    ['LOW', 'HIGH'].forEach(function (side) {
                        var ref = preActive[side];
                        if (!ref || ref.status !== 'ACTIVE_PROTECTED' || firstCloseSeen[ref.id] ||
                            ref.protectedConfirmedAt > c.closeTime || !closeBreak(side, ref.price, c)) return;
                        firstCloseSeen[ref.id] = true;
                        var direction = breakDirection(side);
                        var expected = expectedClassification(simulatedState, direction);
                        var matching = actualBreakEvents.filter(function (e) {
                            return e.source && e.source.structuralSwingId === ref.id;
                        });
                        var actual = matching.length ? matching[0].type : null;
                        breakLedger.push({
                            protectedSwingId: ref.id, protectedSourceSwingId: ref.sourceSwingId,
                            protectedSide: side, protectedPrice: ref.price,
                            protectedConfirmedAt: ref.protectedConfirmedAt,
                            breakDirection: direction, breakTime: c.closeTime, breakTimeIso: iso(c.closeTime),
                            candleIndex: i, stateBefore: simulatedState,
                            expectedStateAfter: expected === 'STRUCTURAL_MSS' ? direction : simulatedState,
                            expectedClassification: expected, actualClassification: actual,
                            actualEventIds: matching.map(function (e) { return e.id; }),
                            classificationMatch: actual === expected,
                            breakCandle: compactCandle(c, i)
                        });
                        if (expected === 'STRUCTURAL_MSS') simulatedState = direction;
                    });
                }
                newEvents.forEach(function (e) {
                    if (!inWindow(e.confirmedAt)) return;
                    if (e.type === 'STRUCTURAL_BOS' || e.type === 'STRUCTURAL_CONTINUATION') {
                        var parent = post.structural5m.swings.filter(function (s) {
                            return e.source && s.id === e.source.structuralSwingId;
                        })[0] || null;
                        var control = post.structural5m.swingBySourceId[e.source && e.source.controllingSwingId] || null;
                        var protectedSide = e.direction === 'BULLISH' ? 'LOW' : 'HIGH';
                        var protectedSwing = post.structural5m.swings.filter(function (s) {
                            return s.side === protectedSide && s.provenance &&
                                s.provenance.bosCandleCloseTime === e.confirmedAt &&
                                s.provenance.parentStructuralLevelId === (parent && parent.id);
                        })[0] || null;
                        bosLedger.push({
                            eventId: e.id, direction: e.direction,
                            parentStructuralLevel: compactSwing(parent), controllingSwing: compactSwing(control),
                            protectedSwing: compactSwing(protectedSwing),
                            protectedConfirmedAt: protectedSwing ? protectedSwing.protectedConfirmedAt : null,
                            bosTime: e.confirmedAt, bosTimeIso: iso(e.confirmedAt),
                            candleIndex: e.candleIndex,
                            structuralStateBefore: e.structuralStateBefore,
                            structuralStateAfter: e.structuralStateAfter,
                            eventClassification: e.type
                        });
                    }
                });
                var mssNow = newEvents.filter(function (e) { return e.type === 'STRUCTURAL_MSS'; });
                if (mssNow.length) {
                    var lastMss = mssNow[mssNow.length - 1];
                    pendingPersistence = { eventId: lastMss.id, expectedState: lastMss.structuralStateAfter };
                }
                if (inWindow(c.closeTime)) stateTrace.push({ time: c.closeTime, stateBefore: preState,
                    stateAfter: post.structural5m.structuralState, eventIds: newEvents.map(function (e) { return e.id; }) });
            });
        });
    });

    return chain.then(function () {
        var st = engine.getState();
        var structuralEvents = st.structural5m.events.filter(function (e) { return inWindow(e.confirmedAt); });
        var actualMss = structuralEvents.filter(function (e) { return e.type === 'STRUCTURAL_MSS'; });
        var actualContinuation = structuralEvents.filter(function (e) { return e.type === 'STRUCTURAL_CONTINUATION'; });
        var registryBos = st.eventRegistry.getByType(SYMBOL, 'STRUCTURAL_BOS').filter(function (e) { return inWindow(e.confirmedAt); });
        var registryMss = st.eventRegistry.getByType(SYMBOL, 'STRUCTURAL_MSS').filter(function (e) { return inWindow(e.confirmedAt); });
        var registryContinuation = st.eventRegistry.getByType(SYMBOL, 'STRUCTURAL_CONTINUATION').filter(function (e) { return inWindow(e.confirmedAt); });
        var registryIds = {};
        registryBos.concat(registryMss, registryContinuation).forEach(function (e) { registryIds[e.id] = true; });
        var missingRegistry = structuralEvents.filter(function (e) {
            return ['STRUCTURAL_BOS', 'STRUCTURAL_MSS', 'STRUCTURAL_CONTINUATION'].indexOf(e.type) >= 0 && !registryIds[e.id];
        });
        var idCounts = {};
        structuralEvents.forEach(function (e) { idCounts[e.id] = (idCounts[e.id] || 0) + 1; });
        var duplicateIds = Object.keys(idCounts).filter(function (id) { return idCounts[id] > 1; });
        var bosOverwrites = bosLedger.filter(function (b) {
            return b.structuralStateBefore !== 'UNKNOWN' && b.structuralStateBefore !== b.structuralStateAfter;
        });
        var swingById = {};
        st.structural5m.swings.forEach(function (s) { swingById[s.id] = s; });
        breakLedger.forEach(function (b) {
            var ref = swingById[b.protectedSwingId];
            var controlSide = b.breakDirection === 'BULLISH' ? 'LOW' : 'HIGH';
            b.eligibleControlsAtFirstClose = st.structural5m.swings.filter(function (s) {
                return ref && s.side === controlSide && s.confirmedAt <= b.breakTime &&
                    s.occurredAt > ref.occurredAt && s.occurredAt < b.breakCandle.openTime;
            }).map(compactSwing);
            if (b.actualClassification != null) return;
            var delayed = structuralEvents.filter(function (e) {
                return (e.type === 'STRUCTURAL_MSS' || e.type === 'STRUCTURAL_CONTINUATION') &&
                    e.source && e.source.structuralSwingId === b.protectedSwingId && e.confirmedAt > b.breakTime;
            }).sort(function (a, z) { return a.confirmedAt - z.confirmedAt; })[0] || null;
            b.delayedActualClassification = delayed ? delayed.type : null;
            b.delayedActualEventId = delayed ? delayed.id : null;
            b.delayedActualTime = delayed ? delayed.confirmedAt : null;
            b.delayBars = delayed ? Math.round((delayed.confirmedAt - b.breakTime) / BAR) : null;
            b.firstCloseDeferralReason = b.eligibleControlsAtFirstClose.length === 0
                ? 'NO_CONFIRMED_CONTROLLING_SWING_AT_FIRST_CLOSE'
                : 'OTHER';
        });
        var premature = [];
        st.structural5m.swings.forEach(function (s) {
            (s.history || []).forEach(function (h) {
                if (h.role !== 'SUPERSEDED_PROTECTED' || !inWindow(h.confirmedAt)) return;
                var replacement = swingById[s.supersededBy];
                if (!replacement || replacement.protectedConfirmedAt == null || replacement.protectedConfirmedAt > h.confirmedAt) {
                    premature.push({ swingId: s.id, transitionTime: h.confirmedAt,
                        supersededBy: s.supersededBy, replacementProtectedConfirmedAt: replacement && replacement.protectedConfirmedAt });
                }
            });
        });
        var expectedMss = breakLedger;
        var expectedCont = bosLedger.filter(function (b) {
            return b.structuralStateBefore !== 'UNKNOWN' && b.structuralStateBefore === b.direction;
        });
        var frontierMismatches = bosLedger.filter(function (b) {
            var expected = b.structuralStateBefore === 'UNKNOWN' ? 'STRUCTURAL_BOS' : 'STRUCTURAL_CONTINUATION';
            return b.eventClassification !== expected;
        });
        var mismatch = breakLedger.filter(function (b) { return !b.classificationMatch; }).concat(frontierMismatches);
        var delayedBreakEvents = breakLedger.filter(function (b) { return b.delayedActualClassification != null; });
        var formationMss = seededSample(expectedMss, 5, 0x4d535331).map(function (b) { return formationFor(b, candles); });
        var formationCont = seededSample(expectedCont, 5, 0x434f4e54).map(function (b) {
            return { eventId: b.eventId, expectedClassification: 'STRUCTURAL_CONTINUATION',
                evaluationTime: b.bosTime,
                formationCandles: candles.slice(Math.max(0, b.candleIndex - 20), b.candleIndex + 1)
                    .map(function (c, offset) { return compactCandle(c, Math.max(0, b.candleIndex - 20) + offset); }) };
        });
        var future = [];
        bosLedger.forEach(function (b) {
            ['parentStructuralLevel', 'controllingSwing', 'protectedSwing'].forEach(function (f) {
                if (b[f] && b[f].confirmedAt > b.bosTime) future.push({ eventId: b.eventId, fact: f, confirmedAt: b[f].confirmedAt, evaluationTime: b.bosTime });
            });
            if (b.protectedConfirmedAt > b.bosTime) future.push({ eventId: b.eventId, fact: 'protectedConfirmedAt' });
        });
        breakLedger.forEach(function (b) {
            if (b.protectedConfirmedAt > b.breakTime) future.push({ protectedSwingId: b.protectedSwingId, fact: 'protectedConfirmedAt' });
        });
        formationMss.concat(formationCont).forEach(function (s) {
            s.formationCandles.forEach(function (c) {
                if (c.closeTime > s.evaluationTime) future.push({ protectedSwingId: s.protectedSwingId, fact: 'formationCandle' });
            });
        });
        var sourceLive = fs.readFileSync(path.join(ROOT, 'live/liveEngine.js'), 'utf8');
        var sourceReplay = fs.readFileSync(path.join(ROOT, 'replay/replayEngine.js'), 'utf8');
        var opportunityOnlyMss = /getByType\(symbol, 'STRUCTURAL_MSS'\)/.test(sourceLive) &&
            sourceLive.indexOf("getByType(symbol, 'STRUCTURAL_CONTINUATION')") < 0;
        var sameDirectionBos = bosLedger.filter(function (b) {
            return b.structuralStateBefore === b.direction && b.structuralStateAfter === b.direction;
        }).length;
        var explanation = 'ACTIVE_PROTECTED close breaks are classified immediately as opposite STRUCTURAL_MSS. Same-direction produced-frontier breaks are classified as STRUCTURAL_CONTINUATION; bootstrap-only breaks remain STRUCTURAL_BOS. Found ' + expectedCont.length + ' expected continuations, ' + actualContinuation.length + ' actual continuations, and ' + delayedBreakEvents.length + ' delayed protected-break events.';
        var rootCause = mismatch.length ? 'CLASSIFICATION_BUG'
            : (missingRegistry.length ? 'EVENT_WIRING_BUG' : 'SEMANTICS_RESOLVED');
        var afterHashes = hashes();
        var result = {
            audit: { version: '5m Structural Provenance V1 Event Completeness Audit', symbol: SYMBOL,
                days: 30, startTime: START, endTime: END, startIso: iso(START), endIso: iso(END),
                closedCandlesOnly: true, productionReplayPath: 'live/liveEngine.createLiveEngine().onBar' },
            counts: {
                STRUCTURAL_BOS_COUNT: structuralEvents.filter(function (e) { return e.type === 'STRUCTURAL_BOS'; }).length,
                ACTIVE_PROTECTED_CLOSE_BREAK_COUNT: breakLedger.length,
                EXPECTED_MSS_COUNT: expectedMss.length,
                EXPECTED_CONTINUATION_COUNT: expectedCont.length,
                ACTUAL_MSS_COUNT: actualMss.length,
                ACTUAL_CONTINUATION_COUNT: actualContinuation.length,
                CLASSIFICATION_MISMATCH_COUNT: mismatch.length,
                EXACT_TIME_MISMATCH_COUNT: delayedBreakEvents.length
            },
            bosLedger: bosLedger,
            activeProtectedCloseBreakLedger: breakLedger,
            mismatchLedger: mismatch,
            specialChecks: {
                mssStatePersistenceViolations: persistenceViolations,
                bosStateOverwriteViolations: bosOverwrites,
                prematureSupersessions: premature,
                activeSideLifecycle: activeSide,
                duplicateEventIds: duplicateIds,
                closeBreaksMissingEvent: breakLedger.filter(function (b) { return b.actualClassification == null; }),
                delayedBreakEvents: delayedBreakEvents,
                eventsMissingFromRegistry: missingRegistry,
                registryCounts: { bos: registryBos.length, mss: registryMss.length, continuation: registryContinuation.length },
                stateEventCounts: {
                    bos: structuralEvents.filter(function (e) { return e.type === 'STRUCTURAL_BOS'; }).length,
                    mss: actualMss.length, continuation: actualContinuation.length
                },
                sameDirectionBosCount: sameDirectionBos,
                opportunityConsumesOnlyStructuralMss: opportunityOnlyMss,
                replaySourceMentionsContinuationRegistration: sourceReplay.indexOf('STRUCTURAL_CONTINUATION') >= 0
            },
            formationSamples: { expectedMss: formationMss, expectedContinuation: formationCont,
                expectedContinuationSampleShortfall: Math.max(0, 5 - formationCont.length) },
            diagnosis: { EVENT_SEMANTICS_STATUS: rootCause, explanation: explanation },
            invariants: { PRODUCTION_CHANGED: !sameHashes(beforeHashes, afterHashes),
                FUTURE_LEAK_VIOLATIONS: future.length },
            futureLeakDetails: future,
            productionHashesBefore: beforeHashes,
            productionHashesAfter: afterHashes
        };
        fs.mkdirSync(path.join(ROOT, OUT), { recursive: true });
        fs.writeFileSync(path.join(ROOT, OUT, 'event-completeness-audit.json'), JSON.stringify(result, null, 2));
        fs.writeFileSync(path.join(ROOT, OUT, 'bos-ledger.json'), JSON.stringify(bosLedger, null, 2));
        fs.writeFileSync(path.join(ROOT, OUT, 'active-protected-close-break-ledger.json'), JSON.stringify(breakLedger, null, 2));
        fs.writeFileSync(path.join(ROOT, OUT, 'formation-samples.json'), JSON.stringify(result.formationSamples, null, 2));
        fs.writeFileSync(path.join(ROOT, OUT, 'EVENT_COMPLETENESS_AUDIT_REPORT.md'), render(result));
        console.log(JSON.stringify({ counts: result.counts, specialChecks: {
            persistence: persistenceViolations.length, bosOverwrite: bosOverwrites.length,
            prematureSupersession: premature.length, missingRegistry: missingRegistry.length,
            sameDirectionBos: sameDirectionBos, activeSideLifecycle: activeSide
        }, diagnosis: result.diagnosis, invariants: result.invariants }, null, 2));
        return result;
    });
}

if (require.main === module) run().catch(function (e) { console.error(e.stack || e); process.exit(1); });
module.exports = { run: run };
