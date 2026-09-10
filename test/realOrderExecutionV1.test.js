'use strict';

var test = require('node:test');
var assert = require('node:assert');
var rules = require('../execution/executionRulesV1');
var repository = require('../execution/executionRepositoryV1');
var serviceModule = require('../execution/realOrderExecutionV1');
var clientModule = require('../execution/binanceExecutionClientV1');
var watchModule = require('../live/eqFvgCountWatchV1');

function bias(direction, strength, confidence) {
    return { status: 'AVAILABLE', closedAt: 100, semantic: { direction: direction, strength: strength, confidence: confidence } };
}
function event(type, ordinal) {
    var bull = type === 'EQL';
    return { ordinal: ordinal === undefined ? 1 : ordinal, watchId: 'W-' + type, symbol: 'BTCUSDT', liquidityId: 'EQ-' + type,
        liquidityType: type, liquidityPrice: bull ? 99 : 111, eqConfirmedAt: 90,
        eqSourceContext: { currentPivot: { price: bull ? 99 : 111, occurredAt: 80, confirmedAt: 90 } },
        rawFvg: { id: 'F-' + type + '-' + (ordinal || 1), direction: bull ? 'BULLISH' : 'BEARISH',
            low: bull ? 100 : 108, high: bull ? 102 : 110, k3Index: 8, confirmedAt: 120 } };
}
function context(type, overrides) {
    var long = type === 'EQL';
    return Object.assign({ bias: bias(long ? 'BULLISH' : 'BEARISH', 'STRONG', 'HIGH'), expected4hClosedAt: 100,
        dynamicDPoints: [{ id: 'D', pointSide: long ? 'HIGH' : 'LOW', price: long ? 104 : 106, confirmedAt: 90, state: 'ACTIVE' }],
        candles: [], symbolRules: { source: 'futures', tickSize: 0.1, stepSize: 0.001,
            minQty: 0.001, maxQty: 100, minNotional: 5 } }, overrides || {});
}

test('entry gate: bullish STRONG HIGH passes', function () { assert.strictEqual(rules.biasGate('LONG', bias('BULLISH', 'STRONG', 'HIGH'), 100).ok, true); });
test('entry gate: bearish STRONG HIGH passes', function () { assert.strictEqual(rules.biasGate('SHORT', bias('BEARISH', 'STRONG', 'HIGH'), 100).ok, true); });
test('entry gate: direction conflict is rejected', function () { assert.strictEqual(rules.biasGate('LONG', bias('BEARISH', 'STRONG', 'HIGH'), 100).reasonCode, 'HTF_NOT_ALIGNED'); });
test('entry gate: MODERATE is rejected', function () { assert.strictEqual(rules.biasGate('LONG', bias('BULLISH', 'MODERATE', 'HIGH'), 100).reasonCode, 'HTF_NOT_STRONG'); });
test('entry gate: MEDIUM confidence is rejected', function () { assert.strictEqual(rules.biasGate('LONG', bias('BULLISH', 'STRONG', 'MEDIUM'), 100).reasonCode, 'HTF_NOT_HIGH_CONFIDENCE'); });
test('initialRR 0.99 is rejected', function () { assert.strictEqual(rules.geometry('LONG', 100, 99, 100.99).reasonCode, 'TRADE_SPACE_INSUFFICIENT'); });
test('initialRR 1.00 passes', function () { assert.strictEqual(rules.geometry('LONG', 100, 99, 101).ok, true); });

test('entry plan uses CE, original EQ wick, nearest causal active target and dynamic quantity', function () {
    var built = rules.buildEntryPlan(event('EQL'), Object.assign({ tradeId: 'T', liveTradingEnabled: false }, context('EQL')));
    assert.strictEqual(built.ok, true); assert.strictEqual(built.plan.entryPrice, 101);
    assert.strictEqual(built.plan.stopPrice, 99); assert.strictEqual(built.plan.targetPrice, 104);
    assert.strictEqual(built.plan.requestedQty, 0.199); assert.strictEqual(built.plan.initialRR, 1.5);
});

test('trade-through and future-confirmed Dynamic-D targets are ineligible', function () {
    var points = [{ id: 'taken', pointSide: 'HIGH', price: 104, confirmedAt: 90, state: 'ACTIVE' },
        { id: 'future', pointSide: 'HIGH', price: 105, confirmedAt: 121, state: 'ACTIVE' }];
    var candles = [{ closeTime: 110, high: 105, low: 98, closed: true }];
    assert.strictEqual(rules.selectTarget('LONG', 101, points, candles, 120), null);
});

