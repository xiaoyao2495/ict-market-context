'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var path = require('path');
var referenceModule = require('../marketReference/marketReferenceV1');
var registryModule = require('../marketReference/marketReferenceRegistryV1');
var structuralSource = require('../marketReference/sources/structuralSwingReferenceSourceV1');
var dynamicSource = require('../marketReference/sources/dynamicDHistoricalExtremeReferenceSourceV1');
var calendarSource = require('../marketReference/sources/previousDayExtremeReferenceSourceV1');
var validation = require('../research/market-reference-model-v1-validation/marketReferenceModelV1Validation');

var NOW = Date.parse('2026-09-10T00:00:00.000Z');

function structural(side, price, id) {
    return {
        id: id || 'BTCUSDT:5m:STRUCTURAL_SWING:' + side + ':' + (NOW - 600000),
        sourceSwingId: 'BTCUSDT:5m:SWING_' + side + ':' + (NOW - 600000),
        symbol: 'BTCUSDT', timeframe: '5m', side: side, price: price,
        occurredAt: NOW - 600000, confirmedAt: NOW,
        history: [{ role: 'LOCAL_SWING', status: 'CANDIDATE', confirmedAt: NOW, reason: 'CONFIRMED_2L2R_PIVOT' }],
        role: 'BROKEN', status: 'BROKEN'
    };
}

function dynamic(side, price, id) {
    return {
        id: id || 'DYNDW:SAME_PROCESS_WICK_V1:BTCUSDT:5m:' + side + ':' + (NOW - 900000) + ':' + NOW,
        processId: 'DYNDPROC:BTCUSDT:5m:' + side + ':' + (NOW - 1200000) + ':' + NOW,
        symbol: 'BTCUSDT', timeframe: '5m', pointSide: side,
        price: price, priceSource: 'SAME_PROCESS_WICK_EXTREME', localizationMode: 'SAME_PROCESS_WICK_V1',
        occurredAt: NOW - 900000, confirmedAt: NOW,
        selectorPrice: price + (side === 'HIGH' ? -1 : 1), selectorOccurredAt: NOW - 1200000,
        selectorWickPrice: price, localizedExtremeOpenTime: NOW - 900000, localizedExtremePrice: price,
        processStartBarIndex: 100, processEndBarIndex: 140, thetaAtExtreme: 0.003,
        sigma5mAtExtreme: 0.001, sigma1hAtExtreme: 0.00346, floorActive: false,
        state: 'INACTIVE'
    };
}

function calendar(type, price, id) {
    var start = Date.parse('2026-09-09T00:00:00.000Z');
    return {
        id: id || 'BTCUSDT:5m:MARKET_REFERENCE:' + type + ':' + start,
        symbol: 'BTCUSDT', timeframe: '5m', type: type, price: price,
        sourceCandleOpenTime: start + 3600000, periodStart: start,
        confirmedAt: start + 86400000, boundaryConvention: 'UTC'
    };
}

function mutable(reference) { return JSON.parse(referenceModule.canonicalSerialize(reference)); }

test('MarketReference canonical schema is exact, immutable and serializable', function () {
    var ref = structuralSource.project(structural('HIGH', 100));
    assert.deepEqual(Object.keys(ref).sort(), ['confirmedAt', 'geometry', 'id', 'modelVersion', 'occurredAt', 'side', 'sourceProvenance', 'sourceType', 'symbol', 'timeframe']);
    assert.equal(ref.modelVersion, 'MARKET_REFERENCE_V1');
    assert.ok(Object.isFrozen(ref));
    assert.ok(Object.isFrozen(ref.geometry));
    assert.ok(Object.isFrozen(ref.sourceProvenance));
    assert.deepEqual(referenceModule.deserialize(referenceModule.canonicalSerialize(ref)), ref);
});

test('invalid sourceType fails closed', function () {
    var ref = mutable(structuralSource.project(structural('HIGH', 100)));
    ref.sourceType = 'LIQUIDITY';
    assert.throws(function () { referenceModule.assertReference(ref); }, /SOURCE_TYPE_INVALID/);
});

