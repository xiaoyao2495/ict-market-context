'use strict';

var MODEL = 'ATR50_36H_UNVIOLATED_CROSS_SOURCE_V1';

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
        historicalSource: 'CAUSAL_ATR50_ZIGZAG',
        historicalLookbackBars: 432,
        historicalLookbackTime: '36H',
        currentPivot: clone(metadata.currentPivot),
        partnerCount: metadata.historicalPartners.length,
        historicalPartners: clone(metadata.historicalPartners)
    };
}

module.exports = {
    MODEL: MODEL,
    fromLiquidity: fromLiquidity
};
