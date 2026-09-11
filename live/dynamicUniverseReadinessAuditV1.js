'use strict';

var universe = require('./dynamicContractUniverseV1');
var dataSource = require('./dataSource');

var VERSION = 'DYNAMIC_UNIVERSE_READINESS_AUDIT_V1';
var MUTATION_KEYS = [
    'ORDER_PLACE_MUTATIONS', 'ORDER_CANCEL_MUTATIONS', 'ALGO_CREATE_MUTATIONS',
    'ALGO_CANCEL_MUTATIONS', 'POSITION_CLOSE_MUTATIONS', 'LEVERAGE_MUTATIONS',
    'MARGIN_MODE_MUTATIONS', 'POSITION_MODE_MUTATIONS'
];

function emptyMutationCounters() {
    var out = {};
    MUTATION_KEYS.forEach(function (key) { out[key] = 0; });
    out.REAL_ORDER_MUTATIONS = 0;
    out.ACCOUNT_MUTATIONS = 0;
    return out;
}

function closedCount(rows) {
    return (rows || []).filter(function (row) { return row && row.closed === true; }).length;
}

function evaluate(input) {
    var x = input || {};
    var rankEligible = x.rankEligible === true;
    var rulesReady = dataSource.executionRulesReady(x.rules);
    var h = dataSource.analysisHistoryStatus({ '4h': x.candles4h || [], '5m': x.candles5m || [] });
    var fetchReady = x.fetch4hOk === true && x.fetch5mOk === true &&
        closedCount(x.candles4h) > 0 && closedCount(x.candles5m) > 0;
    var continuityReady = x.continuous4h !== false && x.continuous5m !== false;
    var scannable = rankEligible && rulesReady && fetchReady && continuityReady;
    var accountModeReady = x.accountReadOk === true && x.oneWay === true;
    var marginTypeReady = x.accountReadOk === true && String(x.marginType || '').toUpperCase() === 'CROSSED';
    var leverageReady = x.accountReadOk === true && Number(x.leverage) === 10;
    var analysisReady = h.biasReady && h.dynamicDReady && h.atrReady && h.eqReady && h.fvgReady;
    var executionReady = rankEligible && scannable && analysisReady && rulesReady &&
        accountModeReady && marginTypeReady && leverageReady;
    var reasons = [];
    if (!rankEligible) reasons.push('NOT_IN_TODAY_UNIVERSE');
    if (!fetchReady) reasons.push('DATA_FETCH_FAILED');
    if (fetchReady && !continuityReady) reasons.push('MARKET_DATA_GAP');
    if (!rulesReady) reasons.push('MARKET_RULES_MISSING');
    if (!h.biasReady) reasons.push('INSUFFICIENT_4H_HISTORY');
    if (!h.dynamicDReady || !h.eqReady || !h.atrReady || !h.fvgReady) reasons.push('INSUFFICIENT_5M_HISTORY');
    if (x.accountReadOk !== true) reasons.push('ACCOUNT_CONFIG_NOT_READY');
    else {
        if (!accountModeReady) reasons.push('ACCOUNT_MODE_NOT_READY');
        if (!marginTypeReady) reasons.push('MARGIN_TYPE_NOT_CROSSED');
        if (!leverageReady) reasons.push('LEVERAGE_NOT_10');
    }
    return {
        rank: x.rank || null,
        symbol: x.symbol,
        quoteVolume24h: Number(x.quoteVolume24h) || 0,
        rankEligible: rankEligible,
        scannable: scannable,
        analysisReady: analysisReady,
        executionReady: executionReady,
        newTradeAdmissionAllowed: rankEligible && executionReady,
        runtimeMaintained: rankEligible || x.activeLifecycle === true,
        activeLifecycle: x.activeLifecycle === true,
        closed4hAvailable: closedCount(x.candles4h),
        closed5mAvailable: closedCount(x.candles5m),
        required4hBars: h.required4hBars,
        required5mBars: h.required5mBars,
        dynamicDReady: h.dynamicDReady,
        atrReady: h.atrReady,
        biasReady: h.biasReady,
        eqReady: h.eqReady,
        fvgReady: h.fvgReady,
        rangeReady: h.rangeReady,
        rulesReady: rulesReady,
        tickSize: x.rules && x.rules.tickSize,
        stepSize: x.rules && x.rules.stepSize,
        minQty: x.rules && x.rules.minQty,
        minNotional: x.rules && x.rules.minNotional,
        accountMode: x.accountReadOk === true ? (x.oneWay ? 'ONE_WAY' : 'HEDGE') : 'UNAVAILABLE',
        marginType: x.accountReadOk === true ? x.marginType : 'UNAVAILABLE',
        leverage: x.accountReadOk === true ? Number(x.leverage) : null,
        accountModeReady: accountModeReady,
        marginTypeReady: marginTypeReady,
        leverageReady: leverageReady,
        blockReasons: reasons
    };
}

function summarize(rows) {
    var top = (rows || []).filter(function (row) { return row.rankEligible; });
    return {
        top10Count: top.length,
        rankEligibleCount: top.filter(function (r) { return r.rankEligible; }).length,
        scannableCount: top.filter(function (r) { return r.scannable; }).length,
        analysisReadyCount: top.filter(function (r) { return r.analysisReady; }).length,
        executionReadyCount: top.filter(function (r) { return r.executionReady; }).length,
        newTradeAdmissionAllowedCount: top.filter(function (r) { return r.newTradeAdmissionAllowed; }).length,
        blockedCount: top.filter(function (r) { return !r.executionReady; }).length,
        readySymbols: top.filter(function (r) { return r.executionReady; }).map(function (r) { return r.symbol; }),
        blockedSymbols: top.filter(function (r) { return !r.executionReady; }).map(function (r) {
            return { symbol: r.symbol, reasons: r.blockReasons.slice() };
        })
    };
}

function mutationFree(counters) {
    return Object.keys(counters || {}).every(function (key) { return Number(counters[key]) === 0; });
}

function snapshotRow(snapshot, symbol) {
    return (snapshot && snapshot.symbols || []).filter(function (row) { return row.symbol === symbol; })[0] || null;
}

module.exports = {
    VERSION: VERSION,
    MUTATION_KEYS: MUTATION_KEYS,
    emptyMutationCounters: emptyMutationCounters,
    evaluate: evaluate,
    summarize: summarize,
    mutationFree: mutationFree,
    snapshotRow: snapshotRow,
    runtimeSymbols: universe.runtimeSymbols
};