test('invalid side fails closed', function () {
    var ref = mutable(structuralSource.project(structural('HIGH', 100)));
    ref.side = 'LONG';
    assert.throws(function () { referenceModule.assertReference(ref); }, /SIDE_INVALID/);
});

test('invalid geometry and non-finite price fail closed', function () {
    var ref = mutable(structuralSource.project(structural('HIGH', 100)));
    ref.geometry.type = 'ZONE';
    assert.throws(function () { referenceModule.assertReference(ref); }, /GEOMETRY_TYPE_INVALID/);
    ref.geometry.type = 'POINT'; ref.geometry.price = Infinity;
    assert.throws(function () { referenceModule.assertReference(ref); }, /PRICE_INVALID/);
});

test('occurredAt after confirmedAt is rejected', function () {
    var input = structural('HIGH', 100); input.occurredAt = input.confirmedAt + 1;
    assert.throws(function () { structuralSource.project(input); }, /CAUSALITY_INVALID/);
});

test('Structural HIGH maps to BUY_SIDE and LOW maps to SELL_SIDE', function () {
    assert.equal(structuralSource.project(structural('HIGH', 100)).side, 'BUY_SIDE');
    assert.equal(structuralSource.project(structural('LOW', 90)).side, 'SELL_SIDE');
});

test('Dynamic-D HIGH maps to BUY_SIDE and LOW maps to SELL_SIDE', function () {
    assert.equal(dynamicSource.project(dynamic('HIGH', 100)).side, 'BUY_SIDE');
    assert.equal(dynamicSource.project(dynamic('LOW', 90)).side, 'SELL_SIDE');
});

test('PDH maps to BUY_SIDE and PDL maps to SELL_SIDE', function () {
    assert.equal(calendarSource.project(calendar('PDH', 100)).side, 'BUY_SIDE');
    assert.equal(calendarSource.project(calendar('PDL', 90)).side, 'SELL_SIDE');
});

test('BUY_SIDE is not LONG and SELL_SIDE is not SHORT', function () {
    var high = structuralSource.project(structural('HIGH', 100));
    var low = structuralSource.project(structural('LOW', 90));
    assert.notEqual(high.side, 'LONG'); assert.notEqual(low.side, 'SHORT');
    assert.equal(Object.prototype.hasOwnProperty.call(high, 'tradeDirection'), false);
});

test('Dynamic-D adapter requires Production SAME_PROCESS_WICK provenance', function () {
    var point = dynamic('HIGH', 100); point.localizationMode = 'SELECTOR_WICK';
    assert.throws(function () { dynamicSource.project(point); }, /LOCALIZATION_PROVENANCE_INVALID/);
});

test('Previous-day adapter requires completed UTC-day availability', function () {
    var point = calendar('PDH', 100); point.confirmedAt--;
    assert.throws(function () { calendarSource.project(point); }, /COMPLETION_INVALID/);
});

test('source-native identity differs across sources at identical price and time', function () {
    var s = structuralSource.project(structural('HIGH', 100, 'native:same'));
    var dInput = dynamic('HIGH', 100, 'native:same'); dInput.occurredAt = s.occurredAt; dInput.localizedExtremeOpenTime = s.occurredAt;
    var d = dynamicSource.project(dInput);
    assert.notEqual(s.id, d.id);
    assert.equal(s.geometry.price, d.geometry.price);
});

test('same exact price and side from different sources coexist without merge', function () {
    var s = structuralSource.project(structural('HIGH', 100));
    var d = dynamicSource.project(dynamic('HIGH', 100));
    var c = calendarSource.project(calendar('PDH', 100));
    var registry = registryModule.createRegistry([s, d, c]);
    assert.equal(registry.findExactPrice(100).length, 3);
    assert.equal(registry.findExactPriceBySide(100, 'BUY_SIDE').length, 3);
    assert.equal(registry.list().length, 3);
});

test('same id duplicate is idempotent', function () {
    var ref = structuralSource.project(structural('HIGH', 100));
    var registry = registryModule.createRegistry([ref]);
    assert.equal(registry.register(ref), ref);
    assert.equal(registry.list().length, 1);
});

