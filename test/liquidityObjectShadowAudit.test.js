/**
 * Phase 11L.11 — Liquidity Object Reclassification Shadow 测试
 *
 * 覆盖：
 *   - associateSweeps excludeStructuralPrimitives：排除 SWING_HIGH/LOW、保留 EQL 等
 *   - auditObjectShadow：SIGNIFICANT / SWING_ONLY / NONE 分组 + 覆盖率 + 统计
 */
var assert = require('assert');
var lp = require('../stats/liquidityProvenance');
var los = require('../stats/liquidityObjectShadowAudit');

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

function mkSweep(id, side, type, candleIndex, confirmedAt) {
    return {
        id: id, side: side, candleIndex: candleIndex, confirmedAt: confirmedAt,
        price: 99, liquidityType: type, timeframe: '5m',
        source: { liquidityType: type, liquidityPrice: 99, side: side }
    };
}
function mkLeg() {
    return { startIndex: 10, endIndex: 12, lastIndex: 12, direction: 'BULLISH', firstConfirmedAt: 1300001, lastConfirmedAt: 1500001 };
}
var BAR = 300000;
function m5(open, high, low, close, i) {
    var t = 1000000 + i * BAR;
    return { openTime: t, open: open, high: high, low: low, close: close, closeTime: t + BAR - 1, closed: true, source: 'futures' };
}

/* ---------- structural primitive exclusion ---------- */

test('11L.11：excludeStructuralPrimitives 排除 SWING、保留 EQL', function () {
    var sweeps = [
        mkSweep('s1', 'SSL', 'SWING_LOW', 6, 1200001),
        mkSweep('s2', 'SSL', 'EQL', 8, 1250001)
    ];
    // 生产（默认）：两者都进 → immediate = 距 start 10 最近 = EQL(2) vs SWING(4) → EQL
    var prod = lp.associateSweeps({ direction: 'BULLISH', leg: mkLeg(), availableAt: 2000000, sweepEvents: sweeps });
    assert.strictEqual(prod.immediateSweep.id, 's2', '生产：EQL 距 2 < SWING 距 4');
    assert.strictEqual(prod.allCandidates.length, 2);
    var shadow = lp.associateSweeps({ direction: 'BULLISH', leg: mkLeg(), availableAt: 2000000, sweepEvents: sweeps, excludeStructuralPrimitives: true });
    assert.ok(shadow, '排除 SWING 后仍有 EQL');
    assert.strictEqual(shadow.allCandidates.length, 1, 'SWING 被排除');
    assert.strictEqual(shadow.immediateSweep.id, 's2');
    // shadow 且只剩 SWING → null（NONE）
    var onlySwing = [mkSweep('s1', 'SSL', 'SWING_LOW', 6, 1200001)];
    var shadow2 = lp.associateSweeps({ direction: 'BULLISH', leg: mkLeg(), availableAt: 2000000, sweepEvents: onlySwing, excludeStructuralPrimitives: true });
    assert.strictEqual(shadow2, null, '仅 SWING 候选 → shadow 下 NONE');
});

/* ---------- auditObjectShadow 分组 + 覆盖率 ---------- */

