'use strict';

// TWO_BAR_PRODUCTION_REPLACEMENT_V1 §56 - causality / future-leak proof for the
// new production entry chain. Prints FUTURE_LEAK_TEST=PASS on success.

var assert = require('assert');

var L = require('../research/reversalPatternSemanticAuditV1');
var twoBarSetupV1 = require('../strategy/twoBarSetupV1');
var twoBarLivePipelineV1 = require('../strategy/twoBarLivePipelineV1');
var breakoutExecutionV1 = require('../execution/breakoutExecutionV1');
var rules = require('../execution/breakoutEntryRulesV1');
var pm = require('../execution/positionManagementV1');
var executionRepositoryV1 = require('../execution/executionRepositoryV1');

var BAR = 300000;
function bar(i, o, h, l, c, closed) {
    return { openTime: i * BAR, closeTime: (i + 1) * BAR - 1, open: o, high: h, low: l, close: c,
        closed: closed === undefined ? true : closed, source: 'futures' };
}
function fixture() {
    var rows = [];
    var close = 105;
    for (var i = 0; i < 8; i++) {
        var open = close;
        close = close - 0.7;
        rows.push(bar(i, open, open + 0.2, close - 0.3, close));
    }
    rows.push(bar(8, 100.6, 100.8, 99.2, 99.4));
    rows.push(bar(9, 99.4, 100.9, 99.0, 100.8));
    for (var j = 10; j < 20; j++) {
        var prev = rows[j - 1].close;
        rows.push(bar(j, prev, prev + 0.5, prev - 0.2, prev + 0.4));
    }
    return rows;
}
function candidateFixture(rows) {
    var k1 = rows[8];
    var k2 = rows[9];
    return { pattern: 'TWO_BAR_REVERSAL', direction: 'BULLISH', startIndex: 8, endIndex: 9,
        symbol: 'BTCUSDT', windowBars: [k1, k2],
        windowFacts: [L.candleFacts(k1), L.candleFacts(k2)] };
}
function scriptedService() {
    return twoBarSetupV1.createService({
        symbol: 'BTCUSDT', decisionStore: twoBarSetupV1.createMemoryStore(),
        requestSemantic: function (systemPrompt) {
            return Promise.resolve(systemPrompt === L.SYSTEM_PROMPT
                ? { matches: [{ pattern: 'TWO_BAR_REVERSAL', direction: 'BULLISH', label: 'CLEAR',
                    confidence: 'HIGH', supportingFacts: ['t'], conflicts: [], reason: 't' }],
                    overall: 'CLEAR_PATTERN' }
                : { expectedDirection: 'BEARISH', detectedDirection: 'BEARISH', label: 'CLEAR',
                    confidence: 'HIGH', estimatedLegBars: 6, reason: 't' });
        }
    });
}
function dPoint(id, side, price, occurredBarIndex, confirmedAt) {
    return { id: id, pointSide: side, price: price, state: 'ACTIVE',
        occurredAt: (occurredBarIndex + 1) * BAR,
        confirmedAt: confirmedAt === undefined ? occurredBarIndex * BAR + (BAR - 1) : confirmedAt,
        occurredBarIndex: occurredBarIndex };
}
function stubStream() {
    return { start: function () { return Promise.resolve(); }, stop: function () { return Promise.resolve(); } };
}

var passed = 0;
var failed = 0;
async function test(name, fn) {
    try {
        await fn();
        passed += 1;
        console.log('PASS ' + name);
    } catch (e) {
        failed += 1;
        console.log('FAIL ' + name);
        console.log('  ' + (e && e.stack || e));
    }
}

