'use strict';

var marketReference = require('../marketReferenceV1');
var dynamicD = require('../../liquidity/causalDynamicDHistoricalExtremes');

var SOURCE_VERSION = 'DYNAMIC_D_HISTORICAL_EXTREME_REFERENCE_SOURCE_V1';

function project(point) {
    if (!point || typeof point.id !== 'string' || !point.id) throw new Error('DYNAMIC_D_SOURCE_ID_INVALID');
    if (point.pointSide !== 'HIGH' && point.pointSide !== 'LOW') throw new Error('DYNAMIC_D_SOURCE_SIDE_INVALID');
    if (point.localizationMode !== dynamicD.LOCALIZATION_VERSION || point.priceSource !== 'SAME_PROCESS_WICK_EXTREME' ||
            point.price !== point.localizedExtremePrice || point.occurredAt !== point.localizedExtremeOpenTime) {
        throw new Error('DYNAMIC_D_LOCALIZATION_PROVENANCE_INVALID');
    }
    return marketReference.createMarketReference({
        symbol: point.symbol,
        timeframe: point.timeframe,
        sourceType: 'DYNAMIC_D_HISTORICAL_EXTREME',
        side: point.pointSide === 'HIGH' ? 'BUY_SIDE' : 'SELL_SIDE',
        price: point.price,
        occurredAt: point.occurredAt,
        confirmedAt: point.confirmedAt,
        sourceProvenance: {
            sourceVersion: SOURCE_VERSION,
            sourceNativeId: point.id,
            candidateId: point.id,
            processId: point.processId,
            pointSide: point.pointSide,
            dynamicDVersion: dynamicD.VERSION,
            closeProcess: {
                selectorPrice: point.selectorPrice,
                selectorOccurredAt: point.selectorOccurredAt,
                processStartBarIndex: point.processStartBarIndex,
                processEndBarIndex: point.processEndBarIndex,
                thetaAtExtreme: point.thetaAtExtreme,
                sigma5mAtExtreme: point.sigma5mAtExtreme == null ? null : point.sigma5mAtExtreme,
                sigma1hAtExtreme: point.sigma1hAtExtreme == null ? null : point.sigma1hAtExtreme,
                floorActive: point.floorActive == null ? null : point.floorActive
            },
            wickLocalization: {
                version: dynamicD.LOCALIZATION_VERSION,
                selectorWickPrice: point.selectorWickPrice,
                localizedExtremeOpenTime: point.localizedExtremeOpenTime,
                localizedExtremePrice: point.localizedExtremePrice
            }
        }
    });
}

function projectMany(points) {
    if (!Array.isArray(points)) throw new Error('DYNAMIC_D_SOURCE_LIST_INVALID');
    return points.map(project);
}

module.exports = {
    SOURCE_VERSION: SOURCE_VERSION,
    project: project,
    projectMany: projectMany
};
