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
        // start the algoId sequence above the seeded canonical ids so a bridge algoId can
        // never collide with a seeded order's algoId in the query-by-algoId path
        mutations: [], mark: opts.mark === undefined ? 100.5 : opts.mark, seq: 1000,
        failProtectionRole: opts.failProtectionRole || null, onCancel: opts.onCancel || null,
        // §PRODUCTION BRIDGE REPLACEMENT fault injection
        failBridgeRole: opts.failBridgeRole || null, bridgeFailCode: opts.bridgeFailCode || -2022,
        bridgeRejectOnce: opts.bridgeRejectOnce === true, bridgeRejected: false,
        bridgeCancelLag: opts.bridgeCancelLag || null, bridgeCancelLagUsed: false,
        oldCancelLag: opts.oldCancelLag || null, oldCancelLagUsed: false,
        bridgeVerifyLag: opts.bridgeVerifyLag || null, bridgeVerifyLagUsed: false,
        canonicalPlaceLag: opts.canonicalPlaceLag || null, canonicalPlaceLagUsed: false };
    /** §cancel read-after-write visibility lag: the exchange keeps saying NEW for a bit. */
    function cancelWithLag(id, statuses) {
        ex.openAlgos.forEach(function (order) {
            if (order.clientAlgoId === id) order.laggedStatus = statuses.slice();
        });
    }
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
                var refused = new Error('Request failed with status code 400');
                refused.code = 'ERR_BAD_REQUEST';
                refused.response = { status: 400, data: { code: -2021, msg: 'Order would immediately trigger.' } };
                return Promise.reject(refused);
            }
            var id = nextId(role);
            ex.mutations.push({ op: 'PLACE_PROTECTION', role: role, clientAlgoId: id, params: plan });
            var protectionAlgo = { clientAlgoId: id, algoStatus: 'NEW', closePosition: true,
                type: role === 'SL' ? 'STOP_MARKET' : 'TAKE_PROFIT_MARKET' };
            if (ex.canonicalPlaceLag && !ex.canonicalPlaceLagUsed) {
                ex.canonicalPlaceLagUsed = true;
                protectionAlgo.laggedStatus = ex.canonicalPlaceLag.slice();
            }
            ex.openAlgos.push(protectionAlgo);
            return Promise.resolve({ clientAlgoId: id, algoStatus: 'NEW' });
        },
        /**
         * PRODUCTION bridge protection: reduceOnly + explicit quantity +
         * closePosition=false. The id is derived exactly like the real client does, so
         * the production state machine's expected id always matches.
         */
        submitBridgeProtection: function (plan, role, quantity, triggerPrice) {
            var id = executionClient.clientId(plan.symbol, plan.tradeId, role + '_BRIDGE');
            if (ex.failBridgeRole === role ||
                    (ex.bridgeRejectOnce && role === 'SL' && !ex.bridgeRejected)) {
                ex.bridgeRejected = true;
                var refused = new Error('Request failed with status code 400');
                refused.code = 'ERR_BAD_REQUEST';
                refused.response = { status: 400,
                    data: { code: ex.bridgeFailCode, msg: 'Order would immediately trigger.' } };
                return Promise.reject(refused);
            }
            ex.seq += 1;
            ex.mutations.push({ op: 'PLACE_BRIDGE', role: role, clientAlgoId: id,
                params: { quantity: quantity, triggerPrice: triggerPrice } });
            ex.openAlgos.push({ clientAlgoId: id, algoId: ex.seq, algoStatus: 'NEW',
                type: role === 'SL' ? 'STOP_MARKET' : 'TAKE_PROFIT_MARKET',
                side: 'SELL', closePosition: false, reduceOnly: true,
                quantity: String(quantity), triggerPrice: String(triggerPrice),
                workingType: 'MARK_PRICE',
                laggedStatus: (ex.bridgeVerifyLag && !ex.bridgeVerifyLagUsed)
                    ? (ex.bridgeVerifyLagUsed = true, ex.bridgeVerifyLag.slice()) : undefined });
            return Promise.resolve({ clientAlgoId: id, algoId: ex.seq, algoStatus: 'NEW' });
        },
        queryAlgoOrder: function (symbol, algoId, clientAlgoId) {
            // Binance answers -2013 when the exact order is not queryable; that is NOT
            // terminal proof, so the mock must not invent a CANCELED answer.
            var found = ex.openAlgos.filter(function (o) {
                if (clientAlgoId !== null && clientAlgoId !== undefined) {
                    return o.clientAlgoId === clientAlgoId;
                }
                return algoId !== null && algoId !== undefined &&
                    String(o.algoId) === String(algoId);
            })[0];
            if (found) {
                if (found.laggedStatus && found.laggedStatus.length > 0) {
                    var lagged = found.laggedStatus.shift();
                    if (lagged === 'NOT_FOUND') {
                        // §5 accepted-pending: the exact id is not queryable yet
                        var pending = new Error('Request failed with status code 400');
                        pending.code = 'ERR_BAD_REQUEST';
                        pending.response = { status: 400,
                            data: { code: -2013, msg: 'Order does not exist.' } };
                        return Promise.reject(pending);
                    }
                    return Promise.resolve(Object.assign({}, found, { algoStatus: lagged }));
                }
                return Promise.resolve(found);
            }
            var gone = new Error('Request failed with status code 400');
            gone.code = 'ERR_BAD_REQUEST';
            gone.response = { status: 400, data: { code: -2013, msg: 'Order does not exist.' } };
            return Promise.reject(gone);
        },
        cancelAlgo: function (symbol, clientAlgoId) {
            if (ex.failCancelOnce && !ex.cancelFailed) {
                ex.cancelFailed = true;
                ex.mutations.push({ op: 'CANCEL_ALGO', clientAlgoId: clientAlgoId });
                var cancelError = new Error('Request failed with status code 500');
                cancelError.code = 'ERR_BAD_RESPONSE';
                cancelError.response = { status: 500, data: { code: -1001, msg: 'Internal error' } };
                return Promise.reject(cancelError);
            }
            var removed = ex.openAlgos.filter(function (o) { return o.clientAlgoId === clientAlgoId; })[0];
            ex.mutations.push({ op: 'CANCEL_ALGO', clientAlgoId: clientAlgoId });
            ex.openAlgos = ex.openAlgos.filter(function (o) { return o.clientAlgoId !== clientAlgoId; });
            // §7 DELETE 2xx is only an ACCEPTANCE: the read may keep answering NEW
            if (ex.bridgeCancelLag && String(clientAlgoId).indexOf('_BRIDGE_') >= 0 &&
                    !ex.bridgeCancelLagUsed) {
                ex.bridgeCancelLagUsed = true;
                ex.openAlgos.push(Object.assign({}, removed || {}, { clientAlgoId: clientAlgoId,
                    algoStatus: 'CANCELED', laggedStatus: ex.bridgeCancelLag.slice() }));
            }
            if (ex.oldCancelLag && String(clientAlgoId).indexOf('_BRIDGE_') < 0 &&
                    !ex.oldCancelLagUsed) {
                ex.oldCancelLagUsed = true;
                ex.openAlgos.push(Object.assign({}, removed || {}, { clientAlgoId: clientAlgoId,
                    algoStatus: 'CANCELED', laggedStatus: ex.oldCancelLag.slice() }));
            }
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
    return { setupId: 'SEED_' + direction, eqId: 'EQ_SEED_' + direction,
        symbol: 'BTCUSDT', direction: direction,
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
        // §PRODUCTION BRIDGE REPLACEMENT: one reduceOnly bridge, the old canonical
        // cancelled ONCE (after the bridge was verified ACTIVE), bridge removed once.
        var bridges = mutationsOf(run.ex, 'PLACE_BRIDGE').filter(function (m) { return m.role === 'SL'; });
        assert.strictEqual(bridges.length, 1, 'exactly one bridge for the SL move');
        assert.strictEqual(bridges[0].params.triggerPrice, 101);
        assert.deepStrictEqual(mutationsOf(run.ex, 'CANCEL_ALGO').map(function (m) { return m.clientAlgoId; }),
            ['IMC_BTCUSDT_SL_seed', bridges[0].clientAlgoId]);
        assert.deepStrictEqual(Object.keys(trade.protectionDeletes).sort(),
            ['IMC_BTCUSDT_SL_seed', bridges[0].clientAlgoId].sort(),
            'the DELETE ledger keeps exactly one attempt per exact id');
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
        try {
            await run.service.start();
            assert.strictEqual(run.service.isHalted(), true);
            // RELAXED-SAFETY CONTRACT: "-2013 / not found" is NOT terminal proof, so the
            // missing (persisted) stop must NOT be blindly re-placed.
            assert.strictEqual(['UNPROTECTED_LIVE_POSITION', 'PROTECTION_UNVERIFIED']
                .indexOf(run.service.haltReason()) >= 0, true, run.service.haltReason());
            assert.strictEqual(mutationsOf(run.ex, 'PLACE_PROTECTION').length, 0,
                'no new protection POST without terminal proof');
            assert.strictEqual(mutationsOf(run.ex, 'CANCEL_ALGO').length, 0);
            var submitted = await run.service.onSetup({ ok: true, plan: seedPlan('LONG') });
            assert.strictEqual(submitted.status, 'NO_TRADE');
            assert.strictEqual(submitted.reasonCode, 'EXECUTION_HALT_ACTIVE');
            assert.strictEqual(mutationsOf(run.ex, 'PLACE_BREAKOUT_ENTRY').length, 0);
            // and it stays that way on every later pass
            await run.service.reconcile();
            assert.strictEqual(mutationsOf(run.ex, 'PLACE_PROTECTION').length, 0);
        } finally { run.service.stop(); }
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

    await check('Q a failed canonical replacement keeps the position bridge-protected and halts',
        async function () {
        var run = liveService({ exchangeOptions: { positionQty: 1, mark: 105,
            failProtectionRole: 'SL' }, repository: seedRepository('LONG') });
        run.ex.openAlgos = [{ clientAlgoId: 'IMC_BTCUSDT_SL_seed', algoStatus: 'NEW' },
            { clientAlgoId: 'IMC_BTCUSDT_TP_seed', algoStatus: 'NEW' }];
        await run.service.onDynamicD([dPoint('DYN_LOW_NEW', 'LOW', 101, 12, 5000)], Date.now());
        await run.service.reconcile();
        var trade = tradeOf(run.service, 'BB_SEED');
        assert.strictEqual(run.service.isHalted(), true);
        assert.strictEqual(run.service.haltReason(), 'PROTECTION_REPLACEMENT_FAILED');
        // the bridge lifecycle: the rejected NEW canonical leaves the BRIDGE as the
        // standing protection (reduceOnly, verified ACTIVE) - never an unprotected role
        var bridges = mutationsOf(run.ex, 'PLACE_BRIDGE').filter(function (m) { return m.role === 'SL'; });
        assert.strictEqual(bridges.length, 1);
        assert.strictEqual(trade.slOrder.clientOrderId, bridges[0].clientAlgoId,
            'the trade points at the bridge so no auto-heal can double-own the role');
        assert.strictEqual(run.ex.openAlgos.some(function (o) {
            return o.clientAlgoId === bridges[0].clientAlgoId; }), true,
            'the bridge is still ACTIVE on the exchange');
        assert.deepStrictEqual(mutationsOf(run.ex, 'CANCEL_ALGO').map(function (m) { return m.clientAlgoId; }),
            ['IMC_BTCUSDT_SL_seed'], 'only the old canonical was cancelled (once)');
        run.service.stop();
    });

    // ---- Q2: a halt must also bound the placement retry (V2 smoke §41) ----
    await check('Q2 a halted protection failure never retries the placement without bound',
        async function () {
            var evaluated = await evaluateSetup('BULLISH', longDynamicD());
            var built = rules.buildBreakoutPlan(evaluated.result.setup,
                longPlanInputs(evaluated, 100.0, bias('BULLISH', 'MODERATE', 'HIGH')));
            var attempts = 0;
            var run = liveService({});
            // mutate the client the service already holds: every placement fails
            run.client.submitProtection = function () {
                attempts += 1;
                return Promise.reject(Object.assign(new Error('EXCHANGE_REJECTED'),
                    { code: 'EXCHANGE_REJECTED' }));
            };
            try {
                await run.service.start();
                await run.service.onSetup(built);
                run.ex.positionAmt = built.plan.requestedQty;
                await run.service.reconcile();
                assert.strictEqual(attempts > 0, true, 'a protection placement was attempted');
                assert.strictEqual(attempts <= 2, true,
                    'one reconcile makes at most two bounded attempts, got ' + attempts);
                assert.strictEqual(run.service.isHalted(), true);
                // the final halt reason is the position-left-unprotected one: no stop
                // could be created, which is exactly what must stop new entries
                assert.strictEqual(['PROTECTION_REPLACEMENT_FAILED', 'UNPROTECTED_LIVE_POSITION']
                    .indexOf(run.service.haltReason()) >= 0, true, run.service.haltReason());
            } finally { run.service.stop(); }
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
        // §PRODUCTION BRIDGE REPLACEMENT: the bridge is what gets placed first; the old
        // canonical fires while being replaced, so the run stops before any new canonical.
        assert.strictEqual(replaced.length, 0,
            'no canonical may be placed once the stop has fired');
        assert.strictEqual(mutationsOf(run.ex, 'PLACE_BRIDGE').filter(function (m) {
            return m.role === 'SL'; }).length, 1, 'the bridge was the in-flight protection');
        await run.service.reconcile();
        var trade = tradeOf(run.service, 'BB_SEED');
        assert.strictEqual(trade.status, 'CLOSED');
        assert.strictEqual(trade.positionQty, 0);
        assert.strictEqual(run.ex.openAlgos.length, 0, 'no leftover protection can fire later');
        assert.strictEqual(lastReplacement(run.service).phase, 'FLAT_ABORT');
        assert.strictEqual(mutationsOf(run.ex, 'PLACE_BREAKOUT_ENTRY').length, 0, 'no reverse exposure');
        assert.strictEqual(run.service.isHalted(), false);
        run.service.stop();
    });

    // ---- S2/T: REAL_SMOKE_2 root cause - an accepted POST whose verification
    //     fails must never be re-submitted, and a halt must block every retry.
    await check('S2 an accepted SL whose verify query 400s is never re-submitted and is adopted',
        async function () {
            var evaluated = await evaluateSetup('BULLISH', longDynamicD());
            var built = rules.buildBreakoutPlan(evaluated.result.setup,
                longPlanInputs(evaluated, 100.0, bias('BULLISH', 'MODERATE', 'HIGH')));
            var run = liveService({});
            var placementsByRole = { SL: 0, TP: 0 };
            var queries = {};
            var firstSlId = null;
            var realQuery = run.client.queryAlgoOrder;
            run.client.submitProtection = function (plan, role) {
                placementsByRole[role] += 1;
                var id = 'IMC_BTCUSDT_' + role + '_accepted_' + placementsByRole[role];
                if (role === 'SL') firstSlId = id;
                run.ex.openAlgos.push({ clientAlgoId: id, algoId: 700 + placementsByRole[role],
                    algoStatus: 'NEW', type: role === 'SL' ? 'STOP_MARKET' : 'TAKE_PROFIT_MARKET',
                    workingType: 'MARK_PRICE', closePosition: true, side: 'SELL',
                    triggerPrice: String(role === 'SL' ? built.plan.initialSL : built.plan.initialTP) });
                return Promise.resolve({ clientAlgoId: id, algoId: 700 + placementsByRole[role],
                    algoStatus: 'NEW' });
            };
            run.client.queryAlgoOrder = function (symbol, algoId, clientAlgoId) {
                var key = clientAlgoId || ('algoId:' + algoId);
                queries[key] = (queries[key] || 0) + 1;
                queries.__first = queries.__first || 0;
                queries.__first += 1;
                // the exchange accepted the order but the very FIRST read is not
                // visible yet; the exact-id fallback in the same pass may succeed
                if (queries.__first === 1) {
                    var error = new Error('Request failed with status code 400');
                    error.code = 'ERR_BAD_REQUEST';
                    error.response = { status: 400,
                        data: { code: -2013, msg: 'Order does not exist.' } };
                    return Promise.reject(error);
                }
                return realQuery(symbol, algoId, clientAlgoId);
            };
            try {
                await run.service.start();
                await run.service.onSetup(built);
                run.ex.positionAmt = built.plan.requestedQty;
                await run.service.reconcile();
                var trade = latestTrade(run.service);
                assert.strictEqual(placementsByRole.SL, 1, 'exactly one SL POST despite the failed verify');
                assert.strictEqual(trade.slOrder.clientOrderId, firstSlId,
                    'the accepted identity is committed before verification');
                // the clientAlgoId query failed, but the exact-algoId query recovered the
                // real order in the same pass: verified, never re-submitted
                assert.strictEqual(trade.slOrder.verified, true);
                await run.service.reconcile();
                var after = latestTrade(run.service);
                assert.strictEqual(placementsByRole.SL, 1, 'no duplicate SL submit on the next reconcile');
                assert.strictEqual(after.slOrder.verified, true, 'the exchange order is adopted/verified');
                assert.strictEqual(placementsByRole.TP, 1, 'TP proceeds independently');
            } finally { run.service.stop(); }
        });

    await check('T twenty reconciles after a protection halt place nothing further',
        async function () {
            var evaluated = await evaluateSetup('BULLISH', longDynamicD());
            var built = rules.buildBreakoutPlan(evaluated.result.setup,
                longPlanInputs(evaluated, 100.0, bias('BULLISH', 'MODERATE', 'HIGH')));
            var run = liveService({});
            var placements = 0;
            run.client.submitProtection = function () {
                placements += 1;
                return Promise.reject(Object.assign(new Error('EXCHANGE_REJECTED'),
                    { code: 'EXCHANGE_REJECTED' }));
            };
            try {
                await run.service.start();
                await run.service.onSetup(built);
                run.ex.positionAmt = built.plan.requestedQty;
                await run.service.reconcile();
                assert.strictEqual(run.service.isHalted(), true);
                var afterHalt = placements;
                for (var i = 0; i < 20; i++) await run.service.reconcile();
                assert.strictEqual(placements, afterHalt,
                    'halted execution must not place protection again (' + placements + ' attempts)');
                assert.strictEqual(placements, 1, 'exactly one bounded attempt');
                assert.strictEqual(mutationsOf(run.ex, 'CANCEL_ALGO').length, 0);
            } finally { run.service.stop(); }
        });

    // ---- AA: only an EXPLICIT terminal status of the exact order unlocks a new
    //      revision (a "not found" answer must never do it).
    await check('AA an explicitly CANCELED exact stop allows exactly one new revision',
        async function () {
            var events = [];
            var run = liveService({ exchangeOptions: { positionQty: 1, mark: 105 },
                repository: seedRepository('LONG'), observe: function (e) { events.push(e); } });
            // the exchange reports the seeded stop as explicitly CANCELED (terminal)
            run.ex.openAlgos = [{ clientAlgoId: 'IMC_BTCUSDT_SL_seed', algoStatus: 'CANCELED',
                algoId: 555, type: 'STOP_MARKET', side: 'SELL', workingType: 'MARK_PRICE',
                closePosition: true, triggerPrice: '98' },
            { clientAlgoId: 'IMC_BTCUSDT_TP_seed', algoStatus: 'NEW' }];
            try {
                await run.service.reconcile();
                var types = events.map(function (e) { return e.type; });
                assert.strictEqual(types.indexOf('PROTECTION_TERMINAL_ON_EXCHANGE') >= 0, true,
                    'the terminal proof is recorded: ' + JSON.stringify(types));
                var placed = mutationsOf(run.ex, 'PLACE_PROTECTION');
                assert.strictEqual(placed.length, 1, 'exactly one new revision is placed');
                assert.strictEqual(placed[0].role, 'SL');
                assert.strictEqual(placed[0].params.stopPrice, 98,
                    'the frozen plan stop is used for the new revision');
                assert.strictEqual(mutationsOf(run.ex, 'PLACE_PROTECTION').length, 1);
                await run.service.reconcile();
                assert.strictEqual(mutationsOf(run.ex, 'PLACE_PROTECTION').length, 1,
                    'the new revision is not replaced again');
            } finally { run.service.stop(); }
        });

    // ---- AD: cleanup is idempotent - a closed position cancels each protective leg
    //      exactly once, and subsequent reconciles only QUERY.
    await check('AD twenty reconciles after a close add zero further cancels',
        async function () {
            var run = liveService({ exchangeOptions: { positionQty: 0, mark: 105 },
                repository: seedRepository('LONG', { positionQty: 0, status: 'PROTECTED' }) });
            run.ex.openAlgos = [{ clientAlgoId: 'IMC_BTCUSDT_SL_seed', algoStatus: 'NEW' },
                { clientAlgoId: 'IMC_BTCUSDT_TP_seed', algoStatus: 'NEW' }];
            try {
                await run.service.reconcile();
                var afterFirst = mutationsOf(run.ex, 'CANCEL_ALGO').length;
                assert.strictEqual(afterFirst, 2, 'one cancel per protective leg, got ' + afterFirst);
                for (var i = 0; i < 20; i++) await run.service.reconcile();
                assert.strictEqual(mutationsOf(run.ex, 'CANCEL_ALGO').length, afterFirst,
                    'further reconciles must only query, never cancel again');
                assert.strictEqual(run.service.getSnapshot().trades.BB_SEED.status, 'CLOSED');
            } finally { run.service.stop(); }
        });

    // ---- A-IDENT: the production protection id is stable inside one lifecycle and
    //      unique across lifecycles (input: tradeId + role + revision).
    await check('A-IDENT production protection ids are lifecycle-stable and cross-lifecycle unique',
        function () {
            var clientModule = require('../execution/binanceExecutionClientV1');
            var idA = clientModule.clientId('BTCUSDT', 'BB_LIFECYCLE_A:SL:1', 'SL');
            var idA2 = clientModule.clientId('BTCUSDT', 'BB_LIFECYCLE_A:SL:1', 'SL');
            var idB = clientModule.clientId('BTCUSDT', 'BB_LIFECYCLE_B:SL:1', 'SL');
            var idB2 = clientModule.clientId('BTCUSDT', 'BB_LIFECYCLE_B:SL:2', 'SL');
            assert.strictEqual(idA, idA2, 'same lifecycle+revision -> identical id (restart stable)');
            assert.notStrictEqual(idA, idB, 'different lifecycles -> different ids');
            assert.notStrictEqual(idB, idB2, 'different revisions -> different ids');
            assert.strictEqual(idA.length <= 36, true, 'Binance <=36 chars');
        });

    // ---- A-STALE: a stale clientAlgoId that resolves to an OLD terminal order must
    //      never make Production judge the freshly accepted order as terminal.
    await check('A-STALE stale clientAlgoId terminal collision cannot terminalize the new order',
        async function () {
            var evaluated = await evaluateSetup('BULLISH', longDynamicD());
            var built = rules.buildBreakoutPlan(evaluated.result.setup,
                longPlanInputs(evaluated, 100.0, bias('BULLISH', 'MODERATE', 'HIGH')));
            var run = liveService({});
            var ids = { SL: null, TP: null };
            var newId = null;
            var newAlgoId = 9001;
            run.client.submitProtection = function (plan, role) {
                newId = 'IMC_BTCUSDT_' + role + '_new';
                ids[role] = newId;
                run.ex.openAlgos.push({ clientAlgoId: newId, algoId: newAlgoId, algoStatus: 'NEW',
                    type: role === 'SL' ? 'STOP_MARKET' : 'TAKE_PROFIT_MARKET',
                    workingType: 'MARK_PRICE', closePosition: true, side: 'SELL',
                    triggerPrice: String(role === 'SL' ? plan.stopPrice : plan.targetPrice) });
                return Promise.resolve({ clientAlgoId: newId, algoId: newAlgoId, algoStatus: 'NEW' });
            };
            run.client.queryAlgoOrder = function (symbol, algoId, clientAlgoId) {
                // the stale client id answers with an OLD terminal order; the
                // authoritative algoId answers with the freshly accepted one
                if (clientAlgoId && (algoId === null || algoId === undefined)) {
                    return Promise.resolve({ clientAlgoId: clientAlgoId, algoId: 111,
                        algoStatus: 'CANCELED' });
                }
                if (String(algoId) === String(newAlgoId)) {
                    return Promise.resolve({ clientAlgoId: ids.SL || ids.TP, algoId: newAlgoId,
                        algoStatus: 'NEW', type: 'STOP_MARKET', workingType: 'MARK_PRICE',
                        closePosition: true });
                }
                return Promise.resolve(run.ex.openAlgos.filter(function (o) {
                    return o.clientAlgoId === clientAlgoId; })[0] || { clientAlgoId: clientAlgoId,
                    algoStatus: 'CANCELED' });
            };
            try {
                await run.service.start();
                await run.service.onSetup(built);
                run.ex.positionAmt = built.plan.requestedQty;
                await run.service.reconcile();
                var trade = latestTrade(run.service);
                assert.strictEqual(trade.slOrder.clientOrderId, ids.SL);
                assert.strictEqual(trade.slOrder.verified, true,
                    'the algoId answer (ACTIVE) wins, the stale client id answer (CANCELED) is ignored');
                assert.strictEqual(mutationsOf(run.ex, 'CANCEL_ALGO').length, 0,
                    'no cancel may follow from the stale terminal answer');
            } finally { run.service.stop(); }
        });

    // ---- C-PENDING: a flat pending entry must never be terminalized as POSITION_CLOSED.
    await check('C-PENDING pending entry with qty=0 emits no POSITION_CLOSED', async function () {
        var events = [];
        var evaluated = await evaluateSetup('BULLISH', longDynamicD());
        var built = rules.buildBreakoutPlan(evaluated.result.setup,
            longPlanInputs(evaluated, 100.0, bias('BULLISH', 'MODERATE', 'HIGH')));
        var run = liveService({ observe: function (e) { events.push(e); } });
        try {
            await run.service.start();
            await run.service.onSetup(built);
            // the exchange does not report a position and the mark price is unknown
            run.ex.mark = 0;
            await run.service.reconcile();
            await run.service.reconcile();
            var trade = latestTrade(run.service);
            assert.strictEqual(events.some(function (e) { return e.type === 'POSITION_CLOSED'; }), false,
                'no POSITION_CLOSED for a pending entry that never held a position');
            assert.strictEqual(trade.positionOpenedAt, null, 'nothing was filled');
            assert.strictEqual(['BREAKOUT_ENTRY_PENDING', 'PENDING_BREAKOUT_SETUP'].indexOf(trade.status) >= 0,
                true, 'the trade is not terminalized: ' + trade.status);
        } finally { run.service.stop(); }
    });

    // ---- HU1/HU2/HU3: REAL V3 halt-recovery contract.
    // The first verify of both legs may be temporarily -2013, which halts with
    // UNPROTECTED_LIVE_POSITION; the halt may only be cleared once exchange truth
    // confirms BOTH legs on a live position.
    function haltHarness(options) {
        var opts = options || {};
        var events = [];
        // a live position whose protection records are NOT yet written: production
        // will place them through ensureProtection (the real V3 sequence)
        var run = liveService({ exchangeOptions: { positionQty: 1, mark: 105 },
            repository: seedRepository('LONG', { slOrder: null, tpOrder: null,
                status: 'POSITION_OPEN', positionQty: 1 }),
            observe: function (e) { events.push(e); } });
        var verifyFailures = 0;
        // the open-orders channel also lags during the -2013 phase (real V3 behaviour):
        // the legs only become visible once the visibility window has passed
        var realGetOpenAlgos = run.client.getOpenAlgoOrders;
        run.client.getOpenAlgoOrders = function (symbol) {
            return realGetOpenAlgos(symbol).then(function (algos) {
                if (verifyFailures < (opts.verifyFailAfter === undefined ? 2 : opts.verifyFailAfter)) {
                    return (algos || []).filter(function (o) {
                        return !/^IMC_BTCUSDT_(SL|TP)_/.test(String(o.clientAlgoId)); });
                }
                if (opts.hideTpForever) {
                    return (algos || []).filter(function (o) { return o.type !== 'TAKE_PROFIT_MARKET'; });
                }
                return algos;
            });
        };
        var realSubmit = run.client.submitProtection;
        run.client.submitProtection = function (plan, role) {
            var id = 'IMC_BTCUSDT_' + role + '_' + (opts.ids ? opts.ids[role] : role);
            // keep the exchange-side mutation log authoritative (real V3 semantics):
            // a placement that reaches the exchange is recorded, not silently mocked away.
            run.ex.mutations.push({ op: 'PLACE_PROTECTION', role: role, clientAlgoId: id, params: plan });
            run.ex.openAlgos.push({ clientAlgoId: id, algoId: role === 'SL' ? 3000002200071150 : 3000002200071165,
                algoStatus: 'NEW', type: role === 'SL' ? 'STOP_MARKET' : 'TAKE_PROFIT_MARKET',
                workingType: 'MARK_PRICE', closePosition: true, side: 'SELL',
                triggerPrice: String(role === 'SL' ? plan.stopPrice : plan.targetPrice) });
            return Promise.resolve({ clientAlgoId: id,
                algoId: role === 'SL' ? 3000002200071150 : 3000002200071165, algoStatus: 'NEW' });
        };
        run.client.queryAlgoOrder = function (symbol, algoId, clientAlgoId) {
            if (verifyFailures < (opts.verifyFailAfter === undefined ? 2 : opts.verifyFailAfter)) {
                verifyFailures += 1;
                var error = new Error('Request failed with status code 400');
                error.code = 'ERR_BAD_REQUEST';
                error.response = { status: 400, data: { code: -2013, msg: 'Order does not exist.' } };
                return Promise.reject(error);
            }
            var found = run.ex.openAlgos.filter(function (o) {
                if (algoId !== null && algoId !== undefined) return String(o.algoId) === String(algoId);
                return o.clientAlgoId === clientAlgoId; })[0];
            if (found) return Promise.resolve(found);
            return Promise.resolve({ clientAlgoId: clientAlgoId, algoStatus: 'NOT_FOUND' });
        };
        return { run: run, events: events, failures: function () { return verifyFailures; } };
    }

    await check('HU1 both legs temporarily -2013 then exchange-ACTIVE -> halt cleared once', async function () {
        var h = haltHarness({});
        var run = h.run;
        try {
            var dyn = Date.now();
            await run.service.onDynamicD([dPoint('HU_SL_UP', 'LOW', 101, 12, dyn)], dyn);
            await run.service.reconcile();
            assert.strictEqual(run.service.isHalted(), true, 'the -2013 verifies halt the service');
            assert.strictEqual(run.service.haltReason(), 'UNPROTECTED_LIVE_POSITION');
            var replacementsBefore = mutationsOf(run.ex, 'PLACE_PROTECTION').length;
            await run.service.reconcile();
            if (run.service.isHalted()) await run.service.reconcile();
            assert.strictEqual(run.service.isHalted(), false, 'both legs ACTIVE -> halt cleared');
            var trade = tradeOf(run.service, 'BB_SEED');
            assert.strictEqual(trade.slOrder.verified, true);
            assert.strictEqual(trade.tpOrder.verified, true);
            assert.strictEqual(h.events.filter(function (e) {
                return e.type === 'EXECUTION_HALT_CLEARED'; }).length, 1, 'cleared exactly once');
            // regression for the snapshot-entry shape bug: an open-order snapshot that
            // verifies a leg must not make the NEXT accepted placement throw and be
            // mislabelled as a replacement failure.
            assert.strictEqual(h.events.some(function (e) {
                return e.type === 'PROTECTION_REPLACE_FAILED' ||
                    e.type === 'PROTECTION_PLACEMENT_UNKNOWN'; }), false,
                'snapshot verification must not poison the next accepted placement');
            await run.service.reconcile();
            assert.strictEqual(mutationsOf(run.ex, 'PLACE_PROTECTION').length > replacementsBefore, true,
                'dynamic replacement may mutate again after the clear');
        } finally { run.service.stop(); }
    });

    await check('HU2 SL ACTIVE but TP still unconfirmed -> halt stays, 0 replacement mutation',
        async function () {
            var h = haltHarness({ hideTpForever: true });
            var run = h.run;
            try {
                var dyn = Date.now();
                await run.service.onDynamicD([dPoint('HU_SL_UP2', 'LOW', 101, 12, dyn)], dyn);
                await run.service.reconcile();
                assert.strictEqual(run.service.isHalted(), true);
                run.ex.openAlgos = run.ex.openAlgos.filter(function (o) {
                    return o.type !== 'TAKE_PROFIT_MARKET'; });   // TP never confirms
                var before = mutationsOf(run.ex, 'PLACE_PROTECTION').length;
                await run.service.reconcile();
                await run.service.reconcile();
                assert.strictEqual(run.service.isHalted(), true, 'one leg is not enough');
                assert.strictEqual(mutationsOf(run.ex, 'PLACE_PROTECTION').length, before,
                    'no dynamic replacement while halted');
            } finally { run.service.stop(); }
        });

    await check('HU3 position goes flat before both legs confirm -> cleanup, no clear+dynamic',
        async function () {
            var h = haltHarness({});
            var run = h.run;
            try {
                var dyn = Date.now();
                await run.service.onDynamicD([dPoint('HU_SL_UP3', 'LOW', 101, 12, dyn)], dyn);
                await run.service.reconcile();
                assert.strictEqual(run.service.isHalted(), true);
                run.ex.positionAmt = 0;                    // the position is gone
                var before = mutationsOf(run.ex, 'PLACE_PROTECTION').length;
                await run.service.reconcile();
                await run.service.reconcile();
                assert.strictEqual(mutationsOf(run.ex, 'PLACE_PROTECTION').length, before,
                    'flat position must not clear the halt and start dynamic mutation');
                assert.strictEqual(tradeOf(run.service, 'BB_SEED').status, 'CLOSED');
            } finally { run.service.stop(); }
        });

    // ---- V3-PROD-1: the PURE PRODUCTION replacement + cleanup lifecycle must be
    //      self-sufficient (no local smoke wrapper guard required).
    await check('V3-PROD-1 production replacement + cleanup needs no external guard',
        async function () {
            var run = liveService({ exchangeOptions: { positionQty: 1, mark: 105 },
                repository: seedRepository('LONG') });
            run.ex.openAlgos = [{ clientAlgoId: 'IMC_BTCUSDT_SL_seed', algoStatus: 'NEW' },
                { clientAlgoId: 'IMC_BTCUSDT_TP_seed', algoStatus: 'NEW' }];
            try {
                var tick = function () {
                    return new Promise(function (resolve) { setTimeout(resolve, 3); }); };
                var dyn = Date.now();
                await run.service.onDynamicD([dPoint('DYN_SL_UP', 'LOW', 101, 12, dyn)], dyn);
                await tick();
                await run.service.reconcile();
                var tpDown = dPoint('DYN_TP_DOWN', 'HIGH', 107, 13, dyn + 1);
                await run.service.onDynamicD([tpDown], dyn + 1);
                await tick();
                await run.service.reconcile();
                var firstTpId = tradeOf(run.service, 'BB_SEED').tpOrder.clientOrderId;
                tpDown.state = 'INACTIVE';      // that target was consumed
                await run.service.onDynamicD([dPoint('DYN_TP_UP', 'HIGH', 120, 14, dyn + 2)], dyn + 2);
                await tick();
                await run.service.reconcile();
                var deletes = mutationsOf(run.ex, 'CANCEL_ALGO');
                var perId = {};
                deletes.forEach(function (m) { perId[m.clientAlgoId] = (perId[m.clientAlgoId] || 0) + 1; });
                assert.strictEqual(perId['IMC_BTCUSDT_SL_seed'], 1, 'replacement old SL canceled once');
                assert.strictEqual(perId['IMC_BTCUSDT_TP_seed'], 1, 'first old TP canceled once :: ' +
                    JSON.stringify(run.ex.mutations.map(function (m) {
                        return m.op + ':' + (m.role || m.clientAlgoId || ''); })));
                var trade = tradeOf(run.service, 'BB_SEED');
                assert.strictEqual(perId[firstTpId], 1, 'second old TP canceled exactly once');
                assert.strictEqual(trade.tpOrder.clientOrderId !== firstTpId, true,
                    'the TP-up replacement produced a new id');
                assert.strictEqual(trade.tpOrder.price, 120, 'the current TP is the up-target');
                var currentSl = trade.slOrder.clientOrderId;
                var currentTp = trade.tpOrder.clientOrderId;
                run.ex.positionAmt = 0;
                await run.service.reconcile();
                var afterClose = mutationsOf(run.ex, 'CANCEL_ALGO');
                var perId2 = {};
                afterClose.forEach(function (m) { perId2[m.clientAlgoId] = (perId2[m.clientAlgoId] || 0) + 1; });
                assert.strictEqual(perId2[currentSl], 1, 'current SL cleaned exactly once');
                assert.strictEqual(perId2[currentTp], 1, 'current TP cleaned exactly once');
                assert.strictEqual(run.ex.openAlgos.length, 0, 'no protective order left open');
                for (var i = 0; i < 20; i++) await run.service.reconcile();
                assert.strictEqual(mutationsOf(run.ex, 'CANCEL_ALGO').length, afterClose.length,
                    'reconcile x20 adds zero further DELETE');
                assert.deepStrictEqual(Object.keys(perId2).filter(function (id) {
                    return perId2[id] > 1; }), [], 'no exact id is DELETEd twice');
            } finally { run.service.stop(); }
        });

    // ---- V3-PROD-2: does PRODUCTION itself blind-retry a DELETE whose outcome is
    //      unknown (5xx)? Measured, never papered over by the smoke wrapper.
    await check('V3-PROD-2 production DELETE with an unknown outcome (measured)', async function () {
        var run = liveService({ exchangeOptions: { positionQty: 0, mark: 105,
            failCancelOnce: true }, repository: seedRepository('LONG', { positionQty: 0 }) });
        run.ex.openAlgos = [{ clientAlgoId: 'IMC_BTCUSDT_SL_seed', algoStatus: 'NEW' },
            { clientAlgoId: 'IMC_BTCUSDT_TP_seed', algoStatus: 'NEW' }];
        try {
            await run.service.reconcile();
            for (var i = 0; i < 3; i++) await run.service.reconcile();
            var deletes = mutationsOf(run.ex, 'CANCEL_ALGO').filter(function (m) {
                return m.clientAlgoId === 'IMC_BTCUSDT_SL_seed'; });
            console.log('MEASURED production DELETE attempts for one id after a 5xx: ' +
                deletes.length);
            assert.ok(deletes.length >= 1, 'the DELETE was attempted');
        } finally { run.service.stop(); }
    });

    // =========================================================================
    // §PRODUCTION BRIDGE REPLACEMENT - PR-B1 .. PR-B15
    // =========================================================================
    /** Seeded LONG trade whose canonical SL/TP are live on the mock exchange. */
    async function bridgeScenario(opts) {
        var o = opts || {};
        var seedOverrides = Object.assign({}, o.seed || {});
        var run = liveService({ exchangeOptions: Object.assign(
            { positionQty: 1, mark: 105 }, o.exchangeOptions || {}),
            repository: seedRepository('LONG', seedOverrides) });
        var snapshot = run.service.getSnapshot().trades.BB_SEED;
        var slId = snapshot.slOrder.clientOrderId;
        var tpId = snapshot.tpOrder.clientOrderId;
        run.ex.openAlgos = [
            { clientAlgoId: slId, algoId: 1, algoStatus: 'NEW', closePosition: true, type: 'STOP_MARKET' },
            { clientAlgoId: tpId, algoId: 2, algoStatus: 'NEW', closePosition: true, type: 'TAKE_PROFIT_MARKET' }];
        return { run: run, slId: slId, tpId: tpId };
    }
    function lastReplacement(svc) { return tradeOf(svc, 'BB_SEED').lastReplacement || null; }
    function inFlight(svc, role) {
        var t = tradeOf(svc, 'BB_SEED');
        return (t.replacements || {})[role] || null;
    }
    function deletesOf(svc, id) {
        var t = tradeOf(svc, 'BB_SEED');
        return ((t.protectionDeletes || {})[id] || {}).attempts || 0;
    }
    function bridgeMutations(ex, role) {
        return mutationsOf(ex, 'PLACE_BRIDGE').filter(function (m) { return m.role === role; });
    }

    await check('PR-B1 SL happy path moves the stop through the bridge lifecycle', async function () {
        var s = await bridgeScenario();
        try {
            await s.run.service.onDynamicD([dPoint('PRB1', 'LOW', 101, 12, 5000)], Date.now());
            await s.run.service.reconcile();
            var trade = tradeOf(s.run.service, 'BB_SEED');
            assert.strictEqual(trade.slOrder.price, 101);
            assert.strictEqual(bridgeMutations(s.run.ex, 'SL').length, 1);
            assert.strictEqual(bridgeMutations(s.run.ex, 'SL')[0].params.triggerPrice, 101);
            var placed = mutationsOf(s.run.ex, 'PLACE_PROTECTION').filter(function (m) { return m.role === 'SL'; });
            assert.strictEqual(placed.length, 1);
            assert.strictEqual(trade.slOrder.clientOrderId, placed[0].clientAlgoId);
            assert.deepStrictEqual(mutationsOf(s.run.ex, 'CANCEL_ALGO').map(function (m) { return m.clientAlgoId; }),
                [s.slId, bridgeMutations(s.run.ex, 'SL')[0].clientAlgoId]);
            assert.strictEqual(lastReplacement(s.run.service).phase, 'COMPLETE');
            assert.strictEqual(inFlight(s.run.service, 'SL'), null);
        } finally { s.run.service.stop(); }
    });

    await check('PR-B2 TP_DOWN happy path reprices the target down', async function () {
        var s = await bridgeScenario();
        try {
            await s.run.service.onDynamicD([dPoint('PRB2', 'HIGH', 106.5, 12, 5000)], Date.now());
            await s.run.service.reconcile();
            var trade = tradeOf(s.run.service, 'BB_SEED');
            assert.strictEqual(trade.tpOrder.price, 106.5);
            var bridges = bridgeMutations(s.run.ex, 'TP');
            assert.strictEqual(bridges.length, 1);
            assert.strictEqual(bridges[0].params.triggerPrice, 106.5);
            assert.deepStrictEqual(mutationsOf(s.run.ex, 'CANCEL_ALGO').map(function (m) { return m.clientAlgoId; }),
                [s.tpId, bridges[0].clientAlgoId]);
            assert.strictEqual(lastReplacement(s.run.service).phase, 'COMPLETE');
        } finally { s.run.service.stop(); }
    });

    await check('PR-B3 TP_UP happy path reprices the target up', async function () {
        var s = await bridgeScenario({ seed: { tpOrder: { role: 'TP',
            clientOrderId: 'IMC_BTCUSDT_TP_now', status: 'NEW', price: 106.5 } } });
        try {
            await s.run.service.onDynamicD([dPoint('PRB3', 'HIGH', 112, 12, 5000)], Date.now());
            await s.run.service.reconcile();
            var trade = tradeOf(s.run.service, 'BB_SEED');
            assert.strictEqual(trade.tpOrder.price, 112);
            var bridges = bridgeMutations(s.run.ex, 'TP');
            assert.strictEqual(bridges.length, 1);
            assert.deepStrictEqual(mutationsOf(s.run.ex, 'CANCEL_ALGO').map(function (m) { return m.clientAlgoId; }),
                ['IMC_BTCUSDT_TP_now', bridges[0].clientAlgoId]);
            assert.strictEqual(lastReplacement(s.run.service).phase, 'COMPLETE');
        } finally { s.run.service.stop(); }
    });

    await check('PR-B4 SL_WORSE candidate causes zero mutation', async function () {
        var s = await bridgeScenario();
        try {
            // a LOW BELOW the current stop 98 can only widen risk -> must be ignored
            await s.run.service.onDynamicD([dPoint('PRB4', 'LOW', 97, 12, 5000)], Date.now());
            await s.run.service.reconcile();
            assert.strictEqual(bridgeMutations(s.run.ex, 'SL').length, 0);
            assert.strictEqual(mutationsOf(s.run.ex, 'PLACE_PROTECTION').length, 0);
            assert.strictEqual(mutationsOf(s.run.ex, 'CANCEL_ALGO').length, 0);
            assert.strictEqual(tradeOf(s.run.service, 'BB_SEED').slOrder.price, 98);
        } finally { s.run.service.stop(); }
    });

    await check('PR-B5 stale Dynamic-D candidate causes zero mutation', async function () {
        var s = await bridgeScenario();
        try {
            // confirmedAt before positionOpenedAt -> not eligible for an update
            await s.run.service.onDynamicD([dPoint('PRB5', 'LOW', 101, 1, 1)], Date.now());
            await s.run.service.reconcile();
            assert.strictEqual(bridgeMutations(s.run.ex, 'SL').length, 0);
            assert.strictEqual(mutationsOf(s.run.ex, 'PLACE_PROTECTION').length, 0);
            assert.strictEqual(mutationsOf(s.run.ex, 'CANCEL_ALGO').length, 0);
        } finally { s.run.service.stop(); }
    });

    await check('PR-B6 rejected bridge keeps the old canonical live', async function () {
        var s = await bridgeScenario({ exchangeOptions: { failBridgeRole: 'SL' } });
        try {
            await s.run.service.onDynamicD([dPoint('PRB6', 'LOW', 101, 12, 5000)], Date.now());
            await s.run.service.reconcile();
            assert.strictEqual(mutationsOf(s.run.ex, 'PLACE_PROTECTION').length, 0);
            assert.strictEqual(mutationsOf(s.run.ex, 'CANCEL_ALGO').length, 0, 'nothing may be cancelled');
            assert.strictEqual(s.run.ex.openAlgos.some(function (o) { return o.clientAlgoId === s.slId; }), true);
            assert.strictEqual(s.run.service.isHalted(), true);
            assert.strictEqual(lastReplacement(s.run.service).phase, 'FAILED_SAFE');
            assert.strictEqual(lastReplacement(s.run.service).reasonCode, 'BRIDGE_POST_REJECTED');
        } finally { s.run.service.stop(); }
    });

    await check('PR-B7 old canonical cancel visibility lag resolves read-only', async function () {
        var s = await bridgeScenario({ exchangeOptions: { oldCancelLag: ['NEW', 'NEW'] } });
        try {
            await s.run.service.onDynamicD([dPoint('PRB7', 'LOW', 101, 12, 5000)], Date.now());
            await s.run.service.reconcile();
            for (var i = 0; i < 4 && inFlight(s.run.service, 'SL'); i++) await s.run.service.reconcile();
            assert.strictEqual(deletesOf(s.run.service, s.slId), 1, 'exactly one DELETE attempt');
            assert.strictEqual(lastReplacement(s.run.service).phase, 'COMPLETE', JSON.stringify(inFlight(s.run.service, 'SL')));
        } finally { s.run.service.stop(); }
    });

    await check('PR-B8 new canonical verify lag is ACCEPTED_PENDING, never a re-post',
        async function () {
            var s = await bridgeScenario({ exchangeOptions: { canonicalPlaceLag: ['NOT_FOUND', 'NOT_FOUND'] } });
            try {
                await s.run.service.onDynamicD([dPoint('PRB8', 'LOW', 101, 12, 5000)], Date.now());
                await s.run.service.reconcile();
                var pending = inFlight(s.run.service, 'SL');
                assert.ok(pending, 'the lifecycle is still in flight after the lag');
                assert.strictEqual(pending.phase, 'NEW_CANONICAL_VERIFICATION_PENDING');
                var firstId = pending.newCanonicalClientAlgoId;
                for (var i = 0; i < 4 && inFlight(s.run.service, 'SL'); i++) await s.run.service.reconcile();
                var posts = mutationsOf(s.run.ex, 'PLACE_PROTECTION').filter(function (m) {
                    return m.clientAlgoId === firstId; });
                assert.strictEqual(posts.length, 1, 'the accepted identity received exactly one POST');
                assert.strictEqual(lastReplacement(s.run.service).phase, 'COMPLETE');
            } finally { s.run.service.stop(); }
        });

    await check('PR-B9 bridge cancel visibility lag resolves read-only', async function () {
        var s = await bridgeScenario({ exchangeOptions: { bridgeCancelLag: ['ACTIVE', 'ACTIVE'] } });
        try {
            await s.run.service.onDynamicD([dPoint('PRB9', 'LOW', 101, 12, 5000)], Date.now());
            await s.run.service.reconcile();
            for (var i = 0; i < 4 && inFlight(s.run.service, 'SL'); i++) await s.run.service.reconcile();
            var bridgeId = bridgeMutations(s.run.ex, 'SL')[0].clientAlgoId;
            assert.strictEqual(deletesOf(s.run.service, bridgeId), 1, 'exactly one bridge DELETE');
            assert.strictEqual(lastReplacement(s.run.service).phase, 'COMPLETE');
        } finally { s.run.service.stop(); }
    });

    await check('PR-B10 position goes flat mid-transition -> FLAT_ABORT, no new canonical',
        async function () {
            var flat = false;
            var s = await bridgeScenario({ exchangeOptions: {
                onCancel: function (clientAlgoId, ex) {
                    if (String(clientAlgoId).indexOf('_BRIDGE_') < 0 && !flat) {
                        flat = true;
                        ex.positionAmt = 0;      // the old canonical fired while being replaced
                    }
                } } });
            try {
                await s.run.service.onDynamicD([dPoint('PRB10', 'LOW', 101, 12, 5000)], Date.now());
                await s.run.service.reconcile();
                await s.run.service.reconcile();
                assert.strictEqual(mutationsOf(s.run.ex, 'PLACE_PROTECTION').length, 0,
                    'nothing new may be placed once the position is flat');
                assert.strictEqual(lastReplacement(s.run.service).phase, 'FLAT_ABORT');
                assert.strictEqual(inFlight(s.run.service, 'SL'), null);
            } finally { s.run.service.stop(); }
        });

    await check('PR-B11 partial quantity change -> FAILED_SAFE, old qty never reused',
        async function () {
            var s = await bridgeScenario({ exchangeOptions: {
                bridgeVerifyLag: ['NOT_FOUND', 'NOT_FOUND', 'NOT_FOUND', 'NEW'] } });
            try {
                await s.run.service.onDynamicD([dPoint('PRB11', 'LOW', 101, 12, 5000)], Date.now());
                await s.run.service.reconcile();
                assert.strictEqual(inFlight(s.run.service, 'SL').phase, 'BRIDGE_VERIFICATION_PENDING');
                s.run.ex.positionAmt = 0.5;
                for (var i = 0; i < 3 && inFlight(s.run.service, 'SL'); i++) await s.run.service.reconcile();
                assert.strictEqual(mutationsOf(s.run.ex, 'PLACE_PROTECTION').length, 0);
                assert.strictEqual(lastReplacement(s.run.service).phase, 'FAILED_SAFE');
                assert.strictEqual(lastReplacement(s.run.service).reasonCode,
                    'POSITION_CHANGED_DURING_REPLACEMENT');
            } finally { s.run.service.stop(); }
        });

    await check('PR-B12 restart resumes every intermediate phase from exchange truth',
        async function () {
            // A..F of §10, each seeded as a persisted phase and resumed by reconcile
            var scenarios = [
                { name: 'A bridge ACTIVE + old canonical ACTIVE', phase: 'BRIDGE_ACTIVE',
                    expectPosts: 1 },
                { name: 'B bridge ACTIVE + old terminal, no new canonical', phase: 'OLD_TERMINAL',
                    expectPosts: 1 },
                { name: 'C bridge ACTIVE + new canonical accepted/unverified',
                    phase: 'NEW_CANONICAL_VERIFICATION_PENDING', expectPosts: 0 },
                { name: 'D new canonical ACTIVE + bridge ACTIVE', phase: 'NEW_CANONICAL_ACTIVE',
                    expectPosts: 0 },
                { name: 'E cancel accepted, terminal not visible', phase: 'BRIDGE_CANCEL_PENDING',
                    expectPosts: 0, deletedBridge: true, bridgeLag: ['ACTIVE', 'CANCELED'] },
                { name: 'F position already flat', phase: 'BRIDGE_ACTIVE', flat: true,
                    expectPosts: 0 }];
            for (var i = 0; i < scenarios.length; i++) {
                var sc = scenarios[i];
                var bridgeId = 'IMC_BTCUSDT_SL_BRIDGE_seed';
                var newId = 'IMC_BTCUSDT_SL_' + (i + 90);
                var seedTrade = {
                    slOrder: { role: 'SL', clientOrderId: sc.phase === 'BRIDGE_ACTIVE'
                        || sc.phase === 'BRIDGE_CANCEL_PENDING' ? bridgeId : newId,
                        status: 'NEW', price: 101, verified: true },
                    replacements: { SL: { role: 'SL', phase: sc.phase, revision: 1,
                        desiredTrigger: 101, freshPositionQty: 1,
                        oldCanonicalId: 'IMC_BTCUSDT_SL_seed', oldCanonicalAlgoId: 1,
                        bridgeClientAlgoId: bridgeId, bridgeAlgoId: 3, bridgeVerifiedActive: true,
                        bridgeTrigger: 101, newCanonicalClientAlgoId: newId,
                        newCanonicalId: newId, newCanonicalVerifiedActive: true,
                        startedAt: Date.now() - 10, phaseStartedAt: Date.now() - 10 },
                        TP: null } };
                if (sc.deletedBridge) {
                    // the DELETE was already accepted before the restart: never again
                    seedTrade.protectionDeletes = {};
                    seedTrade.protectionDeletes[bridgeId] = { attempts: 1,
                        acceptedAt: Date.now() - 5 };
                }
                var s = await bridgeScenario({ exchangeOptions: { positionQty: sc.flat ? 0 : 1 },
                    seed: sc.flat ? Object.assign({ positionQty: 0 }, seedTrade) : seedTrade });
                try {
                    s.run.ex.openAlgos = [
                        { clientAlgoId: bridgeId, algoId: 3, algoStatus: 'NEW', closePosition: false,
                            reduceOnly: true, type: 'STOP_MARKET',
                            laggedStatus: sc.bridgeLag ? sc.bridgeLag.slice() : undefined },
                        { clientAlgoId: newId, algoId: 4, algoStatus: 'NEW', closePosition: true,
                            type: 'STOP_MARKET' }];
                    await s.run.service.reconcile();
                    for (var r = 0; r < 4 && inFlight(s.run.service, 'SL'); r++) {
                        await s.run.service.reconcile();
                    }
                    var done = lastReplacement(s.run.service);
                    assert.ok(done, sc.name + ': the lifecycle reached a final phase');
                    assert.strictEqual(['COMPLETE', 'FLAT_ABORT'].indexOf(done.phase) >= 0, true,
                        sc.name + ' -> ' + done.phase + ' / ' + done.reasonCode);
                    // §10: a resumed phase continues from exchange truth. A phase that
                    // already had its POST must never POST again.
                    assert.strictEqual(mutationsOf(s.run.ex, 'PLACE_PROTECTION').length,
                        sc.expectPosts, sc.name + ': resumed placement count');
                    var delCounts = {};
                    mutationsOf(s.run.ex, 'CANCEL_ALGO').forEach(function (m) {
                        delCounts[m.clientAlgoId] = (delCounts[m.clientAlgoId] || 0) + 1; });
                    Object.keys(delCounts).forEach(function (id) {
                        assert.strictEqual(delCounts[id], 1,
                            sc.name + ': DELETE once for ' + id);
                    });
                } finally { s.run.service.stop(); }
            }
        });

    await check('PR-B13 a mid-replacement role is never double-owned; the other role still works',
        async function () {
        var s = await bridgeScenario({ seed: {
            slOrder: { role: 'SL', clientOrderId: 'IMC_BTCUSDT_SL_BRIDGE_seed', status: 'NEW',
                price: 101, verified: true, bridge: true },
            replacements: { SL: { role: 'SL', phase: 'BRIDGE_ACTIVE', revision: 1,
                desiredTrigger: 101, freshPositionQty: 1, oldCanonicalId: 'IMC_BTCUSDT_SL_seed',
                bridgeClientAlgoId: 'IMC_BTCUSDT_SL_BRIDGE_seed', bridgeAlgoId: 3,
                bridgeVerifiedActive: true, bridgeTrigger: 101,
                startedAt: Date.now() - 10, phaseStartedAt: Date.now() - 10 }, TP: null } } });
        try {
            s.run.ex.openAlgos = [
                { clientAlgoId: 'IMC_BTCUSDT_SL_BRIDGE_seed', algoId: 3, algoStatus: 'NEW',
                    closePosition: false, reduceOnly: true, type: 'STOP_MARKET' },
                { clientAlgoId: s.tpId, algoId: 2, algoStatus: 'NEW', closePosition: true,
                    type: 'TAKE_PROFIT_MARKET' }];
            await s.run.service.reconcile();
            // the SL lifecycle resumes and finishes its OWN canonical placement...
            for (var i = 0; i < 4 && inFlight(s.run.service, 'SL'); i++) {
                await s.run.service.reconcile();
            }
            assert.strictEqual(lastReplacement(s.run.service).phase, 'COMPLETE');
            var slPosts = mutationsOf(s.run.ex, 'PLACE_PROTECTION').filter(function (m) {
                return m.role === 'SL'; });
            assert.strictEqual(slPosts.length, 1,
                'exactly ONE canonical placement for the SL role (no auto-heal duplicate)');
            assert.strictEqual(mutationsOf(s.run.ex, 'PLACE_BRIDGE').filter(function (m) {
                return m.role === 'SL'; }).length, 0,
                'the resumed BRIDGE_ACTIVE phase reuses its existing bridge');
            // ...while the OTHER role is still managed normally
            await s.run.service.onDynamicD([dPoint('PRB13T', 'HIGH', 106.5, 12, 5000)], Date.now());
            await s.run.service.reconcile();
            assert.strictEqual(mutationsOf(s.run.ex, 'PLACE_BRIDGE').filter(function (m) {
                return m.role === 'TP'; }).length, 1, 'the TP role was never blocked');
        } finally { s.run.service.stop(); }
    });

    await check('PR-B14 every exact clientAlgoId receives at most one POST', async function () {
        var s = await bridgeScenario();
        try {
            await s.run.service.onDynamicD([dPoint('PRB14', 'LOW', 101, 12, 5000)], Date.now());
            await s.run.service.reconcile();
            await s.run.service.onDynamicD([dPoint('PRB14T', 'HIGH', 106.5, 13, 5001)], Date.now());
            await s.run.service.reconcile();
            for (var i = 0; i < 3; i++) await s.run.service.reconcile();
            var counts = {};
            mutationsOf(s.run.ex, 'PLACE_PROTECTION').concat(mutationsOf(s.run.ex, 'PLACE_BRIDGE'))
                .forEach(function (m) { counts[m.clientAlgoId] = (counts[m.clientAlgoId] || 0) + 1; });
            Object.keys(counts).forEach(function (id) {
                assert.strictEqual(counts[id], 1, 'exactly one POST for ' + id);
            });
            assert.ok(Object.keys(counts).length >= 4, 'two bridges + two canonical posts');
        } finally { s.run.service.stop(); }
    });

    await check('PR-B15 every exact clientAlgoId receives at most one DELETE', async function () {
        var s = await bridgeScenario();
        try {
            await s.run.service.onDynamicD([dPoint('PRB15', 'LOW', 101, 12, 5000)], Date.now());
            await s.run.service.reconcile();
            for (var i = 0; i < 25; i++) await s.run.service.reconcile();
            var trade = tradeOf(s.run.service, 'BB_SEED');
            Object.keys(trade.protectionDeletes || {}).forEach(function (id) {
                assert.ok(trade.protectionDeletes[id].attempts <= 1,
                    'at most one DELETE for ' + id + ': ' + trade.protectionDeletes[id].attempts);
            });
            var deletes = {};
            mutationsOf(s.run.ex, 'CANCEL_ALGO').forEach(function (m) {
                deletes[m.clientAlgoId] = (deletes[m.clientAlgoId] || 0) + 1; });
            Object.keys(deletes).forEach(function (id) {
                assert.strictEqual(deletes[id], 1, 'wire-level DELETE once for ' + id);
            });
        } finally { s.run.service.stop(); }
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
