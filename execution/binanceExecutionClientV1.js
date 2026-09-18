'use strict';

var crypto = require('crypto');
var network = require('../config/network');
var binanceHttp = require('../data/binanceHttpTransportV1');

function queryString(params) {
    return Object.keys(params).filter(function (key) { return params[key] !== undefined && params[key] !== null; })
        .sort().map(function (key) { return encodeURIComponent(key) + '=' + encodeURIComponent(String(params[key])); }).join('&');
}
function proxyConfig() {
    return network.proxy && network.proxy.enabled ? { proxy: { host: network.proxy.host, port: network.proxy.port } } : {};
}
function clientId(symbol, tradeId, role) {
    var digest = crypto.createHash('sha256').update(String(tradeId)).digest('hex').slice(0, 12);
    return ('IMC_' + String(symbol).slice(0, 10) + '_' + role + '_' + digest).slice(0, 36);
}
function buildEntryParams(plan) {
    return { symbol: plan.symbol, side: plan.direction === 'LONG' ? 'BUY' : 'SELL', positionSide: 'BOTH',
        type: 'LIMIT', timeInForce: 'GTC', quantity: plan.requestedQty, price: plan.entryPrice,
        newClientOrderId: clientId(plan.symbol, plan.tradeId, 'ENTRY'), newOrderRespType: 'ACK' };
}
function buildProtectionParams(plan, role) {
    return { algoType: 'CONDITIONAL', symbol: plan.symbol,
        side: plan.direction === 'LONG' ? 'SELL' : 'BUY', positionSide: 'BOTH',
        type: role === 'SL' ? 'STOP_MARKET' : 'TAKE_PROFIT_MARKET',
        triggerPrice: role === 'SL' ? plan.stopPrice : plan.targetPrice,
        workingType: 'MARK_PRICE', closePosition: 'true',
        clientAlgoId: clientId(plan.symbol, plan.tradeId, role) };
}

/**
 * TWO_BAR_PRODUCTION_REPLACEMENT_V1 §7: breakout opening entry.
 * A conditional STOP_MARKET that OPENS a position (not reduce-only, no
 * closePosition), triggered on CONTRACT_PRICE because the Two-Bar extreme comes
 * from futures trade prices. It reuses the same conditional-order channel as the
 * protective orders and the same client-id / mutation-guard plumbing.
 */
function buildBreakoutEntryParams(plan) {
    return { algoType: 'CONDITIONAL', symbol: plan.symbol,
        side: plan.direction === 'LONG' ? 'BUY' : 'SELL', positionSide: 'BOTH',
        type: 'STOP_MARKET', quantity: plan.requestedQty,
        triggerPrice: plan.entryTrigger, workingType: plan.entryWorkingType || 'CONTRACT_PRICE',
        clientAlgoId: clientId(plan.symbol, plan.setupId + ':ENTRY', 'ENTRY') };
}

/**
 * PRODUCTION BRIDGE REPLACEMENT.
 *
 * A reduceOnly protection with an EXPLICIT quantity and closePosition=false. It is the
 * only order shape that may coexist with a canonical closePosition stop/target: the
 * real exchange rejects a second same-role closePosition order with -4130, which is why
 * the old "place the new canonical first" sequence can never be used again.
 * One-way mode only (reduceOnly is not a hedge-mode concept).
 */
function buildBridgeParams(plan, role, quantity, triggerPrice) {
    return { algoType: 'CONDITIONAL', symbol: plan.symbol,
        side: plan.direction === 'LONG' ? 'SELL' : 'BUY', positionSide: 'BOTH',
        type: role === 'SL' ? 'STOP_MARKET' : 'TAKE_PROFIT_MARKET',
        quantity: quantity, triggerPrice: triggerPrice, workingType: 'MARK_PRICE',
        reduceOnly: 'true', closePosition: 'false',
        clientAlgoId: clientId(plan.symbol, plan.tradeId, role + '_BRIDGE') };
}

/**
 * TWO_BAR_BREAKOUT_REAL_ORDER_SMOKE_V1 (§18/§25): the local real-order smoke must
 * live in its own clientAlgoId namespace so it can never collide with - or cancel
 * - a production order. Everything outside IMC_SMOKE_ is refused, and the id is
 * length-capped to Binance's 36 character client-id limit.
 *
 * Applies to any client id the smoke creates (conditional algo ids and the regular
 * reduceOnly close id alike).
 */
