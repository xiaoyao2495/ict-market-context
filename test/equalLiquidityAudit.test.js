/**
 * Phase 11L.17 — Equal Liquidity Quality Audit 测试
 *
 * 覆盖：
 *   - 6 个维度判定函数（touchCount / clusterWidth / formationSpan / ageBeforeSweep /
 *     reactionStrength / cleanliness），含 leakage 防护（sweep 后信息不可见）
 *   - 聚合：只统计 EQL/EQH 类 sweep、unresolved、维度 true/false 分组、命中数分布
 */
var assert = require('assert');
var eqa = require('../stats/equalLiquidityAudit');

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
function mkMember(id, price, idx, confIdx) {
    return { id: id, symbol: 'X', timeframe: '5m', type: 'SWING_LOW', side: 'SSL', price: price,
        sourceOpenTime: 1000000 + idx * BAR, sourceCloseTime: 1000000 + confIdx * BAR + BAR - 1,
        confirmedAt: 1000000 + confIdx * BAR + BAR - 1, metadata: { index: idx, source: 'futures' } };
}
function mkEqual(id, type, price, members) {
    var minPrice = Infinity;
    var maxPrice = -Infinity;
    var maxConfirmed = 0;
    var minOpen = Infinity;
    var maxClose = 0;
    members.forEach(function (m) {
        if (m.price < minPrice) minPrice = m.price;
        if (m.price > maxPrice) maxPrice = m.price;
        if (m.confirmedAt > maxConfirmed) maxConfirmed = m.confirmedAt;
        if (m.sourceOpenTime < minOpen) minOpen = m.sourceOpenTime;
        if (m.sourceCloseTime > maxClose) maxClose = m.sourceCloseTime;
    });
    return { id: id, symbol: 'X', timeframe: '5m', type: type, side: type === 'EQL' ? 'SSL' : 'BSL',
        price: price, sourceOpenTime: minOpen, sourceCloseTime: maxClose, confirmedAt: maxConfirmed,
        metadata: { minPrice: minPrice, maxPrice: maxPrice, memberCount: members.length, members: members } };
}
function mkSweep(id, lid, type, idx) {
    return { id: id, symbol: 'X', timeframe: '5m', type: 'LIQUIDITY_SWEEP', side: type === 'EQL' ? 'SSL' : 'BSL',
        liquidityId: lid, candleIndex: idx, confirmedAt: 1000000 + idx * BAR + BAR - 1, price: 99,
        source: { liquidityId: lid, liquidityType: type, liquidityPrice: 99 } };
}
function mkMss(id, dir, idx) {
    return { id: id, direction: dir, candleIndex: idx, confirmedAt: 1000000 + idx * BAR + BAR - 1,
        source: { referenceSwingId: 'S', referencePrice: 99 } };
}
function mkAlert(id, dir, anchorIdx) {
    return { id: id, direction: dir, anchorIndex: anchorIdx, tier: 'HIGH_QUALITY' };
}

/* ---------- 维度判定 ---------- */

test('11L.17：isEqualType（母样本筛选）', function () {
    assert.strictEqual(eqa.isEqualType('EQL'), true);
    assert.strictEqual(eqa.isEqualType('EQH'), true);
    assert.strictEqual(eqa.isEqualType('SWING_LOW'), false);
    assert.strictEqual(eqa.isEqualType(null), false);
});

test('11L.17：touchCountDim（2 touch vs 3+ touch）', function () {
    var e2 = mkEqual('E1', 'EQL', 99, [mkMember('m1', 99, 5, 7), mkMember('m2', 99, 10, 12)]);
    var e3 = mkEqual('E2', 'EQL', 99, [mkMember('m1', 99, 5, 7), mkMember('m2', 99, 10, 12), mkMember('m3', 99.05, 14, 15)]);
    assert.strictEqual(eqa.touchCountDim(e2), false, '2 members → 2-touch');
    assert.strictEqual(eqa.touchCountDim(e3), true, '3 members → 3+ touch');
});

test('11L.17：clusterWidthDim（width/tolerance 松紧）', function () {
    // price 100：tol = max(100*0.0002, tick*2)。BTC tickSize=0.1 → tol=0.2
    var loose = mkEqual('E1', 'EQL', 100, [mkMember('m1', 99.75, 5, 7), mkMember('m2', 100.25, 10, 12)]);
    var tight = mkEqual('E2', 'EQL', 100, [mkMember('m1', 99.999, 5, 7), mkMember('m2', 100.001, 10, 12)]);
    assert.strictEqual(eqa.clusterWidthDim(loose, eqa.cfgOf({})), true, 'width 0.5 / tol 0.2 = 2.5 → loose');
    assert.strictEqual(eqa.clusterWidthDim(tight, eqa.cfgOf({})), false, 'width 0.002 / tol 0.2 = 0.01 → tight');
});

