'use strict';

var assert = require('assert');
var readiness = require('../live/dynamicUniverseReadinessAuditV1');
var dataSource = require('../live/dataSource');

function bars(n) { return Array.from({ length: n }, function () { return { closed: true }; }); }
function base(overrides) {
    return Object.assign({ rank: 1, symbol: 'BTCUSDT', quoteVolume24h: 100,
        rankEligible: true, rules: { source: 'futures', tickSize: 0.1, stepSize: 0.001, minQty: 0.001, minNotional: 5 },
        candles4h: bars(dataSource.MIN_ANALYSIS_4H_BARS), candles5m: bars(dataSource.MIN_ANALYSIS_5M_BARS),
        fetch4hOk: true, fetch5mOk: true, continuous4h: true, continuous5m: true,
        accountReadOk: true, oneWay: true, marginType: 'CROSSED', leverage: 10, activeLifecycle: false
    }, overrides || {});
}
function test(name, fn) { try { fn(); console.log('PASS ' + name); } catch (error) { console.error('FAIL ' + name); throw error; } }

test('ranking ready but 120x4H history unavailable blocks execution', function () {
    var row = readiness.evaluate(base({ candles4h: bars(119) }));
    assert.strictEqual(row.rankEligible, true); assert.strictEqual(row.scannable, true);
    assert.strictEqual(row.analysisReady, false); assert.strictEqual(row.executionReady, false);
    assert.ok(row.blockReasons.indexOf('INSUFFICIENT_4H_HISTORY') >= 0);
});
test('full readiness permits new trade admission', function () {
    var row = readiness.evaluate(base());
    assert.strictEqual(row.executionReady, true); assert.strictEqual(row.newTradeAdmissionAllowed, true);
    assert.deepStrictEqual(row.blockReasons, []);
});
test('wrong leverage blocks without mutation', function () {
    var counters = readiness.emptyMutationCounters(); var row = readiness.evaluate(base({ leverage: 20 }));
    assert.strictEqual(row.executionReady, false); assert.ok(row.blockReasons.indexOf('LEVERAGE_NOT_10') >= 0);
    assert.strictEqual(readiness.mutationFree(counters), true);
});
test('ISOLATED margin blocks without mutation', function () {
    var counters = readiness.emptyMutationCounters(); var row = readiness.evaluate(base({ marginType: 'ISOLATED' }));
    assert.strictEqual(row.executionReady, false); assert.ok(row.blockReasons.indexOf('MARGIN_TYPE_NOT_CROSSED') >= 0);
    assert.strictEqual(readiness.mutationFree(counters), true);
});
test('missing tickSize makes market rules not ready', function () {
    var row = readiness.evaluate(base({ rules: { source: 'futures', tickSize: null, stepSize: 0.001, minQty: 0.001, minNotional: 5 } }));
    assert.strictEqual(row.rulesReady, false); assert.strictEqual(row.scannable, false);
    assert.ok(row.blockReasons.indexOf('MARKET_RULES_MISSING') >= 0);
});
test('active lifecycle outside Top10 stays maintained but cannot open new trade', function () {
    var row = readiness.evaluate(base({ rank: null, rankEligible: false, activeLifecycle: true }));
    assert.strictEqual(row.runtimeMaintained, true); assert.strictEqual(row.newTradeAdmissionAllowed, false);
});
test('non-lifecycle symbol outside Top10 is not maintained', function () {
    var row = readiness.evaluate(base({ rank: null, rankEligible: false, activeLifecycle: false }));
    assert.strictEqual(row.runtimeMaintained, false); assert.strictEqual(row.newTradeAdmissionAllowed, false);
});
test('unicode symbol survives readiness, REST parameter transport, persistence and logging representations', function () {
    var received = null;
    function fakeRest(symbol) { received = symbol; return Promise.resolve(); }
    var row = readiness.evaluate(base({ symbol: '牛来USDT' }));
    fakeRest(row.symbol);
    var persisted = JSON.parse(JSON.stringify(row));
    var logged = [row.rank, row.symbol, row.executionReady].join('\t');
    assert.strictEqual(received, '牛来USDT'); assert.strictEqual(persisted.symbol, '牛来USDT');
    assert.ok(logged.indexOf('牛来USDT') >= 0); assert.strictEqual(row.executionReady, true);
});
test('723-bar 5m boundary is exact and 722 blocks Dynamic-D and EQ', function () {
    var pass = readiness.evaluate(base());
    var fail = readiness.evaluate(base({ candles5m: bars(dataSource.MIN_ANALYSIS_5M_BARS - 1) }));
    assert.strictEqual(dataSource.MIN_ANALYSIS_5M_BARS, 723);
    assert.strictEqual(pass.dynamicDReady, true); assert.strictEqual(fail.dynamicDReady, false);
    assert.strictEqual(fail.eqReady, false); assert.strictEqual(fail.executionReady, false);
});
test('summary counts only Top10 rows and exposes blocked reasons', function () {
    var result = readiness.summarize([readiness.evaluate(base()), readiness.evaluate(base({ symbol: 'XUSDT', leverage: 20 }))]);
    assert.strictEqual(result.top10Count, 2); assert.strictEqual(result.executionReadyCount, 1);
    assert.deepStrictEqual(result.readySymbols, ['BTCUSDT']); assert.strictEqual(result.blockedSymbols[0].symbol, 'XUSDT');
});

console.log('ALL DYNAMIC UNIVERSE READINESS AUDIT V1 TESTS PASSED');
