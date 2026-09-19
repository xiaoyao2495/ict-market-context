'use strict';

/**
 * CROSS_SOURCE_PATH_INTEGRITY_V1 shadow replay - PURE shared layer.
 *
 * Requires `fs` and `path` only. NO network module is reachable from here, so both the
 * network phase and the offline replay phase can depend on it without contaminating the
 * replay's module closure.
 *
 * Provides: frozen constants, the on-disk cache, bounded retry, and the series-completeness
 * verifier (§1).
 */

var fs = require('fs');
var path = require('path');

var VERSION = 'PATH_INTEGRITY_SERIES_INTEGRITY_V1';
var BAR_MS = 300000;
/** Frozen warmup: 1500 bars covers Dynamic-D's 432-bar survival window + the ATR14 seed. */
var WARMUP_BARS = 1500;
var DEFAULT_MAX_ATTEMPTS = 4;
var BACKOFF_MS = 1200;
var BACKOFF_CAP_MS = 15000;

function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

/** Last CLOSED 5m bar's closeTime, derived from the clock only (never an unclosed bar). */
function lastClosedBarCloseTime(now) {
    var t = now === undefined ? Date.now() : now;
    return Math.floor(t / BAR_MS) * BAR_MS - 1;
}

/** §1 window arithmetic: an exact N-day window of closed 5m bars ending at `endTime`. */
function windowFor(endTime, days) {
    // 12 five-minute bars per hour -> 288 per day.
    var bars = Math.round(days * 24 * 12);
    return { startTime: endTime - (bars - 1) * BAR_MS, endTime: endTime, bars: bars, days: days };
}

/**
 * §1 openTime of the bar `warmupBars` bars BEFORE the window's first bar.
 *
 * `window.startTime` is a closeTime (`t % BAR_MS === BAR_MS - 1`), so subtracting a bare
 * `warmupBars * BAR_MS` lands one millisecond off the openTime grid and silently loses the
 * oldest warmup bar. Anchor on the window's first openTime instead.
 */
function fetchStartFor(window, warmupBars) {
    var bars = warmupBars === undefined ? WARMUP_BARS : warmupBars;
    var firstWindowBarOpenTime = window.startTime - (BAR_MS - 1);
    return firstWindowBarOpenTime - bars * BAR_MS;
}

// ------------------------------------------------------------------ cache

function createCache(dir) {
    var cacheDir = dir || null;
    function file(key) { return path.join(cacheDir, key + '.json'); }
    return {
        enabled: function () { return !!cacheDir; },
        dir: function () { return cacheDir; },
        read: function (key) {
            if (!cacheDir) return null;
            try { return JSON.parse(fs.readFileSync(file(key), 'utf8')); }
            catch (error) { return null; }
        },
        write: function (key, value) {
            if (!cacheDir) return value;
            fs.mkdirSync(cacheDir, { recursive: true });
            fs.writeFileSync(file(key), JSON.stringify(value));
            return value;
        }
    };
}

// ------------------------------------------------------------------ retry

/**
 * Bounded retry (§1). The caller passes a task that already closes over a FIXED window,
 * so no attempt can silently change the requested range.
 * @returns {Promise<{ok:boolean, value:*, attempts:Array, error:string|null}>}
 */
function withRetry(label, maxAttempts, task) {
    var attempts = [];
    var limit = Math.max(1, maxAttempts || DEFAULT_MAX_ATTEMPTS);
    function attempt(n) {
        return Promise.resolve().then(task).then(function (value) {
            attempts.push({ attempt: n, ok: true, at: Date.now() });
            return { ok: true, value: value, attempts: attempts, error: null };
        }).catch(function (error) {
            var message = String((error && error.message) || error);
            attempts.push({ attempt: n, ok: false, at: Date.now(), error: message });
            if (n >= limit) return { ok: false, value: null, attempts: attempts, error: message };
            var backoff = Math.min(BACKOFF_CAP_MS, BACKOFF_MS * Math.pow(2, n - 1));
            console.error('[' + label + '] attempt ' + n + '/' + limit + ' failed (' + message +
                '), retry in ' + backoff + 'ms');
            return sleep(backoff).then(function () { return attempt(n + 1); });
        });
    }
    return attempt(1);
}

// -------------------------------------------------------------- integrity

/**
 * §1 completeness. A symbol is usable only when ALL of the following hold:
 *   - every bar came from the futures endpoint (never the spot mirror)
 *   - the series is a contiguous 5m sequence with no openTime gap
 *   - the audit window [startTime, endTime] is present bar for bar
 *   - at least `warmupBars` closed bars precede the window
 */
