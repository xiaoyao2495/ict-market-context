/**
 * Swing Liquidity 构建器
 *
 * Pivot High  → BSL (Buy-Side Liquidity)  / type = 'SWING_HIGH'
 * Pivot Low   → SSL (Sell-Side Liquidity) / type = 'SWING_LOW'
 *
 * Phase 12.1（2026-08-20）正名 —— 语义边界：
 * 输入 pivot 的语义 = LOCAL_PIVOT（2-left+2-right 局部转折确认，见 pivotDetector 注释）。
 * 本模块把 LOCAL_PIVOT 包装成 'SWING_HIGH'/'SWING_LOW' 仅是**历史兼容层**：
 * 它不代表该 pivot 已具备 STRUCTURAL_SWING 或 LIQUIDITY_OBJECT 资格
 * （Phase 12.2/12.4 将引入 qualification，届时普通 LOCAL_PIVOT 不应自动注册 liquidity）。
 * Phase 12.1 仅注释正名，包装逻辑与数据结构零改动。
 *
 * 统一 Liquidity Object（15 字段）：
 *   id / symbol / timeframe / type / side / price /
 *   sourceOpenTime / sourceCloseTime / createdAt / confirmedAt /
 *   status / touchedAt / sweptAt / brokenAt / metadata
 *
 * 【confirmedAt 强约束（Phase 3 起）】
 * - Pivot 必须等右侧 right 根 K 线确认
 * - confirmedAt = 【右侧确认 K 线】的 closeTime，绝不退化为 pivot.time
 * - 无法取得右侧确认 candle（candles 未传 / 越界 / 未收盘）时：
 *   → 不生成该 liquidity（宁可缺失，不可用未确认时间冒充）
 *
 * @param {string} symbol
 * @param {string} timeframe
 * @param {Array} pivots [{ type, index, price, time }]
 * @param {Array} candles 原始 K 线数组（必须提供）
 * @param {number} [right] 右侧确认根数，默认 2
 * @returns {Array} 已确认的 Swing liquidity 数组
 */
function buildSwingLiquidity(symbol, timeframe, pivots, candles, right) {
    var confirmRight = right || 2;
    var result = [];

    // 强约束：没有 candles 就无法确定 confirmedAt → 不生成任何 liquidity
    if (!candles || !pivots) {
        return result;
    }

    pivots.forEach(function (pivot) {
        var pivotCandle = candles[pivot.index];
        var confirmCandle = candles[pivot.index + confirmRight];

        // 右侧确认 candle 不存在或未收盘 → 该 pivot 尚未被确认 → 跳过
        if (!confirmCandle || confirmCandle.closed === false) {
            return;
        }
        if (!pivotCandle) {
            return;
        }

        var confirmedAt = confirmCandle.closeTime;
        var source = pivotCandle.source || null;
        var metadata = {
            source: source,
            index: pivot.index
        };

        if (pivot.type === 'HIGH') {
            result.push({
                id:
                    symbol +
                    ':' +
                    timeframe +
                    ':SWING_HIGH:' +
                    pivot.time,
                symbol: symbol,
                timeframe: timeframe,
                type: 'SWING_HIGH',
                side: 'BSL',
                price: pivot.price,
                sourceOpenTime: pivotCandle.openTime,
                sourceCloseTime: pivotCandle.closeTime,
                createdAt: confirmedAt,
                confirmedAt: confirmedAt,
                status: 'ACTIVE',
                touchedAt: null,
                sweptAt: null,
                brokenAt: null,
                metadata: metadata
            });
            return;
        }
        result.push({
            id:
                symbol +
                ':' +
                timeframe +
                ':SWING_LOW:' +
                pivot.time,
            symbol: symbol,
            timeframe: timeframe,
            type: 'SWING_LOW',
            side: 'SSL',
            price: pivot.price,
            sourceOpenTime: pivotCandle.openTime,
            sourceCloseTime: pivotCandle.closeTime,
            createdAt: confirmedAt,
            confirmedAt: confirmedAt,
            status: 'ACTIVE',
            touchedAt: null,
            sweptAt: null,
            brokenAt: null,
            metadata: metadata
        });
    });

    return result;
}

module.exports = {
    buildSwingLiquidity: buildSwingLiquidity
};