test('Binance order parameters use LIMIT GTC and conditional full-close protection', function () {
    var plan = Object.assign(rules.buildEntryPlan(event('EQL'), Object.assign({ tradeId: 'T', liveTradingEnabled: true }, context('EQL'))).plan, { tradeId: 'T' });
    var entry = clientModule.buildEntryParams(plan); var sl = clientModule.buildProtectionParams(plan, 'SL');
    assert.strictEqual(entry.type, 'LIMIT'); assert.strictEqual(entry.timeInForce, 'GTC');
    assert.strictEqual(sl.type, 'STOP_MARKET'); assert.strictEqual(sl.workingType, 'MARK_PRICE');
    assert.strictEqual(sl.closePosition, 'true'); assert.strictEqual(sl.quantity, undefined); assert.strictEqual(sl.reduceOnly, undefined);
    assert.match(entry.newClientOrderId, /^[.A-Z:/a-z0-9_-]{1,36}$/);
});
test('uncertain entry POST queries by client ID and never blindly re-POSTs', async function () {
    var methods = [];
    var transport = { request: async function (cfg) {
        methods.push(cfg.method);
        if (cfg.method === 'POST') { var error = new Error('timeout'); error.code = 'ETIMEDOUT'; throw error; }
        return { data: { clientOrderId: 'recovered', status: 'NEW' } };
    } };
    var client = clientModule.createClient({ liveTradingEnabled: true, apiKey: 'test-key', secret: 'test-secret', transport: transport });
    var plan = Object.assign(rules.buildEntryPlan(event('EQL'), Object.assign({ tradeId: 'T', liveTradingEnabled: true }, context('EQL'))).plan, { tradeId: 'T' });
    var recovered = await client.submitEntry(plan);
    assert.strictEqual(recovered.status, 'NEW'); assert.deepStrictEqual(methods, ['POST', 'GET']);
});
test('client hard guard rejects every mutating call when live trading is disabled', async function () {
    var calls = 0; var client = clientModule.createClient({ liveTradingEnabled: false,
        transport: { request: async function () { calls++; return { data: {} }; } } });
    await assert.rejects(client.setLeverage('BTCUSDT', 10), /LIVE_TRADING_DISABLED/); assert.strictEqual(calls, 0);
});

function dryService(type) {
    var repo = repository.createRepository();
    var posts = 0;
    return { repo: repo, getPosts: function () { return posts; }, service: serviceModule.createService({ symbol: 'BTCUSDT', liveTradingEnabled: false,
        repository: repo, client: { submitEntry: function () { posts++; } }, getContext: function () { return context(type); } }) };
}
test('EQL first Bull FVG consumes forever and #2 cannot create another Entry', async function () {
    var x = dryService('EQL'); await x.service.onFirstMatchingFvg(event('EQL', 1)); await x.service.onFirstMatchingFvg(event('EQL', 2));
    assert.strictEqual(x.repo.isConsumed('EQ-EQL'), true); assert.strictEqual(Object.keys(x.repo.snapshot().trades).length, 1); assert.strictEqual(x.getPosts(), 0);
});
test('EQH first Bear FVG has symmetric permanent consumption', async function () {
    var x = dryService('EQH'); await x.service.onFirstMatchingFvg(event('EQH', 1)); await x.service.onFirstMatchingFvg(event('EQH', 2));
    assert.strictEqual(x.repo.isConsumed('EQ-EQH'), true); assert.strictEqual(Object.keys(x.repo.snapshot().trades).length, 1);
});
test('dry-run builds a shadow pending lifecycle and simulates causal cancel without POST', async function () {
    var x = dryService('EQL'); await x.service.onFirstMatchingFvg(event('EQL'));
    var id = Object.keys(x.repo.snapshot().trades)[0]; assert.strictEqual(x.repo.snapshot().trades[id].entryOrder.status, 'SHADOW_PENDING');
    await x.service.onConfirmedSwings([{ type: 'SWING_LOW', confirmedAt: 121 }]);
    assert.strictEqual(x.repo.snapshot().trades[id].status, 'SHADOW_CANCELED'); assert.strictEqual(x.getPosts(), 0);
});

function liveHarness(type, exchange) {
    var repo = repository.createRepository();
    var actions = [];
    var ex = Object.assign({
        syncTime: async function () {}, getPositionMode: async function () { return { dualSidePosition: false }; },
        getSymbolConfig: async function () { return [{ symbol: 'BTCUSDT', marginType: 'CROSSED', leverage: 10 }]; },
        getPositionRisk: async function () { return [{ positionAmt: '0', marginType: 'cross', leverage: '10' }]; },
        getOpenOrders: async function () { return []; }, getOpenAlgoOrders: async function () { return []; },
        queryOrder: async function () { return { status: 'NEW', origQty: '0.199', executedQty: '0' }; },
        setLeverage: async function () {}, submitEntry: async function () { actions.push('ENTRY'); return { clientOrderId: 'IMC_ENTRY', orderId: 1, status: 'NEW' }; },
        submitProtection: async function (plan, role) { actions.push(role); return { clientAlgoId: 'IMC_' + role, algoId: role, status: 'NEW' }; },
        cancelEntry: async function () { actions.push('CANCEL_ENTRY'); return { status: 'CANCELED' }; },
        cancelAlgo: async function (symbol, id) { actions.push('CANCEL_' + id); return { status: 'CANCELED' }; },
        emergencyClose: async function () { actions.push('MARKET_CLOSE'); }
    }, exchange || {});
    var service = serviceModule.createService({ symbol: 'BTCUSDT', liveTradingEnabled: true, repository: repo, client: ex,
        getContext: function () { return context(type); }, streamFactory: function () { return { start: async function () {}, stop: async function () {} }; } });
    return { service: service, repo: repo, actions: actions, exchange: ex };
}

