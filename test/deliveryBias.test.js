/**
 * deliveryBias 单元测试
 *
 * 事件链：SSL Sweep → Bullish MSS → Bullish Displacement（+8/+15/+25）
 *         BSL Sweep → Bearish MSS → Bearish Displacement（-8/-15/-25）
 * - 顺序严格、方向必须匹配、窗口（Sweep→MSS 12 bars，MSS→Disp 6 bars）
 * - freshness：0-6 ×1.0 / 7-12 ×0.75 / 13-24 ×0.5 / >24 ×0.25
 * - 多链单选（completedAt 最近 → 完整度高 → |score| 高 → id 字典序）
 * - 未来事件排除
 */
var assert = require('assert');
var deliveryBias = require('../bias/deliveryBias');

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

var BAR = 300000; // 5m

function ev(id, direction, confirmedAt) {
    return { id: id, direction: direction, confirmedAt: confirmedAt };
}

function run(sweeps, mss, displacements, evaluationTime) {
    var maxT = 0;
    sweeps.concat(mss).concat(displacements).forEach(function (e) {
        if (e && e.confirmedAt > maxT) maxT = e.confirmedAt;
    });
    // 默认刚完成（ageBars=0，freshness 1.0）；显式传 evaluationTime 则用之
    var evalTime =
        evaluationTime !== undefined ? evaluationTime : maxT + 1;
    return deliveryBias.scoreDeliveryBias({
        evaluationTime: evalTime,
        timeframe: '5m',
        events: { sweeps: sweeps, mss: mss, displacements: displacements }
    }, {});
}

/* ---------- 基础链 ---------- */

test('SSL Sweep only → bullish +8', function () {
    var r = run([ev('s1', 'BULLISH', 1000)], [], []);
    assert.strictEqual(r.available, true);
    assert.strictEqual(r.direction, 'BULLISH');
    assert.strictEqual(r.rawScore, 8);
    assert.strictEqual(r.score, 8);
    assert.strictEqual(r.completedAt, 1000); // sweep confirmedAt
});

test('BSL Sweep only → bearish -8', function () {
    var r = run([ev('s1', 'BEARISH', 1000)], [], []);
    assert.strictEqual(r.direction, 'BEARISH');
    assert.strictEqual(r.score, -8);
});

test('SSL Sweep + Bullish MSS → +15', function () {
    var r = run(
        [ev('s1', 'BULLISH', 1000)],
        [ev('m1', 'BULLISH', 1000 + 2 * BAR)], // 2 bars 后
        []
    );
    assert.strictEqual(r.score, 15);
    assert.strictEqual(r.completedAt, 1000 + 2 * BAR); // mss confirmedAt
});

test('完整 bullish chain → +25', function () {
    var r = run(
        [ev('s1', 'BULLISH', 1000)],
        [ev('m1', 'BULLISH', 1000 + 2 * BAR)],
        [ev('d1', 'BULLISH', 1000 + 2 * BAR + 1 * BAR)]
    );
    assert.strictEqual(r.score, 25);
    assert.strictEqual(r.completedAt, 1000 + 3 * BAR); // displacement confirmedAt
    assert.strictEqual(r.reasons.length, 3);
});

test('完整 bearish chain → -25', function () {
    var r = run(
        [ev('s1', 'BEARISH', 1000)],
        [ev('m1', 'BEARISH', 1000 + 1 * BAR)],
        [ev('d1', 'BEARISH', 1000 + 2 * BAR)]
    );
    assert.strictEqual(r.score, -25);
    assert.strictEqual(r.direction, 'BEARISH');
});

/* ---------- 方向不匹配 ---------- */

test('wrong direction MSS 不拼链（SSL sweep + bearish MSS → 只有 sweep）', function () {
    var r = run(
        [ev('s1', 'BULLISH', 1000)],
        [ev('m1', 'BEARISH', 1000 + 2 * BAR)], // 方向不匹配
        []
    );
    assert.strictEqual(r.rawScore, 8); // sweep only
    assert.strictEqual(r.mss, null);
});

test('wrong direction displacement 不拼链', function () {
    var r = run(
        [ev('s1', 'BULLISH', 1000)],
        [ev('m1', 'BULLISH', 1000 + 2 * BAR)],
        [ev('d1', 'BEARISH', 1000 + 3 * BAR)] // 方向不匹配
    );
    assert.strictEqual(r.rawScore, 15); // sweep + mss
    assert.strictEqual(r.displacement, null);
});

/* ---------- 窗口 ---------- */

test('MSS 超过 12 bars 不拼', function () {
    var r = run(
        [ev('s1', 'BULLISH', 1000)],
        [ev('m1', 'BULLISH', 1000 + 13 * BAR)], // 13 bars > 12
        []
    );
    assert.strictEqual(r.rawScore, 8); // 不拼
});

test('MSS 恰好 12 bars 拼（边界含）', function () {
    var r = run(
        [ev('s1', 'BULLISH', 1000)],
        [ev('m1', 'BULLISH', 1000 + 12 * BAR)],
        []
    );
    assert.strictEqual(r.rawScore, 15);
});

test('Displacement 超过 6 bars 不拼', function () {
    var r = run(
        [ev('s1', 'BULLISH', 1000)],
        [ev('m1', 'BULLISH', 1000 + 2 * BAR)],
        [ev('d1', 'BULLISH', 1000 + 2 * BAR + 7 * BAR)] // 7 bars > 6
    );
    assert.strictEqual(r.rawScore, 15);
});

