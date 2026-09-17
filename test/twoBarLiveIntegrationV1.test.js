'use strict';

// TWO_BAR_PRODUCTION_REPLACEMENT_V1 - live wiring integration (A-R).
//
// Everything runs against a mock exchange, so no socket and no Binance request is
// made. The LLM stages of the setup service are scripted (deterministic), which is
// exactly what the frozen production decision store does during a replay.

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');

var L = require('../research/reversalPatternSemanticAuditV1');
var twoBarSetupV1 = require('../strategy/twoBarSetupV1');
var rules = require('../execution/breakoutEntryRulesV1');
var breakoutExecutionV1 = require('../execution/breakoutExecutionV1');
var executionRepositoryV1 = require('../execution/executionRepositoryV1');
var executionClient = require('../execution/binanceExecutionClientV1');
var universe = require('../live/dynamicContractUniverseV1');

var BAR = 300000;
var RULES = { source: 'futures', tickSize: 0.1, stepSize: 0.001, minQty: 0.001, maxQty: 1000,
    minNotional: 5, minPrice: 0.1, maxPrice: 1000000 };

var passed = 0;
var failed = 0;
async function check(name, fn) {
    try {
        await fn();
        passed += 1;
        console.log('PASS ' + name);
    } catch (e) {
        failed += 1;
        console.log('FAIL ' + name);
        console.log('  ' + (e && e.stack || e));
    }
}

// ------------------------------------------------------------------- fixtures

function bar(i, o, h, l, c) {
    return { openTime: i * BAR, closeTime: (i + 1) * BAR - 1, open: o, high: h, low: l, close: c,
        closed: true, source: 'futures' };
}

/** 20 closed candles: a bearish leg into K1, then a bullish Two-Bar takeover. */
function bullishCandles() {
    var rows = [];
    var close = 105;
    for (var i = 0; i < 8; i++) {
        var open = close;
        close = close - 0.7;
        rows.push(bar(i, open, open + 0.2, close - 0.3, close));
    }
    rows.push(bar(8, 100.6, 100.8, 99.2, 99.4));
    rows.push(bar(9, 99.4, 100.9, 99.0, 100.8));
    for (var j = 10; j < 20; j++) {
        var prev = rows[j - 1].close;
        rows.push(bar(j, prev, prev + 0.5, prev - 0.2, prev + 0.4));
    }
    return rows;
}

/** Mirror fixture: a bullish leg into K1, then a bearish Two-Bar takeover. */
function bearishCandles() {
    var rows = [];
    var close = 95;
    for (var i = 0; i < 8; i++) {
        var open = close;
        close = close + 0.7;
        rows.push(bar(i, open, close + 0.3, open - 0.2, close));
    }
    rows.push(bar(8, 99.4, 100.8, 99.2, 100.6));
    rows.push(bar(9, 100.6, 101.0, 99.1, 99.2));
    for (var j = 10; j < 20; j++) {
        var prev = rows[j - 1].close;
        rows.push(bar(j, prev, prev + 0.2, prev - 0.5, prev - 0.4));
    }
    return rows;
}

function candidate(direction, candles, startIndex) {
    var k1 = candles[startIndex];
    var k2 = candles[startIndex + 1];
    return { pattern: 'TWO_BAR_REVERSAL', direction: direction, startIndex: startIndex,
        endIndex: startIndex + 1, symbol: 'BTCUSDT',
        windowBars: [k1, k2], windowFacts: [L.candleFacts(k1), L.candleFacts(k2)] };
}

function patternDecision(direction) {
    return { matches: [{ pattern: 'TWO_BAR_REVERSAL', direction: direction, label: 'CLEAR',
        confidence: 'HIGH', supportingFacts: ['t'], conflicts: [], reason: 't' }],
        overall: 'CLEAR_PATTERN' };
}

function contextDecision(direction) {
    var expected = direction === 'BULLISH' ? 'BEARISH' : 'BULLISH';
    return { expectedDirection: expected, detectedDirection: expected, label: 'CLEAR',
        confidence: 'HIGH', estimatedLegBars: 6, reason: 't' };
}

function dPoint(id, side, price, occurredBarIndex, confirmedAt) {
    return { id: id, pointSide: side, price: price, state: 'ACTIVE',
        occurredAt: (occurredBarIndex + 1) * BAR,
        confirmedAt: confirmedAt === undefined ? occurredBarIndex * BAR + (BAR - 1) : confirmedAt,
        occurredBarIndex: occurredBarIndex, localizedExtremePrice: price,
        localizationMode: 'SAME_PROCESS_WICK_V1' };
}

