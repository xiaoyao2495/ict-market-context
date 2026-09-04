'use strict';
var assert = require('assert');
var detectorModule = require('../range/rangeDetectorV1');
var alertModule = require('../live/rangeAlertService');
var presentation = require('../notify/rangeNotificationV1');
var liveConfig = require('../config/live.json');

var BAR = 300000;
function candle(index, close, high, low, symbol) {
    var openTime = 1700000000000 + index * BAR;
    var value = close === undefined ? 100 : close;
    return {
        symbol: symbol || 'BTCUSDT', openTime: openTime, closeTime: openTime + BAR - 1,
        open: value, high: high === undefined ? value + 1 : high,
        low: low === undefined ? value - 1 : low, close: value,
        volume: 1, closed: true, source: 'futures'
    };
}

function formationCandles(symbol) {
    var rows = [];
    for (var i = 0; i < 700; i++) rows.push(candle(i, i === 538 ? 105 : 100, undefined, undefined, symbol));
    return rows;
}

function replay(rows, symbol, stop) {
    var detector = detectorModule.createRangeDetectorV1({ symbol: symbol || 'BTCUSDT' });
    var results = [];
    var limit = stop === undefined ? rows.length : stop;
    for (var i = 0; i < limit; i++) results.push(detector.onCandle(rows[i]));
    return { detector: detector, results: results };
}

function assertClose(actual, expected, tolerance, label) {
    assert.ok(Math.abs(actual - expected) <= tolerance, (label || 'number') + ': ' + actual + ' != ' + expected);
}

function researchParity(symbol, datasetPath, rangesPath) {
    var dataset = require(datasetPath).candles;
    var expected = require(rangesPath);
    var result = replay(dataset, symbol);
    var actual = result.detector.getRanges();
    assert.strictEqual(actual.length, expected.length, symbol + ' range count');
    expected.forEach(function (wanted, index) {
        var got = actual[index];
        assert.strictEqual(got.confirmedAt, wanted.confirmedAt, symbol + ' confirmedAt ' + index);
        assertClose(got.upper, wanted.upper, 1e-8, symbol + ' upper ' + index);
        assertClose(got.lower, wanted.lower, 1e-8, symbol + ' lower ' + index);
        assert.strictEqual(got.breakoutAt, wanted.breakoutAt, symbol + ' breakoutAt ' + index);
        assert.strictEqual(got.status, wanted.status, symbol + ' status ' + index);
    });
}