test('Displacement 恰好 6 bars 拼（边界含）', function () {
    var r = run(
        [ev('s1', 'BULLISH', 1000)],
        [ev('m1', 'BULLISH', 1000 + 2 * BAR)],
        [ev('d1', 'BULLISH', 1000 + 2 * BAR + 6 * BAR)]
    );
    assert.strictEqual(r.rawScore, 25);
});

/* ---------- 未来事件排除 ---------- */

test('confirmedAt > evaluationTime 的事件排除', function () {
    var r = run(
        [ev('s1', 'BULLISH', 9999999999999)], // 未来
        [],
        [],
        5000
    );
    assert.strictEqual(r.available, false); // 全部被过滤
});

test('部分未来事件：只拼已确认部分', function () {
    // sweep 1000 + mss 301000 已确认（< 500000），displacement 未来
    var r = run(
        [ev('s1', 'BULLISH', 1000)],
        [ev('m1', 'BULLISH', 1000 + 1 * BAR)],
        [ev('d1', 'BULLISH', 9999999999999)], // 未来 displacement
        500000
    );
    assert.strictEqual(r.rawScore, 15); // 只到 mss
});

/* ---------- freshness ---------- */

test('freshnessMultiplier 边界：0→1.0 / 6→1.0 / 7→0.75 / 12→0.75 / 13→0.5 / 24→0.5 / 25→0.25', function () {
    var cfg = require('../config/thresholds').bias.delivery;
    assert.strictEqual(deliveryBias.freshnessMultiplier(0, cfg), 1.0);
    assert.strictEqual(deliveryBias.freshnessMultiplier(6, cfg), 1.0);
    assert.strictEqual(deliveryBias.freshnessMultiplier(7, cfg), 0.75);
    assert.strictEqual(deliveryBias.freshnessMultiplier(12, cfg), 0.75);
    assert.strictEqual(deliveryBias.freshnessMultiplier(13, cfg), 0.5);
    assert.strictEqual(deliveryBias.freshnessMultiplier(24, cfg), 0.5);
    assert.strictEqual(deliveryBias.freshnessMultiplier(25, cfg), 0.25);
});

test('score 应用 freshness：完整链 30 bars 后 → 25×0.25 ≈ 6', function () {
    var evalTime = 1000 + 3 * BAR + 30 * BAR;
    var r = run(
        [ev('s1', 'BULLISH', 1000)],
        [ev('m1', 'BULLISH', 1000 + 2 * BAR)],
        [ev('d1', 'BULLISH', 1000 + 3 * BAR)],
        evalTime
    );
    assert.strictEqual(r.ageBars, 30);
    assert.strictEqual(r.freshnessMultiplier, 0.25);
    assert.strictEqual(r.score, 6); // 25 * 0.25 = 6.25 → round 6
});

/* ---------- 多链选择 ---------- */

test('多链：completedAt 最近优先', function () {
    // 链 A 完成于 5000（sweep only），链 B 完成于 3000（完整链）
    var r = run(
        [
            ev('sA', 'BULLISH', 5000),
            ev('sB', 'BULLISH', 1000)
        ],
        [],
        [ev('dB', 'BULLISH', 3000)] // 无法与 sB 匹配？sB 1000 → mss 没有 → sweep only
    );
    // sA: sweep only @5000 → +8
    // sB: sweep @1000 → 没有 mss → sweep only @1000 → +8
    // completedAt 最近 = sA (5000)
    assert.strictEqual(r.completedAt, 5000);
});

test('多链：同 completedAt 完整度高优先', function () {
    var r = run(
        [
            ev('sA', 'BULLISH', 1000), // 完整链 1000→3000
            ev('sB', 'BULLISH', 3000) // sweep only @3000
        ],
        [ev('mA', 'BULLISH', 2000)],
        [ev('dA', 'BULLISH', 3000)]
    );
    // 链 A: 完整链 completedAt 3000 → 25
    // 链 B: sweep only completedAt 3000 → 8
    // 同时间 → 完整度高优先 → A
    assert.strictEqual(r.rawScore, 25);
    assert.strictEqual(r.sweep.id, 'sA');
});

test('多链不求和', function () {
    var r = run(
        [
            ev('sA', 'BULLISH', 1000),
            ev('sB', 'BULLISH', 2000)
        ],
        [],
        []
    );
    assert.strictEqual(r.rawScore, 8); // 只选一条，不是 16
    assert.strictEqual(r.sweep.id, 'sB'); // 最近优先
});

test('无事件 → available false', function () {
    var r = run([], [], []);
    assert.strictEqual(r.available, false);
    assert.strictEqual(r.score, 0);
});

test('有事件但无合法链（无 sweep 无法成链）→ available true score 0', function () {
    // 只有 MSS + displacement，没有任何 sweep → 无法构成链
    var r = run(
        [],
        [ev('m1', 'BULLISH', 2000)],
        [ev('d1', 'BULLISH', 3000)]
    );
    assert.strictEqual(r.available, true); // 有事件数据
    assert.strictEqual(r.score, 0); // 但无链
});

console.log('----');
console.log('deliveryBias: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) {
    process.exit(1);
}
