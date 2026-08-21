/**
 * Phase 13 — Draw on Liquidity Quantification 测试
 *
 * 覆盖：
 *   - normalizeCandidates：registry 对象 + DC swings 统一（类型映射/confirmBar 解析）
 *   - buildCandidateIndex：首次穿越 bar（raidBar）+ touch/cross 数组
 *   - isActiveAt：确认前不 ACTIVE、被 take 后不 ACTIVE（生命周期纪律）
 *   - extractFeatures：distanceATR / age / touch/cross / zone / htfStructure / alignment
 *     （feature 全部截至 t，无未来）
 *   - futureLabel：未来第一个被 raid 的候选；label 只进 label 不进 feature
 *   - auditDrawLiquidity：基线对比（最近距离 vs 随机）+ 分布
 */
var assert = require('assert');
var dla = require('../stats/drawLiquidityAudit');

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
function mkBar(i, open, high, low, close) {
    var t = 1000000 + i * BAR;
    return { openTime: t, open: open, high: high, low: low, close: close, closeTime: t + BAR - 1, closed: true };
}
// 模拟 normalizeCandidates 后的候选（含 confirmBar）
function mkLiq(id, type, side, price, confirmBar) {
    return { id: id, type: type, side: side, price: price,
        confirmedAt: 1000000 + confirmBar * BAR + BAR - 1,
        confirmBar: confirmBar,
        status: 'ACTIVE', touchedAt: null, sweptAt: null, brokenAt: null,
        metadata: {}, source: 'registry' };
}

/* ---------- normalizeCandidates ---------- */

test('13：normalizeCandidates（registry + DC 统一，confirmBar 解析）', function () {
    var candles = [];
    for (var i = 0; i < 60; i++) candles.push(mkBar(i, 100, 101, 99, 100.5));
    var liqs = [
        mkLiq('L1', 'PDH', 'BSL', 105, 5),
        mkLiq('L2', 'PDL', 'SSL', 95, 7)
    ];
    var dcRaw = [
        { direction: 'HIGH', price: 110, extremeIndex: 10, occurredAt: 10, confirmedAt: 12,
            replacements: 1, extremeATR: 2 }
    ];
    var dcSwings = dcRaw.map(function (r) {
        return { id: 'X:DC:SWING_HIGH:12:10', type: 'SWING_HIGH', side: 'BSL', price: r.price,
            confirmedAt: 1000000 + 12 * BAR + BAR - 1, metadata: { index: 12, source: 'dc' } };
    });
    var cs = dla.normalizeCandidates(liqs, dcSwings, candles);
    assert.strictEqual(cs.length, 3);
    var dc = cs[2];
    assert.strictEqual(dc.type, 'DC_SWING_HIGH', 'DC swing 类型映射');
    assert.strictEqual(dc.source, 'dc');
    assert.strictEqual(dc.confirmBar, 12, 'confirmBar 从 metadata.index 解析');
    assert.strictEqual(cs[0].confirmBar, 5);
    assert.strictEqual(cs[1].side, 'SSL');
});

/* ---------- buildCandidateIndex ---------- */

test('13：buildCandidateIndex（raidBar 首次穿越 + touch/cross 记录）', function () {
    var candles = [];
    for (var i = 0; i < 40; i++) candles.push(mkBar(i, 100, 101, 99, 100.5));
    candles[10] = mkBar(10, 100, 108, 99, 103);  // high 108 → BSL @105 raid
    candles[11] = mkBar(11, 103, 109, 102, 106); // close 106 >= 105 → cross 于 bar11
    var cs = [mkLiq('B1', 'EQH', 'BSL', 105, 4)];
    var idx = dla.buildCandidateIndex(cs, candles);
    assert.strictEqual(idx['B1'].raidBar, 10, '首次穿越 bar10');
    assert.deepStrictEqual(idx['B1'].touchBars, [10, 11]);
    assert.deepStrictEqual(idx['B1'].crossBars, [11], '收盘穿越 bar11（bar10 close 103 < 105）');
});

