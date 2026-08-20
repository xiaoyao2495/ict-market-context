/**
 * Phase 12.3 — DC Structural Swing MSS Shadow 测试
 *
 * 覆盖：
 *   - 【future-safety 专项（用户强制）】：DC swing 确认前价格越位不得产生 MSS；
 *     所有 MSS 的 referenceSwing.confirmedAt <= 该 MSS candle 的 closeTime（evalTime）
 *   - churn 计数（30min 翻转 / churn 簇 / 同向短重复）
 *   - structureStats 字段（n/bull/bear/refSwingCount/gap/breakPct）
 *   - deliveryStats（displacement 命中 / MFE / MAE / 同套后续同向 MSS）
 *   - buildDcMss 集成（两套 swings 各自跑 detectMss）
 */
var assert = require('assert');
var dcMssShadow = require('../stats/dcMssShadow');

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
function mkSwing(id, type, price, confirmedAt) {
    return { id: id, symbol: 'X', timeframe: '5m', type: type, price: price, confirmedAt: confirmedAt };
}
function mkMss(id, dir, idx, refId, refPrice, breakPct, bodyRatio, closeStrength) {
    return {
        id: id, direction: dir, candleIndex: idx, confirmedAt: 1000000 + idx * BAR + BAR - 1,
        source: { referenceSwingId: refId, referencePrice: refPrice, breakPct: breakPct },
        metadata: { bodyRatio: bodyRatio, closeStrength: closeStrength }
    };
}

/* ---------- future-safety 专项 ---------- */

test('12.3【future-safety】：DC swing 确认前不得产生 MSS；reference 确认时点 <= MSS evalTime', function () {
    // ATR ≈ 1.0（每根 range 1.0）；extreme high=100 @bar5；bar6-15 缓慢回落，bar15 close 98.6 回撤 1.4 >= 1.0×1 → 确认于 bar15
    var out = [];
    var p = 99;
    for (var i = 0; i < 6; i++) {
        var hi = i === 5 ? 100 : 99.9;
        var lo = hi - 1.0;
        var c = hi - 0.5;
        out.push(mkBar(i, p, hi, lo, c));
        p = c;
    }
    for (var j = 6; j < 16; j++) {
        var hi = 99.5;
        var lo = hi - 1.0;
        var c = 99.5 - (j - 6) * 0.1;
        out.push(mkBar(j, p, hi, lo, c));
        p = c;
    }
    // bar16+ close 突破 100（body 1.6/range 1.8 → bodyRatio 0.89，directional bullish）
    for (var k = 16; k < 20; k++) {
        var hi = 100.8;
        var lo = 99.0;
        var c = 100.2;
        out.push(mkBar(k, p, hi, lo, c));
        p = c;
    }

    var shadow = dcMssShadow.buildDcMss(out, [], { symbol: 'X', timeframe: '5m', k: 1.0 });
    assert.strictEqual(shadow.dc.swings.length, 2, 'HIGH@100（bar15 确认）+ LOW@98.5（bar16 反弹确认）');
    var sw = shadow.dc.swings[0];
    assert.strictEqual(sw.type, 'SWING_HIGH');
    // swing 确认于 bar11（bar11 close 99.0 → 回撤 1.0 >= ATR(1.0)）
    var confIdx = Math.round((sw.confirmedAt - 1000000 - (BAR - 1)) / BAR);
    assert.strictEqual(confIdx, 11, 'DC swing 应确认于 bar11（reversal close 达 1 ATR）');

    var mss = shadow.dc.mss;
    // future-safety 核心：MSS 只能在 swing 确认 + close 突破之后产生（bar16）
    assert.strictEqual(mss.length, 1, 'bar15 前不得有 MSS');
    assert.strictEqual(mss[0].candleIndex, 16, '第一个 MSS 出现在 bar16（swing 已确认且 close 突破）');
    // 引用完整性：referenceSwing.confirmedAt <= MSS 所在 bar 的 closeTime（evalTime）
    var ref = shadow.dc.swings.filter(function (s) { return s.id === mss[0].source.referenceSwingId; })[0];
    assert.ok(ref, 'MSS 引用已确认的 DC swing');
    var mssBarClose = out[mss[0].candleIndex].closeTime;
    assert.ok(ref.confirmedAt <= mssBarClose, 'referenceSwing.confirmedAt <= MSS evalTime（future-safety）');
});

/* ---------- churn 计数 ---------- */

