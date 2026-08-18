/**
 * Phase 11L — Live 数据源
 * 初始历史（复用 historicalLoader + 本地缓存）→ 轮询增量 5m → HTF 收盘维护。
 */
var binanceRest = require('../data/binanceRest');
var historicalLoader = require('../replay/historicalLoader');

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
 */
function fetchHtfIncrement(symbol, structureCandles, calendarCandles) {
    var tasks = [];
    function append(arr, tf) {
        arr = arr || (arr = []);
        var last = arr.length > 0 ? arr[arr.length - 1].closeTime : 0;
        tasks.push(binanceRest.loadHistory(symbol, tf, last + 1, Date.now()).then(function (newC) {
            (newC || []).forEach(function (c) {
                var dup = arr.some(function (x) { return x.openTime === c.openTime; });
                if (!dup) arr.push(c);
            });
        }).catch(function () {}));
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
    return Promise.all(tasks);
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
    makeFetcher: makeFetcher
};
