/**
 * 方案 Z Phase-2 扩展：Sweep lifecycle + Break classification 单元测试
 * 覆盖：
 *  - sweep INTACT / TAKEN 判定
 *  - takenByWick（影线刺破 vs 收盘越过）
 *  - closedBeyond 严格性
 *  - 未来泄漏防护（confirmedAt > evaluationTime 的 pivot 不判 TAKEN）
 *  - break classification 保守性（CONTINUATION / MSS / UNCLASSIFIED，默认 UNCLASSIFIED 不造假）
 *  - marketFacts 注入到 prompt
 * 不修改任何生产引擎。
 */
var assert = require('assert');
var auditMarketFacts = require('../ai/auditMarketFacts');
var auditPivots = require('../ai/auditPivots');
var ictBiasPrompt = require('../ai/ictBiasPrompt');
var case2Fixture = require('./fixtures/deepseek4h-case02.json');

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

var IV = 14400000; // 4h

// 构造一段确定性 4H：先 zigzag 出 pivot，再制造一次明确的上破 / 下破。
// pivotPeakIdx / pivotTroughIdx 给出已知峰/谷位置（left=right=2 可见）。
function makeSeries(peakIdx, troughIdx, breachIdx, breachDir, startMs) {
    var arr = [];
    var base = 100000;
    for (var i = 0; i < 30; i++) {
        var ot = startMs + i * IV;
        var lv = base;
        var high = base + 5, low = base - 5;
        if (i === peakIdx) { lv = base + 100; high = base + 130; low = base + 95; }
        else if (i === troughIdx) { lv = base - 100; high = base - 95; low = base - 130; }
        else if (i > peakIdx && i < troughIdx) {
            // 下行段（peak → trough）
            var t = (i - peakIdx) / (troughIdx - peakIdx);
            lv = (base + 100) + t * ((base - 100) - (base + 100));
            high = lv + 5; low = lv - 5;
        } else if (i > troughIdx) {
            var t2 = (i - troughIdx) / 10;
            lv = (base - 100) + t2 * 200;
            high = lv + 5; low = lv - 5;
        }
        arr.push({
            openTime: ot, open: lv, high: high, low: low, close: lv,
            closeTime: ot + IV - 1, closed: true, source: 'futures'
        });
    }
    // 在 breachIdx 制造一次刺破：
    //  breachDir='UP'  → 价格向上越过 peak（扫 BSL）
    //  breachDir='DOWN'→ 价格向下越过 trough（扫 SSL）
    if (breachIdx > 0 && breachIdx < arr.length) {
        var c = arr[breachIdx];
        if (breachDir === 'UP') {
            c.high = base + 200; c.low = base + 150; c.open = base + 160; c.close = base + 180;
        } else {
            c.high = base - 150; c.low = base - 200; c.open = base - 160; c.close = base - 180;
        }
    }
    return arr;
}

/* ---------- Sweep lifecycle ---------- */

test('sweep：被上破的 swing high 标 TAKEN + takenByWick=false（收盘越过）', function () {
    var c = makeSeries(4, 10, 14, 'UP', 1700000000000);
    var pv = auditPivots.detectPivots(c, 20, { left: 2, right: 2, window: 120 });
    var mf = auditMarketFacts.computeMarketFacts(c, 20, pv, { deliveryHintEnabled: false });
    var taken = mf.sweeps.filter(function (s) { return s.status === 'TAKEN'; });
    assert.ok(taken.length >= 1, '应至少有一个 TAKEN');
    var high = taken.filter(function (s) { return s.refSide === 'HIGH'; })[0];
    assert.ok(high, '应存在被上破的 HIGH');
    assert.strictEqual(high.takenByWick, false, '收盘越过应为 takenByWick=false');
    assert.strictEqual(high.closedBeyond, true, '收盘越过 closedBeyond=true');
    assert.ok(high.takenAt, 'takenAt 应存在');
});

test('sweep：仅影线刺破 → takenByWick=true（收盘未越过）', function () {
    // 构造：swing high 之后一根 high 刺破但 close 仍在下方
    var c = makeSeries(4, 10, 14, 'UP', 1700000000000);
    var pv = auditPivots.detectPivots(c, 20, { left: 2, right: 2, window: 120 });
    // 手动把 breach candle 改回"仅影线刺破"
    var breachC = c[14];
    breachC.high = 100200; // 越过 peak high（base+130=100130）
    breachC.low = 100120; breachC.open = 100150; breachC.close = 100110; // 收盘未越过
    var mf = auditMarketFacts.computeMarketFacts(c, 20, pv, { deliveryHintEnabled: false });
    var high = mf.sweeps.filter(function (s) { return s.refSide === 'HIGH' && s.status === 'TAKEN'; })[0];
    assert.ok(high, '应 TAKEN');
    assert.strictEqual(high.takenByWick, true, '仅影线刺破 takenByWick=true');
    assert.strictEqual(high.closedBeyond, false, '收盘未越过 closedBeyond=false');
});

