/**
 * Phase 11L.15 — Alert Prioritization Shadow 测试
 *
 * 覆盖：
 *   - isSignificant / immediateGroupOf / windowHasSignificant 分类
 *   - 两个口径分组（immediate / window）+ 抑制原因分布
 *   - forward 指标（NearHit / MFE）计入正确
 *   - 非 HIGH 不统计；baseline = 全部 HIGH
 */
var assert = require('assert');
var ap = require('../stats/alertPrioritization');

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
    for (var i = 0; i < 40; i++) out.push(m5(100, 101, 99, 100.5, i));
    return out;
}

function mkAlert(id, ctx, extra) {
    var a = {
        id: id,
        tier: 'HIGH_QUALITY',
        direction: 'BULLISH',
        legStartIndex: 10,
        anchorIndex: 14,
        availableIndex: 14,
        availableAt: 1000000 + 14 * BAR + BAR - 1,
        notificationPrice: 100.5,
        notificationNearTarget: 105,
        nearTarget: 105,
        anchorPrice: 100.5,
        liquidityContext: ctx
    };
    for (var k in (extra || {})) a[k] = extra[k];
    return a;
}

function swCtx(sourceType, allTypes) {
    var list = allTypes || [sourceType];
    return {
        immediateSweep: { sourceType: sourceType, sourcePrice: 99, candleIndex: 5, barsBeforeLegStart: 5, relation: 'BEFORE_LEG' },
        allCandidates: list.map(function (t, i) {
            return { sourceType: t, sourcePrice: 99, candleIndex: 5 + i, barsBeforeLegStart: 5 - i };
        })
    };
}

/* ---------- 分类 ---------- */

test('11L.15：isSignificant / immediateGroupOf / windowHasSignificant 分类', function () {
    ['EQL', 'EQH', 'PDL', 'PDH', 'PWH', 'PWL', 'SESSION_LOW', 'SESSION_HIGH', 'ASIA_LOW', 'LONDON_HIGH', 'NEW_YORK_LOW'].forEach(function (t) {
        assert.strictEqual(ap.isSignificant(t), true, t + ' 应算 Significant');
    });
    ['SWING_LOW', 'SWING_HIGH'].forEach(function (t) {
        assert.strictEqual(ap.isSignificant(t), false, t + ' 不算 Significant');
    });
    assert.strictEqual(ap.isSignificant('UNKNOWN'), false);
    assert.strictEqual(ap.isSignificant(null), false);

    assert.strictEqual(ap.immediateGroupOf(mkAlert('a', swCtx('EQL'))), 'SIGNIFICANT');
    assert.strictEqual(ap.immediateGroupOf(mkAlert('b', swCtx('SWING_LOW'))), 'SWING');
    assert.strictEqual(ap.immediateGroupOf(mkAlert('c', null)), 'NONE');
    assert.strictEqual(ap.immediateGroupOf(mkAlert('d', { immediateSweep: null, allCandidates: [] })), 'NONE');

    // window 口径：immediate 是 swing，但窗口内有 EQL → true
    assert.strictEqual(ap.windowHasSignificant(mkAlert('e', swCtx('SWING_LOW', ['SWING_LOW', 'EQL']))), true);
    assert.strictEqual(ap.windowHasSignificant(mkAlert('f', swCtx('SWING_LOW', ['SWING_LOW']))), false);
    assert.strictEqual(ap.windowHasSignificant(mkAlert('g', null)), false);
});

/* ---------- 两个口径分组 + 原因分布 + forward ---------- */

test('11L.15：auditPrioritization 两口径分组 + 原因分布 + forward', function () {
    var candles = mkCandles();
    candles[21] = m5(100.5, 105.5, 100.4, 105.2, 21); // 通知后 6 bars 内触达 near → near30/near1h hit

    var alerts = [
        // A1：immediate = EQL → immediate 口径 PRIORITY；window 口径也 PRIORITY
        mkAlert('a1', swCtx('EQL')),
        // A2：immediate = SWING_LOW，窗口内有 EQL → immediate 口径 SUPPRESSED(SWING)；window 口径 PRIORITY
        mkAlert('a2', swCtx('SWING_LOW', ['SWING_LOW', 'EQL'])),
        // A3：immediate = SWING_LOW，窗口内只有 SWING → 两口径都 SUPPRESSED(SWING)
        mkAlert('a3', swCtx('SWING_LOW', ['SWING_LOW'])),
        // A4：无 liquidityContext → 两口径都 SUPPRESSED(NONE)
        mkAlert('a4', null),
        // A5：WATCH 不应统计
        mkAlert('a5', swCtx('EQL'), { tier: 'WATCH' })
    ];

    var res = ap.auditPrioritization(alerts, candles);
    assert.strictEqual(res.total, 4, 'WATCH 不统计');

    // baseline
    assert.strictEqual(res.baseline.n, 4);
    assert.strictEqual(res.baseline.nearHit1h, 4, '4 个 HIGH 通知后都触达');
    assert.strictEqual(res.baseline.nearCnt1h, 4);

    // 口径 A（immediate）
    var ia = res.variants.immediate;
    assert.strictEqual(ia.priority.n, 1, 'A1 唯一 immediate=EQL');
    assert.strictEqual(ia.suppressed.n, 3);
    assert.strictEqual(ia.suppressedReasons.SWING, 2, 'A2、A3 immediate 是 SWING');
    assert.strictEqual(ia.suppressedReasons.NONE, 1, 'A4 无 sweep');

    // 口径 B（window）
    var ib = res.variants.window;
    assert.strictEqual(ib.priority.n, 2, 'A1、A2 窗口内有 EQL');
    assert.strictEqual(ib.suppressed.n, 2);
    assert.strictEqual(ib.suppressedReasons.SWING, 1, 'A3 窗口内只有 SWING');
    assert.strictEqual(ib.suppressedReasons.NONE, 1, 'A4 无 sweep');

    // forward 统计：所有样本通知后都触达 → nearHit == n（对每组）
    [ia.priority, ia.suppressed, ib.priority, ib.suppressed, res.baseline].forEach(function (acc) {
        assert.strictEqual(acc.nearHit1h, acc.n, 'n=' + acc.n + ' 全部触达');
        assert.ok(acc.mfeCnt === acc.n && acc.mfeSum > 0, 'MFE 计入');
    });
});

/* ---------- 边界：目标缺失 ---------- */

test('11L.15：无 notificationNearTarget 时分类照常、near 不计', function () {
    var candles = mkCandles();
    var alerts = [
        mkAlert('x', swCtx('PDH'), { notificationNearTarget: null }),
        mkAlert('y', swCtx('SWING_HIGH'))
    ];
    var res = ap.auditPrioritization(alerts, candles);
    assert.strictEqual(res.total, 2);
    assert.strictEqual(res.variants.immediate.priority.n, 1, 'PDH → PRIORITY（即使无 target）');
    assert.strictEqual(res.variants.immediate.priority.nearCnt1h, 0, '无 target → near 不计');
    assert.strictEqual(res.variants.immediate.priority.nearHit1h, 0);
    assert.strictEqual(res.variants.immediate.priority.mfeCnt, 1, 'MFE 仍计（statOne 返回则计）');
});

/* ---------- 汇总 ---------- */

console.log('---');
if (failed === 0) {
    console.log('ALL TESTS PASSED (' + passed + ')');
} else {
    console.log('SOME TESTS FAILED (' + failed + '/' + (passed + failed) + ')');
}
process.exit(failed === 0 ? 0 : 1);
