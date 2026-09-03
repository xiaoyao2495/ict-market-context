'use strict';

var producer = require('../liquidity/productionEqualLiquidityV1');
var dynamicD = require('../liquidity/causalDynamicDHistoricalExtremes');

var MODEL = producer.VERSION; // 'DYNAMIC_D_36H_CROSS_SOURCE_V1'
var HISTORICAL_SOURCE = dynamicD.VERSION; // 'CAUSAL_DYNAMIC_D_V1'

function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function fromLiquidity(liquidity) {
    if (!liquidity || (liquidity.type !== 'EQH' && liquidity.type !== 'EQL')) return null;
    var metadata = liquidity.metadata || {};
    if (metadata.eqModelVersion !== MODEL || !Array.isArray(metadata.historicalPartners)) return null;
    return {
        eqType: liquidity.type,
        side: liquidity.side,
        eqModelVersion: MODEL,
        pointInTimeObservation: true,
        asOf: liquidity.confirmedAt,
        currentSource: 'ORDINARY_CAUSAL_2X2',
        historicalSource: HISTORICAL_SOURCE,
        historicalLookbackBars: dynamicD.LOOKBACK_BARS,
        historicalLookbackTime: '36H',
        currentPivot: clone(metadata.currentPivot),
        partnerCount: metadata.historicalPartners.length,
        historicalPartners: clone(metadata.historicalPartners)
    };
}

module.exports = {
    MODEL: MODEL,
    HISTORICAL_SOURCE: HISTORICAL_SOURCE,
    fromLiquidity: fromLiquidity
};
