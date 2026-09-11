/**
 * Phase 11L — Live 数据源
 * Production minimum bootstrap → 轮询增量 5m → boundary-scheduled HTF 收盘维护。
 *
 * Phase 11L.3（Final Production Guardrails）：
 *   - checkFuturesPurity：初始化 futures-only fail-closed（任何 timeframe / exchangeInfo
 *     出现非 futures 源 → 初始化失败）
 *   - validate5mContinuity：DATA_GAP backfill 后的严格连续性验证
 *   - fetchHtfIncrement：futures-only 增量（spot 绝不 append）+ 不吞网络错误
 */
var binanceRest = require('../data/binanceRest');
var historicalLoader = require('../replay/historicalLoader');
var continuityChecker = require('../replay/continuityChecker');
var productionHistory = require('../config/productionHistoryRequirementsV1');

var BAR_MS = 300000; // 5m
var LIVE_TIMEFRAMES = ['5m', '1h', '4h', '1d'];
var LIVE_HTF_TIMEFRAMES = ['1h', '4h', '1d'];
var INTERVAL_MS = { '5m': BAR_MS, '1h': 3600000, '4h': 14400000, '1d': 86400000 };
var HTTP_TECHNICAL_ALLOWANCE_BARS = 2;
var MIN_ANALYSIS_4H_BARS = productionHistory['4h'].requiredClosedBars;
var MIN_ANALYSIS_5M_BARS = productionHistory['5m'].requiredClosedBars;
var DYNAMIC_D_VOLATILITY_BARS = 289;
var DYNAMIC_D_ACTIVE_LOOKBACK_BARS = 432;

function closedCount(rows) {
    return (rows || []).filter(function (c) { return c && c.closed === true; }).length;
}

function analysisHistoryStatus(data) {
    var closed4h = closedCount(data && data['4h']);
    var closed5m = closedCount(data && data['5m']);
    return {
        required4hBars: MIN_ANALYSIS_4H_BARS,
        available4hBars: closed4h,
        required5mBars: MIN_ANALYSIS_5M_BARS,
        available5mBars: closed5m,
        biasReady: closed4h >= MIN_ANALYSIS_4H_BARS,
        dynamicDReady: closed5m >= MIN_ANALYSIS_5M_BARS,
        atrReady: closed5m >= 15,
        eqReady: closed5m >= MIN_ANALYSIS_5M_BARS,
        fvgReady: closed5m >= 3,
        rangeReady: closed5m >= 501
    };
}

function analysisHistoryReady(data) {
    var status = analysisHistoryStatus(data);
    return status.biasReady && status.dynamicDReady && status.atrReady && status.eqReady && status.fvgReady;
}

function executionRulesReady(info) {
    return !!info && info.source === 'futures' && info.tickSize > 0 && info.stepSize > 0 &&
        info.minQty > 0 && info.minNotional > 0;
}

/**
 * Fix 1（11L.3 P0）+ 11L.4：初始化 futures purity 检查（纯函数，可测）
 * 严格 source presence：source 必须显式 === 'futures'。
 *   - source === 'spot-mirror' → 明确污染，拒绝
 *   - source === undefined → 来源不明（旧格式/未知源），生产严格模式同样拒绝
 *     （宁可要求清理 .live-state 重新 bootstrap，也不为兼容旧格式降低 production purity）
 * 检查 production bootstrap 返回的全部 live timeframe 与 exchangeInfo。
 * @param {Object} data { '5m','1h','4h','1d', exchangeInfo }
 * @returns {{ok: boolean, issues: Array<string>}}
 */
function checkFuturesPurity(data) {
    var issues = [];
    LIVE_TIMEFRAMES.forEach(function (tf) {
        var arr = (data && data[tf]) || [];
        arr.forEach(function (c, i) {
            if (!c.source || c.source !== 'futures') {
                issues.push(tf + '[' + i + '] source=' + (c.source || 'undefined') + ' openTime=' + c.openTime);
            }
        });
    });
    if (data && data.exchangeInfo && (!data.exchangeInfo.source || data.exchangeInfo.source !== 'futures')) {
        issues.push('exchangeInfo source=' + (data.exchangeInfo.source || 'undefined'));
    }
    return { ok: issues.length === 0, issues: issues };
}

/**
 * Fix 2（11L.3 P0）：严格 5m continuity 验证（纯函数，可测）
 * 要求：
 *   - full 非空
 *   - full[0].openTime === lastOpenTime + 5m（首根必须紧接上一根，无缺口）
 *   - full 内部逐根连续（复用 replay continuityChecker：gap/duplicate/out-of-order）
 * @param {number} lastOpenTime 引擎最后推进的 5m openTime
 * @param {Array} full 合并后的候选 K 列表（时间升序）
 * @returns {{ok: boolean, reason?: string}}
 */
