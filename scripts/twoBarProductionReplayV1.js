'use strict';

/**
 * TWO_BAR_PRODUCTION_REPLACEMENT_V1 - causal replay over the saved BTCUSDT 5m
 * snapshot.
 *
 * This runs the REAL new-entry wiring, not the rules in isolation:
 *
 *   closed 5m candle -> TwoBarLivePipeline (one closed bar at a time)
 *     -> TwoBarSetupV1 (pattern LLM + preceding-leg LLM)
 *     -> TwoBarCurrentPoint -> Causal Dynamic-D EQ match (EQL/EQH)
 *     -> 4H direction gate -> BreakoutEntryPlan
 *     -> breakoutExecutionV1.onSetup  (SHADOW: LIVE_TRADING_ENABLED=false)
 *
 * LLM determinism: the frozen pattern/context decisions of the earlier
 * REVERSAL_PATTERN_SEMANTIC_AUDIT_V1 run are replayed from disk. No network LLM
 * call is made, and a candidate without a frozen decision fails closed locally.
 *
 * The 4H bias fed to the direction gate is a REPLAY-ONLY deterministic stand-in
 * (Theil-Sen slope of 48 closed 4H candles) because the production bias needs a
 * DeepSeek call. The gate itself (BREAKOUT_ENTRY_RULES_V1.htfDirectionGate) is
 * unchanged and still receives a production-shaped snapshot.
 *
 * Output: process funnel only. No PnL, MFE, MAE, win rate or outcome.
 *
 * Usage: ICT_PROXY_ENABLED=1 node scripts/twoBarProductionReplayV1.js
 *   (network is only used for the one-time warmup / exchangeInfo cache)
 */

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var AUDIT_DIR = path.join(__dirname, '..', 'output', 'reversal-pattern-semantic-audit-v1');
var OUT_DIR = path.join(__dirname, '..', 'output', 'two-bar-production-replacement-v1');
var SNAPSHOT_FILE = path.join(AUDIT_DIR, 'BTCUSDT-5m-two-bar-candles.json');
var STAGE1_FILE = path.join(AUDIT_DIR, 'BTCUSDT-5m-two-bar-stage1-results.json');
var CONTEXT_FILE = path.join(AUDIT_DIR, 'BTCUSDT-5m-two-bar-context-results.json');
var WARMUP_FILE = path.join(OUT_DIR, 'BTCUSDT-5m-warmup.json');
var HTF_FILE = path.join(OUT_DIR, 'BTCUSDT-4h-candles.json');
var RULES_FILE = path.join(OUT_DIR, 'BTCUSDT-exchangeInfo.json');
var REPORT_FILE = path.join(OUT_DIR, 'BTCUSDT-two-bar-production-replay-funnel.json');

var SYMBOL = 'BTCUSDT';
var WARMUP_BARS = 1500;

var twoBarSetupV1 = require('../strategy/twoBarSetupV1');
var twoBarLivePipelineV1 = require('../strategy/twoBarLivePipelineV1');
var breakoutExecutionV1 = require('../execution/breakoutExecutionV1');
var theilSen48 = require('../bias/directionalContext/theilSen48');

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
}
function canonical(value) {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(canonical);
    return Object.keys(value).sort().reduce(function (acc, k) { acc[k] = canonical(value[k]); return acc; }, {});
}
function stable(value) { return JSON.stringify(canonical(value)); }
function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
function fetchRest() { return require('../data/binanceRest'); }

// ---------------------------------------------------------------- warmup data

function loadWarmup() {
    if (fs.existsSync(WARMUP_FILE)) return Promise.resolve(readJson(WARMUP_FILE));
    var snapshot = readJson(SNAPSHOT_FILE);
    var endTime = snapshot.candles[0].openTime - 1;
    console.log('REPLAY_WARMUP_FETCH bars=' + WARMUP_BARS + ' endTime=' + endTime);
    return fetchRest().getFuturesKlinesStrict(SYMBOL, '5m', WARMUP_BARS, null, endTime)
        .then(function (candles) {
            if (candles.length < 900) throw new Error('WARMUP_INSUFFICIENT ' + candles.length);
            writeJson(WARMUP_FILE, { symbol: SYMBOL, interval: '5m', fetchedAt: Date.now(), candles: candles });
            return { symbol: SYMBOL, interval: '5m', candles: candles };
        });
}

