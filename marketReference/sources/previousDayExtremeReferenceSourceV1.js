'use strict';

var marketReference = require('../marketReferenceV1');
var utcTime = require('../../utils/utcTime');

var SOURCE_VERSION = 'PREVIOUS_DAY_EXTREME_REFERENCE_SOURCE_V1';

function project(extreme) {
    if (!extreme || typeof extreme.id !== 'string' || !extreme.id) throw new Error('PREVIOUS_DAY_SOURCE_ID_INVALID');
    if (extreme.type !== 'PDH' && extreme.type !== 'PDL') throw new Error('PREVIOUS_DAY_SOURCE_TYPE_INVALID');
    if (extreme.boundaryConvention !== 'UTC') throw new Error('PREVIOUS_DAY_BOUNDARY_INVALID');
    if (!Number.isFinite(extreme.periodStart) || extreme.confirmedAt !== extreme.periodStart + utcTime.DAY_MS) {
        throw new Error('PREVIOUS_DAY_COMPLETION_INVALID');
    }
    if (!Number.isFinite(extreme.sourceCandleOpenTime) || extreme.sourceCandleOpenTime < extreme.periodStart ||
            extreme.sourceCandleOpenTime >= extreme.periodStart + utcTime.DAY_MS) {
        throw new Error('PREVIOUS_DAY_OCCURRENCE_INVALID');
    }
    return marketReference.createMarketReference({
        symbol: extreme.symbol,
        timeframe: extreme.timeframe,
        sourceType: 'PREVIOUS_DAY_EXTREME',
        side: extreme.type === 'PDH' ? 'BUY_SIDE' : 'SELL_SIDE',
        price: extreme.price,
        occurredAt: extreme.sourceCandleOpenTime,
        confirmedAt: extreme.confirmedAt,
        sourceProvenance: {
            sourceVersion: SOURCE_VERSION,
            sourceNativeId: extreme.id,
            calendarType: extreme.type,
            boundaryConvention: 'UTC',
            periodStart: extreme.periodStart,
            periodEndExclusive: extreme.periodStart + utcTime.DAY_MS,
            sourceCandleOpenTime: extreme.sourceCandleOpenTime,
            calendarConventionVersion: 'UTC_COMPLETED_DAY_V1'
        }
    });
}

function projectMany(extremes) {
    if (!Array.isArray(extremes)) throw new Error('PREVIOUS_DAY_SOURCE_LIST_INVALID');
    return extremes.map(project);
}

module.exports = {
    SOURCE_VERSION: SOURCE_VERSION,
    project: project,
    projectMany: projectMany
};