async function main() {
    await test('T1 the pipeline only evaluates a candidate on the bar that closes K2', async function () {
        var rows = fixture();
        var calls = [];
        var pipeline = twoBarLivePipelineV1.createPipeline({
            symbol: 'BTCUSDT',
            setupService: { evaluateCandidate: function (c, ctx) {
                calls.push({ endIndex: c.endIndex, currentBarIndex: ctx.currentBarIndex });
                return Promise.resolve({ status: 'NO_SETUP', reason: 'PATTERN_NOT_CLEAR', stage: 'PATTERN' });
            } },
            getBias: function () { return null; },
            getExpected4hClosedAt: function () { return null; }
        });
        for (var i = 0; i < rows.length; i++) await pipeline.onClosedBar(rows, i);
        assert.strictEqual(calls.length, 1);
        assert.strictEqual(calls[0].endIndex, 9);
        assert.strictEqual(calls[0].currentBarIndex, 9);
        assert.strictEqual(calls.every(function (c) { return c.endIndex === c.currentBarIndex; }), true);
    });

    await test('T2 the pattern and context payloads contain no candle after K2.closeTime', async function () {
        var rows = fixture();
        var cand = candidateFixture(rows);
        var confirmedAt = rows[9].closeTime;
        assert.ok(rows[8].closeTime <= confirmedAt && rows[9].closeTime === confirmedAt);
        assert.doesNotThrow(function () { L.assertWindowWithinConfirmation(cand.windowBars, confirmedAt); });
        var payload = L.buildUserPayload('BTCUSDT', '5m', cand.windowBars, cand.windowFacts, confirmedAt);
        assert.doesNotThrow(function () { L.assertNoFutureData(payload, confirmedAt); });
        var leaky = JSON.parse(JSON.stringify(payload));
        leaky.bars.push({ openTime: 10 * BAR, closeTime: 11 * BAR - 1, open: 1, high: 1, low: 1, close: 1 });
        assert.throws(function () { L.assertNoFutureData(leaky, confirmedAt); }, /FUTURE_LEAK/);
        // a window that reaches into K3 (i.e. K2 was not the last closed bar)
        assert.throws(function () {
            L.assertWindowWithinConfirmation([rows[8], rows[9], rows[10]], confirmedAt);
        }, /FUTURE_LEAK_WINDOW/);
        // a future-dated timestamp anywhere in the payload is refused
        assert.throws(function () {
            L.assertNoFutureData({ evaluationTime: confirmedAt }, confirmedAt - 1);
        }, /FUTURE_LEAK_TIME/);
    });

    await test('T3 setup / EQ availability / plan decision time are causal', async function () {
        var rows = fixture();
        var dynamicDState = { recentSurvivalPoints: [dPoint('DYN_LOW_1', 'LOW', 98.6, 5),
            dPoint('DYN_HIGH_1', 'HIGH', 106.0, 6)] };
        var result = await scriptedService().evaluateCandidate(candidateFixture(rows),
            { candles: rows, atrValue: 1.0, dynamicDState: dynamicDState, currentBarIndex: 9 });
        assert.strictEqual(result.status, 'SETUP', JSON.stringify(result.reason));
        assert.strictEqual(result.setup.confirmedAt, rows[9].closeTime);
        assert.strictEqual(result.setup.availableAt, rows[9].closeTime);
        assert.strictEqual(result.setup.partners.every(function (p) {
            return p.confirmedAt <= rows[9].closeTime; }), true);
        var built = rules.buildBreakoutPlan(result.setup, {
            symbolRules: { source: 'futures', tickSize: 0.1, stepSize: 0.001, minQty: 0.001,
                maxQty: 1000, minNotional: 5 },
            bias: { status: 'AVAILABLE', closedAt: 1000, expectedClosedAt: 1000,
                semantic: { direction: 'BULLISH', strength: 'MODERATE', confidence: 'HIGH' } },
            currentContractPrice: 100.0, dynamicDPoints: dynamicDState.recentSurvivalPoints, candles: rows });
        assert.strictEqual(built.ok, true, built.reasonCode);
        assert.strictEqual(built.plan.setupId, result.setup.id);
        assert.strictEqual(built.plan.eqId, result.setup.nearestPartnerId);
        assert.strictEqual(built.plan.decisionTime, rows[9].closeTime);
        assert.strictEqual(built.plan.decisionTime >= built.plan.setupConfirmedAt, true);
        assert.strictEqual(built.plan.targetConfirmedAt <= rows[9].closeTime, true);
    });

    await test('T4 an unclosed 4H snapshot fails closed (HTF_UNAVAILABLE)', async function () {
        assert.strictEqual(rules.htfDirectionGate('LONG', { status: 'AVAILABLE', closedAt: 100,
            expectedClosedAt: 200, semantic: { direction: 'BULLISH' } }).reasonCode, 'HTF_UNAVAILABLE');
        assert.strictEqual(rules.htfDirectionGate('LONG', { status: 'AVAILABLE', closedAt: 100,
            expectedClosedAt: 100, semantic: { direction: 'BULLISH' } }).ok, true);
    });

    await test('T5 dynamic SL/TP only consume causally eligible Dynamic-D points', async function () {
        assert.strictEqual(pm.isEligibleUpdate({ confirmedAt: 2000, occurredAt: 1000 }, 1500, 2000), true);
        assert.strictEqual(pm.isEligibleUpdate({ confirmedAt: 1500, occurredAt: 1000 }, 1500, 2000), false);
        assert.strictEqual(pm.isEligibleUpdate({ confirmedAt: 2001, occurredAt: 1000 }, 1500, 2000), false);
        var calls = 0;
        var client = {};
        ['placeBreakoutEntry', 'submitProtection', 'cancelAlgo', 'setLeverage'].forEach(function (k) {
            client[k] = function () { calls += 1; return Promise.resolve({}); };
        });
        client.getPositionRisk = function () { return Promise.resolve([{ positionAmt: '1' }]); };
        client.getOpenOrders = function () { return Promise.resolve([]); };
        client.getOpenAlgoOrders = function () { return Promise.resolve([
            { clientAlgoId: 'IMC_BTCUSDT_SL_1', algoStatus: 'NEW' },
            { clientAlgoId: 'IMC_BTCUSDT_TP_1', algoStatus: 'NEW' }]); };
        var service = breakoutExecutionV1.createService({
            symbol: 'BTCUSDT', liveTradingEnabled: true, client: client, streamFactory: stubStream,
            getMarkPrice: function () { return 105; },
            repository: executionRepositoryV1.createRepository({
                initial: { activeTradeId: 'T1', trades: { T1: {
                    tradeId: 'T1', symbol: 'BTCUSDT', status: 'PROTECTED',
                    plan: { direction: 'LONG', initialSL: 98, initialTP: 110, requestedQty: 0.2,
                        setupId: 'S', symbol: 'BTCUSDT' },
                    positionQty: 1,
                    entryOrder: { role: 'ENTRY', clientOrderId: 'IMC_BTCUSDT_ENTRY_1',
                        status: 'FILLED_OR_GONE' },
                    slOrder: { role: 'SL', clientOrderId: 'IMC_BTCUSDT_SL_1', status: 'NEW', price: 98 },
                    tpOrder: { role: 'TP', clientOrderId: 'IMC_BTCUSDT_TP_1', status: 'NEW', price: 110 },
                    slRevision: 0, tpRevision: 0, positionOpenedAt: Date.now() + 60000,
                    alertedEvents: {} } } } })
        });
        await service.onDynamicD([dPoint('FUTURE_LOW', 'LOW', 104, 12, Date.now() + 120000)], Date.now());
        await service.reconcile();
        assert.strictEqual(calls, 0, 'an ineligible Dynamic-D point must not mutate orders');
        service.stop();
    });

    await test('T6 LIVE_TRADING_ENABLED=false never mutates the exchange', async function () {
        var rows = fixture();
        var dynamicDState = { recentSurvivalPoints: [dPoint('DYN_LOW_1', 'LOW', 98.6, 5),
            dPoint('DYN_HIGH_1', 'HIGH', 106.0, 6)] };
        var result = await scriptedService().evaluateCandidate(candidateFixture(rows),
            { candles: rows, atrValue: 1.0, dynamicDState: dynamicDState, currentBarIndex: 9 });
        var built = rules.buildBreakoutPlan(result.setup, {
            symbolRules: { source: 'futures', tickSize: 0.1, stepSize: 0.001, minQty: 0.001,
                maxQty: 1000, minNotional: 5 },
            bias: { status: 'AVAILABLE', closedAt: 1000, expectedClosedAt: 1000,
                semantic: { direction: 'BULLISH', strength: 'WEAK', confidence: 'LOW' } },
            currentContractPrice: 100.0, dynamicDPoints: dynamicDState.recentSurvivalPoints,
            candles: rows, liveTradingEnabled: false });
        var mutations = 0;
        var client = {};
        ['placeBreakoutEntry', 'submitProtection', 'cancelAlgo', 'setLeverage', 'setMarginType']
            .forEach(function (k) { client[k] = function () { mutations += 1; return Promise.resolve({}); }; });
        var service = breakoutExecutionV1.createService({ symbol: 'BTCUSDT', liveTradingEnabled: false,
            client: client, getMarkPrice: function () { return 100.0; } });
        var submitted = await service.onSetup(built);
        assert.strictEqual(submitted.status, 'SHADOW_ORDER');
        assert.strictEqual(submitted.trade.status, 'SHADOW_BREAKOUT_PENDING');
        assert.strictEqual(submitted.trade.plan.entryWorkingType, 'CONTRACT_PRICE');
        await service.reconcile();
        assert.strictEqual(mutations, 0);
        service.stop();
    });

    console.log('');
    console.log('FUTURE_LEAK_TEST=' + (failed === 0 ? 'PASS' : 'FAIL'));
    console.log('CHECKS PASSED: ' + passed);
    console.log('CHECKS FAILED: ' + failed);
    if (failed) process.exitCode = 1;
}

main().catch(function (error) {
    console.error(error && error.stack || error);
    process.exit(1);
});