test('pending entry is untouched before a confirmed pivot and canceled only on matching confirmed 2L/2R', async function () {
    var x = liveHarness('EQL'); await x.service.start(); await x.service.onFirstMatchingFvg(event('EQL'));
    await x.service.onConfirmedSwings([]); assert.strictEqual(x.actions.includes('CANCEL_ENTRY'), false);
    await x.service.onConfirmedSwings([{ type: 'SWING_LOW', confirmedAt: 121 }]); assert.strictEqual(x.actions.includes('CANCEL_ENTRY'), true); await x.service.stop();
});
test('short pending entry cancels only on confirmed HIGH', async function () {
    var x = liveHarness('EQH'); await x.service.start(); await x.service.onFirstMatchingFvg(event('EQH'));
    await x.service.onConfirmedSwings([{ type: 'SWING_LOW', confirmedAt: 121 }]); assert.strictEqual(x.actions.includes('CANCEL_ENTRY'), false);
    await x.service.onConfirmedSwings([{ type: 'SWING_HIGH', confirmedAt: 122 }]); assert.strictEqual(x.actions.includes('CANCEL_ENTRY'), true); await x.service.stop();
});
test('cancel/fill race: exchange FILLED state protects full position', async function () {
    var calls = 0;
    var x = liveHarness('EQL', { queryOrder: async function () { return { status: 'FILLED', origQty: '0.199', executedQty: '0.199', avgPrice: '101' }; },
        getPositionRisk: async function () { calls++; return [{ positionAmt: calls === 1 ? '0' : '0.199' }]; } });
    await x.service.start(); await x.service.onFirstMatchingFvg(event('EQL')); await x.service.onConfirmedSwings([{ type: 'SWING_LOW', confirmedAt: 121 }]);
    assert.deepStrictEqual(x.actions.slice(-2), ['SL', 'TP']); await x.service.stop();
});
test('cancel/fill race: partial canceled remainder protects actual partial position', async function () {
    var calls = 0;
    var x = liveHarness('EQL', { queryOrder: async function () { return { status: 'CANCELED', origQty: '0.199', executedQty: '0.05', avgPrice: '101' }; },
        getPositionRisk: async function () { calls++; return [{ positionAmt: calls === 1 ? '0' : '0.05' }]; } });
    await x.service.start(); await x.service.onFirstMatchingFvg(event('EQL')); await x.service.onConfirmedSwings([{ type: 'SWING_LOW', confirmedAt: 121 }]);
    assert.deepStrictEqual(x.actions.slice(-2), ['SL', 'TP']); await x.service.stop();
});

test('startup removes orphan SL and TP when exchange position is zero', async function () {
    var x = liveHarness('EQL', { getOpenAlgoOrders: async function () { return [{ clientAlgoId: 'IMC_SL_X', status: 'NEW' }, { clientAlgoId: 'IMC_TP_X', status: 'NEW' }]; } });
    await x.service.start(); assert.ok(x.actions.includes('CANCEL_IMC_SL_X')); assert.ok(x.actions.includes('CANCEL_IMC_TP_X')); await x.service.stop();
});

