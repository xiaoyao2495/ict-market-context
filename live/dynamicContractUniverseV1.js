'use strict';

var fs = require('fs');
var path = require('path');
var binanceRest = require('../data/binanceRest');
var persistence = require('./persistence');

var VERSION = 'DYNAMIC_CONTRACT_UNIVERSE_V1';
// TWO_BAR_PRODUCTION_REPLACEMENT_V1 §3: the new-opportunity universe is TOP 5.
// This only controls NEW setup detection / NEW entries; symbols that already hold
// a pending order or an open position keep being managed outside this universe.
var TOP_N = 5;
var RANK_TIMEFRAME = '4h';
var RANK_CLOSED_BARS = 6;
var REFRESH_HOUR_UTC = 0;
var REFRESH_MINUTE_UTC = 5;
var DEFAULT_CONCURRENCY = 8;
var DEFAULT_REQUEST_INTERVAL_MS = 200;

function dateKey(ms) { return new Date(ms).toISOString().slice(0, 10); }

function eligibleContracts(symbols) {
    return (symbols || []).filter(function (s) {
        return s && s.status === 'TRADING' && s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT';
    });
}

function symbolRules(info) {
    var parsed = binanceRest.parseExchangeInfo({ symbols: [info] }, info.symbol, 'futures');
    return {
        tickSize: parsed.tickSize,
        stepSize: parsed.stepSize,
        minQty: parsed.minQty,
        minNotional: parsed.minNotional
    };
}

function rulesReady(rules) {
    return !!rules && rules.tickSize > 0 && rules.stepSize > 0 && rules.minQty > 0 && rules.minNotional > 0;
}

function configMatchesContract(config) {
    var cfg = config || {};
    return cfg.version === VERSION && Number(cfg.topN) === TOP_N &&
        cfg.rankTimeframe === RANK_TIMEFRAME && Number(cfg.rankClosedBars) === RANK_CLOSED_BARS &&
        Number(cfg.refreshHourUTC) === REFRESH_HOUR_UTC && Number(cfg.refreshMinuteUTC) === REFRESH_MINUTE_UTC &&
        Number.isFinite(Number(cfg.concurrency)) && Number(cfg.concurrency) > 0 &&
        Number.isFinite(Number(cfg.requestIntervalMs)) && Number(cfg.requestIntervalMs) > 0;
}

function latestClosedWindow(candles, evaluationTime) {
    var seen = {};
    var closed = (candles || []).filter(function (c) {
        return c && c.closed !== false && Number(c.closeTime) <= evaluationTime;
    }).sort(function (a, b) { return a.openTime - b.openTime; }).filter(function (c) {
        if (seen[c.openTime]) return false;
        seen[c.openTime] = true;
        return true;
    });
    return closed.slice(-RANK_CLOSED_BARS);
}

function rankWindowContinuous(window) {
    if (!window || window.length !== RANK_CLOSED_BARS) return false;
    for (var i = 1; i < window.length; i++) {
        if (window[i].openTime - window[i - 1].openTime !== 4 * 60 * 60 * 1000) return false;
    }
    return true;
}

function rankRows(rows, topN) {
    return (rows || []).filter(function (row) { return row.rankEligible === true; })
        .slice().sort(function (a, b) {
            var volumeOrder = b.quoteVolume24h - a.quoteVolume24h;
            if (volumeOrder) return volumeOrder;
            return a.symbol < b.symbol ? -1 : (a.symbol > b.symbol ? 1 : 0);
        }).slice(0, topN || TOP_N).map(function (row, index) {
            return Object.assign({}, row, { rank: index + 1 });
        });
}

function mapLimit(items, limit, worker) {
    var laneLimit = Math.max(1, Math.floor(Number(limit) || 1));
    var results = new Array(items.length), cursor = 0;
    function lane() {
        function next() {
            if (cursor >= items.length) return Promise.resolve();
            var index = cursor++;
            return Promise.resolve(worker(items[index], index)).then(function (value) {
                results[index] = value;
                return next();
            });
        }
        return next();
    }
    var lanes = [];
    for (var i = 0; i < Math.min(laneLimit, items.length); i++) lanes.push(lane());
    return Promise.all(lanes).then(function () { return results; });
}

