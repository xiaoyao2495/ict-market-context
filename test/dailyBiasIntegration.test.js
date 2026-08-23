/** Daily Bias -> Opportunity Integration V1 regression tests. */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var alignment = require('../bias/dailyBiasAlignment');
var serviceModule = require('../live/dailyBiasService');
var storeModule = require('../live/dailyBiasStore');
var liveEngine = require('../live/liveEngine');
var integrationAudit = require('../stats/dailyBiasIntegrationAudit');
var liveScript = require('../scripts/live');

var passed = 0;
var failed = 0;
var asyncTests = [];

function test(name, fn) {
    try {
        var result = fn();
        if (result && typeof result.then === 'function') {
            asyncTests.push(result.then(function () {
                passed++;
                console.log('PASS  ' + name);
            }).catch(function (e) {
                failed++;
                console.log('FAIL  ' + name + ' -> ' + e.message);
            }));
        } else {
            passed++;
            console.log('PASS  ' + name);
        }
    } catch (e) {
        failed++;
        console.log('FAIL  ' + name + ' -> ' + e.message);
    }
}

function memoryStore() {
    var state = { snapshot: null, lastAttempt: null };
    return {
        getState: function () { return state; },
        getSnapshot: function () { return state.snapshot; },
        getLastAttempt: function () { return state.lastAttempt; },
        recordSuccess: function (snapshot, attemptedAt) {
            state.snapshot = snapshot;
            state.lastAttempt = {
                evaluationTime: snapshot.evaluationTime,
                attemptedAt: attemptedAt,
                status: 'SUCCESS'
            };
        },
        recordFailure: function (evaluationTime, attemptedAt, error) {
            state.lastAttempt = {
                evaluationTime: evaluationTime,
                attemptedAt: attemptedAt,
                status: 'FAILED',
                error: { code: error.code, message: error.message }
            };
        }
    };
}

function candle(closeTime) {
    return { openTime: closeTime - serviceModule.FOUR_HOURS_MS + 1, closeTime: closeTime, closed: true };
}

test('computeBiasAlignment: MATCH / OPPOSITE / UNCLEAR / STALE / UNKNOWN', function () {
    assert.strictEqual(alignment.computeBiasAlignment({ bias: 'BULLISH', status: 'VALID' }, 'LONG'), 'MATCH');
    assert.strictEqual(alignment.computeBiasAlignment({ bias: 'BULLISH', status: 'VALID' }, 'SHORT'), 'OPPOSITE');
    assert.strictEqual(alignment.computeBiasAlignment({ bias: 'BEARISH', status: 'VALID' }, 'SHORT'), 'MATCH');
    assert.strictEqual(alignment.computeBiasAlignment({ bias: 'BEARISH', status: 'VALID' }, 'LONG'), 'OPPOSITE');
    assert.strictEqual(alignment.computeBiasAlignment({ bias: 'UNCLEAR', status: 'VALID' }, 'LONG'), 'UNCLEAR');
    assert.strictEqual(alignment.computeBiasAlignment({ bias: 'BULLISH', status: 'STALE' }, 'LONG'), 'UNKNOWN');
    assert.strictEqual(alignment.computeBiasAlignment({ bias: 'UNKNOWN', status: 'UNKNOWN' }, 'LONG'), 'UNKNOWN');
});

test('Live opportunity 只附加 dailyBias 六字段，tier/notifyPriority 不变', function () {
    var opp = {
        id: 'x', direction: 'BULLISH', availableAt: 2000,
        tier: 'HIGH_QUALITY', notifyPriority: 'PRIORITY_HIGH'
    };
    liveEngine.attachDailyBias(opp, function () {
        return {
            bias: 'BEARISH', confidence: 'HIGH', alignment: 'OPPOSITE', status: 'VALID',
            evaluationTime: 1000, ageMs: 1000
        };
    });
    assert.deepStrictEqual(Object.keys(opp.dailyBias).sort(),
        ['ageMs', 'alignment', 'bias', 'confidence', 'evaluationTime', 'status'].sort());
    assert.strictEqual(opp.tier, 'HIGH_QUALITY');
    assert.strictEqual(opp.notifyPriority, 'PRIORITY_HIGH');
});

