/**
 * Phase 11L.7 — ICT Trigger Price Shadow Audit 测试
 *
 * 锁定语义：
 *   - OTE range = Canonical Displacement formation start→end
 *     BULLISH 回撤从高往低 / BEARISH 从低往高
 *   - FVG_TOUCH = 首次进入 FVG（BULLISH low<=zoneHigh）；FVG_CE = 中点
 *   - 触发扫描从 availableIndex+1 开始（无 information-availability leakage）
 *   - 等待期限 HORIZON_BARS（超过 → NO_TRIGGER）
 *   - post-trigger 质量从 triggerIndex+1（N+1）起算，MFE/MAE 以触发价为基准
 *   - NO_TRIGGER 但 near 命中 → noTriggerButNearHit（错过 delivery）
 *   - Effective Capture = TriggerRate × NearHit1h
 */
var assert = require('assert');
var tpa = require('../stats/triggerPriceAudit');

var passed = 0;
var failed = 0;

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log('PASS  ' + name);
    } catch (e) {
        failed++;
        console.log('FAIL  ' + name + '  ->  ' + e.message);
    }
}

function mkCandle(i, open, high, low, close) {
    var base = 1700000000000 + i * 300000;
    return { openTime: base, closeTime: base + 299999, open: open, high: high, low: low, close: close, source: 'futures' };
}

// 一个 BULLISH leg：index0..3 从 98 推升到 110（legHigh=110, legLow=97，跨整段位移）
// OTE_62 = 110 - 0.62*(110-97) = 101.94；OTE_70_5 = 110 - 0.705*13 = 100.835
// FVG zone [102, 106] → CE = 104
function buildFixture() {
    var candles = [];
    // availableIndex = 4（anchor=3）
    candles.push(mkCandle(0, 98, 100, 97, 99));
    candles.push(mkCandle(1, 99, 102, 98, 101));
    candles.push(mkCandle(2, 101, 104, 100, 103));
    candles.push(mkCandle(3, 103, 110, 102, 109)); // leg end (anchor)
    candles.push(mkCandle(4, 109, 110, 108, 109)); // availableAt
    // 之后回撤
    candles.push(mkCandle(5, 109, 109, 106.5, 108)); // 触 CE(104)? low 106.5 未到；触 zoneHigh(106)? 未到
    candles.push(mkCandle(6, 108, 108, 104.2, 106)); // 触 CE(104)? low 104.2 未到；触 zoneHigh(106) yes
    candles.push(mkCandle(7, 106, 106, 103.5, 105)); // 触 CE(104) yes (low 103.5<=104)；触 OTE62(101.94)? no
    return candles;
}

test('computeTriggerPrices: BULLISH OTE 从 legHigh 往下算', function () {
    var candles = buildFixture();
    var leg = { ids: ['D1'], startIndex: 0, endIndex: 3, direction: 'BULLISH' };
    var legByDispId = { 'D1': leg };
    var fvg = { id: 'F1', zoneLow: 102, zoneHigh: 106, direction: 'BULLISH', displacementEventId: 'D1' };
    var fvgById = { 'F1': fvg };
    var item = { direction: 'BULLISH', canonicalDisplacementId: 'D1', fvgIds: ['F1'], availableIndex: 4 };
    var p = tpa.computeTriggerPrices(item, fvgById, legByDispId, candles);
    assert.strictEqual(p.availPrice, 109);
    assert.strictEqual(p.legHigh, 110);
    assert.strictEqual(p.legLow, 97);
    assert.ok(Math.abs(p.ote.OTE_62 - 101.94) < 1e-9);
    assert.ok(Math.abs(p.ote.OTE_70_5 - 100.835) < 1e-9);
    assert.strictEqual(p.fvgCe, 104);
});

test('computeTriggerPrices: BEARISH OTE 从 legLow 往上算', function () {
    var candles = [];
    candles.push(mkCandle(0, 110, 111, 100, 101)); // leg end (anchor)
    candles.push(mkCandle(1, 101, 101, 100, 101)); // availableAt
    var leg = { ids: ['D2'], startIndex: 0, endIndex: 0, direction: 'BEARISH' };
    var p = tpa.computeTriggerPrices(
        { direction: 'BEARISH', canonicalDisplacementId: 'D2', fvgIds: [], availableIndex: 1 },
        {}, { 'D2': leg }, candles);
    assert.strictEqual(p.legHigh, 111);
    assert.strictEqual(p.legLow, 100);
    assert.ok(Math.abs(p.ote.OTE_62 - (100 + 0.62 * 11)) < 1e-9);
    assert.ok(Math.abs(p.ote.OTE_70_5 - (100 + 0.705 * 11)) < 1e-9);
});

