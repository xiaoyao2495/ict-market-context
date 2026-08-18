/**
 * conflictDetector / biasScorer / biasEngine / biasExplanation 单元测试
 */
var assert = require('assert');
var conflictDetector = require('../bias/conflictDetector');
var biasScorer = require('../bias/biasScorer');
var biasEngine = require('../bias/biasEngine');
var biasExplanation = require('../bias/biasExplanation');

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

function comp(name, score, available) {
    var c = { score: score, available: available !== undefined ? available : true };
    return c;
}

/* ---------- conflictDetector ---------- */

test('bullish structure + bearish delivery → STRUCTURE_VS_DELIVERY MAJOR', function () {
    var cs = conflictDetector.detectConflicts({
        liquidity: comp('l', 15),
        structure: comp('s', 20),
        location: comp('loc', 0),
        delivery: comp('d', -25)
    }, {});
    assert.strictEqual(cs.length, 1);
    assert.strictEqual(cs[0].type, 'STRUCTURE_VS_DELIVERY');
    assert.strictEqual(cs[0].severity, 'MAJOR');
    assert.deepStrictEqual(cs[0].bullishEvidence, ['STRUCTURE']);
    assert.deepStrictEqual(cs[0].bearishEvidence, ['DELIVERY']);
});

test('bearish structure + bullish delivery → MAJOR', function () {
    var cs = conflictDetector.detectConflicts({
        liquidity: comp('l', 0),
        structure: comp('s', -20),
        location: comp('loc', 0),
        delivery: comp('d', 25)
    }, {});
    assert.strictEqual(cs.length, 1);
    assert.strictEqual(cs[0].severity, 'MAJOR');
});

test('liquidity vs structure → DRAW_VS_STRUCTURE MODERATE', function () {
    var cs = conflictDetector.detectConflicts({
        liquidity: comp('l', -15),
        structure: comp('s', 20),
        location: comp('loc', 0),
        delivery: comp('d', 0)
    }, {});
    var hit = null;
    cs.forEach(function (c) {
        if (c.type === 'DRAW_VS_STRUCTURE') hit = c;
    });
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'MODERATE');
});

test('location vs delivery → LOCATION_VS_DELIVERY MINOR', function () {
    var cs = conflictDetector.detectConflicts({
        liquidity: comp('l', 0),
        structure: comp('s', 0),
        location: comp('loc', 10),
        delivery: comp('d', -25)
    }, {});
    var hit = null;
    cs.forEach(function (c) {
        if (c.type === 'LOCATION_VS_DELIVERY') hit = c;
    });
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'MINOR');
});

test('delivery unavailable → STRUCTURE_VS_DELIVERY 不产生', function () {
    var cs = conflictDetector.detectConflicts({
        liquidity: comp('l', 15),
        structure: comp('s', 20),
        location: comp('loc', 0),
        delivery: comp('d', 0, false) // 无数据
    }, {});
    assert.strictEqual(cs.length, 0);
});

test('NEUTRAL / score=0 不构成 conflict', function () {
    var cs = conflictDetector.detectConflicts({
        liquidity: comp('l', 0),
        structure: comp('s', 0),
        location: comp('loc', 0),
        delivery: comp('d', 0)
    }, {});
    assert.strictEqual(cs.length, 0);
});

/* ---------- biasScorer 五档边界 ---------- */

test('五档方向边界：+35 / +15 / +14.999 / -14.999 / -15 / -35', function () {
    var cfg = require('../config/thresholds');
    assert.strictEqual(biasScorer.directionOf(35, cfg), 'BULLISH');
    assert.strictEqual(biasScorer.directionOf(34.999, cfg), 'LEAN_BULLISH');
    assert.strictEqual(biasScorer.directionOf(15, cfg), 'LEAN_BULLISH');
    assert.strictEqual(biasScorer.directionOf(14.999, cfg), 'NEUTRAL');
    assert.strictEqual(biasScorer.directionOf(-14.999, cfg), 'NEUTRAL');
    assert.strictEqual(biasScorer.directionOf(-15, cfg), 'LEAN_BEARISH');
    assert.strictEqual(biasScorer.directionOf(-34.999, cfg), 'LEAN_BEARISH');
    assert.strictEqual(biasScorer.directionOf(-35, cfg), 'BEARISH');
    assert.strictEqual(biasScorer.directionOf(0, cfg), 'NEUTRAL');
});

test('scoreBias：四分量相加 + clamp', function () {
    var b = biasScorer.scoreBias({
        liquidity: comp('l', 15),
        structure: comp('s', 20),
        location: comp('loc', 10),
        delivery: comp('d', -25)
    }, {});
    assert.strictEqual(b.score, 20);
    assert.strictEqual(b.direction, 'LEAN_BULLISH');
});

test('scoreBias：clamp 到 ±100', function () {
    var b = biasScorer.scoreBias({
        liquidity: comp('l', 100),
        structure: comp('s', 100),
        location: comp('loc', 100),
        delivery: comp('d', 100)
    }, {});
    assert.strictEqual(b.score, 100);
    assert.strictEqual(b.direction, 'BULLISH');
});