test('11L.17：formationSpanDim（成员时间跨度）', function () {
    var slow = mkEqual('E1', 'EQL', 99, [mkMember('m1', 99, 0, 2), mkMember('m2', 99, 15, 17)]);
    var fast = mkEqual('E2', 'EQL', 99, [mkMember('m1', 99, 0, 2), mkMember('m2', 99, 5, 7)]);
    assert.strictEqual(eqa.formationSpanDim(slow, eqa.cfgOf({})), true, '15 bars → slow');
    assert.strictEqual(eqa.formationSpanDim(fast, eqa.cfgOf({})), false, '5 bars → fast');
});

test('11L.17：ageBeforeSweepDim（形成后存活时长）', function () {
    var eq = mkEqual('E1', 'EQL', 99, [mkMember('m1', 99, 0, 2), mkMember('m2', 99, 5, 7)]);
    var oldSweep = mkSweep('W1', 'E1', 'EQL', 55);  // 48 bars 后
    var youngSweep = mkSweep('W2', 'E1', 'EQL', 10); // 3 bars 后
    assert.strictEqual(eqa.ageBeforeSweepDim(eq, oldSweep, eqa.cfgOf({})), true, 'age 48 bars → old');
    assert.strictEqual(eqa.ageBeforeSweepDim(eq, youngSweep, eqa.cfgOf({})), false, 'age 3 bars → young');
});

test('11L.17：reactionStrengthDim（成员 touch 后明显远离）', function () {
    var candles = mkCandles(); // 默认 high=101 low=99.4 close=100.5
    // level 99：成员确认后 high 101 → far 2.0，avg range 1.6 → 1.25 >= 1.0 → strong
    var strong = mkEqual('E1', 'EQL', 99, [mkMember('m1', 99, 3, 5), mkMember('m2', 99, 8, 10)]);
    var se = mkSweep('W1', 'E1', 'EQL', 20);
    var idxByClose = {};
    candles.forEach(function (c, i) { idxByClose[c.closeTime] = i; });
    assert.strictEqual(eqa.reactionStrengthDim(strong, se, candles, idxByClose, eqa.cfgOf({})), true);

    // level 100.8（紧贴高点）：far = 101-100.8 = 0.2，avg range 1.6 → 0.125 < 1.0 → weak
    var weak = mkEqual('E2', 'EQL', 100.8, [mkMember('m1', 100.8, 3, 5), mkMember('m2', 100.8, 8, 10)]);
    assert.strictEqual(eqa.reactionStrengthDim(weak, se, candles, idxByClose, eqa.cfgOf({})), false);

    // 成员确认后窗口延伸进 sweep K 时 clamp（无未来泄漏：不 panic 即可）
    var late = mkEqual('E3', 'EQL', 99, [mkMember('m1', 99, 3, 5), mkMember('m2', 99, 17, 19)]);
    assert.strictEqual(eqa.reactionStrengthDim(late, mkSweep('W3', 'E3', 'EQL', 20), candles, idxByClose, eqa.cfgOf({})), false);
});

test('11L.17：cleanlinessDim（sweep 前 close 穿越 level）', function () {
    var candles = mkCandles();
    var idxByClose = {};
    candles.forEach(function (c, i) { idxByClose[c.closeTime] = i; });
    // level 99：默认 close 100.5 恒在 level 上方 → 无穿越 → clean
    var clean = mkEqual('E1', 'EQL', 99, [mkMember('m1', 99, 0, 2), mkMember('m2', 99, 5, 7)]);
    assert.strictEqual(eqa.cleanlinessDim(clean, mkSweep('W1', 'E1', 'EQL', 20), candles, idxByClose), true);

    // level 100.5：中间 close 从上方（100.5>=level）到下方（构造 bar 12 close=99）再回上方 → crossed
    var c2 = mkCandles();
    c2[12] = m5(100.5, 100.6, 99, 99.2, 12); // close 99.2 < 100.5 → 穿越到下方
    c2[13] = m5(99.2, 100.8, 99.0, 100.6, 13); // close 100.6 >= 100.5 → 穿越回上方
    var idxByClose2 = {};
    c2.forEach(function (c, i) { idxByClose2[c.closeTime] = i; });
    var polluted = mkEqual('E2', 'EQL', 100.5, [mkMember('m1', 100.5, 0, 2), mkMember('m2', 100.5, 5, 7)]);
    assert.strictEqual(eqa.cleanlinessDim(polluted, mkSweep('W2', 'E2', 'EQL', 20), c2, idxByClose2), false);
});

/* ---------- 聚合 ---------- */

