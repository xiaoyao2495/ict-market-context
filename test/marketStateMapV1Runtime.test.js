'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var engineModule = require('../marketState/marketStateMapV1Engine');
var runtimeModule = require('../marketState/marketStateMapV1Runtime');
var llm1 = require('../marketState/trendEstablishmentMinimalEscapeV1_1Llm');
var dataSource = require('../live/dataSource');

var BAR = 300000;
function candles(count, start) {
    start = Math.floor(start / BAR) * BAR;
    var out = [], previous = 100;
    for (var i = 0; i < count; i++) {
        var center = 100 + i * 0.12 + Math.sin(i * Math.PI / 3) * 2.2;
        var close = center + Math.sin(i * 1.7) * 0.25;
        out.push({ openTime: start + i * BAR, closeTime: start + (i + 1) * BAR - 1,
            open: previous, high: Math.max(previous, close) + 0.45,
            low: Math.min(previous, close) - 0.45, close: close, closed: true, source: 'futures' });
        previous = close;
    }
    return out;
}
function decide(packet, direction) {
    return Promise.resolve({ response: { decision: 'ESTABLISHED', candidateDirection: direction,
        primaryReason: 'DIRECTIONAL_STRUCTURE_ESTABLISHED', briefReason: 'fixture' },
    requestKey: 'fixture-' + packet.evaluationTime, packetSHA256: 'fixture' });
}
function runtime(symbol, extra) {
    return runtimeModule.createRuntime(Object.assign({ symbol: symbol, decide: decide }, extra || {}));
}
function projected(rows) {
    return rows.map(function (x) { return { evaluationTime: x.evaluationTime, state: x.state,
        stateSince: x.stateSince, trendEstablishedAt: x.trendEstablishedAt,
        activeProtectedType: x.activeProtectedType, activeProtectedPrice: x.activeProtectedPrice }; });
}

test('frozen LLM1 identity is exact and LLM2 is absent', function () {
    assert.strictEqual(llm1.MODEL, 'deepseek-v4-flash');
    assert.strictEqual(llm1.PROMPT_SHA256, '2b0bf9b6eb60c486fdb896591178c3bee8ae2150f80ed569070fa278521bff50');
    assert.strictEqual(llm1.PACKET_SCHEMA_SHA256, '0794f0c6fcdf0b1c0b6a9a414f8bd97a2be8a7ef71541221f569fde23f70baa2');
    assert.strictEqual(runtime('BTCUSDT').constants.llm2Enabled, false);
});

test('BOOTSTRAP_RESEARCH_PARITY and LIVE_INCREMENTAL_PARITY', async function () {
    var rows = candles(96, 1800000000000);
    var reference = engineModule.createEngine({ decide: decide });
    var expected = await reference.replay(rows);
    var boot = runtime('BTCUSDT'); await boot.bootstrap(rows);
    assert.deepStrictEqual(projected(boot.getTimeline()), projected(expected.snapshots));
    assert.deepStrictEqual(boot.getTransitions(), expected.transitions);
    var incremental = runtime('BTCUSDT'); await incremental.bootstrap(rows.slice(0, 48));
    for (var i = 48; i < rows.length; i++) await incremental.onClosedCandle(rows[i]);
    assert.deepStrictEqual(projected(incremental.getTimeline()), projected(expected.snapshots));
});

test('RESTART_STATE_PARITY', async function () {
    var rows = candles(90, 1810000000000), continuous = runtime('BTCUSDT');
    await continuous.bootstrap(rows.slice(0, 45));
    for (var i = 45; i < rows.length; i++) await continuous.onClosedCandle(rows[i]);
    var restartedBefore = runtime('BTCUSDT'); await restartedBefore.bootstrap(rows.slice(0, 45));
    var restarted = runtime('BTCUSDT'); await restarted.bootstrap(rows.slice(0, 45));
    for (i = 45; i < rows.length; i++) await restarted.onClosedCandle(rows[i]);
    assert.deepStrictEqual(projected(restarted.getTimeline()), projected(continuous.getTimeline()));
    assert.strictEqual(restartedBefore.getStatus().latestEvaluationTime, rows[44].closeTime);
});