test('每个新 CLOSED 4H 只请求一次；同一 4H 不随 5m 重复请求', function () {
    var requests = 0;
    var now = 100000;
    var service = serviceModule.createDailyBiasService({
        symbol: 'BTCUSDT', store: memoryStore(), now: function () { return now; },
        requestBias: function (symbol, candles, evaluationTime) {
            requests++;
            return Promise.resolve({ bias: 'BULLISH', confidence: 'HIGH', evaluationTime: evaluationTime });
        }
    });
    var c = [candle(1000)];
    return service.updateOnClosed4h(c).then(function (first) {
        assert.strictEqual(first.updated, true);
        return service.updateOnClosed4h(c);
    }).then(function (second) {
        assert.strictEqual(second.attempted, false);
        assert.strictEqual(second.reason, 'ALREADY_ATTEMPTED');
        assert.strictEqual(requests, 1);
    });
});

test('API failure 保留上一 snapshot：<=8h STALE，>8h UNKNOWN', function () {
    var now = 1000;
    var shouldFail = false;
    var store = memoryStore();
    var service = serviceModule.createDailyBiasService({
        symbol: 'BTCUSDT', store: store, now: function () { return now; },
        requestBias: function (symbol, candles, evaluationTime) {
            if (shouldFail) {
                var error = new Error('api down'); error.code = 'NETWORK_ERROR';
                return Promise.reject(error);
            }
            return Promise.resolve({ bias: 'BEARISH', confidence: 'MEDIUM', evaluationTime: evaluationTime });
        }
    });
    var firstEval = 1000;
    return service.updateOnClosed4h([candle(firstEval)]).then(function () {
        shouldFail = true;
        now = firstEval + serviceModule.FOUR_HOURS_MS;
        return service.updateOnClosed4h([candle(firstEval), candle(now)]);
    }).then(function (failed) {
        assert.strictEqual(failed.updated, false);
        assert.strictEqual(store.getSnapshot().bias, 'BEARISH', '上一份有效 snapshot 必须保留');
        var stale = service.getDailyBias('SHORT', firstEval + serviceModule.EIGHT_HOURS_MS);
        assert.strictEqual(stale.bias, 'BEARISH');
        assert.strictEqual(stale.status, 'STALE');
        assert.strictEqual(stale.alignment, 'UNKNOWN');
        var unknown = service.getDailyBias('SHORT', firstEval + serviceModule.EIGHT_HOURS_MS + 1);
        assert.strictEqual(unknown.bias, 'UNKNOWN');
        assert.strictEqual(unknown.confidence, null);
        assert.strictEqual(unknown.status, 'UNKNOWN');
        assert.strictEqual(unknown.alignment, 'UNKNOWN');
    });
});

test('未来 snapshot 不得回写历史 opportunity', function () {
    var store = memoryStore();
    store.recordSuccess({
        symbol: 'BTCUSDT', bias: 'BULLISH', confidence: 'HIGH', evaluationTime: 2000
    }, 2000);
    var service = serviceModule.createDailyBiasService({ symbol: 'BTCUSDT', store: store });
    assert.deepStrictEqual(service.getDailyBias('LONG', 1999), alignment.unknownDailyBias());
});

