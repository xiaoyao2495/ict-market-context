/**
 * Phase 11L.4 — Alert Availability-Time 语义测试
 *
 * 覆盖：
 *   - createWindowedLegBuilder：关闭时标记 availableAt / availableIndex / closeReason
 *     （new-displacement 触发 vs timeout 过期）
 *   - createLegBuilder：修复 closeExpired 引用未定义 MS 的 bug
 *   - buildWindowedLegIndex：tail close 的 availableIndex 按 closeTime 反查
 *   - alertReplay.assessAlerts：post-alert 统计从 availableIndex+1 开始（不再用 anchorIndex+1）
 *     + 无有效通知时点的样本计 incomplete（不计入 hit 率）
 */
var assert = require('assert');
var displacementLeg = require('../stats/displacementLeg');
var alertReplay = require('../stats/alertReplay');

var tests = [];
var passed = 0;
var failed = 0;

function test(name, fn) {
    tests.push({ name: name, fn: fn });
}

function m5(open, high, low, close, i) {
    var base = 1700000000000 + i * 300000;
    return {
        openTime: base,
        closeTime: base + 299999,
        open: open, high: high, low: low, close: close,
        volume: 100, closed: true, source: 'futures'
    };
}

function disp(id, dir, index, confirmedAt) {
    return { id: id, direction: dir, candleIndex: index, confirmedAt: confirmedAt, metadata: {} };
}

// ---------- createWindowedLegBuilder：availableAt 语义 ----------
test('windowed feed: 新 displacement 触发关闭 → availableAt=触发K confirmedAt / closeReason=new-displacement', function () {
    var b = displacementLeg.createWindowedLegBuilder();
    var t0 = 1000000;
    b.feed(disp('d1', 'BULLISH', 0, t0));
    var r = b.feed(disp('d2', 'BEARISH', 3, t0 + 900000));
    assert.ok(r.closed, '不同向触发关闭');
    assert.strictEqual(r.closed.availableAt, t0 + 900000, '通知可用时点 = 触发 K 的 confirmedAt');
    assert.strictEqual(r.closed.availableIndex, 3, '触发 K 的 candleIndex');
    assert.strictEqual(r.closed.closeReason, 'new-displacement');
});

test('windowed closeExpired: timeout → availableAt=lastConfirmedAt+15min / closeReason=timeout', function () {
    var b = displacementLeg.createWindowedLegBuilder();
    var t0 = 1000000;
    b.feed(disp('d1', 'BULLISH', 0, t0));
    assert.strictEqual(b.closeExpired(t0 + 899999), null, '未满 15min 不关闭');
    var expired = b.closeExpired(t0 + 900000);
    assert.ok(expired, '满 15min 关闭');
    assert.strictEqual(expired.availableAt, t0 + 900000, 'availableAt = lastConfirmedAt + mergeMs');
    assert.strictEqual(expired.closeReason, 'timeout');
});

test('windowed close（数据末尾 flush）→ 模拟 timeout availableAt', function () {
    var b = displacementLeg.createWindowedLegBuilder();
    var t0 = 1000000;
    b.feed(disp('d1', 'BULLISH', 0, t0));
    var closed = b.close();
    assert.ok(closed);
    assert.strictEqual(closed.availableAt, t0 + 900000);
    assert.strictEqual(closed.closeReason, 'timeout');
});

// ---------- createLegBuilder：MS bug 修复 ----------
test('createLegBuilder: closeExpired 不再 ReferenceError（MS bug 修复）', function () {
    var b = displacementLeg.createLegBuilder();
    var t0 = 1000000;
    b.feed(disp('d1', 'BULLISH', 0, t0));
    var expired = null;
    var threw = false;
    try {
        expired = b.closeExpired(t0 + 900000);
    } catch (e) {
        threw = true;
    }
    assert.strictEqual(threw, false, '不抛 ReferenceError: MS is not defined');
    assert.ok(expired);
    assert.strictEqual(expired.closeReason, 'timeout');
    assert.strictEqual(expired.availableAt, t0 + 900000);
});

test('createLegBuilder: feed 关闭 → availableAt/closeReason 正确', function () {
    var b = displacementLeg.createLegBuilder();
    var t0 = 1000000;
    b.feed(disp('d1', 'BULLISH', 0, t0));
    var r = b.feed(disp('d2', 'BULLISH', 1, t0 + 300000)); // 相邻同向 → 合并
    assert.strictEqual(r.closed, null, '同向相邻合并');
    var r2 = b.feed(disp('d3', 'BEARISH', 2, t0 + 600000)); // 触发关闭
    assert.ok(r2.closed);
    assert.strictEqual(r2.closed.closeReason, 'new-displacement');
    assert.strictEqual(r2.closed.availableIndex, 2);
});

// ---------- buildWindowedLegIndex：tail availableIndex 反查 ----------
test('buildWindowedLegIndex: tail close 的 availableIndex 按 closeTime 反查（数据覆盖 → 有值）', function () {
    var candles = [];
    for (var i = 0; i < 30; i++) candles.push(m5(100, 101, 99, 100.5, i));
    var t0 = 1700000000000; // index 0 openTime
    var displacements = [disp('d1', 'BULLISH', 5, t0 + 5 * 300000 + 299999)]; // index 5 closeTime
    var idx = displacementLeg.buildWindowedLegIndex(displacements, candles, [], []);
    var leg = idx['d1'];
    assert.ok(leg);
    // leg 唯一 → tail close；availableAt = lastConfirmedAt + 900000 = index(5).closeTime + 900000 = index(8).closeTime
    assert.strictEqual(leg.availableIndex, 8);
    assert.strictEqual(leg.closeReason, 'timeout');
});

