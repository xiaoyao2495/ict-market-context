'use strict';

var test = require('node:test');
var assert = require('node:assert');
var initModule = require('../scripts/execution-account-init');

function harness(options) {
    var opts = options || {};
    var calls = [];
    var forbidden = [];
    var current = {};
    initModule.TARGET_SYMBOLS.forEach(function (symbol) {
        current[symbol] = { symbol: symbol, marginType: 'CROSSED', leverage: opts.leverages && opts.leverages[symbol] !== undefined
            ? opts.leverages[symbol] : 10 };
    });
    var client = {
        syncTime: async function () { calls.push({ method: 'GET', endpoint: '/fapi/v1/time' }); },
        getPositionRisk: async function () { calls.push({ method: 'GET', endpoint: '/fapi/v3/positionRisk' }); return opts.positions || []; },
        getOpenOrders: async function () { calls.push({ method: 'GET', endpoint: '/fapi/v1/openOrders' }); return opts.orders || []; },
        getOpenAlgoOrders: async function () { calls.push({ method: 'GET', endpoint: '/fapi/v1/openAlgoOrders' }); return opts.algos || []; },
        getPositionMode: async function () { calls.push({ method: 'GET', endpoint: '/fapi/v1/positionSide/dual' });
            return { dualSidePosition: opts.hedge === true }; },
        getSymbolConfig: async function (symbol) { calls.push({ method: 'GET', endpoint: '/fapi/v1/symbolConfig', symbol: symbol });
            if (opts.missingConfig === symbol) return [];
            var item = Object.assign({}, current[symbol]);
            if (opts.marginTypes && opts.marginTypes[symbol]) item.marginType = opts.marginTypes[symbol];
            return [item]; },
        setLeverage: async function (symbol, leverage) {
            calls.push({ method: 'POST', endpoint: '/fapi/v1/leverage', symbol: symbol, leverage: leverage });
            if (opts.postBehavior) return opts.postBehavior(symbol, leverage, current);
            current[symbol].leverage = leverage; return { symbol: symbol, leverage: leverage };
        }
    };
    ['placeOrder', 'submitEntry', 'cancelOrder', 'cancelEntry', 'placeAlgoOrder', 'submitProtection',
        'cancelAlgoOrder', 'cancelAlgo', 'changeMarginMode', 'setMarginType', 'changePositionMode',
        'setPositionMode', 'emergencyClose'].forEach(function (name) {
        client[name] = function () { forbidden.push(name); throw new Error('FORBIDDEN_MUTATION'); };
    });
    var output = [];
    return { calls: calls, forbidden: forbidden, current: current, output: output,
        run: function (env) { return initModule.runAccountInit({ client: client,
            env: Object.assign({ BINANCE_FUTURES_API_KEY: 'key', BINANCE_FUTURES_API_SECRET: 'secret',
                EXECUTION_ACCOUNT_INIT_ENABLED: 'true', LIVE_TRADING_ENABLED: 'false' }, env || {}),
            write: function (line) { output.push(String(line)); } }); } };
}

function posts(h) { return h.calls.filter(function (call) { return call.method === 'POST'; }); }

test('missing credentials aborts before reads or mutation', async function () {
    var h = harness(); var result = await h.run({ BINANCE_FUTURES_API_KEY: '', BINANCE_FUTURES_API_SECRET: '' });
    assert.strictEqual(result.exitCode, 1); assert.strictEqual(h.calls.length, 0); assert.strictEqual(result.mutatingApiCallCount, 0);
});

test('init flag false is dry-run only with no mutation', async function () {
    var h = harness({ leverages: { BTCUSDT: 125 } }); var result = await h.run({ EXECUTION_ACCOUNT_INIT_ENABLED: 'false' });
    assert.strictEqual(posts(h).length, 0); assert.strictEqual(result.details.BTCUSDT.result, 'DRY_RUN_WOULD_SET_LEVERAGE_10');
});

test('HEDGE position mode aborts with no mutation', async function () {
    var h = harness({ hedge: true, leverages: { BTCUSDT: 125 } }); var result = await h.run();
    assert.strictEqual(result.final, 'NOT_READY'); assert.strictEqual(posts(h).length, 0);
    assert.ok(h.output.includes('REASON=POSITION_MODE_NOT_ONE_WAY'));
});

