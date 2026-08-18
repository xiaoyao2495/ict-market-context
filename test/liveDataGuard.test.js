/**
 * Phase 11L.3 — Live 数据保护测试
 *
 * 覆盖：
 *   - checkFuturesPurity：初始化 futures-only fail-closed（5m/HTF/exchangeInfo）
 *   - validate5mContinuity：DATA_GAP backfill 后的严格连续性验证
 *   - fetchHtfIncrement：futures-only 增量（spot 绝不 append）+ 网络错误不吞
 */
var assert = require('assert');
var path = require('path');

var binanceRestPath = require.resolve('../data/binanceRest');
var dataSourcePath = path.join(__dirname, '..', 'live', 'dataSource.js');

var tests = [];
var passed = 0;
var failed = 0;

function test(name, fn) {
    tests.push({ name: name, fn: fn });
}

/** 替换 dataSource 内部引用的 binanceRest 模块（require 缓存注入） */
function loadDataSourceWithMock(mock) {
    require.cache[binanceRestPath] = {
        id: binanceRestPath,
        filename: binanceRestPath,
        loaded: true,
        exports: mock
    };
    delete require.cache[dataSourcePath];
    return require(dataSourcePath);
}

function candle(openTime, source) {
    return {
        openTime: openTime,
        closeTime: openTime + 299999,
        open: 1, high: 2, low: 0.5, close: 1.5, volume: 100,
        closed: true,
        source: source || 'futures'
    };
}

// ---------- checkFuturesPurity ----------
test('checkFuturesPurity: 全部 futures → ok', function () {
    var ds = loadDataSourceWithMock({});
    var data = {
        '5m': [candle(1000), candle(1300)],
        '1h': [candle(3600000)],
        '4h': [candle(14400000)],
        '1d': [candle(86400000)],
        '1w': [candle(604800000)],
        '1M': [candle(2592000000)],
        exchangeInfo: { source: 'futures' }
    };
    var r = ds.checkFuturesPurity(data);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.issues.length, 0);
});

test('checkFuturesPurity: 5m 混入 spot → 不通过', function () {
    var ds = loadDataSourceWithMock({});
    var data = {
        '5m': [candle(1000), candle(1300, 'spot-mirror')],
        '1h': [], '4h': [], '1d': [], '1w': [], '1M': [],
        exchangeInfo: { source: 'futures' }
    };
    var r = ds.checkFuturesPurity(data);
    assert.strictEqual(r.ok, false);
    assert.ok(r.issues[0].indexOf('5m[1]') === 0);
    assert.ok(r.issues[0].indexOf('spot-mirror') !== -1);
});

test('checkFuturesPurity: HTF（1h）spot → 不通过', function () {
    var ds = loadDataSourceWithMock({});
    var data = {
        '5m': [candle(1000)], '4h': [], '1d': [], '1w': [], '1M': [],
        '1h': [candle(3600000, 'spot-mirror')],
        exchangeInfo: { source: 'futures' }
    };
    assert.strictEqual(ds.checkFuturesPurity(data).ok, false);
});

test('checkFuturesPurity: exchangeInfo spot / unavailable → 不通过', function () {
    var ds = loadDataSourceWithMock({});
    var base = { '5m': [candle(1000)], '1h': [], '4h': [], '1d': [], '1w': [], '1M': [] };
    assert.strictEqual(ds.checkFuturesPurity(Object.assign({}, base, { exchangeInfo: { source: 'spot-mirror' } })).ok, false);
    assert.strictEqual(ds.checkFuturesPurity(Object.assign({}, base, { exchangeInfo: { source: 'unavailable' } })).ok, false);
});

test('checkFuturesPurity: 无 source 字段（旧数据）不误报', function () {
    var ds = loadDataSourceWithMock({});
    var data = {
        '5m': [{ openTime: 1000, closeTime: 1299999, close: 1 }],
        '1h': [], '4h': [], '1d': [], '1w': [], '1M': [],
        exchangeInfo: { tickSize: 1 }
    };
    assert.strictEqual(ds.checkFuturesPurity(data).ok, true);
});

// ---------- validate5mContinuity ----------
test('validate5mContinuity: 首根紧接且内部连续 → ok', function () {
    var ds = loadDataSourceWithMock({});
    var full = [candle(1300000), candle(1600000), candle(1900000)];
    assert.strictEqual(ds.validate5mContinuity(1000000, full).ok, true);
});

test('validate5mContinuity: 首根不紧接（缺 10:05）→ firstNotAdjacent', function () {
    var ds = loadDataSourceWithMock({});
    var full = [candle(1600000), candle(1900000)];
    var r = ds.validate5mContinuity(1000000, full);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'firstNotAdjacent');
});

test('validate5mContinuity: 内部 gap → notContinuous', function () {
    var ds = loadDataSourceWithMock({});
    // 1300000 → 1600000 → 2200000：1900000 缺失
    var full = [candle(1300000), candle(1600000), candle(2200000)];
    var r = ds.validate5mContinuity(1000000, full);
    assert.strictEqual(r.ok, false);
    assert.ok(r.reason.indexOf('notContinuous') === 0);
});