/** Runs the REAL setup service (pattern LLM + context LLM scripted) over a fixture. */
function evaluateSetup(direction, options) {
    var opts = options || {};
    var candles = direction === 'BULLISH' ? bullishCandles() : bearishCandles();
    var service = twoBarSetupV1.createService({
        symbol: 'BTCUSDT',
        decisionStore: twoBarSetupV1.createMemoryStore(),
        requestSemantic: function (systemPrompt) {
            return Promise.resolve(systemPrompt === L.SYSTEM_PROMPT
                ? (opts.pattern || patternDecision(direction))
                : (opts.context || contextDecision(direction)));
        }
    });
    var dynamicDState = { recentSurvivalPoints: opts.dynamicDPoints || [] };
    return service.evaluateCandidate(candidate(direction, candles, 8), {
        candles: candles, atrValue: opts.atrValue === undefined ? 1.0 : opts.atrValue,
        dynamicDState: dynamicDState, currentBarIndex: 9
    }).then(function (result) {
        return { candles: candles, dynamicDState: dynamicDState, result: result };
    });
}

function bias(direction, strength, confidence) {
    return { status: 'AVAILABLE', closedAt: 1000, expectedClosedAt: 1000,
        semantic: { direction: direction, strength: strength, confidence: confidence } };
}

/** Long fixture: LOW EQ partner below the two-bar low, HIGH target above the trigger. */
function longDynamicD() {
    return { dynamicDPoints: [dPoint('DYN_LOW_1', 'LOW', 98.6, 5),
        dPoint('DYN_HIGH_1', 'HIGH', 106.0, 6)] };
}

function shortDynamicD() {
    return { dynamicDPoints: [dPoint('DYN_HIGH_1', 'HIGH', 101.2, 5),
        dPoint('DYN_LOW_1', 'LOW', 93.5, 6)] };
}

function longPlanInputs(evaluated, currentContractPrice, htf) {
    return { symbolRules: RULES, bias: htf, currentContractPrice: currentContractPrice,
        dynamicDPoints: evaluated.dynamicDState.recentSurvivalPoints, candles: evaluated.candles };
}

// -------------------------------------------------------------- mock exchange

function mockExchange(options) {
    var opts = options || {};
    var ex = { positionAmt: opts.positionQty || 0, openAlgos: [], openOrders: [], leverage: 10,
        mutations: [], mark: opts.mark === undefined ? 100.5 : opts.mark, seq: 0,
        failProtectionRole: opts.failProtectionRole || null, onCancel: opts.onCancel || null };
    function nextId(role) { ex.seq += 1; return ('IMC_BTCUSDT_' + role + '_' + ex.seq).slice(0, 36); }
    var client = {
        placeBreakoutEntry: function (plan) {
            var id = nextId('ENTRY');
            ex.mutations.push({ op: 'PLACE_BREAKOUT_ENTRY', clientAlgoId: id, params: plan });
            ex.openAlgos.push({ clientAlgoId: id, algoStatus: 'NEW' });
            return Promise.resolve({ clientAlgoId: id, algoStatus: 'NEW' });
        },
        submitProtection: function (plan, role) {
            if (ex.failProtectionRole === role) {
                return Promise.reject(Object.assign(new Error('EXCHANGE_REJECTED'), { code: 'EXCHANGE_REJECTED' }));
            }
            var id = nextId(role);
            ex.mutations.push({ op: 'PLACE_PROTECTION', role: role, clientAlgoId: id, params: plan });
            ex.openAlgos.push({ clientAlgoId: id, algoStatus: 'NEW' });
            return Promise.resolve({ clientAlgoId: id, algoStatus: 'NEW' });
        },
        queryAlgoOrder: function (symbol, algoId, clientAlgoId) {
            var found = ex.openAlgos.filter(function (o) { return o.clientAlgoId === clientAlgoId; })[0];
            return Promise.resolve(found || { clientAlgoId: clientAlgoId, algoStatus: 'CANCELED' });
        },
        cancelAlgo: function (symbol, clientAlgoId) {
            ex.mutations.push({ op: 'CANCEL_ALGO', clientAlgoId: clientAlgoId });
            ex.openAlgos = ex.openAlgos.filter(function (o) { return o.clientAlgoId !== clientAlgoId; });
            if (ex.onCancel) ex.onCancel(clientAlgoId, ex);
            return Promise.resolve({ clientAlgoId: clientAlgoId, algoStatus: 'CANCELED' });
        },
        getPositionRisk: function () {
            return Promise.resolve([{ symbol: 'BTCUSDT', positionAmt: String(ex.positionAmt) }]);
        },
        getOpenOrders: function () { return Promise.resolve(ex.openOrders.slice()); },
        getOpenAlgoOrders: function () { return Promise.resolve(ex.openAlgos.slice()); },
        syncTime: function () { return Promise.resolve({ serverTime: Date.now() }); },
        getPositionMode: function () { return Promise.resolve({ dualSidePosition: false }); },
        getSymbolConfig: function () { return Promise.resolve({ symbol: 'BTCUSDT', leverage: ex.leverage }); },
        setLeverage: function (symbol, leverage) {
            ex.mutations.push({ op: 'SET_LEVERAGE', leverage: leverage });
            ex.leverage = leverage;
            return Promise.resolve({ leverage: leverage });
        }
    };
    return { ex: ex, client: client };
}

