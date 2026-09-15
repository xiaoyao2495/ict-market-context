'use strict';

var marketReference = require('../marketReferenceV1');

var SOURCE_VERSION = 'STRUCTURAL_SWING_REFERENCE_SOURCE_V1';

function project(swing) {
    if (!swing || typeof swing.id !== 'string' || !swing.id) throw new Error('STRUCTURAL_SWING_SOURCE_ID_INVALID');
    if (swing.side !== 'HIGH' && swing.side !== 'LOW') throw new Error('STRUCTURAL_SWING_SOURCE_SIDE_INVALID');
    var creation = Array.isArray(swing.history) && swing.history.length ? swing.history[0] : null;
    if (!creation || creation.confirmedAt !== swing.confirmedAt) {
        throw new Error('STRUCTURAL_SWING_CREATION_PROVENANCE_INVALID');
    }
    return marketReference.createMarketReference({
        symbol: swing.symbol,
        timeframe: swing.timeframe,
        sourceType: 'STRUCTURAL_SWING',
        side: swing.side === 'HIGH' ? 'BUY_SIDE' : 'SELL_SIDE',
        price: swing.price,
        occurredAt: swing.occurredAt,
        confirmedAt: swing.confirmedAt,
        sourceProvenance: {
            sourceVersion: SOURCE_VERSION,
            sourceNativeId: swing.id,
            pivotId: swing.sourceSwingId,
            pivotSide: swing.side,
            wickPrice: swing.price,
            pivotGeometry: { leftBars: 2, rightBars: 2 },
            detectorVersion: 'PIVOT_DETECTOR_2L2R',
            roleAtReferenceConfirmation: creation.role,
            statusAtReferenceConfirmation: creation.status,
            creationReason: creation.reason,
            creationConfirmedAt: creation.confirmedAt
        }
    });
}

function projectMany(swings) {
    if (!Array.isArray(swings)) throw new Error('STRUCTURAL_SWING_SOURCE_LIST_INVALID');
    return swings.map(project);
}

module.exports = {
    SOURCE_VERSION: SOURCE_VERSION,
    project: project,
    projectMany: projectMany
};
