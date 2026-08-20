/**
 * Phase 11L.15 — Live Prioritization Shadow Audit 测试
 *
 * 覆盖：
 *   - 记录 → 伪 alert 映射（availableAt → candle index；notificationNearTarget 回退）
 *   - 分组（PRIORITY_HIGH / STANDARD_HIGH）计数与 forward 指标
 *   - availableAt 不在 candles → unmatched（计数但不计 forward）
 *   - priority 未知 → 归入 STANDARD_HIGH（防御）
 */
var assert = require('assert');
var lpa = require('../stats/livePrioritizationAudit');

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
    out[21] = m5(100.5, 105.5, 100.4, 105.2, 21); // 通知后 6 bars 内触达 near
    return out;
}

function mkRec(id, priority, availIdx, extra) {
    var candles = mkCandles();
    var rec = {
        id: id,
        symbol: 'BTCUSDT',
        ts: 123,
        priority: priority,
        direction: 'BULLISH',
        tier: 'HIGH_QUALITY',
        availableAt: candles[availIdx].closeTime,
        anchorTime: candles[availIdx - 4].closeTime,
        anchorIndex: availIdx - 4,
        notificationPrice: 100.5,
        notificationNearTarget: 105,
        nearTarget: 105,
        nearDistPct: 4.48
    };
    for (var k in (extra || {})) rec[k] = extra[k];
    return rec;
}

/* ---------- 映射 ---------- */

test('11L.15：toPseudoAlert 映射 availableAt → index + target 回退', function () {
    var candles = mkCandles();
    var rec = mkRec('a', 'PRIORITY_HIGH', 14);
    var idx = lpa.buildCloseIndex(candles);
    var al = lpa.toPseudoAlert(rec, idx);
    assert.strictEqual(al.availableIndex, 14, 'availableAt(closeTime) → candle index 14');
    assert.strictEqual(al._priority, 'PRIORITY_HIGH');
    assert.strictEqual(al.notificationNearTarget, 105);
    // notificationNearTarget 缺失 → 回退 nearTarget
    var rec2 = mkRec('b', 'STANDARD_HIGH', 15, { notificationNearTarget: undefined });
    var al2 = lpa.toPseudoAlert(rec2, idx);
    assert.strictEqual(al2.notificationNearTarget, 105, '回退 nearTarget');
    assert.strictEqual(al2._priority, 'STANDARD_HIGH');
    // 未知 priority → STANDARD（防御）
    var rec3 = mkRec('c', 'WEIRD', 15);
    var al3 = lpa.toPseudoAlert(rec3, idx);
    assert.strictEqual(al3._priority, 'STANDARD_HIGH');
    // availableAt 找不到 → availableIndex null（unmatched）
    var al4 = lpa.toPseudoAlert(mkRec('d', 'PRIORITY_HIGH', 6), {});
    assert.strictEqual(al4.availableIndex, null);
});

/* ---------- 分组 + forward ---------- */

test('11L.15：auditLivePrioritization 分组 forward + unmatched', function () {
    var candles = mkCandles();
    var records = [
        mkRec('p1', 'PRIORITY_HIGH', 14),  // idx14 通知 → idx15-26 窗口，idx21 触达 → near hit
        mkRec('p2', 'PRIORITY_HIGH', 14),
        mkRec('s1', 'STANDARD_HIGH', 14),
        mkRec('x1', 'STANDARD_HIGH', 30, { availableAt: 999999999 }) // unmatched
    ];
    var res = lpa.auditLivePrioritization(records, candles);
    assert.strictEqual(res.rawRecords, 4);
    assert.strictEqual(res.uniqueOpportunities, 4);
    assert.strictEqual(res.duplicateRecords, 0);
    assert.strictEqual(res.unmatched, 1, 'x1 availableAt 不在 candles');
    assert.strictEqual(res.groups.PRIORITY_HIGH.n, 2);
    assert.strictEqual(res.groups.STANDARD_HIGH.n, 2, 's1 + x1（x1 只计数不计 forward）');
    assert.strictEqual(res.groups.PRIORITY_HIGH.nearHit1h, 2, 'PRIORITY 两笔都触达');
    assert.strictEqual(res.groups.PRIORITY_HIGH.mfeCnt, 2);
    assert.strictEqual(res.groups.STANDARD_HIGH.nearHit1h, 1, 's1 触达；x1 无 forward');
    assert.strictEqual(res.groups.STANDARD_HIGH.mfeCnt, 1);
});

