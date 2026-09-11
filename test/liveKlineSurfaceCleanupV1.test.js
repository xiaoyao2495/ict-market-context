'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');

var binanceRestPath = require.resolve('../data/binanceRest');
var dataSourcePath = path.join(__dirname, '..', 'live', 'dataSource.js');

function loadDataSource(mock) {
    require.cache[binanceRestPath] = { id: binanceRestPath, filename: binanceRestPath, loaded: true, exports: mock || {} };
    delete require.cache[dataSourcePath];
    return require(dataSourcePath);
}

function bar(openTime, intervalMs, source) {
    return { openTime: openTime, closeTime: openTime + intervalMs - 1,
        open: 1, high: 2, low: 0.5, close: 1.5, volume: 10,
        closed: true, source: source || 'futures' };
}

function series(count, intervalMs, endBoundary) {
    return Array.from({ length: count }, function (_, index) {
        return bar(endBoundary - (count - index) * intervalMs, intervalMs);
    });
}

var tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

test('single source exposes exact 723x5m and 120x4h boundaries', function () {
    var ds = loadDataSource({});
    assert.strictEqual(ds.PRODUCTION_HISTORY_REQUIREMENTS.version, 'PRODUCTION_HISTORY_REQUIREMENTS_V1');
    assert.strictEqual(ds.MIN_ANALYSIS_5M_BARS, 723);
    assert.strictEqual(ds.MIN_ANALYSIS_4H_BARS, 120);
    assert.strictEqual(ds.analysisHistoryStatus({ '5m': series(722, 300000, 1000000000), '4h': series(120, 14400000, 2000000000) }).eqReady, false);
    assert.strictEqual(ds.analysisHistoryStatus({ '5m': series(723, 300000, 1000000000), '4h': series(119, 14400000, 2000000000) }).biasReady, false);
    assert.strictEqual(ds.analysisHistoryReady({ '5m': series(723, 300000, 1000000000), '4h': series(120, 14400000, 2000000000) }), true);
});

test('live entrypoint is decoupled from replay loader and calendar fetcher wiring', function () {
    var liveSource = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'live.js'), 'utf8');
    var engineSource = fs.readFileSync(path.join(__dirname, '..', 'live', 'liveEngine.js'), 'utf8');
    assert.strictEqual(/dataSource\.fetchInitial\s*\(/.test(liveSource), false);
    assert.strictEqual(/dataSource\.makeFetcher\s*\(/.test(liveSource), false);
    assert.strictEqual(/calendarCandles/.test(liveSource), false);
    assert.strictEqual(/calendarCandles|data\.fetcher/.test(engineSource), false);
});

test('generic replay loader retains 1w and 1M support', function () {
    var loader = require('../replay/historicalLoader');
    assert.strictEqual(typeof loader.loadAll, 'function');
    assert.strictEqual(loader.WARMUP_BARS['1w'], 12);
    assert.strictEqual(loader.WARMUP_BARS['1M'], 6);
});

