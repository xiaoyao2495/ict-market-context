/**
 * Objective Narrative Liquidity Taken event.
 *
 * This adapter is deliberately independent of Sweep. It snapshots the first
 * strict trade-through of a causally available Narrative Liquidity identity.
 */
'use strict';

var productionEqProvenance = require('../liquidity/productionEqProvenance');

var NARRATIVE_TYPES = {
    EQH: true,
    EQL: true,
    PDH: true,
    PDL: true,
    PWH: true,
    PWL: true,
    PMH: true,
    PML: true
};

function isNarrativeLiquidityV1(liquidity) {
    return !!(liquidity && NARRATIVE_TYPES[liquidity.type]);
}

function isEligiblePreBarState(liquidity) {
    return !!(liquidity && (liquidity.status === 'ACTIVE' || liquidity.status === 'TOUCHED'));
}

function isCausallyAvailableBeforeBar(liquidity, candle) {
    return !!(liquidity && candle && typeof liquidity.confirmedAt === 'number' &&
        typeof candle.openTime === 'number' && liquidity.confirmedAt <= candle.openTime);
}

function interactionExtreme(liquidity, candle) {
    if (!liquidity || !candle) return null;
    return liquidity.side === 'BSL' ? candle.high : liquidity.side === 'SSL' ? candle.low : null;
}

function isStrictTradeThrough(liquidity, candle, referencePrice) {
    if (!liquidity || !candle || candle.closed !== true) return false;
    var price = referencePrice === undefined ? liquidity.price : referencePrice;
    if (liquidity.side === 'BSL') return candle.high > price;
    if (liquidity.side === 'SSL') return candle.low < price;
    return false;
}

function liquiditySnapshot(liquidity, evaluationTime) {
    var snapshot = { price: liquidity.price, eqPartnerProvenance: null };
    if (liquidity.type !== 'EQH' && liquidity.type !== 'EQL') return snapshot;
    snapshot.eqPartnerProvenance = productionEqProvenance.fromLiquidity(liquidity);
    return snapshot;
}

function buildTakenEvent(liquidity, candle, candleIndex, timeframe) {
    var tf = timeframe || '5m';
    if (tf !== '5m' || !isNarrativeLiquidityV1(liquidity) ||
            !isEligiblePreBarState(liquidity) ||
            !isCausallyAvailableBeforeBar(liquidity, candle)) {
        return null;
    }
    var frozen = liquiditySnapshot(liquidity, candle.openTime);
    if (!isStrictTradeThrough(liquidity, candle, frozen.price)) return null;
    var event = {
        id: liquidity.symbol + ':' + tf + ':TAKEN:' + liquidity.id + ':' + candle.openTime,
        symbol: liquidity.symbol,
        timeframe: tf,
        type: 'LIQUIDITY_TAKEN',
        side: liquidity.side,
        liquidityId: liquidity.id,
        occurredAt: candle.openTime,
        confirmedAt: candle.closeTime,
        candleIndex: candleIndex,
        price: frozen.price,
        source: {
            liquidityId: liquidity.id,
            liquidityType: liquidity.type,
            liquidityPrice: frozen.price,
            side: liquidity.side,
            interactionExtreme: interactionExtreme(liquidity, candle)
        },
        metadata: {}
    };
    if (frozen.eqPartnerProvenance) {
        event.source.eqPartnerProvenance = frozen.eqPartnerProvenance;
    }
    return event;
}

module.exports = {
    NARRATIVE_TYPES: NARRATIVE_TYPES,
    isNarrativeLiquidityV1: isNarrativeLiquidityV1,
    isEligiblePreBarState: isEligiblePreBarState,
    isCausallyAvailableBeforeBar: isCausallyAvailableBeforeBar,
    isStrictTradeThrough: isStrictTradeThrough,
    interactionExtreme: interactionExtreme,
    liquiditySnapshot: liquiditySnapshot,
    buildTakenEvent: buildTakenEvent
};
