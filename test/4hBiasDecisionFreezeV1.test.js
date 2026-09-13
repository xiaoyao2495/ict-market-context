'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var os = require('os');
var path = require('path');
var biasV3 = require('../live/4hBiasV3');
var storeV1 = require('../bias/4hBiasDecisionStoreV1');
var renderer = require('../bias/4hBiasFactRendererV1');
var factsV3 = require('../bias/directionalContext/4hBiasFactsV3');
var semanticV3 = require('../bias/4hBiasSemanticV3');
var notification = require('../notify/4hBiasContext');
var executionRules = require('../execution/executionRulesV1');

function tempDirectory(t) {
    var directory = fs.mkdtempSync(path.join(os.tmpdir(), '4h-bias-freeze-v1-'));
    t.after(function () { fs.rmSync(directory, { recursive: true, force: true }); });
    return directory;
}

function source() {
    return [{ openTime: 0, closeTime: 14399999, open: 1, high: 2, low: 0, close: 1, closed: true, source: 'futures' }];
}

function facts(values) {
    return Object.assign({
        normalizedDirectionalSpread: 0.21475,
        adx14: 29.64759,
        signedMoveAtr24: 0.13924,
        signedEfficiency24: 0.04822,
        theilSenSlope48: 0.00001,
        structureDirection: 'UP'
    }, values || {});
}

function factSet(symbol, closeTime, values) {
    return { version: factsV3.VERSION, symbol: symbol, timeframe: '4h', closedAt: closeTime, facts: facts(values) };
}

function llmDecision(confidence, summary) {
    return {
        direction: 'BEARISH', strength: 'STRONG', confidence: confidence || 'HIGH',
        summary: summary || 'diagnostic only', conflicts: 'NONE'
    };
}

function service(options) {
    var opts = options || {};
    var candles = opts.candles || source();
    return biasV3.createService({
        symbol: opts.symbol || 'RAYSOLUSDT',
        getFourHourCandles: function () { return candles; },
        buildFacts: opts.buildFacts || function (rows, closeTime) { return factSet(opts.symbol || 'RAYSOLUSDT', closeTime, opts.factValues); },
        requestSemantic: opts.requestSemantic || function () { return Promise.resolve(llmDecision()); },
        decisionStore: opts.decisionStore,
        promptHash: opts.promptHash,
        promptVersion: opts.promptVersion,
        modelId: opts.modelId
    });
}

function identity(overrides) {
    var x = overrides || {};
    return storeV1.buildIdentity({
        symbol: x.symbol || 'RAYSOLUSDT', openTime: 0, closeTime: 14399999,
        factsVersion: factsV3.VERSION, facts: facts(x.factValues),
        promptHash: x.promptHash || semanticV3.PROMPT_HASH,
        promptVersion: x.promptVersion || semanticV3.VERSION,
        modelId: x.modelId || semanticV3.MODEL
    });
}

test('01 canonical serialization sorts keys, preserves exact finite values and canonicalizes negative zero', function () {
    assert.equal(storeV1.stableSerialize({ z: true, b: null, a: -0, nested: { y: 'x', x: 0.06387 } }),
        '{"a":0,"b":null,"nested":{"x":0.06387,"y":"x"},"z":true}');
    assert.throws(function () { storeV1.stableSerialize({ x: Infinity }); }, /CANONICAL_NON_FINITE/);
});

test('02 restart reuses first durable RAYSOL decision and makes zero second-process LLM calls', async function (t) {
    var directory = tempDirectory(t), firstCalls = 0, secondCalls = 0;
    var first = service({ decisionStore: storeV1.createStore({ directory: directory }), requestSemantic: function () {
        firstCalls += 1; return Promise.resolve(llmDecision('HIGH'));
    }});
    var a = await first.refresh(14399999);
    var second = service({ decisionStore: storeV1.createStore({ directory: directory }), requestSemantic: function () {
        secondCalls += 1; return Promise.resolve(llmDecision('MEDIUM'));
    }});
    var b = await second.refresh(14399999);
    assert.equal(firstCalls, 1); assert.equal(secondCalls, 0);
    assert.deepEqual(b.semantic, { direction: 'BEARISH', strength: 'STRONG', confidence: 'HIGH' });
    assert.equal(a.decisionKey, b.decisionKey); assert.equal(b.decisionSource, 'FROZEN_STORE');
});

