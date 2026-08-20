/**
 * Phase 12.2 — ATR Directional Change Structural Swing Shadow 测试
 *
 * 覆盖：
 *   - DC 构建：严格交替、replacement 计数、ATR 冻结语义（extreme 时点锁定）、
 *     确认无未来泄漏（extremeIndex < confirmedAt）
 *   - 多档审计：k 越大 swings 越少（降噪单调性）、统计字段
 */
var assert = require('assert');
var dca = require('../stats/directionalChangeAudit');

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

/** 锯齿：每 segLen bars 反向，幅度 amp */
function zigzag(n, segLen, amp, base) {
    var out = [];
    var price = base;
    var dir = 1;
    for (var i = 0; i < n; i++) {
        if (i > 0 && i % segLen === 0) dir *= -1;
        var step = amp / segLen;
        var target = i === 0 ? price : price + dir * step;
        var open = i === 0 ? price : out[i - 1].close;
        var close = target;
        out.push(mkBar(i, open, Math.max(open, close) + 0.2, Math.min(open, close) - 0.2, close));
        price = target;
    }
    return out;
}

/* ---------- 构建 ---------- */

test('12.2：DC 严格交替 + 无未来泄漏', function () {
    var candles = zigzag(90, 10, 10, 100);
    var swings = dca.buildDcSwings(candles, 1.0);
    assert.ok(swings.length >= 6, '90 bars 锯齿至少 ~8 个 swing，实际 ' + swings.length);
    var prev = null;
    swings.forEach(function (s) {
        assert.ok(s.extremeIndex < s.confirmedAt, 'extreme 在确认之前（无未来泄漏）');
        assert.ok(s.confirmedAt < candles.length, '确认在数据范围内');
        if (prev) assert.notStrictEqual(s.direction, prev, '方向严格交替');
        prev = s.direction;
    });
});

test('12.2：replacement 计数（candidate 吞掉 local extreme）', function () {
    var out = [];
    var p = 100;
    for (var i = 0; i < 15; i++) {
        var hi = 100 + i;              // 每根新高
        var lo = hi - 0.4;
        var close = hi - 0.1;
        out.push(mkBar(i, p, hi, lo, close));
        p = close;
    }
    for (var j = 15; j < 21; j++) {
        var c = 100 + 14 - (j - 14) * 2; // 深跌
        out.push(mkBar(j, p, Math.max(p, c) + 0.2, Math.min(p, c) - 0.2, c));
        p = c;
    }
    var swings = dca.buildDcSwings(out, 1.0);
    assert.ok(swings.length >= 1, '应有 HIGH 确认');
    assert.ok(swings[0].replacements >= 10, '阶梯 14 根新高 → replacements >= 10，实际 ' + swings[0].replacements);
});

test('12.2：ATR 冻结语义（extreme 时点锁定，不被后续波动漂移）', function () {
    var out = [];
    var p = 99.5;
    for (var i = 0; i < 11; i++) {
        // bar0-10 波动极小（range ~0.2）；bar5 是 candidate high=100
        var hi = i === 5 ? 100 : 99.9;
        var lo = 99.7;
        var c = 99.8;
        out.push(mkBar(i, p, hi, lo, c));
        p = c;
    }
    for (var j = 11; j < 21; j++) {
        // bar11-20 波动暴增且价格下跌（high 不创新高，避免抢走 candidate）
        var hi = 99.9;
        var lo = 99.3 - (j - 11) * 0.2;
        var c = 99.5 - (j - 11) * 0.5;
        out.push(mkBar(j, p, hi, lo, c));
        p = c;
    }
    var swings = dca.buildDcSwings(out, 1.0);
    assert.ok(swings.length >= 1, '应有 HIGH 确认');
    var s = swings[0];
    // 冻结：extremeATR 取 extreme 时点（bar<=5，range~0.2），远小于后续波动（~5）
    assert.ok(s.extremeATR < 1, 'extremeATR 应锁定在 ~0.2（冻结语义），实际 ' + s.extremeATR.toFixed(2));
    // 若 ATR 被后续波动污染（阈值 ~5），回撤 0.5 不会在 bar11 确认 → confirmedAt 会 > 11
    assert.strictEqual(s.confirmedAt, 11, '冻结后阈值 ~0.2，bar11 回撤 0.5 即确认');
});

/* ---------- 多档审计 ---------- */

test('12.2：k 越大 swings 越少（降噪单调）', function () {
    // 幅度分层：小 leg（0.4）只在低 k 确认，大 leg（10）各档都确认
    var out = [];
    var p = 100;
    var targets = [110, 109.6, 120, 119.5, 130, 129.4]; // 交替峰谷，小 leg 0.4/0.5，大 leg 10
    var seg = Math.ceil(60 / targets.length);
    var tIdx = 0;
    for (var i = 0; i < 60; i++) {
        var step = (targets[tIdx] - p) / seg;
        var close = p + step;
        out.push(mkBar(i, p, Math.max(p, close) + 0.2, Math.min(p, close) - 0.2, close));
        p = close;
        if (i > 0 && i % seg === 0 && tIdx < targets.length - 1) tIdx++;
    }
    var stats = dca.auditDc(out, [0.5, 1.0, 2.0]);
    assert.ok(stats[0].n >= stats[1].n, 'k=0.5 应 >= k=1.0（' + stats[0].n + ' vs ' + stats[1].n + '）');
    assert.ok(stats[1].n >= stats[2].n, 'k=1.0 应 >= k=2.0（' + stats[1].n + ' vs ' + stats[2].n + '）');
});

test('12.2：统计字段完整性（交替率/延迟/leg）', function () {
    var candles = zigzag(90, 10, 10, 100);
    var stats = dca.auditDc(candles, [1.0]);
    var st = stats[0];
    assert.strictEqual(st.alternationRate, 1, 'DC 严格交替 → alt 100%');
    assert.ok(st.medianBarsPerLeg > 0, 'medianBarsPerLeg > 0');
    assert.ok(st.medianLegRangeAtr > 1, 'leg range/ATR 应 > 1（锯齿 leg 幅度 10 / ATR ~0.4）');
    assert.ok(st.medianConfirmDelay > 0, '确认延迟 > 0');
    assert.strictEqual(typeof st.replacementMean, 'number');
    assert.ok((st.replacementBuckets['0'] || 0) + (st.replacementBuckets['1'] || 0) +
        (st.replacementBuckets['2-3'] || 0) + (st.replacementBuckets['4+'] || 0) === st.n, 'replacement 桶和 = n');
});

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
