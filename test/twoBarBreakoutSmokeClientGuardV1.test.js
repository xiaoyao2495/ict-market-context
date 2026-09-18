'use strict';

// TWO_BAR_BREAKOUT_REAL_ORDER_SMOKE_V1 (§18/§25): the local real-order smoke needs
// its own clientAlgoId namespace, and the production id must stay byte-identical.
// These guards live in the shared execution client, so they are covered here.

var test = require('node:test');
var assert = require('node:assert');
var clientModule = require('../execution/binanceExecutionClientV1');

function recordingClient() {
    var calls = [];
    return {
        calls: calls,
        client: clientModule.createClient({
            apiKey: 'key', secret: 'secret', liveTradingEnabled: true,
            transport: {
                request: function (config) {
                    calls.push({ method: config.method, url: config.url, params: config.params,
                        headers: config.headers });
                    return Promise.resolve({ data: { algoId: 7, clientAlgoId: 'x', algoStatus: 'NEW' } });
                }
            }
        })
    };
}

var PLAN = { symbol: 'BTCUSDT', direction: 'LONG', tradeId: 'T', setupId: 'S',
    entryTrigger: 100.9, entryWorkingType: 'CONTRACT_PRICE', requestedQty: 0.267 };
var PROTECTION_PLAN = { symbol: 'BTCUSDT', direction: 'LONG', tradeId: 'T',
    stopPrice: 98.6, targetPrice: 106 };

function algoIdOf(url) {
    return decodeURIComponent(String(url).split('clientAlgoId=')[1].split('&')[0]);
}

/** The client signs its params into the request URL, not into config.params. */
function queryOf(url) {
    var out = {};
    String(url).split('?')[1].split('&').forEach(function (pair) {
        var parts = pair.split('=');
        out[parts[0]] = decodeURIComponent(parts[1]);
    });
    return out;
}

test('production placeBreakoutEntry keeps its deterministic IMC_<symbol>_ENTRY_ id', async function () {
    var run = recordingClient();
    await run.client.placeBreakoutEntry(PLAN);
    assert.equal(run.calls.length, 1);
    assert.equal(run.calls[0].method, 'POST');
    var query = queryOf(run.calls[0].url);
    assert.ok(/^IMC_BTCUSDT_ENTRY_[0-9a-f]{12}$/.test(query.clientAlgoId), query.clientAlgoId);
    assert.equal(query.type, 'STOP_MARKET');
    assert.equal(query.workingType, 'CONTRACT_PRICE');
    assert.equal(query.reduceOnly, undefined);
    assert.equal(query.closePosition, undefined);
});

test('the smoke id override accepts only the IMC_SMOKE_ namespace', async function () {
    var run = recordingClient();
    await run.client.placeBreakoutEntry(PLAN, 'IMC_SMOKE_BTCUSDT_ENTRY_1');
    assert.equal(queryOf(run.calls[0].url).clientAlgoId, 'IMC_SMOKE_BTCUSDT_ENTRY_1');
    for (var bad of ['IMC_BTCUSDT_ENTRY_abcdef012345', 'SMOKE_BTCUSDT_1', 'IMC_SMOKE_',
        'IMC_SMOKE_BTCUSDT_ENTRY_1_2_3_4_5_6_7_8_9_0_1_2']) {
        await assert.rejects(run.client.placeBreakoutEntry(PLAN, bad), function (error) {
            assert.equal(error.code, 'MUTATION_GUARD_BLOCKED');
            return true;
        });
    }
    assert.equal(run.calls.length, 1, 'a refused id must never reach the transport');
});

test('cancelSmokeAlgo refuses anything outside the smoke namespace', async function () {
    var run = recordingClient();
    for (var bad of ['IMC_BTCUSDT_ENTRY_abcdef012345', 'IMC_BTCUSDT_SL_abcdef012345',
        'IMC_SMOKE2_PROM_A_SL', '']) {
        await assert.rejects(run.client.cancelSmokeAlgo('BTCUSDT', bad), function (error) {
            assert.equal(error.code, 'MUTATION_GUARD_BLOCKED');
            return true;
        });
    }
    assert.equal(run.calls.length, 0, 'a refused cancel must never reach the transport');
    await run.client.cancelSmokeAlgo('BTCUSDT', 'IMC_SMOKE_BTCUSDT_ENTRY_1');
    assert.equal(run.calls[0].method, 'DELETE');
    assert.equal(algoIdOf(run.calls[0].url), 'IMC_SMOKE_BTCUSDT_ENTRY_1');
});

test('the smoke namespace predicate is exact', function () {
    assert.equal(clientModule.isSmokeClientAlgoId('IMC_SMOKE_BTCUSDT_ENTRY_1'), true);
    assert.equal(clientModule.isSmokeClientAlgoId('IMC_SMOKE_BTCUSDT_ENTRY_' + '9'.repeat(25)), false);
    assert.equal(clientModule.isSmokeClientAlgoId('IMC_BTCUSDT_ENTRY_abcdef012345'), false);
    assert.equal(clientModule.isSmokeClientAlgoId(null), false);
    assert.equal(clientModule.isSmokeClientAlgoId(undefined), false);
    assert.equal(clientModule.isSmokeClientAlgoId('IMC_SMOKE_'), false);
});

