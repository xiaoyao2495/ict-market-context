'use strict';

var assert = require('assert');
var diagnostic = require('../scripts/diagnoseDailyBiasMss');
var structuralEventReference = require('../ai/structuralEventReference');

var passed = 0;
function test(name, fn) {
    try {
        fn();
        passed++;
        console.log('PASS  ' + name);
    } catch (error) {
        console.error('FAIL  ' + name + ': ' + error.message);
        throw error;
    }
}

var events = [{
    type: 'STRUCTURAL_MSS',
    direction: 'BEARISH',
    referenceLevel: 77039,
    eventTime: '2026-08-23T15:00:00.000Z',
    confirmedAt: '2026-08-23T15:59:59.999Z'
}];

test('authoritative MSS event ID reference is valid', function () {
    var id = structuralEventReference.eventId(events[0]);
    var out = diagnostic.buildComparison({ delivery: {
        referencedStructuralEventIds: [id]
    } }, { structuralEvents: events });
    assert.deepStrictEqual(out.unknownReferences, []);
    assert.strictEqual(out.authoritativeLatestMss.eventId, id);
    assert.strictEqual(out.diagnosis, 'STRUCTURAL_EVENT_REFERENCES_VALID');
});

test('unknown structural event reference is identified', function () {
    var out = diagnostic.buildComparison({ delivery: {
        referencedStructuralEventIds: ['AUTHORITATIVE_STRUCTURAL_EVENT:invented']
    } }, { structuralEvents: events });
    assert.strictEqual(out.unknownReferences.length, 1);
    assert.strictEqual(out.diagnosis, 'UNKNOWN_AUTHORITATIVE_STRUCTURAL_EVENT_REFERENCE');
});

test('empty references do not recreate or omit deterministic facts', function () {
    var out = diagnostic.buildComparison({ delivery: {
        referencedStructuralEventIds: []
    } }, { structuralEvents: events });
    assert.strictEqual(out.authoritativeMssCount, 1);
    assert.strictEqual(out.referencedStructuralEventCount, 0);
    assert.strictEqual(out.diagnosis, 'STRUCTURAL_EVENT_REFERENCES_VALID');
});

test('production invented 76510 legacy MSS is classified as forbidden contract', function () {
    var out = diagnostic.buildComparison({ delivery: { mss: [{
        type: 'BEARISH', brokenSwingPrice: 76510,
        breakTime: '2026-08-23T04:00:00.000Z'
    }], referencedStructuralEventIds: [] } }, { structuralEvents: events });
    assert.strictEqual(out.legacyMssFieldPresent, true);
    assert.strictEqual(out.diagnosis, 'LEGACY_AI_MSS_FIELD_FORBIDDEN');
});

test('future safety reports candle or event beyond evaluationTime', function () {
    var evaluationTime = Date.parse('2026-08-23T15:59:59.999Z');
    var out = diagnostic.futureLeakDetails({
        candles: [{ closeTime: evaluationTime + 1 }],
        marketFacts: { structuralEvents: [{
            type: 'STRUCTURAL_MSS', confirmedAt: '2026-08-23T16:00:00.000Z'
        }] }
    }, evaluationTime);
    assert.strictEqual(out.length, 2);
});

console.log('dailyBiasMssDiagnostic: ' + passed + ' passed, 0 failed');
