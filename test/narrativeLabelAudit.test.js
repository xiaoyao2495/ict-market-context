/**
 * Bias Phase 1 — ICT Narrative Ground Truth 测试
 *
 * 覆盖：
 *   - buildNarratives：SSL raid → Bullish MSS → Bullish Disp 链；BSL 镜像；
 *     无同向 MSS / 无 leg 归属 → 不成链；raid 后首个同向 MSS
 *   - outcomeOf：MFE/MAE（30m/1h/4h）、Near Draw Hit、Continuation、Invalidation；
 *     outcome 从 disp 之后，无未来泄漏
 *   - auditNarratives：转化率 + 时间结构 median + outcome 汇总
 */
var assert = require('assert');
var nla = require('../stats/narrativeLabelAudit');

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
function mkSweep(id, dir, side, idx) {
    return { id: id, direction: dir, side: side, candleIndex: idx, confirmedAt: 1000000 + idx * BAR + BAR - 1,
        source: { liquidityId: 'L1', liquidityType: side === 'BSL' ? 'EQH' : 'EQL', liquidityPrice: 100, side: side } };
}
function mkMss(id, dir, idx) {
    return { id: id, direction: dir, candleIndex: idx, confirmedAt: 1000000 + idx * BAR + BAR - 1,
        source: { referenceSwingId: 'REF', referencePrice: 100 } };
}
function mkDisp(id, dir, idx) {
    return { id: id, direction: dir, candleIndex: idx, confirmedAt: 1000000 + idx * BAR + BAR - 1 };
}

/* ---------- buildNarratives ---------- */

test('Phase1：buildNarratives（SSL raid → Bull MSS → Bull Disp 完整链）', function () {
    var sweeps = [mkSweep('W1', 'BULLISH', 'SSL', 10)];
    var mss = [mkMss('M1', 'BULLISH', 20)];
    var legByDispId = { D1: { mssId: 'M1', startIndex: 25, endIndex: 30, direction: 'BULLISH', quality: 'STRONG' } };
    var ns = nla.buildNarratives({ sweeps: sweeps, mssEvents: mss, legByDispId: legByDispId });
    assert.strictEqual(ns.length, 1, '完整链 1 条');
    assert.strictEqual(ns[0].raidSide, 'SSL');
    assert.strictEqual(ns[0].mssId, 'M1');
    assert.strictEqual(ns[0].dispId, 'D1');
    assert.strictEqual(ns[0].raidToMssBars, 10);
    assert.strictEqual(ns[0].mssToDispBars, 5, 'disp start 25 - mss 20');
});

test('Phase1：buildNarratives（BSL 镜像 / 无同向 MSS / 无 leg 归属 → 不成链）', function () {
    // BSL raid → Bear MSS → Bear Disp
    var ns1 = nla.buildNarratives({
        sweeps: [mkSweep('W1', 'BEARISH', 'BSL', 10)],
        mssEvents: [mkMss('M1', 'BEARISH', 20)],
        legByDispId: { D1: { mssId: 'M1', startIndex: 25, endIndex: 30, direction: 'BEARISH', quality: 'EXPLOSIVE' } }
    });
    assert.strictEqual(ns1.length, 1, 'BSL→Bear 链');
    assert.strictEqual(ns1[0].raidSide, 'BSL');
    // 无同向 MSS（只有 BULLISH MSS，sweep 是 BEARISH）
    var ns2 = nla.buildNarratives({
        sweeps: [mkSweep('W1', 'BEARISH', 'BSL', 10)],
        mssEvents: [mkMss('M1', 'BULLISH', 20)],
        legByDispId: { D1: { mssId: 'M1', startIndex: 25, endIndex: 30, direction: 'BULLISH', quality: 'STRONG' } }
    });
    assert.strictEqual(ns2.length, 0, 'MSS 方向不匹配 → 不成链');
    // leg 归属不匹配（leg 由别的 MSS 触发）
    var ns3 = nla.buildNarratives({
        sweeps: [mkSweep('W1', 'BULLISH', 'SSL', 10)],
        mssEvents: [mkMss('M1', 'BULLISH', 20)],
        legByDispId: { D1: { mssId: 'OTHER', startIndex: 25, endIndex: 30, direction: 'BULLISH', quality: 'STRONG' } }
    });
    assert.strictEqual(ns3.length, 0, 'leg.mssId ≠ MSS → 不成链');
    // raid 前已有同向 MSS → raid 后无 → 不成链
    var ns4 = nla.buildNarratives({
        sweeps: [mkSweep('W1', 'BULLISH', 'SSL', 30)],
        mssEvents: [mkMss('M1', 'BULLISH', 20)],
        legByDispId: { D1: { mssId: 'M1', startIndex: 25, endIndex: 30, direction: 'BULLISH', quality: 'STRONG' } }
    });
    assert.strictEqual(ns4.length, 0, 'MSS 在 raid 前 → 不成链（因果顺序）');
});

