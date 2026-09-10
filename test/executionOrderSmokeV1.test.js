'use strict';

var test = require('node:test');
var assert = require('node:assert');
var smokeModule = require('../scripts/execution-order-smoke');

function exchangeInfo() {
    return { symbols: [{ symbol: 'PROMUSDT', status: 'TRADING', contractType: 'PERPETUAL', filters: [
        { filterType: 'PRICE_FILTER', minPrice: '0.001', maxPrice: '10000', tickSize: '0.001' },
        { filterType: 'LOT_SIZE', minQty: '0.1', maxQty: '100000', stepSize: '0.1' },
        { filterType: 'MIN_NOTIONAL', notional: '5' }
    ] }] };
}
function harness(options) {
    var opts = options || {}; var calls = []; var forbidden = []; var onEvent = null;
    var state = { status: 'NONE', executedQty: 0, positionQty: Number(opts.positionQty || 0), order: null };
    var openOrdersCalls = 0;
    var client = {
        getUserDataApiKey: function () { return 'key'; },
        syncTime: async function () { calls.push('GET_TIME'); },
        getPositionMode: async function () { calls.push('GET_MODE'); return { dualSidePosition: opts.hedge === true }; },
        getSymbolConfig: async function () { calls.push('GET_CONFIG'); return [{ symbol: 'PROMUSDT',
            marginType: opts.marginType || 'CROSSED', leverage: opts.leverage === undefined ? 10 : opts.leverage }]; },
        getPositionRisk: async function () { calls.push('GET_POSITION');
            return [{ symbol: 'PROMUSDT', positionAmt: String(state.positionQty) }]; },
        getOpenOrders: async function () { calls.push('GET_ORDERS');
            openOrdersCalls += 1;
            if (openOrdersCalls === 1 && opts.existingOrder) return [{ symbol: 'PROMUSDT', clientOrderId: 'OTHER', status: 'NEW' }];
            return ['NEW', 'PARTIALLY_FILLED'].indexOf(state.status) >= 0 && state.order ? [Object.assign({}, state.order, {
                status: state.status, executedQty: String(state.executedQty) })] : []; },
        getOpenAlgoOrders: async function () { calls.push('GET_ALGOS'); return opts.existingAlgo ? [{ symbol: 'PROMUSDT', clientAlgoId: 'OTHER' }] : []; },
        getExchangeInfo: async function () { calls.push('GET_INFO'); return exchangeInfo(); },
        getMarkPrices: async function () { calls.push('GET_MARK'); return [{ symbol: 'PROMUSDT', markPrice: String(opts.markPrice || 5.687) }]; },
        getBookTicker: async function () { calls.push('GET_BOOK'); return { symbol: 'PROMUSDT', bidPrice: String(opts.bestBid || 5.68) }; },
        submitSmokeLimit: async function (order) {
            calls.push('PLACE'); state.order = { symbol: order.symbol, clientOrderId: order.newClientOrderId,
                orderId: 101, side: order.side, type: order.type, timeInForce: order.timeInForce, origQty: String(order.quantity) };
            state.status = opts.placeStatus || 'NEW';
            if (onEvent && opts.wsEvent !== false) onEvent({ e: 'ORDER_TRADE_UPDATE', o: { c: order.newClientOrderId, X: 'NEW' } });
            if (opts.placeUnknown) throw Object.assign(new Error('unknown'), { code: 'ORDER_STATE_UNKNOWN' });
            return Object.assign({}, state.order, { status: state.status, executedQty: '0' });
        },
        queryOrder: async function () {
            calls.push('QUERY_ORDER');
            if (opts.queryThrowsOnce && calls.filter(function (x) { return x === 'QUERY_ORDER'; }).length === 1) {
                throw new Error('query unavailable');
            }
            if (opts.beforeCancelFill && calls.filter(function (x) { return x === 'QUERY_ORDER'; }).length === 1) {
                state.status = 'PARTIALLY_FILLED'; state.executedQty = 0.1; state.positionQty = 0.1;
            }
            return Object.assign({}, state.order, { status: state.status, executedQty: String(state.executedQty) });
        },
        cancelSmokeOrder: async function () {
            calls.push('CANCEL');
            if (opts.cancelRaceFill) { state.status = 'FILLED'; state.executedQty = 3.6; state.positionQty = 3.6; }
            else state.status = 'CANCELED';
            if (opts.cancelThrows) throw Object.assign(new Error('cancel timeout'), { code: 'ETIMEDOUT' });
            return Object.assign({}, state.order, { status: state.status });
        },
        emergencyClose: async function () { calls.push('EMERGENCY_CLOSE'); state.positionQty = 0; return { status: 'NEW' }; }
    };
    ['submitEntry', 'submitProtection', 'cancelAlgo', 'setLeverage', 'setMarginType', 'setPositionMode'].forEach(function (name) {
        client[name] = function () { forbidden.push(name); throw new Error('FORBIDDEN'); };
    });
    var sessionFactory = function (sessionOptions) { onEvent = sessionOptions.onEvent; return {
        start: async function () { calls.push('WS_START'); }, ping: async function () { calls.push('WS_PING'); },
        stop: async function () { calls.push('WS_STOP'); }
    }; };
    var output = [];
    return { client: client, calls: calls, forbidden: forbidden, state: state, output: output,
        run: function (env) { openOrdersCalls = 0; return smokeModule.runOrderSmoke({ client: client, sessionFactory: sessionFactory,
            waitForWs: async function () {}, now: 1788959693353,
            env: Object.assign({ BINANCE_FUTURES_API_KEY: 'key', BINANCE_FUTURES_API_SECRET: 'secret',
                EXECUTION_ORDER_SMOKE_ENABLED: 'true', EXECUTION_ORDER_SMOKE_SYMBOL: 'PROMUSDT',
                LIVE_TRADING_ENABLED: 'false' }, env || {}), write: function (line) { output.push(String(line)); } }); } };
}