test('sweep：未被触及的 pivot 标 INTACT', function () {
    var c = makeSeries(4, 10, 14, 'UP', 1700000000000);
    var pv = auditPivots.detectPivots(c, 20, { left: 2, right: 2, window: 120 });
    var mf = auditMarketFacts.computeMarketFacts(c, 20, pv, { deliveryHintEnabled: false });
    var intact = mf.sweeps.filter(function (s) { return s.status === 'INTACT'; });
    assert.ok(intact.length >= 1, '应存在 INTACT（如未被扫的 LOW 或其他）');
    intact.forEach(function (s) {
        assert.strictEqual(s.takenAt, null);
        assert.strictEqual(s.takenByWick, null);
        assert.strictEqual(s.closedBeyond, null);
    });
});

test('sweep：未来泄漏防护（confirmedAt > evaluationTime 的 pivot 不判 TAKEN）', function () {
    // evalIdx 放在 pivot 确认之前
    var c = makeSeries(4, 10, 14, 'UP', 1700000000000);
    // 取一个 pivot 的确认点刚好在 evaluationTime 之后：用很小的 evalIdx
    // peak@4 的 confirmedAt = c[6].closeTime；若 evalIdx=5，则 confirmedAt(6) > evalTime(5) → 跳过
    var pv = auditPivots.detectPivots(c, 5, { left: 2, right: 2, window: 120 });
    var mf = auditMarketFacts.computeMarketFacts(c, 5, pv, { deliveryHintEnabled: false });
    mf.sweeps.forEach(function (s) {
        assert.strictEqual(s.status, 'INTACT', '未来确认的 pivot 必须 INTACT（防泄漏）');
    });
});

/* ---------- Break classification 保守性 ---------- */

test('break：关闭 delivery hint → 全部 UNCLASSIFIED（不造假 MSS）', function () {
    var c = makeSeries(4, 10, 14, 'UP', 1700000000000);
    var pv = auditPivots.detectPivots(c, 20, { left: 2, right: 2, window: 120 });
    var mf = auditMarketFacts.computeMarketFacts(c, 20, pv, { deliveryHintEnabled: false });
    assert.ok(mf.breaks.length >= 1, '应存在 break（被刺破的 pivot）');
    mf.breaks.forEach(function (b) {
        assert.strictEqual(b.classification, 'UNCLASSIFIED', 'UNCLEAR 下不应标 MSS');
        assert.strictEqual(b.relationToDelivery, 'UNKNOWN', 'UNCLEAR 下 relation=UNKNOWN');
        assert.strictEqual(b.mssCandidate, false, 'UNKNOWN 下不得是 mssCandidate');
        assert.ok(b.referenceSwing && b.referenceSwing.price, '应回指 referenceSwing');
        assert.ok(b.breakAt, '应有 breakAt');
    });
});

test('break：direction 修正（HIGH 被破=BULLISH，LOW 被破=BEARISH）', function () {
    // makeSeries(...,'UP') 制造上破 HIGH → direction 应为 BULLISH（非 BEARISH）
    var c = makeSeries(4, 10, 14, 'UP', 1700000000000);
    var pv = auditPivots.detectPivots(c, 20, { left: 2, right: 2, window: 120 });
    var mf = auditMarketFacts.computeMarketFacts(c, 20, pv, { deliveryHintEnabled: false });
    var highBreak = mf.breaks.filter(function (x) { return x.referenceSwing.refSide === 'HIGH'; })[0];
    assert.ok(highBreak, '应存在 HIGH 被破 break');
    assert.strictEqual(highBreak.direction, 'BULLISH', 'HIGH 被上破 direction 必须为 BULLISH（反转 bug 已修）');
    // 下破 LOW 测试（DOWN）
    var c2 = makeSeries(4, 10, 14, 'DOWN', 1700000000000);
    var pv2 = auditPivots.detectPivots(c2, 20, { left: 2, right: 2, window: 120 });
    var mf2 = auditMarketFacts.computeMarketFacts(c2, 20, pv2, { deliveryHintEnabled: false });
    var lowBreak = mf2.breaks.filter(function (x) { return x.referenceSwing.refSide === 'LOW'; })[0];
    assert.ok(lowBreak, '应存在 LOW 被破 break');
    assert.strictEqual(lowBreak.direction, 'BEARISH', 'LOW 被下破 direction 必须为 BEARISH');
});