/* ---------- isActiveAt（生命周期纪律） ---------- */

test('13：isActiveAt（确认前不 ACTIVE / take 后不 ACTIVE / sweptAt 防御）', function () {
    var candles = [];
    for (var i = 0; i < 40; i++) candles.push(mkBar(i, 100, 101, 99, 100.5));
    candles[10] = mkBar(10, 100, 108, 99, 100); // BSL @105 raid 于 bar10
    var cs = [mkLiq('B1', 'EQH', 'BSL', 105, 4)];
    var idx = dla.buildCandidateIndex(cs, candles);
    assert.strictEqual(dla.isActiveAt(cs[0], idx, 3, candles), false, '确认前（bar3 < confirm bar4）不 ACTIVE');
    assert.strictEqual(dla.isActiveAt(cs[0], idx, 9, candles), true, '确认后未 take → ACTIVE');
    assert.strictEqual(dla.isActiveAt(cs[0], idx, 10, candles), false, 'raid bar10 → 已被 take 不再 ACTIVE');
    // sweptAt 防御：价格未穿越但 registry 标记 swept
    var cs2 = [mkLiq('B2', 'PDH', 'BSL', 200, 4)]; // price 200 永不被穿越
    var idx2 = dla.buildCandidateIndex(cs2, candles);
    cs2[0].sweptAt = 1000000 + 20 * BAR + BAR - 1; // bar20 swept
    assert.strictEqual(dla.isActiveAt(cs2[0], idx2, 19, candles), true, 'swept 前 ACTIVE');
    assert.strictEqual(dla.isActiveAt(cs2[0], idx2, 20, candles), false, 'sweptAt <= t → 淘汰');
});

/* ---------- extractFeatures（无未来） ---------- */

test('13：extractFeatures（distanceATR/age/touch/cross/zone/htf/alignment，feature 全部截至 t）', function () {
    var candles = [];
    for (var i = 0; i < 40; i++) candles.push(mkBar(i, 100, 101, 99, 100.5));
    candles[8] = mkBar(8, 100, 105.5, 99, 100);  // touch BSL @105（high 105.5）
    var cs = [mkLiq('B1', 'EQH', 'BSL', 105, 4)];
    var idx = dla.buildCandidateIndex(cs, candles);
    var ctx = {
        candles: candles,
        atrAt: function () { return 2; },
        htfTrend: { 20: { h1Up: true, h4Up: true } },
        rangeHi: 110, rangeLo: 90,
        lastDispDir: { 20: 'BULLISH' }
    };
    var f = dla.extractFeatures(cs[0], idx['B1'], ctx, 20);
    assert.strictEqual(f.type, 'EQH');
    assert.strictEqual(f.side, 'BSL');
    assert.strictEqual(f.distanceATR, 2.25, '(105 - 100.5)/2');
    assert.strictEqual(f.ageBars, 16, 'bar20 - confirm bar4');
    assert.strictEqual(f.touchCount, 1, 'bar8 触及一次（bar20 的 high 101 未触及 105）');
    assert.strictEqual(f.closeCrossCount, 0);
    assert.strictEqual(f.zone, 'EQ', '(100.5-90)/(110-90)=0.525 → 0.45-0.55 区间 = EQ');
    assert.strictEqual(f.htfStructure, 'BULLISH');
    assert.strictEqual(f.deliveryAlignment, 'MATCH', 'BSL 上方 + 最近 BULLISH displacement → MATCH');
});

/* ---------- futureLabel ---------- */

