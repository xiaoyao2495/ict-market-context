/**
 * Phase 11L.16 — Swing Foundation Shadow Audit 测试
 *
 * 覆盖：
 *   - 5 个维度判定函数（opposing MSS reference / protected / displacement leg /
 *     dealing range / excursion），含 leakage 防护
 *   - 聚合：只统计 SWING 类 sweep、unresolved、维度 true/false 分组、命中数分布
 */
var assert = require('assert');
var sfa = require('../stats/swingFoundationAudit');
var sca = require('../stats/sweepCentricAudit');

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
    for (var i = 0; i < 40; i++) out.push(m5(100, 101, 99.4, 100.5, i));
    return out;
}
function mkSwing(id, type, price, idx, confIdx) {
    return { id: id, symbol: 'X', timeframe: '5m', type: type, side: type === 'SWING_LOW' ? 'SSL' : 'BSL',
        price: price, confirmedAt: 1000000 + confIdx * BAR + BAR - 1, metadata: { index: idx, source: 'futures' } };
}
function mkSweep(id, lid, type, idx, price) {
    return { id: id, symbol: 'X', timeframe: '5m', type: 'LIQUIDITY_SWEEP', side: type === 'SWING_LOW' ? 'SSL' : 'BSL',
        liquidityId: lid, candleIndex: idx, confirmedAt: 1000000 + idx * BAR + BAR - 1, price: price,
        source: { liquidityId: lid, liquidityType: type, liquidityPrice: price } };
}
function mkMss(id, dir, refId, idx) {
    return { id: id, direction: dir, candleIndex: idx, confirmedAt: 1000000 + idx * BAR + BAR - 1,
        source: { referenceSwingId: refId, referencePrice: 99 } };
}
function mkDisp(id, dir, idx) {
    return { id: id, direction: dir, candleIndex: idx, confirmedAt: 1000000 + idx * BAR + BAR - 1 };
}

/* ---------- 维度判定 ---------- */

test('11L.16：hasOpposingMssReference（opposing + sweep 前，leakage 防护）', function () {
    var swing = mkSwing('S1', 'SWING_LOW', 99, 5, 7);
    var se = mkSweep('W1', 'S1', 'SWING_LOW', 12, 99);
    // BEARISH MSS 在 sweep 前引用 S1 → true
    assert.strictEqual(sfa.hasOpposingMssReference(swing, se, [mkMss('m1', 'BEARISH', 'S1', 9)]), true);
    // BULLISH MSS（同向，非 opposing）→ false
    assert.strictEqual(sfa.hasOpposingMssReference(swing, se, [mkMss('m2', 'BULLISH', 'S1', 9)]), false);
    // 其他 swing id → false
    assert.strictEqual(sfa.hasOpposingMssReference(swing, se, [mkMss('m3', 'BEARISH', 'OTHER', 9)]), false);
    // MSS 在 sweep 之后 → false（future leakage 防护）
    assert.strictEqual(sfa.hasOpposingMssReference(swing, se, [mkMss('m4', 'BEARISH', 'S1', 15)]), false);
});

test('11L.16：isProtectedUntilSweep（sweep 前从未被测试）', function () {
    var candles = mkCandles();
    var swing = mkSwing('S1', 'SWING_LOW', 99, 5, 7);
    var se = mkSweep('W1', 'S1', 'SWING_LOW', 12, 99);
    // 默认 idx6-11 low=99.4 > 99 → 从未被测试 → true
    assert.strictEqual(sfa.isProtectedUntilSweep(swing, se, candles, 5), true);
    // idx9 low=98.5 <= 99 → 提前测试过 → false
    var c2 = mkCandles();
    c2[9] = m5(99.9, 100.2, 98.5, 99.8, 9);
    assert.strictEqual(sfa.isProtectedUntilSweep(swing, se, c2, 5), false);
});

