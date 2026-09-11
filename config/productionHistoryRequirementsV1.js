'use strict';

/**
 * The single source of truth for live-production candle history.
 * Replay/research loaders deliberately keep their independent, date-range API.
 */
module.exports = Object.freeze({
    version: 'PRODUCTION_HISTORY_REQUIREMENTS_V1',
    '5m': Object.freeze({ requiredClosedBars: 723, role: 'PRODUCTION_REQUIRED' }),
    '4h': Object.freeze({ requiredClosedBars: 120, role: 'PRODUCTION_REQUIRED' }),
    // Transitional parity contracts. Remove only after LEGACY_SNAPSHOT_ISOLATION_V1.
    '1h': Object.freeze({ requiredClosedBars: 920, role: 'LEGACY_TEMPORARY_DEPENDENCY' }),
    '1d': Object.freeze({ requiredClosedBars: 230, role: 'LEGACY_TEMPORARY_DEPENDENCY' })
});