function loadHtf() {
    if (fs.existsSync(HTF_FILE)) return Promise.resolve(readJson(HTF_FILE));
    return fetchRest().getFuturesKlinesStrict(SYMBOL, '4h', 500, null, null).then(function (candles) {
        writeJson(HTF_FILE, { symbol: SYMBOL, interval: '4h', fetchedAt: Date.now(), candles: candles });
        return { symbol: SYMBOL, interval: '4h', candles: candles };
    });
}

function loadSymbolRules() {
    if (fs.existsSync(RULES_FILE)) return Promise.resolve(readJson(RULES_FILE));
    return fetchRest().getExchangeInfo(SYMBOL).then(function (info) {
        writeJson(RULES_FILE, info);
        return info;
    });
}

// ------------------------------------------------------- frozen LLM decisions

/**
 * Rebuilds the TWO_BAR_SETUP_V1 frozen decision store from the saved audit
 * results. Keys are recomputed with the exact production key derivation, so a
 * lookup can only hit when the candidate identity is identical.
 */
function frozenStore(stage1, contextResults) {
    var map = {};
    function key(kind, direction, k1OpenTime, k2OpenTime) {
        return sha256(stable([SYMBOL, direction, k1OpenTime, k2OpenTime,
            twoBarSetupV1.PROMPT_VERSION, twoBarSetupV1.MODEL, kind]));
    }
    (stage1.results || []).forEach(function (r) {
        if (!r.llm) return;
        map[key('PATTERN', r.direction, r.k1.openTime, r.k2.openTime)] = r.llm;
    });
    (contextResults.results || []).forEach(function (r) {
        if (!r.context || r.status !== 'OK') return;
        var decision = {
            expectedDirection: r.context.expectedDirection,
            detectedDirection: r.context.detectedDirection,
            label: r.context.label,
            confidence: r.context.confidence,
            estimatedLegBars: r.context.estimatedLegBars,
            reason: r.context.reason
        };
        map[key('CONTEXT', r.direction, r.k1.openTime, r.k2.openTime)] = decision;
    });
    var hits = 0;
    var misses = 0;
    return {
        lookup: function (k) {
            if (map[k]) { hits += 1; return { decision: map[k] }; }
            misses += 1;
            return null;
        },
        // Unreachable in replay (requestSemantic throws first); kept defensive so a
        // non-frozen decision can never be silently admitted.
        freeze: function () {
            throw Object.assign(new Error('REPLAY_NO_FROZEN_DECISION'), { code: 'REPLAY_NO_FROZEN_DECISION' });
        },
        stats: function () { return { frozenKeys: Object.keys(map).length, hits: hits, misses: misses }; }
    };
}

// ------------------------------------------------------------ HTF stand-in

function twoBarMirrorBias(htfCandles, evaluationTime) {
    var closed = htfCandles.filter(function (c) { return c.closed !== false && c.closeTime <= evaluationTime; });
    if (closed.length < theilSen48.WINDOW) return null;
    var slope;
    try { slope = theilSen48.slope48(closed); } catch (e) { return null; }
    var direction = slope > 0 ? 'BULLISH' : slope < 0 ? 'BEARISH' : 'NEUTRAL';
    var last = closed[closed.length - 1];
    return { status: 'AVAILABLE', closedAt: last.closeTime, expectedClosedAt: last.closeTime,
        semantic: { direction: direction, strength: 'MODERATE', confidence: 'MEDIUM' },
        source: 'REPLAY_DETERMINISTIC_THEILSEN48_4H_CLOSE' };
}

