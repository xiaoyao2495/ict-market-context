/**
 * FVG Lifecycle（Phase 9.1）
 *
 * 状态（只升不降）：
 *   ACTIVE
 *     ↓
 *   TOUCHED
 *     ↓
 *   MIDPOINT_TOUCHED
 *     ↓
 *   FILLED
 *
 * 另外允许外部显式 INVALIDATED（由 Entry Gate / 场景失效触发）。
 *
 * Bullish（zoneLow 下沿 / zoneHigh 上沿，价格从上往下回踩）：
 *   TOUCHED         candle.low  <= zoneHigh
 *   MIDPOINT_TOUCHED candle.low <= midpoint
 *   FILLED          candle.low  <= zoneLow
 * Bearish 对称：
 *   TOUCHED         candle.high >= zoneLow
 *   MIDPOINT_TOUCHED candle.high >= midpoint
 *   FILLED          candle.high >= zoneHigh
 *
 * 所有时间戳使用触发 candle.closeTime。
 * 注意：FVG 被 fill 不直接解释为 setup invalid —— 由 Entry Gate 决定。
 */
/**
 * 纯函数：根据 candle 计算状态变化
 * @param {Object} fvg FVG 对象
 * @param {Object} candle 已收盘 candle
 * @returns {Object|null} {
 *   status, touchedAt, midpointTouchedAt, filledAt, changed: bool
 * }；未收盘返回 null
 */
function evaluateFvg(fvg, candle) {
    if (!fvg || !candle || candle.closed === false) {
        return null;
    }
    if (fvg.status === 'FILLED' || fvg.status === 'INVALIDATED') {
        return {
            status: fvg.status,
            touchedAt: fvg.touchedAt,
            midpointTouchedAt: fvg.midpointTouchedAt,
            filledAt: fvg.filledAt,
            changed: false
        };
    }

    var bullish = fvg.direction === 'BULLISH';
    var closeTime = candle.closeTime;

    var status = fvg.status || 'ACTIVE';
    var touchedAt = fvg.touchedAt;
    var midpointTouchedAt = fvg.midpointTouchedAt;
    var filledAt = fvg.filledAt;
    var changed = false;

    if (bullish) {
        if (status === 'ACTIVE' && candle.low <= fvg.zoneHigh) {
            status = 'TOUCHED';
            touchedAt = closeTime;
            changed = true;
        }
        if (
            (status === 'TOUCHED' || status === 'ACTIVE') &&
            candle.low <= fvg.midpoint
        ) {
            if (status === 'ACTIVE') {
                status = 'TOUCHED';
                touchedAt = closeTime;
            }
            if (status !== 'MIDPOINT_TOUCHED') {
                status = 'MIDPOINT_TOUCHED';
                midpointTouchedAt = closeTime;
                changed = true;
            }
        }
        if (
            (status === 'TOUCHED' || status === 'MIDPOINT_TOUCHED' || status === 'ACTIVE') &&
            candle.low <= fvg.zoneLow
        ) {
            if (status === 'ACTIVE') {
                status = 'TOUCHED';
                touchedAt = closeTime;
            }
            if (status !== 'MIDPOINT_TOUCHED') {
                status = 'MIDPOINT_TOUCHED';
                midpointTouchedAt = closeTime;
            }
            if (status !== 'FILLED') {
                status = 'FILLED';
                filledAt = closeTime;
                changed = true;
            }
        }
    } else {
        if (status === 'ACTIVE' && candle.high >= fvg.zoneLow) {
            status = 'TOUCHED';
            touchedAt = closeTime;
            changed = true;
        }
        if (
            (status === 'TOUCHED' || status === 'ACTIVE') &&
            candle.high >= fvg.midpoint
        ) {
            if (status === 'ACTIVE') {
                status = 'TOUCHED';
                touchedAt = closeTime;
            }
            if (status !== 'MIDPOINT_TOUCHED') {
                status = 'MIDPOINT_TOUCHED';
                midpointTouchedAt = closeTime;
                changed = true;
            }
        }
        if (
            (status === 'TOUCHED' || status === 'MIDPOINT_TOUCHED' || status === 'ACTIVE') &&
            candle.high >= fvg.zoneHigh
        ) {
            if (status === 'ACTIVE') {
                status = 'TOUCHED';
                touchedAt = closeTime;
            }
            if (status !== 'MIDPOINT_TOUCHED') {
                status = 'MIDPOINT_TOUCHED';
                midpointTouchedAt = closeTime;
            }
            if (status !== 'FILLED') {
                status = 'FILLED';
                filledAt = closeTime;
                changed = true;
            }
        }
    }

    return {
        status: status,
        touchedAt: touchedAt,
        midpointTouchedAt: midpointTouchedAt,
        filledAt: filledAt,
        changed: changed
    };
}

/**
 * 应用状态变化到 FVG 对象（原地更新，返回新的 status）
 */
function applyFvgEvent(fvg, result) {
    if (!result) {
        return fvg && fvg.status;
    }
    fvg.status = result.status;
    fvg.touchedAt = result.touchedAt;
    fvg.midpointTouchedAt = result.midpointTouchedAt;
    fvg.filledAt = result.filledAt;
    return fvg.status;
}

/**
 * 显式 invalidate（外部调用，如 Entry Gate）
 */
function invalidate(fvg, closeTime) {
    fvg.status = 'INVALIDATED';
    fvg.invalidatedAt = closeTime;
    return fvg.status;
}

module.exports = {
    evaluateFvg: evaluateFvg,
    applyFvgEvent: applyFvgEvent,
    invalidate: invalidate
};
