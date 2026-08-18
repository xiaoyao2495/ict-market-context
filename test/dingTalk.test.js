/**
 * Phase 11L.3 — 钉钉投递语义测试
 *
 * Fix 3（P1）：sendText 的 resolve 唯一语义 = 钉钉确认收到（errcode === 0）；
 * HTTP 成功但业务失败（errcode !== 0，如 310000）→ reject，调用方保留 pending 重试。
 */
var assert = require('assert');
var dingTalk = require('../notify/dingTalk');

var tests = [];
var passed = 0;
var failed = 0;

function test(name, fn) {
    tests.push({ name: name, fn: fn });
}

function mockFetch(impl) {
    var orig = globalThis.fetch;
    globalThis.fetch = impl;
    return function restore() {
        globalThis.fetch = orig;
    };
}

function jsonResponse(obj) {
    return Promise.resolve({
        json: function () { return Promise.resolve(obj); }
    });
}

test('sendText: errcode=0 → resolve（返回钉钉响应）', function () {
    var restore = mockFetch(function () { return jsonResponse({ errcode: 0, errmsg: 'ok' }); });
    return dingTalk.sendText('https://example.com/hook', '', '监测 test')
        .then(function (res) {
            assert.strictEqual(res.errcode, 0);
            restore();
        }).catch(function (e) { restore(); throw e; });
});

test('sendText: errcode=310000（业务失败）→ reject，视为投递失败', function () {
    var restore = mockFetch(function () { return jsonResponse({ errcode: 310000, errmsg: 'keywords not in content' }); });
    return dingTalk.sendText('https://example.com/hook', '', 'test')
        .then(function () {
            restore();
            throw new Error('应当 reject（errcode=310000）');
        }).catch(function (e) {
            restore();
            assert.ok(e.message.indexOf('310000') !== -1);
            assert.strictEqual(e.res.errcode, 310000);
        });
});

test('sendText: 网络失败 → reject', function () {
    var restore = mockFetch(function () { return Promise.reject(new Error('ECONNRESET')); });
    return dingTalk.sendText('https://example.com/hook', '', '监测 test')
        .then(function () {
            restore();
            throw new Error('应当 reject（网络错误）');
        }).catch(function (e) {
            restore();
            assert.ok(e.message.indexOf('ECONNRESET') !== -1);
        });
});

test('sendText: 响应体非 JSON → reject', function () {
    var restore = mockFetch(function () {
        return Promise.resolve({ json: function () { return Promise.reject(new Error('invalid json')); } });
    });
    return dingTalk.sendText('https://example.com/hook', '', '监测 test')
        .then(function () {
            restore();
            throw new Error('应当 reject（无效响应）');
        }).catch(function (e) {
            restore();
            assert.ok(e.message.indexOf('invalid json') !== -1);
        });
});

test('sendText: 响应为空对象 → reject', function () {
    var restore = mockFetch(function () { return jsonResponse({}); });
    return dingTalk.sendText('https://example.com/hook', '', '监测 test')
        .then(function () {
            restore();
            throw new Error('应当 reject（errcode 缺失）');
        }).catch(function (e) {
            restore();
            assert.ok(e.message.indexOf('errcode=none') !== -1);
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
    console.log('dingTalk sendText: ' + passed + ' passed, ' + failed + ' failed');
    if (failed > 0) {
        process.exit(1);
    }
});