// ---------------------------------------------------------------- main replay

function main() {
    var snapshot = readJson(SNAPSHOT_FILE);
    var replay = snapshot.candles;
    return Promise.all([loadWarmup(), loadHtf(), loadSymbolRules()]).then(function (loaded) {
        var warmup = loaded[0].candles;
        var htf = loaded[1].candles;
        var symbolRules = loaded[2];
        var combined = warmup.concat(replay);
        var warmupLength = warmup.length;
        if (warmup[warmup.length - 1].closeTime >= replay[0].openTime) {
            throw new Error('WARMUP_NOT_CONTIGUOUS');
        }
        console.log('REPLAY_WINDOW candles=' + replay.length +
            ' ' + new Date(replay[0].openTime).toISOString() + ' -> ' +
            new Date(replay[replay.length - 1].closeTime).toISOString());
        console.log('REPLAY_WARMUP candles=' + warmupLength + '（ATR / Dynamic-D / EQ partner window）');

        // Real mutation counters over the real execution client. live=false makes
        // every mutating call impossible; the counters prove it.
        var counters = { placeBreakoutEntry: 0, submitProtection: 0, cancelAlgo: 0,
            setLeverage: 0, setMarginType: 0, otherMutation: 0 };
        var realClient = require('../execution/binanceExecutionClientV1')
            .createClient({ liveTradingEnabled: false });
        var client = {};
        Object.keys(realClient).forEach(function (k) {
            client[k] = function () {
                if (k === 'placeBreakoutEntry' || k === 'submitProtection' || k === 'cancelAlgo' ||
                        k === 'setLeverage' || k === 'setMarginType') {
                    counters[k] += 1;
                }
                return realClient[k].apply(realClient, arguments);
            };
        });

        var store = frozenStore(readJson(STAGE1_FILE), readJson(CONTEXT_FILE));
        var llmRequests = { attempted: 0 };
        var setupService = twoBarSetupV1.createService({
            symbol: SYMBOL,
            decisionStore: store,
            // A candidate whose identity is not in the frozen audit result must
            // fail closed locally - never fall back to a live DeepSeek call.
            requestSemantic: function () {
                llmRequests.attempted += 1;
                throw Object.assign(new Error('REPLAY_NO_FROZEN_DECISION'), { code: 'REPLAY_NO_FROZEN_DECISION' });
            }
        });

        var execution = breakoutExecutionV1.createService({
            symbol: SYMBOL,
            liveTradingEnabled: false,
            client: client,
            getMarkPrice: function () { return null; },
            getNewTradeAdmission: function () { return { admitted: true, reasonCode: null }; },
            observe: function () {}
        });

        var currentIndex = warmupLength - 1;
        var pipeline = twoBarLivePipelineV1.createPipeline({
            symbol: SYMBOL,
            setupService: setupService,
            execution: execution,
            liveTradingEnabled: false,
            getBias: function () { return twoBarMirrorBias(htf, combined[Math.max(0, currentIndex)].closeTime); },
            getExpected4hClosedAt: function () {
                var bias = twoBarMirrorBias(htf, combined[Math.max(0, currentIndex)].closeTime);
                return bias ? bias.expectedClosedAt : null;
            },
            getSymbolRules: function () { return symbolRules; },
            getCurrentContractPrice: function () { return combined[Math.max(0, currentIndex)].close; }
        });

        pipeline.warmupThrough(combined, warmupLength - 1);

        var chain = Promise.resolve();
        var perBar = [];
        for (var i = warmupLength; i < combined.length; i++) {
            (function (index) {
                chain = chain.then(function () {
                    currentIndex = index;
                    return pipeline.onClosedBar(combined, index).then(function (delta) {
                        if (delta.candidates > 0 || delta.plans.length > 0) {
                            perBar.push({ index: index - warmupLength, openTime: combined[index].openTime,
                                candidates: delta.candidates, plans: delta.plans.length,
                                reasons: delta.reasons });
                        }
                    });
                });
            })(i);
        }

        return chain.then(function () {
            var funnel = pipeline.funnel();
            var snapshotOut = execution.getSnapshot();
            var trades = Object.keys(snapshotOut.trades || {}).map(function (k) { return snapshotOut.trades[k]; });
            var report = {
                task: 'TWO_BAR_PRODUCTION_REPLACEMENT_V1_CAUSAL_REPLAY',
                symbol: SYMBOL,
                liveTradingEnabled: false,
                evaluationWindow: { candleCount: replay.length,
                    firstOpenTime: replay[0].openTime, lastCloseTime: replay[replay.length - 1].closeTime },
                warmupCandleCount: warmupLength,
                llmMode: 'FROZEN_DECISIONS_REPLAYED_FROM_REVERSAL_PATTERN_SEMANTIC_AUDIT_V1',
                liveLlmRequestsAttempted: llmRequests.attempted,
                htfBiasSource: 'REPLAY_DETERMINISTIC_THEILSEN48_4H_CLOSE（no LLM; gate unchanged）',
                frozenStore: store.stats(),
                funnel: funnel,
                evaluationCandles: replay.length,
                barsAdvancedIncludingWarmup: funnel.bars,
                shadowSetups: trades.map(function (t) {
                    return { tradeId: t.tradeId, status: t.status, direction: t.plan.direction,
                        setupId: t.plan.setupId, eqType: t.plan.eqType,
                        entryTrigger: t.plan.entryTrigger, initialSL: t.plan.initialSL,
                        initialTP: t.plan.initialTP, initialRR: t.plan.initialRR,
                        htfDirection: t.plan.htfDirection, requestedQty: t.plan.requestedQty };
                }),
                mutationCounters: counters,
                perBarWithActivity: perBar
            };
            writeJson(REPORT_FILE, report);

            console.log('');
            console.log('=== TWO_BAR PRODUCTION REPLACEMENT V1 — CAUSAL REPLAY FUNNEL ===');
            console.log('evaluation candles        : ' + replay.length +
                '（warmup advanced first: ' + (funnel.bars - replay.length) + '）');
            console.log('Two-Bar candidates        : ' + funnel.candidates);
            console.log('pattern CLEAR             : ' + funnel.patternClear);
            console.log('context CLEAR (aligned)   : ' + funnel.contextAligned);
            console.log('EQ matched (Dynamic-D)    : ' + funnel.eqMatched);
            console.log('HTF direction aligned     : ' + funnel.htfAligned);
            console.log('already crossed           : ' + funnel.alreadyCrossed);
            console.log('no Dynamic-D target       : ' + funnel.noTarget);
            console.log('RR / geometry rejected    : ' + funnel.rrRejected);
            console.log('breakout plans            : ' + funnel.plans);
            console.log('shadow setups accepted    : ' + funnel.accepted);
            console.log('llm errors (fail-closed)  : ' + funnel.llmErrors);
            console.log('');
            console.log('REAL_ORDER_PLACE_COUNT=' + counters.placeBreakoutEntry);
            console.log('REAL_ORDER_CANCEL_COUNT=' + counters.cancelAlgo);
            console.log('REAL_LEVERAGE_MUTATION_COUNT=' + counters.setLeverage);
            console.log('REAL_MARGIN_MUTATION_COUNT=' + counters.setMarginType);
            console.log('REAL_ORDER_MUTATIONS=' + (counters.placeBreakoutEntry + counters.submitProtection +
                counters.cancelAlgo + counters.setLeverage + counters.setMarginType));
            console.log('SHADOW_SETUP_COUNT=' + trades.length);
            console.log('REPLAY_REPORT=' + REPORT_FILE);
        });
    });
}

if (require.main === module) {
    main().catch(function (error) {
        console.error('REPLAY_FAILED ' + (error && error.stack || error));
        process.exitCode = 1;
    });
}

module.exports = { main: main };