function validate5mContinuity(lastOpenTime, full) {
    if (!full || full.length === 0) {
        return { ok: false, reason: 'empty' };
    }
    if (full[0].openTime !== lastOpenTime + BAR_MS) {
        return { ok: false, reason: 'firstNotAdjacent' };
    }
    var cc = continuityChecker.checkContinuity(full, '5m');
    if (!cc.valid) {
        return {
            ok: false,
            reason: 'notContinuous gaps=' + cc.gaps.length +
                ' dup=' + cc.duplicates.length +
                ' ooo=' + cc.outOfOrder.length
        };
    }
    return { ok: true };
}

/**
 * 初始数据：拉 warmupDays 的 5m + 全部 HTF + exchangeInfo。
 * @returns {Promise<Object>} { '5m', '1h', '4h', '1d', '1w', '1M', exchangeInfo }
 */
function fetchInitial(symbol, warmupDays) {
    var end = Date.now();
    var start = end - warmupDays * 24 * 3600 * 1000;
    return historicalLoader.loadAll(symbol, start, end);
}

function visibleClosed(rows, evaluationTime, required) {
    var seen = {};
    return (rows || []).filter(function (c) {
        return c && c.closed === true && c.closeTime <= evaluationTime && c.source === 'futures';
    }).sort(function (a, b) { return a.openTime - b.openTime; }).filter(function (c) {
        if (seen[c.openTime]) return false;
        seen[c.openTime] = true;
        return true;
    }).slice(-required);
}

function fetchProductionWindow(symbol, timeframe, evaluationTime, options) {
    var opts = options || {};
    var required = productionHistory[timeframe].requiredClosedBars;
    var intervalMs = INTERVAL_MS[timeframe];
    var requestLimit = required + HTTP_TECHNICAL_ALLOWANCE_BARS;
    var startTime = evaluationTime - requestLimit * intervalMs;
    var getKlines = opts.getKlines || binanceRest.getFuturesKlinesStrict;
    return Promise.resolve(getKlines(symbol, timeframe, requestLimit, startTime, evaluationTime))
        .then(function (rows) { return visibleClosed(rows, evaluationTime, required); });
}

function buildProductionBootstrapResult(symbol, values) {
    var v = values || {};
    var data = {
        symbol: symbol,
        '5m': v.candles5m || [],
        '4h': v.candles4h || [],
        '1h': v.candles1h || [],
        '1d': v.candles1d || [],
        exchangeInfo: v.rules || v.exchangeInfo || null
    };
    data.candles5m = data['5m'];
    data.candles4h = data['4h'];
    data.rules = data.exchangeInfo;
    data.readiness = analysisHistoryStatus(data);
    data.readiness.history5mReady = data.readiness.available5mBars >= MIN_ANALYSIS_5M_BARS;
    data.readiness.history4hReady = data.readiness.available4hBars >= MIN_ANALYSIS_4H_BARS;
    return data;
}

/** One fetch result is both the readiness evidence and the live runner input. */
function fetchProductionBootstrap(symbol, evaluationTime, options) {
    var opts = options || {};
    var at = Number(evaluationTime === undefined ? Date.now() : evaluationTime);
    var getExchangeInfo = opts.getExchangeInfo || binanceRest.getExchangeInfo;
    return Promise.all([
        fetchProductionWindow(symbol, '5m', at, opts),
        fetchProductionWindow(symbol, '4h', at, opts),
        fetchProductionWindow(symbol, '1h', at, opts),
        fetchProductionWindow(symbol, '1d', at, opts),
        Promise.resolve(getExchangeInfo(symbol))
    ]).then(function (values) {
        return buildProductionBootstrapResult(symbol, {
            candles5m: values[0], candles4h: values[1], candles1h: values[2], candles1d: values[3], rules: values[4]
        });
    });
}

function createProductionBootstrapService(options) {
    var opts = options || {};
    var inFlight = {};
    var completed = {};
    return {
        prepare: function (symbol, evaluationTime) {
            if (completed[symbol]) return Promise.resolve(completed[symbol]);
            if (inFlight[symbol]) return inFlight[symbol];
            inFlight[symbol] = fetchProductionBootstrap(symbol, evaluationTime, opts).then(function (result) {
                completed[symbol] = result;
                delete inFlight[symbol];
                return result;
            }, function (error) {
                delete inFlight[symbol];
                throw error;
            });
            return inFlight[symbol];
        },
        get: function (symbol) { return completed[symbol] || null; },
        forget: function (symbol) { delete completed[symbol]; delete inFlight[symbol]; }
    };
}

