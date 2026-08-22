/**
 * Offline runner for 4H audit-only Structural Provenance V1.
 *
 * Usage:
 *   DEEPSEEK_CASE_IDXS=409 node scripts/auditStructuralProvenance4h.js
 *
 * 只读本地 klines；不加载 DeepSeek client，不构造/修改 Prompt，不调用 API。
 */
var fs = require('fs');
var path = require('path');
var auditPivots = require('../ai/auditPivots');
var auditMarketFacts = require('../ai/auditMarketFacts');
var structural = require('../ai/auditStructuralProvenance');

var KLINES_FILE = path.join('outputs', 'deepseek-4h-bias', 'klines_4h.json');

function parseSingleIdx() {
    var raw = process.env.DEEPSEEK_CASE_IDXS;
    var values = (raw || '').split(',').map(function (x) {
        return parseInt(x.trim(), 10);
    }).filter(function (x) { return isFinite(x) && x >= 0; });
    if (values.length !== 1) {
        throw new Error('必须设置唯一 DEEPSEEK_CASE_IDXS，例如 409');
    }
    return values[0];
}

function findOne(arr, predicate, label) {
    var x = arr.filter(predicate)[0];
    if (!x) throw new Error('Case regression 缺少 ' + label);
    return x;
}

function run() {
    var idx = parseSingleIdx();
    var cached = JSON.parse(fs.readFileSync(KLINES_FILE, 'utf8'));
    var candles = cached.candles || [];
    if (idx >= candles.length) throw new Error('DEEPSEEK_CASE_IDXS 越界 ' + idx);

    var pivots = auditPivots.detectPivots(candles, idx, {
        left: 2, right: 2, window: 120
    });
    var facts = auditMarketFacts.computeMarketFacts(candles, idx, pivots, {
        deliveryHintEnabled: true
    });
    var result = structural.computeStructuralProvenance(candles, idx, pivots, {
        breaks: facts.breaks
    });

    var s71382 = findOne(result.protectedSwings, function (x) {
        return x.price === 71382.1;
    }, '71382.1 protected swing');
    var s72451 = findOne(result.protectedSwings, function (x) {
        return x.price === 72451.9;
    }, '72451.9 protected swing');
    var firstBearishMss = result.structuralEvents.filter(function (x) {
        return x.type === 'STRUCTURAL_MSS' && x.direction === 'BEARISH';
    }).sort(function (a, b) {
        return Date.parse(a.confirmedAt) - Date.parse(b.confirmedAt);
    }).filter(function (x) {
        return Date.parse(x.confirmedAt) >= Date.parse('2026-04-12T00:00:00.000Z');
    })[0] || null;
    var continuation71259 = result.structuralEvents.filter(function (x) {
        return x.type === 'CONTINUATION' && x.referenceLevel === 71259;
    })[0] || null;

    var case2Pass = s71382.role === 'SUPERSEDED_PROTECTED_LOW' &&
        s71382.supportedProducedHigh === 73450 &&
        s71382.structuralMssReference === false &&
        s72451.role === 'ACTIVE_PROTECTED_LOW' &&
        s72451.parentStructuralLevel === 73450 &&
        s72451.bosClose === 73635.9 &&
        s72451.supportedProducedHigh === 73773.4 &&
        s72451.protectedConfirmedAt === '2026-04-11T23:59:59.999Z' &&
        firstBearishMss && firstBearishMss.referenceLevel === 72451.9 &&
        continuation71259 && continuation71259.direction === 'BEARISH' &&
        result.futureLeakViolations.length === 0;

    var artifact = {
        symbol: 'BTCUSDT',
        timeframe: '4h',
        caseIndex: idx,
        evaluationTime: new Date(candles[idx].closeTime).toISOString(),
        source: KLINES_FILE,
        deepSeekApiCalled: false,
        params: result.params,
        protectedSwings: result.protectedSwings,
        pendingProvenances: result.pendingProvenances,
        penetrations: result.penetrations,
        structuralEvents: result.structuralEvents,
        structuralState: result.structuralState,
        diagnostics: {
            CASE2_PROVENANCE_PASS: case2Pass,
            FIRST_BEARISH_MSS_REFERENCE: firstBearishMss ? firstBearishMss.referenceLevel : null,
            FUTURE_LEAK_VIOLATIONS: result.futureLeakViolations
        }
    };

    var outFile = path.join('outputs', 'deepseek-4h-bias',
        'structural-provenance-v1_case_idx' + idx + '.json');
    fs.writeFileSync(outFile, JSON.stringify(artifact, null, 2));
    console.log(JSON.stringify({
        output: outFile,
        evaluationTime: artifact.evaluationTime,
        diagnostics: artifact.diagnostics,
        protectedSwingCount: artifact.protectedSwings.length,
        structuralEventCount: artifact.structuralEvents.length
    }, null, 2));
    if (!case2Pass) process.exitCode = 1;
    return artifact;
}

if (require.main === module) run();

module.exports = { run: run, parseSingleIdx: parseSingleIdx };
