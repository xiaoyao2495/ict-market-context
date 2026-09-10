#!/usr/bin/env node
'use strict';

var clientModule = require('../execution/binanceExecutionClientV1');
var smokeModule = require('./execution-smoke');

var TARGET_LEVERAGE = 10;
var TARGET_SYMBOLS = ['ETHUSDT', 'BNBUSDT', 'ZECUSDT', 'PROMUSDT', 'BTCUSDT'];
var ALLOWED_MUTATION = Object.freeze({
    method: 'POST', endpoint: '/fapi/v1/leverage', leverage: TARGET_LEVERAGE,
    symbols: new Set(TARGET_SYMBOLS)
});

function list(value) { return Array.isArray(value) ? value : (value ? [value] : []); }
function upper(value) { return String(value || '').toUpperCase(); }
function safeCode(error) {
    var data = error && error.response && error.response.data;
    return data && data.code !== undefined ? data.code : (error && error.code || 'UNKNOWN');
}
function uncertain(error) {
    return !error || !error.response || error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT' ||
        error.code === 'ECONNRESET' || (error.response && error.response.status >= 500);
}
function symbolConfig(value, symbol) {
    return list(value).filter(function (item) { return item && item.symbol === symbol; })[0] || null;
}

function createMutationGuard(client, journal) {
    var records = journal || [];
    var mutationCount = 0;
    var mutatedSymbols = new Set();
    function blocked(reason) {
        var error = Object.assign(new Error('MUTATION_GUARD_BLOCKED: ' + reason),
            { code: 'MUTATION_GUARD_BLOCKED', exitCode: 3 });
        throw error;
    }
    function mutate(request) {
        if (!request || request.method !== ALLOWED_MUTATION.method) blocked('METHOD');
        if (request.endpoint !== ALLOWED_MUTATION.endpoint) blocked('ENDPOINT');
        if (!ALLOWED_MUTATION.symbols.has(request.symbol)) blocked('SYMBOL');
        if (Number(request.leverage) !== ALLOWED_MUTATION.leverage) blocked('LEVERAGE');
        if (mutatedSymbols.has(request.symbol)) blocked('DUPLICATE_SYMBOL');
        if (mutationCount >= TARGET_SYMBOLS.length) blocked('MAX_MUTATIONS');
        mutationCount += 1; mutatedSymbols.add(request.symbol);
        var record = { symbol: request.symbol, endpoint: request.endpoint,
            requestedLeverage: request.leverage, result: 'REQUESTED' };
        records.push(record);
        return Promise.resolve(client.setLeverage(request.symbol, request.leverage)).then(function (response) {
            record.result = 'POST_SUCCEEDED'; return response;
        }, function (error) {
            record.result = uncertain(error) ? 'POST_RESULT_UNKNOWN' : 'POST_FAILED'; throw error;
        });
    }
    return { mutate: mutate, getCount: function () { return mutationCount; }, records: records };
}

function readAll(client) {
    return client.syncTime().then(function () {
        return Promise.all([
            client.getPositionRisk(), client.getOpenOrders(), client.getOpenAlgoOrders(), client.getPositionMode(),
            Promise.all(TARGET_SYMBOLS.map(function (symbol) { return client.getSymbolConfig(symbol); }))
        ]);
    }).then(function (values) {
        var configs = {};
        TARGET_SYMBOLS.forEach(function (symbol, index) { configs[symbol] = symbolConfig(values[4][index], symbol); });
        return { positions: list(values[0]), regularOrders: list(values[1]), algoOrders: list(values[2]),
            positionMode: values[3], configs: configs };
    });
}