test('nonzero position skips only unsafe symbol', async function () {
    var h = harness({ positions: [{ symbol: 'ETHUSDT', positionAmt: '0.2' }], leverages: { ETHUSDT: 125, BTCUSDT: 125 } });
    var result = await h.run(); assert.strictEqual(result.details.ETHUSDT.result, 'SKIP_UNSAFE_TO_CHANGE_LEVERAGE');
    assert.strictEqual(posts(h).some(function (x) { return x.symbol === 'ETHUSDT'; }), false);
    assert.strictEqual(posts(h).some(function (x) { return x.symbol === 'BTCUSDT'; }), true);
});

test('regular order skips symbol leverage mutation', async function () {
    var h = harness({ orders: [{ symbol: 'BNBUSDT', status: 'NEW' }], leverages: { BNBUSDT: 20 } });
    var result = await h.run(); assert.strictEqual(result.details.BNBUSDT.result, 'SKIP_UNSAFE_TO_CHANGE_LEVERAGE');
    assert.strictEqual(posts(h).some(function (x) { return x.symbol === 'BNBUSDT'; }), false);
});

test('algo order skips symbol leverage mutation', async function () {
    var h = harness({ algos: [{ symbol: 'ZECUSDT', algoStatus: 'NEW' }], leverages: { ZECUSDT: 20 } });
    var result = await h.run(); assert.strictEqual(result.details.ZECUSDT.result, 'SKIP_UNSAFE_TO_CHANGE_LEVERAGE');
    assert.strictEqual(posts(h).some(function (x) { return x.symbol === 'ZECUSDT'; }), false);
});

test('non-CROSSED symbol fails without margin or leverage mutation', async function () {
    var h = harness({ marginTypes: { PROMUSDT: 'ISOLATED' }, leverages: { PROMUSDT: 20 } });
    var result = await h.run(); assert.strictEqual(result.details.PROMUSDT.result, 'FAIL_SYMBOL_NOT_CROSSED');
    assert.strictEqual(posts(h).some(function (x) { return x.symbol === 'PROMUSDT'; }), false); assert.deepStrictEqual(h.forbidden, []);
});

test('already configured 10x performs no mutation', async function () {
    var h = harness(); var result = await h.run(); assert.strictEqual(result.final, 'READY');
    assert.strictEqual(result.mutatingApiCallCount, 0); assert.strictEqual(posts(h).length, 0);
});

test('safe non-10x symbol performs exactly one leverage POST', async function () {
    var h = harness({ leverages: { ETHUSDT: 125 } }); var result = await h.run();
    var changes = posts(h).filter(function (x) { return x.symbol === 'ETHUSDT'; });
    assert.strictEqual(changes.length, 1); assert.strictEqual(changes[0].leverage, 10);
    assert.strictEqual(result.details.ETHUSDT.result, 'PASS');
});

test('successful POST requires read-back 10 before PASS', async function () {
    var h = harness({ leverages: { BTCUSDT: 125 } }); var result = await h.run();
    var reads = h.calls.filter(function (x) { return x.endpoint === '/fapi/v1/symbolConfig' && x.symbol === 'BTCUSDT'; });
    assert.strictEqual(reads.length, 2); assert.strictEqual(result.details.BTCUSDT.leverageAfter, 10);
});

test('successful POST with non-10 read-back fails verification', async function () {
    var h = harness({ leverages: { BTCUSDT: 125 }, postBehavior: async function () {
        return { symbol: 'BTCUSDT', leverage: 10 };
    } });
    var result = await h.run(); assert.strictEqual(result.details.BTCUSDT.result, 'FAIL_LEVERAGE_VERIFY_FAILED');
    assert.strictEqual(posts(h).filter(function (x) { return x.symbol === 'BTCUSDT'; }).length, 1);
});

