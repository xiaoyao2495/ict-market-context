/**
 * 4H audit-only Structural Provenance V1.1 regression tests.
 */
var assert = require('assert');
var auditPivots = require('../ai/auditPivots');
var auditMarketFacts = require('../ai/auditMarketFacts');
var structural = require('../ai/auditStructuralProvenance');
var fixture = require('./fixtures/deepseek4h-case02.json');

var passed = 0;
var failed = 0;
function test(name, fn) {
    try {
        fn();
        passed++;
        console.log('PASS  ' + name);
    } catch (e) {
        failed++;
        console.log('FAIL  ' + name + '  ->  ' + e.message);
    }
}

function computeAt(evalIdx) {
    var candles = fixture.candles;
    var pivots = auditPivots.detectPivots(candles, evalIdx, {
        left: 2, right: 2, window: 120
    });
    var facts = auditMarketFacts.computeMarketFacts(candles, evalIdx, pivots, {
        deliveryHintEnabled: true
    });
    return structural.computeStructuralProvenance(candles, evalIdx, pivots, {
        breaks: facts.breaks
    });
}

function finalResult() {
    return computeAt(fixture.candles.length - 1);
}

function swingAt(result, price) {
    var s = result.protectedSwings.filter(function (x) { return x.price === price; })[0];
    assert.ok(s, '缺少 protected swing ' + price);
    return s;
}

function eventAt(result, type, level) {
    var e = result.structuralEvents.filter(function (x) {
        return x.type === type && x.referenceLevel === level;
    })[0];
    assert.ok(e, '缺少 event ' + type + ' @ ' + level);
    return e;
}

test('Case 2：72451.9 在 BOS close 时仅为 PENDING，不提前 ACTIVE', function () {
    var idx = fixture.candles.findIndex(function (c) {
        return new Date(c.openTime).toISOString() === '2026-04-11T16:00:00.000Z';
    });
    var result = computeAt(idx);
    var p = result.pendingProvenances.filter(function (x) {
        return x.controllingPrice === 72451.9 && x.parentStructuralLevel === 73450;
    })[0];
    assert.ok(p, 'BOS candle close 后必须有 72451.9 pending provenance');
    assert.strictEqual(p.bosClose, 73635.9);
    assert.strictEqual(p.status, 'PENDING');
    assert.strictEqual(result.protectedSwings.some(function (x) { return x.price === 72451.9; }), false);
});

test('Case 2：71382.1 是支撑 73450 的 superseded protected low', function () {
    var s = swingAt(finalResult(), 71382.1);
    assert.strictEqual(s.role, 'SUPERSEDED_PROTECTED_LOW');
    assert.strictEqual(s.status, 'SUPERSEDED_PROTECTED');
    assert.strictEqual(s.parentStructuralLevel, 73128);
    assert.strictEqual(s.supportedProducedHigh, 73450);
    assert.strictEqual(s.supersededBy, 72451.9);
    assert.strictEqual(s.structuralMssReference, false);
    assert.strictEqual(s.brokenByClose, false, '04/12 00:00 对 71382.1 只是 wick penetration');
    assert.strictEqual(s.penetratedAt, '2026-04-12T00:00:00.000Z');
    assert.strictEqual(s.penetratedByWick, true);
});

test('Case 2：72451.9 provenance 精确产生 73773.4 HH', function () {
    var s = swingAt(finalResult(), 72451.9);
    assert.strictEqual(s.role, 'ACTIVE_PROTECTED_LOW');
    assert.strictEqual(s.parentStructuralLevel, 73450);
    assert.strictEqual(s.parentHigh, 73450);
    assert.strictEqual(s.bosLevel, 73450);
    assert.strictEqual(s.bosCandleTime, '2026-04-11T16:00:00.000Z');
    assert.strictEqual(s.bosClose, 73635.9);
    assert.strictEqual(s.supportedProducedHigh, 73773.4);
    assert.strictEqual(s.producedHigh, 73773.4);
    assert.strictEqual(s.protectedConfirmedAt, '2026-04-11T23:59:59.999Z');
    assert.strictEqual(s.ancestorProtectedSwing, 71382.1);
});

test('Case 2：close below 72451.9 生成唯一 first bearish structural MSS', function () {
    var result = finalResult();
    var s = swingAt(result, 72451.9);
    var e = eventAt(result, 'STRUCTURAL_MSS', 72451.9);
    assert.strictEqual(s.status, 'BROKEN');
    assert.strictEqual(s.brokenAt, '2026-04-12T00:00:00.000Z');
    assert.strictEqual(s.brokenByClose, true);
    assert.strictEqual(s.structuralMssReference, true);
    assert.strictEqual(e.direction, 'BEARISH');
    assert.strictEqual(e.referenceRole, 'ACTIVE_PROTECTED_LOW');
    assert.strictEqual(e.confirmedAt, '2026-04-12T03:59:59.999Z');
    assert.strictEqual(e.structuralStateBefore, 'BULLISH');
    assert.strictEqual(e.structuralStateAfter, 'BEARISH');
    assert.strictEqual(e.stateChanged, true);
    assert.strictEqual(result.structuralEvents.some(function (x) {
        return x.type === 'STRUCTURAL_MSS' && x.referenceLevel === 71382.1;
    }), false, '71382.1 不得成为同 candle first structural MSS reference');
});

