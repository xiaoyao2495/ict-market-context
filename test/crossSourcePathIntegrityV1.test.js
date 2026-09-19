'use strict';

// CROSS_SOURCE_PATH_INTEGRITY_V1 - deterministic unit coverage (§13 cases 1-15 plus
// the §4 semantic cases A-E). No LLM, no network, no production state.
//
// The three REAL anchors (ETH REAL-001 PASS, BTC REAL-002 PASS, SOL REAL-003 FAIL) are
// injected from test/fixtures/crossSourcePathIntegrityV1.real.json when that fixture is
// present; without it those cases are reported as PENDING (never silently skipped pass).

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var pathIntegrity = require('../strategy/crossSourcePathIntegrityV1');

var TIMEFRAME_MS = pathIntegrity.TIMEFRAME_MS;
var ANCHOR = 1789790000000;                 // arbitrary 5m-aligned anchor openTime
var K1 = ANCHOR + 10 * TIMEFRAME_MS;

var passed = 0, failed = 0;
function check(name, fn) {
    try { fn(); passed += 1; console.log('PASS  ' + name); }
    catch (error) { failed += 1; console.log('FAIL  ' + name + '\n      ' + error.message); }
}

/** Complete intermediate 5m sequence between the anchor and K1. */
function bars(specs) {
    return specs.map(function (spec) {
        var openTime = spec[0];
        return { openTime: openTime, closeTime: openTime + TIMEFRAME_MS - 1,
            high: spec[1], low: spec[2], open: spec[1], close: spec[2] };
    });
}
/** idx 1..9 are the intermediate bars (anchor and K1/K2 are excluded by construction). */
function seq(intermediates, k1Bar, k2Bar) {
    var out = [{ openTime: ANCHOR, high: 500, low: 400, closeTime: ANCHOR + TIMEFRAME_MS - 1 }];
    intermediates.forEach(function (bar, index) {
        var openTime = ANCHOR + (index + 1) * TIMEFRAME_MS;
        out.push({ openTime: openTime, closeTime: openTime + TIMEFRAME_MS - 1,
            high: bar.high, low: bar.low });
    });
    out.push({ openTime: K1, closeTime: K1 + TIMEFRAME_MS - 1, high: k1Bar.high, low: k1Bar.low });
    out.push({ openTime: K1 + TIMEFRAME_MS, closeTime: K1 + 2 * TIMEFRAME_MS - 1,
        high: k2Bar.high, low: k2Bar.low });
    return out;
}
function flat(count, high, low) {
    var out = [];
    for (var i = 0; i < count; i++) out.push({ high: high, low: low });
    return out;
}
function longCase(partnerPrice, intermediates, k1Low, k2Low) {
    return pathIntegrity.evaluateCrossSourcePathIntegrity({
        twoBar: { direction: 'BULLISH', price: Math.min(k1Low, k2Low), k1OpenTime: K1,
            k2OpenTime: K1 + TIMEFRAME_MS, confirmedAt: K1 + 2 * TIMEFRAME_MS - 1 },
        partner: { price: partnerPrice, occurredAt: ANCHOR },
        bars: seq(intermediates, { low: k1Low, high: k1Low + 5 }, { low: k2Low, high: k2Low + 5 })
    });
}
function shortCase(partnerPrice, intermediates, k1High, k2High) {
    return pathIntegrity.evaluateCrossSourcePathIntegrity({
        twoBar: { direction: 'BEARISH', price: Math.max(k1High, k2High), k1OpenTime: K1,
            k2OpenTime: K1 + TIMEFRAME_MS, confirmedAt: K1 + 2 * TIMEFRAME_MS - 1 },
        partner: { price: partnerPrice, occurredAt: ANCHOR },
        bars: seq(intermediates, { high: k1High, low: k1High - 5 }, { high: k2High, low: k2High - 5 })
    });
}