function stubStream() {
    return { start: function () { return Promise.resolve({}); }, stop: function () { return Promise.resolve(); } };
}

/** Builds a live breakoutExecutionV1 over a mock exchange. */
function liveService(options) {
    var opts = options || {};
    var exchange = opts.exchange || mockExchange(opts.exchangeOptions);
    var service = breakoutExecutionV1.createService({
        symbol: 'BTCUSDT',
        liveTradingEnabled: true,
        client: exchange.client,
        streamFactory: stubStream,
        getMarkPrice: function () { return exchange.ex.mark; },
        getNewTradeAdmission: opts.getNewTradeAdmission || function () { return { admitted: true }; },
        observe: opts.observe || function () {},
        repository: opts.repository
    });
    return { ex: exchange.ex, client: exchange.client, service: service };
}

function seedPlan(direction) {
    return { setupId: 'SEED_' + direction, symbol: 'BTCUSDT', direction: direction,
        eqType: direction === 'LONG' ? 'EQL' : 'EQH',
        entryTrigger: direction === 'LONG' ? 100.9 : 99.0,
        entryWorkingType: 'CONTRACT_PRICE', protectionWorkingType: 'MARK_PRICE',
        initialSL: direction === 'LONG' ? 98 : 102, initialTP: direction === 'LONG' ? 110 : 90,
        initialRR: 2, requestedQty: 0.2, decisionTime: 900 };
}

/** Persisted open position, as a restart would restore it. */
function seedRepository(direction, overrides) {
    var plan = seedPlan(direction);
    var trade = Object.assign({
        tradeId: 'BB_SEED', symbol: 'BTCUSDT', status: 'PROTECTED', reasonCode: null, plan: plan,
        positionQty: 1,
        entryOrder: { role: 'ENTRY', clientOrderId: 'IMC_BTCUSDT_ENTRY_seed', status: 'FILLED_OR_GONE' },
        slOrder: { role: 'SL', clientOrderId: 'IMC_BTCUSDT_SL_seed', status: 'NEW', price: plan.initialSL },
        tpOrder: { role: 'TP', clientOrderId: 'IMC_BTCUSDT_TP_seed', status: 'NEW', price: plan.initialTP },
        slRevision: 0, tpRevision: 0, positionOpenedAt: 1000, createdAt: 1000, updatedAt: 1000,
        alertedEvents: {}
    }, overrides || {});
    var state = { version: 'REAL_ORDER_EXECUTION_V1', consumedEqIds: {},
        activeTradeId: trade.tradeId, trades: {} };
    state.trades[trade.tradeId] = trade;
    return executionRepositoryV1.createRepository({ initial: state });
}

function mutationsOf(ex, op) {
    return ex.mutations.filter(function (m) { return m.op === op; });
}

function tradeOf(service, tradeId) {
    return service.getSnapshot().trades[tradeId];
}

function latestTrade(service) {
    var snapshot = service.getSnapshot();
    return snapshot.trades[snapshot.activeTradeId];
}

// ------------------------------------------------------------------ A-R tests

