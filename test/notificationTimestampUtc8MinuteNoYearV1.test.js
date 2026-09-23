'use strict';

var test = require('node:test');
var assert = require('node:assert');
var formatter = require('../notify/notificationTimeV1');
var executionNotification = require('../notify/executionNotificationV1');
var rangeNotification = require('../notify/rangeNotificationV1');
var eqNotification = require('../notify/eqFvgCountWatchNotificationV1');
var watchNotification = require('../notify/watchNotificationPresentationV1');
var live = require('../scripts/live');

var format = formatter.formatNotificationTimeUtc8;
var SAMPLE = 1790128807653;

function assertMinuteOnly(value) {
    assert.match(value, /^\d{2}-\d{2} \d{2}:\d{2} \(UTC\+8\)$/);
    assert.doesNotMatch(value, /\d{4}-\d{2}-\d{2}|:\d{2}:\d{2}|\.\d{3}|Z$/);
}

test('formatter converts epoch milliseconds and numeric epoch strings', function () {
    assert.strictEqual(format(SAMPLE), '09-23 10:00 (UTC+8)');
    assert.strictEqual(format(String(SAMPLE)), '09-23 10:00 (UTC+8)');
    assert.strictEqual(format('2026-09-23T02:00:07.653Z'), '09-23 10:00 (UTC+8)');
});

test('formatter truncates seconds instead of rounding the minute', function () {
    assert.strictEqual(format(Date.parse('2026-09-23T01:59:59.999Z')), '09-23 09:59 (UTC+8)');
    assert.strictEqual(format(Date.parse('2026-09-23T02:00:00.000Z')), '09-23 10:00 (UTC+8)');
});

test('formatter handles fixed UTC+8 day, month and year boundaries', function () {
    assert.strictEqual(format('2026-08-31T18:30:00Z'), '09-01 02:30 (UTC+8)');
    assert.strictEqual(format('2026-12-31T18:00:00Z'), '01-01 02:00 (UTC+8)');
});

test('formatter is server-timezone independent and invalid-safe', function () {
    var before = process.env.TZ;
    process.env.TZ = 'America/Los_Angeles'; var west = format(SAMPLE);
    process.env.TZ = 'Asia/Tokyo'; var east = format(SAMPLE);
    if (before === undefined) delete process.env.TZ; else process.env.TZ = before;
    assert.strictEqual(west, east);
    [null, undefined, '', 'invalid', NaN, Infinity, -1, {}].forEach(function (value) {
        assert.doesNotThrow(function () { assert.strictEqual(format(value), 'UNAVAILABLE'); });
    });
});

test('execution submission and Market State use minute-only UTC+8 while IDs remain byte-identical', function () {
    var tradeId = 'TRADE:1790128200000', setupId = 'SETUP:1790128799999', eqId = 'EQ:1790128200000';
    var event = { type: 'BREAKOUT_ENTRY_SUBMITTED', symbol: 'BTCUSDT', direction: 'LONG',
        tradeId: tradeId, setupId: setupId, eqId: eqId, entryTrigger: 86333.1,
        initialSL: 86047.8, initialTP: 86817.3, initialRR: 1.6971, qty: 0.001,
        notional: 86.3331, submittedAt: SAMPLE, marketStateSnapshot: {
            version: 'MARKET_STATE_MAP_V1', state: 'RANGE', stateSince: 1790125200000,
            snapshotAt: 1790128799999 } };
    var before = JSON.stringify(event), message = executionNotification.build(event, '检测');
    assert.strictEqual(JSON.stringify(event), before);
    assert.match(message, /submittedAt=09-23 10:00 \(UTC\+8\)/);
    assert.match(message, /since=09-23 09:00 \(UTC\+8\)/);
    assert.match(message, /snapshotAt=09-23 09:59 \(UTC\+8\)/);
    [tradeId, setupId, eqId].forEach(function (id) { assert.ok(message.includes(id)); });
    message.split('\n').filter(function (line) { return /^(submittedAt|since|snapshotAt)=/.test(line); })
        .forEach(function (line) { assertMinuteOnly(line.split('=')[1]); });
});

