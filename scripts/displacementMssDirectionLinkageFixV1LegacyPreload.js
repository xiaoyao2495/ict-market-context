'use strict';

// Audit-only compatibility shim. It restores the frozen pre-fix provenance
// selection while keeping the current detector's scoring and event creation.
var detector = require('../events/displacementDetector');
var current = detector.detectDisplacement;

detector.detectDisplacement = function (candles, mssEvents, options) {
    var events = current(candles, mssEvents, options);
    var byIndex = {};
    (mssEvents || []).forEach(function (mss) {
        if (!byIndex[mss.candleIndex]) byIndex[mss.candleIndex] = [];
        byIndex[mss.candleIndex].push(mss);
    });
    events.forEach(function (event) {
        var sameBar = byIndex[event.candleIndex] || [];
        event.metadata.mssEventId = sameBar.length ? sameBar[0].id : null;
    });
    return events;
};
