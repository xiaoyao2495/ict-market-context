#!/usr/bin/env node
'use strict';

require('../config/loadEnv')();

var crypto = require('crypto');
var clientModule = require('../execution/binanceExecutionClientV1');
var streamModule = require('../execution/userDataStreamV1');
var executionRules = require('../execution/executionRulesV1');
var binanceRest = require('../data/binanceRest');
var smokeModule = require('./execution-smoke');

var SYMBOLS = ['ETHUSDT', 'BNBUSDT', 'ZECUSDT', 'PROMUSDT', 'BTCUSDT'];
var DEFAULT_SYMBOL = 'PROMUSDT';
var SAFE_PRICE_FACTOR = 0.90;
var MIN_DISTANCE_PCT = 5;

function list(value) { return Array.isArray(value) ? value : (value ? [value] : []); }
function number(value) { var n = Number(value); return Number.isFinite(n) ? n : null; }
function clientId(symbol, now) {
    var asset = String(symbol).replace(/USDT$/, '').slice(0, 6);
    var suffix = Number(now).toString(36) + crypto.randomBytes(3).toString('hex');
    return ('IMC_SMOKE_' + asset + '_' + suffix).slice(0, 36);
}
function orderStatus(order) { return String(order && (order.status || order.orderStatus) || 'UNKNOWN').toUpperCase(); }
function executedQty(order) { return Number(order && (order.executedQty || order.cumQty) || 0); }
function positionQty(positions, symbol) {
    return list(positions).filter(function (item) { return item.symbol === symbol; })
        .reduce(function (total, item) { return total + Math.abs(Number(item.positionAmt) || 0); }, 0);
}
function findConfig(value, symbol) {
    return list(value).filter(function (item) { return item && item.symbol === symbol; })[0] || null;
}

function createMutationGuard(client, symbol, smokeClientOrderId) {
    var counts = { place: 0, cancel: 0, algo: 0, leverage: 0, marginMode: 0,
        positionMode: 0, positionClose: 0 };
    var records = [];
    var placed = false; var canceled = false; var safetyAuthorized = false;
    function blocked(reason) { throw Object.assign(new Error('MUTATION_GUARD_BLOCKED: ' + reason),
        { code: 'MUTATION_GUARD_BLOCKED', exitCode: 3 }); }
    function validateIdentity(request) {
        if (!request || request.symbol !== symbol || request.clientOrderId !== smokeClientOrderId ||
            !/^IMC_SMOKE_/.test(smokeClientOrderId)) blocked('ORDER_IDENTITY');
    }
    function place(order) {
        validateIdentity({ symbol: order.symbol, clientOrderId: order.newClientOrderId });
        if (placed || counts.place !== 0) blocked('DUPLICATE_PLACE');
        if (order.side !== 'BUY' || order.type !== 'LIMIT' || order.timeInForce !== 'GTC') blocked('ORDER_TYPE');
        placed = true; counts.place += 1;
        records.push({ method: 'POST', endpoint: '/fapi/v1/order', symbol: symbol,
            clientOrderId: smokeClientOrderId, type: 'LIMIT', result: 'REQUESTED' });
        return client.submitSmokeLimit(order);
    }
    function cancel(requestSymbol, requestClientOrderId) {
        validateIdentity({ symbol: requestSymbol, clientOrderId: requestClientOrderId });
        if (!placed || canceled || counts.cancel !== 0) blocked('INVALID_CANCEL_SEQUENCE');
        canceled = true; counts.cancel += 1;
        records.push({ method: 'DELETE', endpoint: '/fapi/v1/order', symbol: symbol,
            clientOrderId: smokeClientOrderId, result: 'REQUESTED' });
        return client.cancelSmokeOrder(symbol, smokeClientOrderId);
    }
    function authorizeSafetyClose() { safetyAuthorized = true; }
    function safetyClose(quantity) {
        if (!safetyAuthorized || !(Number(quantity) > 0) || counts.positionClose !== 0) blocked('SAFETY_CLOSE');
        counts.positionClose += 1;
        records.push({ method: 'POST', endpoint: '/fapi/v1/order', symbol: symbol,
            type: 'MARKET_REDUCE_ONLY_SAFETY_CLOSE', result: 'REQUESTED' });
        return client.emergencyClose(symbol, 'LONG', Number(quantity), smokeClientOrderId);
    }
    function snapshot() { return { counts: Object.assign({}, counts), records: records.slice(),
        total: counts.place + counts.cancel + counts.algo + counts.leverage + counts.marginMode +
            counts.positionMode + counts.positionClose }; }
    return { place: place, cancel: cancel, authorizeSafetyClose: authorizeSafetyClose,
        safetyClose: safetyClose, snapshot: snapshot };
}

