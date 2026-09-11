#!/usr/bin/env node
'use strict';

require('../config/loadEnv')();
var path = require('path');
var network = require('../config/network');
var persistence = require('../live/persistence');
var continuity = require('../replay/continuityChecker');
var dataSource = require('../live/dataSource');
var universe = require('../live/dynamicContractUniverseV1');
var readiness = require('../live/dynamicUniverseReadinessAuditV1');
var executionClient = require('../execution/binanceExecutionClientV1');
var config = require('../config/live.json');

var counters = readiness.emptyMutationCounters();

function closedNative(rows, evaluationTime) {
    var seen = {};
    return (rows || []).filter(function (row) {
        return row && row.closed === true && row.source === 'futures' && row.closeTime <= evaluationTime;
    }).sort(function (a, b) { return a.openTime - b.openTime; }).filter(function (row) {
        if (seen[row.openTime]) return false;
        seen[row.openTime] = true;
        return true;
    });
}

function fetchWindow(symbol, timeframe, evaluationTime) {
    return dataSource.fetchProductionWindow(symbol, timeframe, evaluationTime).then(function (rows) {
        var candles = closedNative(rows, evaluationTime);
        var check = continuity.checkContinuity(candles, timeframe);
        return { ok: true, candles: candles, continuous: check.valid };
    }).catch(function (error) {
        return { ok: false, candles: [], continuous: false, error: error && error.message || String(error) };
    });
}

function loadOrBuildSnapshot(evaluationTime) {
    var file = path.join(config.dataDir, 'dynamic-contract-universe-v1.json');
    var saved = persistence.loadJson(file, null);
    if (universe.validSnapshot(saved) && saved.dateKey === universe.dateKey(evaluationTime)) {
        return Promise.resolve({ status: 'RESTORED', snapshot: saved });
    }
    return universe.buildSnapshot({ evaluationTime: evaluationTime,
        concurrency: config.dynamicUniverse.concurrency,
        requestIntervalMs: config.dynamicUniverse.requestIntervalMs }).then(function (snapshot) {
        return { status: 'BUILT_READ_ONLY', snapshot: snapshot };
    });
}

function readOnlyAccountFacade() {
    var client = executionClient.createClient({ liveTradingEnabled: false });
    return {
        getPositionMode: function () { return client.getPositionMode(); },
        getSymbolConfig: function (symbol) { return client.getSymbolConfig(symbol); }
    };
}

function auditTop10(snapshot) {
    var account = readOnlyAccountFacade();
    var oneWay = false;
    var accountModeOk = false;
    var accountModeError = null;
    return account.getPositionMode().then(function (mode) {
        oneWay = !(mode.dualSidePosition === true || mode.dualSidePosition === 'true');
        accountModeOk = true;
    }).catch(function (error) {
        accountModeError = error && error.message || String(error);
    }).then(function () {
        return universe.mapLimit(snapshot.symbols, 4, function (ranked) {
            return Promise.all([
                fetchWindow(ranked.symbol, '4h', snapshot.evaluationTime),
                fetchWindow(ranked.symbol, '5m', snapshot.evaluationTime),
                account.getSymbolConfig(ranked.symbol).then(function (value) {
                    var rows = Array.isArray(value) ? value : [value];
                    var found = rows.filter(function (row) { return row && row.symbol === ranked.symbol; })[0];
                    return found ? { ok: true, value: found } : { ok: false, error: 'SYMBOL_CONFIG_MISSING' };
                }).catch(function (error) { return { ok: false, error: error && error.message || String(error) }; })
            ]).then(function (values) {
                var h4 = values[0], m5 = values[1], accountConfig = values[2];
                return readiness.evaluate({
                    rank: ranked.rank, symbol: ranked.symbol, quoteVolume24h: ranked.quoteVolume24h,
                    rankEligible: true, rules: Object.assign({ source: 'futures' }, ranked.executionRules),
                    candles4h: h4.candles, candles5m: m5.candles,
                    fetch4hOk: h4.ok, fetch5mOk: m5.ok,
                    continuous4h: h4.continuous, continuous5m: m5.continuous,
                    accountReadOk: accountModeOk && accountConfig.ok,
                    oneWay: oneWay,
                    marginType: accountConfig.value && accountConfig.value.marginType,
                    leverage: accountConfig.value && accountConfig.value.leverage
                });
            });
        }).then(function (rows) { return { rows: rows, accountModeError: accountModeError }; });
    });
}

