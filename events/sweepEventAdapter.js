/**
 * Sweep Event Adapter —— 把 lifecycle 的 SWEPT 结果转为统一 Market Event
 *
 * type = LIQUIDITY_SWEEP
 *   BSL sweep → side = BSL, direction = BEARISH（上方流动性被取走 → 向下重新定价候选）
 *   SSL sweep → side = SSL, direction = BULLISH
 *
 * 保留：
 *   liquidityId / liquidityType / liquidityPrice / side
 *   candle 数据（source.candle）
 *   confirmedAt = 触发 candle.closeTime（绝不用 openTime）
 *
 * id 确定性：symbol:timeframe:SWEEP:liquidityId（一条 liquidity 只 sweep 一次 → 天然唯一）
 */
var narrativeEligibilityConfig = require('../config/sweepNarrativeEligibilityV1');
var narrativeEligibility = require('./sweepNarrativeEligibilityV1');
var productionEqProvenance = require('../liquidity/productionEqProvenance');

function eqPartnerProvenance(liquidity) {
    return productionEqProvenance.fromLiquidity(liquidity);
}

/**
 * @param {Object} liquidity 已标记 SWEPT 的 liquidity（status === 'SWEPT', sweptAt = candle.closeTime）
 * @param {Object} candle 触发 K 线（已收盘）
 * @param {number} candleIndex 触发 K 线索引
 * @param {string} [timeframe] 事件周期（默认 liquidity.timeframe）
 * @returns {Object|null} Market Event
 */
function buildSweepEvent(liquidity, candle, candleIndex, timeframe) {
    if (!liquidity || !candle || candle.closed === false) {
        return null;
    }
    var tf = timeframe || liquidity.timeframe || '5m';
    var direction = liquidity.side === 'BSL' ? 'BEARISH' : 'BULLISH';
    var eqProvenance = eqPartnerProvenance(liquidity);
    var eventPrice = liquidity.price;
    var event = {
        id: liquidity.symbol + ':' + tf + ':SWEEP:' + liquidity.id,
        symbol: liquidity.symbol,
        timeframe: tf,
        type: 'LIQUIDITY_SWEEP',
        direction: direction,
        side: liquidity.side,
        liquidityId: liquidity.id,
        occurredAt: candle.openTime,
        confirmedAt: candle.closeTime,
        candleIndex: candleIndex,
        price: eventPrice,
        source: {
            liquidityId: liquidity.id,
            liquidityType: liquidity.type,
            liquidityPrice: eventPrice,
            side: liquidity.side,
            candle: {
                open: candle.open,
                high: candle.high,
                low: candle.low,
                close: candle.close
            }
        },
        metadata: {}
    };
    if (eqProvenance) event.source.eqPartnerProvenance = eqProvenance;
    if (narrativeEligibilityConfig.isEnabled()) {
        event.narrativeEligibilityV1 = narrativeEligibility.classifySweep(event);
    }
    return event;
}

module.exports = {
    buildSweepEvent: buildSweepEvent,
    eqPartnerProvenance: eqPartnerProvenance
};
