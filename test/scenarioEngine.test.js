/**
 * Scenario / Action Engine 测试（Phase 8）
 *
 * 覆盖：
 *   NEUTRAL / WAIT / WATCH / SETUP_READY / CONFLICT
 *   opposite AMD 分流、blocking conflict、显式条件门控
 *   Scenario Score 分项、quality buckets、cap
 *   Invalidation、Explanation、replay safety（future AMD 状态）
 */
var assert = require('assert');
var scenarioEngine = require('../scenario/scenarioEngine');
var actionEngine = require('../scenario/actionEngine');
var scenarioScorer = require('../scenario/scenarioScorer');
var invalidationEngine = require('../scenario/invalidationEngine');
var scenarioExplanation = require('../scenario/scenarioExplanation');

var tests = [];
var only = null;

function test(name, fn) {
    tests.push({ name: name, fn: fn });
}

function runTest(t) {
    try {
        t.fn();
        console.log('PASS  ' + t.name);
        return true;
    } catch (e) {
        console.log('FAIL  ' + t.name);
        console.log('      ' + (e && e.message ? e.message : e));
        if (only && t.name === only) {
            console.log(e && e.stack);
        }
        return false;
    }
}

/* ---------------- helpers ---------------- */

function bias(dir, confidence, conflicts) {
    return {
        direction: dir,
        score: dir === 'BULLISH' || dir === 'LEAN_BULLISH' ? 25 : dir === 'BEARISH' || dir === 'LEAN_BEARISH' ? -25 : 0,
        confidence: confidence || 'MEDIUM',
        components: {},
        conflicts: conflicts || []
    };
}

function draw(direction) {
    return { direction: direction, imbalance: 0, bsl: {}, ssl: {} };
}

function amd(state, direction, confirmedAt) {
    return {
        state: state,
        direction: direction || null,
        score: 0,
        confirmedAt: confirmedAt !== undefined ? confirmedAt : 1000,
        accumulation: null,
        manipulation: null,
        distribution: null
    };
}

function delivery(direction, score, available) {
    return {
        direction: direction || 'NEUTRAL',
        score: score || 0,
        available: available !== false
    };
}

function major(type) {
    return { type: type || 'STRUCTURE_VS_DELIVERY', severity: 'MAJOR' };
}

function moderate(type) {
    return { type: type || 'DRAW_VS_STRUCTURE', severity: 'MODERATE' };
}

function minor(type) {
    return { type: type || 'LOCATION_VS_DELIVERY', severity: 'MINOR' };
}

function run(input, opts) {
    return scenarioEngine.runScenarioEngine(input, opts || {});
}

/* ================= NEUTRAL ================= */

test('NEUTRAL：neutral bias → scenario NEUTRAL / action WAIT', function () {
    var r = run({
        symbol: 'BTCUSDT', evaluationTime: 1000,
        bias: bias('NEUTRAL', 'MEDIUM'),
        draw: draw('BALANCED'),
        amd: amd('SEARCHING', null),
        alignment: 'UNCONFIRMED',
        conflicts: [],
        delivery: delivery('NEUTRAL', 0, false)
    });
    assert.strictEqual(r.scenarioState, 'NEUTRAL');
    assert.strictEqual(r.action, 'WAIT');
    assert.strictEqual(r.direction, 'NEUTRAL');
});

test('NEUTRAL：neutral + LOW confidence + MAJOR conflict → CONFLICT / NO_TRADE', function () {
    var r = run({
        symbol: 'BTCUSDT', evaluationTime: 1000,
        bias: bias('NEUTRAL', 'LOW'),
        draw: draw('BALANCED'),
        amd: amd('SEARCHING', null),
        alignment: 'UNCONFIRMED',
        conflicts: [major()],
        delivery: delivery('NEUTRAL', 0, false)
    });
    assert.strictEqual(r.scenarioState, 'CONFLICT');
    assert.strictEqual(r.action, 'NO_TRADE');
    assert.strictEqual(r.block, true);
});

/* ================= WAIT ================= */

