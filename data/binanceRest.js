/**
 * Binance USDⓈ-M Futures REST 数据层
 * 统一输出标准化的 candle 对象：
 *   openTime / open / high / low / close / volume / closeTime / closed / source
 *
 * 核心原则（禁止未来数据）：
 * - getKlines 只返回【已收盘】的 K 线（closed === true），未收盘的当前 K 线直接丢弃
 * - 判断标准：closeTime <= 请求时刻
 *
 * 网络策略：
 * - 默认请求合约主域名 fapi.binance.com
 * - 主域名失败（超时 / 502 / ECONNREFUSED / 5xx）自动回退官方数据镜像
 *   data-api.binance.vision（现货端点），并标记 source: 'spot-mirror'
 */
var axios = require('axios');
var network = require('../config/network');

var INTERVAL_MS = {
    '1m': 60000,
    '3m': 180000,
    '5m': 300000,
    '15m': 900000,
    '30m': 1800000,
    '1h': 3600000,
    '2h': 7200000,
    '4h': 14400000,
    '6h': 21600000,
    '8h': 28800000,
    '12h': 43200000,
    '1d': 86400000,
    '3d': 259200000,
    '1w': 604800000,
    '1M': 2592000000
};

/**
 * 是否强制使用镜像
 */
function shouldUseFallback() {
    if (process.env.ICT_USE_FALLBACK === '1') {
        return true;
    }
    return !!network.useFallback;
}

/**
 * 代理配置（axios 的 proxy 选项）
 * network.proxy.enabled 时显式走配置代理（覆盖环境变量）；
 * 否则交给 axios 读取环境变量 HTTP_PROXY/HTTPS_PROXY。
 */
function proxyConfig() {
    if (network.proxy && network.proxy.enabled) {
        return {
            proxy: {
                host: network.proxy.host,
                port: network.proxy.port
            }
        };
    }
    return {};
}

/**
 * 标准化单根原始 K 线（Binance klines 数组格式）
 */
function normalizeCandle(item, source, interval) {
    var intervalMs = INTERVAL_MS[interval] || 300000;
    var openTime = item[0];
    var closeTime = item[6];
    var closed = closeTime <= Date.now();
    return {
        openTime: openTime,
        open: Number(item[1]),
        high: Number(item[2]),
        low: Number(item[3]),
        close: Number(item[4]),
        volume: Number(item[5]),
        closeTime: closeTime,
        closed: closed,
        source: source
    };
}

/**
 * 实际请求逻辑（区分主端点 / 镜像端点）
 */
function requestKlines(symbol, interval, limit, startTime, endTime, useFallback) {
    var url = useFallback ? network.fallbackBaseUrl : network.baseUrl;
    var path = useFallback ? '/api/v3/klines' : '/fapi/v1/klines';
    var source = useFallback ? 'spot-mirror' : 'futures';
    var params = {
        symbol: symbol,
        interval: interval,
        limit: limit || 500
    };
    if (startTime !== undefined && startTime !== null) {
        params.startTime = startTime;
    }
    if (endTime !== undefined && endTime !== null) {
        params.endTime = endTime;
    }
    var cfg = proxyConfig();
    cfg.params = params;
    cfg.timeout = 10000;
    return axios
        .get(url + path, cfg)
        .then(function (response) {
            return response.data
                .map(function (item) {
                    return normalizeCandle(item, source, interval);
                })
                .filter(function (candle) {
                    // 禁止未来数据：未收盘 K 线不进入分析
                    return candle.closed;
                });
        });
}

/**
 * 获取已收盘 K 线（时间升序）
 * @param {string} symbol 交易对，如 'BTCUSDT'
 * @param {string} interval 周期，如 '5m' / '1h' / '4h' / '1d' / '1w'
 * @param {number} limit 数量，默认 500（Binance 单次上限 1500）
 * @param {number} [startTime] 可选：起始 openTime（毫秒）
 * @param {number} [endTime] 可选：结束 openTime（毫秒）
 * @returns {Promise<Array>} 标准化 candle 数组
 */