function protectedInitial(type) {
    var built = rules.buildEntryPlan(event(type), Object.assign({ tradeId: 'T_PROTECTED', liveTradingEnabled: true }, context(type)));
    return { version: 'REAL_ORDER_EXECUTION_V1', consumedEqIds: {}, activeTradeId: 'T_PROTECTED', trades: { T_PROTECTED: {
        tradeId: 'T_PROTECTED', status: 'PROTECTED', positionQty: 1, plan: built.plan,
        entryOrder: { clientOrderId: 'IMC_ENTRY', exchangeOrderId: 1, status: 'FILLED', requestedQty: 1 },
        slOrder: { clientOrderId: 'IMC_SL', exchangeOrderId: 2, status: 'NEW' },
        tpOrder: { clientOrderId: 'IMC_TP', exchangeOrderId: 3, status: 'NEW' }
    } } };
}
test('TP fill closes position and reconciliation cancels the surviving SL', async function () {
    var initial = protectedInitial('EQL'); var repo = repository.createRepository({ initial: initial }); var actions = [];
    var x = liveHarness('EQL', { getPositionRisk: async function () { return [{ positionAmt: '0', marginType: 'cross', leverage: '10' }]; },
        getOpenAlgoOrders: async function () { return [{ clientAlgoId: 'IMC_SL', status: 'NEW' }]; },
        cancelAlgo: async function (s, id) { actions.push(id); return { status: 'CANCELED' }; } });
    x = serviceModule.createService({ symbol: 'BTCUSDT', liveTradingEnabled: true, repository: repo, client: x.exchange,
        getContext: function () { return context('EQL'); }, streamFactory: function () { return { start: async function () {}, stop: async function () {} }; } });
    await x.start(); assert.ok(actions.includes('IMC_SL')); await x.stop();
});
test('SL fill closes position and reconciliation cancels the surviving TP', async function () {
    var initial = protectedInitial('EQL'); var repo = repository.createRepository({ initial: initial }); var actions = [];
    var h = liveHarness('EQL', { getPositionRisk: async function () { return [{ positionAmt: '0', marginType: 'cross', leverage: '10' }]; },
        getOpenAlgoOrders: async function () { return [{ clientAlgoId: 'IMC_TP', status: 'NEW' }]; },
        cancelAlgo: async function (s, id) { actions.push(id); return { status: 'CANCELED' }; } });
    var x = serviceModule.createService({ symbol: 'BTCUSDT', liveTradingEnabled: true, repository: repo, client: h.exchange,
        getContext: function () { return context('EQL'); }, streamFactory: function () { return { start: async function () {}, stop: async function () {} }; } });
    await x.start(); assert.ok(actions.includes('IMC_TP')); await x.stop();
});

test('exchange source of truth rebuilds local pending as filled and protected', async function () {
    var x = liveHarness('EQL', { queryOrder: async function () { return { status: 'FILLED', origQty: '0.199', executedQty: '0.199', avgPrice: '101' }; },
        getPositionRisk: async function () { return [{ positionAmt: '0.199', marginType: 'cross', leverage: '10' }]; } });
    await x.service.start(); await x.service.onFirstMatchingFvg(event('EQL')); await x.service.reconcile();
    assert.strictEqual(x.repo.activeTrade().status, 'PROTECTED'); await x.service.stop();
});

test('persistent SL placement failure triggers critical market close', async function () {
    var calls = 0;
    var x = liveHarness('EQL', {
        getPositionRisk: async function () { calls++; return [{ positionAmt: calls === 1 ? '0' : '0.199' }]; },
        queryOrder: async function () { return { status: 'FILLED', origQty: '0.199', executedQty: '0.199' }; },
        submitProtection: async function () { throw Object.assign(new Error('reject'), { code: 'EXCHANGE_REJECTED' }); }
    });
    await x.service.start(); await x.service.onFirstMatchingFvg(event('EQL')); await x.service.reconcile();
    assert.ok(x.actions.includes('MARKET_CLOSE')); await x.service.stop();
});

test('WS reconnect callback reconciles exchange state before resuming', async function () {
    var reconnect; var positionCalls = 0;
    var x = liveHarness('EQL');
    x.exchange.getPositionRisk = async function () { positionCalls++; return [{ positionAmt: '0' }]; };
    var service = serviceModule.createService({ symbol: 'BTCUSDT', liveTradingEnabled: true, repository: x.repo, client: x.exchange,
        getContext: function () { return context('EQL'); }, streamFactory: function (opts) {
            reconnect = opts.onReconnect; return { start: async function () {}, stop: async function () {} };
        } });
    await service.start(); var before = positionCalls; await reconnect(); assert.ok(positionCalls > before); await service.stop();
});

test('execution failure cannot suppress or mutate WATCH notifications', async function () {
    var liquidity = { id: 'EQ', symbol: 'BTCUSDT', liquidityType: 'EQL', price: 99, confirmedAt: 90,
        metadata: { primaryPartnerSelection: false, currentPivot: { id: 'P', price: 99, occurredAt: 70, confirmedAt: 80 },
            historicalPartners: [{ id: 'D', occurredAt: 60, confirmedAt: 70 }] } };
    var machine = watchModule.createStateMachine();
    var first = machine.step({ evaluationTime: 120, newEqualLiquidity: [liquidity], rawFvg: event('EQL').rawFvg });
    assert.strictEqual(first.notifications.length, 1);
    var execution = serviceModule.createService({ symbol: 'BTCUSDT', liveTradingEnabled: false,
        getContext: function () { return context('EQL', { bias: null }); } });
    await execution.onFirstMatchingFvg(first.notifications[0]);
    assert.strictEqual(machine.getAll()[0].bullFvgCount, 1); assert.strictEqual(machine.getAll()[0].status, 'OPEN');
});