test('WAIT：bullish bias + bullish draw + 无 AMD → BULLISH_WAIT / WAIT', function () {
    var r = run({
        symbol: 'BTCUSDT', evaluationTime: 1000,
        bias: bias('LEAN_BULLISH', 'MEDIUM'),
        draw: draw('LEAN_BSL'),
        amd: amd('SEARCHING', null),
        alignment: 'UNCONFIRMED',
        conflicts: [],
        delivery: delivery('NEUTRAL', 0, false)
    });
    assert.strictEqual(r.scenarioState, 'BULLISH_WAIT');
    assert.strictEqual(r.action, 'WAIT');
});

test('WAIT：bearish bias + bearish draw + 无 AMD → BEARISH_WAIT / WAIT', function () {
    var r = run({
        symbol: 'BTCUSDT', evaluationTime: 1000,
        bias: bias('BEARISH', 'MEDIUM'),
        draw: draw('SSL'),
        amd: amd('SEARCHING', null),
        alignment: 'UNCONFIRMED',
        conflicts: [],
        delivery: delivery('NEUTRAL', 0, false)
    });
    assert.strictEqual(r.scenarioState, 'BEARISH_WAIT');
    assert.strictEqual(r.action, 'WAIT');
});

test('WAIT：bullish bias + opposite bearish AMD + HIGH confidence → BULLISH_WAIT（retracement 处理）', function () {
    var r = run({
        symbol: 'BTCUSDT', evaluationTime: 1000,
        bias: bias('BULLISH', 'HIGH'),
        draw: draw('BSL'),
        amd: amd('MANIPULATION_CONFIRMED', 'BEARISH'),
        alignment: 'OPPOSITE',
        conflicts: [],
        delivery: delivery('BEARISH', -25, true)
    });
    assert.strictEqual(r.scenarioState, 'BULLISH_WAIT');
    assert.strictEqual(r.action, 'WAIT');
    assert.ok(r.reasons.some(function (x) { return x.indexOf('retracement') !== -1; }));
});

/* ================= WATCH ================= */

test('WATCH：bullish MATCH + manipulation confirmed → BULLISH_WATCH / WATCH', function () {
    var r = run({
        symbol: 'BTCUSDT', evaluationTime: 1000,
        bias: bias('LEAN_BULLISH', 'MEDIUM'),
        draw: draw('BSL'),
        amd: amd('MANIPULATION_CONFIRMED', 'BULLISH'),
        alignment: 'MATCH',
        conflicts: [],
        delivery: delivery('NEUTRAL', 0, false)
    });
    assert.strictEqual(r.scenarioState, 'BULLISH_WATCH');
    assert.strictEqual(r.action, 'WATCH');
});

test('WATCH：bearish MATCH + distribution confirmed → BEARISH_WATCH / WATCH', function () {
    var r = run({
        symbol: 'BTCUSDT', evaluationTime: 1000,
        bias: bias('BEARISH', 'MEDIUM'),
        draw: draw('SSL'),
        amd: amd('DISTRIBUTION_CONFIRMED', 'BEARISH'),
        alignment: 'MATCH',
        conflicts: [],
        delivery: delivery('BEARISH', -8, true)
    });
    assert.strictEqual(r.scenarioState, 'BEARISH_WATCH');
    assert.strictEqual(r.action, 'WATCH');
});

test('WATCH 门控：candidate AMD（未到 MANIPULATION）→ 不到 WATCH', function () {
    var r = run({
        symbol: 'BTCUSDT', evaluationTime: 1000,
        bias: bias('BULLISH', 'MEDIUM'),
        draw: draw('BSL'),
        amd: amd('ACCUMULATION_CONFIRMED', 'BULLISH'),
        alignment: 'MATCH',
        conflicts: [],
        delivery: delivery('NEUTRAL', 0, false)
    });
    assert.strictEqual(r.scenarioState, 'BULLISH_WAIT');
    assert.strictEqual(r.action, 'WAIT');
});

test('WATCH 门控：opposite alignment（AMD 方向匹配但 alignment 非 MATCH）→ 不到 WATCH', function () {
    var r = run({
        symbol: 'BTCUSDT', evaluationTime: 1000,
        bias: bias('BULLISH', 'MEDIUM'),
        draw: draw('BSL'),
        amd: amd('MANIPULATION_CONFIRMED', 'BULLISH'),
        alignment: 'UNCONFIRMED',
        conflicts: [],
        delivery: delivery('NEUTRAL', 0, false)
    });
    assert.strictEqual(r.scenarioState, 'BULLISH_WAIT');
    assert.strictEqual(r.action, 'WAIT');
});