test('validate5mContinuity: 空列表 → empty', function () {
    var ds = loadDataSourceWithMock({});
    assert.strictEqual(ds.validate5mContinuity(1000000, []).ok, false);
    assert.strictEqual(ds.validate5mContinuity(1000000, null).ok, false);
});

test('validate5mContinuity: 重复 openTime → notContinuous', function () {
    var ds = loadDataSourceWithMock({});
    var full = [candle(1300000), candle(1300000), candle(1600000)];
    assert.strictEqual(ds.validate5mContinuity(1000000, full).ok, false);
});

// ---------- fetchHtfIncrement（futures-only + 不吞错） ----------
function makeBar(openTime, tfMs, source) {
    return {
        openTime: openTime,
        closeTime: openTime + tfMs - 1,
        open: 1, high: 2, low: 0.5, close: 1.5, volume: 100,
        closed: true,
        source: source || 'futures'
    };
}

test('fetchHtfIncrement: requireFutures + spot HTF → 不 append + DEGRADED', function () {
    var appended = [];
    var ds = loadDataSourceWithMock({
        loadHistory: function () {
            return Promise.resolve([makeBar(3600000, 3600000, 'spot-mirror')]);
        }
    });
    var structure = { '1h': [], '4h': [] };
    var calendar = { '1d': [], '1w': [], '1M': [] };
    return ds.fetchHtfIncrement('BTCUSDT', structure, calendar, true).then(function (res) {
        assert.strictEqual(res.ok, false);
        assert.strictEqual(res.issues.length, 5); // 5 个 timeframe 都请求并返回 spot
        assert.strictEqual(res.issues[0].kind, 'DEGRADED');
        assert.strictEqual(res.issues[0].tf, '1h');
        // spot 未 append：所有 timeframe 数组仍为空
        assert.strictEqual(structure['1h'].length, 0);
        assert.strictEqual(structure['4h'].length, 0);
        assert.strictEqual(calendar['1d'].length, 0);
    });
});

test('fetchHtfIncrement: requireFutures=false + spot → 照旧 append（兼容模式）', function () {
    var ds = loadDataSourceWithMock({
        loadHistory: function () {
            return Promise.resolve([makeBar(3600000, 3600000, 'spot-mirror')]);
        }
    });
    var structure = { '1h': [], '4h': [] };
    var calendar = { '1d': [], '1w': [], '1M': [] };
    return ds.fetchHtfIncrement('BTCUSDT', structure, calendar, false).then(function (res) {
        assert.strictEqual(res.ok, true);
        assert.strictEqual(structure['1h'].length, 1);
    });
});

test('fetchHtfIncrement: futures 正常 → append 且无 issue', function () {
    var ds = loadDataSourceWithMock({
        loadHistory: function () {
            return Promise.resolve([makeBar(3600000, 3600000)]);
        }
    });
    var structure = { '1h': [], '4h': [] };
    var calendar = { '1d': [], '1w': [], '1M': [] };
    return ds.fetchHtfIncrement('BTCUSDT', structure, calendar, true).then(function (res) {
        assert.strictEqual(res.ok, true);
        assert.strictEqual(structure['1h'].length, 1);
    });
});

test('fetchHtfIncrement: 网络失败 → NETWORK_ERROR（不吞错）', function () {
    var ds = loadDataSourceWithMock({
        loadHistory: function () {
            return Promise.reject(new Error('ECONNREFUSED'));
        }
    });
    var structure = { '1h': [], '4h': [] };
    var calendar = { '1d': [], '1w': [], '1M': [] };
    return ds.fetchHtfIncrement('BTCUSDT', structure, calendar, true).then(function (res) {
        assert.strictEqual(res.ok, false);
        assert.strictEqual(res.issues.length, 5);
        assert.strictEqual(res.issues[0].kind, 'NETWORK_ERROR');
        assert.ok(res.issues[0].error.indexOf('ECONNREFUSED') !== -1);
        assert.strictEqual(structure['1h'].length, 0); // 失败不 append
    });
});

test('fetchHtfIncrement: 幂等去重（同 openTime 不重复 append）', function () {
    var calls = 0;
    var ds = loadDataSourceWithMock({
        loadHistory: function () {
            calls++;
            return Promise.resolve([makeBar(3600000, 3600000)]);
        }
    });
    var structure = { '1h': [], '4h': [] };
    var calendar = { '1d': [], '1w': [], '1M': [] };
    return ds.fetchHtfIncrement('BTCUSDT', structure, calendar, true).then(function () {
        return ds.fetchHtfIncrement('BTCUSDT', structure, calendar, true);
    }).then(function () {
        assert.strictEqual(structure['1h'].length, 1); // 第二次同 openTime 不重复
        assert.strictEqual(calls, 10); // 5 tf × 2 轮
    });
});

// ---------- 异步 runner ----------
var chain = Promise.resolve();
tests.forEach(function (t) {
    chain = chain.then(function () {
        return Promise.resolve().then(function () { return t.fn(); })
            .then(function () {
                passed++;
                console.log('PASS  ' + t.name);
            })
            .catch(function (e) {
                failed++;
                console.log('FAIL  ' + t.name + '  ->  ' + (e && e.message || e));
            });
    });
});
chain.then(function () {
    console.log('----');
    console.log('liveDataGuard: ' + passed + ' passed, ' + failed + ' failed');
    if (failed > 0) {
        process.exit(1);
    }
});
