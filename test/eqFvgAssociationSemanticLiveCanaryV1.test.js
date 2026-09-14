'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var contract = require('../semantic/eqFvgAssociationSemanticV1');
var factsModule = require('../semantic/eqFvgAssociationFactsV1');
var storeModule = require('../semantic/eqFvgAssociationDecisionStoreV1');
var serviceModule = require('../live/eqFvgAssociationSemanticV1');
var archiveModule = require('../semantic/eqFvgAssociationCaseArchiveV1');
var alertModule = require('../live/eqFvgCountWatchAlertServiceV1');
var notification = require('../notify/eqFvgCountWatchNotificationV1');
var execution = require('../execution/realOrderExecutionV1');
var executionRepository = require('../execution/executionRepositoryV1');
var realTradeArchive = require('../execution/realTradeCaseArchiveV1');
var loadConfig = require('../config/eqFvgSemanticV1');

function decision(association, confidence) {
    return { association: association, confidence: confidence || 'HIGH', primaryReason: 'DIRECT_CONTINUOUS_REPRICING',
        evidence: ['causal evidence'], counterEvidence: [] };
}
function facts(suffix) {
    return factsModule.validate({ semanticTask: 'EQ_FVG_ASSOCIATION_V1', direction: 'LONG',
        eq: { eqConfirmedAt: '2026-09-14T00:00:00.000Z', marker: suffix || 'a' },
        fvg: { confirmedAt: '2026-09-14T00:05:00.000Z' }, temporalDistance: {}, pricePath: {}, pivots: {},
        structure: {}, displacement: {}, interveningEq: {}, levelInteraction: {} });
}
function event() {
    return { ordinal: 1, symbol: 'BTCUSDT', watchId: 'W', liquidityId: 'EQ', liquidityType: 'EQL',
        liquidityPrice: 99, eqConfirmedAt: Date.parse('2026-09-14T00:00:00.000Z'),
        eqSourceContext: { status: 'AVAILABLE', currentPivot: { price: 99, occurredAt: 1, confirmedAt: 2 }, historicalPartners: [] },
        rawFvg: { id: 'FVG', direction: 'BULLISH', low: 100, high: 102, k3Index: 3,
            confirmedAt: Date.parse('2026-09-14T00:05:00.000Z') }, watchStatusAfterEvent: 'OPEN' };
}
function raw(value) {
    return { rawContent: JSON.stringify(value), rawResponseModelId: 'deepseek-flash',
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, finishReason: 'stop' };
}
function harness(output, overrides) {
    var requested = 0, notified = 0, archived = [];
    var service = serviceModule.createService(Object.assign({ config: { enabled: true, liveGateEnabled: true, failClosed: true },
        store: storeModule.createMemoryStore(), buildFacts: function () { return facts(); },
        request: function () { requested += 1; return Promise.resolve(raw(output)); },
        notify: function () { notified += 1; }, archive: function (record) { archived.push(record); return 'case.json'; }
    }, overrides || {}));
    return { service: service, requested: function () { return requested; }, notified: function () { return notified; }, archived: archived };
}

[
    ['STRONG_ASSOCIATION', 'HIGH', 'PASS'], ['PLAUSIBLE_ASSOCIATION', 'HIGH', 'PASS'],
    ['WEAK_ASSOCIATION', 'HIGH', 'BLOCK'], ['BROKEN_ASSOCIATION', 'HIGH', 'BLOCK'],
    ['UNCLEAR', 'HIGH', 'BLOCK'], ['STRONG_ASSOCIATION', 'MEDIUM', 'BLOCK'],
    ['PLAUSIBLE_ASSOCIATION', 'MEDIUM', 'BLOCK'], ['STRONG_ASSOCIATION', 'LOW', 'BLOCK']
].forEach(function (row) {
    test(row[0] + ' + ' + row[1] + ' => ' + row[2], function () {
        assert.strictEqual(contract.evaluateGate(decision(row[0], row[1])).result, row[2]);
    });
});