test('DailyBiasSnapshot store 持久化最近有效 snapshot 与失败 attempt', function () {
    var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-bias-store-'));
    var file = path.join(dir, 'daily-bias.json');
    try {
        var store = storeModule.createDailyBiasStore(file, 'BTCUSDT');
        store.recordSuccess({ bias: 'BULLISH', confidence: 'HIGH', evaluationTime: 1000 }, 1100);
        var error = new Error('down'); error.code = 'NETWORK_ERROR';
        store.recordFailure(2000, 2100, error);
        var loaded = storeModule.createDailyBiasStore(file, 'BTCUSDT');
        assert.strictEqual(loaded.getSnapshot().evaluationTime, 1000);
        assert.strictEqual(loaded.getLastAttempt().evaluationTime, 2000);
        assert.strictEqual(loaded.getLastAttempt().status, 'FAILED');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('Replay enrichment audit: detection/tier/notification 数量完全不变', function () {
    var before = [
        { id: 'a', direction: 'BULLISH', tier: 'HIGH_QUALITY', notifyPriority: 'PRIORITY_HIGH' },
        { id: 'b', direction: 'BEARISH', tier: 'WATCH', notifyPriority: null },
        { id: 'c', direction: 'BULLISH', tier: 'LOW', notifyPriority: null },
        { id: 'd', direction: 'BEARISH', tier: 'HIGH_QUALITY', notifyPriority: 'STANDARD_HIGH' }
    ];
    var contexts = [
        { bias: 'BULLISH', confidence: 'HIGH', alignment: 'MATCH', status: 'VALID', evaluationTime: 1, ageMs: 1 },
        { bias: 'BULLISH', confidence: 'HIGH', alignment: 'OPPOSITE', status: 'VALID', evaluationTime: 1, ageMs: 1 },
        { bias: 'UNCLEAR', confidence: 'LOW', alignment: 'UNCLEAR', status: 'VALID', evaluationTime: 1, ageMs: 1 },
        { bias: 'UNKNOWN', confidence: null, alignment: 'UNKNOWN', status: 'UNKNOWN', evaluationTime: null, ageMs: null }
    ];
    var after = integrationAudit.enrichOpportunities(before, function (opp) {
        return contexts[before.indexOf(opp)];
    });
    function shouldNotify(opp) {
        return opp.tier === 'HIGH_QUALITY' && opp.notifyPriority === 'PRIORITY_HIGH';
    }
    var result = integrationAudit.audit(before, after, shouldNotify);
    assert.strictEqual(result.DETECTION_CHANGED, false);
    assert.strictEqual(result.TIER_CHANGED, false);
    assert.strictEqual(result.NOTIFICATION_FILTER_CHANGED, false);
    assert.deepStrictEqual(after.map(function (x) { return x.tier; }), before.map(function (x) { return x.tier; }));
    console.log(JSON.stringify(result));
});

test('Non-interference audit 会捕获同数量下的 tier/通知对象偷换', function () {
    var before = [
        { id: 'a', tier: 'HIGH_QUALITY', notify: true },
        { id: 'b', tier: 'WATCH', notify: false }
    ];
    var after = [
        { id: 'a', tier: 'WATCH', notify: false },
        { id: 'b', tier: 'HIGH_QUALITY', notify: true }
    ];
    var result = integrationAudit.audit(before, after, function (x) { return x.notify; });
    assert.strictEqual(result.DETECTION_CHANGED, false);
    assert.strictEqual(result.TIER_CHANGED, true);
    assert.strictEqual(result.NOTIFICATION_FILTER_CHANGED, true);
});

test('DingTalk 报告包含 Daily Bias 区块', function () {
    var message = liveScript.buildMessage({
        direction: 'BULLISH', tier: 'HIGH_QUALITY', notifyPriority: 'PRIORITY_HIGH',
        mssQuality: 'PROTECTED_SWING', legQuality: 'STRONG', legRangeAtr: 2,
        availableAt: 2000, anchorTime: 1000, nearTarget: null, nearDistPct: null,
        notificationNearTarget: null, liquidityContext: null,
        dailyBias: {
            bias: 'BULLISH', confidence: 'HIGH', alignment: 'MATCH', status: 'VALID',
            evaluationTime: 1000, ageMs: 1000
        }
    }, 'BTCUSDT');
    assert.ok(message.indexOf('Daily Bias:') >= 0);
    assert.ok(message.indexOf('BULLISH / HIGH · MATCH · VALID') >= 0);
    assert.ok(message.indexOf('Bias Eval:') >= 0);
});

Promise.all(asyncTests).then(function () {
    console.log('----');
    console.log('dailyBiasIntegration: ' + passed + ' passed, ' + failed + ' failed');
    if (failed > 0) process.exit(1);
});
