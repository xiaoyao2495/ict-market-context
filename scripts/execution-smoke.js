#!/usr/bin/env node
'use strict';

require('../config/loadEnv')();

var clientModule = require('../execution/binanceExecutionClientV1');
var streamModule = require('../execution/userDataStreamV1');
var executionRules = require('../execution/executionRulesV1');
var binanceRest = require('../data/binanceRest');
var network = require('../config/network');

var READ_ONLY_SMOKE = true;
var SYMBOLS = ['ETHUSDT', 'BNBUSDT', 'ZECUSDT', 'PROMUSDT', 'BTCUSDT'];

function list(value) { return Array.isArray(value) ? value : (value ? [value] : []); }
function finite(value) { return value !== '' && value !== null && value !== undefined && Number.isFinite(Number(value)); }
function upper(value) { return String(value || '').toUpperCase(); }
function orderClientId(order) { return String(order && (order.clientOrderId || order.clientAlgoId) || ''); }
function safeMessage(error) {
    var data = error && error.response && error.response.data;
    var message = data && (data.msg || data.message) || error && error.message || 'UNKNOWN_ERROR';
    return String(message).replace(/signature=[^&\s]+/gi, 'signature=[REDACTED]').slice(0, 300);
}
function safeCode(error) {
    var data = error && error.response && error.response.data;
    return data && data.code !== undefined ? data.code : (error && error.code || 'UNKNOWN');
}
function printObject(write, value) { write(JSON.stringify(value)); }

function inspectExchangeState(client) {
    return Promise.all([client.getPositionRisk(), client.getOpenOrders(), client.getOpenAlgoOrders()]).then(function (values) {
        return { positions: list(values[0]), regularOrders: list(values[1]), algoOrders: list(values[2]) };
    });
}

function createSummary() {
    return {
        environment: 'FAIL', publicRest: 'FAIL', authenticatedRest: 'FAIL', positionMode: 'FAIL',
        symbolConfig: 'FAIL', exchangeRules: 'FAIL', sizingPreview: 'FAIL', positionsRead: 'FAIL',
        regularOrdersRead: 'FAIL', algoOrdersRead: 'FAIL', userDataStream: 'FAIL', reconciliationSnapshot: 'FAIL'
    };
}

