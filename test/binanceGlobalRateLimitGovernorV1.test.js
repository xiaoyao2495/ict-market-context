'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var governorModule = require('../data/binanceRateLimitGovernorV1');
var httpTransport = require('../data/binanceHttpTransportV1');
var executionClient = require('../execution/binanceExecutionClientV1');
var executionService = require('../execution/realOrderExecutionV1');
var executionRepository = require('../execution/executionRepositoryV1');

function tempState() {
    var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'binance-governor-v1-'));
    return { dir: dir, file: path.join(dir, 'state.json') };
}
function cleanup(temp) { fs.rmSync(temp.dir, { recursive: true, force: true }); }
function flush() { return new Promise(function (resolve) { setImmediate(resolve); }); }
function rateError(status, code, message, headers) {
    var error = new Error('rate limited');
    error.response = { status: status, data: { code: code, msg: message }, headers: headers || {} };
    return error;
}
function localBlock(until) {
    return Object.assign(new Error('BINANCE_RATE_LIMIT_BLOCKED_LOCALLY'), {
        code: 'BINANCE_RATE_LIMIT_BLOCKED_LOCALLY', blockedUntil: until, remainingMs: 1000,
        rateLimitReason: 'HTTP_418'
    });
}
function governor(temp, now, extra) {
    return governorModule.createGovernor(Object.assign({ statePath: temp.file, now: now,
        minRequestIntervalMs: 0, logger: function () {} }, extra || {}));
}

test('Retry-After supports seconds and HTTP-date forms', function () {
    var now = Date.parse('2026-09-11T00:00:00Z');
    assert.strictEqual(governorModule.parseRetryAfterMs('60', now), 60000);
    assert.strictEqual(governorModule.parseRetryAfterMs('Thu, 11 Sep 2026 00:02:00 GMT', now), 120000);
    assert.strictEqual(governorModule.parseRetryAfterMs('invalid', now), null);
});

test('HTTP 429 persists a global pause and next request makes zero HTTP calls', async function () {
    var temp = tempState(); var now = 1000000; var calls = 0;
    try {
        var g = governor(temp, function () { return now; });
        await assert.rejects(g.execute({ endpoint: '/fapi/v1/klines' }, function () {
            calls += 1; return Promise.reject(rateError(429, -1003, 'Too many requests', { 'Retry-After': '60' }));
        }), /rate limited/);
        assert.strictEqual(g.getState().blockedUntil, now + 60000);
        assert.strictEqual(g.getState().last429At, now);
        assert.strictEqual(g.getState().last418At, null);
        assert.strictEqual(JSON.parse(fs.readFileSync(temp.file, 'utf8')).blockedUntil, now + 60000);
        await assert.rejects(g.execute({ endpoint: '/fapi/v1/time' }, function () { calls += 1; }),
            function (error) { return error.code === 'BINANCE_RATE_LIMIT_BLOCKED_LOCALLY' && error.remainingMs === 60000; });
        assert.strictEqual(calls, 1);
    } finally { cleanup(temp); }
});

test('HTTP 418/-1003 uses max of Retry-After and explicit ban-until', async function () {
    var temp = tempState(); var now = 1700000000000; var explicit = now + 180000;
    try {
        var g = governor(temp, function () { return now; });
        await assert.rejects(g.execute({ endpoint: '/fapi/v1/klines' }, function () {
            return Promise.reject(rateError(418, -1003, 'IP banned until ' + explicit, { 'retry-after': '60' }));
        }));
        assert.strictEqual(g.getState().blockedUntil, explicit);
        assert.strictEqual(g.getState().last418At, now);
    } finally { cleanup(temp); }
});

test('invalid Retry-After uses the configured conservative cooldown without retry', async function () {
    var temp = tempState(); var now = 9000000; var calls = 0;
    try {
        var g = governor(temp, function () { return now; }, { default429CooldownMs: 75000 });
        await assert.rejects(g.execute({}, function () {
            calls += 1;
            return Promise.reject(rateError(429, -1003, 'Too many requests', { 'retry-after': 'invalid' }));
        }));
        assert.strictEqual(g.getState().blockedUntil, now + 75000);
        assert.strictEqual(g.getState().lastRetryAfterMs, 75000);
        await assert.rejects(g.execute({}, function () { calls += 1; }), /BINANCE_RATE_LIMIT_BLOCKED_LOCALLY/);
        assert.strictEqual(calls, 1);
    } finally { cleanup(temp); }
});

