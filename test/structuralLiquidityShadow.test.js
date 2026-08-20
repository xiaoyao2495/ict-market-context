/**
 * Phase 12.5B — Structural Liquidity Causal Chain Shadow 测试
 *
 * 覆盖：
 *   - buildRaidIndex：raid 检测（BSL high>=price / SSL low<=price）、confirmedAt 后起扫、
 *     未穿越 → null
 *   - findCausalLiquidity：完整链命中（raid → 同方向 MSS → leg 归属）、方向不匹配不命中、
 *     raid 在 leg 后不命中、候选未确认不参与、误关联（旧 EQH 型：raid 远早于 leg 且无紧接
 *     MSS）被淘汰
 *   - auditCausalShadow：四象限划分 + 覆盖率 + 时间分布桶
 */
var assert = require('assert');
var sls = require('../stats/structuralLiquidityShadow');

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
function mkSwing(id, type, price, confirmBar) {
    return { id: id, symbol: 'X', timeframe: '5m', type: type, side: type === 'SWING_HIGH' ? 'BSL' : 'SSL',
        price: price, confirmedAt: 1000000 + confirmBar * BAR + BAR - 1,
        metadata: { index: confirmBar, source: 'dc' } };
}
function mkMss(id, dir, idx) {
    return { id: id, direction: dir, candleIndex: idx, confirmedAt: 1000000 + idx * BAR + BAR - 1,
        source: { referenceSwingId: 'REF', referencePrice: 100 } };
}
function mkAlert(id, dir, dispId, anchorIdx) {
    return { id: id, tier: 'HIGH_QUALITY', direction: dir, anchorIndex: anchorIdx, dispId: dispId,
        notificationPrice: 100, notificationNearTarget: null };
}

/* ---------- raid 索引 ---------- */

test('12.5B：buildRaidIndex（BSL high 穿越 / SSL low 穿越 / 未穿越 null）', function () {
    var candles = [];
    for (var i = 0; i < 30; i++) candles.push(mkBar(i, 100, 101, 99, 100.5));
    candles[12] = mkBar(12, 100, 105, 99, 103); // bar12 high 105 → BSL 候选 @104 raid
    candles[14] = mkBar(14, 103, 106, 95, 100); // bar14 low 95 → SSL 候选 @96 raid
    var swings = [
        mkSwing('BSL1', 'SWING_HIGH', 104, 5),
        mkSwing('SSL1', 'SWING_LOW', 96, 7),
        mkSwing('BSL2', 'SWING_HIGH', 120, 3) // 从未被穿越 → null
    ];
    var idx = sls.buildRaidIndex(swings, candles);
    assert.strictEqual(idx.raidByCandidateId['BSL1'].raidIndex, 12, 'BSL @104 在 bar12 被 raid');
    assert.strictEqual(idx.raidByCandidateId['SSL1'].raidIndex, 14, 'SSL @96 在 bar14 被 raid');
    assert.strictEqual(idx.raidByCandidateId['BSL2'], null, 'BSL @120 未被穿越');
    assert.strictEqual(idx.confirmBarById['BSL1'], 5);
});

/* ---------- 因果链判定 ---------- */

test('12.5B：findCausalLiquidity 完整链命中（raid → 同方向 MSS → leg 归属）', function () {
    var candles = [];
    for (var i = 0; i < 40; i++) candles.push(mkBar(i, 100, 101, 99, 100.5));
    candles[10] = mkBar(10, 100, 108, 99, 100);   // BSL @107 raid 于 bar10
    candles[12] = mkBar(12, 100, 109, 99, 107);   // bar12 大幅下跌前
    candles[13] = mkBar(13, 107, 108, 97, 98);    // BEARISH MSS 于 bar13
    var swings = [mkSwing('BSL1', 'SWING_HIGH', 107, 4)]; // 确认于 bar4，bar10 被 raid
    var mss = [mkMss('MSS1', 'BEARISH', 13)];
    var legByDispId = { d1: { mssId: 'MSS1', startIndex: 11, endIndex: 15, direction: 'BEARISH' } };
    var alert = mkAlert('A1', 'BEARISH', 'd1', 15);

    var ctx = {
        dcSwings: swings, dcMss: mss, candles: candles, legByDispId: legByDispId,
        raidByCandidateId: sls.buildRaidIndex(swings, candles).raidByCandidateId,
        confirmBarById: sls.buildRaidIndex(swings, candles).confirmBarById,
        mssByIndex: { 13: [mss[0]] }
    };
    var c = sls.findCausalLiquidity(alert, ctx);
    assert.ok(c, '因果链命中');
    assert.strictEqual(c.candidateId, 'BSL1');
    assert.strictEqual(c.side, 'BSL');
    assert.strictEqual(c.raidIndex, 10);
    assert.strictEqual(c.mssId, 'MSS1');
    assert.strictEqual(c.objectAgeAtRaid, 6, '确认 bar4 → raid bar10 = 6 bars');
    assert.strictEqual(c.raidToMssBars, 3, 'raid bar10 → MSS bar13');
    assert.strictEqual(c.mssToLegBars, 2, 'MSS bar13 - leg start 11 = +2（MSS 在 leg 内）');
    assert.strictEqual(c.raidToLegBars, 1, 'leg start 11 - raid 10');
});