test('02a durable freeze opens the temporary file read-write for fsync and transitions MISS to HIT', function (t) {
    var directory = tempDirectory(t), expected = identity(), openedTemporary = [], temporaryHandles = new Set();
    var originalOpenSync = fs.openSync, originalFsyncSync = fs.fsyncSync, originalCloseSync = fs.closeSync;
    fs.openSync = function (file, flags, mode) {
        var handle = originalOpenSync.call(fs, file, flags, mode);
        if (flags === 'r+' && path.dirname(String(file)) === directory && /\.tmp$/.test(path.basename(String(file)))) {
            openedTemporary.push({ flags: flags, handle: handle });
            temporaryHandles.add(handle);
        }
        return handle;
    };
    var temporaryFsyncCount = 0;
    fs.fsyncSync = function (handle) {
        if (temporaryHandles.has(handle)) temporaryFsyncCount += 1;
        return originalFsyncSync.call(fs, handle);
    };
    fs.closeSync = function (handle) {
        temporaryHandles.delete(handle);
        return originalCloseSync.call(fs, handle);
    };
    try {
        var disk = storeV1.createStore({ directory: directory });
        assert.equal(disk.lookup(expected).status, 'MISS');
        var frozen = disk.freeze(expected,
            { direction: 'BEARISH', strength: 'STRONG', confidence: 'HIGH' }, 1);
        assert.equal(frozen.created, true);
        assert.equal(disk.lookup(expected).status, 'HIT');
    } finally {
        fs.openSync = originalOpenSync;
        fs.fsyncSync = originalFsyncSync;
        fs.closeSync = originalCloseSync;
    }
    assert.deepEqual(openedTemporary.map(function (item) { return item.flags; }), ['r+']);
    assert.equal(temporaryFsyncCount, 1);
});

test('03 twenty simultaneous same-key refreshes produce one LLM call and one official decision', async function (t) {
    var resolve, calls = 0, directory = tempDirectory(t);
    var instance = service({ decisionStore: storeV1.createStore({ directory: directory }), requestSemantic: function () {
        calls += 1; return new Promise(function (done) { resolve = done; });
    }});
    var pending = Array.from({ length: 20 }, function () { return instance.refresh(14399999); });
    await Promise.resolve();
    assert.equal(calls, 1);
    resolve(llmDecision('HIGH'));
    var results = await Promise.all(pending);
    assert.ok(results.every(function (item) { return item.decisionKey === results[0].decisionKey; }));
    assert.equal(fs.readdirSync(directory).filter(function (name) { return /\.json$/.test(name); }).length, 1);
});

test('04 changed facts on the same candle create an independent immutable record', async function (t) {
    var directory = tempDirectory(t), calls = 0;
    function request() { calls += 1; return Promise.resolve(llmDecision(calls === 1 ? 'HIGH' : 'MEDIUM')); }
    var a = await service({ decisionStore: storeV1.createStore({ directory: directory }), requestSemantic: request }).refresh(14399999);
    var b = await service({ decisionStore: storeV1.createStore({ directory: directory }), requestSemantic: request,
        factValues: { normalizedDirectionalSpread: 0.214751 } }).refresh(14399999);
    var again = await service({ decisionStore: storeV1.createStore({ directory: directory }), requestSemantic: request }).refresh(14399999);
    assert.equal(calls, 2); assert.notEqual(a.decisionKey, b.decisionKey);
    assert.equal(a.semantic.confidence, 'HIGH'); assert.equal(b.semantic.confidence, 'MEDIUM');
    assert.equal(again.semantic.confidence, 'HIGH');
});

test('05 prompt identity and model identity independently invalidate cache', async function (t) {
    var directory = tempDirectory(t), calls = 0;
    function request() { calls += 1; return Promise.resolve(llmDecision('HIGH')); }
    await service({ decisionStore: storeV1.createStore({ directory: directory }), requestSemantic: request }).refresh(14399999);
    await service({ decisionStore: storeV1.createStore({ directory: directory }), requestSemantic: request,
        promptHash: 'prompt-hash-v2' }).refresh(14399999);
    await service({ decisionStore: storeV1.createStore({ directory: directory }), requestSemantic: request,
        modelId: 'deepseek-next' }).refresh(14399999);
    assert.equal(calls, 3);
    assert.equal(fs.readdirSync(directory).filter(function (name) { return /\.json$/.test(name); }).length, 3);
});

test('06 persist failure never publishes ephemeral decision and blocks entry', async function () {
    var brokenStore = { lookup: function () { return { status: 'MISS' }; }, freeze: function () {
        throw Object.assign(new Error('disk unavailable'), { code: 'BIAS_DECISION_STORE_ERROR' });
    }};
    var result = await service({ decisionStore: brokenStore }).refresh(14399999);
    assert.equal(result.status, 'UNAVAILABLE'); assert.equal(result.semantic, null);
    assert.equal(result.error.stage, 'DECISION_STORE');
    assert.equal(executionRules.biasGate('SHORT', result, 14399999).reasonCode, 'HTF_UNAVAILABLE');
});