/* ================= SETUP_READY ================= */

test('SETUP_READY：complete bullish AMD + matching delivery → BULLISH_SETUP / CONTEXT_READY', function () {
    var r = run({
        symbol: 'BTCUSDT', evaluationTime: 1000,
        bias: bias('BULLISH', 'HIGH'),
        draw: draw('BSL'),
        amd: amd('COMPLETE', 'BULLISH'),
        alignment: 'MATCH',
        conflicts: [],
        delivery: delivery('BULLISH', 25, true)
    });
    assert.strictEqual(r.scenarioState, 'BULLISH_SETUP');
    assert.strictEqual(r.action, 'SETUP_READY');
    assert.strictEqual(r.setupReadyType, 'CONTEXT_READY');
});

test('SETUP_READY：complete bearish AMD + matching delivery → BEARISH_SETUP / CONTEXT_READY', function () {
    var r = run({
        symbol: 'BTCUSDT', evaluationTime: 1000,
        bias: bias('BEARISH', 'HIGH'),
        draw: draw('SSL'),
        amd: amd('COMPLETE', 'BEARISH'),
        alignment: 'MATCH',
        conflicts: [],
        delivery: delivery('BEARISH', -25, true)
    });
    assert.strictEqual(r.scenarioState, 'BEARISH_SETUP');
    assert.strictEqual(r.action, 'SETUP_READY');
    assert.strictEqual(r.setupReadyType, 'CONTEXT_READY');
});

test('SETUP 门控：AMD COMPLETE 但 delivery opposite → 不 ready（WAIT）', function () {
    var r = run({
        symbol: 'BTCUSDT', evaluationTime: 1000,
        bias: bias('BULLISH', 'HIGH'),
        draw: draw('BSL'),
        amd: amd('COMPLETE', 'BULLISH'),
        alignment: 'MATCH',
        conflicts: [],
        delivery: delivery('BEARISH', -25, true)
    });
    // scenarioState 是 WAIT（delivery 不匹配，进不到 SETUP 分支），action 保守 WAIT
    assert.notStrictEqual(r.scenarioState, 'BULLISH_SETUP');
    assert.strictEqual(r.action, 'WAIT');
});

test('SETUP 门控：matching delivery 但 AMD incomplete → 不 ready', function () {
    var r = run({
        symbol: 'BTCUSDT', evaluationTime: 1000,
        bias: bias('BULLISH', 'HIGH'),
        draw: draw('BSL'),
        amd: amd('DISTRIBUTION_CONFIRMED', 'BULLISH'),
        alignment: 'MATCH',
        conflicts: [],
        delivery: delivery('BULLISH', 25, true)
    });
    assert.strictEqual(r.scenarioState, 'BULLISH_WATCH');
    assert.strictEqual(r.action, 'WATCH');
});

test('SETUP 门控：AMD COMPLETE + delivery matching 但 MAJOR conflict → 不 ready', function () {
    var r = run({
        symbol: 'BTCUSDT', evaluationTime: 1000,
        bias: bias('BULLISH', 'MEDIUM'),
        draw: draw('BSL'),
        amd: amd('COMPLETE', 'BULLISH'),
        alignment: 'MATCH',
        conflicts: [major()],
        delivery: delivery('BULLISH', 25, true)
    });
    assert.notStrictEqual(r.scenarioState, 'BULLISH_SETUP');
    assert.notStrictEqual(r.action, 'SETUP_READY');
});

/* ================= CONFLICT / BLOCKING ================= */

test('CONFLICT：LOW bias confidence + MAJOR + opposite AMD → NO_TRADE（blocking）', function () {
    var r = run({
        symbol: 'BTCUSDT', evaluationTime: 1000,
        bias: bias('BULLISH', 'LOW'),
        draw: draw('BSL'),
        amd: amd('MANIPULATION_CONFIRMED', 'BEARISH'),
        alignment: 'OPPOSITE',
        conflicts: [major()],
        delivery: delivery('BEARISH', -25, true)
    });
    assert.strictEqual(r.scenarioState, 'CONFLICT');
    assert.strictEqual(r.action, 'NO_TRADE');
    assert.strictEqual(r.block, true);
});