test('timeout and invalid schema fail closed without execution admission', async function () {
    var timeout = harness(null, { request: function () { return Promise.reject(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })); } });
    var a = await timeout.service.evaluate(event(), {});
    assert.strictEqual(a.gateResult, 'BLOCK'); assert.strictEqual(a.executionAllowed, false);
    var invalid = harness({ association: 'STRONG_ASSOCIATION' });
    var b = await invalid.service.evaluate(event(), {});
    assert.strictEqual(b.gateResult, 'BLOCK'); assert.strictEqual(b.errorCode, 'EQ_FVG_OUTPUT_SCHEMA_INVALID');
});

test('raw persistence failure prevents parser/freeze and fails closed', async function () {
    var freezeCalls = 0;
    var store = { lookup: function () { return { status: 'MISS' }; }, lookupRaw: function () { return { status: 'MISS' }; },
        persistRaw: function () { throw Object.assign(new Error('disk'), { code: 'EQ_FVG_RAW_PERSIST_FAILED' }); },
        freeze: function () { freezeCalls += 1; } };
    var h = harness(decision('STRONG_ASSOCIATION'), { store: store });
    var result = await h.service.evaluate(event(), {});
    assert.strictEqual(result.gateResult, 'BLOCK'); assert.strictEqual(freezeCalls, 0);
});

test('same facts and concurrent calls use one request then frozen HIT', async function () {
    var h = harness(decision('STRONG_ASSOCIATION'));
    var both = await Promise.all([h.service.evaluate(event(), {}), h.service.evaluate(event(), {})]);
    assert.strictEqual(h.requested(), 1); assert.strictEqual(both[0].decisionKey, both[1].decisionKey);
    await h.service.evaluate(event(), {}); assert.strictEqual(h.requested(), 1);
});