test('registry freezes a valid reconstructed reference before retaining it', function () {
    var reconstructed = mutable(structuralSource.project(structural('HIGH', 100)));
    var registry = registryModule.createRegistry([reconstructed]);
    assert.ok(Object.isFrozen(registry.getById(reconstructed.id)));
    assert.ok(Object.isFrozen(registry.getById(reconstructed.id).sourceProvenance));
});

test('same id with different immutable content is rejected as collision', function () {
    var first = structuralSource.project(structural('HIGH', 100, 'same-native'));
    var second = structuralSource.project(structural('HIGH', 101, 'same-native'));
    var registry = registryModule.createRegistry([first]);
    assert.throws(function () { registry.register(second); }, /ID_COLLISION/);
});

test('registry ordering is deterministic across registration order', function () {
    var refs = [structuralSource.project(structural('HIGH', 100)), dynamicSource.project(dynamic('LOW', 90)), calendarSource.project(calendar('PDH', 110))];
    assert.deepEqual(registryModule.createRegistry(refs).list(), registryModule.createRegistry(refs.slice().reverse()).list());
});

test('registry source, side, as-of, id and exact-price queries work', function () {
    var early = structuralSource.project(structural('HIGH', 100));
    var lateInput = dynamic('LOW', 90); lateInput.confirmedAt += 300000;
    var late = dynamicSource.project(lateInput);
    var registry = registryModule.createRegistry([late, early]);
    assert.equal(registry.getById(early.id), early);
    assert.deepEqual(registry.findBySourceType('STRUCTURAL_SWING'), [early]);
    assert.deepEqual(registry.findBySide('SELL_SIDE'), [late]);
    assert.deepEqual(registry.findConfirmedAsOf(NOW), [early]);
    assert.deepEqual(registry.findExactPrice(100), [early]);
});

test('registry serialization and exact index are restart deterministic', function () {
    var refs = [structuralSource.project(structural('HIGH', 100)), dynamicSource.project(dynamic('HIGH', 100))];
    var before = registryModule.createRegistry(refs);
    var after = registryModule.deserialize(before.serialize());
    assert.equal(after.serialize(), before.serialize());
    assert.equal(after.findExactPrice(100).length, 2);
    assert.deepEqual(after.list().map(function (r) { return r.id; }), before.list().map(function (r) { return r.id; }));
});

test('later Structural role mutation cannot rewrite immutable creation reference', function () {
    var input = structural('HIGH', 100);
    var reference = structuralSource.project(input);
    var bytes = referenceModule.canonicalSerialize(reference);
    input.role = 'ACTIVE_PROTECTED'; input.status = 'ACTIVE_PROTECTED';
    input.history.push({ role: 'BROKEN', status: 'BROKEN', confirmedAt: NOW + 1000, reason: 'FUTURE' });
    assert.equal(referenceModule.canonicalSerialize(reference), bytes);
    assert.equal(Object.prototype.hasOwnProperty.call(reference.sourceProvenance, 'currentRole'), false);
});

var baselineFixture = validation.loadFixture();
var frozenValidation = validation.buildValidation();

test('self-contained baseline fixture has a stable SHA256 and FULL identity level', function () {
    assert.match(baselineFixture.sha256, /^[a-f0-9]{64}$/);
    assert.equal(baselineFixture.fixture.identityFixtureLevel, 'FULL');
    assert.equal(baselineFixture.fixture.rawTotal, baselineFixture.facts.length);
});

