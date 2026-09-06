'use strict';

var VERSION = 'EQ_SOURCE_CONTEXT_V1';

function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function finiteTime(value) {
    return typeof value === 'number' && isFinite(value);
}

function sourceIsCausal(source, eqConfirmedAt) {
    return source && source.id != null && finiteTime(source.occurredAt) &&
        finiteTime(source.confirmedAt) && finiteTime(eqConfirmedAt) &&
        source.occurredAt <= source.confirmedAt && source.confirmedAt <= eqConfirmedAt;
}

function unavailable(errorCode) {
    return {
        version: VERSION,
        status: 'UNAVAILABLE',
        currentPivot: null,
        historicalPartners: [],
        partnerCount: null,
        primaryPartnerSelection: false,
        displayOrderOnly: 'CHRONOLOGICAL_OCCURRED_AT',
        errorCode: errorCode
    };
}

/**
 * Freeze the exact source set already chosen by Production EQ detection.
 * This function never searches candles, matches prices, or selects a partner.
 */
function fromLiquidity(liquidity) {
    var metadata = liquidity && liquidity.metadata;
    var eqConfirmedAt = liquidity && liquidity.confirmedAt;
    if (!metadata || !metadata.currentPivot || !Array.isArray(metadata.historicalPartners)) {
        return unavailable('EQ_SOURCE_CONTEXT_MISSING');
    }
    if (metadata.primaryPartnerSelection !== false) {
        return unavailable('PRIMARY_PARTNER_CONTRACT_INVALID');
    }
    var currentPivot = metadata.currentPivot;
    var partners = metadata.historicalPartners;
    if (!sourceIsCausal(currentPivot, eqConfirmedAt) || partners.length === 0 ||
            partners.some(function (partner) { return !sourceIsCausal(partner, eqConfirmedAt); })) {
        return unavailable('EQ_SOURCE_CAUSALITY_INVALID');
    }
    return {
        version: VERSION,
        status: 'AVAILABLE',
        currentPivot: clone(currentPivot),
        historicalPartners: clone(partners),
        partnerCount: partners.length,
        primaryPartnerSelection: false,
        displayOrderOnly: 'CHRONOLOGICAL_OCCURRED_AT',
        errorCode: null
    };
}

/** Chronological presentation copy only; the persisted detector order is untouched. */
function historicalPartnersForDisplay(context) {
    return clone(context && context.historicalPartners || []).sort(function (a, b) {
        var byTime = a.occurredAt - b.occurredAt;
        return byTime || String(a.id).localeCompare(String(b.id));
    });
}

module.exports = {
    VERSION: VERSION,
    fromLiquidity: fromLiquidity,
    sourceIsCausal: sourceIsCausal,
    historicalPartnersForDisplay: historicalPartnersForDisplay,
    unavailable: unavailable
};