test('process restart restores persistent ban and allows paced HTTP only after expiry', async function () {
    var temp = tempState(); var now = 1700000000000; var until = now + 120000; var calls = 0;
    try {
        var a = governor(temp, function () { return now; });
        await assert.rejects(a.execute({}, function () {
            return Promise.reject(rateError(418, -1003, 'IP banned until ' + until));
        }));
        var b = governor(temp, function () { return now; });
        await assert.rejects(b.execute({}, function () { calls += 1; }), /BINANCE_RATE_LIMIT_BLOCKED_LOCALLY/);
        assert.strictEqual(calls, 0);
        now = until;
        var response = await b.execute({}, function () { calls += 1; return { data: { ok: true } }; });
        assert.strictEqual(response.data.ok, true);
        assert.strictEqual(calls, 1);
        assert.strictEqual(b.getState().blockedUntil, null);
    } finally { cleanup(temp); }
});

test('corrupt persistent state fails safe with a conservative local block', async function () {
    var temp = tempState(); var now = 5000000; var calls = 0;
    try {
        fs.writeFileSync(temp.file, '{broken');
        var g = governor(temp, function () { return now; }, { corruptStateCooldownMs: 45000 });
        await assert.rejects(g.execute({}, function () { calls += 1; }), /BINANCE_RATE_LIMIT_BLOCKED_LOCALLY/);
        assert.strictEqual(calls, 0);
        assert.strictEqual(g.getState().reason, 'STATE_CORRUPT');
        assert.strictEqual(JSON.parse(fs.readFileSync(temp.file, 'utf8')).blockedUntil, now + 45000);
    } finally { cleanup(temp); }
});

test('20 queued requests stop before transport after first 429', async function () {
    var temp = tempState(); var now = 1000; var calls = 0; var timers = [];
    try {
        var g = governor(temp, function () { return now; }, {
            minRequestIntervalMs: 100,
            setTimeout: function (fn, delay) { timers.push({ fn: fn, delay: delay }); return timers.length; },
            clearTimeout: function () {}
        });
        var promises = Array.from({ length: 20 }, function () {
            return g.execute({}, function () {
                calls += 1;
                return Promise.reject(rateError(429, -1003, 'Too many requests', { 'retry-after': '60' }));
            });
        });
        var settled = await Promise.allSettled(promises);
        assert.strictEqual(calls, 1);
        assert.strictEqual(settled.filter(function (x) { return x.status === 'rejected'; }).length, 20);
        assert.strictEqual(settled.filter(function (x) {
            return x.status === 'rejected' && x.reason.code === 'BINANCE_RATE_LIMIT_BLOCKED_LOCALLY';
        }).length, 19);
        assert.strictEqual(g.getState().queued, 0);
    } finally { cleanup(temp); }
});

test('global concurrency is capped at four', async function () {
    var temp = tempState(); var active = 0; var maxActive = 0; var releases = [];
    try {
        var g = governor(temp, Date.now, { maxConcurrency: 4 });
        var requests = Array.from({ length: 12 }, function () {
            return g.execute({}, function () {
                active += 1; maxActive = Math.max(maxActive, active);
                return new Promise(function (resolve) {
                    releases.push(function () { active -= 1; resolve({ data: {} }); });
                });
            });
        });
        await flush();
        assert.strictEqual(active, 4);
        while (releases.length || g.getState().queued || g.getState().inFlight) {
            releases.splice(0).forEach(function (release) { release(); });
            await flush();
        }
        await Promise.all(requests);
        assert.strictEqual(maxActive, 4);
    } finally { cleanup(temp); }
});

test('request starts honor a 100ms minimum interval with an injected clock', async function () {
    var temp = tempState(); var now = 0; var timers = []; var starts = [];
    try {
        var g = governor(temp, function () { return now; }, {
            minRequestIntervalMs: 100,
            setTimeout: function (fn, delay) { timers.push({ fn: fn, delay: delay }); return timers.length; },
            clearTimeout: function () {}
        });
        var promises = [1, 2, 3].map(function () { return g.execute({}, function () {
            starts.push(now); return { data: {} };
        }); });
        await flush();
        while (timers.length) {
            var timer = timers.shift(); now += timer.delay; timer.fn(); await flush();
        }
        await Promise.all(promises);
        assert.deepStrictEqual(starts, [0, 100, 200]);
    } finally { cleanup(temp); }
});

test('used weight and exchangeInfo REQUEST_WEIGHT limit are observed without hard-coding', async function () {
    var temp = tempState();
    try {
        var g = governor(temp, Date.now);
        await g.execute({}, function () { return { headers: { 'x-mbx-used-weight-1m': '123' },
            data: { rateLimits: [{ rateLimitType: 'REQUEST_WEIGHT', interval: 'MINUTE', intervalNum: 1, limit: 6000 }] } }; });
        assert.strictEqual(g.getState().usedWeight1m, 123);
        assert.strictEqual(g.getState().observedWeightLimit1m, 6000);
    } finally { cleanup(temp); }
});

