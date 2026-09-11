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
        submitProtection: function (plan, role) { var p = buildProtectionParams(plan, role); return idempotentPost('/fapi/v1/algoOrder', p,
            function () { return queryAlgo(plan.symbol, null, p.clientAlgoId); }); },
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
        emergencyClose: function (symbol, direction, quantity, tradeId) {
            var p = { symbol: symbol, side: direction === 'LONG' ? 'SELL' : 'BUY', positionSide: 'BOTH', type: 'MARKET',
                quantity: quantity, reduceOnly: 'true', newClientOrderId: clientId(symbol, tradeId, 'CLOSE') };
            return idempotentPost('/fapi/v1/order', p, function () { return queryOrder(symbol, null, p.newClientOrderId); });
        },
        // User Data Stream lifecycle uses the current WebSocket API methods in
        // userDataStreamV1. Only the API key (never the secret) is exposed to it.
    };
}

module.exports = { createClient: createClient, clientId: clientId,
    buildEntryParams: buildEntryParams, buildProtectionParams: buildProtectionParams,
    validateSmokeOrder: validateSmokeOrder, operationName: operationName,
    sanitizedParams: sanitizedParams };
