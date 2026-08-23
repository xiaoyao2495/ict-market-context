'use strict';

/**
 * Stable reference identity for an authoritative structural event at the
 * AI-contract boundary. The deterministic engine remains the owner of event
 * facts; this module only gives those immutable facts an opaque reference the
 * model can echo without reconstructing direction/price/time.
 */
function eventId(event) {
    if (!event || typeof event !== 'object') return null;
    var fields = [
        event.type,
        event.direction,
        event.referenceLevel,
        event.eventTime,
        event.confirmedAt
    ];
    if (fields.some(function (value) {
        return value === undefined || value === null || value === '';
    })) return null;
    return 'AUTHORITATIVE_STRUCTURAL_EVENT:' + fields.map(function (value) {
        return encodeURIComponent(String(value));
    }).join(':');
}

function mssEventIds(events) {
    return (events || []).filter(function (event) {
        return event && event.type === 'STRUCTURAL_MSS';
    }).map(eventId).filter(Boolean);
}

module.exports = {
    eventId: eventId,
    mssEventIds: mssEventIds
};
