'use strict';
var assert = require('assert');
var audit = require('../scripts/swingReactionLegStructuralAttributionAuditV1');

function candles(count) {
    var out = [], base = 1000000;
    for (var i = 0; i < count; i++) out.push({
        openTime: base + i * 300000, closeTime: base + (i + 1) * 300000 - 1,
        open: 100, high: 100.5, low: 99.5, close: 100, closed: true
    });
    return out;
}
function feature(cs) {
    return { canonicalSwingId: 'BTCUSDT:5m:SWING_HIGH:'+cs[0].openTime, side: 'SWING_HIGH', price: 100,
        occurredAt: cs[0].openTime, confirmedAt: cs[2].closeTime, confirmationIndex: 2, sourceIndex: 0,
        atrAtConfirmedAt: 2 };
}
function swing(id, type, price, confirmedAt) { return { id: id, type: type, price: price, confirmedAt: confirmedAt, sourceOpenTime: confirmedAt - 600000 }; }
function mss(id, index, direction, reference, cs) { return { id: id, candleIndex: index, direction: direction, confirmedAt: cs[index].closeTime, source: { referenceSwingId: reference.id } }; }
function disp(id, index, direction, cs) { return { id: id, candleIndex: index, direction: direction, confirmedAt: cs[index].closeTime, price: cs[index].close, source: { candle: cs[index] }, metadata: { atr: 2 } }; }

(function reactionStartsStrictlyAfterConfirmedAt() {
    var cs = candles(12), f = feature(cs);
    cs[1] = Object.assign({}, cs[1], { low: 80, close: 82 });
    cs[2] = Object.assign({}, cs[2], { low: 70, close: 72 });
    cs[3] = Object.assign({}, cs[3], { low: 98, close: 99 });
    var leg = audit.buildReactionLeg(f, cs, 1, 5);
    assert.equal(leg.legObservationStartAt, cs[3].closeTime);
    assert(leg.reactionInitiatedAt > f.confirmedAt);
    assert.equal(leg.legMFE_ATR, 1);
})();

(function insideFirstBarDoesNotInvalidateAndLegIsSideSymmetric() {
    var cs = candles(10), f = feature(cs);
    cs[3] = Object.assign({}, cs[3], { high: 100, low: 100, close: 100 });
    cs[4] = Object.assign({}, cs[4], { high: 100, low: 97, close: 98 });
    var leg = audit.buildReactionLeg(f, cs, 1, 5);
    assert.equal(leg.reactionInitiatedAt, cs[4].closeTime);
    assert.equal(leg.reached1ATR, true);
    var low = Object.assign({}, f, { canonicalSwingId: 'LOW', side: 'SWING_LOW' });
    cs[4] = Object.assign({}, cs[4], { high: 103, low: 100, close: 102 });
    var bull = audit.buildReactionLeg(low, cs, 1, 5);
    assert.equal(bull.legMFE_ATR, 1.5);
})();

(function snapshotRejectsFutureAndAlreadyConsumedReferences() {
    var cs = candles(10), f = feature(cs);
    var old = swing('LOW:OLD', 'SWING_LOW', 95, cs[1].closeTime);
    var future = swing('LOW:FUTURE', 'SWING_LOW', 94, cs[4].closeTime);
    var consumed = swing('LOW:CONSUMED', 'SWING_LOW', 96, cs[0].closeTime);
    var breaks = {}; breaks[consumed.id] = { confirmedAt: cs[1].closeTime };
    var snap = audit.snapshotStructuralReferences(f, [old, consumed, future].sort(function(a,b){return a.confirmedAt-b.confirmedAt;}), breaks);
    assert.equal(snap.nearestOppositeSwingId, old.id);
    assert.equal(snap.populatedReferenceSlots, 1);
    assert.equal(audit.referenceEligibleAtSnapshot(future, f, breaks), false);
    assert.equal(audit.referenceEligibleAtSnapshot(consumed, f, breaks), false);
})();

(function exactKnownReferenceMssAttributesButWrongReferenceDoesNot() {
    var cs = candles(12), f = feature(cs), ref = swing('LOW:KNOWN', 'SWING_LOW', 96, cs[1].closeTime), future = swing('LOW:FUTURE', 'SWING_LOW', 95, cs[5].closeTime);
    cs[3] = Object.assign({}, cs[3], { low: 98, close: 99 });
    cs[4] = Object.assign({}, cs[4], { high: 99, low: 94, close: 95 });
    var leg = audit.buildReactionLeg(f, cs, 1, 6), events = { mss: [mss('M1',4,'BEARISH',ref,cs)], displacements: [] }, byId = {}; byId[ref.id]=ref; byId[future.id]=future;
    var snapshot = audit.snapshotStructuralReferences(f, [ref], {});
    var br = audit.structuralBreakFor(f, leg, snapshot, events.mss, byId, {}, cs);
    var attributed = audit.attributeMss(f, leg, br, events, byId, {}, cs);
    assert.equal(br.attributedStructureBreak, true);
    assert.equal(attributed.attributedMss, true);
    var wrongEvents = { mss: [mss('M2',4,'BEARISH',future,cs)], displacements: [] };
    var wrong = audit.attributeMss(f, leg, br, wrongEvents, byId, {}, cs);
    assert.equal(wrong.genericMssWithin40, true);
    assert.equal(wrong.attributedMss, false);
    assert.equal(wrong.MSS_ATTRIBUTION_REJECT_REASON, 'WRONG_STRUCTURE_REFERENCE');
})();