test('production bootstrap fetches only 5m/4h/1h/1d and returns exact closed windows', async function () {
    var calls = [];
    var intervals = { '5m': 300000, '1h': 3600000, '4h': 14400000, '1d': 86400000 };
    var ds = loadDataSource({});
    var at = Date.parse('2026-09-11T12:00:00Z');
    var result = await ds.fetchProductionBootstrap('BTCUSDT', at, {
        getKlines: function (symbol, tf, limit) {
            calls.push({ symbol: symbol, tf: tf, limit: limit });
            return series(limit, intervals[tf], at).concat([
                bar(at, intervals[tf]),
                Object.assign({}, bar(at + intervals[tf], intervals[tf]), { closed: false })
            ]);
        },
        getExchangeInfo: function () { return { source: 'futures', tickSize: 0.1, stepSize: 0.001, minQty: 0.001, minNotional: 5 }; }
    });
    assert.deepStrictEqual(calls.map(function (x) { return x.tf; }).sort(), ['1d', '1h', '4h', '5m']);
    assert.ok(!Object.prototype.hasOwnProperty.call(result, '1w'));
    assert.ok(!Object.prototype.hasOwnProperty.call(result, '1M'));
    assert.strictEqual(result['5m'].length, 723);
    assert.strictEqual(result['4h'].length, 120);
    assert.strictEqual(result['1h'].length, 920);
    assert.strictEqual(result['1d'].length, 230);
    ['5m', '4h', '1h', '1d'].forEach(function (tf) {
        assert.ok(result[tf].every(function (candle) {
            return candle.closed === true && candle.closeTime <= at;
        }), tf + ' must contain only cutoff-visible fully closed candles');
    });
    assert.strictEqual(calls.filter(function (x) { return x.tf === '5m'; })[0].limit, 725);
    assert.strictEqual(calls.filter(function (x) { return x.tf === '4h'; })[0].limit, 122);
    assert.strictEqual(result.candles5m, result['5m']);
    assert.strictEqual(result.candles4h, result['4h']);
    assert.strictEqual(result.readiness.history5mReady, true);
    assert.strictEqual(result.readiness.history4hReady, true);
});

test('readiness and runner share one cached production bootstrap result', async function () {
    var counts = {};
    var intervals = { '5m': 300000, '1h': 3600000, '4h': 14400000, '1d': 86400000 };
    var ds = loadDataSource({});
    var at = Date.parse('2026-09-11T12:00:00Z');
    var service = ds.createProductionBootstrapService({
        getKlines: function (symbol, tf, limit) {
            counts[tf] = (counts[tf] || 0) + 1;
            return series(limit, intervals[tf], at);
        },
        getExchangeInfo: function () { return { source: 'futures', tickSize: 0.1, stepSize: 0.001, minQty: 0.001, minNotional: 5 }; }
    });
    var readinessResult = await service.prepare('BTCUSDT', at);
    var runnerInput = await service.prepare('BTCUSDT', at + 1000);
    assert.strictEqual(runnerInput, readinessResult);
    assert.deepStrictEqual(counts, { '5m': 1, '4h': 1, '1h': 1, '1d': 1 });
});

test('100 normal ticks make no 1w/1M request and one request per initial HTF boundary', async function () {
    var calls = [];
    var intervals = { '1h': 3600000, '4h': 14400000, '1d': 86400000 };
    var ds = loadDataSource({});
    var boundary = Date.parse('2026-09-11T00:00:00Z');
    var structure = {
        '1h': [bar(boundary - 2 * intervals['1h'], intervals['1h'])],
        '4h': [bar(boundary - 2 * intervals['4h'], intervals['4h'])],
        '1d': [bar(boundary - 2 * intervals['1d'], intervals['1d'])]
    };
    var scheduler = ds.createHtfBoundaryScheduler({ retryIntervalMs: 60000 });
    function loadHistory(symbol, tf, start, end) {
        calls.push(tf);
        var rows = [];
        for (var open = start; open + intervals[tf] - 1 <= end; open += intervals[tf]) rows.push(bar(open, intervals[tf]));
        return rows;
    }
    for (var i = 0; i < 100; i++) {
        await ds.fetchHtfIncrement('BTCUSDT', structure, null, true, {
            evaluationTime: boundary + i * 30000, scheduler: scheduler, loadHistory: loadHistory
        });
    }
    assert.deepStrictEqual(calls.sort(), ['1d', '1h', '4h']);
    assert.strictEqual(calls.indexOf('1w'), -1);
    assert.strictEqual(calls.indexOf('1M'), -1);
});

