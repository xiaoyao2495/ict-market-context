'use strict';

var crypto = require('crypto');

function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (!value || typeof value !== 'object') return value;
    var out = {};
    Object.keys(value).sort().forEach(function (key) { out[key] = stable(value[key]); });
    return out;
}
function hash(value) { return crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex'); }
function firstSweepBySwing(events) {
    var byId = {};
    (events || []).slice().sort(function (a, b) {
        return a.confirmedAt - b.confirmedAt || String(a.swingId).localeCompare(String(b.swingId));
    }).forEach(function (event) {
        if (!event || !event.swingId || !Number.isFinite(event.confirmedAt)) return;
        if (!byId[event.swingId]) byId[event.swingId] = event;
    });
    return byId;
}
function realtimeMembership(row, sweepTime) {
    var out = {};
    ['5m', '15m', '1h', '4h'].forEach(function (timeframe) {
        var member = row.timeframeMembership[timeframe] || { member: false };
        out[timeframe] = member.member && member.confirmedAt <= sweepTime ? 'CONFIRMED' : 'UNCONFIRMED';
    });
    return out;
}
function classify(row, sweepTime, timeframe) {
    var member = row.timeframeMembership[timeframe];
    if (!member || !member.member) return null;
    return member.confirmedAt <= sweepTime ? 'CONFIRMED_AT_SWEEP' : 'UNCONFIRMED_AT_SWEEP';
}
function buildRecords(membership, sweepEvents) {
    var first = firstSweepBySwing(sweepEvents), records = [];
    (membership || []).slice().sort(function (a, b) { return a.canonicalSwingId.localeCompare(b.canonicalSwingId); }).forEach(function (row) {
        var sweep = first[row.canonicalSwingId];
        if (!sweep) return;
        var finalClassification = {}, atSweep = realtimeMembership(row, sweep.confirmedAt);
        ['5m', '15m', '1h', '4h'].forEach(function (tf) { finalClassification[tf] = row.timeframeMembership[tf].member ? 'CONFIRMED' : 'NOT_MEMBER'; });
        ['15m', '1h', '4h'].forEach(function (tf) {
            var classification = classify(row, sweep.confirmedAt, tf), member = row.timeframeMembership[tf];
            if (!classification) return;
            records.push({
                canonicalSwingId: row.canonicalSwingId,
                side: row.side,
                price: row.price,
                timeframe: tf,
                fiveMinuteOccurredAt: row.occurredAt,
                fiveMinuteConfirmedAt: row.confirmedAt,
                htfSwingId: member.htfSwingId,
                htfCandleOccurredAt: member.occurredAt,
                htfConfirmedAt: member.confirmedAt,
                firstSweepAt: sweep.confirmedAt,
                classification: classification,
                finalClassification: finalClassification,
                realtimeClassificationAtSweep: atSweep,
                confirmationLeadMinutes: classification === 'CONFIRMED_AT_SWEEP' ? (sweep.confirmedAt - member.confirmedAt) / 60000 : null,
                postSweepConfirmationLagMinutes: classification === 'UNCONFIRMED_AT_SWEEP' ? (member.confirmedAt - sweep.confirmedAt) / 60000 : null
            });
        });
    });
    return records;
}

module.exports = {
    stable: stable,
    hash: hash,
    firstSweepBySwing: firstSweepBySwing,
    realtimeMembership: realtimeMembership,
    classify: classify,
    buildRecords: buildRecords
};