test('live=false still blocks the smoke override before any transport call', async function () {
    var calls = 0;
    var client = clientModule.createClient({ apiKey: 'key', secret: 'secret', liveTradingEnabled: false,
        transport: { request: function () { calls += 1; return Promise.resolve({ data: {} }); } } });
    await assert.rejects(client.placeBreakoutEntry(PLAN, 'IMC_SMOKE_BTCUSDT_ENTRY_1'), function (error) {
        assert.equal(error.code, 'LIVE_TRADING_DISABLED');
        return true;
    });
    assert.equal(calls, 0);
});

test('production submitProtection keeps its deterministic IMC_<symbol>_<role>_ id', async function () {
    var run = recordingClient();
    await run.client.submitProtection(PROTECTION_PLAN, 'SL');
    var sl = queryOf(run.calls[0].url);
    assert.ok(/^IMC_BTCUSDT_SL_[0-9a-f]{12}$/.test(sl.clientAlgoId), sl.clientAlgoId);
    assert.equal(sl.type, 'STOP_MARKET');
    assert.equal(sl.workingType, 'MARK_PRICE');
    assert.equal(sl.closePosition, 'true');
    assert.equal(sl.triggerPrice, '98.6');
    // the wire field name is a frozen contract: Binance expects workingType, never "workingPrice"
    assert.deepStrictEqual(Object.keys(clientModule.buildProtectionParams(PROTECTION_PLAN, 'SL')).sort(),
        ['algoType', 'clientAlgoId', 'closePosition', 'positionSide', 'side', 'symbol',
            'triggerPrice', 'type', 'workingType']);
    assert.strictEqual(Object.keys(sl).some(function (key) { return /^workingP/.test(key); }), false,
        'no workingPrice field may ever be sent');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(sl, 'workingType'), true);
    await run.client.submitProtection(PROTECTION_PLAN, 'TP');
    var tp = queryOf(run.calls[1].url);
    assert.ok(/^IMC_BTCUSDT_TP_[0-9a-f]{12}$/.test(tp.clientAlgoId), tp.clientAlgoId);
    assert.equal(tp.type, 'TAKE_PROFIT_MARKET');
    assert.equal(tp.workingType, 'MARK_PRICE');
    assert.equal(tp.closePosition, 'true');
});

test('the protection smoke id override accepts only IMC_SMOKE_ and never touches production ids',
    async function () {
        var run = recordingClient();
        await run.client.submitProtection(PROTECTION_PLAN, 'SL', 'IMC_SMOKE_BTCUSDT_V2_SL_abc123');
        assert.equal(queryOf(run.calls[0].url).clientAlgoId, 'IMC_SMOKE_BTCUSDT_V2_SL_abc123');
        await run.client.submitProtection(PROTECTION_PLAN, 'TP', 'IMC_SMOKE_BTCUSDT_V2_TP_abc123');
        assert.equal(queryOf(run.calls[1].url).clientAlgoId, 'IMC_SMOKE_BTCUSDT_V2_TP_abc123');
        for (var bad of ['IMC_BTCUSDT_SL_abcdef012345', 'IMC_SMOKE2_PROM_A_SL', 'IMC_SMOKE_']) {
            await assert.rejects(run.client.submitProtection(PROTECTION_PLAN, 'SL', bad), function (error) {
                assert.equal(error.code, 'MUTATION_GUARD_BLOCKED');
                return true;
            });
        }
        assert.equal(run.calls.length, 2, 'a refused id must never reach the transport');
    });

test('emergencyClose keeps MARKET reduceOnly and accepts only a smoke id when overridden',
    async function () {
        var run = recordingClient();
        await run.client.emergencyClose('BTCUSDT', 'LONG', 0.002, 'BB_TRADE_1');
        var close = queryOf(run.calls[0].url);
        assert.ok(/^IMC_BTCUSDT_CLOSE_[0-9a-f]{12}$/.test(close.newClientOrderId),
            close.newClientOrderId);
        assert.equal(close.type, 'MARKET');
        assert.equal(close.side, 'SELL');
        assert.equal(close.reduceOnly, 'true');
        await run.client.emergencyClose('BTCUSDT', 'LONG', 0.002, 'BB_TRADE_1',
            'IMC_SMOKE_BTCUSDT_V2_CLOSE_abc123');
        assert.equal(queryOf(run.calls[1].url).newClientOrderId, 'IMC_SMOKE_BTCUSDT_V2_CLOSE_abc123');
        await assert.rejects(run.client.emergencyClose('BTCUSDT', 'LONG', 0.002, 'BB_TRADE_1',
            'IMC_BTCUSDT_CLOSE_abcdef012345'), function (error) {
            assert.equal(error.code, 'MUTATION_GUARD_BLOCKED');
            return true;
        });
        assert.equal(run.calls.length, 2);
    });