test('break：time-local delivery 与刺破方向相同 → CONTINUATION（非 MSS）', function () {
    var c = case2Fixture.candles;
    var evalIdx = c.length - 1;
    var pv = auditPivots.detectPivots(c, evalIdx, { left: 2, right: 2, window: 120 });
    var mf = auditMarketFacts.computeMarketFacts(c, evalIdx, pv, { deliveryHintEnabled: true });
    var b = mf.breaks.filter(function (x) { return x.level === 71259; })[0];
    assert.ok(b, '应存在 71259 BEARISH break');
    assert.strictEqual(b.deliveryAtBreak, 'BEARISH');
    assert.strictEqual(b.relationToDelivery, 'SAME', '顺向 relation=SAME');
    assert.strictEqual(b.classification, 'CONTINUATION', '顺向应为 CONTINUATION，不得标 MSS');
    assert.strictEqual(b.mssCandidate, false, 'CONTINUATION 不得是 mssCandidate');
});

test('break：time-local delivery 与刺破方向相反 → UNCLASSIFIED + mssCandidate', function () {
    var c = case2Fixture.candles;
    var evalIdx = c.length - 1;
    var pv = auditPivots.detectPivots(c, evalIdx, { left: 2, right: 2, window: 120 });
    var mf = auditMarketFacts.computeMarketFacts(c, evalIdx, pv, { deliveryHintEnabled: true });
    var b = mf.breaks.filter(function (x) { return x.level === 72451.9; })[0];
    assert.ok(b, '应存在 72451.9 BEARISH break');
    assert.strictEqual(b.deliveryAtBreak, 'BULLISH');
    assert.strictEqual(b.relationToDelivery, 'OPPOSITE', '逆向 relation=OPPOSITE');
    assert.strictEqual(b.classification, 'UNCLASSIFIED', '逆向不得直接标 MSS，应为 UNCLASSIFIED');
    assert.strictEqual(b.mssCandidate, true, '逆向应为 mssCandidate=true（待 structural 条件升级）');
});

test('Case 2 regression：历史 break 使用 time-local delivery，禁止最终 hint 倒灌', function () {
    var c = case2Fixture.candles;
    var evalIdx = c.length - 1;
    var pv = auditPivots.detectPivots(c, evalIdx, { left: 2, right: 2, window: 120 });
    var mf = auditMarketFacts.computeMarketFacts(c, evalIdx, pv, { deliveryHintEnabled: true });

    function byLevel(level) {
        var b = mf.breaks.filter(function (x) { return x.level === level; })[0];
        assert.ok(b, '缺少 Case 2 break ' + level);
        return b;
    }
    function assertBreak(level, delivery, relation, classification, mssCandidate) {
        var b = byLevel(level);
        assert.strictEqual(b.direction, 'BEARISH');
        assert.strictEqual(b.deliveryAtBreak, delivery);
        assert.strictEqual(b.relationToDelivery, relation);
        assert.strictEqual(b.classification, classification);
        assert.strictEqual(b.mssCandidate, mssCandidate);
        assert.ok(Object.prototype.hasOwnProperty.call(b, 'deliverySourceConfirmedAt'));

        var breakCandle = c.filter(function (x) {
            return new Date(x.openTime).toISOString() === b.breakAt;
        })[0];
        assert.ok(breakCandle, '必须能定位 break candle');
        if (b.deliverySourceConfirmedAt != null) {
            assert.ok(Date.parse(b.deliverySourceConfirmedAt) <= breakCandle.closeTime,
                'FUTURE_LEAK: delivery source 晚于 breakEvaluationTime');
        }
    }

    assertBreak(72451.9, 'BULLISH', 'OPPOSITE', 'UNCLASSIFIED', true);
    assertBreak(71382.1, 'BULLISH', 'OPPOSITE', 'UNCLASSIFIED', true);
    assertBreak(71259, 'BEARISH', 'SAME', 'CONTINUATION', false);
});

test('break：referenceSwing 回指正确 pivot（price + occurredAt）', function () {
    var c = makeSeries(4, 10, 14, 'UP', 1700000000000);
    var pv = auditPivots.detectPivots(c, 20, { left: 2, right: 2, window: 120 });
    var mf = auditMarketFacts.computeMarketFacts(c, 20, pv, { deliveryHintEnabled: false });
    mf.breaks.forEach(function (b) {
        var ref = b.referenceSwing;
        assert.ok(ref.refSide === 'HIGH' || ref.refSide === 'LOW');
        var match = (ref.refSide === 'HIGH' ? pv.highs : pv.lows)
            .filter(function (p) { return p.price === ref.price && p.occurredAt === ref.occurredAt; });
        assert.strictEqual(match.length, 1, 'referenceSwing 必须能回指原 pivot');
    });
});

/* ---------- inferDeliveryFromPivots（可选 hint） ---------- */

