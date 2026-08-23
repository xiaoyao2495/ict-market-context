'use strict';

var assert = require('assert');
var diagnostic = require('../scripts/diagnoseDailyBiasMss');

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

test('exact latest MSS echo passes every field', function () {
    var out = diagnostic.buildComparison({ delivery: { mss: [{
        type: 'BEARISH', brokenSwingPrice: 77039,
        breakTime: '2026-08-23T15:00:00.000Z'
    }] } }, { structuralEvents: events });
    assert.strictEqual(out.latestAuthoritativeIncluded, true);
    assert.strictEqual(out.aiMssComparisons[0].againstLatest.exactLatestMatch, true);
    assert.strictEqual(out.diagnosis, 'MSS_ECHO_VALID');
});

test('confirmedAt used as breakTime is identified explicitly', function () {
    var out = diagnostic.buildComparison({ delivery: { mss: [{
        type: 'BEARISH', brokenSwingPrice: 77039,
        breakTime: '2026-08-23T15:59:59.999Z'
    }] } }, { structuralEvents: events });
    var fields = out.aiMssComparisons[0].againstLatest;
    assert.strictEqual(fields.directionMatch, true);
    assert.strictEqual(fields.priceMatch, true);
    assert.strictEqual(fields.eventTimeMatch, false);
    assert.strictEqual(fields.confirmedAtUsedInstead, true);
    assert.strictEqual(out.diagnosis, 'AI_MSS_FIELD_MISMATCH_OR_INVENTED_EVENT');
});

test('price and direction mismatches remain separate diagnostics', function () {
    var out = diagnostic.buildComparison({ delivery: { mss: [{
        type: 'BULLISH', brokenSwingPrice: 77100,
        breakTime: '2026-08-23T15:00:00.000Z'
    }] } }, { structuralEvents: events });
    var fields = out.aiMssComparisons[0].againstLatest;
    assert.strictEqual(fields.directionMatch, false);
    assert.strictEqual(fields.priceMatch, false);
    assert.strictEqual(fields.eventTimeMatch, true);
});

test('omitted latest authoritative MSS is classified', function () {
    var out = diagnostic.buildComparison({ delivery: { mss: [] } }, {
        structuralEvents: events
    });
    assert.strictEqual(out.latestAuthoritativeIncluded, false);
    assert.strictEqual(out.diagnosis, 'AI_OMITTED_LATEST_AUTHORITATIVE_MSS');
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
