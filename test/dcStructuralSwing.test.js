/**
 * Phase 12.5A — structure/dcStructuralSwing（唯一实现）测试
 *
 * 覆盖：
 *   - 状态机 parity：buildDcSwings（全量）== 逐根 stepDcState 累积（Live/Replay 同一实现）
 *   - 严格交替 + 无未来泄漏（extremeIndex < confirmedAt）
 *   - replacement 计数（candidate 吞掉 local extreme）
 *   - ATR 冻结语义（extreme 时点锁定，不被后续波动漂移）
 *   - packageForMss：confirmedAt 转时间戳（future-safety）、metadata.index（classifyMssReference 依赖）
 *   - future-safety：swing 确认前不得成为 MSS reference（confirmedAt > evalTime 不可能入池）
 */
var assert = require('assert');
var dcss = require('../structure/dcStructuralSwing');

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
        var target = i === 0 ? price : price + dir * (amp / segLen);
        var open = i === 0 ? price : out[i - 1].close;
        var close = target;
        out.push(mkBar(i, open, Math.max(open, close) + 0.2, Math.min(open, close) - 0.2, close));
        price = target;
    }
    return out;
}

/* ---------- 状态机 ---------- */

test('12.5A：buildDcSwings 全量 == 逐根 step 累积（parity）', function () {
    var candles = zigzag(90, 10, 10, 100);
    var full = dcss.buildDcSwings(candles, 1.5, {});
    // 逐根 step 累积（Live 增量路径）
    var state = dcss.createDcState(1.5, {});
    var inc = [];
    for (var i = 0; i < candles.length; i++) {
        var sw = dcss.stepDcState(state, candles[i], i, candles);
        if (sw) inc.push(sw);
    }
    assert.strictEqual(inc.length, full.length, '数量一致（' + inc.length + '）');
    for (var j = 0; j < full.length; j++) {
        assert.strictEqual(inc[j].direction, full[j].direction);
        assert.strictEqual(inc[j].price, full[j].price);
        assert.strictEqual(inc[j].extremeIndex, full[j].extremeIndex);
        assert.strictEqual(inc[j].confirmedAt, full[j].confirmedAt);
        assert.strictEqual(inc[j].replacements, full[j].replacements);
    }
});

test('12.5A：严格交替 + 无未来泄漏', function () {
    var candles = zigzag(90, 10, 10, 100);
    var swings = dcss.buildDcSwings(candles, 1.5);
    assert.ok(swings.length >= 5, '至少 ~8 个 swing，实际 ' + swings.length);
    var prev = null;
    swings.forEach(function (s) {
        assert.ok(s.extremeIndex < s.confirmedAt, 'extreme 在确认前（无未来泄漏）');
        if (prev) assert.notStrictEqual(s.direction, prev, '严格交替');
        prev = s.direction;
    });
});

test('12.5A：replacement 计数（candidate 吞掉 local extreme）', function () {
    var out = [];
    var p = 100;
    for (var i = 0; i < 15; i++) {
        var hi = 100 + i;
        var lo = hi - 0.4;
        var close = hi - 0.1;
        out.push(mkBar(i, p, hi, lo, close));
        p = close;
    }
    for (var j = 15; j < 21; j++) {
        var c = 100 + 14 - (j - 14) * 2;
        out.push(mkBar(j, p, Math.max(p, c) + 0.2, Math.min(p, c) - 0.2, c));
        p = c;
    }
    var swings = dcss.buildDcSwings(out, 1.0);
    assert.ok(swings.length >= 1, '应有 HIGH 确认');
    assert.ok(swings[0].replacements >= 10, '阶梯 14 根新高 → replacements >= 10，实际 ' + swings[0].replacements);
});

test('12.5A：ATR 冻结语义（extreme 时点锁定）', function () {
    var out = [];
    var p = 99.5;
    for (var i = 0; i < 11; i++) {
        var hi = i === 5 ? 100 : 99.9;
        var lo = 99.7;
        var c = 99.8;
        out.push(mkBar(i, p, hi, lo, c));
        p = c;
    }
    for (var j = 11; j < 21; j++) {
        var hi = 99.9; // 不创新高（避免抢 candidate）
        var lo = 99.3 - (j - 11) * 0.2;
        var c = 99.5 - (j - 11) * 0.5;
        out.push(mkBar(j, p, hi, lo, c));
        p = c;
    }
    var swings = dcss.buildDcSwings(out, 1.0);
    assert.ok(swings.length >= 1, '应有 HIGH 确认');
    var s = swings[0];
    assert.ok(s.extremeATR < 1, 'extremeATR 锁定在 ~0.2（冻结语义），实际 ' + s.extremeATR.toFixed(2));
    assert.strictEqual(s.confirmedAt, 11, '冻结后阈值 ~0.2，bar11 回撤 0.5 即确认（若用当前 ATR 会推迟）');
});

