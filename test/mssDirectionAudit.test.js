/**
 * Phase 11L.9 — Production MSS Direction Integrity Audit 测试
 *
 * 覆盖：
 *   - MATCH：mss.direction === leg.direction
 *   - OPPOSITE：mss.direction !== leg.direction（生产挂载疑点）
 *   - MISSING：mssId 存在但 MSS 事件找不到
 *   - NO_MSS：leg.mssId 缺失（HIGH 不应出现，观察）
 *   - 明细排序 + 字段完整性
 */
var assert = require('assert');
var mda = require('../stats/mssDirectionAudit');

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

function mkAlert(id, direction, dispId, anchorIndex) {
    return { id: id, direction: direction, dispId: dispId, anchorIndex: anchorIndex, anchorTime: 1000000 + anchorIndex * 300000 };
}
function mkLeg(mssId, start, end) {
    return { mssId: mssId, startIndex: start, endIndex: end, lastIndex: end };
}
function mkMss(id, direction, candleIndex) {
    return { id: id, direction: direction, candleIndex: candleIndex, confirmedAt: 1200000 };
}

test('11L.9：MATCH（mss.direction === leg.direction）', function () {
    var alerts = [mkAlert('a1', 'BULLISH', 'd1', 10)];
    var legByDispId = { d1: mkLeg('m1', 8, 12) };
    var mssById = { m1: mkMss('m1', 'BULLISH', 10) };
    var out = mda.auditMssDirection(alerts, legByDispId, mssById);
    assert.strictEqual(out.total, 1);
    assert.strictEqual(out.MATCH, 1);
    assert.strictEqual(out.OPPOSITE, 0);
    assert.strictEqual(out.MISSING, 0);
});

test('11L.9：OPPOSITE（mss.direction !== leg.direction —— 生产挂载疑点）', function () {
    var alerts = [mkAlert('a1', 'BULLISH', 'd1', 10)];
    var legByDispId = { d1: mkLeg('m1', 8, 12) };
    var mssById = { m1: mkMss('m1', 'BEARISH', 10) };
    var out = mda.auditMssDirection(alerts, legByDispId, mssById);
    assert.strictEqual(out.OPPOSITE, 1);
    assert.strictEqual(out.details.length, 1);
    assert.strictEqual(out.details[0].status, 'OPPOSITE');
    assert.strictEqual(out.details[0].legDirection, 'BULLISH');
    assert.strictEqual(out.details[0].mssDirection, 'BEARISH');
    assert.strictEqual(out.details[0].mssCandleIndex, 10, '明细含 mss candleIndex 供人工核对');
    assert.strictEqual(out.details[0].legStartIndex, 8);
    assert.strictEqual(out.details[0].legEndIndex, 12);
});

test('11L.9：MISSING（mssId 存在但事件找不到）', function () {
    var alerts = [mkAlert('a1', 'BULLISH', 'd1', 10)];
    var legByDispId = { d1: mkLeg('m1', 8, 12) };
    var out = mda.auditMssDirection(alerts, legByDispId, {});
    assert.strictEqual(out.MISSING, 1);
    assert.strictEqual(out.details[0].status, 'MISSING');
});

test('11L.9：NO_MSS（leg.mssId 缺失，观察）', function () {
    var alerts = [mkAlert('a1', 'BULLISH', 'd1', 10)];
    var legByDispId = { d1: mkLeg(null, 8, 12) };
    var out = mda.auditMssDirection(alerts, legByDispId, {});
    assert.strictEqual(out.NO_MSS, 1);
    assert.strictEqual(out.MATCH, 0);
});

test('11L.9：混合样本 + 明细按 anchorIndex 排序', function () {
    var alerts = [
        mkAlert('a2', 'BEARISH', 'd2', 30), // OPPOSITE
        mkAlert('a1', 'BULLISH', 'd1', 10), // MATCH
        mkAlert('a3', 'BULLISH', 'd3', 50)  // MISSING
    ];
    var legByDispId = {
        d1: mkLeg('m1', 8, 12),
        d2: mkLeg('m2', 28, 32),
        d3: mkLeg('m3', 48, 52)
    };
    var mssById = {
        m1: mkMss('m1', 'BULLISH', 10),
        m2: mkMss('m2', 'BULLISH', 30) // BEARISH leg ← BULLISH MSS → OPPOSITE
    };
    var out = mda.auditMssDirection(alerts, legByDispId, mssById);
    assert.strictEqual(out.total, 3);
    assert.strictEqual(out.MATCH, 1);
    assert.strictEqual(out.OPPOSITE, 1);
    assert.strictEqual(out.MISSING, 1);
    assert.strictEqual(out.details.length, 2);
    assert.strictEqual(out.details[0].anchorIndex, 30, '明细按 anchorIndex 升序');
    assert.strictEqual(out.details[1].anchorIndex, 50);
});

test('11L.9：空输入安全', function () {
    var out = mda.auditMssDirection([], {}, {});
    assert.strictEqual(out.total, 0);
    assert.strictEqual(out.MATCH + out.OPPOSITE + out.MISSING + out.NO_MSS, 0);
});

// ---------- 结果 ----------
console.log('mssDirectionAudit tests: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) {
    process.exit(1);
}
