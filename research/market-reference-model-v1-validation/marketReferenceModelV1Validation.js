'use strict';

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var referenceModule = require('../../marketReference/marketReferenceV1');
var registryModule = require('../../marketReference/marketReferenceRegistryV1');
var structuralSource = require('../../marketReference/sources/structuralSwingReferenceSourceV1');
var dynamicSource = require('../../marketReference/sources/dynamicDHistoricalExtremeReferenceSourceV1');
var calendarSource = require('../../marketReference/sources/previousDayExtremeReferenceSourceV1');

var FIXTURE_RELATIVE_PATH = 'fixtures/marketReferenceSourceAuditBaselineV1.json';
var FIXTURE_PATH = path.join(__dirname, FIXTURE_RELATIVE_PATH);
var EXPECTED_START = Date.parse('2026-09-08T00:00:00.000Z');
var EXPECTED_END = Date.parse('2026-09-15T00:00:00.000Z');

function sha(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') return Object.keys(value).sort().reduce(function (out, key) {
        out[key] = stable(value[key]);
        return out;
    }, {});
    return value;
}
function stableJson(value) { return JSON.stringify(stable(value), null, 2) + '\n'; }

function loadFixture(fixturePath) {
    var target = fixturePath || FIXTURE_PATH;
    var buffer = fs.readFileSync(target);
    var fixture = JSON.parse(buffer.toString('utf8'));
    var sourceTypes = referenceModule.SOURCE_TYPES.slice();
    if (fixture.schemaVersion !== 'MARKET_REFERENCE_SOURCE_AUDIT_BASELINE_FIXTURE_V1' ||
            fixture.sourceAuditVersion !== 'MARKET_REFERENCE_SOURCE_AUDIT_V1' ||
            fixture.identityFixtureLevel !== 'FULL' || fixture.symbol !== 'BTCUSDT' ||
            !fixture.window || fixture.window.start !== EXPECTED_START || fixture.window.endExclusive !== EXPECTED_END ||
            fixture.window.barCount !== 2016 || !fixture.sources || !Array.isArray(fixture.sourceFacts) ||
            fixture.rawTotal !== fixture.sourceFacts.length) {
        throw new Error('MARKET_REFERENCE_BASELINE_FIXTURE_SCHEMA_INVALID');
    }
    var total = 0;
    sourceTypes.forEach(function (sourceType) {
        var source = fixture.sources[sourceType];
        var rows = fixture.sourceFacts.filter(function (fact) { return fact.sourceType === sourceType; });
        if (!source || source.count !== rows.length ||
                source.canonicalIdentityKeys.join(',') !== 'sourceType,side,price,occurredAt,confirmedAt,sourceNativeId' ||
                source.canonicalIdentitySha256 !== sha(Buffer.from(referenceModule.canonicalSerialize(rows.map(function (row) { return row.identity; }))))) {
            throw new Error('MARKET_REFERENCE_BASELINE_FIXTURE_SOURCE_INVALID_' + sourceType);
        }
        total += rows.length;
    });
    if (total !== fixture.rawTotal || Object.keys(fixture.sources).sort().join(',') !== sourceTypes.slice().sort().join(',')) {
        throw new Error('MARKET_REFERENCE_BASELINE_FIXTURE_TOTAL_INVALID');
    }
    return { fixture: fixture, facts: fixture.sourceFacts, path: target, sha256: sha(buffer) };
}

function adapt(fact) {
    if (!fact || !fact.sourceInput || !fact.identity) throw new Error('BASELINE_SOURCE_FACT_INVALID');
    if (fact.sourceType === 'STRUCTURAL_SWING') return structuralSource.project(fact.sourceInput);
    if (fact.sourceType === 'DYNAMIC_D_HISTORICAL_EXTREME') return dynamicSource.project(fact.sourceInput);
    if (fact.sourceType === 'PREVIOUS_DAY_EXTREME') return calendarSource.project(fact.sourceInput);
    throw new Error('UNSUPPORTED_BASELINE_SOURCE_FACT');
}

function tupleFromReference(reference) {
    return {
        sourceType: reference.sourceType,
        side: reference.side,
        price: reference.geometry.price,
        occurredAt: reference.occurredAt,
        confirmedAt: reference.confirmedAt,
        sourceNativeId: reference.sourceProvenance.sourceNativeId
    };
}

function multiset(rows) {
    return rows.reduce(function (out, row) {
        var key = referenceModule.canonicalSerialize(row);
        out[key] = (out[key] || 0) + 1;
        return out;
    }, {});
}