test('corrupt fixture source count or identity hash fails validation', function () {
    var directory = fs.mkdtempSync(path.join(require('os').tmpdir(), 'market-reference-fixture-'));
    var target = path.join(directory, 'fixture.json');
    var corrupt = JSON.parse(fs.readFileSync(validation.FIXTURE_PATH, 'utf8'));
    corrupt.sources.STRUCTURAL_SWING.count++;
    fs.writeFileSync(target, JSON.stringify(corrupt));
    try {
        assert.throws(function () { validation.loadFixture(target); }, /FIXTURE_SOURCE_INVALID/);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('frozen 7d data continuity is exactly 2016 bars', function () {
    assert.equal(frozenValidation.outputs.populationParity.dataContinuity.status, 'PASS');
    assert.equal(frozenValidation.outputs.populationParity.dataContinuity.barCount, baselineFixture.fixture.window.barCount);
});

test('full canonical tuple identity parity is 654/654 with zero missing extra duplicate', function () {
    var p = frozenValidation.outputs.populationParity;
    assert.equal(p.status, 'PASS'); assert.equal(p.rawTotal, baselineFixture.fixture.rawTotal);
    assert.equal(p.missing, 0); assert.equal(p.extra, 0); assert.equal(p.duplicateNativeReference, 0);
});

test('source population parity is Structural 582 Dynamic-D 60 PDH/PDL 12', function () {
    var expected = Object.keys(baselineFixture.fixture.sources).reduce(function (out, sourceType) {
        out[sourceType] = baselineFixture.fixture.sources[sourceType].count;
        return out;
    }, {});
    assert.deepEqual(frozenValidation.outputs.populationParity.counts, expected);
});

test('all three source provenance contracts are lossless enough to trace native identities', function () {
    assert.equal(frozenValidation.outputs.sourceProvenanceValidation.status, 'PASS');
});

test('cross-source exact-price references coexist in the frozen population', function () {
    var exact = frozenValidation.outputs.exactPriceCoexistence;
    assert.equal(exact.status, 'PASS'); assert.ok(exact.crossSourceExactPriceGroups > 0); assert.equal(exact.autoMerged, false);
});

test('findConfirmedAsOf has zero causal leakage', function () {
    var audit = frozenValidation.outputs.causalityAudit;
    assert.equal(audit.status, 'PASS'); assert.equal(audit.causalityViolations, 0); assert.equal(audit.querySamplesPassed, audit.querySamples);
});

test('prefix parity checks 20 references per source, or all when fewer', function () {
    var prefix = frozenValidation.outputs.prefixParity;
    assert.equal(prefix.status, 'PASS'); assert.equal(prefix.checked, 52); assert.equal(prefix.passed, 52);
});

test('future source-fact append leaves confirmed immutable core unchanged', function () {
    var future = frozenValidation.outputs.futureAppendInvariance;
    assert.equal(future.status, 'PASS'); assert.equal(future.checked, 52); assert.equal(future.futureLeak, false);
});

test('model code exposes no interaction lifecycle score threshold or production consumer integration', function () {
    var root = path.resolve(__dirname, '..');
    var files = [
        'marketReference/marketReferenceV1.js',
        'marketReference/marketReferenceRegistryV1.js',
        'marketReference/sources/structuralSwingReferenceSourceV1.js',
        'marketReference/sources/dynamicDHistoricalExtremeReferenceSourceV1.js',
        'marketReference/sources/previousDayExtremeReferenceSourceV1.js'
    ];
    var source = files.map(function (file) { return fs.readFileSync(path.join(root, file), 'utf8'); }).join('\n');
    assert.doesNotMatch(source, /require\(['"]\.\.\/live|require\(['"]\.\.\/execution|require\(['"]\.\.\/entry|scripts\/live/);
    assert.doesNotMatch(source, /qualityScore\s*:|liquidityScore\s*:|importanceScore\s*:|distanceThreshold\s*:/);
});

test('default validation code has no old uncommitted research runtime dependency', function () {
    var root = path.resolve(__dirname, '..');
    var files = [
        'research/market-reference-model-v1-validation/marketReferenceModelV1Validation.js',
        'research/market-reference-model-v1-validation/runMarketReferenceModelV1Validation.js',
        'test/marketReferenceModelV1.test.js'
    ];
    var source = files.map(function (file) { return fs.readFileSync(path.join(root, file), 'utf8'); }).join('\n');
    var forbidden = [
        'research-output/market-reference-' + 'source-audit-v1',
        'research/market-reference-' + 'source-audit-v1',
        'market-reference-' + 'source-synthesis-v1',
        'liquidity-data-' + 'observability-audit-v1'
    ];
    forbidden.forEach(function (value) { assert.equal(source.indexOf(value), -1); });
});