test('inferDeliveryFromPivots：higher-high 序列 → BULLISH', function () {
    var c = [];
    var lv = [1000, 990, 1010, 1005, 1020]; // H@0(1000)? 这里用简化：每 4 根一峰
    // 直接用 makeSeries 的下行+上行：peak=4(10100), trough=10(9900)，之后上行创新高？
    // 简化：构造 peaks 升序
    var arr = [];
    for (var i = 0; i < 40; i++) {
        var ot = 1700000000000 + i * IV;
        var p = 100000 + (i % 8 === 0 ? 200 : (i % 8 === 4 ? -200 : 0)) + i; // 峰在 i%8===0 渐高
        arr.push({ openTime: ot, open: p, high: p + (i % 8 === 0 ? 30 : 5),
            low: p - (i % 8 === 4 ? 30 : 5), close: p, closeTime: ot + IV - 1, closed: true, source: 'futures' });
    }
    var pv = auditPivots.detectPivots(arr, 35, { left: 2, right: 2, window: 120 });
    var dir = auditMarketFacts.inferDeliveryFromPivots(arr, 35, pv);
    // 峰渐高（i=0→100000+200=100200; i=8→100008+200=100208 更高）→ BULLISH
    assert.strictEqual(dir, 'BULLISH');
});

test('inferDeliveryFromPivots：无明确突破 → UNCLEAR', function () {
    var arr = [];
    for (var i = 0; i < 40; i++) {
        var ot = 1700000000000 + i * IV;
        var p = 100000 + (i % 8 === 0 ? 50 : (i % 8 === 4 ? -50 : 0)); // 等高低，无更高/更低
        arr.push({ openTime: ot, open: p, high: p + (i % 8 === 0 ? 30 : 5),
            low: p - (i % 8 === 4 ? 30 : 5), close: p, closeTime: ot + IV - 1, closed: true, source: 'futures' });
    }
    var pv = auditPivots.detectPivots(arr, 35, { left: 2, right: 2, window: 120 });
    var dir = auditMarketFacts.inferDeliveryFromPivots(arr, 35, pv);
    assert.strictEqual(dir, 'UNCLEAR');
});

/* ---------- Prompt 注入 ---------- */

test('marketFacts 注入 prompt（sweeps + breaks 可见，且含 MARKET FACTS DISCIPLINE）', function () {
    var c = makeSeries(4, 10, 14, 'UP', 1700000000000);
    var evalIdx = 20;
    var evalTime = c[evalIdx].closeTime;
    var slice = c.slice(evalIdx - 119, evalIdx + 1);
    var pv = auditPivots.detectPivots(c, evalIdx, { left: 2, right: 2, window: 120 });
    var mf = auditMarketFacts.computeMarketFacts(c, evalIdx, pv, { deliveryHintEnabled: false });
    var p = ictBiasPrompt.buildUserPrompt({
        symbol: 'BTCUSDT', evaluationTime: evalTime, candles: slice,
        confirmedSwings: { highs: pv.highs, lows: pv.lows },
        marketFacts: { sweeps: mf.sweeps, breaks: mf.breaks }
    });
    assert.ok(p.indexOf('marketFacts') >= 0, '应含 marketFacts 段');
    assert.ok(p.indexOf('"status": "TAKEN"') >= 0 || p.indexOf('"status":"TAKEN"') >= 0,
        '应含 TAKEN 状态');
    assert.ok(p.indexOf('classification') >= 0, '应含 break classification');
    assert.ok(p.indexOf('relationToDelivery') >= 0, '应含 relationToDelivery 字段');
    assert.ok(p.indexOf('mssCandidate') >= 0, '应含 mssCandidate 字段');
    assert.ok(ictBiasPrompt.SYSTEM_PROMPT.indexOf('MARKET FACTS DISCIPLINE') >= 0,
        'system prompt 应含 MARKET FACTS DISCIPLINE');
    assert.ok(ictBiasPrompt.SYSTEM_PROMPT.indexOf('mssCandidate') >= 0,
        'system prompt 应解释 mssCandidate 语义');
});

test('marketFacts 仅含 TAKEN 时带 takenAt / 不含 null 字段混乱', function () {
    var c = makeSeries(4, 10, 14, 'UP', 1700000000000);
    var pv = auditPivots.detectPivots(c, 20, { left: 2, right: 2, window: 120 });
    var mf = auditMarketFacts.computeMarketFacts(c, 20, pv, { deliveryHintEnabled: false });
    var p = ictBiasPrompt.buildUserPrompt({
        symbol: 'BTCUSDT', evaluationTime: c[20].closeTime, candles: c.slice(20 - 119, 21),
        marketFacts: { sweeps: mf.sweeps, breaks: mf.breaks }
    });
    // 注入的 JSON 应包含 takenAt 字段（TAKEN 项）
    assert.ok(p.indexOf('takenAt') >= 0, 'TAKEN 项应含 takenAt');
});

console.log('----');
console.log('marketFactsAudit: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) { process.exit(1); }