test('MODERATE conflict 不直接 block（bullish WAIT 仍成立）', function () {
    var r = run({
        symbol: 'BTCUSDT', evaluationTime: 1000,
        bias: bias('LEAN_BULLISH', 'MEDIUM'),
        draw: draw('BSL'),
        amd: amd('SEARCHING', null),
        alignment: 'UNCONFIRMED',
        conflicts: [moderate()],
        delivery: delivery('NEUTRAL', 0, false)
    });
    assert.strictEqual(r.scenarioState, 'BULLISH_WAIT');
    assert.strictEqual(r.action, 'WAIT');
    assert.strictEqual(r.block, false);
});

test('MINOR conflict 不直接 block', function () {
    var r = run({
        symbol: 'BTCUSDT', evaluationTime: 1000,
        bias: bias('BULLISH', 'HIGH'),
        draw: draw('BSL'),
        amd: amd('COMPLETE', 'BULLISH'),
        alignment: 'MATCH',
        conflicts: [minor()],
        delivery: delivery('BULLISH', 25, true)
    });
    assert.strictEqual(r.scenarioState, 'BULLISH_SETUP');
    assert.strictEqual(r.action, 'SETUP_READY');
});

/* ================= Scenario Score ================= */

function scored(r) {
    return scenarioScorer.scoreScenario(r, {});
}

test('score：HIGH bias(30) + matching strong draw(20) + COMPLETE AMD(30) + complete delivery(15) + no major(5) = 100', function () {
    var r = run({
        symbol: 'BTCUSDT', evaluationTime: 1000,
        bias: bias('BULLISH', 'HIGH'),
        draw: draw('BSL'),
        amd: amd('COMPLETE', 'BULLISH'),
        alignment: 'MATCH',
        conflicts: [],
        delivery: delivery('BULLISH', 25, true)
    });
    var s = scored(r);
    assert.strictEqual(s.total, 100);
    assert.deepStrictEqual(s.breakdown, {
        bias: 30, draw: 20, amd: 30, delivery: 15, conflict: 5
    });
});

test('score：draw opposite → 0 分贡献', function () {
    var r = run({
        symbol: 'BTCUSDT', evaluationTime: 1000,
        bias: bias('BULLISH', 'MEDIUM'),
        draw: draw('SSL'),
        amd: amd('MANIPULATION_CONFIRMED', 'BULLISH'),
        alignment: 'MATCH',
        conflicts: [],
        delivery: delivery('BULLISH', 8, true)
    });
    var s = scored(r);
    assert.strictEqual(s.breakdown.draw, 0);
    assert.strictEqual(s.breakdown.bias, 22);
    assert.strictEqual(s.breakdown.amd, 20);
    assert.strictEqual(s.breakdown.delivery, 8);
});

test('score：AMD opposite → amd 0 分', function () {
    var r = run({
        symbol: 'BTCUSDT', evaluationTime: 1000,
        bias: bias('BULLISH', 'MEDIUM'),
        draw: draw('BSL'),
        amd: amd('MANIPULATION_CONFIRMED', 'BEARISH'),
        alignment: 'OPPOSITE',
        conflicts: [],
        delivery: delivery('BEARISH', -25, true)
    });
    var s = scored(r);
    assert.strictEqual(s.breakdown.amd, 0);
    assert.strictEqual(s.breakdown.delivery, 0); // opposite delivery → 0
});

test('score：MAJOR conflict → conflict 0 分（penalty）', function () {
    var r = run({
        symbol: 'BTCUSDT', evaluationTime: 1000,
        bias: bias('BULLISH', 'HIGH'),
        draw: draw('BSL'),
        amd: amd('COMPLETE', 'BULLISH'),
        alignment: 'MATCH',
        conflicts: [major()],
        delivery: delivery('BULLISH', 25, true)
    });
    var s = scored(r);
    assert.strictEqual(s.breakdown.conflict, 0);
    assert.strictEqual(s.total, 95);
});

