/**
 * Phase 12.4 — Structural Swing Integration Shadow 测试
 *
 * 覆盖：
 *   - quadrantSplit（BOTH / LEGACY_ONLY / DC_ONLY，方向 + anchor 容差）
 *   - assessQuadrant（NearHit30m/1h、MFE/MAE、hasStrong/strongDispPerAlert、breakPct）
 *   - buildShadowAlerts 集成（两套完整链路：swings → MSS → displacement → alerts）
 */
var assert = require('assert');
var ssi = require('../stats/structuralSwingIntegration');

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
function mkAlert(id, dir, anchorIdx, availIdx, nearTarget, nearDistPct, breakPct) {
    return {
        id: id, tier: 'HIGH_QUALITY', direction: dir, anchorIndex: anchorIdx,
        availableIndex: availIdx !== undefined ? availIdx : anchorIdx,
        anchorPrice: 100, notificationPrice: 100,
        notificationNearTarget: nearTarget !== undefined ? nearTarget : null,
        notificationNearDistPct: nearDistPct !== undefined ? nearDistPct : null,
        mssBreakPct: breakPct !== undefined ? breakPct : 0.001
    };
}

/* ---------- 四象限 ---------- */

test('12.4：quadrantSplit（方向 + anchor 容差）', function () {
    var legacy = [
        mkAlert('l1', 'BULLISH', 100, 102, 103),
        mkAlert('l2', 'BEARISH', 200, 202, 97)
    ];
    var dc = [
        mkAlert('d1', 'BULLISH', 101, 103, 103),  // l1 同向 Δ=1 → BOTH
        mkAlert('d2', 'BEARISH', 250, 252, 97)    // 无 legacy 同向近 anchor → DC_ONLY
    ];
    var q = ssi.quadrantSplit(legacy, dc, 2);
    assert.strictEqual(q.both.length, 1, 'l1-d1 配对');
    assert.strictEqual(q.both[0].legacy.id, 'l1');
    assert.strictEqual(q.both[0].dc.id, 'd1');
    assert.strictEqual(q.legacyOnly.length, 1, 'l2 无 DC 对应 → LEGACY_ONLY');
    assert.strictEqual(q.legacyOnly[0].id, 'l2');
    assert.strictEqual(q.dcOnly.length, 1, 'd2 无 legacy 对应 → DC_ONLY');
    assert.strictEqual(q.dcOnly[0].id, 'd2');
});

test('12.4：quadrantSplit 方向不同不配对', function () {
    var legacy = [mkAlert('l1', 'BULLISH', 300, 302, 103)];
    var dc = [mkAlert('d1', 'BEARISH', 300, 302, 97)];
    var q = ssi.quadrantSplit(legacy, dc, 2);
    assert.strictEqual(q.both.length, 0, '同 anchor 但方向不同 → 不配');
    assert.strictEqual(q.legacyOnly.length, 1);
    assert.strictEqual(q.dcOnly.length, 1);
});

test('12.4：quadrantSplit 只取 HIGH_QUALITY', function () {
    var legacy = [mkAlert('l1', 'BULLISH', 100, 102, 103)];
    legacy[0].tier = 'WATCH';
    var dc = [mkAlert('d1', 'BULLISH', 101, 103, 103)];
    var q = ssi.quadrantSplit(legacy, dc, 2);
    assert.strictEqual(q.legacyN, 0, 'WATCH 不进 HIGH 象限');
    assert.strictEqual(q.dcN, 1);
});

/* ---------- 象限 delivery ---------- */

