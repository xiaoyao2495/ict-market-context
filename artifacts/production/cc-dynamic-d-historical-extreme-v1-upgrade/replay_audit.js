'use strict';

/**
 * HISTORICAL REPLAY SANITY + CAUSALITY AUDIT
 * PRODUCTION_HISTORICAL_EXTREME_CC_DYNAMIC_D_V1
 *
 * Replays the FROZEN Binance USDⓈ-M Futures 5m dataset (NETWORK=0) through the
 * production EQ pipeline and verifies the causality / invariant gates that the
 * spec requires for the ZigZag -> Dynamic D replacement:
 *
 *   1. confirmedAt <= evaluationTime (confirmed on the current reversal candle;
 *      never a future candle).
 *   2. selectorPrice (close) is the DETECTION selector; price (wick) is the
 *      business price. wick is used for EQ + invalidation; close never is.
 *   3. No future data: each anchor's occurrence index is strictly before its
 *      confirmation index, and the evaluation never reads a candle beyond the
 *      current index.
 *   4. Determinism: two independent replays are byte-identical.
 *   5. Production pipeline wraps the detection 1:1 (same anchor id set).
 *
 * Emits replay-summary.json + causality-audit.json. No network, no mutation.
 */

var fs = require('fs');
var path = require('path');

var ROOT = path.resolve(__dirname, '../../..');
var DATA = path.join(ROOT, 'data-cache/BTCUSDT_5m_20636_20697.json');
var dynamicD = require(path.join(ROOT, 'liquidity/causalDynamicDHistoricalExtremes'));
var prodEq = require(path.join(ROOT, 'liquidity/productionEqualLiquidityV1'));

var candles = JSON.parse(fs.readFileSync(DATA, 'utf8'));
if (!Array.isArray(candles)) throw new Error('dataset is not an array');
// Defensive: ensure strictly increasing 5m spacing (causal continuity prereq).
var continuityOk = true;
for (var i = 1; i < candles.length; i++) {
    if (candles[i].openTime !== candles[i - 1].openTime + 300000) { continuityOk = false; break; }
}

// openTime -> candle lookup (for selectorPrice/wick cross-check).
var byOpen = {};
candles.forEach(function (c) { byOpen[c.openTime] = c; });

function replayDynamicD() {
    var st = dynamicD.createState({ symbol: 'BTCUSDT', timeframe: '5m' });
    var anchors = [];
    for (var idx = 0; idx < candles.length; idx++) {
        var out = dynamicD.step(st, candles[idx], idx, candles.slice(0, idx + 1));
        out.dynamicDPoints.forEach(function (a) { anchors.push(a); });
    }
    return anchors;
}

function replayProduction() {
    var st = prodEq.createState({ symbol: 'BTCUSDT', timeframe: '5m' });
    var ids = {};
    for (var idx = 0; idx < candles.length; idx++) {
        var out = prodEq.step(st, candles[idx], idx, candles.slice(0, idx + 1), []);
        out.dynamicDPoints.forEach(function (a) { ids[a.id] = true; });
    }
    return ids;
}

function sortById(arr) { return arr.slice().sort(function (a, b) { return a.id < b.id ? -1 : 1; }); }

var t0 = Date.now();
var anchorsD = replayDynamicD();
var tDyn = Date.now() - t0;
var anchorsProd = replayProduction();

// ---- Causality invariants ----
var lastClose = candles[candles.length - 1].closeTime;
var causalityFailures = [];
var selectorWickFailures = [];
var futureFailures = [];
var highCount = 0, lowCount = 0;
var wickDiffersFromClose = 0;

anchorsD.forEach(function (a) {
    // confirmedAt must equal the confirmation candle's closeTime (evaluation time).
    var confCandle = candles[a.confirmationBarIndex];
    if (a.confirmedAt !== confCandle.closeTime) {
        causalityFailures.push({ id: a.id, reason: 'confirmedAt != confirmationCandle.closeTime' });
    }
    if (a.confirmedAt > lastClose) {
        futureFailures.push({ id: a.id, reason: 'confirmedAt beyond dataset end' });
    }
    // occurrence strictly before confirmation (no same-candle ambiguity / no future).
    if (!(a.occurredBarIndex < a.confirmationBarIndex)) {
        futureFailures.push({ id: a.id, reason: 'occurrence index >= confirmation index' });
    }
    if (!(a.occurredAt < a.confirmedAt)) {
        futureFailures.push({ id: a.id, reason: 'occurredAt >= confirmedAt' });
    }
    // selectorPrice (close) vs price (wick) invariant on the extreme candle.
    var ex = byOpen[a.occurredAt];
    if (!ex) { selectorWickFailures.push({ id: a.id, reason: 'extreme candle not found' }); return; }
    var expectedWick = a.pointSide === 'HIGH' ? ex.high : ex.low;
    var expectedSelector = ex.close;
    if (a.price !== expectedWick) {
        selectorWickFailures.push({ id: a.id, reason: 'price != wick (got ' + a.price + ' want ' + expectedWick + ')' });
    }
    if (a.selectorPrice !== expectedSelector) {
        selectorWickFailures.push({ id: a.id, reason: 'selectorPrice != close' });
    }
    if (expectedWick !== expectedSelector) wickDiffersFromClose++;
    if (a.pointSide === 'HIGH') highCount++; else lowCount++;
});