test('11L.17：auditEqualLiquidity 集成（分组 + forward 计数）', function () {
    var candles = mkCandles();
    // EQL1：3-touch（bar0/5/14），span 16 bars，sweep bar25，后续 BULLISH MSS bar27 + HIGH bar28
    var eq1 = mkEqual('EQ1', 'EQL', 99.0005,
        [mkMember('m1', 99, 0, 2), mkMember('m2', 99, 5, 7), mkMember('m3', 99.001, 14, 15)]);
    var se1 = mkSweep('W1', 'EQ1', 'EQL', 25);
    var mss = [mkMss('mss1', 'BULLISH', 27)]; // EQL(SSL) → BULLISH 方向匹配
    var alerts = [mkAlert('a1', 'BULLISH', 28)];
    // EQL2：2-touch（bar22/27），span 8 bars，loose（width 0.5/0.2=2.5），sweep bar33，无 forward
    var eq2 = mkEqual('EQ2', 'EQL', 98.25,
        [mkMember('m1', 98, 22, 24), mkMember('m2', 98.5, 27, 29)]);
    var se2 = mkSweep('W2', 'EQ2', 'EQL', 33);

    var res = eqa.auditEqualLiquidity({
        sweepEvents: [se1, se2],
        equalLiquidity: [eq1, eq2],
        mssEvents: mss,
        swings: [mkMember('s1', 99, 5, 7)],
        displacementEvents: [],
        legByDispId: {},
        alerts: alerts,
        candles: candles,
        tickSize: 0.1 // 生产等价：BTC tol = max(price*0.0002, 0.2) = 0.2
    });

    assert.strictEqual(res.nTotal, 2, '2 笔 EQL sweep 全部计入');
    assert.strictEqual(res.unresolved, 0);
    // touchCount：EQ1(3)→t，EQ2(2)→f
    assert.strictEqual(res.dimensionStats.touchCount.t.n, 1);
    assert.strictEqual(res.dimensionStats.touchCount.f.n, 1);
    assert.strictEqual(res.dimensionStats.touchCount.t.mss, 1, '3-touch 组的 BULLISH MSS 计入');
    assert.strictEqual(res.dimensionStats.touchCount.t.high, 1, '3-touch 组的 HIGH 计入');
    // formationSpan：EQ1 span 16 bars → t；EQ2 span 8 bars → f
    assert.strictEqual(res.dimensionStats.formationSpan.t.n, 1);
    assert.strictEqual(res.dimensionStats.formationSpan.f.n, 1);
    // clusterWidth：EQ1 width 0.001/0.2 → tight；EQ2 width 0.5/0.2 → loose
    assert.strictEqual(res.dimensionStats.clusterWidth.f.n, 1);
    assert.strictEqual(res.dimensionStats.clusterWidth.t.n, 1);
    // age：两笔都 young（<48 bars）→ 全 f
    assert.strictEqual(res.dimensionStats.ageBeforeSweep.f.n, 2);
    // cleanliness：两笔 sweep 前都无 close 穿越 → 全 t
    assert.strictEqual(res.dimensionStats.cleanliness.t.n, 2);
    // 命中数：EQ1 = touch+span+reaction+clean = 4；EQ2 = clusterWidth+reaction+clean = 3
    assert.strictEqual(res.countDist[4].n, 1);
    assert.strictEqual(res.countDist[3].n, 1);
    // Quality Gate：EQ1 = tight+young+clean → 3/3；EQ2 = loose → 2/3（young+clean）
    assert.strictEqual(res.qualityDist[3].n, 1);
    assert.strictEqual(res.qualityDist[2].n, 1);
});

test('11L.17：qualityHits（tight+young+clean 组合命中）', function () {
    assert.strictEqual(eqa.qualityHits({ clusterWidth: false, ageBeforeSweep: false, cleanliness: true }), 3, 'tight+young+clean → 3/3');
    assert.strictEqual(eqa.qualityHits({ clusterWidth: true, ageBeforeSweep: false, cleanliness: true }), 2, 'loose → 2/3');
    assert.strictEqual(eqa.qualityHits({ clusterWidth: true, ageBeforeSweep: true, cleanliness: true }), 1, 'loose+old → 1/3');
    assert.strictEqual(eqa.qualityHits({ clusterWidth: true, ageBeforeSweep: true, cleanliness: false }), 0, 'loose+old+crossed → 0/3');
});

test('11L.17：SWING sweep 不计入母样本', function () {
    var eq1 = mkEqual('EQ1', 'EQL', 99, [mkMember('m1', 99, 5, 7), mkMember('m2', 99, 10, 12)]);
    var seSwing = { id: 'W1', liquidityId: 'SWING1', candleIndex: 25,
        confirmedAt: 1000000 + 25 * BAR + BAR - 1, side: 'SSL', price: 99,
        source: { liquidityId: 'SWING1', liquidityType: 'SWING_LOW', liquidityPrice: 99 } };
    var res = eqa.auditEqualLiquidity({
        sweepEvents: [seSwing],
        equalLiquidity: [eq1],
        mssEvents: [], swings: [], displacementEvents: [], legByDispId: {}, alerts: [], candles: mkCandles()
    });
    assert.strictEqual(res.nTotal, 0, 'SWING 类 sweep 不进母样本');
});

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