test('score：quality buckets LOW / MEDIUM / HIGH', function () {
    var low = run({
        symbol: 'X', evaluationTime: 1,
        bias: bias('NEUTRAL', 'LOW'), draw: draw('BALANCED'),
        amd: amd('SEARCHING', null), alignment: 'UNCONFIRMED',
        conflicts: [], delivery: delivery('NEUTRAL', 0, false)
    });
    var med = run({
        symbol: 'X', evaluationTime: 1,
        bias: bias('LEAN_BULLISH', 'MEDIUM'), draw: draw('LEAN_BSL'),
        amd: amd('ACCUMULATION_CONFIRMED', 'BULLISH'), alignment: 'MATCH',
        conflicts: [], delivery: delivery('NEUTRAL', 0, false)
    });
    var high = run({
        symbol: 'X', evaluationTime: 1,
        bias: bias('BULLISH', 'HIGH'), draw: draw('BSL'),
        amd: amd('COMPLETE', 'BULLISH'), alignment: 'MATCH',
        conflicts: [], delivery: delivery('BULLISH', 25, true)
    });
    assert.strictEqual(scored(low).quality, 'LOW');
    assert.strictEqual(scored(med).quality, 'MEDIUM');
    assert.strictEqual(scored(high).quality, 'HIGH');
});

test('score：cap 100（永不超）', function () {
    var r = run({
        symbol: 'X', evaluationTime: 1,
        bias: bias('BULLISH', 'HIGH'), draw: draw('BSL'),
        amd: amd('COMPLETE', 'BULLISH'), alignment: 'MATCH',
        conflicts: [], delivery: delivery('BULLISH', 25, true)
    });
    assert.ok(scored(r).total <= 100);
});

/* ================= Invalidation ================= */

test('invalidation：bullish scenario 输出失效条件', function () {
    var r = run({
        symbol: 'BTCUSDT', evaluationTime: 1000,
        bias: bias('BULLISH', 'HIGH'),
        draw: draw('BSL'),
        amd: amd('COMPLETE', 'BULLISH'),
        alignment: 'MATCH',
        conflicts: [],
        delivery: delivery('BULLISH', 25, true)
    });
    var inv = invalidationEngine.buildInvalidation(r, {});
    assert.ok(inv.some(function (x) { return x.indexOf('BEARISH') !== -1; }));
    assert.ok(inv.some(function (x) { return x.indexOf('SSL') !== -1; }));
    assert.ok(inv.some(function (x) { return x.indexOf('INVALIDATED') !== -1; }));
});

test('invalidation：bearish scenario 对称', function () {
    var r = run({
        symbol: 'BTCUSDT', evaluationTime: 1000,
        bias: bias('BEARISH', 'HIGH'),
        draw: draw('SSL'),
        amd: amd('COMPLETE', 'BEARISH'),
        alignment: 'MATCH',
        conflicts: [],
        delivery: delivery('BEARISH', -25, true)
    });
    var inv = invalidationEngine.buildInvalidation(r, {});
    assert.ok(inv.some(function (x) { return x.indexOf('BULLISH') !== -1; }));
    assert.ok(inv.some(function (x) { return x.indexOf('BSL') !== -1; }));
});

test('invalidation：neutral scenario 输出通用条件', function () {
    var r = run({
        symbol: 'X', evaluationTime: 1,
        bias: bias('NEUTRAL', 'MEDIUM'), draw: draw('BALANCED'),
        amd: amd('SEARCHING', null), alignment: 'UNCONFIRMED',
        conflicts: [], delivery: delivery('NEUTRAL', 0, false)
    });
    var inv = invalidationEngine.buildInvalidation(r, {});
    assert.ok(inv.length >= 1);
});

/* ================= Explanation ================= */

test('explanation：WATCH 状态 confirmations/missing 分类正确', function () {
    var r = run({
        symbol: 'BTCUSDT', evaluationTime: 1000,
        bias: bias('LEAN_BULLISH', 'MEDIUM'),
        draw: draw('BSL'),
        amd: amd('MANIPULATION_CONFIRMED', 'BULLISH'),
        alignment: 'MATCH',
        conflicts: [],
        delivery: delivery('NEUTRAL', 0, false)
    });
    var e = scenarioExplanation.buildExplanation(r, {});
    assert.ok(e.confirmations.length >= 1);
    assert.ok(e.missing.some(function (m) { return m.indexOf('distribution') !== -1; }));
    assert.strictEqual(e.conflicts.length, 0);
});