function getKlines(symbol, interval, limit, startTime, endTime) {
    var forceFallback = shouldUseFallback();
    return requestKlines(symbol, interval, limit, startTime, endTime, forceFallback).catch(
        function (primaryError) {
            // 主域名失败 → 自动回退镜像；镜像也失败才抛错
            return requestKlines(symbol, interval, limit, startTime, endTime, true).catch(
                function () {
                    throw primaryError;
                }
            );
        }
    );
}

/**
 * 从 exchangeInfo 响应中解析目标 symbol 的 PRICE_FILTER.tickSize / LOT_SIZE.stepSize
 * （纯函数，便于测试）
 * @param {Object} data exchangeInfo 响应体
 * @param {string} symbol
 * @param {string} source 'futures' | 'spot-mirror'
 */
function parseExchangeInfo(data, symbol, source) {
    var symbolInfo = null;
    (data.symbols || []).forEach(function (s) {
        if (s.symbol === symbol) {
            symbolInfo = s;
        }
    });
    if (!symbolInfo) {
        return {
            symbol: symbol,
            tickSize: null,
            stepSize: null,
            pricePrecision: null,
            source: source || 'not-found'
        };
    }
    var tickSize = null;
    var stepSize = null;
    (symbolInfo.filters || []).forEach(function (f) {
        if (f.filterType === 'PRICE_FILTER' && f.tickSize) {
            tickSize = Number(f.tickSize);
        }
        if (f.filterType === 'LOT_SIZE' && f.stepSize) {
            stepSize = Number(f.stepSize);
        }
    });
    return {
        symbol: symbol,
        tickSize: tickSize,
        stepSize: stepSize,
        pricePrecision:
            symbolInfo.pricePrecision !== undefined
                ? symbolInfo.pricePrecision
                : null,
        source: source || 'futures'
    };
}

var exchangeInfoCache = {}; // symbol -> info

/**
 * 获取某 symbol 的 exchangeInfo（缓存）
 *
 * 网络策略：
 * - 默认请求合约主域名（/fapi/v1/exchangeInfo），source = 'futures'
 * - 主域名失败回退现货镜像（/api/v3/exchangeInfo），source = 'spot-mirror'
 *   —— 现货 tickSize 不得冒充合约数据，source 明确区分
 * - 全部失败 → 返回 tickSize: null（不阻塞系统，tolerance 退化为纯百分比）
 */
function getExchangeInfo(symbol) {
    if (exchangeInfoCache[symbol]) {
        return Promise.resolve(exchangeInfoCache[symbol]);
    }
    var forceFallback = shouldUseFallback();
    var fetchInfo = function (useFallback) {
        var url = useFallback ? network.fallbackBaseUrl : network.baseUrl;
        var path = useFallback ? '/api/v3/exchangeInfo' : '/fapi/v1/exchangeInfo';
        var source = useFallback ? 'spot-mirror' : 'futures';
        var cfg = proxyConfig();
        cfg.timeout = 10000;
        return axios.get(url + path, cfg).then(function (response) {
            return parseExchangeInfo(response.data, symbol, source);
        });
    };
    return fetchInfo(forceFallback)
        .then(function (info) {
            exchangeInfoCache[symbol] = info;
            return info;
        })
        .catch(function () {
            return fetchInfo(true)
                .then(function (info) {
                    exchangeInfoCache[symbol] = info;
                    return info;
                })
                .catch(function () {
                    var info = {
                        symbol: symbol,
                        tickSize: null,
                        stepSize: null,
                        pricePrecision: null,
                        source: 'unavailable'
                    };
                    exchangeInfoCache[symbol] = info;
                    return info;
                });
        });
}

/**
 * 分页加载历史 K 线（时间升序，自动翻页直到 endTime 或数据取尽）
 * 每页 limit 最大 1500（Binance 单次上限）。
 * @param {string} symbol
 * @param {string} interval
 * @param {number} startTime 起始 openTime（毫秒）
 * @param {number} endTime 结束 openTime（毫秒）
 * @param {Object} [options] { pageLimit, onProgress }
 * @returns {Promise<Array>} 已收盘 candle 数组（升序）
 */