test('11L.15a：按 id 去重（crash/replay 重复落盘）', function () {
    var candles = mkCandles();
    var records = [
        mkRec('p1', 'PRIORITY_HIGH', 14),
        mkRec('p1', 'PRIORITY_HIGH', 14), // dup
        mkRec('s1', 'STANDARD_HIGH', 14),
        mkRec('s1', 'STANDARD_HIGH', 14), // dup（STANDARD 不写 delivered，crash 边界易重复）
        mkRec('s1', 'STANDARD_HIGH', 14)  // dup
    ];
    var res = lpa.auditLivePrioritization(records, candles);
    assert.strictEqual(res.rawRecords, 5);
    assert.strictEqual(res.uniqueOpportunities, 2, 'p1 + s1');
    assert.strictEqual(res.duplicateRecords, 3, '5 - 2');
    assert.strictEqual(res.groups.PRIORITY_HIGH.n, 1, 'p1 只计一次');
    assert.strictEqual(res.groups.STANDARD_HIGH.n, 1, 's1 只计一次');
    assert.strictEqual(res.groups.PRIORITY_HIGH.nearHit1h, 1);
    assert.strictEqual(res.groups.STANDARD_HIGH.nearHit1h, 1);
});

test('11L.15a：不完整 forward 窗口不计 denominator（刚发生的 HIGH 不算 miss）', function () {
    var candles = mkCandles(); // 40 根
    var records = [
        mkRec('nearEnd', 'PRIORITY_HIGH', 35), // start=36：30m/1h 都不完整
        mkRec('mid', 'STANDARD_HIGH', 33)      // start=34：30m 完整（34+6=40），1h 不完整（34+12=46>40）
    ];
    var res = lpa.auditLivePrioritization(records, candles);
    assert.strictEqual(res.unmatched, 0, 'availableAt 都能找到');
    assert.strictEqual(res.groups.PRIORITY_HIGH.n, 1);
    assert.strictEqual(res.groups.PRIORITY_HIGH.nearCnt30m, 0, '30m 不完整 → 不计');
    assert.strictEqual(res.groups.PRIORITY_HIGH.nearCnt1h, 0);
    assert.strictEqual(res.groups.PRIORITY_HIGH.mfeCnt, 0, 'MFE 需完整 1h');
    assert.strictEqual(res.groups.STANDARD_HIGH.nearCnt30m, 1, '30m 恰好完整 → 计');
    assert.strictEqual(res.groups.STANDARD_HIGH.nearCnt1h, 0, '1h 不完整 → 不计');
    assert.strictEqual(res.groups.STANDARD_HIGH.mfeCnt, 0);
});

test('11L.15：空记录/空 candles 不崩', function () {
    var res = lpa.auditLivePrioritization([], []);
    assert.strictEqual(res.rawRecords, 0);
    assert.strictEqual(res.uniqueOpportunities, 0);
    assert.strictEqual(res.groups.PRIORITY_HIGH.n, 0);
    assert.strictEqual(res.groups.STANDARD_HIGH.n, 0);
});

/* ---------- 汇总 ---------- */

console.log('---');
if (failed === 0) {
    console.log('ALL TESTS PASSED (' + passed + ')');
} else {
    console.log('SOME TESTS FAILED (' + failed + '/' + (passed + failed) + ')');
}
process.exit(failed === 0 ? 0 : 1);