// ------------------------------------------------------------------ §13 1-3, §4 A-D
check('1 LONG no crossing -> PASS', function () {
    var r = longCase(100.0, flat(9, 100.5, 100.2), 99.5, 100.4);
    assert.strictEqual(r.status, 'PASS');
    assert.strictEqual(r.reason, 'PASS');
    assert.strictEqual(r.intermediateBarCount, 9);
});
check('2 LONG middle low == boundary -> PASS (equality is valid)', function () {
    // boundary = min(partner 100.0, T 99.5) = 99.5; a middle low of exactly 99.5 is VALID
    var r = longCase(100.0, flat(9, 100.2, 99.5), 100.1, 99.5);
    assert.strictEqual(r.boundary, 99.5);
    assert.strictEqual(r.status, 'PASS');
});
check('3 LONG middle low < boundary -> FAIL', function () {
    var r = longCase(100.0, flat(9, 100.2, 99.3), 100.1, 99.5);
    assert.strictEqual(r.boundary, 99.5);
    assert.strictEqual(r.status, 'FAIL');
    assert.strictEqual(r.reason, 'LOW_BELOW_BOUNDARY');
    assert.ok(r.violatingBar, 'a violating bar is reported');
});
check('4 LONG the Two-Bar K1 wick itself is not an intermediate bar', function () {
    // K1.low 99.5 IS the boundary; K2 is bullish; the path must stay PASS
    var r = longCase(100.0, flat(9, 100.4, 99.5), 99.5, 100.2);
    assert.strictEqual(r.boundary, 99.5);
    assert.strictEqual(r.status, 'PASS', 'K1 may not invalidate its own partner');
});
check('5 LONG the Two-Bar K2 wick itself is not an intermediate bar', function () {
    var r = longCase(100.0, flat(9, 100.4, 99.5), 100.2, 99.5);
    assert.strictEqual(r.status, 'PASS', 'K2 may not invalidate its own partner');
});
check('6 LONG D=100 middle=99.7 T=99.5 -> PASS (§4 Case B)', function () {
    var r = longCase(100.0, flat(9, 100.5, 99.7), 100.4, 99.5);
    assert.strictEqual(r.boundary, 99.5);
    assert.strictEqual(r.status, 'PASS');
});
check('7 LONG D=100 middle=99.3 T=99.5 -> FAIL (§4 Case C)', function () {
    var r = longCase(100.0, flat(9, 100.5, 99.3), 100.4, 99.5);
    assert.strictEqual(r.boundary, 99.5);
    assert.strictEqual(r.status, 'FAIL');
});

// ------------------------------------------------------------------ §13 8-12 (SHORT)
check('8 SHORT no crossing -> PASS', function () {
    var r = shortCase(100.0, flat(9, 99.8, 99.5), 100.5, 99.9);
    assert.strictEqual(r.status, 'PASS');
});
check('9 SHORT middle high == boundary -> PASS', function () {
    var r = shortCase(100.0, flat(9, 100.5, 99.5), 99.9, 100.5);
    assert.strictEqual(r.boundary, 100.5);
    assert.strictEqual(r.status, 'PASS');
});
check('10 SHORT middle high > boundary -> FAIL', function () {
    var r = shortCase(100.0, flat(9, 100.7, 99.5), 99.9, 100.5);
    assert.strictEqual(r.boundary, 100.5);
    assert.strictEqual(r.status, 'FAIL');
    assert.strictEqual(r.reason, 'HIGH_ABOVE_BOUNDARY');
});
check('11 SHORT K1/K2 crossing the boundary is outside the intermediate scan', function () {
    var r = shortCase(100.0, flat(9, 100.4, 99.5), 100.5, 101.0);
    assert.strictEqual(r.boundary, 101.0);
    assert.strictEqual(r.status, 'PASS');
});
check('12 the anchor bar itself is not scanned', function () {
    // the anchor bar (low 400 / high 500) would destroy every case if scanned
    var r = longCase(100.0, flat(9, 100.4, 100.0), 100.2, 100.1);
    assert.strictEqual(r.status, 'PASS');
});