/* ---------- MSS 包装 ---------- */

test('12.5A：packageForMss（confirmedAt 时间戳 + metadata.index + future-safety）', function () {
    var candles = zigzag(60, 10, 10, 100);
    var swings = dcss.buildDcSwings(candles, 1.5);
    assert.ok(swings.length > 0);
    swings.forEach(function (raw) {
        var pkg = dcss.packageForMss(raw, 'BTCUSDT', '5m', candles);
        assert.ok(pkg.type === 'SWING_HIGH' || pkg.type === 'SWING_LOW');
        // confirmedAt 必须转成时间戳（ms）——detectMss evalTime = candle.closeTime
        assert.ok(pkg.confirmedAt > 1000000, 'confirmedAt 是时间戳（ms）：' + pkg.confirmedAt);
        assert.strictEqual(pkg.confirmedAt, candles[raw.confirmedAt].closeTime, 'confirmedAt = 确认 bar closeTime');
        // classifyMssReference 依赖 metadata.index
        assert.strictEqual(pkg.metadata.index, raw.extremeIndex, 'metadata.index = extremeIndex');
        // future-safety：confirmedAt（时间戳）对应确认 bar 的 closeTime，早于该时点的 evalTime 才能引用
        var refIndex = Math.round((pkg.confirmedAt - 1000000 - (BAR - 1)) / BAR);
        assert.strictEqual(refIndex, raw.confirmedAt, '时间戳反查 index 一致');
        assert.ok(raw.extremeIndex < raw.confirmedAt);
    });
});

test('12.5A：future-safety（swing 确认前不入池 / MSS 引用已确认 swing）', function () {
    // 构造：extreme high=100 @bar5，bar6-14 缓慢回落（未达 1 ATR），bar11 才确认（close 99.0 回撤 1.0）
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
    // 逐根 step：bar11 才确认 HIGH；bar0-10 的 step 返回 null（不入池）
    var state = dcss.createDcState(1.0, {});
    var firstConfirm = null;
    for (var k = 0; k < 12; k++) {
        var sw = dcss.stepDcState(state, out[k], k, out);
        if (sw && !firstConfirm) firstConfirm = sw;
        if (k < 11) assert.strictEqual(sw, null, 'bar' + k + ' 不应确认 swing（回撤未达 1 ATR）');
    }
    assert.ok(firstConfirm, 'bar11 确认 HIGH');
    assert.strictEqual(firstConfirm.confirmedAt, 11, '确认于 bar11（reversal close 达 1 ATR）');
    assert.strictEqual(firstConfirm.extremeIndex, 5, 'extreme 是 bar5 的 high=100');
});

test('12.5A.1【P0 复现】：DC MSS 必须用 dcRefPool 解析 quality（legacy pool → NO_REFERENCE）', function () {
    // 构造：extreme high=100 @bar5，bar11 确认 HIGH（close 回撤 1 ATR），bar16 close 突破 100 → DC BULLISH MSS
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
    for (var k = 16; k < 20; k++) {
        var hi = 100.8;
        var lo = 99.0;
        var c = 100.2;
        out.push(mkBar(k, p, hi, lo, c));
        p = c;
    }
    var dcSwings = dcss.buildDcSwings(out, 1.0, {}).map(function (raw) {
        return dcss.packageForMss(raw, 'BTCUSDT', '5m', out);
    });
    var mss = require('../events/mssDetector').detectMss(out, dcSwings, {
        symbol: 'BTCUSDT', timeframe: '5m', consumedRefs: {}
    });
    var withDcRef = mss.filter(function (m) {
        return m.source.referenceSwingId.indexOf(':DC:') !== -1;
    });
    assert.ok(withDcRef.length > 0, '存在 DC reference MSS（' + withDcRef.length + '）');

    var mssRef = require('../stats/mssReference');
    // 修复后（正确）：用 dcRefPool 解析 → 至少存在非 NO_REFERENCE 的 quality
    var nonNoRefDc = 0;
    var nonNoRefLegacy = 0;
    withDcRef.forEach(function (m) {
        var qDc = mssRef.classifyMssReference(m, dcSwings).quality;
        var qLegacy = mssRef.classifyMssReference(m, []).quality; // legacy 池找不到 :DC: id → NO_REFERENCE
        if (qDc !== 'NO_REFERENCE') nonNoRefDc++;
        if (qLegacy !== 'NO_REFERENCE') nonNoRefLegacy++;
    });
    assert.ok(nonNoRefDc > 0, 'DC pool 解析应有非 NO_REFERENCE（' + nonNoRefDc + '/' + withDcRef.length + '）——P0 修复后的正确行为');
    assert.strictEqual(nonNoRefLegacy, 0, 'legacy pool 解析全部 NO_REFERENCE（修复前 Live 的 bug 行为）——证明 pool 必须一致');
});

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
