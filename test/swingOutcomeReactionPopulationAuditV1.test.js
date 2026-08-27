'use strict';
var assert = require('assert');
var audit = require('../scripts/swingOutcomeReactionPopulationAuditV1');

function candles() {
    var out = [], base = 1000000;
    for (var i = 0; i < 50; i++) out.push({
        openTime: base + i * 300000, closeTime: base + (i + 1) * 300000 - 1,
        open: 100, high: 101, low: 99, close: 100, closed: true
    });
    return out;
}

(function reactionStartsStrictlyAfterConfirmation() {
    var cs = candles();
    cs[10] = Object.assign({}, cs[10], { low: 80, high: 120 }); // confirmation candle must not enter reaction
    cs[11] = Object.assign({}, cs[11], { low: 98, high: 101, close: 99 });
    cs[12] = Object.assign({}, cs[12], { low: 96, high: 100, close: 97 });
    var f = { canonicalSwingId: 'X', side: 'SWING_HIGH', price: 100, atrAtConfirmedAt: 2, confirmationIndex: 10, confirmedAt: cs[10].closeTime };
    var r = audit.reactionFor(f, cs);
    assert.equal(r.reactionATR_1, 1);
    assert.equal(r.reactionATR_3, 2);
    assert.equal(r.maeATR_1, 0.5);
    assert.equal(r.barsTo_1ATR, 1);
    assert(r.reactionEfficiency_3 >= 0 && r.reactionEfficiency_3 <= 1);
})();

(function lowSideIsSymmetric() {
    var cs = candles();
    cs[11] = Object.assign({}, cs[11], { low: 99, high: 102, close: 101 });
    var f = { canonicalSwingId: 'Y', side: 'SWING_LOW', price: 100, atrAtConfirmedAt: 2, confirmationIndex: 10, confirmedAt: cs[10].closeTime };
    var r = audit.reactionFor(f, cs);
    assert.equal(r.reactionATR_1, 1);
    assert.equal(r.directionalCloseCount_1, 1);
})();

(function incompleteHorizonIsNull() {
    var cs = candles().slice(0, 12);
    var f = { canonicalSwingId: 'Z', side: 'SWING_HIGH', price: 100, atrAtConfirmedAt: 2, confirmationIndex: 10, confirmedAt: cs[10].closeTime };
    var r = audit.reactionFor(f, cs);
    assert.equal(r.reactionATR_1, 0.5);
    assert.equal(r.reactionATR_3, null);
    assert.equal(r.reactionATR_40, null);
})();

(function deterministicStatisticsAndSelection() {
    var d = audit.distribution([1, 2, 3, 4]);
    assert.equal(d.count, 4);
    assert.equal(d.median, 2.5);
    var rows = [];
    for (var i = 0; i < 100; i++) rows.push({
        canonicalSwingId: 'ID:' + String(i).padStart(3, '0'), occurredAt: i, confirmedAt: i + 1,
        side: i % 2 ? 'SWING_HIGH' : 'SWING_LOW', price: 100,
        prominenceATR: i, reactionATR_3: i / 10, reactionATR_10: 100 - i,
        reactionATR_40: i, mfeATR_40: i, maeATR_40: i / 2,
        sameSideCountWithin0_5ATR: i, nearestHigherOrderDistanceATR: i,
        barsToCrossBeyondSwing: i % 7, breakNearestOppositeSwing: i % 2 === 0,
        mssConfirmed: false, displacementConfirmed: false, reactionPathClass: 'CHOPPY',
        growth_10_to_20: i
    });
    var a = audit.selectCounterexamples(rows), b = audit.selectCounterexamples(rows);
    assert.deepStrictEqual(a, b);
    assert.equal(a.length, 8);
    assert.equal(audit.stable(a), audit.stable(b));
})();

console.log('Swing Outcome / Reaction Population Audit V1 tests passed');