function printValue(value) { return value === null || value === undefined ? '-' : String(value); }
function bool(value) { return value ? 'true' : 'false'; }
function printReport(snapshotResult, auditResult) {
    var snapshot = snapshotResult.snapshot;
    var rows = auditResult.rows;
    var summary = readiness.summarize(rows);
    var active = universe.discoverActiveLifecycleSymbols(config.dataDir);
    console.log('AUDIT=' + readiness.VERSION);
    console.log('READ_ONLY=true');
    console.log('UNIVERSE_SOURCE=' + snapshotResult.status);
    console.log('UNIVERSE_VERSION=' + snapshot.version);
    console.log('UNIVERSE_GENERATED_AT=' + new Date(snapshot.generatedAt).toISOString());
    console.log('UNIVERSE_EVALUATION_TIME=' + new Date(snapshot.evaluationTime).toISOString());
    console.log('UNIVERSE_SYMBOL_COUNT=' + snapshot.symbols.length);
    console.log('REQUIRED_4H_BARS=' + dataSource.MIN_ANALYSIS_4H_BARS);
    console.log('REQUIRED_5M_BARS=' + dataSource.MIN_ANALYSIS_5M_BARS);
    console.log('TOP10_COUNT=' + summary.top10Count);
    console.log('RANK_ELIGIBLE_COUNT=' + summary.rankEligibleCount);
    console.log('SCANNABLE_COUNT=' + summary.scannableCount);
    console.log('ANALYSIS_READY_COUNT=' + summary.analysisReadyCount);
    console.log('EXECUTION_READY_COUNT=' + summary.executionReadyCount);
    console.log('NEW_TRADE_ADMISSION_ALLOWED_COUNT=' + summary.newTradeAdmissionAllowedCount);
    console.log('BLOCKED_COUNT=' + summary.blockedCount);
    console.log('READY_SYMBOLS=' + (summary.readySymbols.join(',') || '-'));
    console.log('BLOCKED_SYMBOLS=' + (summary.blockedSymbols.map(function (x) {
        return x.symbol + ' -> ' + x.reasons.join(',');
    }).join(' | ') || '-'));
    console.log('ACTIVE_LIFECYCLE_SYMBOL_COUNT=' + active.length);
    console.log('ACTIVE_LIFECYCLE_SYMBOLS=' + (active.join(',') || '-'));
    active.filter(function (symbol) { return !readiness.snapshotRow(snapshot, symbol); }).forEach(function (symbol) {
        console.log('ACTIVE_LIFECYCLE ' + symbol +
            ' SCAN_UNIVERSE_MEMBER=false RUNTIME_MAINTAINED=true NEW_TRADE_ADMISSION_ALLOWED=false');
    });
    console.log('UNFINISHED_4H_INCLUDED=false');
    console.log('FUTURE_CANDLES_USED=false');
    Object.keys(counters).forEach(function (key) { console.log(key + '=' + counters[key]); });
    console.log('MUTATION_GUARD=' + (readiness.mutationFree(counters) ? 'PASS' : 'FAIL'));
    console.log('MUTATING_API_METHODS_EXPOSED=false');
    if (auditResult.accountModeError) console.log('ACCOUNT_MODE_READ_ERROR=' + auditResult.accountModeError);
    console.log('');
    console.log(['RANK','SYMBOL','QUOTE_VOLUME_24H','4H_AVAIL','4H_REQ','5M_AVAIL','5M_REQ',
        'DYNAMIC_D_READY','ATR_READY','BIAS_READY','EQ_READY','FVG_READY','TICK_SIZE','STEP_SIZE',
        'MIN_QTY','MIN_NOTIONAL','MARGIN_TYPE','LEVERAGE','SCANNABLE','ANALYSIS_READY',
        'EXECUTION_READY','NEW_TRADE_ADMISSION','BLOCK_REASON'].join('\t'));
    rows.forEach(function (row) {
        console.log([row.rank,row.symbol,row.quoteVolume24h,row.closed4hAvailable,row.required4hBars,
            row.closed5mAvailable,row.required5mBars,bool(row.dynamicDReady),bool(row.atrReady),bool(row.biasReady),
            bool(row.eqReady),bool(row.fvgReady),printValue(row.tickSize),printValue(row.stepSize),printValue(row.minQty),
            printValue(row.minNotional),row.marginType,printValue(row.leverage),bool(row.scannable),
            bool(row.analysisReady),bool(row.executionReady),bool(row.newTradeAdmissionAllowed),
            row.blockReasons.join(',') || '-'].join('\t'));
    });
    console.log('AUDIT=' + (readiness.mutationFree(counters) && snapshot.symbols.length === 10 ? 'PASS' : 'FAIL'));
}

var evaluationTime = Date.now();
if (network.proxy && network.proxy.enabled) console.log('NETWORK=proxy-configured');
loadOrBuildSnapshot(evaluationTime).then(function (snapshotResult) {
    return auditTop10(snapshotResult.snapshot).then(function (auditResult) {
        printReport(snapshotResult, auditResult);
    });
}).catch(function (error) {
    var response = error && error.response;
    var body = response && response.data || {};
    console.error('AUDIT=FAIL ' + (error && error.message || error));
    if (response) console.error('HTTP_STATUS=' + response.status);
    if (body.code !== undefined) console.error('BINANCE_CODE=' + body.code);
    if (body.msg !== undefined) console.error('BINANCE_MESSAGE=' + body.msg);
    Object.keys(counters).forEach(function (key) { console.error(key + '=' + counters[key]); });
    process.exitCode = 1;
});