test('V1.1：同方向 protected close-break 保持 BROKEN，但降级 structural continuation', function () {
    var result = finalResult();
    var swing = swingAt(result, 69142.6);
    var e = eventAt(result, 'STRUCTURAL_CONTINUATION', 69142.6);
    assert.strictEqual(swing.status, 'BROKEN');
    assert.strictEqual(swing.brokenByClose, true);
    assert.strictEqual(swing.structuralMssReference, false);
    assert.strictEqual(e.direction, 'BULLISH');
    assert.strictEqual(e.structuralStateBefore, 'BULLISH');
    assert.strictEqual(e.structuralStateAfter, 'BULLISH');
    assert.strictEqual(e.stateChanged, false);
    assert.strictEqual(result.structuralEvents.some(function (x) {
        return x.type === 'STRUCTURAL_MSS' && x.referenceLevel === 69142.6;
    }), false);
});

test('V1.1：每个 STRUCTURAL_MSS 都必须实际改变 state', function () {
    finalResult().structuralEvents.filter(function (e) {
        return e.type === 'STRUCTURAL_MSS';
    }).forEach(function (e) {
        assert.notStrictEqual(e.structuralStateBefore, e.direction);
        assert.strictEqual(e.structuralStateAfter, e.direction);
        assert.strictEqual(e.stateChanged, true);
    });
});

test('V1.1 persistence：active protected / state / ancestry 不因 pivot window 滚出而消失', function () {
    var candles = [];
    var start = Date.parse('2026-01-01T00:00:00.000Z');
    for (var i = 0; i < 4; i++) {
        candles.push({
            openTime: start + i * 14400000,
            open: 100, high: 105, low: 95, close: 100,
            closeTime: start + (i + 1) * 14400000 - 1,
            closed: true
        });
    }
    var carried = {
        evaluationTime: candles[2].closeTime,
        protectedSwings: [{
            price: 110, occurredAt: new Date(candles[0].openTime).toISOString(),
            confirmedAt: new Date(candles[1].closeTime).toISOString(), side: 'HIGH',
            direction: 'BEARISH', parentStructuralLevel: 90,
            parentStructuralConfirmedAt: new Date(candles[0].closeTime).toISOString(),
            bosLevel: 90, bosCandleTime: new Date(candles[1].openTime).toISOString(),
            bosClose: 89, bosConfirmedAt: new Date(candles[1].closeTime).toISOString(),
            protectedConfirmedAt: new Date(candles[1].closeTime).toISOString(),
            supportedProducedLevel: 85, supportedProducedConfirmedAt: null,
            role: 'ACTIVE_PROTECTED_HIGH', status: 'ACTIVE_PROTECTED',
            ancestry: [120], ancestorProtectedSwing: 120, supersededBy: null,
            brokenAt: null, brokenConfirmedAt: null, brokenByClose: false,
            structuralMssReference: false
        }],
        structuralEvents: [{
            type: 'BOS', direction: 'BEARISH', referenceLevel: 90,
            referenceRole: 'PARENT_STRUCTURAL_LOW',
            eventTime: new Date(candles[1].openTime).toISOString(),
            confirmedAt: new Date(candles[1].closeTime).toISOString(),
            sourceProtectedSwing: null
        }]
    };
    var result = structural.computeStructuralProvenance(candles, 3,
        { highs: [], lows: [], params: { left: 2, right: 2, window: 2 } },
        { breaks: [], previousSnapshot: carried });
    var s = swingAt(result, 110);
    assert.strictEqual(s.status, 'ACTIVE_PROTECTED');
    assert.deepStrictEqual(s.ancestry, [120]);
    assert.strictEqual(s.ancestorProtectedSwing, 120);
    assert.strictEqual(result.structuralState, 'BEARISH');
    assert.strictEqual(result.persistence.carriedProtectedSwingCount, 1);
    assert.deepStrictEqual(result.futureLeakViolations, []);
});

test('Case 2：71259 后续 close break 是 bearish CONTINUATION', function () {
    var result = finalResult();
    var e = eventAt(result, 'CONTINUATION', 71259);
    assert.strictEqual(e.direction, 'BEARISH');
    assert.strictEqual(e.eventTime, '2026-04-12T12:00:00.000Z');
    assert.strictEqual(e.confirmedAt, '2026-04-12T15:59:59.999Z');
    assert.strictEqual(e.sourceProtectedSwing.price, 72451.9);
});

test('Bearish provenance 对称：首次 close-through 72451.9 激活 73773.4 protected high', function () {
    var s = swingAt(finalResult(), 73773.4);
    assert.strictEqual(s.side, 'HIGH');
    assert.strictEqual(s.direction, 'BEARISH');
    assert.strictEqual(s.role, 'ACTIVE_PROTECTED_HIGH');
    assert.strictEqual(s.parentStructuralLevel, 72451.9);
    assert.strictEqual(s.bosClose, 71563.6);
    assert.strictEqual(s.protectedConfirmedAt, '2026-04-12T03:59:59.999Z');
});

test('所有 protected/event confirmedAt 均不晚于 evaluationTime', function () {
    var result = finalResult();
    assert.deepStrictEqual(result.futureLeakViolations, []);
    result.protectedSwings.forEach(function (s) {
        ['confirmedAt', 'parentStructuralConfirmedAt', 'bosConfirmedAt',
            'protectedConfirmedAt', 'supportedProducedConfirmedAt', 'brokenConfirmedAt',
            'penetrationConfirmedAt']
            .forEach(function (field) {
                if (s[field] != null) {
                    assert.ok(Date.parse(s[field]) <= result.evaluationTime,
                        'future leak ' + s.price + ' ' + field);
                }
            });
    });
    result.structuralEvents.forEach(function (e) {
        assert.ok(Date.parse(e.confirmedAt) <= result.evaluationTime,
            'future event ' + e.type + ' @ ' + e.referenceLevel);
    });
});

test('Case 2 structural provenance deterministic', function () {
    assert.deepStrictEqual(finalResult(), finalResult());
});

console.log('----');
console.log('structuralProvenance4hAudit: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