test('12.5B：方向不匹配 / raid 在 leg 后 / 无 MSS → 不命中', function () {
    var candles = [];
    for (var i = 0; i < 40; i++) candles.push(mkBar(i, 100, 101, 99, 100.5));
    candles[10] = mkBar(10, 100, 108, 99, 100);
    var swings = [mkSwing('BSL1', 'SWING_HIGH', 107, 4)];
    var raidIdx = sls.buildRaidIndex(swings, candles);
    var mss = [mkMss('MSS1', 'BEARISH', 13)];
    function ctxFor(legStart, legMssId) {
        return {
            dcSwings: swings, dcMss: mss, candles: candles,
            legByDispId: { d1: { mssId: legMssId, startIndex: legStart, endIndex: 15, direction: 'BEARISH' } },
            raidByCandidateId: raidIdx.raidByCandidateId,
            confirmBarById: raidIdx.confirmBarById,
            mssByIndex: { 13: [mss[0]] }
        };
    }
    // 方向不匹配：BULLISH alert 只找 SSL，BSL 候选不参与
    var alertLong = mkAlert('A1', 'BULLISH', 'd1', 15);
    assert.strictEqual(sls.findCausalLiquidity(alertLong, ctxFor(11, 'MSS1')), null, 'BULLISH 不匹配 BSL 候选');
    // raid 在 leg 之后（leg 已完成才 raid）→ 因果顺序错
    var raidLate = sls.findCausalLiquidity(mkAlert('A1', 'BEARISH', 'd1', 15), ctxFor(5, 'MSS1'));
    assert.strictEqual(raidLate, null, 'leg.startIndex=5 < raid=10 → raid 在 leg 后 → 不命中');
    // leg.mssId 归属：MSS 必须属于当前 leg（leg.mssId === mss.id，同一因果链）
    var otherLeg = sls.findCausalLiquidity(mkAlert('A1', 'BEARISH', 'd1', 15), ctxFor(11, 'OTHER'));
    assert.strictEqual(otherLeg, null, 'leg.mssId=OTHER 与 MSS1 不匹配 → 非同一链 → 不命中');
});

test('12.5B【验收案例】旧 EQH 型误关联被淘汰（raid 远早于 leg 且无紧接 MSS）', function () {
    // 模拟 2267.09 案例：candidate 确认很早（bar 4），raid 在 bar 8（很早），
    // 之后直到 leg（bar 30 起）都没有方向匹配的 MSS → 因果链不命中
    var candles = [];
    for (var i = 0; i < 45; i++) candles.push(mkBar(i, 100, 101, 99, 100.5));
    candles[8] = mkBar(8, 100, 106, 99, 100); // raid bar8
    var swings = [mkSwing('OLD', 'SWING_HIGH', 105, 4)];
    // 无任何 BEARISH MSS（或 MSS 远在 leg 后）
    var mss = [mkMss('MSS1', 'BEARISH', 40)]; // MSS 在 leg（30）之后 → raid 后第一个同方向 MSS 是 40，
    // raid(8) → MSS(40)：raidToMssBars=32。宽松版会命中（有同方向 MSS）…… 用 no-MSS 场景更贴合：
    var mssNone = [];
    var ctx = {
        dcSwings: swings, dcMss: mssNone, candles: candles,
        legByDispId: { d1: { mssId: null, startIndex: 30, endIndex: 35, direction: 'BEARISH' } },
        raidByCandidateId: sls.buildRaidIndex(swings, candles).raidByCandidateId,
        confirmBarById: sls.buildRaidIndex(swings, candles).confirmBarById,
        mssByIndex: {}
    };
    var c = sls.findCausalLiquidity(mkAlert('A1', 'BEARISH', 'd1', 35), ctx);
    assert.strictEqual(c, null, 'raid 后无同方向 MSS → 旧 EQH 型不命中（因果链替代窗口相关性）');
});