test('POSITION_CLOSED summary formats submitted, filled and closed timestamps only at render', function () {
    var summary = { direction: 'LONG', tradeId: 'T1', setupId: 'S1', eqId: 'E1',
        setup: { submittedAt: SAMPLE, plannedEntry: 1, initialSL: 0.9, initialTP: 1.2, initialRR: 2 },
        entry: { filled: true, fillPrice: 1, filledAt: SAMPLE + 61000, qty: 1, notional: 1 },
        protection: {}, exit: { exitReason: 'TP', exitPrice: 1.2, closedAt: SAMPLE + 122000, holdingSeconds: 61 },
        result: {}, executionAudit: {} };
    var before = JSON.stringify(summary);
    var message = executionNotification.build({ type: 'POSITION_CLOSED', symbol: 'BTCUSDT', summary: summary }, '检测');
    assert.strictEqual(JSON.stringify(summary), before);
    ['submittedAt=09-23 10:00 (UTC+8)', 'filledAt=09-23 10:01 (UTC+8)',
        'closedAt=09-23 10:02 (UTC+8)'].forEach(function (line) { assert.ok(message.includes(line)); });
});

test('range, EQ/FVG, WATCH and opportunity builders share the strict display format', function () {
    var range = rangeNotification.buildRangeConfirmationMessage({ symbol: 'BTCUSDT', lower: 1,
        upper: 2, midpoint: 1.5, widthPct: 1, visualStartAt: SAMPLE, confirmedAt: SAMPLE + 61000 });
    assert.ok(range.includes('开始形成: 09-23 10:00 (UTC+8)'));
    assert.ok(range.includes('确认时间: 09-23 10:01 (UTC+8)'));

    var eq = eqNotification.build({ symbol: 'BTCUSDT', liquidityType: 'EQL', liquidityPrice: 1,
        expectedDirection: 'BULLISH', eqConfirmedAt: SAMPLE, watchStatusAfterEvent: 'OPEN', ordinal: 1,
        rawFvg: { direction: 'BULLISH', low: 1, high: 2, confirmedAt: SAMPLE + 61000 } });
    assert.ok(eq.includes('EQ确认: 09-23 10:00 (UTC+8)'));
    assert.ok(eq.includes('FVG确认: 09-23 10:01 (UTC+8)'));

    var watch = watchNotification.build({ symbol: 'BTCUSDT', direction: 'BULLISH', state: 'FVG_TOUCHED' }, 1,
        { notificationGeneratedAt: SAMPLE });
    assert.ok(watch.includes('时间：09-23 10:00 (UTC+8)'));

    var opportunity = live.buildMessage({ direction: 'BULLISH', availableAt: SAMPLE,
        anchorTime: SAMPLE - 300000, notificationNearTarget: null, notificationNearDistPct: null,
        nearTarget: null, nearDistPct: null, deliveryQuality: 'NORMAL', formationRangeAtr: null,
        liquidityContext: null }, 'BTCUSDT', null);
    assert.ok(opportunity.includes('通知: 09-23 10:00 (UTC+8)（leg 锚 09-23 09:55 (UTC+8)）'));
});

test('time-labelled fields leak no raw epoch, year, seconds, milliseconds or ISO Z', function () {
    var message = executionNotification.build({ type: 'BREAKOUT_ENTRY_SUBMITTED', symbol: 'BTCUSDT',
        submittedAt: SAMPLE, marketStateSnapshot: { state: 'BULL_TREND', stateSince: SAMPLE,
            snapshotAt: SAMPLE, version: 'MARKET_STATE_MAP_V1' } }, '检测');
    var lines = message.split('\n').filter(function (line) {
        return /^(submittedAt|snapshotAt|since|filledAt|closedAt|confirmedAt|occurredAt)=/.test(line);
    });
    assert.ok(lines.length >= 3);
    lines.forEach(function (line) {
        assert.doesNotMatch(line, /=\d{13}(?:\D|$)/);
        assert.doesNotMatch(line, /\d{4}-\d{2}-\d{2}|:\d{2}:\d{2}|\.\d{3}|Z(?:\s|$)/);
        assertMinuteOnly(line.slice(line.indexOf('=') + 1));
    });
});
