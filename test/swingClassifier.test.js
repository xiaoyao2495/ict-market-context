/**
 * swingClassifier 单元测试
 *
 * - HH + HL → BULLISH
 * - LH + LL → BEARISH
 * - HH + LL / LH + HL → CONFLICTED
 * - 数据不足 → NEUTRAL
 * - 防未来数据（time > evaluationTime 排除）
 */
var assert = require('assert');
var swingClassifier = require('../structure/swingClassifier');

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

function pivot(type, price, time) {
    return { type: type, index: 0, price: price, time: time };
}

function confirmedPivot(type, price, occurredAt, confirmedAt) {
    return { type: type, index: 0, price: price, time: occurredAt, occurredAt: occurredAt, confirmedAt: confirmedAt };
}

/* ---------- P0: confirmedAt 防未来数据（Phase 11R） ---------- */

test('P0：confirmedAt > evaluationTime 的 pivot 排除（即使 occurredAt 在过去）', function () {
    // 4H pivot 08:00 出现，右侧确认 16:00 收盘。
    // evaluationTime = 12:00：pivot occurredAt(08:00) <= 12:00，但 confirmedAt(16:00) > 12:00
    // → 该 pivot 尚未确认，不得进入结构判定（这是 Replay 的 future leakage 修复）
    var pivots = [
        confirmedPivot('HIGH', 100, 800, 1600),
        confirmedPivot('LOW', 90, 900, 1700),
        confirmedPivot('HIGH', 105, 1000, 1800),
        confirmedPivot('LOW', 95, 1100, 1900)
    ];
    // 全部未确认（confirmedAt 都 > 12:00）
    var r = swingClassifier.classifyStructure(pivots, { timeframe: '4h', evaluationTime: 1200 });
    assert.strictEqual(r.structure, 'NEUTRAL');
    assert.strictEqual(r.reason.indexOf('insufficient') !== -1, true);
});

test('P0：confirmedAt <= evaluationTime 才参与（部分确认）', function () {
    var pivots = [
        confirmedPivot('HIGH', 100, 800, 1600),   // 16:00 确认
        confirmedPivot('LOW', 90, 900, 1700),     // 17:00 确认
        confirmedPivot('HIGH', 105, 1000, 1800),  // 18:00 确认
        confirmedPivot('LOW', 95, 1100, 1900)     // 19:00 确认
    ];
    // evaluationTime = 1650：只有第一个 HIGH 确认
    var r = swingClassifier.classifyStructure(pivots, { timeframe: '4h', evaluationTime: 1650 });
    assert.strictEqual(r.structure, 'NEUTRAL'); // 只有 1 个 high 确认，数据不足
    // evaluationTime = 1850：HIGH×2 + LOW×1 确认 → 仍不足 2 low
    var r2 = swingClassifier.classifyStructure(pivots, { timeframe: '4h', evaluationTime: 1850 });
    assert.strictEqual(r2.structure, 'NEUTRAL');
    // evaluationTime = 2000：全部确认 → HH + HL → BULLISH
    var r3 = swingClassifier.classifyStructure(pivots, { timeframe: '4h', evaluationTime: 2000 });
    assert.strictEqual(r3.structure, 'BULLISH');
});

test('P0：latestPivots 按 confirmedAt 排序（而非 time）', function () {
    var pivots = [
        confirmedPivot('HIGH', 100, 1000, 3000), // 出现早但确认晚
        confirmedPivot('HIGH', 102, 2000, 2500)  // 出现晚但确认早
    ];
    var highs = swingClassifier.latestPivots(pivots, 'HIGH', 2);
    // 按确认时间排序：[102(2500), 100(3000)]，最近 = 100（确认最晚）
    assert.strictEqual(highs[highs.length - 1].price, 100);
});

/* ---------- BULLISH ---------- */

test('HH + HL → BULLISH', function () {
    var pivots = [
        pivot('HIGH', 63000, 1000),
        pivot('LOW', 62800, 2000),
        pivot('HIGH', 63200, 3000), // HH: 63200 > 63000
        pivot('LOW', 63050, 4000) // HL: 63050 > 62800
    ];
    var r = swingClassifier.classifyStructure(pivots, { timeframe: '4h' });
    assert.strictEqual(r.structure, 'BULLISH');
    assert.strictEqual(r.hh, true);
    assert.strictEqual(r.hl, true);
    assert.strictEqual(r.lh, false);
    assert.strictEqual(r.ll, false);
    assert.strictEqual(r.timeframe, '4h');
});

/* ---------- BEARISH ---------- */

test('LH + LL → BEARISH', function () {
    var pivots = [
        pivot('HIGH', 63200, 1000),
        pivot('LOW', 63050, 2000),
        pivot('HIGH', 63100, 3000), // LH: 63100 < 63200
        pivot('LOW', 62900, 4000) // LL: 62900 < 63050
    ];
    var r = swingClassifier.classifyStructure(pivots, {});
    assert.strictEqual(r.structure, 'BEARISH');
    assert.strictEqual(r.lh, true);
    assert.strictEqual(r.ll, true);
});

/* ---------- CONFLICTED ---------- */

test('HH + LL → CONFLICTED', function () {
    var pivots = [
        pivot('HIGH', 63000, 1000),
        pivot('LOW', 62800, 2000),
        pivot('HIGH', 63200, 3000), // HH
        pivot('LOW', 62700, 4000) // LL
    ];
    var r = swingClassifier.classifyStructure(pivots, {});
    assert.strictEqual(r.structure, 'CONFLICTED');
});

test('LH + HL → CONFLICTED', function () {
    var pivots = [
        pivot('HIGH', 63200, 1000),
        pivot('LOW', 62800, 2000),
        pivot('HIGH', 63100, 3000), // LH
        pivot('LOW', 62900, 4000) // HL
    ];
    var r = swingClassifier.classifyStructure(pivots, {});
    assert.strictEqual(r.structure, 'CONFLICTED');
});

/* ---------- NEUTRAL / 数据不足 ---------- */

test('数据不足（缺 low）→ NEUTRAL', function () {
    var pivots = [
        pivot('HIGH', 63000, 1000),
        pivot('HIGH', 63200, 2000)
    ];
    var r = swingClassifier.classifyStructure(pivots, {});
    assert.strictEqual(r.structure, 'NEUTRAL');
});

test('空数组 → NEUTRAL', function () {
    var r = swingClassifier.classifyStructure([], {});
    assert.strictEqual(r.structure, 'NEUTRAL');
});

/* ---------- 防未来数据 ---------- */

test('time > evaluationTime 的 pivot 不参与', function () {
    var pivots = [
        pivot('HIGH', 63000, 1000),
        pivot('LOW', 62800, 2000),
        pivot('HIGH', 63200, 9999999999), // 未来
        pivot('LOW', 63050, 9999999999) // 未来
    ];
    var r = swingClassifier.classifyStructure(pivots, { evaluationTime: 5000 });
    // 未来 pivot 被排除 → 只剩 1 high 1 low → NEUTRAL
    assert.strictEqual(r.structure, 'NEUTRAL');
});

test('latestPivots：按时间取最近 n 个', function () {
    var pivots = [
        pivot('HIGH', 63000, 1000),
        pivot('HIGH', 63100, 2000),
        pivot('HIGH', 63200, 3000)
    ];
    var latest = swingClassifier.latestPivots(pivots, 'HIGH', 2);
    assert.strictEqual(latest.length, 2);
    assert.strictEqual(latest[0].price, 63100);
    assert.strictEqual(latest[1].price, 63200);
});

console.log('----');
console.log('swingClassifier: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) {
    process.exit(1);
}