(function mssAfterConfirmedReversalIsNotAttributed() {
    var cs = candles(12), f = feature(cs), ref = swing('LOW:R', 'SWING_LOW', 95, cs[1].closeTime), byId = {}; byId[ref.id]=ref;
    cs[3] = Object.assign({}, cs[3], { low: 95, close: 96 });
    cs[4] = Object.assign({}, cs[4], { high: 99, low: 96, close: 98 });
    cs[5] = Object.assign({}, cs[5], { low: 94, close: 94 });
    var leg = audit.buildReactionLeg(f, cs, 1, 8);
    assert.equal(leg.legEndReason, 'CONFIRMED_REVERSAL');
    var events = { mss: [mss('LATE',5,'BEARISH',ref,cs)], displacements: [] }, snapshot = audit.snapshotStructuralReferences(f,[ref],{});
    var br = audit.structuralBreakFor(f,leg,snapshot,events.mss,byId,{},cs), out = audit.attributeMss(f,leg,br,events,byId,{},cs);
    assert.equal(out.attributedMss, false);
    assert(['NEW_DELIVERY','AFTER_REACTION_LEG_END'].indexOf(out.MSS_ATTRIBUTION_REJECT_REASON) >= 0);
})();

(function returnToSwingEndsCausalOwnership() {
    var cs = candles(12), f = feature(cs);
    cs[3] = Object.assign({},cs[3],{low:96,high:99,close:97});
    cs[4] = Object.assign({},cs[4],{low:97,high:101,close:99});
    var leg = audit.buildReactionLeg(f,cs,5,8);
    assert.equal(leg.returnedToSwing,true);
    assert(leg.attributionEndIndex < 4);
})();

(function displacementNeedsAttributedMssAndExactDeliveryBoundary() {
    var cs = candles(15), f = feature(cs), leg = { attributionEndIndex: 5, legEndIndex: 5, legEndReason: 'MAX_HORIZON', returnedToSwing: false, crossedBeyondSwing: false, reactionInitiatedIndex: 3 };
    var d2 = disp('D2',7,'BEARISH',cs), events = { displacements: [d2] };
    var noMss = audit.attributeDisplacement(f,leg,{attributedMss:false,attributedMssIndex:null,attributedMssConfirmedAt:null},events,cs);
    assert.equal(noMss.sameDeliveryDisplacement,false);
    assert.equal(noMss.DISPLACEMENT_ATTRIBUTION_REJECT_REASON,'NO_ATTRIBUTED_MSS');
    var yes = audit.attributeDisplacement(f,leg,{attributedMss:true,attributedMssIndex:4,attributedMssConfirmedAt:cs[4].closeTime},events,cs);
    assert.equal(yes.sameDeliveryDisplacement,true);
    assert.equal(audit.continuationAllowed(leg,7),true);
    assert.equal(audit.continuationAllowed(leg,9),false);
})();

(function displacementAfterReturnOrOppositeReactionIsRejected() {
    var cs = candles(15), f = feature(cs), event = disp('D',7,'BEARISH',cs), events = { displacements: [event] };
    var leg = { attributionEndIndex: 4, legEndIndex: 5, legEndReason: 'CONFIRMED_REVERSAL', returnedToSwing: true, crossedBeyondSwing: false, reactionInitiatedIndex: 3 };
    var out = audit.attributeDisplacement(f,leg,{attributedMss:true,attributedMssIndex:4,attributedMssConfirmedAt:cs[4].closeTime},events,cs);
    assert.equal(out.sameDeliveryDisplacement,false);
    assert(['AFTER_RETURN_TO_SWING','NEW_DELIVERY'].indexOf(out.DISPLACEMENT_ATTRIBUTION_REJECT_REASON)>=0);
})();

(function canonicalIdentityAndReproducibilityAreDeterministic() {
    assert.equal(audit.canonicalSwingId('BTCUSDT','5m','SWING_HIGH',123),'BTCUSDT:5m:SWING_HIGH:123');
    var value = [{ b: 2, a: 1 }];
    assert.equal(audit.stable(value),audit.stable(JSON.parse(JSON.stringify(value))));
    var selected1 = audit.selectCounterexamples([]), selected2 = audit.selectCounterexamples([]);
    assert.deepStrictEqual(selected1,selected2);
})();

console.log('Swing Reaction-Leg Structural Attribution Audit V1 tests passed');
