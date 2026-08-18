/**
 * Historical Loader（Phase 11R）
 *
 * 按 replayStart - warmup → replayEnd 加载全部 timeframe，
 * 替代"最新 N 根"——保证回放区间内每个时点的 HTF 数据完整。
 *
 * warmup：
 *   5m:  至少 150 根（pivot right=2 + ATR(14) + accumulation 36 + 保险）
 *   1h:  至少 96 根（4 天）
 *   4h:  至少 60 根（10 天）
 *   1d:  至少 150 根（覆盖 30 天回放 + PDH 完整日）
 *   1w:  至少 12 根（12 周，覆盖 30 天 + 上一完整周）
 *   1M:  至少 6 根（6 个月，覆盖上一完整月）
 */
var binanceRest = require('../data/binanceRest');
var fs = require('fs');
var path = require('path');

// Phase 11E：本地数据缓存（重复窗口免下载；同一天内重复跑同一 window 命中）
// key = symbol + interval + dayBucket(loadStart) + dayBucket(replayEnd)
var CACHE_DIR = process.env.DATA_CACHE_DIR || path.join(__dirname, '..', 'data-cache');
var DAY = 86400000;

function cacheKey(symbol, interval, loadStart, replayEnd) {
    return symbol + '_' + interval + '_' + Math.floor(loadStart / DAY) + '_' + Math.floor(replayEnd / DAY);
}

function readCache(key) {
    try {
        if (process.env.DISABLE_DATA_CACHE === '1') return null;
        var f = path.join(CACHE_DIR, key + '.json');
        if (!fs.existsSync(f)) return null;
        return JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch (e) {
        return null;
    }
}

function writeCache(key, candles) {
    try {
        if (process.env.DISABLE_DATA_CACHE === '1') return;
        if (!fs.existsSync(CACHE_DIR)) {
            fs.mkdirSync(CACHE_DIR, { recursive: true });
        }
        fs.writeFileSync(path.join(CACHE_DIR, key + '.json'), JSON.stringify(candles));
    } catch (e) {
        // 缓存失败不影响正确性
    }
}

var WARMUP_BARS = {
    '5m': 300,
    '1h': 200,
    '4h': 120,
    '1d': 200,
    '1w': 12,
    '1M': 6
};

/**
 * @param {string} symbol
 * @param {string} interval
 * @param {number} replayStart 回放区间起点（毫秒）
 * @param {number} replayEnd 回放区间终点（毫秒）
 * @param {Object} [options] { warmupBars, onProgress }
 * @returns {Promise<Array>} 已收盘 candle（时间升序，含 warmup 部分）
 */
function loadInterval(symbol, interval, replayStart, replayEnd, options) {
    var opts = options || {};
    var warmupBars = opts.warmupBars || WARMUP_BARS[interval] || 100;
    var intervalMs = intervalMsOf(interval);
    var loadStart = replayStart - warmupBars * intervalMs;
    if (loadStart < 0) {
        loadStart = 0;
    }
    // Phase 11E：缓存命中 → 免下载
    var key = cacheKey(symbol, interval, loadStart, replayEnd);
    var cached = readCache(key);
    if (cached) {
        return Promise.resolve(cached);
    }
    return binanceRest.loadHistory(symbol, interval, loadStart, replayEnd, {
        pageLimit: 1500,
        onProgress: opts.onProgress
    }).then(function (candles) {
        writeCache(key, candles);
        return candles;
    });
}

/**
 * 加载回放所需全部 timeframe
 * @returns {Promise<Object>} {
 *   '5m', '1h', '4h', '1d', '1w', '1M', exchangeInfo
 * }
 */
function loadAll(symbol, replayStart, replayEnd, options) {
    var opts = options || {};
    var intervals = ['5m', '1h', '4h', '1d', '1w', '1M'];
    var requests = {};
    intervals.forEach(function (iv) {
        requests[iv] = loadInterval(symbol, iv, replayStart, replayEnd, {
            onProgress: opts.onProgress && function (n) { opts.onProgress(iv, n); }
        });
    });
    // exchangeInfo 缓存（key = symbol_EXCHANGE）
    var exKey = symbol + '_EXCHANGE';
    var exCached = readCache(exKey);
    if (exCached) {
        requests.exchangeInfo = Promise.resolve(exCached);
    } else {
        requests.exchangeInfo = binanceRest.getExchangeInfo(symbol).then(function (info) {
            writeCache(exKey, info);
            return info;
        });
    }

    return Promise.all(Object.keys(requests).map(function (k) {
        return requests[k].then(function (v) { return [k, v]; });
    })).then(function (pairs) {
        var data = {};
        pairs.forEach(function (p) { data[p[0]] = p[1]; });
        return data;
    });
}

function intervalMsOf(interval) {
    var map = {
        '1m': 60000, '3m': 180000, '5m': 300000, '15m': 900000,
        '30m': 1800000, '1h': 3600000, '4h': 14400000,
        '1d': 86400000, '1w': 604800000, '1M': 2592000000
    };
    return map[interval] || 300000;
}

module.exports = {
    loadInterval: loadInterval,
    loadAll: loadAll,
    WARMUP_BARS: WARMUP_BARS
};