test('DUPLICATE_5M_UPDATE_IDEMPOTENT and older updates are ignored', async function () {
    var rows = candles(31, 1820000000000), map = runtime('BTCUSDT'); await map.bootstrap(rows.slice(0, 30));
    var before = map.getTimeline();
    assert.strictEqual((await map.onClosedCandle(rows[29])).status, 'DUPLICATE');
    assert.strictEqual((await map.onClosedCandle(rows[20])).status, 'OLDER_IGNORED');
    assert.deepStrictEqual(map.getTimeline(), before);
    var first = map.onClosedCandle(rows[30]);
    assert.strictEqual((await map.onClosedCandle(rows[30])).status, 'DUPLICATE');
    assert.strictEqual((await first).status, 'PROCESSED');
    assert.strictEqual(map.getTimeline().filter(function (x) { return x.evaluationTime === rows[30].closeTime; }).length, 1);
});

test('bootstrap buffers and drains new closed bars before atomic READY publication', async function () {
    var rows = candles(31, 1825000000000), map = runtime('BTCUSDT');
    var boot = map.bootstrap(rows.slice(0, 30));
    assert.strictEqual((await map.onClosedCandle(rows[30])).status, 'BUFFERED');
    await boot;
    assert.strictEqual(map.getStatus().status, 'READY');
    assert.strictEqual(map.getStatus().latestEvaluationTime, rows[30].closeTime);
    assert.strictEqual(map.snapshotAt(rows[30].closeTime).evaluationTime, rows[30].closeTime);
});

test('HISTORICAL_SNAPSHOT_CAUSALITY and stale/future snapshots are rejected', async function () {
    var rows = candles(4, 1830000000000);
    function fakeFactory() {
        var snapshots = [], states = ['RANGE', 'BULL_TREND', 'RANGE', 'BEAR_TREND'];
        return { replay: async function (items) {
            snapshots = items.map(function (c, i) { return { version: 'MARKET_STATE_MAP_V1',
                evaluationTime: c.closeTime, state: states[i], stateSince: c.closeTime,
                trendEstablishedAt: states[i] === 'RANGE' ? null : c.closeTime,
                activeProtectedType: null, activeProtectedPrice: null }; });
            return { snapshots: snapshots, transitions: [], current: snapshots[snapshots.length - 1], latestEvaluationTime: snapshots[snapshots.length - 1].evaluationTime };
        }, onClosedCandle: async function () { throw new Error('unused'); }, getResult: function () { return { snapshots: snapshots, transitions: [], current: snapshots[snapshots.length - 1], latestEvaluationTime: snapshots[snapshots.length - 1].evaluationTime }; } };
    }
    var map = runtimeModule.createRuntime({ symbol: 'BTCUSDT', decide: decide, engineFactory: fakeFactory });
    await map.bootstrap(rows);
    assert.deepStrictEqual(rows.map(function (c) { return map.snapshotAt(c.closeTime).state; }), ['RANGE', 'BULL_TREND', 'RANGE', 'BEAR_TREND']);
    assert.strictEqual(map.snapshotAt(rows[0].closeTime - BAR), null);
    assert.strictEqual(map.snapshotAt(rows[3].closeTime + BAR), null);
    assert.strictEqual(map.snapshotAt(rows[1].closeTime).evaluationTime, rows[1].closeTime);
});

test('MARKET_STATE_RUNTIME_FUTURE_POISON_PARITY', async function () {
    var rows = candles(75, 1840000000000), cut = 49;
    var original = runtime('BTCUSDT'); await original.bootstrap(rows.slice(0, cut + 1));
    var poisonedRows = JSON.parse(JSON.stringify(rows));
    for (var i = cut + 1; i < poisonedRows.length; i++) {
        poisonedRows[i].open *= 10; poisonedRows[i].high *= 10; poisonedRows[i].low *= 10; poisonedRows[i].close *= 10;
    }
    var poisoned = runtime('BTCUSDT'); await poisoned.bootstrap(poisonedRows.slice(0, cut + 1));
    assert.deepStrictEqual(poisoned.snapshotAt(rows[cut].closeTime), original.snapshotAt(rows[cut].closeTime));
});