function isSmokeClientAlgoId(value) {
    var id = String(value === undefined || value === null ? '' : value);
    return id.length <= 36 && /^IMC_SMOKE_[A-Za-z0-9_:-]{1,26}$/.test(id);
}
function validateSmokeOrder(order) {
    if (!order || order.side !== 'BUY' || order.type !== 'LIMIT' || order.timeInForce !== 'GTC' ||
        !order.symbol || !Number.isFinite(Number(order.quantity)) || Number(order.quantity) <= 0 ||
        !Number.isFinite(Number(order.price)) || Number(order.price) <= 0 ||
        !/^IMC_SMOKE_[.A-Z:/a-z0-9_-]{1,26}$/.test(String(order.newClientOrderId || '')) ||
        String(order.newClientOrderId).length > 36) {
        throw Object.assign(new Error('INVALID_SMOKE_ORDER_PARAMS'), { code: 'MUTATION_GUARD_BLOCKED' });
    }
}
function uncertain(error) {
    if (!error) return false;
    // A local refusal never reached the exchange, so the order state is certain:
    // it must not be swallowed by the POST-then-query idempotency path.
    if (error.code === 'LIVE_TRADING_DISABLED' || error.code === 'BINANCE_CREDENTIALS_MISSING' ||
            error.code === 'MUTATION_GUARD_BLOCKED') {
        return false;
    }
    return !error.response || error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT' ||
        (error.response && error.response.status >= 500);
}
function operationName(method, path, params) {
    if (path === '/fapi/v1/algoOrder') {
        if (method === 'POST') return params && params.type === 'STOP_MARKET' ? 'CREATE_SL_ALGO' :
            params && params.type === 'TAKE_PROFIT_MARKET' ? 'CREATE_TP_ALGO' : 'CREATE_ALGO_ORDER';
        if (method === 'GET') return 'QUERY_ALGO_ORDER';
        if (method === 'DELETE') return 'CANCEL_ALGO_ORDER';
    }
    if (path === '/fapi/v1/order') return method === 'POST' ? 'PLACE_REGULAR_ORDER' :
        method === 'DELETE' ? 'CANCEL_REGULAR_ORDER' : 'QUERY_REGULAR_ORDER';
    return method + ' ' + path;
}
function sanitizedParams(params) {
    var blocked = { signature: true, apiKey: true, secret: true };
    var out = {};
    Object.keys(params || {}).forEach(function (key) { if (!blocked[key]) out[key] = params[key]; });
    return out;
}