/* ---------- 聚合 ---------- */

test('12.5B：auditCausalShadow 四象限 + 覆盖率 + 分布', function () {
    var candles = [];
    for (var i = 0; i < 40; i++) candles.push(mkBar(i, 100, 101, 99, 100.5));
    candles[10] = mkBar(10, 100, 108, 99, 100);
    var swings = [mkSwing('BSL1', 'SWING_HIGH', 107, 4)];
    var mss = [mkMss('MSS1', 'BEARISH', 13)];
    var raidIdx = sls.buildRaidIndex(swings, candles);
    var legByDispId = { d1: { mssId: 'MSS1', startIndex: 11, endIndex: 15, direction: 'BEARISH' } };
    var ctx = {
        dcSwings: swings, dcMss: mss, candles: candles, legByDispId: legByDispId,
        raidByCandidateId: raidIdx.raidByCandidateId,
        confirmBarById: raidIdx.confirmBarById,
        mssByIndex: { 13: [mss[0]] }
    };
    // alert1：因果命中（dispId d1）+ 窗口相关（构造 liquidityContext allCandidates 有 significant）→ BOTH
    var a1 = mkAlert('A1', 'BEARISH', 'd1', 15);
    a1.liquidityContext = { allCandidates: [{ sourceType: 'EQH', sourcePrice: 105, barsBeforeLegStart: 5 }] };
    // alert2：因果命中但窗口无 significant → CAUSAL_ONLY
    var a2 = mkAlert('A2', 'BEARISH', 'd1', 16);
    a2.liquidityContext = { allCandidates: [{ sourceType: 'SWING_HIGH', sourcePrice: 105, barsBeforeLegStart: 5 }] };
    // alert3：窗口 significant 但因果不命中（方向不匹配 BULLISH）→ WINDOW_ONLY
    var a3 = mkAlert('A3', 'BULLISH', 'd1', 17);
    a3.liquidityContext = { allCandidates: [{ sourceType: 'EQL', sourcePrice: 96, barsBeforeLegStart: 3 }] };
    // alert4：都无 → NEITHER
    var a4 = mkAlert('A4', 'BULLISH', 'd1', 18);
    a4.liquidityContext = { allCandidates: [] };

    var res = sls.auditCausalShadow([a1, a2, a3, a4], ctx);
    assert.strictEqual(res.total, 4);
    assert.strictEqual(res.quadrants.BOTH.n, 1);
    assert.strictEqual(res.quadrants.CAUSAL_ONLY.n, 1);
    assert.strictEqual(res.quadrants.WINDOW_ONLY.n, 1);
    assert.strictEqual(res.quadrants.NEITHER.n, 1);
    assert.strictEqual(res.causalRate, 0.5, '2/4 命中因果链');
    assert.strictEqual(res.windowRate, 0.5, '2/4 窗口相关');
    // 分布：BOTH+CAUSAL_ONLY 各 1 个 causal 样本 → objectAgeAtRaid 桶有值
    var distTotal = Object.keys(res.dist.objectAgeAtRaid).reduce(function (s, k) { return s + res.dist.objectAgeAtRaid[k]; }, 0);
    assert.strictEqual(distTotal, 2, '2 个 causal 样本进分布');
});

/* ---------- 12.5B.2 Corroboration Audit ---------- */

test('12.5B.2：corrGroupOf 分类（PD / EQL / SESSION / null）', function () {
    assert.strictEqual(sls.corrGroupOf('PDH'), 'PD');
    assert.strictEqual(sls.corrGroupOf('PDL'), 'PD');
    assert.strictEqual(sls.corrGroupOf('PWH'), 'PD');
    assert.strictEqual(sls.corrGroupOf('EQL'), 'EQL');
    assert.strictEqual(sls.corrGroupOf('EQH'), 'EQL');
    assert.strictEqual(sls.corrGroupOf('ASIA_HIGH'), 'SESSION');
    assert.strictEqual(sls.corrGroupOf('LONDON_LOW'), 'SESSION');
    assert.strictEqual(sls.corrGroupOf('NEW_YORK_HIGH'), 'SESSION');
    assert.strictEqual(sls.corrGroupOf('SESSION_HIGH'), 'SESSION');
    assert.strictEqual(sls.corrGroupOf('SWING_HIGH'), null, '普通 swing 不是 corroboration');
    assert.strictEqual(sls.corrGroupOf('FVG'), null);
    assert.strictEqual(sls.corrGroupOf(''), null);
});