test('11L.16：hasOpposingLeg（pivot 后、sweep 前、反向 STRONG/EXPLOSIVE）', function () {
    var candles = mkCandles();
    var idx = sca.buildOutcomeIndex({ mssEvents: [], displacementEvents: [], alerts: [], swings: [], legByDispId: {}, candles: candles });
    idx.idxByClose = {};
    candles.forEach(function (c, i) { idx.idxByClose[c.closeTime] = i; });
    var swing = mkSwing('S1', 'SWING_LOW', 99, 5, 7);
    var se = mkSweep('W1', 'S1', 'SWING_LOW', 12, 99);
    // 无 leg → false
    assert.strictEqual(sfa.hasOpposingLeg(swing, se, idx), false);
    // pivot 后 sweep 前有 BULLISH EXPLOSIVE leg → true
    idx.dispByIndex[8] = [mkDisp('d1', 'BULLISH', 8)];
    idx.legByDispId = { d1: { id: 'd1', quality: 'EXPLOSIVE', startIndex: 8, endIndex: 8 } };
    assert.strictEqual(sfa.hasOpposingLeg(swing, se, idx), true);
    // 方向相同（BEARISH，非反向）→ false
    idx.dispByIndex[8] = [mkDisp('d2', 'BEARISH', 8)];
    idx.legByDispId = { d2: { id: 'd2', quality: 'EXPLOSIVE', startIndex: 8, endIndex: 8 } };
    assert.strictEqual(sfa.hasOpposingLeg(swing, se, idx), false);
    // leg 在 sweep 之后 → false（leakage）
    idx.dispByIndex[14] = [mkDisp('d3', 'BULLISH', 14)];
    idx.legByDispId = { d3: { id: 'd3', quality: 'EXPLOSIVE', startIndex: 14, endIndex: 14 } };
    assert.strictEqual(sfa.hasOpposingLeg(swing, se, idx), false);
});

test('11L.16：excursionAtr（最大远离 / 窗口 ATR）', function () {
    var candles = mkCandles();
    var swing = mkSwing('S1', 'SWING_LOW', 99, 5, 7);
    var se = mkSweep('W1', 'S1', 'SWING_LOW', 12, 99);
    // 默认 high=101 → maxFar=2，range 均值 ~1.6 → ratio ~1.25 >= 1.0 → true
    assert.ok(sfa.excursionAtr(swing, se, candles, 5) >= 1.0, '默认数据 excursion 应 >= 1.0');
    // 窗口内 high 贴近 pivot（maxFar 0.3）、range 正常（0.5）→ ratio 0.6 < 1.0
    var c2 = mkCandles();
    for (var j = 6; j <= 12; j++) c2[j] = m5(98.9, 99.3, 98.8, 99.2, j);
    assert.ok(sfa.excursionAtr(swing, se, c2, 5) < 1.0, '紧贴 pivot → excursion < 1.0');
});

/* ---------- 聚合 ---------- */