function verifySeries(candles, window, warmupBars) {
    var out = {
        barCount: candles ? candles.length : 0,
        futuresBars: 0, spotMirrorBars: 0, otherSourceBars: 0,
        gaps: [], windowBars: 0, windowBarsExpected: 0, warmupBars: 0,
        firstOpenTime: null, lastOpenTime: null, firstCloseTime: null, lastCloseTime: null,
        contiguous: false, windowComplete: false, warmupSufficient: false,
        futuresOnly: false, PASS: false, reason: null
    };
    if (!candles || candles.length === 0) { out.reason = 'EMPTY_SERIES'; return out; }
    var warmupNeeded = warmupBars === undefined ? WARMUP_BARS : warmupBars;
    out.firstOpenTime = candles[0].openTime;
    out.lastOpenTime = candles[candles.length - 1].openTime;
    out.firstCloseTime = candles[0].closeTime;
    out.lastCloseTime = candles[candles.length - 1].closeTime;

    candles.forEach(function (candle, index) {
        if (candle.source === 'futures') out.futuresBars += 1;
        else if (candle.source === 'spot-mirror' || candle.source === 'spot-fill') out.spotMirrorBars += 1;
        else out.otherSourceBars += 1;
        if (index > 0) {
            var step = candle.openTime - candles[index - 1].openTime;
            if (step !== BAR_MS && out.gaps.length < 20) {
                out.gaps.push({ afterOpenTime: candles[index - 1].openTime,
                    nextOpenTime: candle.openTime, stepMs: step });
            }
        }
        if (candle.closeTime >= window.startTime && candle.closeTime <= window.endTime) {
            out.windowBars += 1;
        }
        if (candle.closeTime < window.startTime) out.warmupBars += 1;
    });
    // The window is closed-bar inclusive at BOTH ends: closeTimes run from window.startTime
    // to window.endTime in BAR_MS steps, i.e. (endTime - startTime)/BAR_MS + 1 bars.
    // (Dividing `delta + 1` first truncates the trailing millisecond and under-counts by one.)
    out.windowBarsExpected = Math.round((window.endTime - window.startTime) / BAR_MS) + 1;
    out.contiguous = out.gaps.length === 0;
    out.futuresOnly = out.futuresBars === out.barCount;
    out.windowComplete = out.windowBars === out.windowBarsExpected;
    out.warmupSufficient = out.warmupBars >= warmupNeeded;
    out.PASS = out.contiguous && out.futuresOnly && out.windowComplete && out.warmupSufficient;
    if (!out.PASS) {
        if (!out.futuresOnly) out.reason = 'NON_FUTURES_SOURCE';
        else if (!out.contiguous) out.reason = 'SERIES_GAP';
        else if (!out.windowComplete) out.reason = 'WINDOW_INCOMPLETE';
        else out.reason = 'WARMUP_INSUFFICIENT';
    }
    return out;
}

// ------------------------------------------------------------ cache keys

function klinesCacheKey(symbol, fetchStart, endTime) {
    return 'klines-' + symbol + '-5m-' + fetchStart + '-' + endTime;
}
function rulesCacheKey(symbol) { return 'exchangeInfo-futures-' + symbol; }

/**
 * §1 rebuild a phase-1 result from the on-disk cache WITHOUT any network call.
 * Pure: `fs` reads only. Used by `--replayOnly`, which therefore never loads a network module.
 */
function loadPreparedFromCache(options) {
    var opts = options || {};
    var symbol = opts.symbol;
    var win = { startTime: opts.startTime, endTime: opts.endTime };
    var warmupBars = opts.warmupBars === undefined ? WARMUP_BARS : opts.warmupBars;
    var fetchStart = fetchStartFor(win, warmupBars);
    var result = { symbol: symbol, window: win, warmupBars: warmupBars, fetchStart: fetchStart,
        fetchEnd: win.endTime, attempts: [], symbolRules: null, quality: null,
        REPLAY_VALID: false, reason: null, fromCache: true };
    var klines = opts.cache ? opts.cache.read(klinesCacheKey(symbol, fetchStart, win.endTime)) : null;
    var rules = opts.cache ? opts.cache.read(rulesCacheKey(symbol)) : null;
    if (!klines || !klines.candles) { result.reason = 'CACHE_MISS_KLINES'; return result; }
    result.quality = verifySeries(klines.candles, win, warmupBars);
    if (!result.quality.PASS) {
        result.reason = 'DATA_INCOMPLETE_' + result.quality.reason;
        return result;
    }
    if (!rules || !rules.rules) { result.reason = 'CACHE_MISS_SYMBOL_RULES'; return result; }
    if (rules.rules.source !== 'futures') { result.reason = 'SYMBOL_RULES_NOT_FUTURES'; return result; }
    result.symbolRules = rules.rules;
    result.candles = klines.candles;
    result.REPLAY_VALID = true;
    return result;
}

module.exports = {
    VERSION: VERSION,
    BAR_MS: BAR_MS,
    WARMUP_BARS: WARMUP_BARS,
    DEFAULT_MAX_ATTEMPTS: DEFAULT_MAX_ATTEMPTS,
    sleep: sleep,
    lastClosedBarCloseTime: lastClosedBarCloseTime,
    windowFor: windowFor,
    fetchStartFor: fetchStartFor,
    createCache: createCache,
    withRetry: withRetry,
    verifySeries: verifySeries,
    klinesCacheKey: klinesCacheKey,
    rulesCacheKey: rulesCacheKey,
    loadPreparedFromCache: loadPreparedFromCache
};
