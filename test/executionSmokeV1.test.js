'use strict';

var test = require('node:test');
var assert = require('node:assert');
var EventEmitter = require('events');
var smoke = require('../scripts/execution-smoke');
var streamModule = require('../execution/userDataStreamV1');
var executionRules = require('../execution/executionRulesV1');

function exchangeInfo() {
    return { symbols: smoke.SYMBOLS.map(function (symbol) { return { symbol: symbol, status: 'TRADING', contractType: 'PERPETUAL',
        pricePrecision: 4, filters: [
            { filterType: 'PRICE_FILTER', minPrice: '0.1', maxPrice: '1000000', tickSize: '0.1' },
            { filterType: 'LOT_SIZE', minQty: '0.001', maxQty: '10000', stepSize: '0.001' },
            { filterType: 'MIN_NOTIONAL', notional: '5' }
        ] }; }) };
}
function harness(overrides) {
    var calls = [];
    var mutations = [];
    var client = {
        getUserDataApiKey: function () { return 'key'; },
        getServerTime: async function () { calls.push('getServerTime'); return { serverTime: 1000 }; },
        syncTime: async function () { calls.push('syncTime'); return 0; },
        getPositionRisk: async function () { calls.push('getPositionRisk'); return []; },
        getPositionMode: async function () { calls.push('getPositionMode'); return { dualSidePosition: false }; },
        getSymbolConfig: async function (symbol) { calls.push('getSymbolConfig'); return [{ symbol: symbol, marginType: 'CROSSED', leverage: 10 }]; },
        getExchangeInfo: async function () { calls.push('getExchangeInfo'); return exchangeInfo(); },
        getMarkPrices: async function () { calls.push('getMarkPrices'); return smoke.SYMBOLS.map(function (symbol) { return { symbol: symbol, markPrice: '100' }; }); },
        getOpenOrders: async function () { calls.push('getOpenOrders'); return []; },
        getOpenAlgoOrders: async function () { calls.push('getOpenAlgoOrders'); return []; }
    };
    ['placeOrder', 'submitEntry', 'cancelOrder', 'cancelEntry', 'placeAlgoOrder', 'submitProtection',
        'cancelAlgoOrder', 'cancelAlgo', 'changeLeverage', 'setLeverage', 'changeMarginMode',
        'setMarginType', 'changePositionMode', 'setPositionMode', 'emergencyClose'].forEach(function (name) {
        client[name] = async function () { mutations.push(name); throw new Error('MUTATION_CALLED'); };
    });
    Object.assign(client, overrides || {});
    var output = [];
    var probeFactory = function () { return { run: async function () {
        calls.push('probe'); return { authenticated: true, connected: true, keepalive: true, cleanClose: true };
    } }; };
    return { client: client, calls: calls, mutations: mutations, output: output,
        run: function (extra) { return smoke.runSmoke(Object.assign({
            env: { BINANCE_FUTURES_API_KEY: 'key', BINANCE_FUTURES_API_SECRET: 'secret', LIVE_TRADING_ENABLED: 'true' },
            client: client, probeFactory: probeFactory, write: function (line) { output.push(String(line)); }, now: function () { return 1000; }
        }, extra || {})); } };
}

test('READ_ONLY_SMOKE is hard frozen true', function () { assert.strictEqual(smoke.READ_ONLY_SMOKE, true); });

test('missing key fails without any network call', async function () {
    var calls = 0;
    var result = await smoke.runSmoke({ env: {}, client: { getServerTime: function () { calls += 1; } }, write: function () {} });
    assert.strictEqual(result.exitCode, 1); assert.strictEqual(calls, 0); assert.strictEqual(result.mutationApiCallCount, 0);
});

test('ONE_WAY passes', async function () {
    var h = harness(); var result = await h.run(); assert.strictEqual(result.summary.positionMode, 'PASS');
});

test('HEDGE fails and performs no mutation', async function () {
    var h = harness({ getPositionMode: async function () { h.calls.push('getPositionMode'); return { dualSidePosition: true }; } });
    var result = await h.run(); assert.strictEqual(result.summary.positionMode, 'FAIL'); assert.deepStrictEqual(h.mutations, []);
});

test('CROSS plus 10x passes symbol config', async function () {
    var h = harness(); var result = await h.run(); assert.strictEqual(result.summary.symbolConfig, 'PASS');
});

test('wrong leverage is NOT_READY and does not call changeLeverage', async function () {
    var h = harness({ getSymbolConfig: async function (symbol) { h.calls.push('getSymbolConfig');
        return [{ symbol: symbol, marginType: 'CROSSED', leverage: symbol === 'BTCUSDT' ? 20 : 10 }]; } });
    var result = await h.run(); assert.strictEqual(result.summary.symbolConfig, 'FAIL');
    assert.ok(h.output.some(function (line) { return line === 'WARN SYMBOL_NOT_READY'; })); assert.deepStrictEqual(h.mutations, []);
});

