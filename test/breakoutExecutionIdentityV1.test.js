'use strict';

var test = require('node:test');
var assert = require('node:assert');
var execution = require('../execution/breakoutExecutionV1');
var repositoryModule = require('../execution/executionRepositoryV1');

function plan(setupId, eqId, overrides) {
    return Object.assign({
        setupId: setupId, eqId: eqId, symbol: 'BTCUSDT', direction: 'LONG',
        entryTrigger: 101, entryWorkingType: 'CONTRACT_PRICE', protectionWorkingType: 'MARK_PRICE',
        requestedQty: 0.2, initialSL: 98, initialTP: 106, initialRR: 1.5
    }, overrides || {});
}

function service(options) {
    var opts = options || {};
    var mutations = [];
    var client = {};
    ['placeBreakoutEntry', 'submitProtection', 'cancelAlgo', 'setLeverage', 'setMarginType']
        .forEach(function (name) {
            client[name] = function () { mutations.push(name); return Promise.resolve({}); };
        });
    return {
        mutations: mutations,
        service: execution.createService({
            symbol: 'BTCUSDT', liveTradingEnabled: false, client: client,
            repository: opts.repository, observe: opts.observe
        })
    };
}

test('valid envelope uses real setupId for tradeId and real eqId for consumption', async function () {
    var events = [];
    var run = service({ observe: function (event) { events.push(event); } });
    var input = plan('SETUP_A', 'EQ_A');
    var result = await run.service.onSetup({ ok: true, plan: input });
    assert.equal(result.status, 'SHADOW_ORDER');
    assert.equal(result.trade.tradeId, execution.tradeIdFor(input));
    assert.notEqual(result.trade.tradeId, 'BB_undefined');
    assert.match(result.trade.tradeId, /SETUPA/);
    assert.equal(run.service._repository.isConsumed('EQ_A'), true);
    assert.equal(run.service._repository.isConsumed('undefined'), false);
    var submitted = events.filter(function (event) { return event.type === 'BREAKOUT_ENTRY_SUBMITTED'; })[0];
    assert.equal(submitted.setupId, 'SETUP_A');
    assert.equal(submitted.eqId, 'EQ_A');
    assert.deepEqual(run.mutations, []);
});

test('a distinct EQ remains available after another EQ was consumed', async function () {
    var repo = repositoryModule.createRepository({ initial: {} });
    assert.equal(repo.consumeEq('EQ_A', { setupId: 'SETUP_A' }), true);
    var run = service({ repository: repo });
    var result = await run.service.onSetup({ ok: true, plan: plan('SETUP_B', 'EQ_B') });
    assert.equal(result.status, 'SHADOW_ORDER');
    assert.equal(repo.isConsumed('EQ_B'), true);
    assert.deepEqual(run.mutations, []);
});

test('the same EQ is still deduplicated', async function () {
    var repo = repositoryModule.createRepository({ initial: {} });
    assert.equal(repo.consumeEq('EQ_A', { setupId: 'SETUP_A' }), true);
    var run = service({ repository: repo });
    var result = await run.service.onSetup({ ok: true, plan: plan('SETUP_AGAIN', 'EQ_A') });
    assert.equal(result.status, 'NO_TRADE');
    assert.equal(result.reasonCode, 'SETUP_ALREADY_CONSUMED');
    assert.deepEqual(run.mutations, []);
});

test('legacy undefined marker does not consume a real EQ', async function () {
    var repo = repositoryModule.createRepository({ initial: { consumedEqIds: { undefined: true } } });
    assert.equal(repo.isConsumed('EQ_NEW'), false);
    var run = service({ repository: repo });
    var result = await run.service.onSetup({ ok: true, plan: plan('SETUP_NEW', 'EQ_NEW') });
    assert.equal(result.status, 'SHADOW_ORDER');
    assert.equal(repo.snapshot().consumedEqIds.undefined, true);
    assert.equal(repo.isConsumed('EQ_NEW'), true);
});

test('invalid identity fails closed before persistence or exchange mutation', async function () {
    var events = [];
    var run = service({ observe: function (event) { events.push(event); } });
    var missingSetup = await run.service.onSetup({ ok: true, plan: plan(undefined, 'EQ_A') });
    var missingEq = await run.service.onSetup({ ok: true, plan: plan('SETUP_A', '') });
    assert.equal(missingSetup.reasonCode, 'INVALID_EXECUTION_PLAN_IDENTITY');
    assert.equal(missingEq.reasonCode, 'INVALID_EXECUTION_PLAN_IDENTITY');
    assert.equal(run.service.getSnapshot().activeTradeId, null);
    assert.deepEqual(run.service.getSnapshot().consumedEqIds, {});
    assert.equal(Object.keys(run.service.getSnapshot().trades).some(function (id) {
        return id === 'BB_undefined';
    }), false);
    assert.equal(events.every(function (event) {
        return event.reasonCode === 'INVALID_EXECUTION_PLAN_IDENTITY';
    }), true);
    assert.deepEqual(run.mutations, []);
});

test('consumed EQ persistence survives hydrate without blocking another EQ', function () {
    var persisted;
    var first = repositoryModule.createRepository({ initial: {}, persist: function (state) { persisted = state; } });
    assert.equal(first.consumeEq('EQ_A', { setupId: 'SETUP_A' }), true);
    var hydrated = repositoryModule.createRepository({ initial: persisted });
    assert.equal(hydrated.isConsumed('EQ_A'), true);
    assert.equal(hydrated.isConsumed('EQ_B'), false);
});

test('legacy marker hydration leaves an existing active trade and protection unchanged', function () {
    var active = {
        tradeId: 'BB_EXISTING', symbol: 'BTCUSDT', status: 'PROTECTED',
        plan: plan('SETUP_EXISTING', 'EQ_EXISTING'), positionQty: 1,
        entryOrder: { status: 'FILLED_OR_GONE' },
        slOrder: { clientAlgoId: 'SL_EXISTING', status: 'NEW', price: 98 },
        tpOrder: { clientAlgoId: 'TP_EXISTING', status: 'NEW', price: 106 },
        bridge: { phase: 'NONE' }
    };
    var initial = { consumedEqIds: { undefined: true }, activeTradeId: active.tradeId, trades: {} };
    initial.trades[active.tradeId] = active;
    var repo = repositoryModule.createRepository({ initial: initial });
    var before = repo.snapshot();
    var run = service({ repository: repo });
    assert.deepEqual(run.service.getSnapshot(), before);
    assert.deepEqual(run.mutations, []);
});

test('repository refuses undefined, null, and empty EQ identities', function () {
    var writes = 0;
    var repo = repositoryModule.createRepository({ initial: {}, persist: function () { writes += 1; } });
    assert.equal(repo.consumeEq(undefined), false);
    assert.equal(repo.consumeEq(null), false);
    assert.equal(repo.consumeEq(''), false);
    assert.deepEqual(repo.snapshot().consumedEqIds, {});
    assert.equal(writes, 0);
});