function loadHistory(symbol, interval, startTime, endTime, options) {
    var opts = options || {};
    var pageLimit = opts.pageLimit || 1500;
    var out = [];
    var cursor = startTime;

    function page() {
        if (cursor > endTime) {
            return Promise.resolve(out);
        }
        return getKlines(symbol, interval, pageLimit, cursor, endTime).then(function (candles) {
            if (!candles || candles.length === 0) {
                return out;
            }
            out = out.concat(candles);
            if (opts.onProgress) {
                opts.onProgress(out.length, cursor, endTime);
            }
            var last = candles[candles.length - 1];
            var next = last.openTime + INTERVAL_MS[interval];
            if (next <= cursor || last.closeTime >= endTime) {
                return out; // 没有进展或已到达 endTime
            }
            cursor = next;
            return page();
        });
    }

    return page();
}

/**
 * Phase 11L.2 — 过滤合法永续合约候选（纯函数，可测）
 * TRADING + USDT 计价 + （无 contractType（spot 源）或 PERPETUAL）
 */
function parseTopCandidates(symbols) {
    return (symbols || []).filter(function (s) {
        if (s.status !== 'TRADING' || s.quoteAsset !== 'USDT') return false;
        if (s.contractType !== undefined && s.contractType !== 'PERPETUAL') return false;
        return true;
    });
}

/**
 * Phase 11L.2 — Top 成交量 symbol
 * 1. exchangeInfo（/fapi/v1/exchangeInfo）→ 合法 PERPETUAL + TRADING + USDT 名单
 *    （fapi exchangeInfo 不包含成交量字段，仅作合约名单来源）
 * 2. 24hr ticker（/fapi/v1/ticker/24hr）→ quoteVolume 补成交量
 * 3. 按 quoteVolume 降序取前 count
 * @param {number} [count] 默认 10
 * @returns {Promise<Array>} [{ symbol, quoteVolume, source }]
 */
function fetchTopVolumeSymbols(count) {
    var n = count || 10;
    var forceFallback = shouldUseFallback();

    function fetchCandidates(useFallback) {
        var url = useFallback ? network.fallbackBaseUrl : network.baseUrl;
        var path = useFallback ? '/api/v3/exchangeInfo' : '/fapi/v1/exchangeInfo';
        var source = useFallback ? 'spot-mirror' : 'futures';
        var cfg = proxyConfig();
        cfg.timeout = 10000;
        return axios.get(url + path, cfg).then(function (response) {
            var symbols = (response.data && response.data.symbols) || [];
            return { candidates: parseTopCandidates(symbols), source: source, useFallback: useFallback };
        });
    }

    function fetchVolumes(useFallback) {
        var url = useFallback ? network.fallbackBaseUrl : network.baseUrl;
        var path = useFallback ? '/api/v3/ticker/24hr' : '/fapi/v1/ticker/24hr';
        var cfg = proxyConfig();
        cfg.timeout = 10000;
        return axios.get(url + path, cfg).then(function (r) {
            var map = {};
            (r.data || []).forEach(function (t) {
                if (t.symbol && t.quoteVolume !== undefined) {
                    map[t.symbol] = parseFloat(t.quoteVolume) || 0;
                }
            });
            return map;
        }).catch(function () { return {}; }); // 成交量失败 → 保持 exchangeInfo 顺序兜底
    }

    function rank(info) {
        return fetchVolumes(info.useFallback).then(function (volMap) {
            var withVol = info.candidates.map(function (s) {
                return {
                    symbol: s.symbol,
                    quoteVolume: volMap[s.symbol] !== undefined ? volMap[s.symbol] : 0,
                    source: info.source
                };
            });
            withVol.sort(function (a, b) { return b.quoteVolume - a.quoteVolume; });
            return withVol.slice(0, n);
        });
    }

    return fetchCandidates(forceFallback).then(rank).catch(function () {
        return fetchCandidates(!forceFallback).then(rank); // 另一个源兜底
    });
}

module.exports = {
    getKlines: getKlines,
    getExchangeInfo: getExchangeInfo,
    loadHistory: loadHistory,
    parseExchangeInfo: parseExchangeInfo,
    fetchTopVolumeSymbols: fetchTopVolumeSymbols,
    parseTopCandidates: parseTopCandidates
};