test('smoke flag false produces complete dry-run and zero mutation', async function () {
    var h = harness(); var result = await h.run({ EXECUTION_ORDER_SMOKE_ENABLED: 'false' });
    assert.strictEqual(result.final, 'DRY_RUN'); assert.strictEqual(result.mutations.total, 0);
    assert.ok(result.details.plan.quantity > 0); assert.ok(result.details.plan.limitPrice < result.details.plan.bestBid);
});
test('wrong position mode blocks every mutation', async function () { var h = harness({ hedge: true }); var r = await h.run(); assert.strictEqual(r.reason, 'POSITION_MODE_NOT_ONE_WAY'); assert.strictEqual(r.mutations.total, 0); });
test('leverage other than 10 blocks every mutation', async function () { var h = harness({ leverage: 20 }); var r = await h.run(); assert.strictEqual(r.reason, 'LEVERAGE_NOT_10'); assert.strictEqual(r.mutations.total, 0); });
test('margin other than CROSSED blocks every mutation', async function () { var h = harness({ marginType: 'ISOLATED' }); var r = await h.run(); assert.strictEqual(r.reason, 'SYMBOL_NOT_CROSSED'); assert.strictEqual(r.mutations.total, 0); });
test('existing position blocks every mutation', async function () { var h = harness({ positionQty: 1 }); var r = await h.run(); assert.strictEqual(r.reason, 'EXISTING_POSITION'); assert.strictEqual(r.mutations.total, 0); });
test('existing regular order blocks every mutation', async function () { var h = harness({ existingOrder: true }); var r = await h.run(); assert.strictEqual(r.reason, 'EXISTING_REGULAR_ORDER'); assert.strictEqual(r.mutations.total, 0); });
test('existing algo order blocks every mutation', async function () { var h = harness({ existingAlgo: true }); var r = await h.run(); assert.strictEqual(r.reason, 'EXISTING_ALGO_ORDER'); assert.strictEqual(r.mutations.total, 0); });
test('marketable or too-close limit price aborts', async function () { var h = harness({ bestBid: 5.0 }); var r = await h.run(); assert.strictEqual(r.reason, 'UNSAFE_LIMIT_PRICE'); assert.strictEqual(r.mutations.total, 0); });