test('explanation：conflicts 描述存在', function () {
    var r = run({
        symbol: 'BTCUSDT', evaluationTime: 1000,
        bias: bias('BULLISH', 'LOW'),
        draw: draw('BSL'),
        amd: amd('MANIPULATION_CONFIRMED', 'BEARISH'),
        alignment: 'OPPOSITE',
        conflicts: [major()],
        delivery: delivery('BEARISH', -25, true)
    });
    var e = scenarioExplanation.buildExplanation(r, {});
    assert.ok(e.conflicts.some(function (c) { return c.indexOf('STRUCTURE_VS_DELIVERY') !== -1; }));
});

/* ================= Replay safety ================= */

test('replay：future AMD 状态（confirmedAt > evaluationTime）→ 不参与，降级 WAIT', function () {
    var r = run({
        symbol: 'BTCUSDT', evaluationTime: 1000,
        bias: bias('BULLISH', 'HIGH'),
        draw: draw('BSL'),
        amd: amd('COMPLETE', 'BULLISH', 5000), // confirmedAt 未来
        alignment: 'MATCH',
        conflicts: [],
        delivery: delivery('BULLISH', 25, true)
    });
    assert.strictEqual(r.scenarioState, 'BULLISH_WAIT');
    assert.notStrictEqual(r.action, 'SETUP_READY');
});

test('replay：deterministic（相同输入两次结果一致）', function () {
    var input = {
        symbol: 'BTCUSDT', evaluationTime: 1000,
        bias: bias('BULLISH', 'HIGH'),
        draw: draw('BSL'),
        amd: amd('COMPLETE', 'BULLISH'),
        alignment: 'MATCH',
        conflicts: [minor()],
        delivery: delivery('BULLISH', 25, true)
    };
    var r1 = run(JSON.parse(JSON.stringify(input)), {});
    var r2 = run(JSON.parse(JSON.stringify(input)), {});
    assert.strictEqual(r1.scenarioState, r2.scenarioState);
    assert.strictEqual(r1.action, r2.action);
    assert.strictEqual(r1.quality.total, r2.quality.total);
});

/* ================= Action Engine 门控直测 ================= */

test('actionEngine：SETUP 门控（delivery 未匹配 → 降级 WAIT）', function () {
    var parts = {
        direction: 'BULLISH',
        amd: amd('COMPLETE', 'BULLISH'),
        alignment: 'MATCH',
        conflicts: [],
        delivery: delivery('BEARISH', -25, true)
    };
    var a = actionEngine.resolveAction('BULLISH_SETUP', parts, {});
    assert.strictEqual(a.action, 'WAIT');
    assert.strictEqual(a.setupReadyType, null);
});

test('actionEngine：WATCH 门控（AMD state 不够 → 降级 WAIT）', function () {
    var parts = {
        direction: 'BULLISH',
        amd: amd('ACCUMULATION_CONFIRMED', 'BULLISH'),
        alignment: 'MATCH',
        conflicts: [],
        delivery: delivery('BULLISH', 8, true)
    };
    var a = actionEngine.resolveAction('BULLISH_WATCH', parts, {});
    assert.strictEqual(a.action, 'WAIT');
});

test('actionEngine：CONFLICT → NO_TRADE / NEUTRAL → WAIT', function () {
    assert.strictEqual(actionEngine.resolveAction('CONFLICT', {}, {}).action, 'NO_TRADE');
    assert.strictEqual(actionEngine.resolveAction('NEUTRAL', {}, {}).action, 'WAIT');
});

/* ---------------- run ---------------- */

var passCount = 0;
tests.forEach(function (t) {
    if (runTest(t)) {
        passCount++;
    }
});

console.log('--------------------------------');
console.log(passCount + ' / ' + tests.length + ' passed');

if (passCount !== tests.length) {
    process.exit(1);
}
