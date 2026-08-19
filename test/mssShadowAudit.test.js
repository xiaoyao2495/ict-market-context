/**
 * Phase 11L.8 第二刀 — MSS↔Leg Shadow Association Audit 测试
 *
 * 覆盖：
 *   - associateRelatedMss 三组分类（INSIDE_LEG / BEFORE_LEG / NO_RELATED_MSS）
 *   - 方向匹配（BULLISH leg ← BULLISH MSS）
 *   - 距离 leg.startIndex 最近；距离相同取 confirmedAt 更新
 *   - confirmedAt > availableAt 排除（无 future leakage）
 *   - beforeLookbackBars 边界（6 根内关联、7 根外不关联）
 *   - buildShadowItems：其他维度冻结，只换 MSS 关联 → tier 变化
 *   - assessShadow 分组统计（HIGH 子集 NearHit30m/1h/MFE/MAE + all 对照）
 */
var assert = require('assert');
var msa = require('../stats/mssShadowAudit');
var opportunity = require('../stats/opportunity');
var displacementLeg = require('../stats/displacementLeg');
var opportunityQuality = require('../stats/opportunityQuality');

var passed = 0;
var failed = 0;

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log('PASS ' + name);
    } catch (e) {
        failed++;
        console.log('FAIL ' + name + ' -> ' + e.message);
    }
}

var BAR = 300000;
function m5(open, high, low, close, i) {
    var t = 1000000 + i * BAR;
    return { openTime: t, open: open, high: high, low: low, close: close, closeTime: t + BAR - 1, closed: true, source: 'futures' };
}
function mss(over) {
    var m = {
        id: 'MSS:X', symbol: 'X', timeframe: '5m', type: 'MSS', direction: 'BULLISH',
        confirmedAt: 1200001, candleIndex: 8,
        source: { referenceSwingId: 'SW1', referencePrice: 99, breakDistance: 1, breakPct: 0.01 },
        metadata: { bodyRatio: 0.8 }
    };
    if (over) {
        for (var k in over) {
            if (Object.prototype.hasOwnProperty.call(over, k)) m[k] = over[k];
        }
    }
    return m;
}

var LEG_INSIDE = { startIndex: 10, endIndex: 12, lastIndex: 12, direction: 'BULLISH', firstConfirmedAt: 1300001, lastConfirmedAt: 1500001 };
var LEG_BEFORE = { startIndex: 10, endIndex: 12, lastIndex: 12, direction: 'BULLISH', firstConfirmedAt: 1300001, lastConfirmedAt: 1500001 };

/* ---------- 三组分类 ---------- */

test('11L.8-S2：INSIDE_LEG（MSS 同根/腿内）', function () {
    var rel = msa.associateRelatedMss(LEG_INSIDE, [mss({ candleIndex: 10 })], {});
    assert.strictEqual(rel.relation, 'INSIDE_LEG');
    assert.ok(rel.mssEvent);
});

test('11L.8-S2：BEFORE_LEG（MSS 在 leg.start 前 1~6 根）', function () {
    var rel = msa.associateRelatedMss(LEG_BEFORE, [mss({ candleIndex: 5 })], { beforeLookbackBars: 6 });
    assert.strictEqual(rel.relation, 'BEFORE_LEG', 'start 10 - 5 = 5 → 前 6 根内');
    assert.ok(rel.mssEvent);
});

test('11L.8-S2：NO_RELATED_MSS（窗口内无方向匹配 MSS）', function () {
    var rel = msa.associateRelatedMss(LEG_BEFORE, [], {});
    assert.strictEqual(rel.relation, 'NO_RELATED_MSS');
    assert.strictEqual(rel.mssEvent, null);
});

test('11L.8-S2：方向不匹配不关联（BULLISH leg 不关联 BEARISH MSS）', function () {
    var rel = msa.associateRelatedMss(LEG_BEFORE, [mss({ direction: 'BEARISH', candleIndex: 5 })], { beforeLookbackBars: 6 });
    assert.strictEqual(rel.relation, 'NO_RELATED_MSS');
});

/* ---------- 选择规则 ---------- */

test('11L.8-S2：距离 leg.startIndex 最近；距离相同取 confirmedAt 更新', function () {
    var far = mss({ id: 'far', candleIndex: 5, confirmedAt: 1100001 });   // 距 10 = 5
    var near = mss({ id: 'near', candleIndex: 8, confirmedAt: 1250001 }); // 距 10 = 2 → 最近
    var rel = msa.associateRelatedMss(LEG_BEFORE, [far, near], { beforeLookbackBars: 6 });
    assert.strictEqual(rel.mssEvent.id, 'near');
    // 距离相同取 confirmedAt 更新
    var a = mss({ id: 'a', candleIndex: 8, confirmedAt: 1100001 });
    var b = mss({ id: 'b', candleIndex: 12, confirmedAt: 1250001 }); // |10-12|=2 与 a 同距，更新
    var rel2 = msa.associateRelatedMss(LEG_INSIDE, [a, b], {});
    assert.strictEqual(rel2.mssEvent.id, 'b');
});

