'use strict';

var test = require('node:test');
var assert = require('node:assert');
var notification = require('../notify/executionNotificationV1');
var execution = require('../execution/breakoutExecutionV1');
var repository = require('../execution/executionRepositoryV1');

function notified(types) {
    return types.filter(function (type) {
        return notification.shouldNotifyExecutionEvent({ type: type });
    });
}

test('normal lifecycle sends only SUBMITTED and CLOSED', function () {
    assert.deepEqual(notified(['BREAKOUT_ENTRY_SUBMITTED', 'BREAKOUT_ENTRY_FILLED',
        'PROTECTION_VERIFICATION_PENDING', 'PROTECTION_VERIFIED', 'PROTECTION_VERIFIED',
        'POSITION_CLOSED']), ['BREAKOUT_ENTRY_SUBMITTED', 'POSITION_CLOSED']);
});

test('observed transient verify/halt recovery still sends only SUBMITTED and CLOSED', function () {
    assert.deepEqual(notified(['BREAKOUT_ENTRY_SUBMITTED', 'BREAKOUT_ENTRY_FILLED',
        'PROTECTION_PLACED_VERIFICATION_PENDING', 'PROTECTION_VERIFY_FAILED',
        'PROTECTION_VERIFICATION_PENDING', 'EXECUTION_HALT', 'PROTECTION_VERIFIED',
        'PROTECTION_VERIFIED', 'EXECUTION_HALT_CLEARED', 'POSITION_CLOSED']),
    ['BREAKOUT_ENTRY_SUBMITTED', 'POSITION_CLOSED']);
});

test('submitted notification contains the real execution identities and plan values', function () {
    var message = notification.build({ type: 'BREAKOUT_ENTRY_SUBMITTED', symbol: 'BTCUSDT',
        direction: 'LONG', tradeId: 'BB_SETUPA', setupId: 'SETUP_A', eqId: 'EQ_A',
        entryTrigger: 101, initialSL: 98, initialTP: 106, initialRR: 1.5,
        qty: 0.2, notional: 20.2, submittedAt: 1790128807653 }, '检测');
    ['tradeId=BB_SETUPA', 'setupId=SETUP_A', 'eqId=EQ_A', 'entry=101',
        'initialSL=98', 'initialTP=106', 'initialRR=1.5', 'qty=0.2',
        'notional=20.2', 'submittedAt=09-23 10:00 \\(UTC\\+8\\)'].forEach(function (part) { assert.match(message, new RegExp(part)); });
    assert.doesNotMatch(message, /undefined|null/);
});

test('lifecycle audit survives repository reload and produces a recovered CLOSED summary', function () {
    var trade = { tradeId: 'BB_SETUPA', symbol: 'BTCUSDT', status: 'PROTECTED',
        plan: { setupId: 'SETUP_A', eqId: 'EQ_A', symbol: 'BTCUSDT', direction: 'LONG',
            entryTrigger: 101, initialSL: 98, initialTP: 106, initialRR: 1.5 },
        submittedAt: 1000, positionOpenedAt: 2000, closedAt: 12000,
        entryOrder: { status: 'FILLED_OR_GONE' },
        slOrder: { status: 'CANCELED', verified: true },
        tpOrder: { status: 'FILLED_OR_GONE', verified: true }, alertedEvents: {} };
    execution.applyExecutionAuditEvent('BREAKOUT_ENTRY_FILLED', trade, { positionQty: 0.2 });
    execution.applyExecutionAuditEvent('PROTECTION_VERIFY_FAILED', trade, {});
    execution.applyExecutionAuditEvent('EXECUTION_HALT', trade, {});
    execution.applyExecutionAuditEvent('PROTECTION_VERIFIED', trade, { role: 'SL' });
    execution.applyExecutionAuditEvent('PROTECTION_VERIFIED', trade, { role: 'TP' });
    execution.applyExecutionAuditEvent('EXECUTION_HALT_CLEARED', trade, {});
    var initial = { activeTradeId: trade.tradeId, consumedEqIds: { EQ_A: true }, trades: {} };
    initial.trades[trade.tradeId] = trade;
    var reloaded = repository.createRepository({ initial: initial }).activeTrade();
    var summary = execution.closedSummary(reloaded);
    assert.equal(summary.protection.protectionVerifyFailureCount, 1);
    assert.equal(summary.protection.temporaryExecutionHaltSeen, true);
    assert.equal(summary.protection.temporaryExecutionHaltCleared, true);
    assert.equal(summary.protection.protectionEventuallyVerified, true);
    assert.equal(summary.executionAudit.executionAnomaly, false);
    assert.equal(summary.exit.exitReason, 'UNKNOWN');
    assert.equal(summary.entry.fillPrice, null);
    var message = notification.build({ type: 'POSITION_CLOSED', symbol: 'BTCUSDT',
        tradeId: trade.tradeId, summary: summary }, '检测');
    assert.match(message, /protectionVerifyFailureCount=1/);
    assert.match(message, /temporaryExecutionHaltSeen=true/);
    assert.match(message, /temporaryExecutionHaltCleared=true/);
    assert.match(message, /protectionEventuallyVerified=true/);
    assert.match(message, /executionAnomaly=false/);
    assert.match(message, /fillPrice=UNKNOWN/);
});

test('all intermediate execution lifecycle events are silent', function () {
    ['BREAKOUT_ENTRY_FILLED', 'PROTECTION_PLACED_VERIFICATION_PENDING',
        'PROTECTION_VERIFY_FAILED', 'PROTECTION_VERIFICATION_PENDING', 'PROTECTION_VERIFIED',
        'EXECUTION_HALT', 'EXECUTION_HALT_CLEARED', 'ORPHAN_ORDER_FOUND', 'EXCHANGE_REJECTED']
        .forEach(function (type) {
            assert.equal(notification.shouldNotifyExecutionEvent({ type: type }), false, type);
        });
    assert.equal(notification.shouldNotifyExecutionEvent({
        type: 'BREAKOUT_ENTRY_SUBMITTED', shadow: true }), false, 'shadow submission');
});