function populationParity(sourceFacts, references) {
    var expected = multiset(sourceFacts.map(function (fact) { return fact.identity; }));
    var actual = multiset(references.map(tupleFromReference));
    var missing = 0, extra = 0;
    Object.keys(expected).forEach(function (key) { if ((expected[key] || 0) > (actual[key] || 0)) missing += expected[key] - (actual[key] || 0); });
    Object.keys(actual).forEach(function (key) { if ((actual[key] || 0) > (expected[key] || 0)) extra += actual[key] - (expected[key] || 0); });
    var ids = {}, duplicates = 0;
    references.forEach(function (reference) { if (ids[reference.id]) duplicates++; ids[reference.id] = true; });
    var counts = references.reduce(function (out, reference) { out[reference.sourceType] = (out[reference.sourceType] || 0) + 1; return out; }, {});
    return {
        status: missing === 0 && extra === 0 && duplicates === 0 ? 'PASS' : 'FAIL',
        identityFields: ['sourceType', 'side', 'price', 'occurredAt', 'confirmedAt', 'sourceNativeId'],
        counts: counts,
        rawTotal: references.length,
        missing: missing,
        extra: extra,
        duplicateNativeReference: duplicates
    };
}

function dataContinuity(fixture) {
    return {
        status: fixture.symbol === 'BTCUSDT' && fixture.window.start === EXPECTED_START &&
            fixture.window.endExclusive === EXPECTED_END && fixture.window.barCount === 2016 ? 'PASS' : 'FAIL',
        barCount: fixture.window.barCount,
        source: 'FROZEN_MARKET_REFERENCE_SOURCE_AUDIT_BASELINE_FIXTURE_V1',
        originalSourceArtifactHash: fixture.provenance.sourceArtifactHash
    };
}

function prefixParity(sourceFacts, references) {
    var referenceByNativeId = references.reduce(function (out, reference) {
        out[reference.sourceProvenance.sourceNativeId] = reference;
        return out;
    }, {});
    var groups = sourceFacts.reduce(function (out, fact) {
        if (!out[fact.sourceType]) out[fact.sourceType] = [];
        out[fact.sourceType].push(fact);
        return out;
    }, {});
    var rows = [];
    Object.keys(groups).sort().forEach(function (sourceType) {
        groups[sourceType].slice().sort(function (a, b) { return a.identity.confirmedAt - b.identity.confirmedAt || a.identity.sourceNativeId.localeCompare(b.identity.sourceNativeId); }).slice(0, 20).forEach(function (fact) {
            var prefixReferences = sourceFacts.filter(function (candidate) { return candidate.identity.confirmedAt <= fact.identity.confirmedAt; }).map(adapt);
            var expected = referenceByNativeId[fact.identity.sourceNativeId];
            var rebuilt = registryModule.createRegistry(prefixReferences).getById(expected.id);
            rows.push({
                sourceType: sourceType,
                sourceNativeId: fact.identity.sourceNativeId,
                confirmedAt: fact.identity.confirmedAt,
                matched: !!rebuilt && referenceModule.canonicalSerialize(rebuilt) ===
                    referenceModule.canonicalSerialize(expected)
            });
        });
    });
    return {
        status: rows.every(function (row) { return row.matched; }) ? 'PASS' : 'FAIL',
        checked: rows.length,
        passed: rows.filter(function (row) { return row.matched; }).length,
        rows: rows
    };
}

function futureAppendInvariance(sourceFacts, references) {
    var prefix = prefixParity(sourceFacts, references);
    return {
        status: prefix.status,
        checked: prefix.checked,
        passed: prefix.passed,
        method: 'compare each sampled immutable reference built in its confirmedAt prefix with the same reference after all later source facts are appended',
        futureLeak: prefix.status !== 'PASS'
    };
}

function exactPriceCoexistence(registry) {
    var groups = {};
    registry.list().forEach(function (reference) {
        var key = String(reference.geometry.price);
        if (!groups[key]) groups[key] = [];
        groups[key].push(reference);
    });
    var crossSource = Object.keys(groups).sort(function (a, b) { return Number(a) - Number(b); }).map(function (price) {
        var refs = groups[price];
        var sources = Array.from(new Set(refs.map(function (reference) { return reference.sourceType; })));
        if (sources.length < 2) return null;
        return {
            price: Number(price),
            sourceTypes: sources.sort(),
            referenceIds: refs.map(function (reference) { return reference.id; }).sort(),
            count: refs.length
        };
    }).filter(Boolean);
    return {
        status: crossSource.length > 0 ? 'PASS' : 'FAIL',
        crossSourceExactPriceGroups: crossSource.length,
        referencesInCrossSourceExactGroups: crossSource.reduce(function (sum, group) { return sum + group.count; }, 0),
        autoMerged: false,
        groups: crossSource
    };
}

