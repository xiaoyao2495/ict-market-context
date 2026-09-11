'use strict';

var fs = require('fs');
var path = require('path');

var VERSION = 'BINANCE_GLOBAL_RATE_LIMIT_GOVERNOR_V1';
var DEFAULT_MAX_CONCURRENCY = 4;
var DEFAULT_MIN_REQUEST_INTERVAL_MS = 100;
var DEFAULT_429_COOLDOWN_MS = 60000;
var DEFAULT_418_COOLDOWN_MS = 5 * 60000;
var DEFAULT_CORRUPT_STATE_COOLDOWN_MS = 60000;
var tempSequence = 0;

function finiteNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    var n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function headerValue(headers, name) {
    if (!headers) return null;
    if (typeof headers.get === 'function') {
        var viaGet = headers.get(name);
        if (viaGet !== undefined && viaGet !== null) return viaGet;
    }
    var target = String(name).toLowerCase();
    var keys = Object.keys(headers);
    for (var i = 0; i < keys.length; i++) {
        if (keys[i].toLowerCase() === target) return headers[keys[i]];
    }
    return null;
}

function parseRetryAfterMs(value, now) {
    if (value === undefined || value === null || value === '') return null;
    var seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
    var absolute = Date.parse(String(value));
    if (!Number.isFinite(absolute)) return null;
    return Math.max(0, absolute - now);
}

function parseBanUntil(message) {
    var text = String(message || '');
    var match = text.match(/(?:banned|ban)[^\d]{0,40}(?:until)?[^\d]{0,20}(\d{10,13})/i) ||
        text.match(/until[^\d]{0,20}(\d{10,13})/i);
    if (!match) return null;
    var value = Number(match[1]);
    if (!Number.isFinite(value)) return null;
    return match[1].length <= 10 ? value * 1000 : value;
}

function responseData(error) {
    return error && error.response && error.response.data || {};
}

function isRateLimitError(error) {
    var status = finiteNumber(error && (error.httpStatus !== undefined ? error.httpStatus :
        error.response && error.response.status));
    var data = responseData(error);
    var code = finiteNumber(error && error.binanceCode !== undefined ? error.binanceCode : data.code);
    return !!error && (error.code === 'BINANCE_RATE_LIMIT_BLOCKED_LOCALLY' ||
        status === 429 || status === 418 || code === -1003);
}

function localBlockedError(state, now) {
    var until = Number(state.blockedUntil);
    var error = new Error('BINANCE_RATE_LIMIT_BLOCKED_LOCALLY');
    error.code = 'BINANCE_RATE_LIMIT_BLOCKED_LOCALLY';
    error.dataSourceCode = 'DATA_SOURCE_RATE_LIMITED';
    error.blockedUntil = until;
    error.remainingMs = Math.max(0, until - now);
    error.rateLimitReason = state.reason || 'RATE_LIMIT';
    return error;
}

function initialState() {
    return {
        version: VERSION,
        blockedUntil: null,
        reason: null,
        last429At: null,
        last418At: null,
        lastRetryAfterMs: null,
        usedWeight1m: null,
        observedWeightLimit1m: null,
        lastRequestStartedAt: null
    };
}

