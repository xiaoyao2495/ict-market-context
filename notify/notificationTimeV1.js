'use strict';

var UTC8_OFFSET_MS = 8 * 60 * 60 * 1000;
var UNAVAILABLE = 'UNAVAILABLE';

function timestamp(value) {
    if (value === null || value === undefined || value === '') return null;
    if (value instanceof Date) return value.getTime();
    if (typeof value === 'number') return isFinite(value) && value >= 0 ? value : null;
    if (typeof value !== 'string') return null;
    var text = value.trim();
    if (!text) return null;
    var parsed = /^\d+(?:\.\d+)?$/.test(text) ? Number(text) : Date.parse(text);
    return isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function pad2(value) { return value < 10 ? '0' + value : String(value); }

/** Presentation-only, deterministic fixed UTC+8 minute display. */
function formatNotificationTimeUtc8(value) {
    var ms = timestamp(value);
    if (ms === null) return UNAVAILABLE;
    var shifted = new Date(ms + UTC8_OFFSET_MS);
    if (!isFinite(shifted.getTime())) return UNAVAILABLE;
    return pad2(shifted.getUTCMonth() + 1) + '-' + pad2(shifted.getUTCDate()) + ' ' +
        pad2(shifted.getUTCHours()) + ':' + pad2(shifted.getUTCMinutes()) + ' (UTC+8)';
}

module.exports = { formatNotificationTimeUtc8: formatNotificationTimeUtc8,
    UTC8_OFFSET_MS: UTC8_OFFSET_MS, UNAVAILABLE: UNAVAILABLE };
