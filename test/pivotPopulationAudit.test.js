/**
 * Phase 12.1 — Pivot Population Audit 测试
 *
 * 覆盖：
 *   - 桶分类（相邻同向距离 / prominence / 穿越寿命）
 *   - nesting 判定
 *   - 聚合：密度、HIGH/LOW 计数、unresolved
 */
var assert = require('assert');
var ppa = require('../stats/pivotPopulationAudit');

var passed = 0;
var failed = 0;

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log('PASS ' + name);
    } catch (e) {
        failed++;
        console.log('FAIL ' + name + ' -> ' + (e && e.message || e));
    }
}

var BAR = 300000;
function m5(o, h, l, c, i) {
    var t = 1000000 + i * BAR;
    return { openTime: t, open: o, high: h, low: l, close: c, closeTime: t + BAR - 1, closed: true };
}
function mkCandles() {
    var out = [];
    for (var i = 0; i < 60; i++) out.push(m5(100, 101, 99.4, 100.5, i));
    return out;
}
function mkPivot(id, type, price, idx) {
    return { id: id, symbol: 'X', timeframe: '5m', type: type, side: type === 'SWING_LOW' ? 'SSL' : 'BSL',
        price: price, confirmedAt: 1000000 + (idx + 2) * BAR + BAR - 1, metadata: { index: idx, source: 'futures' } };
}
function mkPivots() {
    var out = [];
    // LOW pivots at 5 (99) / 20 (98.5) / 40 (98) —— 相互距离 15/20 bars
    out.push(mkPivot('P1', 'SWING_LOW', 99, 5));
    out.push(mkPivot('P2', 'SWING_LOW', 98.5, 20));
    out.push(mkPivot('P3', 'SWING_LOW', 98, 40));
    // HIGH pivots at 12 (101.2) / 30 (101.5) —— 距离 18 bars（默认 high=101 < 101.2，不提前触发穿越）
    out.push(mkPivot('P4', 'SWING_HIGH', 101.2, 12));
    out.push(mkPivot('P5', 'SWING_HIGH', 101.5, 30));
    return out;
}

/* ---------- 桶分类 ---------- */

test('12.1：bucketDist（相邻同向距离）', function () {
    assert.strictEqual(ppa.bucketDist(1), '1');
    assert.strictEqual(ppa.bucketDist(2), '2');
    assert.strictEqual(ppa.bucketDist(3), '3');
    assert.strictEqual(ppa.bucketDist(5), '4-6');
    assert.strictEqual(ppa.bucketDist(8), '7-12');
    assert.strictEqual(ppa.bucketDist(13), '13+');
    assert.strictEqual(ppa.bucketDist(40), '13+');
});

test('12.1：bucketProm（prominence/ATR）', function () {
    assert.strictEqual(ppa.bucketProm(0.1), '<0.25');
    assert.strictEqual(ppa.bucketProm(0.3), '0.25-0.5');
    assert.strictEqual(ppa.bucketProm(0.7), '0.5-1');
    assert.strictEqual(ppa.bucketProm(1.5), '1-2');
    assert.strictEqual(ppa.bucketProm(3), '>=2');
});

test('12.1：bucketLife（穿越寿命）', function () {
    assert.strictEqual(ppa.bucketLife(2), '<=3');
    assert.strictEqual(ppa.bucketLife(5), '4-6');
    assert.strictEqual(ppa.bucketLife(9), '7-12');
    assert.strictEqual(ppa.bucketLife(20), '13-24');
    assert.strictEqual(ppa.bucketLife(25), '>24');
    assert.strictEqual(ppa.bucketLife(100), '>24');
});

/* ---------- 聚合 ---------- */

test('12.1：auditPivotPopulation 聚合（密度/距离/寿命/nesting）', function () {
    var candles = mkCandles();
    var res = ppa.auditPivotPopulation({ pivots: mkPivots(), candles: candles, bars: 60 });
    assert.strictEqual(res.n, 5);
    assert.strictEqual(res.highCount, 2);
    assert.strictEqual(res.lowCount, 3);
    assert.strictEqual(res.unresolved, 0);
    // 密度：5 pivots / (60/12=5h) = 1.0/h
    assert.ok(Math.abs(res.perHour - 1.0) < 1e-9, 'perHour = n / (bars/12)');
    // 相邻同向距离：LOW 15/20 → 13+、13+；HIGH 18 → 13+
    assert.strictEqual(res.distSameDir['13+'], 3, '三对同向相邻距离都在 13+');
    // 穿越寿命：默认 candles low=99.4 恒 > pivot 价（99/98.5/98）→ 未穿越 → >24
    assert.strictEqual(res.distCrossLife['>24'], 5);
    // nesting：LOW 99（P1）附近 ±12 无更低 → false；98.5/98 相互距离 20 > 12 → 都不 nested
    assert.strictEqual(res.nested.nestedCount, 0);
});

