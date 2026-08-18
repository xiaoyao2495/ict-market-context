/**
 * Phase 11L.5 — Near Draw staleness（通知时点 target 有效性验证）
 *
 * 背景（P0-2）：15min 时间窗 leg 在 availableAt 才确认结束并通知，但 near target 是
 * anchor 时刻（最后位移 K）冻结的。anchor → available 之间的 K 可能已经 TOUCHED/SWEPT/
 * BROKEN 该流动性 —— 这时再按旧 target 通知就是 stale alert，且历史统计会把
 * "通知前已被价格拿走的 target"算进 post-alert hit（target staleness）。
 *
 * 方案 B（保守，第一版）：near target 已被消费 → 不发送旧 HIGH（STALE_NEAR_SUPPRESSED），
 * 历史统计同样剔除这些"Live 不会通知"的样本。
 *
 * 消费判定（mode）：
 *   'touch'（默认）：任意 K high >= nearTarget（BULLISH）/ low <= nearTarget（BEARISH）
 *   'close-cross'：任意 K close 穿越 target（BULLISH close >= nearTarget / BEARISH close <= nearTarget）
 *     —— 更贴近 ICT liquidity sweep 语义（收盘价真正穿过流动性，而非 wick 触及）
 */
function checkNearConsumed(nearTarget, direction, candles, fromIndex, toIndex, mode) {
    if (nearTarget === null || nearTarget === undefined) {
        return { consumed: false, firstTouchIndex: null };
    }
    var bullish = direction === 'BULLISH';
    var cross = mode === 'close-cross';
    var list = candles || [];
    for (var j = fromIndex; j <= toIndex; j++) {
        var c = list[j];
        if (!c) break;
        if (cross) {
            if (bullish && c.close >= nearTarget) {
                return { consumed: true, firstTouchIndex: j };
            }
            if (!bullish && c.close <= nearTarget) {
                return { consumed: true, firstTouchIndex: j };
            }
        } else {
            if (bullish && c.high >= nearTarget) {
                return { consumed: true, firstTouchIndex: j };
            }
            if (!bullish && c.low <= nearTarget) {
                return { consumed: true, firstTouchIndex: j };
            }
        }
    }
    return { consumed: false, firstTouchIndex: null };
}

module.exports = {
    checkNearConsumed: checkNearConsumed
};
