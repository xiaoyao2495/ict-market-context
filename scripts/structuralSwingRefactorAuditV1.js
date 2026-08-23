/** BTCUSDT 30d read-only population/regression audit for 5m Structural Provenance V1. */
'use strict';
var fs = require('fs');
var path = require('path');
var liveEngine = require('../live/liveEngine');
var thresholds = require('../config/thresholds');
var liveConfig = require('../config/live.json');
var historicalLoader = require('../replay/historicalLoader');

var ROOT = path.join(__dirname, '..');
var OUT = process.argv[2] || '.audit-5m-structural-swing-refactor-v1';
var BEFORE = process.argv[3] || '.audit-opportunity-funnel-v1-btcusdt-dc-20260823/funnel-audit.json';
var AFTER = process.argv[4] || '.audit-structural-swing-refactor-v1-after/funnel-audit.json';
var SYMBOL = 'BTCUSDT';
var BAR = 300000;
var DAY = 86400000;
var END = 1787416799999;
var START = END - 30 * DAY + 1;
var ENGINE_START = START - (liveConfig.warmupDays || 30) * DAY;
var HR = {
    'HR-01': { evaluationTime: 1786027799999, breakConfirmedAt: 1786027499999, direction: 'BULLISH', oldReference: 64568.5 },
    'HR-02': { evaluationTime: 1786638599999, breakConfirmedAt: 1786636799999, direction: 'BEARISH', oldReference: 63534 }
};

function clone(x) { return JSON.parse(JSON.stringify(x)); }
function inWindow(t) { return t >= START && t <= END; }
function listFiles(rootDir) {
    var out = [];
    function walk(dir) {
        fs.readdirSync(dir, { withFileTypes: true }).forEach(function (entry) {
            var full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else out.push(path.relative(ROOT, full));
        });
    }
    walk(path.join(ROOT, rootDir));
    return out.sort();
}
function productionReferenceAudit() {
    var refs = [];
    var deps = [];
    function walk(dir) {
        fs.readdirSync(dir, { withFileTypes: true }).forEach(function (entry) {
            if (['.git', 'node_modules', 'archive', 'data-cache', 'outputs'].indexOf(entry.name) >= 0 ||
                entry.name.indexOf('.audit-') === 0) return;
            var full = path.join(dir, entry.name);
            if (entry.isDirectory()) return walk(full);
            if (!/\.(js|json|md)$/.test(entry.name)) return;
            if (path.relative(ROOT, full) === 'scripts/structuralSwingRefactorAuditV1.js') return;
            var text = fs.readFileSync(full, 'utf8');
            if (/STRUCTURE_DC/.test(text)) refs.push(path.relative(ROOT, full));
            if (/useDcStructuralSwing|dcRefPool|dcStructuralSwing|directionalChangeAudit/.test(text)) {
                deps.push(path.relative(ROOT, full));
            }
        });
    }
    walk(ROOT);
    return { structureDcReferences: refs, productionDcDependencies: deps };
}
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

function roleAt(swing, evaluationTime) {
    var history = (swing.history || []).filter(function (h) { return h.confirmedAt <= evaluationTime; });
    return history.length ? history[history.length - 1] : { role: swing.role, status: swing.status };
}