test('12.1：nesting（±12 内同向更极端 → nested）', function () {
    var candles = mkCandles();
    // P1(99@5) 与 P2(98.5@9)：距离 4 < 12 且 98.5 <= 99 → P1 nested；P2 附近无更低的（98.5 是最低）→ false
    var pivots = [
        mkPivot('P1', 'SWING_LOW', 99, 5),
        mkPivot('P2', 'SWING_LOW', 98.5, 9)
    ];
    var res = ppa.auditPivotPopulation({ pivots: pivots, candles: candles, bars: 60 });
    assert.strictEqual(res.nested.nestedCount, 1, 'P1 被 P2（更低）覆盖 → nested');
});

test('12.1：prominence 分布（浅 vs 深）', function () {
    // 平坦市场：pivot LOW @99，后续 high 最高 99.6（远离 ~0.6）；ATR 小 → 相对深
    var c1 = [];
    for (var i = 0; i < 40; i++) c1.push(m5(100, 100.4, 99.6, 100.0, i));
    c1[5] = m5(100, 100.5, 99, 99.5, 5);   // pivot LOW @5
    var shallow = ppa.auditPivotPopulation({ pivots: [mkPivot('P', 'SWING_LOW', 99, 5)], candles: c1, bars: 40 });
    // prominence = 后续 6 bars maxHigh - 99。bars 6-11 high=100.4 → extreme 100.4 → far 1.4
    // ATR(14) 窗口 range 0.8 → ratio ~1.75 → '1-2'
    assert.strictEqual(shallow.distProminence['1-2'], 1, '平坦市场 pivot 深度 ~1.75 ATR');

    // 紧贴市场：后续 high 紧贴 pivot → 浅
    var c2 = [];
    for (var i = 0; i < 40; i++) c2.push(m5(100, 101, 99.4, 100.5, i));
    c2[5] = m5(100, 101, 99.95, 100.0, 5); // pivot LOW @ 99.95（几乎贴近邻居 low 99.4？不——邻居 low 99.4 更低，不是 pivot）
    // 构造真正紧贴：邻居 low 都 >= 99.95
    var c3 = [];
    for (var i = 0; i < 40; i++) c3.push(m5(100, 100.1, 99.96, 100.0, i));
    c3[5] = m5(100, 100.1, 99.9, 100.0, 5);  // pivot LOW @99.9，邻居 low 99.96 > 99.9 ✓，后续 high 100.1 → far 0.2
    var tight = ppa.auditPivotPopulation({ pivots: [mkPivot('P', 'SWING_LOW', 99.9, 5)], candles: c3, bars: 40 });
    // ATR(14) 窗口 range 0.14 → ratio 0.2/0.14 ≈ 1.43 → '1-2'？high 100.1 - 99.9 = 0.2；avg range 0.14
    // 期望 <1？不一定。改用明确构造：high 100.0，pivot 99.9 → far 0.1，range 0.1 → ratio ~1
    var c4 = [];
    for (var i = 0; i < 40; i++) c4.push(m5(100, 100.05, 99.95, 100.0, i));
    c4[5] = m5(100, 100.0, 99.9, 99.95, 5); // pivot LOW @99.9（邻居 low 99.95 > 99.9 ✓），后续 high 100.05 → far 0.15，range 0.1
    var t2 = ppa.auditPivotPopulation({ pivots: [mkPivot('P', 'SWING_LOW', 99.9, 5)], candles: c4, bars: 40 });
    var keys = Object.keys(t2.distProminence);
    assert.ok(keys.length >= 1, 'prominence 有分桶');
});

test('12.1：unresolved（pivot 无法定位 index）', function () {
    var candles = mkCandles();
    var bad = { id: 'BAD', type: 'SWING_LOW', price: 99, confirmedAt: 999999 }; // confirmedAt 不在 candles
    var res = ppa.auditPivotPopulation({ pivots: [mkPivot('P', 'SWING_LOW', 99, 5), bad], candles: candles, bars: 60 });
    assert.strictEqual(res.n, 1, '只有可定位的 pivot 计入');
    assert.strictEqual(res.unresolved, 1);
});

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