test('13：futureLabel（未来第一个被 raid 的候选；label 独立于 feature）', function () {
    var candles = [];
    for (var i = 0; i < 40; i++) candles.push(mkBar(i, 100, 101, 99, 100.5));
    candles[12] = mkBar(12, 100, 106, 99, 100);  // BSL1 @105 raid bar12
    candles[20] = mkBar(20, 100, 101, 94, 100);  // SSL1 @95 raid bar20
    var cs = [
        mkLiq('B1', 'EQH', 'BSL', 105, 4),
        mkLiq('S1', 'PDL', 'SSL', 95, 6)
    ];
    var idx = dla.buildCandidateIndex(cs, candles);
    // t=8：两个都 ACTIVE，B1 raid bar12 < S1 raid bar20 → nextDraw = B1(BSL)
    var actives8 = cs.filter(function (c) { return dla.isActiveAt(c, idx, 8, candles); });
    var lb8 = dla.futureLabel(actives8, idx, 8);
    assert.strictEqual(lb8.nextSide, 'BSL');
    assert.strictEqual(lb8.nextType, 'EQH');
    assert.strictEqual(lb8.barsToRaid, 4, 'raid bar12 - t8');
    // t=15：B1 已被 take（raid 12 <= 15），只剩 S1 → nextDraw = SSL
    var actives15 = cs.filter(function (c) { return dla.isActiveAt(c, idx, 15, candles); });
    assert.strictEqual(actives15.length, 1, 'B1 已被 take 出池');
    var lb15 = dla.futureLabel(actives15, idx, 15);
    assert.strictEqual(lb15.nextSide, 'SSL');
    assert.strictEqual(lb15.nextType, 'PDL');
});

/* ---------- auditDrawLiquidity（基线对比） ---------- */

test('13：auditDrawLiquidity（基线：最近距离 vs 随机；分布输出）', function () {
    var candles = [];
    for (var i = 0; i < 60; i++) candles.push(mkBar(i, 100, 101, 99, 100.5));
    candles[12] = mkBar(12, 100, 106, 99, 100);  // BSL @105 raid bar12
    candles[22] = mkBar(22, 100, 101, 94, 100);  // SSL @95 raid bar22
    candles[30] = mkBar(30, 100, 108, 99, 100);  // BSL @105 再次 raid（后续）
    var liqs = [
        mkLiq('B1', 'EQH', 'BSL', 105, 4),
        mkLiq('S1', 'PDL', 'SSL', 95, 6)
    ];
    var atrSeries = {};
    candles.forEach(function (c, i) { atrSeries[i] = 2; });
    var htfTrend = {};
    candles.forEach(function (c, i) { htfTrend[i] = { h1Up: true, h4Up: true }; });
    var res = dla.auditDrawLiquidity({
        candles: candles,
        liquidityObjects: liqs,
        dcSwings: [],
        htfTrend: htfTrend,
        htf1hCandles: [],
        displacementEvents: [],
        atrSeries: atrSeries,
        startIndex: 0
    });
    assert.ok(res.n > 0, '有 label 的 bar 数 > 0');
    assert.ok(res.accuracyNearest !== null && res.accuracyNearest >= 0 && res.accuracyNearest <= 1);
    assert.ok(res.accuracyRandom !== null && res.accuracyRandom >= 0 && res.accuracyRandom <= 1);
    assert.ok(res.sideDist.BSL !== undefined || res.sideDist.SSL !== undefined, 'side 分布存在');
    // 最近距离基线：t=8 时 BSL @105 距离 4.5、SSL @95 距离 5.5 → 预测 BSL（实际 BSL）✓
    // t=13 后 BSL 被 take（raid 12）→ 只剩 SSL → 预测 SSL（实际 SSL）✓ —— 最近距离应显著好于随机
    assert.ok(res.accuracyNearest > 0.5, '最近距离基线应 > 随机（构造倾向）；实际 ' + res.accuracyNearest);
    // Phase 13.1：分桶统计存在且聚合正确
    var totalBuckets = Object.keys(res.bucketStats).reduce(function (s, k) { return s + res.bucketStats[k].n; }, 0);
    assert.strictEqual(totalBuckets, res.n, '分桶 n 之和 = 总 label 数');
});