function paced(worker, intervalMs) {
    var interval = Math.max(0, Math.floor(Number(intervalMs) || 0));
    var nextStartAt = 0;
    return function (item, index) {
        var now = Date.now();
        var reservedAt = Math.max(now, nextStartAt);
        nextStartAt = reservedAt + interval;
        var delay = reservedAt - now;
        return new Promise(function (resolve) { setTimeout(resolve, delay); }).then(function () {
            return worker(item, index);
        });
    };
}

function buildSnapshot(options) {
    var opts = options || {};
    var evaluationTime = Number(opts.evaluationTime === undefined ? Date.now() : opts.evaluationTime);
    var topN = Number(opts.topN || TOP_N);
    var concurrency = Number(opts.concurrency || DEFAULT_CONCURRENCY);
    var requestIntervalMs = opts.requestIntervalMs === undefined ?
        (opts.getKlines ? 0 : DEFAULT_REQUEST_INTERVAL_MS) : Number(opts.requestIntervalMs);
    var getExchangeInfo = opts.getExchangeInfo || binanceRest.getFuturesExchangeInfo;
    var getKlines = opts.getKlines || binanceRest.getFuturesKlinesStrict;
    var generatedAt = Number(opts.generatedAt === undefined ? Date.now() : opts.generatedAt);
    return Promise.resolve(getExchangeInfo()).then(function (exchangeInfo) {
        if (!exchangeInfo || exchangeInfo.source !== 'futures') throw new Error('UNIVERSE_EXCHANGE_INFO_NOT_FUTURES');
        var eligible = eligibleContracts(exchangeInfo.symbols);
        if (!eligible.length) throw new Error('UNIVERSE_NO_ELIGIBLE_CONTRACTS');
        return mapLimit(eligible, concurrency, paced(function (contract) {
            return Promise.resolve(getKlines(contract.symbol, RANK_TIMEFRAME, 7, undefined, evaluationTime)).then(function (candles) {
                if ((candles || []).some(function (c) { return c.source !== 'futures'; })) {
                    throw new Error('UNIVERSE_KLINE_NOT_FUTURES symbol=' + contract.symbol);
                }
                var window = latestClosedWindow(candles, evaluationTime);
                var rules = symbolRules(contract);
                if (window.length < RANK_CLOSED_BARS) {
                    return { symbol: contract.symbol, rankEligible: false, reason: 'INSUFFICIENT_RANK_HISTORY',
                        closedBars: window.length, executionRules: rules };
                }
                if (!rankWindowContinuous(window)) throw new Error('RANK_WINDOW_NOT_CONTINUOUS symbol=' + contract.symbol);
                var quoteVolume = 0;
                window.forEach(function (c) {
                    if (c.quoteAssetVolume === null || c.quoteAssetVolume === undefined || c.quoteAssetVolume === '' ||
                            !Number.isFinite(Number(c.quoteAssetVolume))) {
                        throw new Error('QUOTE_ASSET_VOLUME_MISSING symbol=' + contract.symbol);
                    }
                    quoteVolume += Number(c.quoteAssetVolume);
                });
                return { symbol: contract.symbol, rankEligible: true, reason: null,
                    quoteVolume24h: quoteVolume, closedBars: window.length,
                    first4hOpenTime: window[0].openTime,
                    last4hCloseTime: window[window.length - 1].closeTime,
                    executionRules: rules };
            });
        }, requestIntervalMs)).then(function (rows) {
            var ranked = rankRows(rows, topN);
            if (ranked.length < topN) throw new Error('UNIVERSE_INSUFFICIENT_RANKABLE_CONTRACTS expected=' + topN + ' actual=' + ranked.length);
            var notReady = ranked.filter(function (r) { return !rulesReady(r.executionRules); });
            if (notReady.length) throw new Error('UNIVERSE_SYMBOL_RULES_NOT_READY symbol=' + notReady[0].symbol);
            return {
                version: VERSION,
                dateKey: dateKey(evaluationTime),
                generatedAt: generatedAt,
                evaluationTime: evaluationTime,
                rankingWindow: { timeframe: RANK_TIMEFRAME, closedBars: RANK_CLOSED_BARS },
                topN: topN,
                eligibleContractCount: eligible.length,
                insufficientHistoryCount: rows.filter(function (r) { return !r.rankEligible; }).length,
                symbols: ranked.map(function (r) {
                    return { rank: r.rank, symbol: r.symbol, quoteVolume24h: r.quoteVolume24h,
                        first4hOpenTime: r.first4hOpenTime, last4hCloseTime: r.last4hCloseTime,
                        scannable: true, executionReady: false, executionRules: r.executionRules };
                })
            };
        });
    });
}