function createGovernor(options) {
    var opts = options || {};
    var nowFn = opts.now || Date.now;
    var setTimer = opts.setTimeout || setTimeout;
    var clearTimer = opts.clearTimeout || clearTimeout;
    var logger = opts.logger || function (event) { console.warn(JSON.stringify(event)); };
    var statePath = opts.statePath || process.env.BINANCE_RATE_LIMIT_STATE_PATH ||
        path.join(__dirname, '..', '.live-state', 'binance-rate-limit-state.json');
    var maxConcurrency = finiteNumber(opts.maxConcurrency) || DEFAULT_MAX_CONCURRENCY;
    var minIntervalMs = opts.minRequestIntervalMs === 0 ? 0 :
        (finiteNumber(opts.minRequestIntervalMs) || DEFAULT_MIN_REQUEST_INTERVAL_MS);
    var cooldown429 = finiteNumber(opts.default429CooldownMs) || DEFAULT_429_COOLDOWN_MS;
    var cooldown418 = finiteNumber(opts.default418CooldownMs) || DEFAULT_418_COOLDOWN_MS;
    var corruptCooldown = finiteNumber(opts.corruptStateCooldownMs) || DEFAULT_CORRUPT_STATE_COOLDOWN_MS;
    var state = initialState();
    var queue = [];
    var inFlight = 0;
    var timer = null;
    var localBlockLoggedUntil = null;
    var weightLogLevel = null;

    function log(type, meta, extra) {
        var event = Object.assign({ event: type, timestamp: new Date(nowFn()).toISOString(),
            endpointCategory: meta && (meta.category || meta.endpoint) || 'UNKNOWN',
            httpStatus: null, binanceCode: null, usedWeight1m: state.usedWeight1m,
            blockedUntil: state.blockedUntil }, extra || {});
        try { logger(event); } catch (ignore) {}
    }

    function persist() {
        var dir = path.dirname(statePath);
        fs.mkdirSync(dir, { recursive: true });
        var tmp = statePath + '.' + process.pid + '.' + (++tempSequence) + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 384 });
        fs.renameSync(tmp, statePath);
    }

    function mergePersistent(parsed) {
        if (!parsed || parsed.version !== VERSION) throw new Error('RATE_LIMIT_STATE_SCHEMA_INVALID');
        var diskUntil = finiteNumber(parsed.blockedUntil);
        var memoryUntil = finiteNumber(state.blockedUntil);
        if (diskUntil !== null && (memoryUntil === null || diskUntil > memoryUntil)) {
            state.blockedUntil = diskUntil;
            state.reason = parsed.reason || state.reason;
        }
        ['last429At', 'last418At', 'lastRetryAfterMs', 'usedWeight1m',
            'observedWeightLimit1m', 'lastRequestStartedAt'].forEach(function (key) {
            if (parsed[key] !== undefined && parsed[key] !== null) state[key] = parsed[key];
        });
    }

    function loadPersistent(failSafeOnCorrupt) {
        try {
            if (!fs.existsSync(statePath)) return;
            mergePersistent(JSON.parse(fs.readFileSync(statePath, 'utf8')));
        } catch (error) {
            if (!failSafeOnCorrupt) return;
            var now = nowFn();
            state = initialState();
            state.blockedUntil = now + corruptCooldown;
            state.reason = 'STATE_CORRUPT';
            persist();
            log('BINANCE_RATE_LIMIT_BLOCKED_LOCAL', { category: 'STATE_RESTORE' }, {
                reason: state.reason, stateCorrupt: true
            });
        }
    }

    function recoverIfExpired(meta) {
        var now = nowFn();
        if (state.blockedUntil !== null && now >= state.blockedUntil) {
            var previousReason = state.reason;
            state.blockedUntil = null;
            state.reason = null;
            localBlockLoggedUntil = null;
            persist();
            log('BINANCE_RATE_LIMIT_RECOVERED', meta, { reason: previousReason });
        }
    }

    function currentBlock(meta) {
        loadPersistent(true);
        recoverIfExpired(meta);
        if (state.blockedUntil !== null && nowFn() < state.blockedUntil) {
            if (localBlockLoggedUntil !== state.blockedUntil) {
                localBlockLoggedUntil = state.blockedUntil;
                log('BINANCE_RATE_LIMIT_BLOCKED_LOCAL', meta, { reason: state.reason,
                    remainingMs: state.blockedUntil - nowFn() });
            }
            return localBlockedError(state, nowFn());
        }
        return null;
    }

    function rejectQueued() {
        var blocked = localBlockedError(state, nowFn());
        while (queue.length) queue.shift().reject(blocked);
        if (timer) { clearTimer(timer); timer = null; }
    }

    function applyBlock(until, reason, status, code, retryAfterMs, meta) {
        var existing = finiteNumber(state.blockedUntil);
        state.blockedUntil = existing === null ? until : Math.max(existing, until);
        state.reason = reason;
        state.lastRetryAfterMs = retryAfterMs;
        if (status === 429) state.last429At = nowFn();
        if (status === 418) state.last418At = nowFn();
        persist();
        log(status === 418 ? 'BINANCE_RATE_LIMIT_418' : 'BINANCE_RATE_LIMIT_429', meta, {
            httpStatus: status, binanceCode: code, reason: reason, retryAfterMs: retryAfterMs
        });
        rejectQueued();
    }

    function observeResponse(response, meta) {
        var headers = response && response.headers;
        var used = finiteNumber(headerValue(headers, 'x-mbx-used-weight-1m'));
        if (used !== null) state.usedWeight1m = used;
        var limits = response && response.data && response.data.rateLimits;
        if (Array.isArray(limits)) {
            limits.forEach(function (limit) {
                if (limit && limit.rateLimitType === 'REQUEST_WEIGHT' && limit.interval === 'MINUTE' &&
                        Number(limit.intervalNum || 1) === 1 && finiteNumber(limit.limit) !== null) {
                    state.observedWeightLimit1m = Number(limit.limit);
                }
            });
        }
        if (state.usedWeight1m !== null && state.observedWeightLimit1m) {
            var ratio = state.usedWeight1m / state.observedWeightLimit1m;
            var level = ratio >= 0.95 ? '95' : ratio >= 0.90 ? '90' : ratio >= 0.80 ? '80' : null;
            if (level && level !== weightLogLevel) {
                weightLogLevel = level;
                log('BINANCE_RATE_LIMIT_WEIGHT_HIGH', meta, { ratio: ratio });
            } else if (!level) weightLogLevel = null;
        }
    }

    function observeError(error, meta) {
        var response = error && error.response;
        observeResponse(response, meta);
        if (!isRateLimitError(error) || error.code === 'BINANCE_RATE_LIMIT_BLOCKED_LOCALLY') return;
        var status = finiteNumber(response && response.status);
        var data = responseData(error);
        var code = finiteNumber(data.code);
        var retryAfterMs = parseRetryAfterMs(headerValue(response && response.headers, 'retry-after'), nowFn());
        var explicitBan = parseBanUntil(data.msg);
        var fallback = status === 418 || (status !== 429 && code === -1003) ? cooldown418 : cooldown429;
        var appliedRetryMs = retryAfterMs;
        if (appliedRetryMs === null && explicitBan === null) appliedRetryMs = fallback;
        var retryUntil = appliedRetryMs === null ? null : nowFn() + appliedRetryMs;
        var until = explicitBan === null ? retryUntil : retryUntil === null ? explicitBan : Math.max(explicitBan, retryUntil);
        var reason = status === 418 ? 'HTTP_418' : status === 429 ? 'HTTP_429' : 'BINANCE_-1003';
        applyBlock(until, reason, status, code, appliedRetryMs, meta);
    }

    function drain() {
        if (timer || queue.length === 0) return;
        var blocked = currentBlock(queue[0] && queue[0].meta);
        if (blocked) { rejectQueued(); return; }
        while (queue.length > 0 && inFlight < maxConcurrency) {
            var now = nowFn();
            var previousStart = finiteNumber(state.lastRequestStartedAt);
            var wait = previousStart === null ? 0 : Math.max(0, previousStart + minIntervalMs - now);
            if (wait > 0) {
                timer = setTimer(function () { timer = null; drain(); }, wait);
                return;
            }
            var item = queue.shift();
            inFlight += 1;
            state.lastRequestStartedAt = now;
            (function (active) {
                Promise.resolve().then(active.transportCall).then(function (response) {
                    try {
                        observeResponse(response, active.meta);
                        active.resolve(response);
                    } catch (error) {
                        active.reject(error);
                    }
                }, function (error) {
                    try {
                        observeError(error, active.meta);
                        active.reject(error);
                    } catch (governorError) {
                        governorError.cause = error;
                        active.reject(governorError);
                    }
                }).then(function finalize() {
                    inFlight -= 1;
                    drain();
                }, function finalizeAfterError() {
                    inFlight -= 1;
                    drain();
                });
            }(item));
            if (minIntervalMs > 0 && queue.length > 0) {
                timer = setTimer(function () { timer = null; drain(); }, minIntervalMs);
                return;
            }
        }
    }

    function execute(meta, transportCall) {
        var blocked = currentBlock(meta);
        if (blocked) return Promise.reject(blocked);
        return new Promise(function (resolve, reject) {
            queue.push({ meta: meta || {}, transportCall: transportCall, resolve: resolve, reject: reject });
            drain();
        });
    }

    loadPersistent(true);

    return {
        version: VERSION,
        execute: execute,
        getState: function () { return Object.assign({}, state, { inFlight: inFlight, queued: queue.length }); },
        statePath: statePath,
        maxConcurrency: maxConcurrency,
        minRequestIntervalMs: minIntervalMs
    };
}

var globalGovernor = createGovernor();

module.exports = {
    VERSION: VERSION,
    DEFAULT_MAX_CONCURRENCY: DEFAULT_MAX_CONCURRENCY,
    DEFAULT_MIN_REQUEST_INTERVAL_MS: DEFAULT_MIN_REQUEST_INTERVAL_MS,
    DEFAULT_429_COOLDOWN_MS: DEFAULT_429_COOLDOWN_MS,
    DEFAULT_418_COOLDOWN_MS: DEFAULT_418_COOLDOWN_MS,
    createGovernor: createGovernor,
    globalGovernor: globalGovernor,
    isRateLimitError: isRateLimitError,
    parseRetryAfterMs: parseRetryAfterMs,
    parseBanUntil: parseBanUntil
};