/* ---------- Phase 13.1：净化 + 分桶 ---------- */

test('13.1：excludeLegacySwing 净化（排除 legacy SWING，保留 DC_SWING/EQH/PDL 等）', function () {
    var candles = [];
    for (var i = 0; i < 60; i++) candles.push(mkBar(i, 100, 101, 99, 100.5));
    candles[12] = mkBar(12, 100, 106, 99, 100);
    candles[22] = mkBar(22, 100, 101, 94, 100);
    candles[30] = mkBar(30, 100, 108, 99, 100);
    var liqs = [
        mkLiq('L1', 'SWING_HIGH', 'BSL', 105, 4),  // legacy 2-2 → 净化后排除
        mkLiq('L2', 'PDL', 'SSL', 95, 6)
    ];
    var dcRaw = [{ direction: 'HIGH', price: 108, extremeIndex: 10, occurredAt: 10, confirmedAt: 12, replacements: 1, extremeATR: 2 }];
    var dcSwings = dcRaw.map(function (r) {
        return { id: 'X:DC:SWING_HIGH:12:10', type: 'SWING_HIGH', side: 'BSL', price: r.price,
            confirmedAt: 1000000 + 12 * BAR + BAR - 1, metadata: { index: 12, source: 'dc' } };
    });
    var atrSeries = {};
    candles.forEach(function (c, i) { atrSeries[i] = 2; });
    var htfTrend = {};
    candles.forEach(function (c, i) { htfTrend[i] = { h1Up: true, h4Up: true }; });
    // V1 全池
    var resV1 = dla.auditDrawLiquidity({
        candles: candles, liquidityObjects: liqs, dcSwings: dcSwings,
        htfTrend: htfTrend, htf1hCandles: [], displacementEvents: [], atrSeries: atrSeries, startIndex: 0
    });
    // 净化
    var res13 = dla.auditDrawLiquidity({
        candles: candles, liquidityObjects: liqs, dcSwings: dcSwings,
        htfTrend: htfTrend, htf1hCandles: [], displacementEvents: [], atrSeries: atrSeries,
        startIndex: 0, excludeLegacySwing: true
    });
    assert.ok(resV1.n > 0, 'V1 全池有 label');
    assert.ok(res13.n > 0, '净化后仍有 label（DC_SWING/PDL 保留）');
    // typeDist 不应含 legacy SWING
    assert.strictEqual(res13.typeDist.SWING_HIGH, undefined, '净化后 nextType 无 legacy SWING_HIGH');
    assert.strictEqual(res13.typeDist.SWING_LOW, undefined, '净化后 nextType 无 legacy SWING_LOW');
    assert.ok(res13.typeDist.PDL !== undefined || res13.typeDist.DC_SWING_HIGH !== undefined, '净化后 label 来自 significant');
    // 分桶（barsToRaid 分桶聚合）
    var totalB = Object.keys(res13.bucketStats).reduce(function (s, k) { return s + res13.bucketStats[k].n; }, 0);
    assert.strictEqual(totalB, res13.n, '净化模式分桶 n 之和 = label 数');
});

test('13.1：raidBucketOf 分桶边界（30m/1h/4h/24h）', function () {
    assert.strictEqual(dla.raidBucketOf(1), '30m');
    assert.strictEqual(dla.raidBucketOf(6), '30m');
    assert.strictEqual(dla.raidBucketOf(7), '1h');
    assert.strictEqual(dla.raidBucketOf(12), '1h');
    assert.strictEqual(dla.raidBucketOf(13), '4h');
    assert.strictEqual(dla.raidBucketOf(48), '4h');
    assert.strictEqual(dla.raidBucketOf(49), '24h');
    assert.strictEqual(dla.raidBucketOf(288), '24h');
    assert.strictEqual(dla.raidBucketOf(289), '>24h');
});

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