test('POST timeout with read-back 10 passes as verified', async function () {
    var h = harness({ leverages: { BTCUSDT: 125 }, postBehavior: async function (symbol, leverage, current) {
        current[symbol].leverage = leverage; var error = new Error('timeout'); error.code = 'ETIMEDOUT'; throw error;
    } });
    var result = await h.run(); assert.strictEqual(result.details.BTCUSDT.result, 'PASS_POST_RESULT_UNKNOWN_BUT_VERIFIED');
    assert.strictEqual(posts(h).filter(function (x) { return x.symbol === 'BTCUSDT'; }).length, 1);
});

test('POST timeout with read-back not 10 fails without blind retry', async function () {
    var h = harness({ leverages: { BTCUSDT: 125 }, postBehavior: async function () {
        var error = new Error('timeout'); error.code = 'ETIMEDOUT'; throw error;
    } });
    var result = await h.run(); assert.strictEqual(result.details.BTCUSDT.result, 'FAIL_LEVERAGE_CHANGE_STATE_UNKNOWN');
    assert.strictEqual(posts(h).filter(function (x) { return x.symbol === 'BTCUSDT'; }).length, 1);
});

test('mutation endpoint outside allowlist is blocked', async function () {
    var guard = initModule.createMutationGuard({ setLeverage: function () {} });
    assert.throws(function () { guard.mutate({ method: 'POST', endpoint: '/fapi/v1/order', symbol: 'BTCUSDT', leverage: 10 }); },
        function (error) { return error.code === 'MUTATION_GUARD_BLOCKED'; }); assert.strictEqual(guard.getCount(), 0);
});

test('leverage other than 10 is blocked', function () {
    var guard = initModule.createMutationGuard({ setLeverage: function () {} });
    assert.throws(function () { guard.mutate({ method: 'POST', endpoint: '/fapi/v1/leverage', symbol: 'BTCUSDT', leverage: 20 }); },
        /MUTATION_GUARD_BLOCKED/); assert.strictEqual(guard.getCount(), 0);
});

test('symbol outside allowlist is blocked', function () {
    var guard = initModule.createMutationGuard({ setLeverage: function () {} });
    assert.throws(function () { guard.mutate({ method: 'POST', endpoint: '/fapi/v1/leverage', symbol: 'XRPUSDT', leverage: 10 }); },
        /MUTATION_GUARD_BLOCKED/); assert.strictEqual(guard.getCount(), 0);
});

test('all five changes never exceed five leverage mutations', async function () {
    var h = harness({ leverages: { ETHUSDT: 125, BNBUSDT: 20, ZECUSDT: 20, PROMUSDT: 20, BTCUSDT: 125 } });
    var result = await h.run(); assert.strictEqual(result.mutatingApiCallCount, 5); assert.strictEqual(posts(h).length, 5);
    assert.ok(posts(h).every(function (x) { return x.endpoint === '/fapi/v1/leverage' && x.leverage === 10; }));
});

test('duplicate mutation for one symbol is guard-blocked', async function () {
    var guard = initModule.createMutationGuard({ setLeverage: async function () {} });
    await guard.mutate({ method: 'POST', endpoint: '/fapi/v1/leverage', symbol: 'BTCUSDT', leverage: 10 });
    assert.throws(function () { guard.mutate({ method: 'POST', endpoint: '/fapi/v1/leverage', symbol: 'BTCUSDT', leverage: 10 }); },
        /MUTATION_GUARD_BLOCKED/); assert.strictEqual(guard.getCount(), 1);
});

test('account init never calls any forbidden mutation family', async function () {
    var h = harness({ leverages: { ETHUSDT: 125, BTCUSDT: 125 } }); var result = await h.run();
    assert.deepStrictEqual(h.forbidden, []); assert.strictEqual(result.orderMutations, 0);
    assert.strictEqual(result.positionMutations, 0); assert.strictEqual(result.marginModeMutations, 0);
    assert.strictEqual(result.positionModeMutations, 0);
});

test('missing symbol config fails closed without mutation', async function () {
    var h = harness({ missingConfig: 'PROMUSDT', leverages: { PROMUSDT: 20 } }); var result = await h.run();
    assert.strictEqual(result.details.PROMUSDT.result, 'FAIL_SYMBOL_CONFIG_UNAVAILABLE');
    assert.strictEqual(posts(h).some(function (x) { return x.symbol === 'PROMUSDT'; }), false);
});