function runAccountInit(options) {
    var opts = options || {};
    var env = opts.env || process.env;
    var write = opts.write || console.log;
    var apiKey = env.BINANCE_FUTURES_API_KEY || env.BINANCE_API_KEY || '';
    var secret = env.BINANCE_FUTURES_API_SECRET || env.BINANCE_API_SECRET || '';
    var enabled = env.EXECUTION_ACCOUNT_INIT_ENABLED === 'true';
    var journal = [];
    var client = opts.client || clientModule.createClient({ apiKey: apiKey, secret: secret, liveTradingEnabled: enabled });
    var guard = createMutationGuard(client, journal);
    var details = {};

    function finish(final, exitCode, reason) {
        var ready = TARGET_SYMBOLS.filter(function (symbol) { return details[symbol] && details[symbol].ready; }).length;
        write('================================='); write('EXECUTION ACCOUNT INIT SUMMARY'); write('=================================');
        write('TARGET_SYMBOLS=' + TARGET_SYMBOLS.length); write('READY_SYMBOLS=' + ready);
        write('NOT_READY_SYMBOLS=' + (TARGET_SYMBOLS.length - ready));
        write('MUTATING_API_CALL_COUNT=' + guard.getCount());
        write('ORDER_MUTATIONS=0'); write('POSITION_MUTATIONS=0'); write('MARGIN_MODE_MUTATIONS=0');
        write('POSITION_MODE_MUTATIONS=0'); write('LEVERAGE_MUTATIONS=' + guard.getCount());
        write('ACCOUNT_CONFIGURATION=' + final); write('FINAL=' + final);
        if (reason) write('REASON=' + reason);
        return { exitCode: exitCode, final: final, details: details, mutationJournal: journal,
            mutatingApiCallCount: guard.getCount(), orderMutations: 0, positionMutations: 0,
            marginModeMutations: 0, positionModeMutations: 0, leverageMutations: guard.getCount() };
    }

    write('================================='); write('EXECUTION ACCOUNT INIT'); write('=================================');
    write('TARGET_LEVERAGE=' + TARGET_LEVERAGE); write('TARGET_SYMBOLS=' + TARGET_SYMBOLS.length);
    write('ACCOUNT_INIT_ENABLED=' + enabled); write('LIVE_TRADING_ENABLED=' + String(env.LIVE_TRADING_ENABLED));
    write('API_KEY_PRESENT=' + Boolean(apiKey)); write('API_SECRET_PRESENT=' + Boolean(secret));
    if (!apiKey || !secret) return Promise.resolve(finish('NOT_READY', 1, 'AUTH_CREDENTIALS_MISSING'));
    if (!enabled) {
        write('DRY_RUN'); write('NO_MUTATION');
    }

    return readAll(client).then(function (snapshot) {
        var hedge = snapshot.positionMode && (snapshot.positionMode.dualSidePosition === true ||
            snapshot.positionMode.dualSidePosition === 'true');
        write('POSITION_MODE=' + (hedge ? 'HEDGE FAIL' : 'ONE_WAY PASS'));
        if (hedge) return finish('NOT_READY', 1, 'POSITION_MODE_NOT_ONE_WAY');

        var sequence = Promise.resolve();
        TARGET_SYMBOLS.forEach(function (symbol) {
            sequence = sequence.then(function () {
                var config = snapshot.configs[symbol];
                var positions = snapshot.positions.filter(function (item) { return item.symbol === symbol; });
                var positionQty = positions.reduce(function (total, item) { return total + Math.abs(Number(item.positionAmt) || 0); }, 0);
                var regularCount = snapshot.regularOrders.filter(function (item) { return item.symbol === symbol; }).length;
                var algoCount = snapshot.algoOrders.filter(function (item) { return item.symbol === symbol; }).length;
                var before = config ? Number(config.leverage) : null;
                var marginType = config ? upper(config.marginType) : null;
                var detail = details[symbol] = { symbol: symbol, leverageBefore: before, leverageAfter: before,
                    marginType: marginType, position: positionQty, openOrders: regularCount,
                    openAlgoOrders: algoCount, mutation: 'NONE', result: null, ready: false };
                write(symbol); write('  position=' + positionQty); write('  openOrders=' + regularCount);
                write('  openAlgoOrders=' + algoCount); write('  marginType=' + (marginType || 'UNAVAILABLE'));
                write('  leverageBefore=' + (before === null ? 'UNAVAILABLE' : before));
                if (!config) { detail.result = 'FAIL_SYMBOL_CONFIG_UNAVAILABLE'; write('  RESULT=' + detail.result); return; }
                if (positionQty !== 0 || regularCount !== 0 || algoCount !== 0) {
                    detail.result = 'SKIP_UNSAFE_TO_CHANGE_LEVERAGE'; write('  RESULT=' + detail.result); return;
                }
                if (marginType !== 'CROSSED') {
                    detail.result = 'FAIL_SYMBOL_NOT_CROSSED'; write('  RESULT=' + detail.result); return;
                }
                if (before === TARGET_LEVERAGE) {
                    detail.ready = true; detail.result = 'PASS_ALREADY_CONFIGURED';
                    write('  mutation=NONE'); write('  leverageAfter=' + before); write('  RESULT=' + detail.result); return;
                }
                if (!enabled) {
                    detail.result = 'DRY_RUN_WOULD_SET_LEVERAGE_10';
                    write('  mutation=NONE_DRY_RUN'); write('  leverageAfter=' + before); write('  RESULT=' + detail.result); return;
                }
                detail.mutation = 'POST /fapi/v1/leverage leverage=10'; write('  mutation=' + detail.mutation);
                var postError = null;
                return guard.mutate({ method: 'POST', endpoint: '/fapi/v1/leverage', symbol: symbol,
                    leverage: TARGET_LEVERAGE }).catch(function (error) { postError = error; }).then(function () {
                    return client.getSymbolConfig(symbol);
                }).then(function (readback) {
                    var afterConfig = symbolConfig(readback, symbol); var after = afterConfig ? Number(afterConfig.leverage) : null;
                    detail.leverageAfter = after; write('  leverageAfter=' + (after === null ? 'UNAVAILABLE' : after));
                    if (after === TARGET_LEVERAGE) {
                        detail.ready = true;
                        detail.result = postError ? (uncertain(postError) ? 'PASS_POST_RESULT_UNKNOWN_BUT_VERIFIED' : 'PASS_POST_ERROR_BUT_VERIFIED') : 'PASS';
                    } else detail.result = postError && uncertain(postError) ? 'FAIL_LEVERAGE_CHANGE_STATE_UNKNOWN' : 'FAIL_LEVERAGE_VERIFY_FAILED';
                    var record = journal[journal.length - 1]; if (record && record.symbol === symbol) record.result = detail.result;
                    write('  RESULT=' + detail.result);
                }, function (readError) {
                    detail.result = postError && uncertain(postError) ? 'FAIL_LEVERAGE_CHANGE_STATE_UNKNOWN' : 'FAIL_LEVERAGE_VERIFY_FAILED';
                    var record = journal[journal.length - 1]; if (record && record.symbol === symbol) record.result = detail.result;
                    write('  leverageAfter=UNAVAILABLE'); write('  RESULT=' + detail.result);
                    write('  code=' + safeCode(readError)); write('  message=' + smokeModule.safeMessage(readError));
                });
            });
        });
        return sequence.then(function () {
            if (guard.getCount() > TARGET_SYMBOLS.length) {
                return finish('NOT_READY', 3, 'UNEXPECTED_MUTATION_COUNT');
            }
            var allReady = TARGET_SYMBOLS.every(function (symbol) { return details[symbol] && details[symbol].ready; });
            return finish(allReady ? 'READY' : 'NOT_READY', allReady ? 0 : 1);
        });
    }).catch(function (error) {
        write('FAIL ' + (error.code || 'ACCOUNT_INIT_INTERNAL_ERROR'));
        write('code=' + safeCode(error)); write('message=' + smokeModule.safeMessage(error));
        return finish('NOT_READY', error.exitCode === 3 ? 3 : 2, error.code || 'ACCOUNT_INIT_INTERNAL_ERROR');
    });
}

if (require.main === module) {
    runAccountInit().then(function (result) { process.exitCode = result.exitCode; }, function (error) {
        console.error('FAIL ACCOUNT_INIT_INTERNAL_ERROR'); console.error('message=' + smokeModule.safeMessage(error));
        console.log('MUTATING_API_CALL_COUNT=0'); console.log('ORDER_MUTATIONS=0');
        console.log('POSITION_MUTATIONS=0'); process.exitCode = 2;
    });
}

module.exports = { TARGET_LEVERAGE: TARGET_LEVERAGE, TARGET_SYMBOLS: TARGET_SYMBOLS,
    ALLOWED_MUTATION: ALLOWED_MUTATION, createMutationGuard: createMutationGuard,
    readAll: readAll, runAccountInit: runAccountInit };