test('only BUY LIMIT GTC is placed', async function () {
    var h = harness(); var r = await h.run(); assert.strictEqual(r.final, 'PASS');
    assert.strictEqual(h.state.order.side, 'BUY'); assert.strictEqual(h.state.order.type, 'LIMIT'); assert.strictEqual(h.state.order.timeInForce, 'GTC');
});
test('clientOrderId has isolated IMC_SMOKE prefix and valid length', async function () {
    var h = harness(); var r = await h.run(); assert.match(r.details.clientOrderId, /^IMC_SMOKE_/); assert.ok(r.details.clientOrderId.length <= 36);
});
test('successful POST makes exactly one place mutation', async function () { var h = harness(); var r = await h.run(); assert.strictEqual(r.mutations.counts.place, 1); assert.strictEqual(h.calls.filter(function (x) { return x === 'PLACE'; }).length, 1); });
test('POST unknown plus open-order recovery never re-POSTs', async function () { var h = harness({ placeUnknown: true }); var r = await h.run(); assert.strictEqual(r.final, 'PASS'); assert.strictEqual(h.calls.filter(function (x) { return x === 'PLACE'; }).length, 1); });
test('post-place verification error locates and cancels the smoke order', async function () {
    var h = harness({ queryThrowsOnce: true }); var r = await h.run(); assert.strictEqual(r.final, 'FAIL');
    assert.strictEqual(h.calls.filter(function (x) { return x === 'PLACE'; }).length, 1);
    assert.strictEqual(h.calls.filter(function (x) { return x === 'CANCEL'; }).length, 1);
});
test('REST NEW with zero execution allows cancel', async function () { var h = harness(); var r = await h.run(); assert.strictEqual(r.details.restNew, true); assert.strictEqual(r.mutations.counts.cancel, 1); });

test('partial fill before cancel fails and invokes existing emergency safety path', async function () {
    var h = harness({ beforeCancelFill: true }); var r = await h.run(); assert.strictEqual(r.reason, 'UNEXPECTED_SMOKE_FILL_BEFORE_CANCEL');
    assert.strictEqual(r.mutations.counts.positionClose, 1); assert.ok(h.calls.includes('EMERGENCY_CLOSE'));
});
test('cancel must be confirmed by REST as CANCELED', async function () { var h = harness(); var r = await h.run(); assert.strictEqual(r.details.finalOrderStatus, 'CANCELED'); });
test('cancel timeout uses read-back and does not send a second cancel', async function () {
    var h = harness({ cancelThrows: true }); var r = await h.run(); assert.strictEqual(r.final, 'PASS');
    assert.strictEqual(h.calls.filter(function (x) { return x === 'CANCEL'; }).length, 1);
});
test('cancel/fill race is not marked canceled and invokes safety path', async function () {
    var h = harness({ cancelRaceFill: true }); var r = await h.run(); assert.strictEqual(r.reason, 'UNEXPECTED_SMOKE_FILL_CANCEL_RACE');
    assert.strictEqual(r.mutations.counts.positionClose, 1); assert.notStrictEqual(r.final, 'PASS');
});
test('successful final position is zero', async function () { var h = harness(); var r = await h.run(); assert.strictEqual(r.details.finalPositionQty, 0); });
test('successful final smoke open order count is zero', async function () { var h = harness(); var r = await h.run(); assert.strictEqual(r.details.smokeOpenOrders, 0); });
test('algo mutation and smoke algo count are zero', async function () { var h = harness(); var r = await h.run(); assert.strictEqual(r.mutations.counts.algo, 0); assert.strictEqual(r.details.smokeAlgoOrders, 0); });
test('production EQ consumption remains untouched', async function () { var h = harness(); var r = await h.run(); assert.strictEqual(r.details.eqConsumptionTouched, false); });
test('production symbol slot remains FREE', async function () { var h = harness(); var r = await h.run(); assert.strictEqual(r.details.productionSlot, 'FREE'); });
test('normal success has exactly two mutations', async function () { var h = harness(); var r = await h.run(); assert.strictEqual(r.mutations.total, 2); assert.deepStrictEqual(r.mutations.records.map(function (x) { return x.method; }), ['POST', 'DELETE']); });
test('no leverage margin position-mode or algo mutation method is called', async function () { var h = harness(); var r = await h.run(); assert.deepStrictEqual(h.forbidden, []); assert.strictEqual(r.mutations.counts.leverage + r.mutations.counts.marginMode + r.mutations.counts.positionMode + r.mutations.counts.algo, 0); });

test('mutation guard rejects non-BUY LIMIT orders', function () {
    var guard = smokeModule.createMutationGuard({ submitSmokeLimit: function () {} }, 'PROMUSDT', 'IMC_SMOKE_PROM_X');
    assert.throws(function () { guard.place({ symbol: 'PROMUSDT', newClientOrderId: 'IMC_SMOKE_PROM_X', side: 'SELL', type: 'LIMIT', timeInForce: 'GTC' }); }, /MUTATION_GUARD_BLOCKED/);
});
test('symbol outside whitelist aborts before network or mutation', async function () {
    var h = harness(); var r = await h.run({ EXECUTION_ORDER_SMOKE_SYMBOL: 'XRPUSDT' });
    assert.strictEqual(r.exitCode, 3); assert.strictEqual(h.calls.length, 0); assert.strictEqual(r.mutations.total, 0);
});