test('componentDirection', function () {
    assert.strictEqual(biasScorer.componentDirection(5), 'BULLISH');
    assert.strictEqual(biasScorer.componentDirection(-5), 'BEARISH');
    assert.strictEqual(biasScorer.componentDirection(0), 'NEUTRAL');
});

/* ---------- confidence ---------- */

test('confidence 基础：abs 15 / 35 边界', function () {
    assert.strictEqual(biasEngine.computeConfidence(0, [], 1, {}), 'LOW');
    assert.strictEqual(biasEngine.computeConfidence(14.999, [], 1, {}), 'LOW');
    assert.strictEqual(biasEngine.computeConfidence(15, [], 1, {}), 'MEDIUM');
    assert.strictEqual(biasEngine.computeConfidence(34.999, [], 1, {}), 'MEDIUM');
    assert.strictEqual(biasEngine.computeConfidence(35, [], 1, {}), 'HIGH');
});

test('confidence：1 MAJOR conflict 降 1 级', function () {
    var major = [{ type: 'STRUCTURE_VS_DELIVERY', severity: 'MAJOR' }];
    assert.strictEqual(biasEngine.computeConfidence(35, major, 1, {}), 'MEDIUM');
    assert.strictEqual(biasEngine.computeConfidence(20, major, 1, {}), 'LOW');
});

test('confidence：2 MAJOR conflicts 降 2 级', function () {
    var two = [{ severity: 'MAJOR' }, { severity: 'MAJOR' }];
    assert.strictEqual(biasEngine.computeConfidence(40, two, 1, {}), 'LOW');
});

test('confidence：coverage < 0.5 强制 LOW', function () {
    assert.strictEqual(biasEngine.computeConfidence(50, [], 0.25, {}), 'LOW');
});

test('confidence：coverage < 0.75 最大 MEDIUM', function () {
    assert.strictEqual(biasEngine.computeConfidence(50, [], 0.5, {}), 'MEDIUM');
    assert.strictEqual(biasEngine.computeConfidence(20, [], 0.5, {}), 'MEDIUM');
});

test('confidence：coverage >= 0.75 不限制', function () {
    assert.strictEqual(biasEngine.computeConfidence(50, [], 0.75, {}), 'HIGH');
});

/* ---------- biasEngine 集成 ---------- */

function engineContext(opts) {
    var o = opts || {};
    return {
        symbol: 'BTCUSDT',
        evaluationTime: o.evaluationTime !== undefined ? o.evaluationTime : 100000,
        timeframe: '5m',
        draw: o.draw || { direction: 'BSL' },
        structures: o.structures || {
            '1d': { timeframe: '1d', structure: 'BULLISH' },
            '4h': { timeframe: '4h', structure: 'BULLISH' },
            '1h': { timeframe: '1h', structure: 'NEUTRAL' }
        },
        location: o.location || { zone: 'DISCOUNT', intensity: 'MODERATE', ratio: 0.3 },
        events: o.events || { sweeps: [], mss: [], displacements: [] }
    };
}

test('engine：bullish context（draw BSL + structure bullish + discount）→ BULLISH', function () {
    var ctx = engineContext({
        draw: { direction: 'BSL' },
        location: { zone: 'DISCOUNT', intensity: 'MODERATE', ratio: 0.3 }
    });
    var bias = biasEngine.runBiasEngine(ctx, {});
    assert.strictEqual(bias.components.liquidity.score, 30);
    assert.ok(bias.components.structure.score > 0);
    assert.ok(bias.components.location.score > 0);
    assert.ok(bias.score > 35);
    assert.strictEqual(bias.direction, 'BULLISH');
});

test('engine：bearish context → BEARISH', function () {
    var ctx = engineContext({
        draw: { direction: 'SSL' },
        structures: {
            '1d': { timeframe: '1d', structure: 'BEARISH' },
            '4h': { timeframe: '4h', structure: 'BEARISH' },
            '1h': { timeframe: '1h', structure: 'BEARISH' }
        },
        location: { zone: 'PREMIUM', intensity: 'EXTREME', ratio: 0.9 }
    });
    var bias = biasEngine.runBiasEngine(ctx, {});
    assert.ok(bias.score < -35);
    assert.strictEqual(bias.direction, 'BEARISH');
});

