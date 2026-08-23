'use strict';
var fs = require('fs');
var path = require('path');
var pivot = require('../structure/pivotDetector');
var structural = require('../structure/structuralProvenance5m');
var dir = path.join(__dirname, '..', 'data-cache');
var byOpen = {};
fs.readdirSync(dir).filter(function (f) { return f.indexOf('BTCUSDT_5m_') === 0 && /\.json$/.test(f); })
    .forEach(function (f) {
        var rows;
        try { rows = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { return; }
        (rows || []).forEach(function (c) { if (c.source === 'futures' && c.closed !== false) byOpen[c.openTime] = c; });
    });
var startTime = Number(process.argv[2] || 0);
var candles = Object.keys(byOpen).map(function (k) { return byOpen[k]; })
    .filter(function (c) { return c.openTime >= startTime; })
    .sort(function (a, b) { return a.openTime - b.openTime; });
var st = structural.createState({ symbol: 'BTCUSDT', timeframe: '5m' });
var snaps = {};
candles.forEach(function (c, i) {
    var added = [];
    var mid = i - 2;
    if (mid >= 2) {
        if (pivot.detectPivotHigh(candles, mid, 2, 2)) added.push(make('HIGH', mid, i));
        if (pivot.detectPivotLow(candles, mid, 2, 2)) added.push(make('LOW', mid, i));
    }
    structural.step(st, c, i, added);
    if (c.closeTime === 1786027799999 || c.closeTime === 1786638599999) {
        snaps[c.closeTime] = JSON.parse(JSON.stringify({
            state: st.structuralState,
            activeProtected: st.activeProtected,
            frontier: st.frontier,
            pendingProduced: st.pendingProduced,
            retiredProduced: st.retiredProduced,
            refs: st.swings.filter(function (s) { return s.price === 64568.5 || s.price === 63534; }),
            events: st.events.filter(function (e) { return e.confirmedAt >= c.closeTime - 48 * 300000; })
        }));
    }
    function make(side, pidx, confirmIdx) {
        return { id: 'BTCUSDT:5m:SWING_' + side + ':' + candles[pidx].openTime,
            symbol: 'BTCUSDT', timeframe: '5m', type: 'SWING_' + side,
            price: side === 'HIGH' ? candles[pidx].high : candles[pidx].low,
            sourceOpenTime: candles[pidx].openTime, confirmedAt: candles[confirmIdx].closeTime,
            metadata: { index: pidx } };
    }
});
console.log(JSON.stringify({ counts: {
    swings: st.swings.length,
    bos: st.events.filter(function (e) { return e.type === 'STRUCTURAL_BOS'; }).length,
    mss: st.events.filter(function (e) { return e.type === 'STRUCTURAL_MSS'; }).length,
    continuation: st.events.filter(function (e) { return e.type === 'STRUCTURAL_CONTINUATION'; }).length
}, snapshots: snaps,
targetPenetrations: st.penetrations.filter(function (p) {
    return p.referenceLevel === 63637.8;
}),
targetBreakDiagnostics: st.swings.filter(function (s) {
    return [1785310500000, 1786534500000, 1786582800000, 1787022900000].indexOf(s.occurredAt) >= 0;
}).map(function (s) {
    return { swing: s, events: st.events.filter(function (e) {
        return e.source && e.source.structuralSwingId === s.id;
    }) };
}) }, null, 2));