/**
 * Maximum closed 5m candles needed to reproduce fetchInitial's bootstrap window:
 * configured replay days plus historicalLoader's explicit 5m warmup.
 */
function initial5mRetentionBars(warmupDays) {
    var days = Number(warmupDays);
    if (!isFinite(days) || days < 0) days = 0;
    return Math.ceil(days * 24 * 60 / 5) + historicalLoader.WARMUP_BARS['5m'];
}

function production5mRetentionBars() {
    return productionHistory['5m'].requiredClosedBars;
}

/**
 * Fix 4（11L.2）：轮询最新已收盘 5m K（closeTime > lastCloseTime）。
 * 结构化返回以区分 NO_NEW_BAR（正常）/ NETWORK_ERROR（网络失败，不吞错）。
 * @returns {Promise<{ok: boolean, candles: Array, error?: string}>}
 */
function pollNew5m(symbol, lastCloseTime) {
    var now = Date.now();
    return binanceRest.getKlines(symbol, '5m', 5, lastCloseTime + 1, now).then(function (candles) {
        return {
            ok: true,
            candles: (candles || []).filter(function (c) {
                return c.closed && c.closeTime > lastCloseTime;
            }).sort(function (a, b) { return a.openTime - b.openTime; })
        };
    }).catch(function (e) {
        return { ok: false, error: (e && e.message) || 'network', candles: [] };
    });
}

/**
 * Fix 4（11L.2）：数据缺口补历史（从 lastCloseTime 之后拉全段已收盘 5m）。
 */
function backfill5m(symbol, lastCloseTime) {
    var now = Date.now();
    return binanceRest.loadHistory(symbol, '5m', lastCloseTime + 1, now).then(function (c) {
        return c || [];
    }).catch(function () { return []; });
}

function recover5mGap(symbol, lastOpenTime, lastCloseTime, freshCandles, options) {
    var fresh = freshCandles || [];
    var hasGap = lastOpenTime !== null && fresh.length > 0 && fresh[0].openTime !== lastOpenTime + BAR_MS;
    if (!hasGap) return Promise.resolve({ gapDetected: false, backfilledBars: 0, candles: fresh });
    var recover = options && options.backfill5m || backfill5m;
    return Promise.resolve(recover(symbol, lastCloseTime)).then(function (rows) {
        var missing = (rows || []).filter(function (c) {
            return c.closed && c.closeTime > lastCloseTime && c.openTime < fresh[0].openTime;
        }).sort(function (a, b) { return a.openTime - b.openTime; });
        return { gapDetected: true, backfilledBars: missing.length, candles: missing.concat(fresh) };
    });
}

/**
 * Live HTF 收盘维护：仅 1h/4h/1d。1w/1M 不属于 live request surface。
 * 增量追加最新已收盘 K（幂等：按 openTime 去重）。
 *
 * Fix 1（11L.3 P0）：
 *   - requireFutures=true 时，任何 source !== 'futures' 的 HTF K 线【绝不 append】
 *     （spot-mirror 不得混入 futures context，Bias/Draw 不被污染）
 *   - 网络失败【不吞错】：记录 HTF_NETWORK_ERROR（调用方保留旧 snapshot、标记 stale）
 *
 * @param {boolean} [requireFutures] 生产严格模式（config.live.json requireFutures）
 * @returns {Promise<{ok: boolean, issues: Array<{tf, kind: 'DEGRADED'|'NETWORK_ERROR', ...}>}>}
 */
function createHtfBoundaryScheduler(options) {
    var opts = options || {};
    var retryIntervalMs = Number(opts.retryIntervalMs || 60000);
    var attempts = {};
    function reserve(timeframe, rows, evaluationTime) {
        var intervalMs = INTERVAL_MS[timeframe];
        if (!intervalMs) return null;
        var last = rows && rows.length ? rows[rows.length - 1] : null;
        if (!last || !Number.isFinite(Number(last.closeTime))) return null;
        var boundary = Number(last.closeTime) + intervalMs;
        if (evaluationTime < boundary) return null;
        var previous = attempts[timeframe];
        if (previous && previous.boundary === boundary && evaluationTime - previous.at < retryIntervalMs) return null;
        attempts[timeframe] = { boundary: boundary, at: evaluationTime };
        return boundary;
    }
    return {
        reserve: reserve,
        snapshot: function () { return JSON.parse(JSON.stringify(attempts)); }
    };
}