test('engine：用户关键例子 —— HTF bullish + LTF bearish delivery → LEAN_BULLISH + MAJOR conflict + LOW confidence', function () {
    var ctx = engineContext({
        draw: { direction: 'LEAN_BSL' }, // +15
        structures: {
            '1d': { timeframe: '1d', structure: 'BULLISH' },
            '4h': { timeframe: '4h', structure: 'BULLISH' },
            '1h': { timeframe: '1h', structure: 'NEUTRAL' }
        }, // +19.25
        location: { zone: 'DISCOUNT', intensity: 'MODERATE', ratio: 0.3 }, // +10
        events: {
            sweeps: [{ id: 's1', direction: 'BEARISH', confirmedAt: 1000 }],
            mss: [{ id: 'm1', direction: 'BEARISH', confirmedAt: 2000 }],
            displacements: [{ id: 'd1', direction: 'BEARISH', confirmedAt: 3000 }]
        } // 完整 bearish 链 -25
    });
    var bias = biasEngine.runBiasEngine(ctx, {});
    // raw = 15 + 19.25 + 10 - 25 = 19.25 → LEAN_BULLISH
    assert.strictEqual(bias.direction, 'LEAN_BULLISH');
    assert.ok(bias.score > 15 && bias.score < 35);
    // 两个冲突：STRUCTURE_VS_DELIVERY(MAJOR) + LOCATION_VS_DELIVERY(MINOR)
    assert.strictEqual(bias.conflicts.length, 2);
    var majorHit = false;
    bias.conflicts.forEach(function (c) {
        if (c.type === 'STRUCTURE_VS_DELIVERY' && c.severity === 'MAJOR') majorHit = true;
    });
    assert.ok(majorHit);
    assert.strictEqual(bias.confidence, 'LOW'); // 1 MAJOR 降级
    assert.strictEqual(bias.evidenceCoverage.ratio, 1); // 4/4
});

test('engine：draw balanced + bullish structure → NEUTRAL 倾向（liquidity 0）', function () {
    var ctx = engineContext({ draw: { direction: 'BALANCED' } });
    var bias = biasEngine.runBiasEngine(ctx, {});
    assert.strictEqual(bias.components.liquidity.score, 0);
    assert.ok(bias.components.structure.score > 0);
    assert.strictEqual(bias.components.location.score, 0); // draw balanced → location 0
});

test('engine：无 delivery 数据 → coverage 3/4', function () {
    var ctx = engineContext({ events: { sweeps: [], mss: [], displacements: [] } });
    var bias = biasEngine.runBiasEngine(ctx, {});
    assert.strictEqual(bias.components.delivery.available, false);
    assert.strictEqual(bias.evidenceCoverage.available, 3);
    assert.strictEqual(bias.evidenceCoverage.total, 4);
    assert.strictEqual(bias.evidenceCoverage.ratio, 0.75);
});

test('engine：coverage 0.5（delivery 无 + location 无）→ confidence 最大 MEDIUM', function () {
    var ctx = engineContext({
        location: { zone: 'UNKNOWN', intensity: null, ratio: null },
        events: { sweeps: [], mss: [], displacements: [] }
    });
    var bias = biasEngine.runBiasEngine(ctx, {});
    assert.strictEqual(bias.evidenceCoverage.available, 2);
    assert.strictEqual(bias.evidenceCoverage.ratio, 0.5);
    assert.notStrictEqual(bias.confidence, 'HIGH'); // < 0.75 → 最大 MEDIUM
    assert.ok(bias.confidence === 'MEDIUM' || bias.confidence === 'LOW');
});

test('engine：future sweep event 排除（不影响 delivery）', function () {
    var ctx = engineContext({
        evaluationTime: 5000,
        events: {
            sweeps: [{ id: 's1', direction: 'BULLISH', confirmedAt: 9999999999999 }],
            mss: [],
            displacements: []
        }
    });
    var bias = biasEngine.runBiasEngine(ctx, {});
    assert.strictEqual(bias.components.delivery.available, false); // 未来事件被过滤
});

/* ---------- biasExplanation ---------- */

test('explanation：bullish/bearish evidence 正确分类，无重复', function () {
    var ex = biasExplanation.buildExplanation({
        components: {
            liquidity: { score: 15, available: true, reasons: ['LEAN_BSL liquidity draw'] },
            structure: { score: 20, available: true, reasons: ['4h structure bullish'] },
            location: { score: 0, available: true, reasons: ['price at equilibrium'] },
            delivery: { score: -25, available: true, reasons: ['BSL swept', 'bearish displacement'] }
        },
        conflicts: [
            { type: 'STRUCTURE_VS_DELIVERY', severity: 'MAJOR', reason: 'HTF structure bullish while LTF delivery bearish' }
        ]
    });
    assert.strictEqual(ex.bullish.length, 2); // liquidity + structure
    assert.strictEqual(ex.bearish.length, 1); // delivery（reasons 只取第一条）
    assert.strictEqual(ex.neutral.length, 1); // location 0
    assert.strictEqual(ex.conflicts.length, 1);
    assert.strictEqual(ex.conflicts[0].severity, 'MAJOR');
});

test('explanation：unavailable 组件不产生 evidence', function () {
    var ex = biasExplanation.buildExplanation({
        components: {
            liquidity: { score: 15, available: true, reasons: ['x'] },
            structure: { score: 0, available: false, reasons: ['no data'] },
            location: { score: 0, available: false, reasons: ['no range'] },
            delivery: { score: 0, available: false, reasons: ['no events'] }
        },
        conflicts: []
    });
    assert.strictEqual(ex.bullish.length, 1);
    assert.strictEqual(ex.neutral.length, 0); // unavailable 不进 neutral
});

console.log('----');
console.log('bias engine suite: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) {
    process.exit(1);
}