function runSmoke(options) {
    var opts = options || {};
    var env = opts.env || process.env;
    var write = opts.write || console.log;
    var apiKey = env.BINANCE_FUTURES_API_KEY || '';
    var secret = env.BINANCE_FUTURES_API_SECRET || '';
    var mutationCount = 0;
    var realOrdersSent = 0;
    var summary = createSummary();
    var details = { symbols: {}, positionMode: null, openPositions: [], imcRegularOrders: [], imcAlgoOrders: [],
        userDataStream: null, reconciliationSnapshot: null };
    var client = opts.client || clientModule.createClient({ apiKey: apiKey, secret: secret, liveTradingEnabled: false });
    var probeFactory = opts.probeFactory || streamModule.createReadOnlyProbe;
    var now = opts.now || Date.now;
    var criticalFailure = false;
    var activeSection = 'publicRest';

    function fail(section, code, error) {
        if (section) summary[section] = 'FAIL'; criticalFailure = true;
        write('FAIL ' + code);
        if (error) { write('code=' + safeCode(error)); write('message=' + safeMessage(error)); }
    }
    function warn(code, fields) {
        write('WARN ' + code);
        if (fields) Object.keys(fields).forEach(function (key) { write(key + '=' + fields[key]); });
    }
    function step(number, title) { write('[' + number + '/10] ' + title); }

    step(1, 'Environment');
    write((apiKey ? 'PASS' : 'FAIL') + ' API_KEY_PRESENT=' + Boolean(apiKey));
    write((secret ? 'PASS' : 'FAIL') + ' API_SECRET_PRESENT=' + Boolean(secret));
    write('INFO LIVE_TRADING_ENABLED=' + String(env.LIVE_TRADING_ENABLED));
    write('INFO PROXY=' + (network.proxy && network.proxy.enabled
        ? 'configured:' + network.proxy.host + ':' + network.proxy.port : 'not_configured'));
    write('INFO RUNTIME=' + process.version);
    write('INFO RUNTIME_MODE=READ_ONLY');
    write('PASS READ_ONLY_SMOKE=' + READ_ONLY_SMOKE);
    if (!apiKey || !secret) {
        fail('environment', 'AUTH_CREDENTIALS_MISSING');
        writeSummary(write, summary, mutationCount, realOrdersSent, 'FAIL');
        return Promise.resolve({ exitCode: 1, result: 'FAIL', summary: summary, details: details,
            mutationApiCallCount: mutationCount, realOrdersSent: realOrdersSent, networkCallCount: 0 });
    }
    summary.environment = 'PASS';

    var authenticatedPositions;
    var symbolConfigs = {};
    var exchangeData;
    var markPrices = {};

    step(2, 'Binance public connectivity');
    var localBefore = now();
    return client.getServerTime().then(function (time) {
        var localAfter = now();
        var serverTime = Number(time.serverTime);
        if (!Number.isFinite(serverTime)) throw new Error('SERVER_TIME_NOT_FINITE');
        var localTime = Math.round((localBefore + localAfter) / 2);
        var offset = serverTime - localTime;
        summary.publicRest = 'PASS';
        write('PASS SERVER_TIME'); write('localTime=' + localTime); write('serverTime=' + serverTime); write('offsetMs=' + offset);
        if (Math.abs(offset) > 1000) warn('SERVER_TIME_OFFSET_HIGH', { offsetMs: offset });
        return client.syncTime();
    }).then(function () {
        step(3, 'Authenticated REST');
        activeSection = 'authenticatedRest';
        return client.getPositionRisk();
    }).then(function (positions) {
        authenticatedPositions = list(positions); summary.authenticatedRest = 'PASS'; write('PASS AUTHENTICATED_REST');
        step(4, 'Position Mode');
        activeSection = 'positionMode';
        return client.getPositionMode();
    }).then(function (mode) {
        var hedge = mode.dualSidePosition === true || mode.dualSidePosition === 'true';
        details.positionMode = hedge ? 'HEDGE' : 'ONE_WAY';
        if (hedge) fail('positionMode', 'POSITION_MODE_EXPECTED_ONE_WAY');
        else { summary.positionMode = 'PASS'; write('PASS POSITION_MODE=ONE_WAY'); }
        if (hedge) write('actual=HEDGE');

        step(5, 'Symbol Config / Margin / Leverage');
        activeSection = 'symbolConfig';
        return Promise.all(SYMBOLS.map(function (symbol) {
            return client.getSymbolConfig(symbol).then(function (value) {
                var config = list(value).filter(function (item) { return item && item.symbol === symbol; })[0] || null;
                symbolConfigs[symbol] = config; return config;
            }, function (error) {
                symbolConfigs[symbol] = null; warn('SYMBOL_CONFIG_UNAVAILABLE', { symbol: symbol,
                    code: safeCode(error), message: safeMessage(error) }); return null;
            });
        }));
    }).then(function () {
        var available = 0; var configMismatch = false;
        SYMBOLS.forEach(function (symbol) {
            var config = symbolConfigs[symbol];
            details.symbols[symbol] = details.symbols[symbol] || { symbol: symbol };
            if (!config) { warn('SYMBOL_CONFIG_NOT_FOUND', { symbol: symbol }); return; }
            available += 1;
            var margin = upper(config.marginType); var leverage = Number(config.leverage);
            details.symbols[symbol].marginType = margin; details.symbols[symbol].leverage = leverage;
            if (margin === 'CROSSED' && leverage === 10) write('PASS ' + symbol + ' marginType=' + margin + ' leverage=' + leverage);
            else { configMismatch = true; warn('SYMBOL_NOT_READY', { symbol: symbol, marginType: margin, leverage: leverage, expected: 'CROSSED/10' }); }
        });
        if (!available) fail('symbolConfig', 'SYMBOL_CONFIG_API_NO_RESULTS');
        else if (configMismatch) { summary.symbolConfig = 'FAIL'; criticalFailure = true; }
        else summary.symbolConfig = 'PASS';

        step(6, 'Exchange Symbol Rules and 20 USDT sizing preview');
        activeSection = 'exchangeRules';
        return Promise.all([client.getExchangeInfo(), client.getMarkPrices()]);
    }).then(function (values) {
        exchangeData = values[0];
        list(values[1]).forEach(function (item) { if (item && item.symbol) markPrices[item.symbol] = Number(item.markPrice); });
        var rulesFailed = false; var sizingFailed = false; var found = 0;
        SYMBOLS.forEach(function (symbol) {
            var parsed = binanceRest.parseExchangeInfo(exchangeData, symbol, 'futures');
            var detail = details.symbols[symbol] = Object.assign(details.symbols[symbol] || {}, parsed);
            if (parsed.status !== 'TRADING') {
                warn('SYMBOL_NOT_TRADING', { symbol: symbol, status: parsed.status || 'NOT_FOUND' }); return;
            }
            found += 1;
            if (!executionRules.validateRules(parsed)) {
                rulesFailed = true; fail(null, 'SYMBOL_RULES_INVALID'); write('symbol=' + symbol); return;
            }
            var refPrice = markPrices[symbol]; detail.refPrice = refPrice;
            if (!finite(refPrice) || refPrice <= 0) {
                sizingFailed = true; fail(null, 'SYMBOL_REFERENCE_PRICE_INVALID'); write('symbol=' + symbol); return;
            }
            var sized = executionRules.sizeOrder('LONG', refPrice, refPrice, refPrice, parsed);
            detail.targetNotional = Math.max(executionRules.MIN_TARGET_NOTIONAL, Number(parsed.minNotional));
            detail.legalizedQty = sized.requestedQty; detail.actualNotional = sized.actualNotional;
            detail.sizingStatus = sized.ok ? 'PASS' : 'FAIL';
            write(symbol); write('  status=' + parsed.status); write('  refPrice=' + refPrice);
            write('  minNotional=' + parsed.minNotional); write('  tickSize=' + parsed.tickSize);
            write('  stepSize=' + parsed.stepSize); write('  targetNotional=' + detail.targetNotional);
            write('  legalizedQty=' + (sized.requestedQty === undefined ? 'N/A' : sized.requestedQty));
            write('  actualNotional=' + (sized.actualNotional === undefined ? 'N/A' : sized.actualNotional));
            write('  status=' + detail.sizingStatus);
            if (!sized.ok) { sizingFailed = true; fail(null, 'SYMBOL_SIZING'); write('reason=' + sized.reasonCode); }
        });
        if (!found) rulesFailed = true;
        summary.exchangeRules = rulesFailed ? 'FAIL' : 'PASS';
        summary.sizingPreview = sizingFailed || !found ? 'FAIL' : 'PASS';
        if (rulesFailed || sizingFailed || !found) criticalFailure = true;

        step(7, 'Current Positions');
        details.openPositions = authenticatedPositions.filter(function (position) { return Number(position.positionAmt) !== 0; })
            .map(function (position) { return { symbol: position.symbol, positionAmt: position.positionAmt,
                entryPrice: position.entryPrice, markPrice: position.markPrice, unRealizedProfit: position.unRealizedProfit,
                leverage: position.leverage, marginType: position.marginType }; });
        summary.positionsRead = 'PASS';
        if (!details.openPositions.length) write('PASS OPEN_POSITIONS=0');
        else details.openPositions.forEach(function (position) { warn('OPEN_POSITION_FOUND'); printObject(write, position); });

        step(8, 'Open Entry / Regular Orders');
        activeSection = 'regularOrdersRead';
        return client.getOpenOrders();
    }).then(function (orders) {
        var all = list(orders); details.imcRegularOrders = all.filter(function (order) { return orderClientId(order).indexOf('IMC_') === 0; })
            .map(function (order) { return { symbol: order.symbol, orderId: order.orderId, clientOrderId: order.clientOrderId,
                side: order.side, type: order.type, status: order.status, price: order.price,
                origQty: order.origQty, executedQty: order.executedQty }; });
        summary.regularOrdersRead = 'PASS'; write('INFO OPEN_REGULAR_ORDERS=' + all.length);
        if (!details.imcRegularOrders.length) write('PASS IMC_REGULAR_ORDERS=0');
        else details.imcRegularOrders.forEach(function (order) { warn('OPEN_REGULAR_ORDER_FOUND'); printObject(write, order); });

        step(9, 'Open Algo Orders');
        activeSection = 'algoOrdersRead';
        return client.getOpenAlgoOrders();
    }).then(function (orders) {
        var all = list(orders); details.imcAlgoOrders = all.filter(function (order) { return orderClientId(order).indexOf('IMC_') === 0; })
            .map(function (order) { return { symbol: order.symbol, clientAlgoId: order.clientAlgoId,
                clientOrderId: order.clientOrderId, algoId: order.algoId, type: order.type, side: order.side,
                triggerPrice: order.triggerPrice, workingType: order.workingType, algoStatus: order.algoStatus,
                closePosition: order.closePosition }; });
        summary.algoOrdersRead = 'PASS'; write('INFO OPEN_ALGO_ORDERS=' + all.length);
        if (!details.imcAlgoOrders.length) write('PASS IMC_ALGO_ORDERS=0');
        else details.imcAlgoOrders.forEach(function (order) {
            warn('OPEN_ALGO_ORDER_FOUND'); printObject(write, order);
            var position = authenticatedPositions.filter(function (p) { return p.symbol === order.symbol && Number(p.positionAmt) !== 0; })[0];
            if (!position) warn('ORPHAN_PROTECTIVE_ORDER_DETECTED', { action: 'READ_ONLY_DO_NOT_CANCEL' });
        });

        step(10, 'User Data Stream and REST reconciliation snapshot');
        activeSection = 'userDataStream';
        return probeFactory({ client: client }).run();
    }).then(function (probe) {
        details.userDataStream = probe;
        if (!probe.authenticated || !probe.connected || !probe.keepalive || !probe.cleanClose) throw new Error('USER_DATA_STREAM_INCOMPLETE');
        summary.userDataStream = 'PASS';
        write('PASS USER_DATA_STREAM_AUTH'); write('PASS USER_DATA_STREAM_CONNECT');
        write('PASS USER_DATA_STREAM_KEEPALIVE'); write('PASS USER_DATA_STREAM_CLEAN_CLOSE');
        activeSection = 'reconciliationSnapshot';
        return inspectExchangeState(client);
    }).then(function (snapshot) {
        var symbolSlots = {};
        SYMBOLS.forEach(function (symbol) {
            var positionQty = snapshot.positions.filter(function (p) { return p.symbol === symbol; })
                .reduce(function (total, p) { return total + Math.abs(Number(p.positionAmt) || 0); }, 0);
            symbolSlots[symbol] = { positionQty: positionQty,
                openRegularOrders: snapshot.regularOrders.filter(function (o) { return o.symbol === symbol; }).length,
                openAlgoOrders: snapshot.algoOrders.filter(function (o) { return o.symbol === symbol; }).length };
        });
        details.reconciliationSnapshot = { positionCount: snapshot.positions.length,
            nonZeroPositionCount: snapshot.positions.filter(function (p) { return Number(p.positionAmt) !== 0; }).length,
            regularOrderCount: snapshot.regularOrders.length, algoOrderCount: snapshot.algoOrders.length,
            symbolSlots: symbolSlots };
        summary.reconciliationSnapshot = 'PASS'; write('PASS RECONCILIATION_SNAPSHOT');
        printObject(write, details.reconciliationSnapshot);
        var result = criticalFailure ? 'FAIL' : 'PASS';
        writeSummary(write, summary, mutationCount, realOrdersSent, result);
        return { exitCode: result === 'PASS' ? 0 : 1, result: result, summary: summary, details: details,
            mutationApiCallCount: mutationCount, realOrdersSent: realOrdersSent };
    }).catch(function (error) {
        fail(activeSection, activeSection === 'userDataStream' ? 'USER_DATA_STREAM_FAILED' : 'CRITICAL_API_READ_FAILED', error);
        writeSummary(write, summary, mutationCount, realOrdersSent, 'FAIL');
        return { exitCode: 1, result: 'FAIL', summary: summary, details: details,
            mutationApiCallCount: mutationCount, realOrdersSent: realOrdersSent, error: safeMessage(error) };
    });
}