function fetchHtfIncrement(symbol, structureCandles, calendarCandles, requireFutures, options) {
    var opts = options || {};
    var evaluationTime = Number(opts.evaluationTime === undefined ? Date.now() : opts.evaluationTime);
    var scheduler = opts.scheduler || createHtfBoundaryScheduler({ retryIntervalMs: opts.retryIntervalMs });
    var loadHistory = opts.loadHistory || binanceRest.loadHistory;
    var tasks = [];
    var issues = [];
    function append(arr, tf) {
        arr = arr || (arr = []);
        var last = arr.length > 0 ? arr[arr.length - 1].closeTime : 0;
        var boundary = scheduler.reserve(tf, arr, evaluationTime);
        if (boundary === null) return arr;
        tasks.push(Promise.resolve(loadHistory(symbol, tf, last + 1, evaluationTime)).then(function (newC) {
            (newC || []).forEach(function (c) {
                // 11L.5（P1-1）：统一严格 source presence —— source 必须显式 === 'futures'
                // （undefined 视为来源不明，与 checkFuturesPurity 一致，拒绝 append）
                if (requireFutures && c.source !== 'futures') {
                    issues.push({ tf: tf, kind: 'DEGRADED', source: (c.source || 'undefined'), openTime: c.openTime });
                    return; // 绝不把 spot/未知来源 HTF 塞进 futures context
                }
                if (c.closed !== true || c.closeTime > evaluationTime) return;
                var dup = arr.some(function (x) { return x.openTime === c.openTime; });
                if (!dup) arr.push(c);
            });
        }).catch(function (e) {
            issues.push({ tf: tf, kind: 'NETWORK_ERROR', error: (e && e.message) || 'network' });
        }));
        return arr;
    }
    if (structureCandles) {
        append(structureCandles['1h'] || (structureCandles['1h'] = []), '1h');
        append(structureCandles['4h'] || (structureCandles['4h'] = []), '4h');
        append(structureCandles['1d'] || (structureCandles['1d'] = []), '1d');
    }
    return Promise.all(tasks).then(function () {
        return { ok: issues.length === 0, issues: issues };
    });
}

/**
 * fetcher（rebuildSnapshot 的 daily/weekly/monthly liquidity 用）：
 * 优先查表 calendarCandles（与回测一致，零网络），缺失/越界时网络兜底。
 * @param {Object} calendarCandles { '1d': [...], '1w': [...], '1M': [...] }
 */
function makeFetcher(calendarCandles) {
    return function (symbol, interval, limit, startTime, endTime) {
        var arr = calendarCandles && calendarCandles[interval];
        if (arr && arr.length > 0) {
            var hit = arr.filter(function (c) {
                return c.closed && c.closeTime >= startTime && c.closeTime <= endTime;
            });
            return Promise.resolve(hit.slice(-(limit || 1500)));
        }
        return binanceRest.getKlines(symbol, interval, limit || 1500, startTime, endTime).then(function (candles) {
            return (candles || []).filter(function (c) { return c.closed; });
        }).catch(function () { return []; });
    };
}

module.exports = {
    fetchInitial: fetchInitial,
    fetchProductionWindow: fetchProductionWindow,
    fetchProductionBootstrap: fetchProductionBootstrap,
    buildProductionBootstrapResult: buildProductionBootstrapResult,
    createProductionBootstrapService: createProductionBootstrapService,
    initial5mRetentionBars: initial5mRetentionBars,
    production5mRetentionBars: production5mRetentionBars,
    pollNew5m: pollNew5m,
    backfill5m: backfill5m,
    recover5mGap: recover5mGap,
    fetchHtfIncrement: fetchHtfIncrement,
    createHtfBoundaryScheduler: createHtfBoundaryScheduler,
    makeFetcher: makeFetcher,
    checkFuturesPurity: checkFuturesPurity,
    validate5mContinuity: validate5mContinuity,
    HTF_TIMEFRAMES: LIVE_TIMEFRAMES,
    LIVE_HTF_TIMEFRAMES: LIVE_HTF_TIMEFRAMES,
    HTTP_TECHNICAL_ALLOWANCE_BARS: HTTP_TECHNICAL_ALLOWANCE_BARS,
    PRODUCTION_HISTORY_REQUIREMENTS: productionHistory,
    MIN_ANALYSIS_4H_BARS: MIN_ANALYSIS_4H_BARS,
    MIN_ANALYSIS_5M_BARS: MIN_ANALYSIS_5M_BARS,
    DYNAMIC_D_VOLATILITY_BARS: DYNAMIC_D_VOLATILITY_BARS,
    DYNAMIC_D_ACTIVE_LOOKBACK_BARS: DYNAMIC_D_ACTIVE_LOOKBACK_BARS,
    analysisHistoryStatus: analysisHistoryStatus,
    analysisHistoryReady: analysisHistoryReady,
    executionRulesReady: executionRulesReady
};