test('11L.16：auditSwingFoundation 聚合（只统计 SWING、维度分组、命中数）', function () {
    var candles = mkCandles();
    // s1：STRUCTURAL —— protected(从未测试) + displacementLeg(idx8 BULLISH EXPLOSIVE) + excursion
    //     （mssReference=false：无 opposing MSS；dealingRange=false：htf 远离）
    // s2：INTERNAL —— 快速被扫、提前测试、无 leg、无 HTF、无 excursion（hit=0）
    // s3：EQL sweep —— 不计入母样本
    candles[8] = m5(100.5, 104.0, 100.2, 103.5, 8); // BULLISH leg K（s1 后）
    candles[9] = m5(103.0, 103.5, 102.0, 102.8, 9);
    // s2：窄幅窗口且 high 不高于 pivot（98.5）→ excursion=0；idx16 low 98.0 <= 98.5 → protected=false
    candles[16] = m5(98.4, 98.5, 98.0, 98.3, 16);
    candles[17] = m5(98.3, 98.5, 98.1, 98.4, 17);
    candles[18] = m5(98.4, 98.5, 98.2, 98.4, 18);
    // s1 sweep 后 forward：BULLISH MSS + STRONG leg + HIGH
    candles[14] = m5(103.5, 106.0, 103.0, 105.5, 14);
    var swings = [
        mkSwing('S1', 'SWING_LOW', 99, 5, 7),
        mkSwing('S2', 'SWING_LOW', 98.5, 15, 17)
    ];
    var sweepEvents = [
        mkSweep('W1', 'S1', 'SWING_LOW', 12, 99),
        mkSweep('W2', 'S2', 'SWING_LOW', 18, 98.5),
        mkSweep('W3', 'EQ1', 'EQL', 20, 97.5),   // 非 SWING → 不计
        mkSweep('W4', 'NO_SUCH', 'SWING_LOW', 22, 96) // unresolved
    ];
    var mssEvents = [
        mkMss('m1', 'BULLISH', 'S1', 14) // s1 sweep 后的 BULLISH MSS（forward 用；protected 判定不看 MSS）
    ];
    var displacementEvents = [
        mkDisp('d1', 'BULLISH', 8),   // s1 pivot 后 sweep 前 → 维度③ true
        mkDisp('d2', 'BULLISH', 14)   // s1 sweep 后 → forward StrongLeg
    ];
    var legByDispId = {
        d1: { id: 'd1', quality: 'EXPLOSIVE', startIndex: 8, endIndex: 8 },
        d2: { id: 'd2', quality: 'STRONG', startIndex: 14, endIndex: 14 }
    };
    var alerts = [{ id: 'a1', tier: 'HIGH_QUALITY', direction: 'BULLISH', anchorIndex: 15 }];
    var htfCandles = { '1h': [m5(100, 101, 95, 99, 0)] }; // 极值 95，远离 99 → dealingRange=false

    var res = sfa.auditSwingFoundation({
        sweepEvents: sweepEvents, swings: swings, mssEvents: mssEvents,
        displacementEvents: displacementEvents, legByDispId: legByDispId,
        alerts: alerts, candles: candles, htfCandles: htfCandles
    });

    assert.strictEqual(res.nTotal, 3, 'W1/W2/W4 是 SWING 类（W3 EQL 不计）');
    assert.strictEqual(res.unresolved, 1, 'W4 liquidityId 找不到 swing');
    // 维度：s1 = protected + displacementLeg + excursion（3 维 true）；s2 = 全 false
    assert.strictEqual(res.dimensionStats.protectedSwing.t.n, 1, 's1 从未被测试');
    assert.strictEqual(res.dimensionStats.displacementLeg.t.n, 1, 's1 有反向 EXPLOSIVE leg');
    assert.strictEqual(res.dimensionStats.dealingRange.f.n, 2, 's1/s2 都远离 1h 极值');
    // 命中数分布：s1 hit=3（protected+leg+excursion），s2 hit=0
    assert.strictEqual(res.countDist[3].n, 1, 's1 命中 3 维');
    assert.strictEqual(res.countDist[0].n, 1, 's2 命中 0 维');
    // forward（1h 窗口 sweep 后）：s1 有 BULLISH MSS + STRONG leg + HIGH
    assert.strictEqual(res.countDist[3].mss, 1);
    assert.strictEqual(res.countDist[3].strongLeg, 1);
    assert.strictEqual(res.countDist[3].high, 1);
    assert.strictEqual(res.countDist[0].mss, 0, 's2 无 forward delivery');
});

/* ---------- 汇总 ---------- */

console.log('---');
if (failed === 0) {
    console.log('ALL TESTS PASSED (' + passed + ')');
} else {
    console.log('SOME TESTS FAILED (' + failed + '/' + (passed + failed) + ')');
}
process.exit(failed === 0 ? 0 : 1);