test('11L.8-S2：confirmedAt > availableAt → 排除（无 future leakage）', function () {
    var rel = msa.associateRelatedMss(LEG_BEFORE, [mss({ candleIndex: 5, confirmedAt: 9000001 })], {
        beforeLookbackBars: 6, availableAt: 2000000
    });
    assert.strictEqual(rel.relation, 'NO_RELATED_MSS', '未来 MSS 被排除');
});

test('11L.8-S2：beforeLookbackBars 边界（6 根内关联、7 根外不关联）', function () {
    var relIn = msa.associateRelatedMss(LEG_BEFORE, [mss({ candleIndex: 10 - 6 })], { beforeLookbackBars: 6 }); // 恰好 6 根前
    assert.strictEqual(relIn.relation, 'BEFORE_LEG', '6 根前 → 窗口内');
    var relOut = msa.associateRelatedMss(LEG_BEFORE, [mss({ candleIndex: 10 - 7 })], { beforeLookbackBars: 6 }); // 7 根前
    assert.strictEqual(relOut.relation, 'NO_RELATED_MSS', '7 根前 → 窗口外');
});

/* ---------- buildShadowItems：其他冻结，只换 MSS 关联 ---------- */

test('11L.8-S2：BEFORE_LEG shadow 使 tier 从 LOW 升为 HIGH（其他维度冻结）', function () {
    var candles = [];
    for (var i = 0; i < 60; i++) candles.push(m5(100, 101, 99, 100.5, i));
    // 同根无 MSS（生产 same-candle 关联不到）→ 现有 tier LOW；leg 前 5 根有 BULLISH MSS → shadow HIGH
    var fvgs = [{ id: 'f1', direction: 'BULLISH', displacementEventId: 'd1', zoneLow: 100.2, zoneHigh: 100.8 }];
    var opps = [{ id: 'm1', direction: 'BULLISH', fvgIds: ['f1'], createdAt: 1000000, lastAt: 1400000 }];
    var legByDispId = {
        d1: {
            quality: 'EXPLOSIVE', mssQuality: 'NO_MSS',
            startIndex: 10, endIndex: 12, lastIndex: 12,
            firstConfirmedAt: candles[10].closeTime, lastConfirmedAt: candles[12].closeTime,
            direction: 'BULLISH', ids: ['d1'], rangeAtr: 2.6, netMoveAtr: 2.1, bodyEfficiency: 0.7
        }
    };
    var drawTrace = [];
    drawTrace[12] = { bslNear: 105, bslMacro: 110, sslNear: null, sslMacro: null };
    // MSS 在 leg 前 5 根（candleIndex 5），strong break + 最近 opposing → PROTECTED_SWING
    var swings = [{ id: 'SW1', type: 'SWING_HIGH', price: 99, index: 3, confirmedAt: candles[3].closeTime, timeframe: '5m' }];
    var mssEvents = [{
        id: 'm1', symbol: 'X', timeframe: '5m', type: 'MSS', direction: 'BULLISH',
        candleIndex: 5, confirmedAt: candles[5].closeTime,
        source: { referenceSwingId: 'SW1', referencePrice: 99, breakDistance: 1.5, breakPct: 0.015 },
        metadata: { bodyRatio: 0.9 }
    }];
    var items = msa.buildShadowItems(opps, fvgs, legByDispId, mssEvents, swings, drawTrace, candles, {});
    assert.strictEqual(items.length, 1);
    var it = items[0];
    assert.strictEqual(it.group, 'BEFORE_LEG', 'MSS 在 leg 前 5 根');
    assert.strictEqual(it.tier, 'HIGH_QUALITY', 'shadow 关联 BEFORE MSS → HIGH（现有生产为 NO_MSS → LOW）');
    assert.strictEqual(it.legQuality, 'EXPLOSIVE', 'legQuality 冻结不变');
    assert.strictEqual(it.mssQuality, 'HTF_RELEVANT', 'shadow mssQuality 由 related MSS 算出（最近 opposing + 近期极值 + 强突破）');
});