// ------------------------------------------------------------------ §13 13-15
check('13 the scan uses anchorOccurredAt, never a process range', function () {
    var withProcess = pathIntegrity.evaluateCrossSourcePathIntegrity({
        twoBar: { direction: 'BULLISH', price: 99.5, k1OpenTime: K1, confirmedAt: K1 },
        // a process range that starts far earlier must be ignored entirely
        partner: { price: 100.0, occurredAt: ANCHOR, processStart: ANCHOR - 20 * TIMEFRAME_MS,
            processEnd: ANCHOR + TIMEFRAME_MS },
        bars: seq(flat(9, 100.5, 99.7), { low: 100.4, high: 100.9 }, { low: 99.5, high: 100.0 })
    });
    assert.strictEqual(withProcess.anchorOccurredAt, ANCHOR);
    assert.strictEqual(withProcess.intermediateBarCount, 9);
    assert.strictEqual(withProcess.status, 'PASS');
});
check('14 a gap in the intermediate path -> UNKNOWN / fail closed', function () {
    var withGap = seq(flat(9, 100.5, 100.2), { low: 100.4, high: 100.9 }, { low: 100.1, high: 100.6 });
    withGap.splice(5, 1);                          // drop one intermediate bar
    var r = pathIntegrity.evaluateCrossSourcePathIntegrity({
        twoBar: { direction: 'BULLISH', price: 100.1, k1OpenTime: K1, confirmedAt: K1 },
        partner: { price: 100.0, occurredAt: ANCHOR }, bars: withGap
    });
    assert.strictEqual(r.status, 'UNKNOWN');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'MISSING_INTERMEDIATE_BARS');
});
check('15 no future bars: a bar closing after the Two-Bar confirmation fails closed', function () {
    var withFuture = seq(flat(9, 100.5, 100.2), { low: 100.4, high: 100.9 }, { low: 100.1, high: 100.6 });
    withFuture[3].closeTime = K1 + 5 * TIMEFRAME_MS;    // claims to close after confirmation
    var r = pathIntegrity.evaluateCrossSourcePathIntegrity({
        twoBar: { direction: 'BULLISH', price: 100.1, k1OpenTime: K1, confirmedAt: K1 },
        partner: { price: 100.0, occurredAt: ANCHOR }, bars: withFuture
    });
    assert.strictEqual(r.status, 'UNKNOWN');
    assert.strictEqual(r.ok, false);
});
check('13b missing anchor provenance -> UNKNOWN / fail closed', function () {
    var r = pathIntegrity.evaluateCrossSourcePathIntegrity({
        twoBar: { direction: 'BULLISH', price: 100.1, k1OpenTime: K1, confirmedAt: K1 },
        partner: { price: 100.0 }, bars: []
    });
    assert.strictEqual(r.status, 'UNKNOWN');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'MISSING_INTERMEDIATE_BARS');
});

// ------------------------------------------------------------------ §11 real anchors
var FIXTURE = path.join(__dirname, 'fixtures', 'crossSourcePathIntegrityV1.real.json');
var NAMES = ['ETH_REAL_001', 'BTC_REAL_002', 'SOL_REAL_003'];

async function checkAsync(name, fn) {
    try { await fn(); passed += 1; console.log('PASS  ' + name); }
    catch (error) { failed += 1; console.log('FAIL  ' + name + '\n      ' + (error && error.message)); }
}
function integrityOf(anchor, candidate) {
    return pathIntegrity.evaluateCrossSourcePathIntegrity({ twoBar: anchor.twoBar,
        partner: { price: candidate.provenance.price, occurredAt: candidate.provenance.occurredAt },
        bars: anchor.bars });
}
/** The production selector order over a candidate list: confirmedAt asc, then id. */
function selectFirst(candidates) {
    return candidates.slice().sort(function (a, b) {
        return a.provenance.confirmedAt - b.provenance.confirmedAt ||
            String(a.provenance.id).localeCompare(String(b.provenance.id)); })[0] || null;
}