function validSnapshot(snapshot) {
    if (!snapshot || snapshot.version !== VERSION || snapshot.topN !== TOP_N ||
            !snapshot.rankingWindow || snapshot.rankingWindow.timeframe !== RANK_TIMEFRAME ||
            snapshot.rankingWindow.closedBars !== RANK_CLOSED_BARS ||
            !Number.isFinite(Number(snapshot.generatedAt)) || !Number.isFinite(Number(snapshot.evaluationTime)) ||
            snapshot.dateKey !== dateKey(Number(snapshot.evaluationTime)) ||
            !Array.isArray(snapshot.symbols) || snapshot.symbols.length !== TOP_N) return false;
    var seen = {};
    return snapshot.symbols.every(function (row, index) {
        if (!row || row.rank !== index + 1 || !row.symbol || seen[row.symbol] ||
                !Number.isFinite(Number(row.quoteVolume24h)) || Number(row.quoteVolume24h) < 0 ||
                !Number.isFinite(Number(row.first4hOpenTime)) || !Number.isFinite(Number(row.last4hCloseTime)) ||
                Number(row.last4hCloseTime) > Number(snapshot.evaluationTime) || !rulesReady(row.executionRules)) return false;
        if (index > 0 && Number(row.quoteVolume24h) > Number(snapshot.symbols[index - 1].quoteVolume24h)) return false;
        seen[row.symbol] = true;
        return true;
    });
}

function isRefreshDue(snapshot, now) {
    if (validSnapshot(snapshot) && snapshot.dateKey === dateKey(now)) return false;
    var d = new Date(now);
    return d.getUTCHours() > REFRESH_HOUR_UTC ||
        (d.getUTCHours() === REFRESH_HOUR_UTC && d.getUTCMinutes() >= REFRESH_MINUTE_UTC);
}

function snapshotSymbols(snapshot) {
    return validSnapshot(snapshot) ? snapshot.symbols.map(function (r) { return r.symbol; }) : [];
}

function runtimeSymbols(scanSymbols, activeSymbols) {
    var seen = {}, out = [];
    (scanSymbols || []).concat(activeSymbols || []).forEach(function (symbol) {
        if (symbol && !seen[symbol]) { seen[symbol] = true; out.push(symbol); }
    });
    return out;
}

function snapshotHasActiveLifecycle(snapshot) {
    if (!snapshot || !snapshot.activeTradeId) return false;
    var trade = snapshot.trades && snapshot.trades[snapshot.activeTradeId];
    if (!trade) return true;
    function open(order) { return order && ['NEW', 'PARTIALLY_FILLED', 'PENDING_NEW', 'UNKNOWN'].indexOf(order.status) >= 0; }
    if (Math.abs(Number(trade.positionQty) || 0) > 0) return true;
    if (open(trade.entryOrder) || open(trade.slOrder) || open(trade.tpOrder)) return true;
    return ['CLOSED', 'CANCELED', 'NO_TRADE', 'SHADOW_ORDER', 'SHADOW_CANCELED'].indexOf(trade.status) === -1;
}

