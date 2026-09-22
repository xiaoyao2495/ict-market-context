'use strict';

var VERSION = 'MARKET_STATE_MAP_V1';
var VALID = ['RANGE', 'BULL_TREND', 'BEAR_TREND'];

function unavailable(snapshotAt, reason) {
    return { version: VERSION, snapshotAt: snapshotAt || null, state: 'UNAVAILABLE',
        stateSince: null, trendEstablishedAt: null, activeProtectedType: null,
        activeProtectedPrice: null, errorCode: reason || 'MARKET_STATE_NOT_READY' };
}

function normalize(raw, snapshotAt) {
    if (!raw || VALID.indexOf(raw.state) < 0) return unavailable(snapshotAt, 'MARKET_STATE_NOT_READY');
    return { version: VERSION, snapshotAt: snapshotAt,
        state: raw.state, stateSince: raw.stateSince || null,
        trendEstablishedAt: raw.trendEstablishedAt || null,
        activeProtectedType: raw.state === 'RANGE' ? null : (raw.activeProtectedType || null),
        activeProtectedPrice: raw.state === 'RANGE' ? null :
            (Number.isFinite(Number(raw.activeProtectedPrice)) ? Number(raw.activeProtectedPrice) : null),
        errorCode: null };
}

/** Reporting-only fail-open boundary. Provider must return state causal at snapshotAt. */
function capture(provider, snapshotAt) {
    try { return normalize(typeof provider === 'function' ? provider(snapshotAt) : null, snapshotAt); }
    catch (error) { return unavailable(snapshotAt, error && error.code || 'MARKET_STATE_SNAPSHOT_FAILED'); }
}

module.exports = { VERSION: VERSION, capture: capture, normalize: normalize, unavailable: unavailable,
    MARKET_STATE_AFFECTS_TRADING: false, LLM2_ENABLED: false };