test('disk store survives restart and a changed facts hash creates a new decision', async function () {
    var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eq-fvg-store-')); var calls = 0, marker = 'a';
    function make() { return serviceModule.createService({ config: { enabled: true, liveGateEnabled: true, failClosed: true },
        store: storeModule.createStore({ directory: dir }), buildFacts: function () { return facts(marker); },
        request: function () { calls += 1; return Promise.resolve(raw(decision('PLAUSIBLE_ASSOCIATION'))); },
        notify: function () {}, archive: function () {} }); }
    await make().evaluate(event(), {}); await make().evaluate(event(), {}); assert.strictEqual(calls, 1);
    marker = 'b'; await make().evaluate(event(), {}); assert.strictEqual(calls, 2);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('raw is persisted before parsing', async function () {
    var order = [], base = storeModule.createMemoryStore();
    var store = { lookup: base.lookup, lookupRaw: base.lookupRaw,
        persistRaw: function (identity, response, at) { order.push('RAW'); return base.persistRaw(identity, response, at); },
        freeze: function (identity, rawRecord, value, at) { order.push('FREEZE'); return base.freeze(identity, rawRecord, value, at); } };
    var h = harness(decision('STRONG_ASSOCIATION'), { store: store });
    await h.service.evaluate(event(), {}); assert.deepStrictEqual(order, ['RAW', 'FREEZE']);
});

test('semantic block is archived and annotates the existing DingTalk outbox', async function () {
    var sent = [], alerts = alertModule.createService({ send: function (value) { sent.push(value); return { errcode: 0 }; } });
    alerts.onStep({ evaluationTime: event().rawFvg.confirmedAt, newEqualLiquidity: [{ id: 'EQ', symbol: 'BTCUSDT', type: 'EQL',
        price: 99, confirmedAt: event().eqConfirmedAt, metadata: { primaryPartnerSelection: false,
            currentPivot: { id: 'P', price: 99, occurredAt: 1, confirmedAt: 2 },
            historicalPartners: [{ id: 'H', price: 99, occurredAt: 1, confirmedAt: 2 }] } }], rawFvg: event().rawFvg });
    var actualEvent = alerts.snapshot().pending[0].event;
    var h = harness(decision('WEAK_ASSOCIATION'), { notify: function (source, result) {
        assert.strictEqual(alerts.annotateSemantic(source, result), true);
    } });
    var result = await h.service.evaluate(actualEvent, {}); await alerts.flush();
    assert.strictEqual(result.gateResult, 'BLOCK'); assert.strictEqual(h.archived.length, 1); assert.strictEqual(sent.length, 1);
    assert.match(notification.build(sent[0]), /Semantic Gate: BLOCK/);
});

test('semantic notification handoff failure is fail closed', async function () {
    var h = harness(decision('STRONG_ASSOCIATION'), { notify: function () { throw new Error('outbox'); } });
    var result = await h.service.evaluate(event(), {});
    assert.strictEqual(result.gateResult, 'BLOCK'); assert.strictEqual(result.executionAllowed, false);
    assert.strictEqual(result.errorCode, 'EQ_FVG_SEMANTIC_NOTIFICATION_FAILED');
});

test('filesystem archive creates immutable PASS and BLOCK cases', function () {
    var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eq-fvg-cases-'));
    var archive = archiveModule.createArchive({ directory: dir });
    var a = archive.write({ decisionKey: 'a', semanticGate: 'BLOCK' });
    var b = archive.write({ decisionKey: 'b', semanticGate: 'PASS' });
    assert.match(path.basename(a), /^SEMANTIC_BLOCK_CASE_/); assert.match(path.basename(b), /^SEMANTIC_CANDIDATE_CASE_/);
    fs.rmSync(dir, { recursive: true, force: true });
});

function executionContext(overrides) {
    return Object.assign({ bias: { status: 'AVAILABLE', closedAt: 100, factsHash: '4hf', decisionKey: '4hd',
        semantic: { direction: 'BULLISH', strength: 'STRONG', confidence: 'HIGH' } }, expected4hClosedAt: 100,
        dynamicDPoints: [{ id: 'D', pointSide: 'HIGH', price: 104, confirmedAt: 1, state: 'ACTIVE' }], candles: [],
        symbolRules: { source: 'futures', tickSize: 0.1, stepSize: 0.001, minQty: 0.001, maxQty: 100, minNotional: 5 }
    }, overrides || {});
}
function semanticEvent() {
    var e = event(); e.eqFvgSemantic = { semanticVersion: contract.VERSION, promptHash: contract.PROMPT_SHA256,
        factsHash: 'facts', decisionKey: 'decision', gateResult: 'PASS', gateReason: null,
        decision: decision('STRONG_ASSOCIATION') }; return e;
}
test('semantic PASS still respects 4H and RR gates', async function () {
    var posts = 0;
    var bad4h = execution.createService({ symbol: 'BTCUSDT', liveTradingEnabled: false,
        client: { submitEntry: function () { posts += 1; } }, getContext: function () { return executionContext({ bias: null }); } });
    var a = await bad4h.onFirstMatchingFvg(semanticEvent()); assert.strictEqual(a.reasonCode, 'HTF_UNAVAILABLE');
    var badRr = execution.createService({ symbol: 'BTCUSDT', liveTradingEnabled: false,
        client: { submitEntry: function () { posts += 1; } }, getContext: function () {
            return executionContext({ dynamicDPoints: [{ id: 'D', pointSide: 'HIGH', price: 101.5, confirmedAt: 1, state: 'ACTIVE' }] });
        } });
    var e = semanticEvent(); e.liquidityId = 'EQ2';
    var b = await badRr.onFirstMatchingFvg(e); assert.strictEqual(b.reasonCode, 'TRADE_SPACE_INSUFFICIENT'); assert.strictEqual(posts, 0);
});

test('all deterministic gates pass reaches existing shadow execution and archives semantic fields', async function () {
    var repo = executionRepository.createRepository();
    var service = execution.createService({ symbol: 'BTCUSDT', liveTradingEnabled: false, repository: repo,
        getContext: function () { return executionContext(); } });
    var result = await service.onFirstMatchingFvg(semanticEvent());
    assert.strictEqual(result.status, 'SHADOW_ORDER'); assert.strictEqual(result.plan.eqFvgSemantic.association, 'STRONG_ASSOCIATION');
    assert.strictEqual(result.plan.htfFactsHash, '4hf');
    assert.strictEqual(result.plan.eqCurrentPoint.price, 99); assert.ok(Array.isArray(result.plan.eqHistoricalPartners));
});

test('live lifecycle record receives immutable semantic and 4H identities plus real case id', async function () {
    var repo = executionRepository.createRepository(), archived = [];
    var client = { syncTime: async function () {}, getPositionMode: async function () { return { dualSidePosition: false }; },
        getSymbolConfig: async function () { return [{ symbol: 'BTCUSDT', marginType: 'CROSSED', leverage: 10 }]; },
        getPositionRisk: async function () { return [{ positionAmt: '0' }]; }, getOpenOrders: async function () { return []; },
        getOpenAlgoOrders: async function () { return []; }, submitEntry: async function () { return { clientOrderId: 'IMC_E', orderId: 7, status: 'NEW' }; } };
    var service = execution.createService({ symbol: 'BTCUSDT', liveTradingEnabled: true, repository: repo, client: client,
        getContext: function () { return executionContext(); },
        archiveTrade: function (trade) { archived.push(trade); },
        streamFactory: function () { return { start: async function () {}, stop: async function () {} }; } });
    await service.start(); var trade = await service.onFirstMatchingFvg(semanticEvent());
    assert.strictEqual(trade.tradeCaseId, 'REAL_TRADE_CASE_' + trade.tradeId);
    assert.strictEqual(trade.plan.eqFvgSemantic.decisionKey, 'decision'); assert.strictEqual(trade.plan.htfDecisionKey, '4hd');
    assert.strictEqual(archived.length > 0, true); assert.strictEqual(archived[0].plan.eqFvgSemantic.association, 'STRONG_ASSOCIATION');
    await service.stop();
});

test('real trade case archive is append-only JSONL', function () {
    var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'real-trade-cases-'));
    var archive = realTradeArchive.createArchive({ directory: dir });
    var trade = { tradeCaseId: 'REAL_TRADE_CASE_T_1', tradeId: 'T_1', plan: { eqFvgSemantic: { decisionKey: 'frozen' } } };
    var file = archive.append(trade); archive.append(Object.assign({}, trade, { status: 'CLOSED' }));
    assert.strictEqual(fs.readFileSync(file, 'utf8').trim().split('\n').length, 2);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('facts confirmed after FVG cutoff are rejected', function () {
    var x = facts(); x.eq.futureAt = '2026-09-14T00:10:00.000Z';
    assert.throws(function () { factsModule.validate(x); }, /EQ_FVG_FACT_AFTER_FVG_CUTOFF/);
});

test('frozen prompt and pass policy are exact', function () {
    assert.strictEqual(contract.PROMPT_SHA256, '82b434bfb0112cfa32f4921cb1a80156feeeb1c0e83bbd448f22886232292918');
    assert.strictEqual(contract.MODEL, 'deepseek-v4-flash'); assert.strictEqual(contract.TEMPERATURE, 0);
});

test('feature config defaults fail closed and live-gate rollback restores prior admission', async function () {
    var names = ['EQ_FVG_SEMANTIC_ENABLED', 'EQ_FVG_SEMANTIC_LIVE_GATE_ENABLED',
        'EQ_FVG_SEMANTIC_FAIL_CLOSED', 'EQ_FVG_SEMANTIC_REQUIRED_CONFIDENCE'];
    var saved = {}; names.forEach(function (key) { saved[key] = process.env[key]; delete process.env[key]; });
    try {
        var cfg = loadConfig(); assert.deepStrictEqual(cfg, { enabled: true, liveGateEnabled: true, failClosed: true, requiredConfidence: 'HIGH' });
        var h = harness(decision('WEAK_ASSOCIATION'), { config: { enabled: true, liveGateEnabled: false, failClosed: true } });
        var result = await h.service.evaluate(event(), {});
        assert.strictEqual(result.gateResult, 'BLOCK'); assert.strictEqual(result.executionAllowed, true);
        process.env.EQ_FVG_SEMANTIC_FAIL_CLOSED = 'false'; assert.throws(loadConfig, /MUST_BE_TRUE/);
    } finally { names.forEach(function (key) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }); }
});