function discoverActiveLifecycleSymbols(dataDir) {
    if (!fs.existsSync(dataDir)) return [];
    return fs.readdirSync(dataDir, { withFileTypes: true }).filter(function (entry) { return entry.isDirectory(); })
        .map(function (entry) { return entry.name; }).filter(function (symbol) {
            var state = persistence.loadJson(path.join(dataDir, symbol, 'real-order-execution-v1.json'), null);
            return snapshotHasActiveLifecycle(state);
        }).sort();
}

function createService(options) {
    var opts = options || {};
    var snapshotFile = opts.snapshotFile;
    var load = opts.load || function () { return persistence.loadJson(snapshotFile, null); };
    var save = opts.save || function (snapshot) { persistence.saveJson(snapshotFile, snapshot); };
    var builder = opts.buildSnapshot || buildSnapshot;
    var retryIntervalMs = Number(opts.retryIntervalMs || 60 * 60 * 1000);
    var lastAttemptAt = null;
    var loaded = load();
    var current = validSnapshot(loaded) ? loaded : null;
    function refresh(evaluationTime) {
        lastAttemptAt = evaluationTime;
        return Promise.resolve(builder({ evaluationTime: evaluationTime, topN: TOP_N,
            concurrency: opts.concurrency || DEFAULT_CONCURRENCY,
            requestIntervalMs: opts.requestIntervalMs === undefined ? DEFAULT_REQUEST_INTERVAL_MS : opts.requestIntervalMs })).then(function (snapshot) {
            if (!validSnapshot(snapshot)) throw new Error('INVALID_UNIVERSE_SNAPSHOT');
            save(snapshot); current = snapshot;
            return { status: 'REFRESHED', ready: true, snapshot: current };
        }).catch(function (error) {
            return { status: 'REFRESH_FAILED', ready: !!current, snapshot: current, error: error };
        });
    }
    function initialize(evaluationTime) {
        if (current && current.dateKey === dateKey(evaluationTime)) return Promise.resolve({ status: 'RESTORED', ready: true, snapshot: current });
        return refresh(evaluationTime);
    }
    function refreshIfDue(evaluationTime) {
        if (!isRefreshDue(current, evaluationTime)) return Promise.resolve({ status: 'NOT_DUE', ready: !!current, snapshot: current });
        if (lastAttemptAt !== null && evaluationTime - lastAttemptAt < retryIntervalMs) {
            return Promise.resolve({ status: 'RETRY_NOT_DUE', ready: !!current, snapshot: current });
        }
        return refresh(evaluationTime);
    }
    return { initialize: initialize, refresh: refresh, refreshIfDue: refreshIfDue,
        getSnapshot: function () { return current; }, isReady: function () { return !!current; } };
}

module.exports = {
    VERSION: VERSION, TOP_N: TOP_N, RANK_TIMEFRAME: RANK_TIMEFRAME,
    RANK_CLOSED_BARS: RANK_CLOSED_BARS, REFRESH_HOUR_UTC: REFRESH_HOUR_UTC,
    REFRESH_MINUTE_UTC: REFRESH_MINUTE_UTC, DEFAULT_CONCURRENCY: DEFAULT_CONCURRENCY,
    DEFAULT_REQUEST_INTERVAL_MS: DEFAULT_REQUEST_INTERVAL_MS,
    dateKey: dateKey, eligibleContracts: eligibleContracts, symbolRules: symbolRules,
    rulesReady: rulesReady, configMatchesContract: configMatchesContract,
    latestClosedWindow: latestClosedWindow, rankWindowContinuous: rankWindowContinuous, rankRows: rankRows,
    mapLimit: mapLimit, paced: paced, buildSnapshot: buildSnapshot, validSnapshot: validSnapshot,
    isRefreshDue: isRefreshDue, snapshotSymbols: snapshotSymbols, runtimeSymbols: runtimeSymbols,
    snapshotHasActiveLifecycle: snapshotHasActiveLifecycle,
    discoverActiveLifecycleSymbols: discoverActiveLifecycleSymbols, createService: createService
};