test('12.3：structureStats churn（30min 翻转 / 簇 / 同向短重复）', function () {
    // B@10 S@13 B@16 S@19：间隔 3 bars，连续翻转 → flips=3, clusters=1, sameDirShort=0
    var mss1 = [
        mkMss('m1', 'BULLISH', 10, 's1', 100, 0.002, 0.7, 0.8),
        mkMss('m2', 'BEARISH', 13, 's2', 99, 0.002, 0.7, 0.8),
        mkMss('m3', 'BULLISH', 16, 's3', 100, 0.002, 0.7, 0.8),
        mkMss('m4', 'BEARISH', 19, 's4', 99, 0.002, 0.7, 0.8)
    ];
    var st1 = dcMssShadow.structureStats(mss1, 1);
    assert.strictEqual(st1.churnFlips, 3, 'B→S→B→S 三次翻转');
    assert.strictEqual(st1.churnClusters, 1, '4 连翻转 = 1 个 churn 簇');
    assert.strictEqual(st1.sameDirShort, 0);
    assert.strictEqual(st1.n, 4);
    assert.strictEqual(st1.bull, 2);
    assert.strictEqual(st1.bear, 2);
    assert.strictEqual(st1.refSwingCount, 4);
    assert.strictEqual(st1.gapMedian, 3);
    assert.strictEqual(st1.breakPctMedian, 0.002);

    // 同向短重复：B@10 B@12（间隔 2 <= 6）→ sameDirShort=1
    var mss2 = [
        mkMss('m1', 'BULLISH', 10, 's1', 100, 0.002, 0.7, 0.8),
        mkMss('m2', 'BULLISH', 12, 's2', 100.5, 0.002, 0.7, 0.8)
    ];
    var st2 = dcMssShadow.structureStats(mss2, 1);
    assert.strictEqual(st2.sameDirShort, 1, '同向且 <= 30min → 短重复');

    // 间隔 > 6 的翻转不算 churn：B@10 S@20（间隔 10）
    var mss3 = [
        mkMss('m1', 'BULLISH', 10, 's1', 100, 0.002, 0.7, 0.8),
        mkMss('m2', 'BEARISH', 20, 's2', 99, 0.002, 0.7, 0.8)
    ];
    var st3 = dcMssShadow.structureStats(mss3, 1);
    assert.strictEqual(st3.churnFlips, 0, '间隔 10 > 6 → 不算 churn flip');
});

/* ---------- deliveryStats ---------- */

test('12.3：deliveryStats（displacement 命中 / MFE / MAE / 同套后续同向 MSS）', function () {
    var candles = [];
    var p = 100;
    for (var i = 0; i < 30; i++) {
        // 默认窄幅；bar 12 后强涨
        var hi = i >= 12 ? 103 : 100.5;
        var lo = i >= 12 ? 100 : 99.5;
        var c = i >= 12 ? 102.5 : 100;
        candles.push(mkBar(i, p, hi, lo, c));
        p = c;
    }
    var disp = [{ id: 'd1', direction: 'BULLISH', candleIndex: 14 }];
    var legByDispId = { d1: { id: 'd1', quality: 'STRONG' } };
    var dispByIndex = {};
    disp.forEach(function (d) { dispByIndex[d.candleIndex] = [d]; });

    var mss = [mkMss('m1', 'BULLISH', 12, 's1', 100, 0.002, 0.7, 0.8)];
    var st = dcMssShadow.deliveryStats(mss, candles, { dispByIndex: dispByIndex, legByDispId: legByDispId });
    assert.strictEqual(st.dispStrongRate, 1, '1h 内 STRONG displacement 命中');
    assert.ok(st.mfeMean > 0, '顺向 MFE > 0');
    assert.strictEqual(st.nextSameDirMssRate, 0, '同套后续无同向 MSS');
});

/* ---------- buildDcMss 集成 ---------- */

test('12.3：buildDcMss 集成（legacy vs DC 两套各自跑 MSS）', function () {
    // 锯齿 candles + legacy 2-2 swings
    var out = [];
    var price = 100;
    var dir = 1;
    for (var i = 0; i < 80; i++) {
        if (i > 0 && i % 10 === 0) dir *= -1;
        var step = 10 / 10;
        var target = i === 0 ? price : price + dir * step;
        var open = i === 0 ? price : out[i - 1].close;
        var close = target;
        out.push(mkBar(i, open, Math.max(open, close) + 0.2, Math.min(open, close) - 0.2, close));
        price = target;
    }
    // legacy swings：在每段峰谷放 2-2 包装的 swing（近似即可，检测逻辑与 swings 数量解耦）
    var legacySwings = [
        mkSwing('S_H1', 'SWING_HIGH', 104.5, 1000000 + 10 * BAR + BAR - 1),
        mkSwing('S_L1', 'SWING_LOW', 95.5, 1000000 + 20 * BAR + BAR - 1),
        mkSwing('S_H2', 'SWING_HIGH', 104.5, 1000000 + 30 * BAR + BAR - 1),
        mkSwing('S_L2', 'SWING_LOW', 95.5, 1000000 + 40 * BAR + BAR - 1),
        mkSwing('S_H3', 'SWING_HIGH', 104.5, 1000000 + 50 * BAR + BAR - 1),
        mkSwing('S_L3', 'SWING_LOW', 95.5, 1000000 + 60 * BAR + BAR - 1)
    ];
    var shadow = dcMssShadow.buildDcMss(out, legacySwings, { symbol: 'X', timeframe: '5m', k: 1.0 });
    assert.ok(shadow.dc.swings.length > 0, 'DC swings 生成');
    assert.ok(shadow.dc.mss.length >= 0, 'DC MSS 可空');
    assert.ok(Array.isArray(shadow.legacy.mss), 'legacy MSS 数组');
    assert.strictEqual(shadow.k, 1.0);
    // 两套 MSS 无交叉引用污染（id 命名空间隔离）
    var legacyIds = {};
    shadow.legacy.mss.forEach(function (m) { legacyIds[m.source.referenceSwingId] = true; });
    shadow.dc.mss.forEach(function (m) {
        assert.ok(!legacyIds[m.source.referenceSwingId], 'DC MSS 不引用 legacy swing');
    });
});

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