test('12.4：assessQuadrant（NearHit / MFE / hasStrong / breakPct）', function () {
    var candles = [];
    var p = 100;
    for (var i = 0; i < 30; i++) {
        var hi = i >= 6 ? 104 : 100.5;
        var lo = i >= 6 ? 100 : 99.5;
        var c = i >= 6 ? 102.5 : 100;
        candles.push(mkBar(i, p, hi, lo, c));
        p = c;
    }
    var alert = mkAlert('a1', 'BULLISH', 3, 5, 103, 3.0, 0.0015);
    var disp = [{ id: 'd1', direction: 'BULLISH', candleIndex: 8 }];
    var dispByIndex = {};
    disp.forEach(function (d) { dispByIndex[d.candleIndex] = [d]; });
    var legByDispId = { d1: { id: 'd1', quality: 'STRONG' } };

    var a = ssi.assessQuadrant([alert], candles, dispByIndex, legByDispId);
    assert.strictEqual(a.n, 1);
    assert.strictEqual(a.nearHit30m, 1, 'bar6 high 104 >= 103 在 30m 内触达');
    assert.strictEqual(a.nearHit1h, 1);
    assert.ok(a.mfe1h > 0, '顺向 MFE > 0');
    assert.strictEqual(a.hasStrongRate, 1, '1h 内 STRONG displacement 命中');
    assert.strictEqual(a.strongDispPerAlert, 1);
    assert.strictEqual(a.breakPctMedian, 0.0015);
});

test('12.4：assessQuadrant incomplete（availableAt 超出数据）不计入', function () {
    var candles = [];
    for (var i = 0; i < 10; i++) candles.push(mkBar(i, 100, 101, 99, 100.5));
    var alert = mkAlert('a1', 'BULLISH', 8, 9, 103);
    var a = ssi.assessQuadrant([alert], candles, {}, {});
    assert.strictEqual(a.n, 1, '样本计数保留');
    assert.strictEqual(a.nearHit30m, null, '无通知后数据 → 不计入 hit 率（同 assessAlerts 口径）');
});

/* ---------- 集成 ---------- */

test('12.4：buildShadowAlerts 集成（两套完整链路）', function () {
    // 锯齿 candles
    var out = [];
    var price = 100;
    var dir = 1;
    for (var i = 0; i < 100; i++) {
        if (i > 0 && i % 10 === 0) dir *= -1;
        var target = i === 0 ? price : price + dir * (10 / 10);
        var open = i === 0 ? price : out[i - 1].close;
        var close = target;
        out.push(mkBar(i, open, Math.max(open, close) + 0.2, Math.min(open, close) - 0.2, close));
        price = target;
    }
    var legacySwings = [];
    for (var s = 0; s < 5; s++) {
        legacySwings.push({
            id: 'S_H' + s, type: 'SWING_HIGH', price: 104.5 + s * 0.1,
            confirmedAt: 1000000 + (10 + s * 10) * BAR + BAR - 1
        });
        legacySwings.push({
            id: 'S_L' + s, type: 'SWING_LOW', price: 95.5 - s * 0.1,
            confirmedAt: 1000000 + (20 + s * 10) * BAR + BAR - 1
        });
    }
    var dcRaw = require('../stats/directionalChangeAudit').buildDcSwings(out, 1.5, { confirmWith: 'close' });
    var shadow = ssi.buildShadowAlerts({
        candles: out, fvgs: [], drawTrace: [], sweepEvents: [],
        symbol: 'X', timeframe: '5m', k: 1.5
    }, legacySwings, dcRaw);

    assert.ok(shadow.legacy.mss.length >= 0, 'legacy MSS 数组');
    assert.ok(shadow.dc.mss.length >= 0, 'DC MSS 数组');
    assert.ok(shadow.dc.swings.length > 0, 'DC swings 生成');
    // 回归：DC swing 必须带 metadata.index（classifyMssReference 依赖，缺失 → 无 PROTECTED_SWING → 无 HIGH）
    shadow.dc.swings.forEach(function (w) {
        assert.strictEqual(typeof w.metadata.index, 'number', 'DC swing metadata.index 必须存在');
    });
    assert.strictEqual(shadow.k, 1.5);
    assert.ok(Array.isArray(shadow.legacy.alerts), 'legacy alerts 数组');
    assert.ok(Array.isArray(shadow.dc.alerts), 'DC alerts 数组');
    // future-safety 抽查：DC MSS 的 referenceSwing.confirmedAt <= MSS evalTime
    var dcSwingsById = {};
    shadow.dc.swings.forEach(function (w) { dcSwingsById[w.id] = w; });
    shadow.dc.mss.forEach(function (m) {
        var ref = dcSwingsById[m.source.referenceSwingId];
        if (!ref) return;
        var bar = out[m.candleIndex];
        assert.ok(ref.confirmedAt <= bar.closeTime, 'DC reference confirmedAt <= MSS evalTime');
    });
});

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