test('buildWindowedLegIndex: 数据不足（tail 超界）→ availableIndex = null', function () {
    var candles = [];
    for (var i = 0; i < 6; i++) candles.push(m5(100, 101, 99, 100.5, i)); // 只有 0-5
    var t0 = 1700000000000;
    var displacements = [disp('d1', 'BULLISH', 5, t0 + 5 * 300000 + 299999)];
    var idx = displacementLeg.buildWindowedLegIndex(displacements, candles, [], []);
    assert.strictEqual(idx['d1'].availableIndex, null, 'lastConfirmedAt+15min 超出数据 → 无通知点');
});

// ---------- assessAlerts：availableAt+1 统计起点 ----------
test('assessAlerts: post-alert 统计从 availableIndex+1 起（availableAt 之后才允许观察）', function () {
    var candles = [];
    for (var i = 0; i < 60; i++) candles.push(m5(100, 101, 99, 100.5, i));
    // 锚 index 10（close 100.5）；通知可用 index 13（anchor+3 = timeout 确认）
    // 若仍从 anchor+1=11 统计：11-22 窗口内 index 11 就触达 near 103
    // 若从 available+1=14 统计：14 之后触达才算 hit —— 构造"11 触达但 14 前回落"验证
    candles[11] = m5(100.5, 103.5, 100.4, 103.2, 11); // high >= 103：anchor+1 窗口内触达
    candles[12] = m5(103.2, 103.4, 100.8, 101.0, 12);
    candles[13] = m5(101.0, 101.2, 99.5, 99.8, 13);   // 回落到 99.8
    candles[14] = m5(99.8, 100.0, 99.5, 99.7, 14);   // available+1 起不再触达 103
    var alerts = [
        {
            id: 'a', tier: 'HIGH_QUALITY', direction: 'BULLISH',
            anchorIndex: 10, anchorPrice: 100.5, nearTarget: 103, nearDistPct: 2.49,
            availableIndex: 13, availableAt: candles[13].closeTime, closeReason: 'timeout'
        }
    ];
    var a = alertReplay.assessAlerts(alerts, candles);
    assert.strictEqual(a.byTier.HIGH_QUALITY, 1, '通知计数含该样本');
    assert.strictEqual(a.tierStats.HIGH_QUALITY.n, 1);
    assert.strictEqual(a.tierStats.HIGH_QUALITY.w1h.nearHit, 0, 'availableAt+1（index 14）起 1h 内未触达 103 → 不算 hit');
    assert.strictEqual(a.tierStats.HIGH_QUALITY.w1h.nearCnt, 1);
    assert.strictEqual(a.incomplete, 0);
});

test('assessAlerts: availableIndex 缺失回退 anchorIndex（旧调用兼容）', function () {
    var candles = [];
    for (var i = 0; i < 40; i++) candles.push(m5(100, 101, 99, 100.5, i));
    var alerts = [
        { id: 'a', tier: 'HIGH_QUALITY', direction: 'BULLISH', anchorIndex: 10, anchorPrice: 100.5, nearTarget: 100.6, nearDistPct: 0.1 }
    ];
    var a = alertReplay.assessAlerts(alerts, candles);
    assert.strictEqual(a.tierStats.HIGH_QUALITY.n, 1, '回退 anchorIndex → start=11 可评估');
});

test('assessAlerts: 无有效通知时点（availableIndex null）→ incomplete 不计入 hit 率', function () {
    var candles = [];
    for (var i = 0; i < 30; i++) candles.push(m5(100, 101, 99, 100.5, i));
    var alerts = [
        { id: 'a', tier: 'HIGH_QUALITY', direction: 'BULLISH', anchorIndex: 25, anchorPrice: 100.5, nearTarget: 103, nearDistPct: 2.49, availableIndex: null, availableAt: null, closeReason: 'timeout' },
        { id: 'b', tier: 'WATCH', direction: 'BULLISH', anchorIndex: 5, anchorPrice: 100.5, nearTarget: 100.6, nearDistPct: 0.1, availableIndex: 5, availableAt: candles[5].closeTime, closeReason: 'new-displacement' }
    ];
    var a = alertReplay.assessAlerts(alerts, candles);
    assert.strictEqual(a.incomplete, 1, 'availableIndex null → incomplete');
    assert.strictEqual(a.tierStats.HIGH_QUALITY, undefined, 'HIGH 无有效样本 → 键保持 undefined（0 计入）');
    assert.strictEqual(a.tierStats.WATCH.n, 1);
    assert.strictEqual(a.tierStats.WATCH.w1h.nearHit, 1, 'index 6 起 high 100.5+ 触达 100.6？需看窗口——窗口内高 101 ≥ 100.6 → hit');
});

// ---------- 异步 runner（保持一致性；本文件同步为主） ----------
var chain = Promise.resolve();
tests.forEach(function (t) {
    chain = chain.then(function () {
        return Promise.resolve().then(function () { return t.fn(); })
            .then(function () {
                passed++;
                console.log('PASS  ' + t.name);
            })
            .catch(function (e) {
                failed++;
                console.log('FAIL  ' + t.name + '  ->  ' + (e && e.message || e));
            });
    });
});
chain.then(function () {
    console.log('----');
    console.log('availabilityTime: ' + passed + ' passed, ' + failed + ' failed');
    if (failed > 0) {
        process.exit(1);
    }
});
