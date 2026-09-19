'use strict';

/**
 * CROSS_SOURCE_PATH_INTEGRITY_V1 shadow replay - PHASE 1, the ONLY network module.
 *
 * §1 network/offline separation: this file is the single place in the replay that touches the
 * network. It downloads exactly what phase 2 needs, verifies it, and caches it on disk. The
 * replay (`offlineReplayV1.js`) never requires this file, `binanceRest`,
 * `binanceHttpTransportV1` or `axios`, and the entry script asserts that at runtime - the
 * strongest form being two separate processes (`--networkOnly` then `--replayOnly`).
 *
 * PUBLIC market data only: /fapi/v1/klines and /fapi/v1/exchangeInfo.
 *   - no api key, no signing, no private endpoint, no order route is named anywhere here
 *
 * Bounded retry (§1/§5):
 *   - `maxAttempts` per symbol, exponential backoff, hard ceiling
 *   - the fetch window is computed once and never recomputed inside the retry loop
 *   - a failed attempt writes nothing, so a retry re-downloads exactly the same range
 *   - a symbol whose data is still incomplete is reported REPLAY_INVALID and its statistics
 *     are never used
 */

var flowData = require('../../../research/two-bar-flow-audit-v1/lib/flowDataClientV1');
var binanceRest = require('../../../data/binanceRest');
var series = require('./seriesIntegrityV1');

var VERSION = 'PATH_INTEGRITY_NETWORK_PREP_V1';
var BAR_MS = series.BAR_MS;
var WARMUP_BARS = series.WARMUP_BARS;
var FUTURES_EXCHANGE_INFO_URL = 'https://fapi.binance.com/fapi/v1/exchangeInfo';

/**
 * §1 keep a transient proxy/agent fault from killing the run (the previous attempt died with
 * `agent-base` `onerror` -> EXIT=1). Every incident is recorded and reported; completeness of the
 * DATA - not the absence of exceptions - is the real gate.
 */
function installNetworkGuard() {
    var incidents = [];
    function onUncaught(error) {
        incidents.push({ at: Date.now(), kind: 'uncaughtException',
            message: String((error && error.message) || error) });
        console.error('[network-guard] swallowed transient error: ' +
            String((error && error.message) || error));
    }
    function onRejection(reason) {
        incidents.push({ at: Date.now(), kind: 'unhandledRejection',
            message: String((reason && reason.message) || reason) });
        console.error('[network-guard] swallowed transient rejection: ' +
            String((reason && reason.message) || reason));
    }
    process.on('uncaughtException', onUncaught);
    process.on('unhandledRejection', onRejection);
    return {
        incidents: incidents,
        release: function () {
            process.removeListener('uncaughtException', onUncaught);
            process.removeListener('unhandledRejection', onRejection);
            return incidents;
        }
    };
}

/** Futures-only symbol rules: `binanceRest.getExchangeInfo` may fall back to the spot mirror,
 *  so the futures document is fetched directly and parsed explicitly (§1 data purity). */
function fetchFuturesSymbolRules(symbol) {
    return flowData.requestPublic(FUTURES_EXCHANGE_INFO_URL, {})
        .then(function (data) { return binanceRest.parseExchangeInfo(data, symbol, 'futures'); });
}

function klinesCacheKey(symbol, fetchStart, endTime) {
    return series.klinesCacheKey(symbol, fetchStart, endTime);
}
function rulesCacheKey(symbol) { return series.rulesCacheKey(symbol); }

/**
 * Download and verify one symbol's 2D window.
 * @param {Object} options { symbol, startTime, endTime, cache, maxAttempts, warmupBars }
 */
function prepareSymbol(options) {
    var opts = options || {};
    var symbol = opts.symbol;
    var win = { startTime: opts.startTime, endTime: opts.endTime };
    var warmupBars = opts.warmupBars === undefined ? WARMUP_BARS : opts.warmupBars;
    var fetchStart = series.fetchStartFor(win, warmupBars);
    var result = { symbol: symbol, version: VERSION, window: win, warmupBars: warmupBars,
        fetchStart: fetchStart, fetchEnd: win.endTime, attempts: [], symbolRules: null,
        quality: null, REPLAY_VALID: false, reason: null };

    console.log('[' + symbol + '] network phase: 5m klines ' + new Date(fetchStart).toISOString() +
        ' -> ' + new Date(win.endTime).toISOString());

    // `fetchStart` / `win.endTime` are captured above and never recomputed, so every retry walks
    // exactly the same range (§1: the window must not change on retry).
    return series.withRetry(symbol + ' klines', opts.maxAttempts, function () {
        return flowData.fetchKlines(symbol, '5m', fetchStart, win.endTime, opts.cache);
    }).then(function (klines) {
        result.attempts = klines.attempts;
        if (!klines.ok) {
            result.quality = series.verifySeries([], win, warmupBars);
            result.reason = 'KLINES_UNAVAILABLE';
            return result;
        }
        result.quality = series.verifySeries(klines.value, win, warmupBars);
        if (!result.quality.PASS) {
            result.reason = 'DATA_INCOMPLETE_' + result.quality.reason;
            return result;
        }
        return series.withRetry(symbol + ' exchangeInfo', opts.maxAttempts, function () {
            var cached = opts.cache ? opts.cache.read(rulesCacheKey(symbol)) : null;
            if (cached && cached.rules) return cached.rules;
            return fetchFuturesSymbolRules(symbol).then(function (rules) {
                if (opts.cache) opts.cache.write(rulesCacheKey(symbol), { rules: rules });
                return rules;
            });
        }).then(function (info) {
            result.attempts = result.attempts.concat(info.attempts);
            if (!info.ok) { result.reason = 'SYMBOL_RULES_UNAVAILABLE'; return result; }
            if (info.value.source !== 'futures') {
                // A spot-mirror tickSize must never masquerade as futures rules.
                result.reason = 'SYMBOL_RULES_NOT_FUTURES';
                return result;
            }
            result.symbolRules = info.value;
            result.candles = klines.value;
            result.REPLAY_VALID = true;
            return result;
        });
    }).catch(function (error) {
        result.reason = 'NETWORK_PHASE_ERROR';
        result.error = String((error && error.message) || error);
        if (!result.quality) result.quality = series.verifySeries([], win, warmupBars);
        return result;
    });
}

/**
 * Pure re-export: `--replayOnly` calls `series.loadPreparedFromCache` directly so that the offline
 * phase never loads this module (and therefore never loads the network stack).
 */
function loadPreparedFromCache(options) {
    return series.loadPreparedFromCache(options);
}

module.exports = {
    VERSION: VERSION,
    BAR_MS: BAR_MS,
    WARMUP_BARS: WARMUP_BARS,
    FUTURES_EXCHANGE_INFO_URL: FUTURES_EXCHANGE_INFO_URL,
    installNetworkGuard: installNetworkGuard,
    fetchFuturesSymbolRules: fetchFuturesSymbolRules,
    klinesCacheKey: klinesCacheKey,
    rulesCacheKey: rulesCacheKey,
    prepareSymbol: prepareSymbol,
    loadPreparedFromCache: loadPreparedFromCache
};