test('rate-limit Futures failures never fall back to Spot; ordinary failure still does', async function () {
    var original = httpTransport.request;
    var binanceRest = require('../data/binanceRest');
    var urls = [];
    try {
        httpTransport.request = function (cfg) { urls.push(cfg.url);
            return Promise.reject(rateError(429, -1003, 'Too many requests')); };
        await assert.rejects(binanceRest.getKlines('BTCUSDT', '5m', 5));
        assert.strictEqual(urls.length, 1);
        assert.match(urls[0], /fapi\.binance\.com/);

        urls = [];
        httpTransport.request = function (cfg) {
            urls.push(cfg.url);
            if (urls.length === 1) return Promise.reject(Object.assign(new Error('temporary'), { response: { status: 503, data: {} } }));
            return Promise.resolve({ data: [[0, '1', '2', '0.5', '1.5', '10', 299999, '20']] });
        };
        var rows = await binanceRest.getKlines('BTCUSDT', '5m', 5);
        assert.strictEqual(urls.length, 2);
        assert.match(urls[1], /data-api\.binance\.vision/);
        assert.strictEqual(rows[0].source, 'spot-mirror');
    } finally { httpTransport.request = original; }
});

test('418, body -1003, and local governor blocks each suppress Spot fallback', async function () {
    var original = httpTransport.request;
    var binanceRest = require('../data/binanceRest');
    var cases = [rateError(418, -1003, 'IP banned'), rateError(400, -1003, 'Too many requests'), localBlock(Date.now() + 60000)];
    try {
        for (var i = 0; i < cases.length; i++) {
            var calls = 0; var expected = cases[i];
            httpTransport.request = function () { calls += 1; return Promise.reject(expected); };
            await assert.rejects(binanceRest.getKlines('BTCUSDT', '5m', 5));
            assert.strictEqual(calls, 1);
        }
    } finally { httpTransport.request = original; }
});

test('signed reads and mutations use the same governor transport gate', async function () {
    var admitted = [];
    var fakeGovernor = { execute: function (meta, call) { admitted.push(meta); return Promise.resolve().then(call); } };
    var client = executionClient.createClient({ apiKey: 'test-key', secret: 'test-secret', liveTradingEnabled: true,
        governor: fakeGovernor, transport: { request: function () { return Promise.resolve({ data: [] }); } } });
    await client.getPositionRisk('BTCUSDT');
    await client.setLeverage('BTCUSDT', 10);
    assert.deepStrictEqual(admitted.map(function (x) { return x.category; }), ['EXECUTION_REST', 'EXECUTION_MUTATION']);
});

test('REST block preserves active lifecycle as RECONCILING and WS event path remains active', async function () {
    var blocked = false; var onEvent; var events = [];
    var initial = { version: 'REAL_ORDER_EXECUTION_V1', consumedEqIds: {}, activeTradeId: 'T', trades: { T: {
        tradeId: 'T', symbol: 'BTCUSDT', status: 'PROTECTED', positionQty: 1,
        plan: { symbol: 'BTCUSDT', direction: 'LONG' },
        entryOrder: { clientOrderId: 'IMC_ENTRY', exchangeOrderId: 1, status: 'FILLED', requestedQty: 1 },
        slOrder: { clientOrderId: 'IMC_SL', exchangeOrderId: 2, status: 'NEW' },
        tpOrder: { clientOrderId: 'IMC_TP', exchangeOrderId: 3, status: 'NEW' }
    } } };
    function read(value) { return function () { return blocked ? Promise.reject(localBlock(Date.now() + 60000)) : Promise.resolve(value); }; }
    var client = {
        syncTime: read({}), getPositionMode: read({ dualSidePosition: false }),
        getSymbolConfig: read([{ symbol: 'BTCUSDT', marginType: 'CROSSED', leverage: 10 }]),
        getPositionRisk: read([{ positionAmt: '1' }]), getOpenOrders: read([]),
        getOpenAlgoOrders: read([{ clientAlgoId: 'IMC_SL', algoStatus: 'NEW' }, { clientAlgoId: 'IMC_TP', algoStatus: 'NEW' }]),
        queryOrder: read({ status: 'FILLED', origQty: '1', executedQty: '1' }),
        queryAlgoOrder: function (symbol, algoId, clientId) { return read({ clientAlgoId: clientId, algoStatus: 'NEW' })(); }
    };
    var repo = executionRepository.createRepository({ initial: initial });
    var service = executionService.createService({ symbol: 'BTCUSDT', liveTradingEnabled: true, repository: repo,
        client: client, observe: function (event) { events.push(event); },
        streamFactory: function (opts) { onEvent = opts.onEvent; return { start: function () { return Promise.resolve(); }, stop: function () { return Promise.resolve(); } }; }
    });
    await service.start();
    blocked = true;
    onEvent({ e: 'ORDER_TRADE_UPDATE' });
    await flush(); await flush();
    var trade = repo.activeTrade();
    assert.ok(trade);
    assert.strictEqual(trade.status, 'RECONCILING');
    assert.strictEqual(trade.reasonCode, 'DATA_SOURCE_BLOCKED');
    assert.strictEqual(trade.positionQty, 1);
    assert.strictEqual(trade.slOrder.status, 'NEW');
    assert.ok(events.some(function (event) { return event.type === 'DATA_SOURCE_BLOCKED'; }));
    await service.stop();
});