test('candleTriggers: BULLISH 回撤触发条件是 low<=trigger', function () {
    var c = { high: 105, low: 103.5 };
    assert.strictEqual(tpa.candleTriggers(c, true, 104), true);
    assert.strictEqual(tpa.candleTriggers(c, true, 103.8), true);
    assert.strictEqual(tpa.candleTriggers(c, true, 103.4), false);
});

test('candleTriggers: BEARISH 回撤触发条件是 high>=trigger', function () {
    var c = { high: 104, low: 102 };
    assert.strictEqual(tpa.candleTriggers(c, false, 103.5), true);
    assert.strictEqual(tpa.candleTriggers(c, false, 104.5), false);
});

test('simulateOne: 触发扫描必须从 availableIndex+1 开始（无 leakage）', function () {
    var candles = buildFixture();
    var leg = { ids: ['D1'], startIndex: 0, endIndex: 3, direction: 'BULLISH' };
    var fvg = { id: 'F1', zoneLow: 102, zoneHigh: 106, direction: 'BULLISH', displacementEventId: 'D1' };
    var item = { direction: 'BULLISH', canonicalDisplacementId: 'D1', fvgIds: ['F1'], availableIndex: 4, nearTarget: 116 };
    var r = tpa.simulateOne(item, { 'F1': fvg }, { 'D1': leg }, candles);
    // availableIndex=4 → 扫描从 5 开始。index6 low104.2 触 FVG_TOUCH(106)；index7 才触 CE(104)
    var pm = r.perModel;
    assert.strictEqual(pm.AVAILABLE.triggered, true);
    assert.strictEqual(pm.AVAILABLE.triggerIndex, 4);
    assert.strictEqual(pm.AVAILABLE.waitBars, 0);
    assert.strictEqual(pm.FVG_TOUCH.triggered, true);
    assert.strictEqual(pm.FVG_TOUCH.triggerIndex, 6, 'index6 low104.2<=106 首触 FVG');
    assert.strictEqual(pm.FVG_CE.triggered, true);
    assert.strictEqual(pm.FVG_CE.triggerIndex, 7, 'index7 low103.5<=104 首触 CE');
    assert.strictEqual(pm.OTE_62.triggered, false, 'legLow=97 → OTE62=101.94 未回撤到');
    assert.strictEqual(pm.OTE_70_5.triggered, false, '未回撤到 100.835');
});

test('simulateOne: availableIndex 越界（无可验证行情）→ 返回 null', function () {
    var candles = [mkCandle(0, 100, 102, 99, 101)];
    var item = { direction: 'BULLISH', canonicalDisplacementId: 'D1', fvgIds: [], availableIndex: 0, nearTarget: 110 };
    var r = tpa.simulateOne(item, {}, {}, candles);
    assert.strictEqual(r, null, 'availableIndex+1 >= candles.length');
});

test('simulateOne: 等待期限超过 HORIZON_BARS → NO_TRIGGER', function () {
    // leg high 110 low 100，OTE62=103.8，但 48 根内永不回撤
    var candles = [];
    // availableIndex = 3
    candles.push(mkCandle(0, 100, 110, 100, 109)); // leg end
    candles.push(mkCandle(1, 109, 111, 108, 110)); // availableAt
    candles.push(mkCandle(2, 110, 111, 108, 108));
    for (var i = 3; i < 3 + tpa.HORIZON_BARS + 2; i++) {
        candles.push(mkCandle(i, 108, 109, 107, 108)); // 永不回撤到 103.8
    }
    var leg = { ids: ['D1'], startIndex: 0, endIndex: 0, direction: 'BULLISH' };
    var item = { direction: 'BULLISH', canonicalDisplacementId: 'D1', fvgIds: [], availableIndex: 1, nearTarget: 115 };
    var r = tpa.simulateOne(item, {}, { 'D1': leg }, candles);
    assert.strictEqual(r.perModel.OTE_62.triggered, false);
    assert.strictEqual(r.perModel.OTE_62.triggerIndex, null);
});

test('assess: BASELINE effectiveCapture = NearHit1h（triggerRate=1）', function () {
    // 构造 availableIndex=0，triggerIndex=0；post-trigger 从 1 起；近端在 index1 命中
    var candles = [];
    candles.push(mkCandle(0, 100, 110, 100, 109)); // availableAt & trigger
    candles.push(mkCandle(1, 109, 116, 108, 115)); // 触 near 116
    candles.push(mkCandle(2, 115, 117, 114, 116));
    var item = { direction: 'BULLISH', canonicalDisplacementId: 'D1', fvgIds: [], availableIndex: 0, nearTarget: 116, tier: 'HIGH_QUALITY', hasDisplacement: true };
    var leg = { ids: ['D1'], startIndex: 0, endIndex: 0, direction: 'BULLISH' };
    var results = tpa.simulateAll([item], [], { 'D1': leg }, candles);
    assert.strictEqual(results.length, 1);
    var a = tpa.assess(results, candles);
    assert.strictEqual(a.AVAILABLE.triggerRate, 1);
    assert.strictEqual(a.AVAILABLE.nearHit1h, 1);
    assert.strictEqual(a.AVAILABLE.nearHit30m, 1);
    assert.strictEqual(a.AVAILABLE.effectiveCapture, 1);
    // 其他模型无 FVG/leg 摆动区? leg 存在但 OTE 也触发（index1 high116>=? BEARISH 才比较 high）——
    // BULLISH 用 low，index1 low108 不触发 OTE62(103.8)，FVG 无 zone → unavailable
    assert.strictEqual(a.FVG_TOUCH.unavailable, 1);
    assert.strictEqual(a.OTE_62.triggered, 0);
    assert.strictEqual(a.OTE_62.noTriggerButNearHit, 1, '未触发但 near 在 horizon 内命中');
});