function buildPlan(symbol, exchangeInfo, markData, bookData, now) {
    var rules = binanceRest.parseExchangeInfo(exchangeInfo, symbol, 'futures');
    if (rules.status !== 'TRADING' || !executionRules.validateRules(rules)) {
        return { ok: false, reason: 'INVALID_SYMBOL_RULES', rules: rules };
    }
    var mark = number(Array.isArray(markData) ? (markData.filter(function (item) { return item.symbol === symbol; })[0] || {}).markPrice
        : markData && markData.markPrice);
    var bid = number(Array.isArray(bookData) ? (bookData.filter(function (item) { return item.symbol === symbol; })[0] || {}).bidPrice
        : bookData && bookData.bidPrice);
    if (!(mark > 0) || !(bid > 0)) return { ok: false, reason: 'UNSAFE_LIMIT_PRICE', rules: rules };
    var limit = executionRules.legalize(mark * SAFE_PRICE_FACTOR, rules.tickSize, 'DOWN');
    var distancePct = (mark - limit) / mark * 100;
    if (!(limit < bid) || distancePct + 1e-9 < MIN_DISTANCE_PCT) {
        return { ok: false, reason: 'UNSAFE_LIMIT_PRICE', rules: rules, markPrice: mark,
            bestBid: bid, limitPrice: limit, distanceFromMarkPct: distancePct };
    }
    var sized = executionRules.sizeOrder('LONG', limit, limit, limit, rules);
    if (!sized.ok) return { ok: false, reason: sized.reasonCode, rules: rules };
    var id = clientId(symbol, now);
    return { ok: true, symbol: symbol, markPrice: mark, bestBid: bid, limitPrice: limit,
        distanceFromMarkPct: distancePct, minNotional: rules.minNotional,
        targetNotional: sized.targetNotional, quantity: sized.requestedQty,
        actualNotional: sized.actualNotional, clientOrderId: id,
        order: { symbol: symbol, side: 'BUY', type: 'LIMIT', timeInForce: 'GTC',
            quantity: sized.requestedQty, price: limit, newClientOrderId: id, newOrderRespType: 'ACK' } };
}