// ---- Determinism: second independent replay must be byte-identical ----
var anchorsD2 = replayDynamicD();
var determinismOk = JSON.stringify(sortById(anchorsD)) === JSON.stringify(sortById(anchorsD2));

// ---- Production wraps detection 1:1 ----
var prodIds = Object.keys(anchorsProd).sort();
var dynIds = sortById(anchorsD).map(function (a) { return a.id; });
var wrapOk = prodIds.length === dynIds.length && prodIds.every(function (id, i) { return id === dynIds[i]; });

// ---- Age-expiry / terminal transition on real anchors (no resurrection) ----
// Exercise markInactive on a real anchor and confirm it cannot be reactivated.
var sampleAnchor = anchorsD[0];
var inactivationOk = false;
if (sampleAnchor) {
    var cloned = JSON.parse(JSON.stringify(sampleAnchor));
    var first = dynamicD.markInactive(cloned, 'AGE_EXPIRY', cloned.confirmedAt + 1);
    var second = dynamicD.markInactive(cloned, 'STRICT_CROSS', cloned.confirmedAt + 2);
    inactivationOk = first === true && second === false && cloned.state === 'INACTIVE';
}

var causalityPass = causalityFailures.length === 0 && futureFailures.length === 0;
var selectorPass = selectorWickFailures.length === 0;
var allPass = causalityPass && selectorPass && determinismOk && wrapOk && inactivationOk && continuityOk;

var replaySummary = {
    task: 'PRODUCTION_HISTORICAL_EXTREME_CC_DYNAMIC_D_V1',
    dataset: 'data-cache/BTCUSDT_5m_20636_20697.json',
    dataSource: candles[0] && candles[0].source,
    networkUsed: false,
    bars: candles.length,
    candleSpacingMs: 300000,
    continuityOk: continuityOk,
    runtimeMsDynamicD: tDyn,
    anchors: {
        total: anchorsD.length,
        HIGH: highCount,
        LOW: lowCount,
        wickDiffersFromCloseCount: wickDiffersFromClose
    },
    determinism: determinismOk,
    productionWrap: wrapOk,
    ageExpiryTerminal: inactivationOk,
    verdict: allPass ? 'PASS' : 'FAIL'
};

var causalityAudit = {
    task: 'PRODUCTION_HISTORICAL_EXTREME_CC_DYNAMIC_D_V1',
    generatedAt: new Date().toISOString(),
    gates: {
        CONFIRMED_AT_LE_EVALUATION_TIME: {
            pass: causalityFailures.length === 0,
            failures: causalityFailures.slice(0, 10),
            failureCount: causalityFailures.length
        },
        NO_FUTURE_DATA: {
            pass: futureFailures.length === 0,
            failures: futureFailures.slice(0, 10),
            failureCount: futureFailures.length
        },
        SELECTOR_PRICE_CLOSE_BUSINESS_PRICE_WICK: {
            pass: selectorPass,
            failures: selectorWickFailures.slice(0, 10),
            failureCount: selectorWickFailures.length,
            note: 'selectorPrice=close used only for detection; price=wick (HIGH->candle.high, LOW->candle.low) used for EQ + invalidation'
        },
        DETERMINISM: { pass: determinismOk },
        PRODUCTION_WRAPS_DETECTION_1TO1: { pass: wrapOk },
        INACTIVE_TERMINAL_NO_RESURRECTION: { pass: inactivationOk }
    },
    verdict: allPass ? 'PASS' : 'FAIL'
};

fs.writeFileSync(path.join(__dirname, 'replay-summary.json'), JSON.stringify(replaySummary, null, 2) + '\n');
fs.writeFileSync(path.join(__dirname, 'causality-audit.json'), JSON.stringify(causalityAudit, null, 2) + '\n');

console.log('REPLAY SUMMARY: ' + (allPass ? 'PASS' : 'FAIL'));
console.log('  bars=' + candles.length + ' anchors=' + anchorsD.length +
    ' (HIGH=' + highCount + ' LOW=' + lowCount + ') wick!=close=' + wickDiffersFromClose);
console.log('  determinism=' + determinismOk + ' productionWrap=' + wrapOk +
    ' ageTerminal=' + inactivationOk + ' continuity=' + continuityOk);
if (!allPass) {
    console.log('  causalityFailures=' + causalityFailures.length +
        ' futureFailures=' + futureFailures.length +
        ' selectorWickFailures=' + selectorWickFailures.length);
    process.exit(1);
}