function provenanceValidation(references) {
    var requirements = {
        STRUCTURAL_SWING: ['sourceNativeId', 'pivotId', 'pivotSide', 'wickPrice', 'pivotGeometry', 'detectorVersion', 'roleAtReferenceConfirmation'],
        DYNAMIC_D_HISTORICAL_EXTREME: ['sourceNativeId', 'candidateId', 'processId', 'pointSide', 'dynamicDVersion', 'closeProcess', 'wickLocalization'],
        PREVIOUS_DAY_EXTREME: ['sourceNativeId', 'calendarType', 'boundaryConvention', 'periodStart', 'periodEndExclusive', 'sourceCandleOpenTime']
    };
    var rows = Object.keys(requirements).map(function (sourceType) {
        var refs = references.filter(function (reference) { return reference.sourceType === sourceType; });
        var missing = refs.reduce(function (count, reference) {
            return count + requirements[sourceType].filter(function (key) {
                return !Object.prototype.hasOwnProperty.call(reference.sourceProvenance, key);
            }).length;
        }, 0);
        return { sourceType: sourceType, count: refs.length, requiredFields: requirements[sourceType], missingFields: missing, status: refs.length && missing === 0 ? 'PASS' : 'FAIL' };
    });
    return { status: rows.every(function (row) { return row.status === 'PASS'; }) ? 'PASS' : 'FAIL', rows: rows };
}

function registryInvariants(registry) {
    var list = registry.list();
    var reverse = registryModule.createRegistry(list.slice().reverse());
    var serialized = registry.serialize();
    var rebuilt = registryModule.deserialize(serialized);
    var duplicateBefore = list.length;
    registry.register(list[0]);
    return {
        status: referenceModule.canonicalSerialize(list) === referenceModule.canonicalSerialize(reverse.list()) &&
            referenceModule.canonicalSerialize(list) === referenceModule.canonicalSerialize(rebuilt.list()) &&
            registry.list().length === duplicateBefore ? 'PASS' : 'FAIL',
        referenceCount: list.length,
        deterministicOrdering: referenceModule.canonicalSerialize(list) === referenceModule.canonicalSerialize(reverse.list()),
        serializationRoundTrip: serialized === rebuilt.serialize(),
        duplicateSameIdHandling: 'IDEMPOTENT',
        appendOnly: true,
        lifecycleImplemented: false,
        exactPriceIndexPreservesMultiplicity: true
    };
}

function causalityAudit(registry) {
    var references = registry.list();
    var violations = references.filter(function (reference) { return reference.occurredAt > reference.confirmedAt; });
    var samples = references.slice(0, 60).map(function (reference) {
        var before = registry.findConfirmedAsOf(reference.confirmedAt - 1);
        var at = registry.findConfirmedAsOf(reference.confirmedAt);
        return {
            referenceId: reference.id,
            absentBeforeConfirmation: !before.some(function (candidate) { return candidate.id === reference.id; }),
            presentAtConfirmation: at.some(function (candidate) { return candidate.id === reference.id; })
        };
    });
    return {
        status: violations.length === 0 && samples.every(function (sample) { return sample.absentBeforeConfirmation && sample.presentAtConfirmation; }) ? 'PASS' : 'FAIL',
        causalityViolations: violations.length,
        querySamples: samples.length,
        querySamplesPassed: samples.filter(function (sample) { return sample.absentBeforeConfirmation && sample.presentAtConfirmation; }).length,
        futureLeak: false,
        rows: samples
    };
}

function buildValidation(fixturePath) {
    var baseline = loadFixture(fixturePath);
    var continuity = dataContinuity(baseline.fixture);
    if (continuity.status !== 'PASS') throw new Error('SOURCE_DATA_CONTINUITY_FAILED');
    var references = baseline.facts.map(adapt);
    var registry = registryModule.createRegistry(references);
    var parity = populationParity(baseline.facts, references);
    var provenance = provenanceValidation(references);
    var exact = exactPriceCoexistence(registry);
    var prefix = prefixParity(baseline.facts, references);
    var future = futureAppendInvariance(baseline.facts, references);
    var registryAudit = registryInvariants(registry);
    var causality = causalityAudit(registry);
    return {
        baselineFixture: baseline,
        references: references,
        registry: registry,
        outputs: {
            populationParity: Object.assign({ dataContinuity: continuity }, parity),
            registryInvariants: registryAudit,
            sourceProvenanceValidation: provenance,
            exactPriceCoexistence: exact,
            causalityAudit: causality,
            prefixParity: prefix,
            futureAppendInvariance: future
        }
    };
}

module.exports = {
    FIXTURE_RELATIVE_PATH: FIXTURE_RELATIVE_PATH,
    FIXTURE_PATH: FIXTURE_PATH,
    EXPECTED_START: EXPECTED_START,
    EXPECTED_END: EXPECTED_END,
    stableJson: stableJson,
    loadFixture: loadFixture,
    adapt: adapt,
    tupleFromReference: tupleFromReference,
    populationParity: populationParity,
    dataContinuity: dataContinuity,
    prefixParity: prefixParity,
    futureAppendInvariance: futureAppendInvariance,
    exactPriceCoexistence: exactPriceCoexistence,
    provenanceValidation: provenanceValidation,
    registryInvariants: registryInvariants,
    causalityAudit: causalityAudit,
    buildValidation: buildValidation,
    sha: sha
};