test('RANGE_READY_SEMANTICS', async function () {
    var rows = candles(20, 1850000000000).map(function (c) { c.open = 100; c.high = 100; c.low = 100; c.close = 100; return c; });
    var map = runtime('BTCUSDT'); await map.bootstrap(rows);
    assert.strictEqual(map.getStatus().status, 'READY');
    assert.strictEqual(map.getStatus().state, 'RANGE');
    assert.strictEqual(map.snapshotAt(rows[19].closeTime).state, 'RANGE');
});

test('MARKET_STATE_SYMBOL_ISOLATION', async function () {
    var btcRows = candles(50, 1860000000000), ethRows = candles(35, 1860000000000);
    var btc = runtime('BTCUSDT'), eth = runtime('ETHUSDT'); await Promise.all([btc.bootstrap(btcRows), eth.bootstrap(ethRows)]);
    var before = eth.getTimeline(); await btc.onClosedCandle(candles(51, 1860000000000)[50]);
    assert.deepStrictEqual(eth.getTimeline(), before);
    assert.notStrictEqual(btc.getStatus().latestEvaluationTime, eth.getStatus().latestEvaluationTime);
});

test('bootstrap and update failures are isolated and diagnostic', async function () {
    var events = [], rows = candles(16, 1870000000000);
    var failedBoot = runtime('BTCUSDT', { observe: function (x) { events.push(x); }, engineFactory: function () { return { replay: async function () { throw Object.assign(new Error('safe'), { code: 'LLM_TIMEOUT' }); } }; } });
    await failedBoot.bootstrap(rows); assert.strictEqual(failedBoot.getStatus().status, 'ERROR');
    assert.strictEqual(events[0].event, 'MARKET_STATE_BOOTSTRAP_STARTED');
    assert.strictEqual(events[1].event, 'MARKET_STATE_BOOTSTRAP_FAILED');
    assert.strictEqual(failedBoot.snapshotAt(rows[15].closeTime), null);
    var failedFetch = runtime('ETHUSDT', { observe: function (x) { events.push(x); } });
    failedFetch.failBootstrap(Object.assign(new Error('history unavailable'), { code: 'BINANCE_HISTORY_FAILED' }));
    assert.strictEqual(failedFetch.getStatus().status, 'ERROR');
    assert.strictEqual(failedFetch.getStatus().lastError.errorCode, 'BINANCE_HISTORY_FAILED');
});

test('Market State bootstrap history is exactly 2016 closed futures bars', async function () {
    var rows = candles(2020, 1880000000000), seen;
    var result = await dataSource.fetchMarketStateBootstrap5m('BTCUSDT', rows[rows.length - 1].closeTime + 1, {
        loadHistory: function (symbol, interval, start, end, options) { seen = { symbol: symbol, interval: interval, options: options }; return rows; }
    });
    assert.strictEqual(result.length, 2016); assert.strictEqual(result[0].openTime, rows[4].openTime);
    assert.deepStrictEqual(seen, { symbol: 'BTCUSDT', interval: '5m', options: { pageLimit: 1500 } });
    assert.strictEqual(runtimeModule.BOOTSTRAP_HISTORY_BARS, 2016);
});

test('live.js wires per-symbol runtime without awaiting Market State', function () {
    var source = fs.readFileSync(path.join(__dirname, '..', 'scripts/live.js'), 'utf8');
    assert.match(source, /marketStateMapV1Runtime\.createRuntime/);
    assert.match(source, /marketStateMap:\s*marketStateMap/);
    assert.match(source, /marketStateMap\.onClosedCandle\(c\)/);
    assert.doesNotMatch(source, /await\s+runnerOptions\.marketStateMap/);
});