test('11L.8-S2：NO_RELATED_MSS 永不成为 HIGH（NO_MSS → LOW）', function () {
    var candles = [];
    for (var i = 0; i < 60; i++) candles.push(m5(100, 101, 99, 100.5, i));
    var fvgs = [{ id: 'f1', direction: 'BULLISH', displacementEventId: 'd1', zoneLow: 100.2, zoneHigh: 100.8 }];
    var opps = [{ id: 'm1', direction: 'BULLISH', fvgIds: ['f1'], createdAt: 1000000, lastAt: 1400000 }];
    var legByDispId = {
        d1: {
            quality: 'EXPLOSIVE', mssQuality: 'NO_MSS',
            startIndex: 10, endIndex: 12, lastIndex: 12,
            firstConfirmedAt: candles[10].closeTime, lastConfirmedAt: candles[12].closeTime,
            direction: 'BULLISH', ids: ['d1'], rangeAtr: 2.6, netMoveAtr: 2.1, bodyEfficiency: 0.7
        }
    };
    var drawTrace = [];
    drawTrace[12] = { bslNear: 105, bslMacro: 110, sslNear: null, sslMacro: null };
    var items = msa.buildShadowItems(opps, fvgs, legByDispId, [], [], drawTrace, candles, {});
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].group, 'NO_RELATED_MSS');
    assert.strictEqual(items[0].tier, 'LOW_QUALITY', '无 MSS → NO_MSS → LOW');
    assert.strictEqual(items[0].mssQuality, 'NO_MSS');
});

/* ---------- assessShadow 统计 ---------- */

test('11L.8-S2：assessShadow 分组统计（HIGH 子集 + all 对照）', function () {
    var candles = [];
    for (var i = 0; i < 60; i++) candles.push(m5(100, 101, 99, 100.5, i));
    // BEFORE 组：HIGH，通知后 1h 内触达 near 105
    candles[20] = m5(100.5, 104, 100.4, 103, 20);
    candles[21] = m5(103, 105.5, 102.9, 105.2, 21); // high >= 105 → near hit
    var items = [
        { id: 'a', direction: 'BULLISH', group: 'BEFORE_LEG', tier: 'HIGH_QUALITY',
          availableIndex: 19, notificationPrice: 100.5, notificationNearTarget: 105 },
        { id: 'b', direction: 'BULLISH', group: 'NO_RELATED_MSS', tier: 'LOW_QUALITY',
          availableIndex: 18, notificationPrice: 100.5, notificationNearTarget: 105 }
    ];
    var g = msa.assessShadow(items, candles);
    assert.strictEqual(g.BEFORE_LEG.all, 1);
    assert.strictEqual(g.BEFORE_LEG.high, 1);
    assert.strictEqual(g.BEFORE_LEG.highNearHit1h, 1, '1h 内触达 near');
    assert.strictEqual(g.BEFORE_LEG.highNearHit30m, 1, '30m 内触达（20-21 在 6 根内）');
    assert.ok(g.BEFORE_LEG.highMfeCnt === 1 && g.BEFORE_LEG.highMfeSum > 0, 'MFE 计入');
    assert.strictEqual(g.NO_RELATED_MSS.all, 1);
    assert.strictEqual(g.NO_RELATED_MSS.high, 0, 'LOW 不进 HIGH 统计');
    assert.strictEqual(g.NO_RELATED_MSS.allNearHit1h, 1, 'all 对照统计保留');
});

test('11L.8-S2：assessShadow —— BEARISH 样本 MAE 非负（防符号回归）', function () {
    var candles = [];
    for (var i = 0; i < 40; i++) candles.push(m5(100, 101, 99, 100.5, i));
    var items = [{
        id: 'b', direction: 'BEARISH', group: 'BEFORE_LEG', tier: 'HIGH_QUALITY',
        availableIndex: 10, notificationPrice: 100, notificationNearTarget: 90
    }];
    var g = msa.assessShadow(items, candles);
    assert.ok(g.BEFORE_LEG.highMaeSum >= 0, 'BEARISH MAE 必须非负（曾因复制错误为负）');
    assert.ok(g.BEFORE_LEG.highMfeSum >= 0, 'BEARISH MFE 必须非负');
});

/* ---------- 与 buildWindowedLegIndex 集成（权威路径） ---------- */

test('11L.8-S2：associateRelatedMss 可消费 buildWindowedLegIndex 的 leg（字段对齐）', function () {
    var candles = [];
    for (var i = 0; i < 40; i++) candles.push(m5(100, 101, 99, 100.5, i));
    var displacements = [{
        id: 'd1', symbol: 'X', timeframe: '5m', type: 'DISPLACEMENT', direction: 'BULLISH',
        confirmedAt: candles[10].closeTime, candleIndex: 10,
        metadata: { mssEventId: null, atr: 1 }
    }];
    var mssEvents = [mss({ id: 'm1', candleIndex: 6, confirmedAt: candles[6].closeTime })];
    var idx = displacementLeg.buildWindowedLegIndex(displacements, candles, mssEvents, [], 900000);
    var leg = idx['d1'];
    assert.ok(leg, 'leg 构建成功');
    assert.strictEqual(leg.startIndex, 10);
    var rel = msa.associateRelatedMss(leg, mssEvents, { beforeLookbackBars: 6, availableAt: candles[10].closeTime });
    assert.strictEqual(rel.relation, 'BEFORE_LEG', 'MSS 在 leg 前 4 根');
});

// ---------- 结果 ----------
console.log('mssShadowAudit tests: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) {
    process.exit(1);
}