test('1h/4h/1d fetch only when their next closed boundary becomes possible', function () {
    var ds = loadDataSource({});
    var scheduler = ds.createHtfBoundaryScheduler({ retryIntervalMs: 60000 });
    var t = Date.parse('2026-09-11T00:00:00Z');
    var h1 = [bar(t - 2 * 3600000, 3600000)];
    var h4 = [bar(t - 2 * 14400000, 14400000)];
    var d1 = [bar(t - 2 * 86400000, 86400000)];
    assert.ok(scheduler.reserve('1h', h1, t) !== null);
    h1.push(bar(t - 3600000, 3600000));
    assert.strictEqual(scheduler.reserve('1h', h1, t + 30000), null);
    assert.strictEqual(scheduler.reserve('1h', h1, t + 59 * 60000 + 30000), null);
    assert.ok(scheduler.reserve('1h', h1, t + 3600000) !== null);
    assert.ok(scheduler.reserve('4h', h4, t) !== null);
    h4.push(bar(t - 14400000, 14400000));
    assert.strictEqual(scheduler.reserve('4h', h4, t + 30000), null);
    assert.ok(scheduler.reserve('4h', h4, t + 4 * 3600000) !== null);
    assert.ok(scheduler.reserve('1d', d1, t) !== null);
    d1.push(bar(t - 86400000, 86400000));
    assert.strictEqual(scheduler.reserve('1d', d1, t + 30000), null);
    assert.ok(scheduler.reserve('1d', d1, t + 86400000) !== null);

    var retryRows = [bar(t - 2 * 3600000, 3600000)];
    var retryScheduler = ds.createHtfBoundaryScheduler({ retryIntervalMs: 60000 });
    assert.ok(retryScheduler.reserve('1h', retryRows, t) !== null);
    assert.strictEqual(retryScheduler.reserve('1h', retryRows, t + 30000), null);
    assert.ok(retryScheduler.reserve('1h', retryRows, t + 60000) !== null);
});

test('5m polling and targeted one/multiple-bar gap backfill remain wired', async function () {
    var calls = [];
    var now = Date.now();
    var ds = loadDataSource({
        getKlines: function (symbol, tf, limit, start) {
            calls.push({ kind: 'poll', tf: tf, limit: limit, start: start });
            return Promise.resolve([]);
        },
        loadHistory: function (symbol, tf, start) {
            calls.push({ kind: 'backfill', tf: tf, start: start });
            return Promise.resolve([]);
        }
    });
    await ds.pollNew5m('BTCUSDT', now - 300000);
    await ds.backfill5m('BTCUSDT', now - 600000);
    assert.strictEqual(calls[0].kind, 'poll');
    assert.strictEqual(calls[0].tf, '5m');
    assert.strictEqual(calls[0].limit, 5);
    assert.strictEqual(calls[1].kind, 'backfill');
    assert.strictEqual(calls[1].tf, '5m');

    var lastOpen = 1000000;
    var lastClose = lastOpen + 300000 - 1;
    var fresh = [bar(lastOpen + 3 * 300000, 300000)];
    var recoveryCalls = 0;
    var recovered = await ds.recover5mGap('BTCUSDT', lastOpen, lastClose, fresh, {
        backfill5m: function () {
            recoveryCalls += 1;
            return [bar(lastOpen + 300000, 300000), bar(lastOpen + 2 * 300000, 300000), fresh[0]];
        }
    });
    assert.strictEqual(recoveryCalls, 1);
    assert.strictEqual(recovered.gapDetected, true);
    assert.strictEqual(recovered.backfilledBars, 2);
    assert.deepStrictEqual(recovered.candles.map(function (c) { return c.openTime; }),
        [lastOpen + 300000, lastOpen + 2 * 300000, lastOpen + 3 * 300000]);
});

(async function () {
    var passed = 0;
    for (var i = 0; i < tests.length; i++) {
        try { await tests[i].fn(); passed++; console.log('PASS ' + tests[i].name); }
        catch (error) { console.error('FAIL ' + tests[i].name); throw error; }
    }
    console.log('LIVE KLINE SURFACE CLEANUP V1: ' + passed + '/' + tests.length + ' PASS');
}()).catch(function (error) { console.error(error && error.stack || error); process.exitCode = 1; });