test('12.5B.2：corrBuckets 归属（单类 / overlap 多桶 / ONLY）+ hasStrong', function () {
    var candles = [];
    for (var i = 0; i < 40; i++) candles.push(mkBar(i, 100, 101, 99, 100.5));
    candles[10] = mkBar(10, 100, 108, 99, 100);
    var swings = [mkSwing('BSL1', 'SWING_HIGH', 107, 4)];
    var mss = [mkMss('MSS1', 'BEARISH', 13)];
    var raidIdx = sls.buildRaidIndex(swings, candles);
    var legByDispId = {
        d1: { mssId: 'MSS1', startIndex: 11, endIndex: 15, direction: 'BEARISH' },
        D1: { mssId: 'MSS1', startIndex: 11, endIndex: 15, direction: 'BEARISH', quality: 'EXPLOSIVE' }
    };
    var dispByIndex = { 16: [{ id: 'D1', direction: 'BEARISH', candleIndex: 16 }] };
    var ctx = {
        dcSwings: swings, dcMss: mss, candles: candles, legByDispId: legByDispId,
        dispByIndex: dispByIndex,
        raidByCandidateId: raidIdx.raidByCandidateId,
        confirmBarById: raidIdx.confirmBarById,
        mssByIndex: { 13: [mss[0]] }
    };
    // a1：causal 命中 + EQH 佐证 → EQL 桶；anchor 15 → hasStrong 窗口 16-27（D1 @16 EXPLOSIVE 同向）
    var a1 = mkAlert('A1', 'BEARISH', 'd1', 15);
    a1.liquidityContext = { allCandidates: [{ sourceType: 'EQH', sourcePrice: 105, barsBeforeLegStart: 5 }] };
    // a2：causal 命中 + PDH+EQL 双佐证 → PD 桶 + EQL 桶 + MULTI 桶（overlap）
    var a2 = mkAlert('A2', 'BEARISH', 'd1', 16);
    a2.liquidityContext = { allCandidates: [
        { sourceType: 'PDH', sourcePrice: 108, barsBeforeLegStart: 3 },
        { sourceType: 'EQL', sourcePrice: 96, barsBeforeLegStart: 4 }
    ] };
    // a3：causal 命中但佐证只有普通 swing（非 significant）→ ONLY 桶
    var a3 = mkAlert('A3', 'BEARISH', 'd1', 17);
    a3.liquidityContext = { allCandidates: [{ sourceType: 'SWING_HIGH', sourcePrice: 105, barsBeforeLegStart: 2 }] };

    var res = sls.auditCausalShadow([a1, a2, a3], ctx);
    assert.strictEqual(res.corrBuckets.EQL.n, 2, 'a1(EQH) + a2(EQL) → EQL 桶 2（overlap 计数）');
    assert.strictEqual(res.corrBuckets.PD.n, 1, 'a2(PDH) → PD 桶 1');
    assert.strictEqual(res.corrBuckets.SESSION.n, 0);
    assert.strictEqual(res.corrBuckets.MULTI.n, 1, 'a2 双佐证 → MULTI 桶 1');
    assert.strictEqual(res.corrBuckets.ONLY.n, 1, 'a3 无 significant 佐证 → ONLY 桶 1（= CAUSAL_ONLY 组）');
    // hasStrong：a1 anchor15 → 窗口 16-27 命中 D1 EXPLOSIVE（同方向 BEARISH）；a2/a3 窗口不命中
    assert.strictEqual(res.corrBuckets.EQL.hasStrongN, 2);
    assert.strictEqual(res.corrBuckets.EQL.hasStrong, 1, 'EQL 桶 hasStrong=1（仅 a1 命中）');
    assert.strictEqual(res.corrBuckets.PD.hasStrong, 0, 'PD 桶（a2）窗口 17-28 无 disp → 0');
    assert.strictEqual(res.corrBuckets.ONLY.hasStrong, 0, 'ONLY 桶（a3 anchor17）窗口 18-29 无 disp → 0');
});

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