test('assess: NO_TRIGGER 但 near 命中 → noTriggerButNearHit 计入', function () {
    // availableIndex=0；OTE62 永不触发；near 在 horizon 内命中
    var candles = [];
    candles.push(mkCandle(0, 100, 110, 100, 109));
    for (var i = 1; i < 10; i++) candles.push(mkCandle(i, 109, 116, 108, 115)); // 触 near 115 但不回撤
    var item = { direction: 'BULLISH', canonicalDisplacementId: 'D1', fvgIds: [], availableIndex: 0, nearTarget: 115, tier: 'HIGH_QUALITY', hasDisplacement: true };
    var leg = { ids: ['D1'], startIndex: 0, endIndex: 0, direction: 'BULLISH' };
    var r = tpa.simulateAll([item], [], { 'D1': leg }, candles);
    var a = tpa.assess(r, candles);
    assert.strictEqual(a.OTE_62.noTriggerButNearHit, 1);
    assert.strictEqual(a.OTE_62.triggered, 0);
});

test('assess: MFE/MAE 以触发价为基准（post-trigger N+1 起算）', function () {
    var candles = [];
    candles.push(mkCandle(0, 100, 100, 100, 100)); // availableAt & BASELINE trigger
    candles.push(mkCandle(1, 100, 106, 99, 105));  // post-trigger 从1起，MFE=6
    candles.push(mkCandle(2, 105, 108, 104, 107)); // MFE=8, MAE: high-max 108-100=8? 用低点 104→MAE=1
    var item = { direction: 'BULLISH', canonicalDisplacementId: 'D1', fvgIds: [], availableIndex: 0, nearTarget: null, tier: 'HIGH_QUALITY', hasDisplacement: true };
    var leg = { ids: ['D1'], startIndex: 0, endIndex: 0, direction: 'BULLISH' };
    var r = tpa.simulateAll([item], [], { 'D1': leg }, candles);
    var a = tpa.assess(r, candles);
    // BASELINE triggerPrice=100；1h MFE = 平均 (high-100) 最大 = (108-100)=8 → 8/100*100=8%
    assert.ok(Math.abs(a.AVAILABLE.mfe1h - 8.0) < 1e-9);
    // MAE1h = max(100-low) = max(1,1)=1 → 1%
    assert.ok(Math.abs(a.AVAILABLE.mae1h - 1.0) < 1e-9);
});

test('assess: 触发分布按等待根数累计（15m/30m/1h/4h）', function () {
    var candles = [];
    candles.push(mkCandle(0, 100, 110, 100, 109)); // availableAt (idx0)
    // leg 单根 100..110 → BULLISH OTE62 = 110-0.62*10 = 103.8
    // 回撤：idx2 触 103.8（waitBars=2 → 15m 内）
    candles.push(mkCandle(1, 109, 109, 108, 108));
    candles.push(mkCandle(2, 108, 108, 103.5, 105));
    var leg = { ids: ['D1'], startIndex: 0, endIndex: 0, direction: 'BULLISH' };
    var item = { direction: 'BULLISH', canonicalDisplacementId: 'D1', fvgIds: [], availableIndex: 0, nearTarget: null, tier: 'HIGH_QUALITY', hasDisplacement: true };
    var r = tpa.simulateAll([item], [], { 'D1': leg }, candles);
    assert.strictEqual(r[0].perModel.OTE_62.triggered, true);
    assert.strictEqual(r[0].perModel.OTE_62.waitBars, 2);
    var a = tpa.assess(r, candles);
    assert.strictEqual(a.OTE_62.trig15m, 1, 'waitBars=2 <= 3 → 15m 内触发');
    assert.strictEqual(a.OTE_62.trig30m, 1);
    assert.strictEqual(a.OTE_62.trig1h, 1);
    assert.strictEqual(a.OTE_62.trigRate15m, 1);
    assert.strictEqual(a.OTE_62.trigRate4h, 1);
});

console.log('----');
console.log('triggerPriceAudit: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