async function realAnchorChecks() {
    var real = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
    var twoBar = require('../strategy/twoBarReversalV1');
    var setupV1 = require('../strategy/twoBarSetupV1');
    var patternLib = require('../research/reversalPatternSemanticAuditV1');

    NAMES.forEach(function (name) {
        var anchor = real[name];
        check('16/17/18 ' + name + ' re-executes every real candidate window', function () {
            assert.ok(anchor, name + ' present in the fixture');
            assert.ok(anchor.bars.length > 0, name + ' ships real bars, not a bare expectation');
            anchor.candidates.forEach(function (candidate) {
                var r = integrityOf(anchor, candidate);
                assert.strictEqual(r.status, candidate.expectedPathStatus,
                    name + ' ' + candidate.provenance.price + ' -> ' + r.status + '/' + r.reason);
                if (candidate.expectedReason) assert.strictEqual(r.reason, candidate.expectedReason);
            });
        });
        check('19 ' + name + ' the surviving set + production selector pick the expected partner',
            function () {
                var accepted = anchor.candidates.filter(function (candidate) {
                    return integrityOf(anchor, candidate).ok === true; });
                var chosen = selectFirst(accepted);
                assert.strictEqual(chosen ? chosen.provenance.id : null,
                    anchor.expectedSelectedPartnerId, name + ' selector result');
            });
    });

    for (var name of NAMES) {
        await checkAsync('20 ' + name + ' setup service: EQ eligibility after the path filter',
            async function () {
                var anchor = real[name];
                var candles = anchor.bars;
                var idx = {};
                candles.forEach(function (bar, i) { idx[bar.openTime] = i; });
                var k1Index = idx[anchor.twoBar.k1OpenTime], k2Index = idx[anchor.twoBar.k2OpenTime];
                assert.ok(k1Index !== undefined && k2Index !== undefined,
                    name + ' K1/K2 present inside the fixture bars');
                var side = anchor.twoBar.direction === 'BULLISH' ? 'LOW' : 'HIGH';
                var points = anchor.candidates.map(function (candidate) {
                    return { id: candidate.provenance.id, processId: candidate.provenance.processId,
                        pointSide: side, price: candidate.provenance.price,
                        occurredAt: candidate.provenance.occurredAt,
                        confirmedAt: candidate.provenance.confirmedAt,
                        occurredBarIndex: idx[candidate.provenance.occurredAt],
                        localizedExtremePrice: candidate.provenance.price, state: 'ACTIVE' }; });
                var observed = [];
                var direction = anchor.twoBar.direction;
                var service = setupV1.createService({ symbol: anchor.symbol,
                    decisionStore: setupV1.createMemoryStore(),
                    observe: function (event) { observed.push(event); },
                    requestSemantic: function (systemPrompt) {
                        var expected = direction === 'BULLISH' ? 'BEARISH' : 'BULLISH';
                        return Promise.resolve(systemPrompt === patternLib.SYSTEM_PROMPT
                            ? { matches: [{ pattern: 'TWO_BAR_REVERSAL', direction: direction,
                                label: 'CLEAR', confidence: 'HIGH', supportingFacts: ['t'],
                                conflicts: [], reason: 't' }], overall: 'CLEAR_PATTERN' }
                            : { expectedDirection: expected, detectedDirection: expected,
                                label: 'CLEAR', confidence: 'HIGH', estimatedLegBars: 6,
                                reason: 't' }); } });
                var result = await service.evaluateCandidate(
                    { direction: direction, symbol: anchor.symbol,
                        windowBars: [candles[k1Index], candles[k2Index]],
                        windowFacts: candles.slice(k1Index, k2Index + 1),
                        startIndex: k1Index, endIndex: k2Index },
                    { candles: candles, atrValue: anchor.tolerance / 0.7,
                        dynamicDState: { recentSurvivalPoints: points }, currentBarIndex: k2Index });
                var rejected = observed.filter(function (e) {
                    return e.event === 'TWO_BAR_EQ_PATH_REJECTED'; });
                var failing = anchor.candidates.filter(function (c) {
                    return c.expectedPathStatus !== 'PASS'; });
                assert.strictEqual(rejected.length, failing.length,
                    name + ' exactly the failing candidates are logged as TWO_BAR_EQ_PATH_REJECTED');
                if (anchor.expectedSelectedPartnerId === null) {
                    assert.strictEqual(result.status, 'NO_SETUP', name + ' no surviving EQ partner');
                    assert.strictEqual(result.reason, 'NO_DYNAMIC_D_EQ_PARTNER');
                } else {
                    assert.strictEqual(result.status, 'SETUP', name + ' setup survives');
                    assert.strictEqual(result.setup.nearestPartnerId, anchor.expectedSelectedPartnerId);
                    assert.strictEqual(result.setup.type,
                        direction === 'BULLISH' ? 'EQL' : 'EQH');
                }
            });
    }
}

if (fs.existsSync(FIXTURE)) {
    realAnchorChecks().catch(function (error) {
        failed += 1; console.log('FAIL  real anchor harness\n      ' + (error && error.stack || error)); })
        .then(function () { summary(); });
} else {
    console.log('PENDING real anchors: fixture ' + path.relative(process.cwd(), FIXTURE) +
        ' is not present (requires a one-time extraction of real 5m bars)');
    summary();
}

function summary() {
    console.log('');
    console.log('CHECKS PASSED: ' + passed);
    console.log('CHECKS FAILED: ' + failed);
    console.log('CROSS_SOURCE_PATH_INTEGRITY_V1=' + (failed === 0 ? 'PASS' : 'FAIL'));
    if (failed) process.exitCode = 1;
}