async function runOrderSmoke(options) {
    var opts = options || {}; var env = opts.env || process.env; var write = opts.write || console.log;
    var apiKey = env.BINANCE_FUTURES_API_KEY || ''; var secret = env.BINANCE_FUTURES_API_SECRET || '';
    var enabled = env.EXECUTION_ORDER_SMOKE_ENABLED === 'true';
    var symbol = env.EXECUTION_ORDER_SMOKE_SYMBOL || DEFAULT_SYMBOL;
    var client = opts.client || clientModule.createClient({ apiKey: apiKey, secret: secret, liveTradingEnabled: enabled });
    var sessionFactory = opts.sessionFactory || streamModule.createReadOnlySession;
    var waitForWs = opts.waitForWs || function () { return new Promise(function (resolve) { setTimeout(resolve, 750); }); };
    var details = { symbol: symbol, productionSlot: 'FREE', eqConsumptionTouched: false };
    var guard = null; var session = null; var wsConnected = false; var wsNewEventSeen = false;

    function final(result, exitCode, reason) {
        var mutation = guard ? guard.snapshot() : { counts: { place: 0, cancel: 0, algo: 0, leverage: 0,
            marginMode: 0, positionMode: 0, positionClose: 0 }, records: [], total: 0 };
        write('================================='); write('REAL ORDER SMOKE SUMMARY'); write('=================================');
        write('SYMBOL=' + symbol); write('ORDER_PLACE_MUTATIONS=' + mutation.counts.place);
        write('ORDER_CANCEL_MUTATIONS=' + mutation.counts.cancel); write('ALGO_MUTATIONS=' + mutation.counts.algo);
        write('LEVERAGE_MUTATIONS=' + mutation.counts.leverage); write('MARGIN_MODE_MUTATIONS=' + mutation.counts.marginMode);
        write('POSITION_MODE_MUTATIONS=' + mutation.counts.positionMode);
        write('POSITION_CLOSE_MUTATIONS=' + mutation.counts.positionClose);
        write('TOTAL_MUTATING_API_CALL_COUNT=' + mutation.total);
        write('REAL_ORDERS_SENT=' + mutation.counts.place); write('PRODUCTION_SLOT=' + details.productionSlot);
        write('EQ_CONSUMPTION_TOUCHED=' + details.eqConsumptionTouched); if (reason) write('REASON=' + reason);
        write('FINAL=' + result);
        return { exitCode: exitCode, final: result, reason: reason || null, details: details,
            mutations: mutation, wsConnected: wsConnected, wsNewEventSeen: wsNewEventSeen };
    }
    function printPlan(plan) {
        write('SIZING'); write('  markPrice=' + plan.markPrice); write('  bestBid=' + plan.bestBid);
        write('  minNotional=' + plan.minNotional); write('  targetNotional=' + plan.targetNotional);
        write('  qty=' + plan.quantity); write('  actualNotional=' + plan.actualNotional);
        write('LIMIT'); write('  side=BUY'); write('  type=LIMIT'); write('  timeInForce=GTC');
        write('  limitPrice=' + plan.limitPrice); write('  distanceFromMarkPct=' + plan.distanceFromMarkPct);
        write('  clientOrderId=' + plan.clientOrderId);
    }
    async function closeSession() { if (session) { try { await session.stop(); } catch (ignore) {} session = null; } }
    async function safety(order, positions, reason) {
        details.unexpectedFill = true; write('CRITICAL UNEXPECTED_SMOKE_FILL');
        var qty = Math.max(executedQty(order), positionQty(positions, symbol));
        guard.authorizeSafetyClose();
        if (['NEW', 'PARTIALLY_FILLED', 'PENDING_NEW'].indexOf(orderStatus(order)) >= 0 && guard.snapshot().counts.cancel === 0) {
            try { await guard.cancel(symbol, details.clientOrderId); } catch (ignore) {}
        }
        await guard.safetyClose(qty);
        await closeSession(); return final('FAIL', 1, reason || 'UNEXPECTED_SMOKE_FILL');
    }
    async function cleanupAfterFailure(reason) {
        var mutation = guard && guard.snapshot();
        if (!guard || !mutation || mutation.counts.place !== 1 || mutation.counts.positionClose !== 0) {
            await closeSession(); return final('FAIL', 1, reason);
        }
        var located = null; var positions = [];
        try { located = await client.queryOrder(symbol, details.orderId, details.clientOrderId); } catch (ignore) {}
        if (!located) {
            try { located = list(await client.getOpenOrders(symbol)).filter(function (item) {
                return item.clientOrderId === details.clientOrderId;
            })[0] || null; } catch (ignore2) {}
        }
        try { positions = await client.getPositionRisk(symbol); } catch (ignore3) {}
        if ((located && executedQty(located) > 0) || positionQty(positions, symbol) !== 0) {
            return safety(located || {}, positions, 'UNEXPECTED_SMOKE_FILL_DURING_FAILURE_CLEANUP');
        }
        mutation = guard.snapshot();
        if (located && ['NEW', 'PARTIALLY_FILLED', 'PENDING_NEW'].indexOf(orderStatus(located)) >= 0 && mutation.counts.cancel === 0) {
            try { await guard.cancel(symbol, details.clientOrderId); } catch (ignore4) {}
        }
        await closeSession(); return final('FAIL', 1, reason);
    }

    write('================================='); write('REAL ORDER SMOKE #1'); write('=================================');
    write('SYMBOL=' + symbol); write('MODE=' + (enabled ? 'REAL_LIMIT_CANCEL_SMOKE' : 'DRY_RUN'));
    write('ORDER_SMOKE_ENABLED=' + enabled); write('LIVE_TRADING_ENABLED=' + String(env.LIVE_TRADING_ENABLED));
    write('API_KEY_PRESENT=' + Boolean(apiKey)); write('API_SECRET_PRESENT=' + Boolean(secret));
    if (!apiKey || !secret) return final('FAIL', 1, 'AUTH_CREDENTIALS_MISSING');
    if (SYMBOLS.indexOf(symbol) < 0) return final('FAIL', 3, 'MUTATION_GUARD_BLOCKED_SYMBOL');

    try {
        await client.syncTime();
        var values = await Promise.all([client.getPositionMode(), client.getSymbolConfig(symbol),
            client.getPositionRisk(symbol), client.getOpenOrders(symbol), client.getOpenAlgoOrders(symbol),
            client.getExchangeInfo(), client.getMarkPrices(), client.getBookTicker(symbol)]);
        var mode = values[0]; var config = findConfig(values[1], symbol); var positions = list(values[2]);
        var regularOrders = list(values[3]); var algoOrders = list(values[4]);
        var hedge = mode && (mode.dualSidePosition === true || mode.dualSidePosition === 'true');
        var qtyBefore = positionQty(positions, symbol); var margin = String(config && config.marginType || '').toUpperCase();
        var leverage = Number(config && config.leverage);
        write('PRECHECK'); write('  API_AUTH=PASS'); write('  POSITION_MODE=' + (hedge ? 'HEDGE' : 'ONE_WAY'));
        write('  MARGIN=' + (margin || 'UNAVAILABLE')); write('  LEVERAGE=' + (Number.isFinite(leverage) ? leverage : 'UNAVAILABLE'));
        write('  POSITION=' + qtyBefore); write('  OPEN_ORDERS=' + regularOrders.length); write('  OPEN_ALGO=' + algoOrders.length);
        var precheckReason = hedge ? 'POSITION_MODE_NOT_ONE_WAY' : !config ? 'SYMBOL_CONFIG_UNAVAILABLE'
            : margin !== 'CROSSED' ? 'SYMBOL_NOT_CROSSED' : leverage !== 10 ? 'LEVERAGE_NOT_10'
                : qtyBefore !== 0 ? 'EXISTING_POSITION' : regularOrders.length ? 'EXISTING_REGULAR_ORDER'
                    : algoOrders.length ? 'EXISTING_ALGO_ORDER' : null;
        if (precheckReason) return final('FAIL', 1, precheckReason);
        var plan = buildPlan(symbol, values[5], values[6], values[7], opts.now === undefined ? Date.now() : opts.now);
        if (!plan.ok) return final('FAIL', 1, plan.reason);
        details.plan = plan; details.clientOrderId = plan.clientOrderId; printPlan(plan);
        guard = createMutationGuard(client, symbol, plan.clientOrderId);
        if (!enabled) { write('DRY_RUN'); write('NO_ORDER_CREATED'); return final('DRY_RUN', 0); }

        session = sessionFactory({ client: client, onEvent: function (event) {
            var order = event && event.o;
            if (event.e === 'ORDER_TRADE_UPDATE' && order && order.c === plan.clientOrderId && String(order.X).toUpperCase() === 'NEW') {
                wsNewEventSeen = true;
            }
        } });
        await session.start(); wsConnected = true; write('PASS WS_CONNECTED');

        var placed;
        try { placed = await guard.place(plan.order); }
        catch (postError) {
            if (postError.code !== 'ORDER_STATE_UNKNOWN') throw postError;
            var uncertainOrders = list(await client.getOpenOrders(symbol));
            var found = uncertainOrders.filter(function (item) { return item.clientOrderId === plan.clientOrderId; })[0];
            if (!found) { await closeSession(); return final('FAIL', 1, 'ORDER_STATE_UNKNOWN'); }
            placed = found;
        }
        details.orderId = placed.orderId || null; write('PLACE'); write('  RESULT=PASS');
        var verified = await client.queryOrder(symbol, placed.orderId, plan.clientOrderId);
        await waitForWs(); var wsKeepalive = true;
        try { await session.ping(); } catch (pingError) { wsKeepalive = false; write('WARN WS_KEEPALIVE_FAILED'); }
        var beforeCancelPositions = await client.getPositionRisk(symbol);
        details.restNew = orderStatus(verified) === 'NEW' && executedQty(verified) === 0;
        write('VERIFY'); write('  REST_NEW=' + (details.restNew ? 'PASS' : 'FAIL'));
        write('  WS_CONNECTED=' + wsConnected); write('  WS_NEW_EVENT_SEEN=' + wsNewEventSeen);
        write('  executedQty=' + executedQty(verified)); write('  positionQty=' + positionQty(beforeCancelPositions, symbol));
        if (executedQty(verified) > 0 || positionQty(beforeCancelPositions, symbol) !== 0) {
            return await safety(verified, beforeCancelPositions, 'UNEXPECTED_SMOKE_FILL_BEFORE_CANCEL');
        }
        if (orderStatus(verified) !== 'NEW') { await closeSession(); return final('FAIL', 1, 'ORDER_NOT_NEW'); }

        var cancelError = null;
        try { await guard.cancel(symbol, plan.clientOrderId); }
        catch (error) { cancelError = error; }
        write('CANCEL'); write('  RESULT=' + (cancelError ? 'RESPONSE_UNKNOWN_OR_FAILED' : 'REQUESTED'));
        var canceledOrder = await client.queryOrder(symbol, placed.orderId, plan.clientOrderId);
        var finalPositions = await client.getPositionRisk(symbol);
        if (executedQty(canceledOrder) > 0 || positionQty(finalPositions, symbol) !== 0 || orderStatus(canceledOrder) === 'FILLED') {
            return await safety(canceledOrder, finalPositions, 'UNEXPECTED_SMOKE_FILL_CANCEL_RACE');
        }
        var finalRegular = list(await client.getOpenOrders(symbol));
        var finalAlgos = list(await client.getOpenAlgoOrders(symbol));
        var smokeOpen = finalRegular.filter(function (item) { return item.clientOrderId === plan.clientOrderId; });
        var smokeAlgos = finalAlgos.filter(function (item) {
            return String(item.clientAlgoId || item.clientOrderId || '').indexOf('IMC_SMOKE_') === 0;
        });
        details.finalOrderStatus = orderStatus(canceledOrder); details.finalPositionQty = positionQty(finalPositions, symbol);
        details.smokeOpenOrders = smokeOpen.length; details.smokeAlgoOrders = smokeAlgos.length;
        write('FINAL VERIFY'); write('  orderStatus=' + details.finalOrderStatus);
        write('  positionQty=' + details.finalPositionQty); write('  smokeOpenOrders=' + smokeOpen.length);
        write('  smokeAlgoOrders=' + smokeAlgos.length); write('  productionSlot=FREE');
        await closeSession();
        if (details.finalOrderStatus !== 'CANCELED' || details.finalPositionQty !== 0 || smokeOpen.length || smokeAlgos.length) {
            return final('FAIL', 1, cancelError ? 'ORDER_STATE_UNKNOWN' : 'CLEANUP_VERIFY_FAILED');
        }
        if (!wsKeepalive) return final('FAIL', 1, 'WS_KEEPALIVE_FAILED');
        return final('PASS', 0);
    } catch (error) {
        write('FAIL ' + (error.code || 'ORDER_SMOKE_INTERNAL_ERROR'));
        write('message=' + smokeModule.safeMessage(error));
        if (guard && guard.snapshot().counts.place === 1) {
            return cleanupAfterFailure(error.code || 'ORDER_SMOKE_INTERNAL_ERROR');
        }
        await closeSession();
        return final('FAIL', error.exitCode === 3 ? 3 : 2, error.code || 'ORDER_SMOKE_INTERNAL_ERROR');
    }
}

if (require.main === module) {
    runOrderSmoke().then(function (result) { process.exitCode = result.exitCode; }, function (error) {
        console.error('FAIL ORDER_SMOKE_INTERNAL_ERROR'); console.error('message=' + smokeModule.safeMessage(error)); process.exitCode = 2;
    });
}

module.exports = { SYMBOLS: SYMBOLS, DEFAULT_SYMBOL: DEFAULT_SYMBOL, SAFE_PRICE_FACTOR: SAFE_PRICE_FACTOR,
    MIN_DISTANCE_PCT: MIN_DISTANCE_PCT, clientId: clientId, buildPlan: buildPlan,
    createMutationGuard: createMutationGuard, runOrderSmoke: runOrderSmoke };