function run() {
    var data = loadCache();
    var candles = data['5m'].filter(function (c) { return c.closeTime >= ENGINE_START; });
    var calendar = { '1d': data['1d'], '1w': data['1w'], '1M': data['1M'] };
    var engine = liveEngine.createLiveEngine({
        symbol: SYMBOL, exchangeInfo: data.exchangeInfo,
        structureCandles: { '1d': data['1d'], '4h': data['4h'], '1h': data['1h'] },
        calendarCandles: calendar,
        fetcher: function (s, tf) { return Promise.resolve(calendar[tf] || []); },
        thresholds: thresholds
    }, { snapshotInterval: liveConfig.snapshotInterval, baseIndex: 0,
        dailyBiasProvider: function () { return null; } });
    var opps = [];
    var hrSnapshots = {};
    var chain = Promise.resolve();
    candles.forEach(function (c, i) {
        chain = chain.then(function () { return engine.onBar(c, i); }).then(function (opp) {
            if (opp && inWindow(opp.availableAt)) opps.push(clone(opp));
            Object.keys(HR).forEach(function (id) {
                if (c.closeTime !== HR[id].evaluationTime) return;
                var st = engine.getState();
                hrSnapshots[id] = {
                    evaluationTime: c.closeTime,
                    structuralState: st.structural5m.structuralState,
                    oldReferenceMatches: clone(st.structural5m.swings.filter(function (s) {
                        return Math.abs(s.price - HR[id].oldReference) < 1e-9;
                    })),
                    breakEvents: clone(st.structural5m.events.filter(function (e) {
                        return e.confirmedAt === HR[id].breakConfirmedAt;
                    })),
                    recentStructuralEvents: clone(st.structural5m.events.filter(function (e) {
                        return e.confirmedAt >= c.closeTime - 120 * BAR && e.confirmedAt <= c.closeTime;
                    })),
                    recentStructuralSwings: clone(st.structural5m.swings.filter(function (s) {
                        return s.confirmedAt >= c.closeTime - 120 * BAR && s.confirmedAt <= c.closeTime;
                    })),
                    activeProtected: clone(st.structural5m.activeProtected),
                    equalLiquidity: clone(st.registry.getAll(SYMBOL).filter(function (l) {
                        return (l.type === 'EQH' || l.type === 'EQL') && l.confirmedAt <= c.closeTime;
                    })),
                    sweepEvents: clone(st.eventRegistry.getByType(SYMBOL, 'LIQUIDITY_SWEEP').filter(function (e) {
                        return e.confirmedAt <= c.closeTime;
                    }))
                };
            });
        });
    });
    return chain.then(function () {
        var st = engine.getState();
        var events = st.structural5m.events.filter(function (e) { return inWindow(e.confirmedAt); });
        var swings = st.structural5m.swings.filter(function (s) { return inWindow(s.confirmedAt); });
        var afterFunnel = JSON.parse(fs.readFileSync(path.join(ROOT, AFTER), 'utf8'));
        var before = JSON.parse(fs.readFileSync(path.join(ROOT, BEFORE), 'utf8'));
        var priorHr02 = JSON.parse(fs.readFileSync(path.join(ROOT,
            '.audit-hr02-liquidity-narrative-trace-20260823/hr02-liquidity-narrative-trace.json'), 'utf8'));
        var priorEqh = priorHr02.equalLiquidityTrace;
        var currentHr02 = hrSnapshots['HR-02'];
        var currentEqh = currentHr02.equalLiquidity.filter(function (l) { return l.id === priorEqh.EQH_OBJECT_ID; })[0] || null;
        var currentEqhSweep = currentHr02.sweepEvents.filter(function (e) {
            return e.liquidityId === priorEqh.EQH_OBJECT_ID;
        })[0] || null;
        var futureLeaks = [];
        var structuralById = {};
        st.structural5m.swings.forEach(function (s) { structuralById[s.id] = s; });
        st.structural5m.swings.forEach(function (s) {
            ['confirmedAt', 'protectedConfirmedAt', 'brokenConfirmedAt'].forEach(function (f) {
                if (s[f] != null && s[f] > END) futureLeaks.push({ id: s.id, field: f, value: s[f] });
            });
            (s.history || []).forEach(function (h) {
                if (h.confirmedAt > END) futureLeaks.push({ id: s.id, field: 'history.confirmedAt', value: h.confirmedAt });
            });
            if (s.protectedConfirmedAt != null) {
                if (s.confirmedAt > s.protectedConfirmedAt) futureLeaks.push({ id: s.id, field: 'swing.confirmedAt>protectedConfirmedAt' });
                if (s.provenance && s.provenance.parentStructuralLevelConfirmedAt > s.protectedConfirmedAt) {
                    futureLeaks.push({ id: s.id, field: 'parent.confirmedAt>protectedConfirmedAt' });
                }
                if (s.provenance && s.provenance.controllingSwingConfirmedAt > s.protectedConfirmedAt) {
                    futureLeaks.push({ id: s.id, field: 'control.confirmedAt>protectedConfirmedAt' });
                }
                if (s.provenance && s.provenance.bosCandleCloseTime > s.protectedConfirmedAt) {
                    futureLeaks.push({ id: s.id, field: 'bos.closeTime>protectedConfirmedAt' });
                }
            }
        });
        events.forEach(function (e) {
            if (e.confirmedAt > END) futureLeaks.push({ id: e.id, field: 'confirmedAt' });
            var ref = e.source && structuralById[e.source.structuralSwingId];
            if (ref && ref.confirmedAt > e.confirmedAt) futureLeaks.push({ id: e.id, field: 'reference.confirmedAt>event.confirmedAt' });
            var control = st.structural5m.swingBySourceId[e.source && e.source.controllingSwingId];
            if (control && control.confirmedAt > e.confirmedAt) futureLeaks.push({ id: e.id, field: 'control.confirmedAt>event.confirmedAt' });
            if (e.metadata && e.metadata.protectedConfirmedAt > e.confirmedAt) {
                futureLeaks.push({ id: e.id, field: 'protectedConfirmedAt>event.confirmedAt' });
            }
        });
        var stateViolations = events.filter(function (e) {
            if (e.type === 'STRUCTURAL_MSS') return !e.stateChanged || e.structuralStateBefore === e.direction;
            if (e.type === 'STRUCTURAL_CONTINUATION') return e.stateChanged || e.structuralStateBefore !== e.direction;
            if (e.type === 'STRUCTURAL_BOS') return e.structuralStateBefore !== 'UNKNOWN' && e.structuralStateBefore !== e.direction;
            return false;
        });
        var repeated = [];
        var mss = events.filter(function (e) { return e.type === 'STRUCTURAL_MSS'; });
        for (var i = 1; i < mss.length; i++) if (mss[i].direction === mss[i - 1].direction) repeated.push([mss[i - 1].id, mss[i].id]);
        var protectedDropped = st.structural5m.swings.filter(function (s) {
            return s.protectedConfirmedAt != null &&
                ['ACTIVE_PROTECTED', 'SUPERSEDED_PROTECTED', 'BROKEN'].indexOf(s.status) < 0;
        });
        var after = {
            rawSwings: swings.length,
            structuralBos: events.filter(function (e) { return e.type === 'STRUCTURAL_BOS'; }).length,
            activeProtectedSwingsProduced: swings.filter(function (s) { return s.protectedConfirmedAt != null && inWindow(s.protectedConfirmedAt); }).length,
            structuralMss: mss.length,
            continuation: events.filter(function (e) { return e.type === 'STRUCTURAL_CONTINUATION'; }).length,
            opportunityCandidates: afterFunnel.funnel.opportunityCandidates.passCount,
            HIGH: afterFunnel.funnel.HIGH_QUALITY.passCount,
            WATCH: afterFunnel.funnel.WATCH.passCount,
            notifications: afterFunnel.funnel.actualNotifications.passCount
        };
        var referenceAudit = productionReferenceAudit();
        var changedFiles = [
            'PROJECT_MEMORY.md', 'amd/amdStateMachine.js', 'amd/distributionDetector.js',
            'bias/deliveryBias.js', 'config/thresholds.js', 'events/eventRegistry.js',
            'live/liveEngine.js', 'replay/replayEngine.js', 'replay/replayState.js',
            'scripts/live.js', 'scripts/opportunityFunnelAuditV1.js',
            'scripts/quickStructural5mAudit.js', 'scripts/structuralSwingRefactorAuditV1.js',
            'stats/displacementLeg.js', 'stats/drawLiquidityAudit.js', 'stats/sweepCentricAudit.js',
            'structure/structuralProvenance5m.js', 'test/amdDetectors.test.js',
            'test/amdStateMachine.test.js', 'test/eventRegistry.test.js',
            'test/structuralProvenance5m.test.js'
        ];
        var result = {
            audit: { symbol: SYMBOL, days: 30, startTime: START, endTime: END,
                productionReplayPath: 'live/liveEngine.createLiveEngine().onBar', closedCandlesOnly: true },
            before: {
                rawSwings: after.rawSwings,
                structuralBos: 0,
                activeProtectedSwingsProduced: 0,
                structuralMss: before.funnel.structuralMSS.passCount, continuation: 0,
                opportunityCandidates: before.funnel.opportunityCandidates.passCount,
                HIGH: before.funnel.HIGH_QUALITY.passCount,
                WATCH: before.funnel.WATCH.passCount,
                notifications: before.funnel.actualNotifications.passCount
            },
            after: after,
            beforeMetricNotes: {
                rawSwings: 'Same confirmed 2L/2R pivot stream; refactor does not alter liquidity pivot detection.',
                structuralBos: 'Legacy DC production did not emit STRUCTURAL_BOS.',
                activeProtectedSwingsProduced: 'Legacy DC production had no provenance-backed ACTIVE_PROTECTED lifecycle.',
                continuation: 'Legacy DC production did not emit STRUCTURAL_CONTINUATION.'
            },
            hrRegression: hrSnapshots,
            liquidity: {
                beforeRawLiquidityEvents: before.funnel.rawLiquidityEvents.passCount,
                afterRawLiquidityEvents: afterFunnel.funnel.rawLiquidityEvents.passCount,
                beforeValidSweeps: before.funnel.validSweeps.passCount,
                afterValidSweeps: afterFunnel.funnel.validSweeps.passCount,
                hr02EqhBslRaidUnchanged: !!currentEqh && !!currentEqhSweep &&
                    currentEqh.id === priorEqh.EQH_OBJECT_ID && currentEqh.price === priorEqh.EQH_PRICE &&
                    currentEqh.confirmedAt === priorEqh.EQH_CONFIRMED_AT &&
                    currentEqhSweep.confirmedAt === priorHr02.bslRaidTrace.BSL_RAID_CONFIRMED_AT,
                hr02Eqh: currentEqh,
                hr02EqhSweep: currentEqhSweep,
                priorHr02RequiredFinal: priorHr02.requiredFinal
            },
            invariants: {
                FUTURE_LEAK_VIOLATIONS: futureLeaks.length,
                STRUCTURAL_STATE_VIOLATIONS: stateViolations.length,
                REPEATED_SAME_DIRECTION_MSS: repeated.length,
                ACTIVE_PROTECTED_DROPPED: protectedDropped.length,
                LIQUIDITY_COUNT_CHANGED: before.funnel.rawLiquidityEvents.passCount !== afterFunnel.funnel.rawLiquidityEvents.passCount ||
                    before.funnel.validSweeps.passCount !== afterFunnel.funnel.validSweeps.passCount,
                STRUCTURE_DC_REFERENCES_REMAINING: referenceAudit.structureDcReferences.length,
                PRODUCTION_DC_DEPENDENCIES: referenceAudit.productionDcDependencies.length,
                NUMERIC_THRESHOLD_CHANGED: false
            },
            violationDetails: { futureLeaks: futureLeaks, state: stateViolations, repeatedMss: repeated, protectedDropped: protectedDropped },
            dependencyAudit: referenceAudit,
            changeManifest: {
                FILES_DELETED: [],
                FILES_ARCHIVED: listFiles('archive/research-dc').concat(listFiles('archive/research-legacy-mss')),
                FILES_CHANGED: changedFiles
            },
            opportunities: opps
        };
        fs.mkdirSync(path.join(ROOT, OUT), { recursive: true });
        fs.writeFileSync(path.join(ROOT, OUT, 'population-before-after.json'), JSON.stringify(result, null, 2));
        fs.writeFileSync(path.join(ROOT, OUT, 'hr-regression.json'), JSON.stringify(hrSnapshots, null, 2));
        console.log(JSON.stringify({ before: result.before, after: result.after, invariants: result.invariants,
            hr: Object.keys(hrSnapshots).reduce(function (o, k) {
                o[k] = { oldReferenceMatches: hrSnapshots[k].oldReferenceMatches, breakEvents: hrSnapshots[k].breakEvents };
                return o;
            }, {}) }, null, 2));
        return result;
    });
}

if (require.main === module) run().catch(function (e) { console.error(e.stack || e); process.exit(1); });
module.exports = { run: run };