/* ---------- outcomeOf ---------- */

test('Phase1：outcomeOf（MFE/MAE/NearHit/Continuation/Invalidation；outcome 在 disp 之后）', function () {
    var candles = [];
    for (var i = 0; i < 80; i++) candles.push(mkBar(i, 100, 101, 99, 100.5));
    // disp 于 bar25（close 100.5）；bar26-30 上涨（BULLISH MFE）
    candles[26] = mkBar(26, 100.5, 103, 100, 102.5);
    candles[27] = mkBar(27, 102.5, 104, 102, 103.5);
    // bar28 反向 MSS（invalidation）在 4h 内
    var mss = [mkMss('M1', 'BULLISH', 20), mkMss('M2', 'BEARISH', 28)];
    // bar40 同向 displacement（continuation）在 4h 内
    var disp = [mkDisp('D1', 'BULLISH', 25), mkDisp('D2', 'BULLISH', 40)];
    var drawTrace = { 25: { bslNear: 104, sslNear: 96 } }; // BULLISH → 上方 target 104
    var narr = { raidSide: 'SSL', dispIndex: 25 };
    var o = nla.outcomeOf(narr, { candles: candles, displacementEvents: disp, mssEvents: mss, drawTrace: drawTrace });
    assert.ok(o, 'outcome 存在');
    assert.ok(o.mfe30m > 0, '30m MFE > 0（bar26-27 上涨）');
    assert.strictEqual(o.nearHit1h, true, 'bar27 high 104 >= target 104 → NearHit1h');
    assert.strictEqual(o.continuation, true, 'bar40 同向 disp → continuation');
    assert.strictEqual(o.invalidated, true, 'bar28 反向 MSS → invalidated');
});

/* ---------- auditNarratives ---------- */

test('Phase1：auditNarratives（转化率 + 时间结构 median + outcome 汇总）', function () {
    var candles = [];
    for (var i = 0; i < 60; i++) candles.push(mkBar(i, 100, 101, 99, 100.5));
    candles[30] = mkBar(30, 100, 105, 99, 102);
    var sweeps = [mkSweep('W1', 'BULLISH', 'SSL', 10), mkSweep('W2', 'BEARISH', 'BSL', 40)];
    var mss = [mkMss('M1', 'BULLISH', 20), mkMss('M2', 'BEARISH', 45)];
    var legByDispId = {
        D1: { mssId: 'M1', startIndex: 25, endIndex: 30, direction: 'BULLISH', quality: 'STRONG' },
        D2: { mssId: 'M2', startIndex: 48, endIndex: 52, direction: 'BEARISH', quality: 'STRONG' }
    };
    var res = nla.auditNarratives({
        candles: candles, sweeps: sweeps, mssEvents: mss, displacementEvents: [],
        legByDispId: legByDispId, drawTrace: {}
    });
    assert.strictEqual(res.stats.totalSweeps, 2);
    assert.strictEqual(res.stats.narratives, 2, '两条完整链');
    assert.strictEqual(res.stats.narrByRaidSide.SSL, 1);
    assert.strictEqual(res.stats.narrByRaidSide.BSL, 1);
    assert.strictEqual(res.stats.medianBars.raidToMss, 7.5, 'median(10, 5) = 7.5');
    assert.strictEqual(res.stats.medianBars.mssToDisp, 4, 'median(5, 3) = 4');
    assert.ok(res.outcomeSummary.BULLISH && res.outcomeSummary.BULLISH.n === 1, 'BULLISH outcome 1');
    assert.ok(res.outcomeSummary.BEARISH && res.outcomeSummary.BEARISH.n === 1, 'BEARISH outcome 1');
});

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