test('11L.11：分组 SIGNIFICANT / SWING_ONLY / NONE + 覆盖率', function () {
    var candles = [];
    for (var i = 0; i < 40; i++) candles.push(m5(100, 101, 99, 100.5, i));
    candles[21] = m5(100.5, 105.5, 100.4, 105.2, 21); // 通知后触达 near
    var sweepEvents = [
        mkSweep('sw1', 'SSL', 'SWING_LOW', 5, candles[5].closeTime),
        mkSweep('sw2', 'SSL', 'EQL', 6, candles[6].closeTime)
    ];
    function mkAlert(id, legStart, anchorIndex, prodCtx) {
        return {
            id: id, tier: 'HIGH_QUALITY', direction: 'BULLISH', legStartIndex: legStart, anchorIndex: anchorIndex,
            availableIndex: 20, availableAt: candles[20].closeTime,
            notificationPrice: 100.5, notificationNearTarget: 105, nearTarget: 105,
            anchorTime: candles[anchorIndex].closeTime,
            liquidityContext: prodCtx
        };
    }
    var alerts = [
        // A：窗口 [10-48, 12] 内含 EQL(idx6)+SWING(idx5) → shadow 排除 SWING 后关联 EQL → SIGNIFICANT
        mkAlert('a', 10, 12, { immediateSweep: { candleIndex: 6, sourcePrice: 99, sourceType: 'EQL', barsBeforeLegStart: 4 } }),
        // B：窗口 [3-48, 5] 内只有 SWING(idx5)，EQL(idx6) 在 anchor 之后 → shadow 排除 SWING 后无 → SWING_ONLY
        mkAlert('b', 3, 5, { immediateSweep: { candleIndex: 5, sourcePrice: 99, sourceType: 'SWING_LOW', barsBeforeLegStart: -2 } }),
        // C：窗口 [0-48, 0] 无任何候选（sweeps 在 idx 5/6 之后）→ NONE
        mkAlert('c', 0, 0, null)
    ];
    var res = los.auditObjectShadow(alerts, sweepEvents, candles, {});
    assert.strictEqual(res.total, 3);
    assert.strictEqual(res.prodCoverage, 2 / 3, '生产：a、b 有 immediateSweep，c 无');
    assert.strictEqual(res.shadowCoverage, 1 / 3, 'shadow：仅 a 有（EQL），b/c 无');
    assert.strictEqual(res.groups.SIGNIFICANT.n, 1, 'a：shadow 关联 EQL');
    assert.strictEqual(res.groups.SWING_ONLY.n, 1, 'b：生产有 SWING、shadow 排除后无');
    assert.strictEqual(res.groups.NONE.n, 1, 'c：都无');
    assert.ok(res.significantSamples.length === 1 && res.significantSamples[0].sourceType === 'EQL', 'SIGNIFICANT 示例输出');
});

test('11L.11：SWING_ONLY 分组（窗口内只有 SWING 时）', function () {
    var candles = [];
    for (var i = 0; i < 40; i++) candles.push(m5(100, 101, 99, 100.5, i));
    candles[21] = m5(100.5, 105.5, 100.4, 105.2, 21);
    // 窗口内只有 SWING_LOW（idx 5），无 EQL
    var sweepEvents = [mkSweep('sw1', 'SSL', 'SWING_LOW', 5, candles[5].closeTime)];
    var alert = {
        id: 'a', tier: 'HIGH_QUALITY', direction: 'BULLISH', legStartIndex: 10, anchorIndex: 12,
        availableIndex: 20, availableAt: candles[20].closeTime,
        notificationPrice: 100.5, notificationNearTarget: 105, nearTarget: 105,
        anchorTime: candles[12].closeTime,
        liquidityContext: { immediateSweep: { candleIndex: 5, sourcePrice: 99, sourceType: 'SWING_LOW', barsBeforeLegStart: 5 } }
    };
    var res = los.auditObjectShadow([alert], sweepEvents, candles, {});
    assert.strictEqual(res.prodCoverage, 1, '生产有 immediateSweep');
    assert.strictEqual(res.shadowCoverage, 0, 'shadow 排除 SWING 后无候选');
    assert.strictEqual(res.groups.SWING_ONLY.n, 1, '生产有、shadow 无 → SWING_ONLY');
    assert.strictEqual(res.groups.SIGNIFICANT, undefined);
});

/* ---------- 生产默认不变（回归保护） ---------- */

test('11L.11：generic association 未请求 consumer gate 时仍保留 raw Swing', function () {
    var sweeps = [mkSweep('s1', 'SSL', 'SWING_LOW', 6, 1200001)];
    var prod = lp.associateSweeps({ direction: 'BULLISH', leg: mkLeg(), availableAt: 2000000, sweepEvents: sweeps });
    assert.ok(prod, 'generic association preserves raw Swing unless consumer gate is requested');
    assert.strictEqual(prod.immediateSweep.id, 's1');
});

// ---------- 结果 ----------
console.log('liquidityObjectShadowAudit tests: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) {
    process.exit(1);
}