function writeSummary(write, summary, mutationCount, realOrdersSent, result) {
    write('=============================='); write('EXECUTION READ-ONLY SMOKE'); write('==============================');
    write('READ_ONLY=true'); write('REAL_ORDERS_SENT=' + realOrdersSent); write('ACCOUNT_MUTATIONS=' + mutationCount);
    [
        ['Environment', 'environment'], ['Public REST', 'publicRest'], ['Authenticated REST', 'authenticatedRest'],
        ['Position Mode', 'positionMode'], ['Symbol Config', 'symbolConfig'], ['Exchange Rules', 'exchangeRules'],
        ['Sizing Preview', 'sizingPreview'], ['Positions Read', 'positionsRead'],
        ['Regular Orders Read', 'regularOrdersRead'], ['Algo Orders Read', 'algoOrdersRead'],
        ['User Data Stream', 'userDataStream'], ['Reconciliation Snapshot', 'reconciliationSnapshot']
    ].forEach(function (item) { write(item[0] + '=' + summary[item[1]]); });
    write('MUTATING_API_CALL_COUNT=' + mutationCount); write('RESULT=' + result);
    write('READ_ONLY_SMOKE=true'); write('REAL_ORDERS_SENT=0'); write('ACCOUNT_MUTATIONS=0');
}

if (require.main === module) {
    runSmoke().then(function (result) { process.exitCode = result.exitCode; }, function (error) {
        console.error('FAIL INTERNAL_ERROR'); console.error('message=' + safeMessage(error));
        console.log('READ_ONLY_SMOKE=true'); console.log('REAL_ORDERS_SENT=0'); console.log('ACCOUNT_MUTATIONS=0');
        process.exitCode = 2;
    });
}

module.exports = { READ_ONLY_SMOKE: READ_ONLY_SMOKE, SYMBOLS: SYMBOLS, runSmoke: runSmoke,
    inspectExchangeState: inspectExchangeState, safeMessage: safeMessage };
