/**
 * Phase 11L — Live 数据源
 * 初始历史（复用 historicalLoader + 本地缓存）→ 轮询增量 5m → HTF 收盘维护。
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

var BAR_MS = 300000; // 5m
var HTF_TIMEFRAMES = ['5m', '1h', '4h', '1d', '1w', '1M'];

/**
 * Fix 1（11L.3 P0）：初始化 futures purity 检查（纯函数，可测）
 * 检查 fetchInitial 返回的全部 timeframe 与 exchangeInfo：
 * 任何 candle.source / exchangeInfo.source !== 'futures' → 不通过。
 * @param {Object} data { '5m','1h','4h','1d','1w','1M', exchangeInfo }
 * @returns {{ok: boolean, issues: Array<string>}}
 */
function checkFuturesPurity(data) {
    var issues = [];
    HTF_TIMEFRAMES.forEach(function (tf) {
        var arr = (data && data[tf]) || [];
        arr.forEach(function (c, i) {
            if (c.source && c.source !== 'futures') {
                issues.push(tf + '[' + i + '] source=' + c.source + ' openTime=' + c.openTime);
            }
        });
    });
    if (data && data.exchangeInfo && data.exchangeInfo.source && data.exchangeInfo.source !== 'futures') {
        issues.push('exchangeInfo source=' + data.exchangeInfo.source);
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

/**
 * HTF 收盘维护：1h/4h（structureCandles）与 1d/1w/1M（calendarCandles）
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
function fetchHtfIncrement(symbol, structureCandles, calendarCandles, requireFutures) {
    var tasks = [];
    var issues = [];
    function append(arr, tf) {
        arr = arr || (arr = []);
        var last = arr.length > 0 ? arr[arr.length - 1].closeTime : 0;
        tasks.push(binanceRest.loadHistory(symbol, tf, last + 1, Date.now()).then(function (newC) {
            (newC || []).forEach(function (c) {
                if (requireFutures && c.source && c.source !== 'futures') {
                    issues.push({ tf: tf, kind: 'DEGRADED', source: c.source, openTime: c.openTime });
                    return; // 绝不把 spot HTF 塞进 futures context
                }
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
    }
    if (calendarCandles) {
        append(calendarCandles['1d'] || (calendarCandles['1d'] = []), '1d');
        append(calendarCandles['1w'] || (calendarCandles['1w'] = []), '1w');
        append(calendarCandles['1M'] || (calendarCandles['1M'] = []), '1M');
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
    pollNew5m: pollNew5m,
    backfill5m: backfill5m,
    fetchHtfIncrement: fetchHtfIncrement,
    makeFetcher: makeFetcher,
    checkFuturesPurity: checkFuturesPurity,
    validate5mContinuity: validate5mContinuity,
    HTF_TIMEFRAMES: HTF_TIMEFRAMES
};