test('sizing preview uses production legalization logic', async function () {
    var h = harness(); var result = await h.run();
    var expected = executionRules.sizeOrder('LONG', 100, 100, 100,
        { source: 'futures', tickSize: 0.1, stepSize: 0.001, minQty: 0.001, maxQty: 10000,
            minNotional: 5, minPrice: 0.1, maxPrice: 1000000 });
    assert.strictEqual(result.details.symbols.BTCUSDT.legalizedQty, expected.requestedQty);
    assert.strictEqual(result.details.symbols.BTCUSDT.actualNotional, expected.actualNotional);
});

test('open IMC regular order warns and never cancels', async function () {
    var h = harness({ getOpenOrders: async function () { h.calls.push('getOpenOrders');
        return [{ symbol: 'BTCUSDT', clientOrderId: 'IMC_ENTRY_X', status: 'NEW' }]; } });
    var result = await h.run(); assert.strictEqual(result.details.imcRegularOrders.length, 1);
    assert.ok(h.output.includes('WARN OPEN_REGULAR_ORDER_FOUND')); assert.deepStrictEqual(h.mutations, []);
});

test('orphan IMC protective algo warns and never cleans up', async function () {
    var h = harness({ getOpenAlgoOrders: async function () { h.calls.push('getOpenAlgoOrders');
        return [{ symbol: 'BTCUSDT', clientAlgoId: 'IMC_SL_X', algoStatus: 'NEW' }]; } });
    var result = await h.run(); assert.strictEqual(result.details.imcAlgoOrders.length, 1);
    assert.ok(h.output.includes('WARN ORPHAN_PROTECTIVE_ORDER_DETECTED')); assert.deepStrictEqual(h.mutations, []);
});

test('User Data Stream connect success passes all stream gates', async function () {
    var h = harness(); var result = await h.run(); assert.strictEqual(result.summary.userDataStream, 'PASS');
    assert.ok(h.output.includes('PASS USER_DATA_STREAM_KEEPALIVE'));
});

test('reconciliation inspection invokes only three read methods', async function () {
    var names = [];
    var snapshot = await smoke.inspectExchangeState({
        getPositionRisk: async function () { names.push('positions'); return []; },
        getOpenOrders: async function () { names.push('regular'); return []; },
        getOpenAlgoOrders: async function () { names.push('algo'); return []; },
        ensureProtection: function () { names.push('protect'); }, cancelOrphan: function () { names.push('cancel'); },
        emergencyClose: function () { names.push('close'); }
    });
    assert.deepStrictEqual(names.sort(), ['algo', 'positions', 'regular']); assert.deepStrictEqual(snapshot.positions, []);
});

test('smoke never calls placeOrder', async function () { var h = harness(); await h.run(); assert.ok(!h.mutations.includes('placeOrder')); });
test('smoke never calls cancelOrder', async function () { var h = harness(); await h.run(); assert.ok(!h.mutations.includes('cancelOrder')); });
test('smoke never calls placeAlgoOrder', async function () { var h = harness(); await h.run(); assert.ok(!h.mutations.includes('placeAlgoOrder')); });
test('smoke never calls cancelAlgoOrder', async function () { var h = harness(); await h.run(); assert.ok(!h.mutations.includes('cancelAlgoOrder')); });
test('smoke never calls changeLeverage', async function () { var h = harness(); await h.run(); assert.ok(!h.mutations.includes('changeLeverage')); });
test('smoke never calls changeMarginMode', async function () { var h = harness(); await h.run(); assert.ok(!h.mutations.includes('changeMarginMode')); });
test('smoke never calls changePositionMode', async function () { var h = harness(); await h.run(); assert.ok(!h.mutations.includes('changePositionMode')); });

test('explicit mutation spy remains zero across a complete smoke run', async function () {
    var h = harness(); var result = await h.run(); assert.strictEqual(h.mutations.length, 0);
    assert.strictEqual(result.mutationApiCallCount, 0); assert.strictEqual(result.realOrdersSent, 0);
});

test('read-only User Data Stream probe performs start, ping, stop and clean data close', async function () {
    var controls = [];
    function FakeWebSocket(url) {
        EventEmitter.call(this); this.url = url; this.readyState = 1;
        var self = this; setImmediate(function () { self.emit('open'); });
    }
    FakeWebSocket.prototype = Object.create(EventEmitter.prototype);
    FakeWebSocket.prototype.constructor = FakeWebSocket;
    FakeWebSocket.prototype.send = function (raw) {
        var request = JSON.parse(raw); controls.push(request.method); var self = this;
        setImmediate(function () { self.emit('message', JSON.stringify({ id: request.id, status: 200,
            result: request.method === 'userDataStream.start' ? { listenKey: 'test-listen-key' } : {} })); });
    };
    FakeWebSocket.prototype.close = function () { var self = this; setImmediate(function () { self.emit('close'); }); };
    var probe = streamModule.createReadOnlyProbe({ client: { getUserDataApiKey: function () { return 'key'; } },
        WebSocket: FakeWebSocket, timeoutMs: 100, observeMs: 1 });
    var result = await probe.run();
    assert.deepStrictEqual(controls, ['userDataStream.start', 'userDataStream.ping', 'userDataStream.stop']);
    assert.deepStrictEqual(result, { authenticated: true, connected: true, keepalive: true, cleanClose: true, eventCount: 0 });
});