async function main() {
    // A/Q — Pine ATR500 seed/recursion and readiness.
    var d = detectorModule.createRangeDetectorV1({ symbol: 'BTCUSDT' });
    var r;
    for (var i = 0; i < 499; i++) r = d.onCandle(candle(i));
    assert.strictEqual(r.status, 'NOT_READY');
    assert.strictEqual(r.events.length, 0);
    r = d.onCandle(candle(499));
    assert.strictEqual(r.status, 'READY');
    assert.strictEqual(r.atr, 2);
    r = d.onCandle(candle(500, 100, 150, 99));
    assertClose(r.atr, (2 * 499 + 51) / 500, 1e-12, 'ATR recursion');

    // B/C/E/F — 24-close transition, one violation, causal confirmation, retrospective start.
    var rows = formationCandles('BTCUSDT');
    var built = replay(rows, 'BTCUSDT', 563);
    assert.strictEqual(built.results[561].events.length, 0, 'spike remains one close violation');
    var confirmation = built.results[562].events[0];
    assert.strictEqual(confirmation.type, 'RANGE_CONFIRMED');
    assert.strictEqual(confirmation.confirmedAt, rows[562].closeTime);
    assert.strictEqual(confirmation.visualStartAt, rows[538].openTime);
    assert.ok(confirmation.confirmedAt <= rows[562].closeTime);

    // D — a wick outside the eventual band does not invalidate close containment.
    var wickRows = formationCandles('BTCUSDT');
    wickRows[550] = candle(550, 100, 1000, 1);
    var wickBuilt = replay(wickRows, 'BTCUSDT', 563);
    assert.strictEqual(wickBuilt.results[562].events[0].type, 'RANGE_CONFIRMED');

    // G/H/I — exact touches remain active; strict close above breaks UP.
    var active = built.detector.getState().activeRange;
    var upperTouch = candle(563, active.upper, active.upper, active.lower);
    var touchResult = built.detector.onCandle(upperTouch);
    assert.strictEqual(touchResult.activeRange.status, 'ACTIVE');
    var lowerTouch = candle(564, active.lower, active.upper, active.lower);
    touchResult = built.detector.onCandle(lowerTouch);
    assert.strictEqual(touchResult.activeRange.status, 'ACTIVE');
    var upBreak = candle(565, active.upper + 0.000001, active.upper + 1, active.lower);
    var upResult = built.detector.onCandle(upBreak);
    assert.strictEqual(upResult.events[0].type, 'RANGE_BROKEN');
    assert.strictEqual(upResult.events[0].direction, 'UP');
    assert.strictEqual(built.detector.getActiveRange(), null);

    // J — strict close below breaks DOWN.
    var downBuilt = replay(rows, 'BTCUSDT', 563);
    var downActive = downBuilt.detector.getState().activeRange;
    var downResult = downBuilt.detector.onCandle(candle(563, downActive.lower - 0.000001, downActive.upper, downActive.lower - 1));
    assert.strictEqual(downResult.events[0].direction, 'DOWN');
    assert.strictEqual(downBuilt.detector.getRanges()[0].status, 'BROKEN_DOWN');

    // K/L/M — success dedupe, continuation silence, breakout is record-only.
    var sends = 0; var records = []; var persisted = null;
    var service = alertModule.createRangeAlertService({
        symbol: 'BTCUSDT',
        send: function () { sends++; return Promise.resolve({ errcode: 0 }); },
        record: function (event) { records.push(event); },
        persist: function (snapshot) { persisted = snapshot; }
    });
    for (i = 0; i <= 562; i++) service.onCandle(rows[i], { notificationsEnabled: true });
    await service.flush();
    assert.strictEqual(sends, 1);
    service.onCandle(rows[562], { notificationsEnabled: true }); // same candle re-evaluation
    await service.flush();
    assert.strictEqual(sends, 1);
    service.onCandle(candle(563, 100), { notificationsEnabled: true }); // continuation
    await service.flush();
    assert.strictEqual(sends, 1);
    var serviceActive = service.getDetector().getState().activeRange;
    service.onCandle(candle(564, serviceActive.upper + 1, serviceActive.upper + 2, serviceActive.lower), { notificationsEnabled: true });
    await service.flush();
    assert.strictEqual(sends, 1, 'breakout notification disabled');
    assert.strictEqual(records.filter(function (x) { return x.type === 'RANGE_BROKEN'; }).length, 1);
    assert.strictEqual(service.getDetector().getActiveRange(), null);

    // N — after terminal breakout a fresh qualifying transition may confirm once.
    for (i = 565; i <= 570; i++) service.onCandle(candle(i, i === 565 ? 105 : 100), { notificationsEnabled: true });
    for (i = 571; i <= 589; i++) service.onCandle(candle(i, 100), { notificationsEnabled: true });
    // The spike at 565 leaves the 24-close window at 589.
    await service.flush();
    assert.strictEqual(sends, 2);

    // O — persisted delivered keys suppress re-notification after restart/replay.
    var restoredSends = 0;
    var restored = alertModule.createRangeAlertService({
        symbol: 'BTCUSDT', delivered: persisted.delivered,
        send: function () { restoredSends++; return Promise.resolve({ errcode: 0 }); }
    });
    for (i = 0; i <= 562; i++) restored.onCandle(rows[i], { notificationsEnabled: true });
    await restored.flush();
    assert.strictEqual(restoredSends, 0);

    // Failed delivery stays in the outbox; a later success is stored once.
    var retryAttempts = 0; var allowSuccess = false;
    var retryService = alertModule.createRangeAlertService({
        symbol: 'BTCUSDT',
        send: function () {
            retryAttempts++;
            return Promise.resolve({ errcode: allowSuccess ? 0 : -1 });
        }
    });
    for (i = 0; i <= 562; i++) retryService.onCandle(rows[i], { notificationsEnabled: true });
    await retryService.flush();
    assert.strictEqual(retryService.snapshot().pending.length, 1);
    assert.strictEqual(Object.keys(retryService.snapshot().delivered).length, 0);
    allowSuccess = true;
    await retryService.flush();
    await retryService.flush();
    assert.strictEqual(retryAttempts, 2);
    assert.strictEqual(retryService.snapshot().pending.length, 0);
    assert.strictEqual(Object.keys(retryService.snapshot().delivered).length, 1);

    // P — per-symbol state and stable identities are isolated.
    var btcBuilt = replay(rows, 'BTCUSDT', 563);
    var zecRows = formationCandles('ZECUSDT');
    var zecBuilt = replay(zecRows, 'ZECUSDT', 563);
    assert.notStrictEqual(btcBuilt.detector.getRanges()[0].id, zecBuilt.detector.getRanges()[0].id);
    assert.strictEqual(btcBuilt.detector.getRanges()[0].symbol, 'BTCUSDT');
    assert.strictEqual(zecBuilt.detector.getRanges()[0].symbol, 'ZECUSDT');
    assert.deepStrictEqual(
        replay(rows, 'BTCUSDT').detector.getRanges(),
        replay(rows, 'BTCUSDT').detector.getRanges(),
        'complete replay must be deterministic'
    );
    var beforeRestart = replay(rows, 'BTCUSDT', 563).detector;
    var restoredDetector = detectorModule.createRangeDetectorV1({
        symbol: 'BTCUSDT', state: beforeRestart.getState()
    });
    assert.deepStrictEqual(restoredDetector.getActiveRange(), beforeRestart.getActiveRange());
    assert.strictEqual(restoredDetector.onCandle(candle(563, 100)).events.length, 0);
    assert.strictEqual(restoredDetector.getActiveRange().status, 'ACTIVE');

    // Frozen canary/config and presentation schema.
    assert.deepStrictEqual(liveConfig.rangeDetector.symbols, ['BTCUSDT', 'ZECUSDT']);
    assert.deepStrictEqual(liveConfig.rangeDetector.parameters, { length: 24, mult: 1.0, atrLength: 500 });
    assert.strictEqual(liveConfig.rangeDetector.notifyOnConfirm, true);
    assert.strictEqual(liveConfig.rangeDetector.notifyOnBreakout, false);
    var liveScript = require('../scripts/live');
    assert.strictEqual(liveScript.rangeEnabledFor('BTCUSDT'), true);
    assert.strictEqual(liveScript.rangeEnabledFor('ZECUSDT'), true);
    assert.strictEqual(liveScript.rangeEnabledFor('PROMUSDT'), false);
    var message = presentation.buildRangeConfirmationMessage(confirmation, {
        exchangeInfo: { tickSize: 0.1 }, keyword: '检测', formatTime: String
    });
    assert.ok(message.indexOf('BTCUSDT 5m 震荡区间确认') !== -1);
    assert.ok(message.indexOf('参数: L24 / ATR500 / 1.0') !== -1);
    ['Bullish', 'Bearish', 'AMD', 'Bias', 'Sweep', 'MSS', 'Displacement', 'FVG', 'WATCH', 'Entry', 'Trade'].forEach(function (term) {
        assert.strictEqual(message.indexOf(term), -1, term);
    });

    // Frozen BTC/ZEC research-production replay parity.
    researchParity('BTCUSDT', '../artifacts/research/luxalgo-length24-oos-v1/dataset.json', '../artifacts/research/luxalgo-length24-oos-v1/ranges-length24.json');
    researchParity('ZECUSDT', '../artifacts/research/luxalgo-zec-length24-7d-v1/dataset.json', '../artifacts/research/luxalgo-zec-length24-7d-v1/ranges-zec-length24.json');

    console.log('RANGE_OBJECT_V1 production tests: PASS');
    console.log('BTC_RESEARCH_PRODUCTION_PARITY=PASS');
    console.log('ZEC_RESEARCH_PRODUCTION_PARITY=PASS');
}

main().catch(function (error) {
    console.error(error && error.stack || error);
    process.exit(1);
});