function createClient(options) {
    var opts = options || {};
    var apiKey = opts.apiKey || process.env.BINANCE_FUTURES_API_KEY || '';
    var secret = opts.secret || process.env.BINANCE_FUTURES_API_SECRET || '';
    var enabled = opts.liveTradingEnabled === true;
    var transport = opts.transport;
    var governor = opts.governor;
    var baseUrl = opts.baseUrl || network.baseUrl;
    var clockOffset = 0;

    function request(method, path, params, signed, mutating) {
        if (mutating && !enabled) return Promise.reject(Object.assign(new Error('LIVE_TRADING_DISABLED'), { code: 'LIVE_TRADING_DISABLED' }));
        if ((signed || mutating) && (!apiKey || !secret)) return Promise.reject(Object.assign(new Error('BINANCE_CREDENTIALS_MISSING'), { code: 'BINANCE_CREDENTIALS_MISSING' }));
        var values = Object.assign({}, params || {});
        var encoded;
        if (signed) {
            values.timestamp = Date.now() + clockOffset;
            values.recvWindow = 5000;
            encoded = queryString(values);
            encoded += '&signature=' + crypto.createHmac('sha256', secret).update(encoded).digest('hex');
        } else {
            encoded = queryString(values);
        }
        var cfg = Object.assign(proxyConfig(), { method: method, url: baseUrl + path + (encoded ? '?' + encoded : ''), timeout: 10000,
            headers: apiKey ? { 'X-MBX-APIKEY': apiKey } : {} });
        return binanceHttp.request(cfg, { transport: transport, governor: governor,
            meta: { endpoint: path, category: mutating ? 'EXECUTION_MUTATION' : 'EXECUTION_REST' } })
            .then(function (response) { return response.data; }).catch(function (error) {
            var data = error && error.response && error.response.data || {};
            error.executionOperation = operationName(method, path, values);
            error.executionEndpoint = path;
            error.executionMethod = method;
            error.httpStatus = error && error.response && error.response.status;
            error.binanceCode = data.code;
            error.binanceMessage = data.msg;
            error.sanitizedRequest = sanitizedParams(values);
            throw error;
        });
    }
    function syncTime() {
        return getServerTime().then(function (value) {
            clockOffset = Number(value.serverTime) - Date.now(); return clockOffset;
        });
    }
    function getServerTime() { return request('GET', '/fapi/v1/time', {}, false, false); }
    function queryOrder(symbol, orderId, originalClientOrderId) {
        return request('GET', '/fapi/v1/order', { symbol: symbol, orderId: orderId,
            origClientOrderId: originalClientOrderId }, true, false);
    }
    function queryAlgo(symbol, algoId, clientAlgoId) {
        var identifier = algoId !== undefined && algoId !== null ? { algoId: algoId } : { clientAlgoId: clientAlgoId };
        return request('GET', '/fapi/v1/algoOrder', identifier, true, false);
    }
    function idempotentPost(path, params, queryAfterUnknown) {
        return request('POST', path, params, true, true).catch(function (error) {
            if (!uncertain(error)) throw error;
            return queryAfterUnknown().catch(function () {
                throw Object.assign(new Error('ORDER_STATE_UNKNOWN'), { code: 'ORDER_STATE_UNKNOWN', cause: error });
            });
        });
    }
    return {
        liveTradingEnabled: enabled,
        getUserDataApiKey: function () { return apiKey; },
        getServerTime: getServerTime,
        syncTime: syncTime,
        getExchangeInfo: function () { return request('GET', '/fapi/v1/exchangeInfo', {}, false, false); },
        getMarkPrices: function () { return request('GET', '/fapi/v1/premiumIndex', {}, false, false); },
        getBookTicker: function (symbol) { return request('GET', '/fapi/v1/ticker/bookTicker', { symbol: symbol }, false, false); },
        getPositionMode: function () { return request('GET', '/fapi/v1/positionSide/dual', {}, true, false); },
        getSymbolConfig: function (symbol) { return request('GET', '/fapi/v1/symbolConfig', { symbol: symbol }, true, false); },
        setLeverage: function (symbol, leverage) { return request('POST', '/fapi/v1/leverage', { symbol: symbol, leverage: leverage }, true, true); },
        getPositionRisk: function (symbol) { return request('GET', '/fapi/v3/positionRisk', { symbol: symbol }, true, false); },
        getOpenOrders: function (symbol) { return request('GET', '/fapi/v1/openOrders', { symbol: symbol }, true, false); },
        getOpenAlgoOrders: function (symbol) { return request('GET', '/fapi/v1/openAlgoOrders', { symbol: symbol }, true, false); },
        queryOrder: queryOrder,
        queryAlgoOrder: queryAlgo,
        submitEntry: function (plan) { var p = buildEntryParams(plan); return idempotentPost('/fapi/v1/order', p,
            function () { return queryOrder(plan.symbol, null, p.newClientOrderId); }); },
        submitSmokeLimit: function (order) {
            validateSmokeOrder(order);
            return idempotentPost('/fapi/v1/order', order,
                function () { return queryOrder(order.symbol, null, order.newClientOrderId); });
        },
        submitProtectionSmokeEntry: function (order) {
            if (!order || order.side !== 'BUY' || order.type !== 'LIMIT' || order.timeInForce !== 'GTC' ||
                !/^IMC_SMOKE2_/.test(String(order.newClientOrderId || ''))) {
                return Promise.reject(Object.assign(new Error('INVALID_SMOKE2_ENTRY'), { code: 'MUTATION_GUARD_BLOCKED' }));
            }
            return idempotentPost('/fapi/v1/order', order,
                function () { return queryOrder(order.symbol, null, order.newClientOrderId); });
        },
        submitProtectionSmokeAlgo: function (plan, role, smokeClientAlgoId) {
            if (!/^IMC_SMOKE2_/.test(String(smokeClientAlgoId || '')) || ['SL', 'TP'].indexOf(role) < 0) {
                return Promise.reject(Object.assign(new Error('INVALID_SMOKE2_ALGO'), { code: 'MUTATION_GUARD_BLOCKED' }));
            }
            var p = buildProtectionParams(plan, role); p.clientAlgoId = smokeClientAlgoId;
            return idempotentPost('/fapi/v1/algoOrder', p,
                function () { return queryAlgo(plan.symbol, null, smokeClientAlgoId); });
        },
        /**
         * PRODUCTION bridge protection: reduceOnly + explicit quantity +
         * closePosition=false, so it can be held at the same time as the canonical
         * closePosition stop/target. This is the ONLY shape Production may use while a
         * canonical protection has to be moved.
         */
        submitBridgeProtection: function (plan, role, quantity, triggerPrice) {
            if (['SL', 'TP'].indexOf(role) < 0) {
                return Promise.reject(Object.assign(new Error('INVALID_BRIDGE_ROLE'),
                    { code: 'MUTATION_GUARD_BLOCKED' }));
            }
            if (!(Number(quantity) > 0) || !(Number(triggerPrice) > 0)) {
                return Promise.reject(Object.assign(new Error('INVALID_BRIDGE_ORDER'),
                    { code: 'MUTATION_GUARD_BLOCKED' }));
            }
            var p = buildBridgeParams(plan, role, quantity, triggerPrice);
            return idempotentPost('/fapi/v1/algoOrder', p,
                function () { return queryAlgo(plan.symbol, null, p.clientAlgoId); });
        },
        /**
         * Production call sites pass two arguments and keep the deterministic
         * IMC_<symbol>_<role>_<hash> id. The optional third argument is only for
         * the local fill/protection smoke and must live in IMC_SMOKE_.
         */
        submitProtection: function (plan, role, smokeClientAlgoId) {
            var p = buildProtectionParams(plan, role);
            if (smokeClientAlgoId !== undefined && smokeClientAlgoId !== null) {
                if (!isSmokeClientAlgoId(smokeClientAlgoId)) {
                    return Promise.reject(Object.assign(new Error('INVALID_SMOKE_CLIENT_ALGO_ID'),
                        { code: 'MUTATION_GUARD_BLOCKED' }));
                }
                p.clientAlgoId = String(smokeClientAlgoId);
            }
            return idempotentPost('/fapi/v1/algoOrder', p,
                function () { return queryAlgo(plan.symbol, null, p.clientAlgoId); });
        },
        /**
         * LOCAL SMOKE ONLY - BRIDGE CAPABILITY PROBE.
         *
         * Places a reduceOnly protective order with an EXPLICIT quantity and
         * closePosition=false, so it can coexist with a canonical closePosition
         * stop instead of colliding with it (Binance -4130). The requirement is
         * structurally confined to the IMC_SMOKE_ namespace, exactly like
         * cancelSmokeAlgo, so a production call site can never reach it.
         */
        submitSmokeBridgeOrder: function (order) {
            if (!order || !isSmokeClientAlgoId(order.clientAlgoId) ||
                    !/^IMC_SMOKE_/.test(String(order.clientAlgoId))) {
                return Promise.reject(Object.assign(new Error('INVALID_SMOKE_BRIDGE_ID'),
                    { code: 'MUTATION_GUARD_BLOCKED' }));
            }
            var p = { algoType: 'CONDITIONAL', symbol: order.symbol, side: order.side,
                positionSide: 'BOTH', type: order.type, quantity: order.quantity,
                triggerPrice: order.triggerPrice, workingType: order.workingType || 'MARK_PRICE',
                reduceOnly: 'true', closePosition: 'false', clientAlgoId: String(order.clientAlgoId) };
            return idempotentPost('/fapi/v1/algoOrder', p,
                function () { return queryAlgo(order.symbol, null, p.clientAlgoId); });
        },
        /**
         * Production call site passes one argument and keeps the deterministic
         * IMC_<symbol>_ENTRY_<hash> id. The optional second argument is only for
         * the local real-order smoke and must live in the IMC_SMOKE_ namespace.
         */
        placeBreakoutEntry: function (plan, smokeClientAlgoId) {
            var p = buildBreakoutEntryParams(plan);
            if (smokeClientAlgoId !== undefined && smokeClientAlgoId !== null) {
                if (!isSmokeClientAlgoId(smokeClientAlgoId)) {
                    return Promise.reject(Object.assign(new Error('INVALID_SMOKE_CLIENT_ALGO_ID'),
                        { code: 'MUTATION_GUARD_BLOCKED' }));
                }
                p.clientAlgoId = String(smokeClientAlgoId);
            }
            return idempotentPost('/fapi/v1/algoOrder', p,
                function () { return queryAlgo(plan.symbol, null, p.clientAlgoId); });
        },
        cancelEntry: function (symbol, clientOrderId) { return request('DELETE', '/fapi/v1/order', { symbol: symbol, origClientOrderId: clientOrderId }, true, true); },
        cancelSmokeOrder: function (symbol, clientOrderId) {
            if (!/^IMC_SMOKE_/.test(String(clientOrderId || ''))) {
                return Promise.reject(Object.assign(new Error('INVALID_SMOKE_CLIENT_ORDER_ID'), { code: 'MUTATION_GUARD_BLOCKED' }));
            }
            return request('DELETE', '/fapi/v1/order', { symbol: symbol, origClientOrderId: clientOrderId }, true, true);
        },
        cancelProtectionSmokeAlgo: function (symbol, clientAlgoId) {
            if (!/^IMC_SMOKE2_/.test(String(clientAlgoId || ''))) {
                return Promise.reject(Object.assign(new Error('INVALID_SMOKE2_ALGO_ID'), { code: 'MUTATION_GUARD_BLOCKED' }));
            }
            return request('DELETE', '/fapi/v1/algoOrder', { clientAlgoId: clientAlgoId }, true, true);
        },
        cancelAlgo: function (symbol, clientAlgoId) {
            return request('DELETE', '/fapi/v1/algoOrder', { clientAlgoId: clientAlgoId }, true, true).then(function () {
                return queryAlgo(symbol, null, clientAlgoId).then(function (state) {
                    if (state.algoStatus === 'CANCELED') return state;
                    return queryAlgo(symbol, null, clientAlgoId);
                });
            });
        },
        /**
         * Smoke-only cancel. Structurally unable to cancel anything outside the
         * IMC_SMOKE_ namespace, which is the §25 "never cancelAll, never touch a
         * production order" guarantee for the local real-order smoke.
         */
        cancelSmokeAlgo: function (symbol, clientAlgoId) {
            if (!isSmokeClientAlgoId(clientAlgoId) || !/^IMC_SMOKE_/.test(String(clientAlgoId))) {
                return Promise.reject(Object.assign(new Error('INVALID_SMOKE_ALGO_ID'),
                    { code: 'MUTATION_GUARD_BLOCKED' }));
            }
            return request('DELETE', '/fapi/v1/algoOrder', { clientAlgoId: clientAlgoId }, true, true).then(function () {
                return queryAlgo(symbol, null, clientAlgoId).then(function (state) {
                    if (state.algoStatus === 'CANCELED') return state;
                    return queryAlgo(symbol, null, clientAlgoId);
                });
            });
        },
        /**
         * Verified safety close (MARKET reduceOnly). The optional fifth argument is
         * only for the local smoke, which must keep every id it creates inside the
         * IMC_SMOKE_ namespace.
         */
        emergencyClose: function (symbol, direction, quantity, tradeId, smokeClientOrderId) {
            var p = { symbol: symbol, side: direction === 'LONG' ? 'SELL' : 'BUY', positionSide: 'BOTH', type: 'MARKET',
                quantity: quantity, reduceOnly: 'true', newClientOrderId: clientId(symbol, tradeId, 'CLOSE') };
            if (smokeClientOrderId !== undefined && smokeClientOrderId !== null) {
                if (!isSmokeClientAlgoId(smokeClientOrderId)) {
                    return Promise.reject(Object.assign(new Error('INVALID_SMOKE_CLIENT_ORDER_ID'),
                        { code: 'MUTATION_GUARD_BLOCKED' }));
                }
                p.newClientOrderId = String(smokeClientOrderId);
            }
            return idempotentPost('/fapi/v1/order', p, function () { return queryOrder(symbol, null, p.newClientOrderId); });
        },
        // User Data Stream lifecycle uses the current WebSocket API methods in
        // userDataStreamV1. Only the API key (never the secret) is exposed to it.
    };
}

module.exports = { createClient: createClient, clientId: clientId,
    buildEntryParams: buildEntryParams, buildProtectionParams: buildProtectionParams,
    buildBreakoutEntryParams: buildBreakoutEntryParams,
    isSmokeClientAlgoId: isSmokeClientAlgoId,
    validateSmokeOrder: validateSmokeOrder, operationName: operationName,
    sanitizedParams: sanitizedParams };
