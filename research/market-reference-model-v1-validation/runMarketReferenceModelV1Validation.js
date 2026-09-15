'use strict';

var fs = require('fs');
var path = require('path');
var validation = require('./marketReferenceModelV1Validation');

var ROOT = path.resolve(__dirname, '../..');
var OUT = path.join(ROOT, 'research-output/market-reference-model-v1-validation');
var HEAD = '8329d9d7aeca3286cde002d01caa8405b42f82f0';

function write(name, value) {
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, name), typeof value === 'string' ? value : validation.stableJson(value));
}

function renderReport(result) {
    var o = result.outputs;
    var p = o.populationParity;
    return '# MARKET_REFERENCE_MODEL_V1_VALIDATION\n\n' +
        'STATUS=PASS\n' +
        'MODEL_VERSION=MARKET_REFERENCE_V1\n' +
        'EQ_USED=false\n' +
        'NEW_MARKET_DATA_FETCHED=false\n' +
        'DETECTORS_RERUN=false\n' +
        'PRODUCTION_CONSUMERS_MIGRATED=false\n\n' +
        '## Current source dataflow\n\n' +
        '- `STRUCTURAL_SWING`: existing confirmed 2L/2R pivot → swing wrapper → Structural Provenance creation record → source adapter. Later role lifecycle is excluded from the immutable reference.\n' +
        '- `DYNAMIC_D_HISTORICAL_EXTREME`: Production close-process Dynamic-D → confirmed process → `SAME_PROCESS_WICK_V1` point → source adapter. Turning Significance is not consulted.\n' +
        '- `PREVIOUS_DAY_EXTREME`: existing deterministic completed UTC-day PDH/PDL construction → source adapter. The reference becomes known only at the next UTC boundary.\n\n' +
        '## Frozen 7-day population parity\n\n' +
        '```json\n' + JSON.stringify(p, null, 2) + '\n```\n\n' +
        '## Registry\n\n' +
        '```json\n' + JSON.stringify(o.registryInvariants, null, 2) + '\n```\n\n' +
        '## Exact-price coexistence\n\n' +
        'Cross-source exact-price groups=' + o.exactPriceCoexistence.crossSourceExactPriceGroups +
        '. Every source-native object remains separately addressable; no exact or near-price merge occurs.\n\n' +
        '## Causality and determinism\n\n' +
        '- Causality violations: ' + o.causalityAudit.causalityViolations + '\n' +
        '- Prefix parity: ' + o.prefixParity.status + ' (' + o.prefixParity.passed + '/' + o.prefixParity.checked + ')\n' +
        '- Future append invariance: ' + o.futureAppendInvariance.status + ' (' + o.futureAppendInvariance.passed + '/' + o.futureAppendInvariance.checked + ')\n' +
        '- Future leak: false\n\n' +
        '## Boundary\n\n' +
        'The implementation creates immutable POINT references and an append-only registry only. It contains no liquidity meaning, interaction state, lifecycle, significance gate, score, threshold, clustering, trade direction, Entry, SL, TP, RR, sizing, notification, or execution integration.\n';
}

function main() {
    var result = validation.buildValidation();
    var o = result.outputs;
    var pass = o.populationParity.status === 'PASS' && o.registryInvariants.status === 'PASS' &&
        o.sourceProvenanceValidation.status === 'PASS' && o.exactPriceCoexistence.status === 'PASS' &&
        o.causalityAudit.status === 'PASS' && o.prefixParity.status === 'PASS' &&
        o.futureAppendInvariance.status === 'PASS';
    if (!pass) throw new Error('MARKET_REFERENCE_MODEL_V1_VALIDATION_FAILED');

    write('population-parity.json', o.populationParity);
    write('registry-invariants.json', o.registryInvariants);
    write('source-provenance-validation.json', o.sourceProvenanceValidation);
    write('exact-price-coexistence.json', o.exactPriceCoexistence);
    write('causality-audit.json', o.causalityAudit);
    write('prefix-parity.json', o.prefixParity);
    write('future-append-invariance.json', o.futureAppendInvariance);
    write('REPORT.md', renderReport(result));

    var files = fs.readdirSync(OUT).filter(function (name) { return name !== 'manifest.json'; }).sort().map(function (name) {
        return { path: name, sha256: validation.sha(fs.readFileSync(path.join(OUT, name))) };
    });
    write('manifest.json', {
        task: 'IMPLEMENT_MARKET_REFERENCE_MODEL_V1',
        headAtStart: HEAD,
        status: 'PASS',
        modelVersion: 'MARKET_REFERENCE_V1',
        sourceTypes: ['STRUCTURAL_SWING', 'DYNAMIC_D_HISTORICAL_EXTREME', 'PREVIOUS_DAY_EXTREME'],
        window: { symbol: 'BTCUSDT', interval: '5m', start: validation.EXPECTED_START, endExclusive: validation.EXPECTED_END },
        identityFixtureLevel: result.baselineFixture.fixture.identityFixtureLevel,
        fixture: {
            path: 'research/market-reference-model-v1-validation/' + validation.FIXTURE_RELATIVE_PATH,
            sha256: result.baselineFixture.sha256,
            derivedFrom: result.baselineFixture.fixture.provenance.derivedFrom,
            sourceArtifactHash: result.baselineFixture.fixture.provenance.sourceArtifactHash
        },
        eqUsed: false,
        newMarketDataFetched: false,
        detectorsRerun: false,
        newThresholds: 0,
        newLlmCalls: 0,
        autoCluster: false,
        autoNearMerge: false,
        autoExactPriceMerge: false,
        referenceScore: false,
        significanceGate: false,
        interactionImplemented: false,
        lifecycleImplemented: false,
        productionConsumersMigrated: false,
        productionCodeChanged: false,
        productionBehaviorChanged: false,
        files: files
    });

    console.log('STATUS=PASS');
    console.log('5M_BAR_COUNT=' + o.populationParity.dataContinuity.barCount);
    console.log('STRUCTURAL_COUNT=' + o.populationParity.counts.STRUCTURAL_SWING);
    console.log('DYNAMIC_D_COUNT=' + o.populationParity.counts.DYNAMIC_D_HISTORICAL_EXTREME);
    console.log('PDH_PDL_COUNT=' + o.populationParity.counts.PREVIOUS_DAY_EXTREME);
    console.log('RAW_TOTAL=' + o.populationParity.rawTotal);
    console.log('IDENTITY_PARITY=' + o.populationParity.status);
    console.log('PREFIX_PARITY=' + o.prefixParity.status + ' (' + o.prefixParity.passed + '/' + o.prefixParity.checked + ')');
    console.log('FUTURE_LEAK=' + o.futureAppendInvariance.futureLeak);
    console.log('CAUSALITY_VIOLATIONS=' + o.causalityAudit.causalityViolations);
}

if (require.main === module) {
    try { main(); } catch (error) { console.error(error.stack || error.message); process.exit(1); }
}

module.exports = { main: main, renderReport: renderReport };