test('07 corrupt official record fails closed without asking LLM or overwriting', async function (t) {
    var directory = tempDirectory(t), expected = identity(), calls = 0;
    fs.writeFileSync(path.join(directory, expected.decisionKey + '.json'), '{broken');
    var result = await service({ decisionStore: storeV1.createStore({ directory: directory }), requestSemantic: function () {
        calls += 1; return Promise.resolve(llmDecision());
    }}).refresh(14399999);
    assert.equal(calls, 0); assert.equal(result.status, 'UNAVAILABLE');
    assert.equal(result.error.code, 'BIAS_DECISION_STORE_CORRUPT');
    assert.equal(fs.readFileSync(path.join(directory, expected.decisionKey + '.json'), 'utf8'), '{broken');
});

test('07b invalid decision enum in an official record is corruption and cannot trigger regeneration', async function (t) {
    var directory = tempDirectory(t), expected = identity(), disk = storeV1.createStore({ directory: directory }), calls = 0;
    var frozen = disk.freeze(expected, { direction: 'BEARISH', strength: 'STRONG', confidence: 'HIGH' }, 1);
    var file = path.join(directory, expected.decisionKey + '.json');
    var record = frozen.record; record.decision.confidence = 'CERTAIN';
    fs.writeFileSync(file, JSON.stringify(record));
    var result = await service({ decisionStore: storeV1.createStore({ directory: directory }), requestSemantic: function () {
        calls += 1; return Promise.resolve(llmDecision());
    }}).refresh(14399999);
    assert.equal(calls, 0); assert.equal(result.status, 'UNAVAILABLE');
    assert.equal(result.error.code, 'BIAS_DECISION_STORE_CORRUPT');
});

test('07c factsHash mismatch in an official record is corruption and cannot trigger regeneration', async function (t) {
    var directory = tempDirectory(t), expected = identity(), disk = storeV1.createStore({ directory: directory }), calls = 0;
    var frozen = disk.freeze(expected, { direction: 'BEARISH', strength: 'STRONG', confidence: 'HIGH' }, 1);
    var file = path.join(directory, expected.decisionKey + '.json');
    var record = frozen.record; record.factsHash = '0'.repeat(64);
    fs.writeFileSync(file, JSON.stringify(record));
    var result = await service({ decisionStore: storeV1.createStore({ directory: directory }), requestSemantic: function () {
        calls += 1; return Promise.resolve(llmDecision());
    }}).refresh(14399999);
    assert.equal(calls, 0); assert.equal(result.status, 'UNAVAILABLE');
    assert.equal(result.error.code, 'BIAS_DECISION_STORE_CORRUPT');
});

test('08 create-if-absent makes first durable candidate win across independent store instances', function (t) {
    var directory = tempDirectory(t), expected = identity();
    var a = storeV1.createStore({ directory: directory }).freeze(expected,
        { direction: 'BEARISH', strength: 'STRONG', confidence: 'HIGH' }, 1);
    var b = storeV1.createStore({ directory: directory }).freeze(expected,
        { direction: 'BEARISH', strength: 'STRONG', confidence: 'MEDIUM' }, 2);
    assert.equal(a.created, true); assert.equal(b.created, false);
    assert.deepEqual(b.record.decision, a.record.decision);
});

test('09 deterministic renderer preserves positive, negative, zero and null signs', function () {
    ['0.06387', '0.21475', '0.13924', '0.04822'].forEach(function (value) {
        assert.equal(renderer.numberText(Number(value), true), '+' + value);
    });
    assert.equal(renderer.numberText(-0.21475, true), '-0.21475');
    assert.equal(renderer.numberText(0, true), '0');
    assert.equal(renderer.numberText(-0, true), '0');
    assert.equal(renderer.numberText(null, true), 'null');
});

test('10 positive spread may coexist with frozen bearish semantic decision', function () {
    var text = notification.lines({ status: 'AVAILABLE', semantic: { direction: 'BEARISH', strength: 'STRONG', confidence: 'HIGH' }, facts: facts() }).join('\n');
    assert.match(text, /normalizedDirectionalSpread: \+0\.21475/);
    assert.match(text, /方向: .*BEARISH/);
});

test('11 production notification never uses LLM factual prose', function () {
    var text = notification.lines({ status: 'AVAILABLE', semantic: llmDecision('HIGH', 'spread is negative'), facts: facts() }).join('\n');
    assert.match(text, /normalizedDirectionalSpread: \+0\.21475/);
    assert.doesNotMatch(text, /spread is negative|diagnostic only|解读:/);
});

test('12 execution gate semantics remain exact and consume only structured decision fields', function () {
    function bias(direction, confidence) { return { status: 'AVAILABLE', closedAt: 10,
        semantic: { direction: direction, strength: 'STRONG', confidence: confidence, summary: 'ignored prose' } }; }
    assert.equal(executionRules.biasGate('LONG', bias('BULLISH', 'HIGH'), 10).ok, true);
    assert.equal(executionRules.biasGate('LONG', bias('BULLISH', 'MEDIUM'), 10).reasonCode, 'HTF_NOT_HIGH_CONFIDENCE');
    assert.equal(executionRules.biasGate('SHORT', bias('BEARISH', 'HIGH'), 10).ok, true);
});