test('rate-limited protection placement is not retried and never triggers a blind emergency mutation', async function () {
    var protectionCalls = 0; var emergencyCalls = 0;
    var initial = { version: 'REAL_ORDER_EXECUTION_V1', consumedEqIds: {}, activeTradeId: 'T', trades: { T: {
        tradeId: 'T', symbol: 'BTCUSDT', status: 'FILLED', positionQty: 1,
        plan: { symbol: 'BTCUSDT', direction: 'LONG' },
        entryOrder: { clientOrderId: 'IMC_ENTRY', exchangeOrderId: 1, status: 'FILLED', requestedQty: 1 },
        slOrder: null, tpOrder: null
    } } };
    var blocked = localBlock(Date.now() + 60000);
    var client = {
        getPositionRisk: function () { return Promise.resolve([{ positionAmt: '1' }]); },
        getOpenOrders: function () { return Promise.resolve([]); },
        getOpenAlgoOrders: function () { return Promise.resolve([]); },
        queryOrder: function () { return Promise.resolve({ status: 'FILLED', origQty: '1', executedQty: '1' }); },
        queryAlgoOrder: function () { return Promise.resolve(null); },
        submitProtection: function () { protectionCalls += 1; return Promise.reject(blocked); },
        emergencyClose: function () { emergencyCalls += 1; return Promise.resolve({}); }
    };
    var repo = executionRepository.createRepository({ initial: initial });
    var service = executionService.createService({ symbol: 'BTCUSDT', liveTradingEnabled: true,
        repository: repo, client: client });
    await service.reconcile();
    assert.strictEqual(protectionCalls, 1);
    assert.strictEqual(emergencyCalls, 0);
    assert.strictEqual(repo.activeTrade().status, 'RECONCILING');
    assert.strictEqual(repo.activeTrade().reasonCode, 'DATA_SOURCE_BLOCKED');
});

test('startup account verification rate block preserves a restored active lifecycle', async function () {
    var streamStarts = 0; var events = [];
    var initial = { version: 'REAL_ORDER_EXECUTION_V1', consumedEqIds: {}, activeTradeId: 'T', trades: { T: {
        tradeId: 'T', symbol: 'BTCUSDT', status: 'PROTECTED', positionQty: 1,
        plan: { symbol: 'BTCUSDT', direction: 'LONG' },
        entryOrder: { clientOrderId: 'IMC_ENTRY', exchangeOrderId: 1, status: 'FILLED', requestedQty: 1 },
        slOrder: { clientOrderId: 'IMC_SL', exchangeOrderId: 2, status: 'NEW' },
        tpOrder: { clientOrderId: 'IMC_TP', exchangeOrderId: 3, status: 'NEW' }
    } } };
    var repo = executionRepository.createRepository({ initial: initial });
    var client = { syncTime: function () { return Promise.reject(localBlock(Date.now() + 60000)); } };
    var service = executionService.createService({ symbol: 'BTCUSDT', liveTradingEnabled: true,
        repository: repo, client: client, observe: function (event) { events.push(event); },
        streamFactory: function () { return { start: function () { streamStarts += 1; return Promise.resolve(); },
            stop: function () { return Promise.resolve(); } }; }
    });
    await service.start();
    var trade = repo.activeTrade();
    assert.ok(trade);
    assert.strictEqual(trade.status, 'RECONCILING');
    assert.strictEqual(trade.reasonCode, 'DATA_SOURCE_BLOCKED');
    assert.strictEqual(service.isExecutionReady(), false);
    assert.strictEqual(streamStarts, 0);
    assert.strictEqual(events.filter(function (event) { return event.type === 'DATA_SOURCE_BLOCKED'; }).length, 1);
    await service.stop();
});