async function main() {
    await check('A bullish Two-Bar/EQL/HTF-BULLISH places exactly one BUY STOP_MARKET entry', async function () {
        var evaluated = await evaluateSetup('BULLISH', longDynamicD());
        assert.strictEqual(evaluated.result.status, 'SETUP', JSON.stringify(evaluated.result));
        assert.strictEqual(evaluated.result.setup.type, 'EQL');
        var built = rules.buildBreakoutPlan(evaluated.result.setup,
            longPlanInputs(evaluated, 100.0, bias('BULLISH', 'MODERATE', 'HIGH')));
        assert.strictEqual(built.ok, true, built.reasonCode);
        var run = liveService({});
        try {
            await run.service.start();
            var submitted = await run.service.onSetup(built);
            assert.strictEqual(submitted.status, 'BREAKOUT_ENTRY_PENDING');
            assert.strictEqual(mutationsOf(run.ex, 'PLACE_BREAKOUT_ENTRY').length, 1);
            assert.strictEqual(run.ex.mutations.length, 1, 'exactly one exchange mutation');
            var params = executionClient.buildBreakoutEntryParams(built.plan);
            assert.strictEqual(params.algoType, 'CONDITIONAL');
            assert.strictEqual(params.type, 'STOP_MARKET');
            assert.strictEqual(params.side, 'BUY');
            assert.strictEqual(params.workingType, 'CONTRACT_PRICE');
            assert.strictEqual(params.triggerPrice, built.plan.entryTrigger);
            assert.strictEqual(params.quantity, built.plan.requestedQty);
            assert.deepStrictEqual(Object.keys(params).sort(), ['algoType', 'clientAlgoId',
                'positionSide', 'quantity', 'side', 'symbol', 'triggerPrice', 'type', 'workingType']);
            assert.strictEqual(params.reduceOnly, undefined);
            assert.strictEqual(params.closePosition, undefined);
            assert.strictEqual(params.newClientOrderId, undefined);
        } finally { run.service.stop(); }
    });

    await check('B bearish Two-Bar/EQH/HTF-BEARISH places exactly one SELL STOP_MARKET entry', async function () {
        var evaluated = await evaluateSetup('BEARISH', shortDynamicD());
        assert.strictEqual(evaluated.result.status, 'SETUP', JSON.stringify(evaluated.result));
        assert.strictEqual(evaluated.result.setup.type, 'EQH');
        var built = rules.buildBreakoutPlan(evaluated.result.setup,
            longPlanInputs(evaluated, 102.0, bias('BEARISH', 'MODERATE', 'HIGH')));
        assert.strictEqual(built.ok, true, built.reasonCode);
        var run = liveService({});
        try {
            await run.service.start();
            var submitted = await run.service.onSetup(built);
            assert.strictEqual(submitted.status, 'BREAKOUT_ENTRY_PENDING');
            assert.strictEqual(mutationsOf(run.ex, 'PLACE_BREAKOUT_ENTRY').length, 1);
            assert.strictEqual(run.ex.mutations.length, 1);
            var params = executionClient.buildBreakoutEntryParams(built.plan);
            assert.strictEqual(params.side, 'SELL');
            assert.strictEqual(params.type, 'STOP_MARKET');
            assert.strictEqual(params.triggerPrice, evaluated.result.setup.twoBarLow);
            assert.strictEqual(built.plan.entryTrigger, evaluated.result.setup.twoBarLow);
        } finally { run.service.stop(); }
    });

    await check('C BULLISH+WEAK+LOW is admitted for LONG (strength/confidence never gate)', async function () {
        var evaluated = await evaluateSetup('BULLISH', longDynamicD());
        var built = rules.buildBreakoutPlan(evaluated.result.setup,
            longPlanInputs(evaluated, 100.0, bias('BULLISH', 'WEAK', 'LOW')));
        assert.strictEqual(built.ok, true, built.reasonCode);
        assert.strictEqual(built.plan.htfDirection, 'BULLISH');
        assert.strictEqual(built.plan.htfStrength, 'WEAK');
        assert.strictEqual(built.plan.htfConfidence, 'LOW');
    });

    await check('D BEARISH+HIGH+HIGH fails a LONG with HTF_NOT_ALIGNED and mutates nothing', async function () {
        var evaluated = await evaluateSetup('BULLISH', longDynamicD());
        var built = rules.buildBreakoutPlan(evaluated.result.setup,
            longPlanInputs(evaluated, 100.0, bias('BEARISH', 'HIGH', 'HIGH')));
        assert.strictEqual(built.ok, false);
        assert.strictEqual(built.reasonCode, 'HTF_NOT_ALIGNED');
        var run = liveService({});
        try {
            var submitted = await run.service.onSetup(built);
            assert.strictEqual(submitted.status, 'REJECTED_PLAN');
            assert.strictEqual(run.ex.mutations.length, 0);
        } finally { run.service.stop(); }
    });

    await check('E the new flow invokes the retired FVG detector and EQ-FVG semantic gate zero times', async function () {
        var watchModel = require('../live/eqFvgCountWatchV1');
        var semantic = require('../live/eqFvgAssociationSemanticV1');
        var rawFvgCalls = 0;
        var semanticCalls = 0;
        var originalRawFvg = watchModel.rawFvgAt;
        var originalCreate = semantic.createService;
        watchModel.rawFvgAt = function () { rawFvgCalls += 1; return originalRawFvg.apply(null, arguments); };
        semantic.createService = function () { semanticCalls += 1; return originalCreate.apply(null, arguments); };
        try {
            var evaluated = await evaluateSetup('BULLISH', longDynamicD());
            var built = rules.buildBreakoutPlan(evaluated.result.setup,
                longPlanInputs(evaluated, 100.0, bias('BULLISH', 'MODERATE', 'HIGH')));
            var run = liveService({});
            await run.service.start();
            await run.service.onSetup(built);
            run.service.stop();
        } finally {
            watchModel.rawFvgAt = originalRawFvg;
            semantic.createService = originalCreate;
        }
        assert.strictEqual(rawFvgCalls, 0);
        assert.strictEqual(semanticCalls, 0);
        var text = ['../scripts/live.js', '../live/liveEngine.js', '../strategy/twoBarReversalV1.js',
            '../strategy/twoBarSetupV1.js', '../strategy/twoBarLivePipelineV1.js',
            '../execution/breakoutEntryRulesV1.js', '../execution/breakoutExecutionV1.js',
            '../execution/positionManagementV1.js']
            .map(function (f) { return fs.readFileSync(path.join(__dirname, f), 'utf8'); }).join('\n');
        assert.strictEqual(/eqFvgAssociationSemanticV1|eqFvgCountWatchAlertService|rawFvgAt|eqFvgSemantic/.test(text),
            false, 'no retired EQ/FVG semantic dependency in the live entry chain');
    });

    await check('F metadata.currentPivot / ORDINARY_CAUSAL_2X2 never take part in the new entry plan', async function () {
        var evaluated = await evaluateSetup('BULLISH', longDynamicD());
        var built = rules.buildBreakoutPlan(evaluated.result.setup,
            longPlanInputs(evaluated, 100.0, bias('BULLISH', 'MODERATE', 'HIGH')));
        var text = JSON.stringify({ setup: evaluated.result.setup, plan: built.plan });
        assert.strictEqual(/currentPivot|ORDINARY_CAUSAL_2X2|productionEqualLiquidityV1/.test(text), false);
        assert.strictEqual(evaluated.result.setup.twoBarId.indexOf('TWO_BAR_REVERSAL_V1'), 0);
        ['strategy/twoBarReversalV1.js', 'strategy/twoBarSetupV1.js', 'strategy/twoBarLivePipelineV1.js',
            'execution/breakoutEntryRulesV1.js', 'execution/breakoutExecutionV1.js',
            'execution/positionManagementV1.js'].forEach(function (rel) {
            var src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
            assert.strictEqual(/currentPivot|ORDINARY_CAUSAL_2X2|pivotDetector/.test(src), false, rel);
        });
    });

    await check('G an already-crossed trigger is refused with no order mutation', async function () {
        var evaluated = await evaluateSetup('BULLISH', longDynamicD());
        var built = rules.buildBreakoutPlan(evaluated.result.setup,
            longPlanInputs(evaluated, 100.95, bias('BULLISH', 'MODERATE', 'HIGH')));
        assert.strictEqual(built.ok, false);
        assert.strictEqual(built.reasonCode, 'ENTRY_TRIGGER_ALREADY_CROSSED');
        var run = liveService({});
        try {
            var submitted = await run.service.onSetup(built);
            assert.strictEqual(submitted.status, 'REJECTED_PLAN');
            assert.strictEqual(run.ex.mutations.length, 0);
        } finally { run.service.stop(); }
    });

    await check('H an RR below 1 yields TRADE_SPACE_INSUFFICIENT and no order mutation', async function () {
        var evaluated = await evaluateSetup('BULLISH', {
            dynamicDPoints: [dPoint('DYN_LOW_1', 'LOW', 98.6, 5), dPoint('DYN_HIGH_1', 'HIGH', 101.4, 6)]
        });
        var built = rules.buildBreakoutPlan(evaluated.result.setup,
            longPlanInputs(evaluated, 100.0, bias('BULLISH', 'MODERATE', 'HIGH')));
        assert.strictEqual(built.ok, false);
        assert.strictEqual(built.reasonCode, 'TRADE_SPACE_INSUFFICIENT');
        var run = liveService({});
        try {
            var submitted = await run.service.onSetup(built);
            assert.strictEqual(submitted.status, 'REJECTED_PLAN');
            assert.strictEqual(run.ex.mutations.length, 0);
        } finally { run.service.stop(); }
    });

    await check('I a partial fill creates both protective legs in the same reconcile pass', async function () {
        var evaluated = await evaluateSetup('BULLISH', longDynamicD());
        var built = rules.buildBreakoutPlan(evaluated.result.setup,
            longPlanInputs(evaluated, 100.0, bias('BULLISH', 'MODERATE', 'HIGH')));
        assert.strictEqual(built.plan.requestedQty > 0, true);
        var run = liveService({});
        try {
            await run.service.start();
            await run.service.onSetup(built);
            run.ex.positionAmt = 0.4;
            await run.service.reconcile();
            var trade = latestTrade(run.service);
            assert.strictEqual(trade.positionQty, 0.4);
            var protections = mutationsOf(run.ex, 'PLACE_PROTECTION');
            assert.strictEqual(protections.length, 2, 'SL and TP are placed immediately');
            assert.strictEqual(protections.filter(function (m) { return m.role === 'SL'; }).length, 1);
            assert.strictEqual(protections.filter(function (m) { return m.role === 'TP'; }).length, 1);
            assert.strictEqual(trade.slOrder.status, 'NEW');
            assert.strictEqual(trade.status, 'PROTECTED');
            assert.strictEqual(trade.entryOrder.status, 'NEW', 'the entry order is still working (partial fill)');
        } finally { run.service.stop(); }
    });

    async function runStopCase(lowPrice, slOverride) {
        var run = liveService({ exchangeOptions: { positionQty: 1, mark: 105 },
            repository: seedRepository('LONG', slOverride) });
        run.ex.openAlgos = [{ clientAlgoId: run.service.getSnapshot().trades.BB_SEED.slOrder.clientOrderId,
            algoStatus: 'NEW' }, { clientAlgoId: 'IMC_BTCUSDT_TP_seed', algoStatus: 'NEW' }];
        await run.service.onDynamicD([dPoint('DYN_LOW_NEW', 'LOW', lowPrice, 12, 5000)], Date.now());
        await run.service.reconcile();
        return run;
    }

    await check('J a higher causal LOW Dynamic-D tightens the long stop to 101', async function () {
        var run = await runStopCase(101);
        var placed = mutationsOf(run.ex, 'PLACE_PROTECTION').filter(function (m) { return m.role === 'SL'; });
        assert.strictEqual(placed.length, 1);
        assert.strictEqual(placed[0].params.stopPrice, 101);
        var trade = tradeOf(run.service, 'BB_SEED');
        assert.strictEqual(trade.slOrder.price, 101);
        assert.strictEqual(trade.slOrder.clientOrderId, placed[0].clientAlgoId);
        assert.deepStrictEqual(mutationsOf(run.ex, 'CANCEL_ALGO').map(function (m) { return m.clientAlgoId; }),
            ['IMC_BTCUSDT_SL_seed']);
        assert.strictEqual(mutationsOf(run.ex, 'PLACE_BREAKOUT_ENTRY').length, 0);
        run.service.stop();
    });

    await check('K a looser LOW Dynamic-D is ignored and the stop stays at 101', async function () {
        var run = await runStopCase(99, { slOrder: { role: 'SL', clientOrderId: 'IMC_BTCUSDT_SL_now',
            status: 'NEW', price: 101 } });
        assert.strictEqual(mutationsOf(run.ex, 'PLACE_PROTECTION').length, 0);
        assert.strictEqual(mutationsOf(run.ex, 'CANCEL_ALGO').length, 0);
        assert.strictEqual(tradeOf(run.service, 'BB_SEED').slOrder.price, 101);
        run.service.stop();
    });

    async function runTargetCase(highPrice, currentTp) {
        var run = liveService({ exchangeOptions: { positionQty: 1, mark: 104 },
            repository: seedRepository('LONG', { tpOrder: { role: 'TP',
                clientOrderId: 'IMC_BTCUSDT_TP_now', status: 'NEW', price: currentTp } }) });
        run.ex.openAlgos = [{ clientAlgoId: 'IMC_BTCUSDT_SL_seed', algoStatus: 'NEW' },
            { clientAlgoId: 'IMC_BTCUSDT_TP_now', algoStatus: 'NEW' }];
        await run.service.onDynamicD([dPoint('DYN_HIGH_NEW', 'HIGH', highPrice, 12, 5000)], Date.now());
        await run.service.reconcile();
        return run;
    }

    await check('L the long target reprices DOWN to 106.5', async function () {
        var run = await runTargetCase(106.5, 110);
        var placed = mutationsOf(run.ex, 'PLACE_PROTECTION').filter(function (m) { return m.role === 'TP'; });
        assert.strictEqual(placed.length, 1);
        assert.strictEqual(placed[0].params.targetPrice, 106.5);
        assert.strictEqual(tradeOf(run.service, 'BB_SEED').tpOrder.price, 106.5);
        run.service.stop();
    });

    await check('M the long target reprices back UP to 112', async function () {
        var run = await runTargetCase(112, 106.5);
        var placed = mutationsOf(run.ex, 'PLACE_PROTECTION').filter(function (m) { return m.role === 'TP'; });
        assert.strictEqual(placed.length, 1);
        assert.strictEqual(placed[0].params.targetPrice, 112);
        assert.strictEqual(tradeOf(run.service, 'BB_SEED').tpOrder.price, 112);
        run.service.stop();
    });

    await check('N restart with a position and no exchange stop halts, repairs and blocks new entries', async function () {
        var run = liveService({ exchangeOptions: { positionQty: 1, mark: 105 },
            repository: seedRepository('LONG') });
        run.ex.openAlgos = [{ clientAlgoId: 'IMC_BTCUSDT_TP_seed', algoStatus: 'NEW' }];
        await run.service.start();
        assert.strictEqual(run.service.isHalted(), true);
        assert.strictEqual(run.service.haltReason(), 'UNPROTECTED_LIVE_POSITION');
        var placed = mutationsOf(run.ex, 'PLACE_PROTECTION').filter(function (m) { return m.role === 'SL'; });
        assert.strictEqual(placed.length, 1, 'the missing stop is repaired from the frozen plan');
        assert.strictEqual(placed[0].params.stopPrice, tradeOf(run.service, 'BB_SEED').plan.initialSL);
        var submitted = await run.service.onSetup({ ok: true, plan: seedPlan('LONG') });
        assert.strictEqual(submitted.status, 'NO_TRADE');
        assert.strictEqual(submitted.reasonCode, 'EXECUTION_HALT_ACTIVE');
        assert.strictEqual(mutationsOf(run.ex, 'PLACE_BREAKOUT_ENTRY').length, 0);
        run.service.stop();
    });

    await check('O a position symbol that drops out of the Top N stays in the reconcile set', async function () {
        var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'two-bar-universe-'));
        try {
            fs.mkdirSync(path.join(dir, 'ZECUSDT'), { recursive: true });
            fs.writeFileSync(path.join(dir, 'ZECUSDT', 'real-order-execution-v1.json'),
                JSON.stringify(seedRepository('LONG').snapshot()));
            var active = universe.discoverActiveLifecycleSymbols(dir);
            assert.deepStrictEqual(active, ['ZECUSDT']);
            assert.strictEqual(universe.runtimeSymbols(['BTCUSDT', 'ETHUSDT'], active).indexOf('ZECUSDT') >= 0, true);
            assert.strictEqual(universe.runtimeSymbols(['BTCUSDT', 'ETHUSDT'], active).length, 3);
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
        var run = await runStopCase(102);
        assert.strictEqual(mutationsOf(run.ex, 'PLACE_PROTECTION').filter(function (m) {
            return m.role === 'SL'; })[0].params.stopPrice, 102);
        run.service.stop();
    });

    await check('P a cancel that races a fill recognises the position and protects it', async function () {
        var evaluated = await evaluateSetup('BULLISH', longDynamicD());
        var built = rules.buildBreakoutPlan(evaluated.result.setup,
            longPlanInputs(evaluated, 100.0, bias('BULLISH', 'MODERATE', 'HIGH')));
        var race = false;
        var exchange = mockExchange({ mark: 97.5, positionQty: 0,
            onCancel: function (clientAlgoId, ex) {
                if (/ENTRY/.test(clientAlgoId)) { race = true; ex.positionAmt = 0.5; }
            } });
        var run = liveService({ exchange: exchange });
        try {
            await run.service.start();
            assert.strictEqual(run.ex.mark < built.plan.initialSL, true,
                'the mark price invalidates the pending entry');
            await run.service.onSetup(built);
            await run.service.reconcile();
            var trade = latestTrade(run.service);
            assert.strictEqual(race, true, 'the exchange filled while the cancel was in flight');
            assert.strictEqual(trade.status === 'BREAKOUT_ENTRY_CANCELED', false);
            assert.strictEqual(trade.status, 'PROTECTED');
            assert.strictEqual(trade.positionQty, 0.5);
            assert.strictEqual(mutationsOf(run.ex, 'PLACE_PROTECTION').length, 2);
            await run.service.reconcile();
            assert.strictEqual(latestTrade(run.service).status, 'PROTECTED');
        } finally { run.service.stop(); }
    });

    await check('Q a failed new stop keeps the old stop live, cancels nothing and halts the symbol', async function () {
        var run = liveService({ exchangeOptions: { positionQty: 1, mark: 105,
            failProtectionRole: 'SL' }, repository: seedRepository('LONG') });
        run.ex.openAlgos = [{ clientAlgoId: 'IMC_BTCUSDT_SL_seed', algoStatus: 'NEW' },
            { clientAlgoId: 'IMC_BTCUSDT_TP_seed', algoStatus: 'NEW' }];
        await run.service.onDynamicD([dPoint('DYN_LOW_NEW', 'LOW', 101, 12, 5000)], Date.now());
        await run.service.reconcile();
        var trade = tradeOf(run.service, 'BB_SEED');
        assert.strictEqual(run.service.isHalted(), true);
        assert.strictEqual(run.service.haltReason(), 'PROTECTION_REPLACEMENT_FAILED');
        assert.strictEqual(trade.slOrder.clientOrderId, 'IMC_BTCUSDT_SL_seed');
        assert.strictEqual(trade.slOrder.price, 98);
        assert.strictEqual(mutationsOf(run.ex, 'CANCEL_ALGO').length, 0);
        assert.strictEqual(run.ex.openAlgos.some(function (o) {
            return o.clientAlgoId === 'IMC_BTCUSDT_SL_seed'; }), true);
        run.service.stop();
    });

    await check('R a stop that triggers during replacement leaves zero position and zero exposure', async function () {
        var run = liveService({ exchangeOptions: { positionQty: 1, mark: 105 },
            repository: seedRepository('LONG') });
        run.ex.openAlgos = [{ clientAlgoId: 'IMC_BTCUSDT_SL_seed', algoStatus: 'NEW' },
            { clientAlgoId: 'IMC_BTCUSDT_TP_seed', algoStatus: 'NEW' }];
        run.ex.onCancel = function (clientAlgoId, ex) {
            if (clientAlgoId === 'IMC_BTCUSDT_SL_seed') ex.positionAmt = 0;
        };
        await run.service.onDynamicD([dPoint('DYN_LOW_NEW', 'LOW', 101, 12, 5000)], Date.now());
        await run.service.reconcile();
        var replaced = mutationsOf(run.ex, 'PLACE_PROTECTION').filter(function (m) { return m.role === 'SL'; });
        assert.strictEqual(replaced.length, 1);
        var newSlId = replaced[0].clientAlgoId;
        await run.service.reconcile();
        var trade = tradeOf(run.service, 'BB_SEED');
        assert.strictEqual(trade.status, 'CLOSED');
        assert.strictEqual(trade.positionQty, 0);
        assert.strictEqual(run.ex.openAlgos.length, 0, 'no leftover protection can fire later');
        assert.strictEqual(mutationsOf(run.ex, 'CANCEL_ALGO').some(function (m) {
            return m.clientAlgoId === newSlId; }), true);
        assert.strictEqual(mutationsOf(run.ex, 'PLACE_BREAKOUT_ENTRY').length, 0, 'no reverse exposure');
        assert.strictEqual(run.service.isHalted(), false);
        run.service.stop();
    });

    console.log('');
    console.log('CHECKS PASSED: ' + passed);
    console.log('CHECKS FAILED: ' + failed);
    console.log('TWO_BAR_LIVE_INTEGRATION_V1=' + (failed === 0 ? 'PASS' : 'FAIL') +
        ' (' + passed + ' checks, ' + failed + ' failed)');
    if (failed) process.exitCode = 1;
}

main().catch(function (error) {
    console.error(error && error.stack || error);
    process.exit(1);
});
