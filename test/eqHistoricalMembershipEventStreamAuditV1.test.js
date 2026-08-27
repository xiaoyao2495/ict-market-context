'use strict';
var assert = require('assert');
var projector = require('../audit/eqHistoricalStateProjectorV1');
var audit = require('../scripts/eqHistoricalMembershipEventStreamAuditV1');

function swing(id, type, price, occurredAt, confirmedAt) {
    return { id:id, symbol:'BTCUSDT', timeframe:'5m', type:type, side:type==='SWING_HIGH'?'BSL':'SSL', price:price, sourceOpenTime:occurredAt, sourceCloseTime:occurredAt+299999, confirmedAt:confirmedAt };
}
function object(id, type, members) {
    var confirmedAt=Math.max.apply(null,members.map(function(m){return m.confirmedAt;})),anchor=members[0];
    return { id:id, symbol:'BTCUSDT', timeframe:'5m', type:type, side:type==='EQH'?'BSL':'SSL', price:members.reduce(function(a,m){return a+m.price;},0)/members.length, confirmedAt:confirmedAt, status:'ACTIVE', metadata:{members:members,validPairIds:members.slice(1).map(function(m){return type+':'+anchor.id+':'+m.id;}),pairFeatures:members.slice(1).map(function(m){return{pairId:type+':'+anchor.id+':'+m.id,firstSwingState:'ACTIVE'};})} };
}
function stream(o) {
    var events=[audit.creationEvent(o)];
    o.metadata.members.forEach(function(m){events.push(audit.memberEvent(o,m,o.confirmedAt));});
    return events;
}
var s1=swing('BTCUSDT:5m:SWING_HIGH:1000','SWING_HIGH',100,1000,2000);
var s2=swing('BTCUSDT:5m:SWING_HIGH:3000','SWING_HIGH',100.1,3000,4000);
var s3=swing('BTCUSDT:5m:SWING_HIGH:5000','SWING_HIGH',100.2,5000,6000);
var eq=object('BTCUSDT:EQH:1000','EQH',[s1,s2]);

(function creationAvailabilityUsesLatestMemberConfirmation(){var e=audit.creationEvent(eq);assert.equal(e.effectiveAt,4000);assert.equal(e.formationAvailableAt,4000);assert.equal(e.creationAvailabilityValid,true);})();
(function futureObjectIsInvisible(){assert.equal(projector.projectEqState(stream(eq),3999).length,0);assert.equal(projector.projectEqState(stream(eq),4000).length,1);})();
(function futureMemberIsInvisible(){var events=stream(eq),late=audit.memberEvent(eq,s3,6000);events.push(late);assert.equal(projector.getEqObjectStateAt(eq.id,events,5999).members.length,2);assert.equal(projector.getEqObjectStateAt(eq.id,events,6000).members.length,3);})();
(function futureLifecycleIsInvisible(){var events=stream(eq);events.push(audit.lifecycleEvent(eq,'ACTIVE','SWEPT',7000));assert.equal(projector.getEqObjectStateAt(eq.id,events,6999).currentLifecycleState,'ACTIVE');assert.equal(projector.getEqObjectStateAt(eq.id,events,7000).currentLifecycleState,'SWEPT');})();
(function futureSweptOrBrokenCannotRejectPastEligibleFormation(){['SWEPT','BROKEN'].forEach(function(next){var events=stream(eq),creation=events[0];events.push(audit.lifecycleEvent(eq,'ACTIVE',next,7000));var past=projector.getEqObjectStateAt(eq.id,events,4000);assert.equal(past.currentLifecycleState,'ACTIVE');assert.equal(creation.pairFeatures[0].firstSwingState,'ACTIVE');assert.equal(creation.creationAvailabilityValid,true);});})();
(function historicalMembershipCannotBeRewritten(){var before=projector.projectEqState(stream(eq),4000),events=stream(eq);events.push(audit.memberEvent(eq,s3,6000));assert.deepStrictEqual(projector.projectEqState(events,4000),before);})();
(function noTransitiveMemberInference(){var events=stream(eq);assert.equal(projector.getEqMembershipAt(s3.id,events,9999).length,0);})();
(function lifecycleIsMonotonic(){var events=stream(eq);events.push(audit.lifecycleEvent(eq,'ACTIVE','BROKEN',7000));events.push(audit.lifecycleEvent(eq,'BROKEN','TOUCHED',8000));assert.throws(function(){projector.projectEqState(events,9000);},/Lifecycle regression/);})();
(function sweptAndBrokenRemainQueryable(){var swept=stream(eq);swept.push(audit.lifecycleEvent(eq,'ACTIVE','SWEPT',7000));assert.equal(projector.getEqMembershipAt(s1.id,swept,7000)[0].objectLifecycleState,'SWEPT');var broken=stream(eq);broken.push(audit.lifecycleEvent(eq,'ACTIVE','BROKEN',7000));assert.equal(projector.getEqMembershipAt(s1.id,broken,7000)[0].objectLifecycleState,'BROKEN');})();
(function canonicalSwingIdentityIsStable(){assert.equal(audit.canonicalId(s1),'BTCUSDT:5m:SWING_HIGH:1000');})();
(function productionObjectIdentityIsPreserved(){var e=audit.creationEvent(eq);assert.equal(e.productionObjectId,'BTCUSDT:EQH:1000');assert.equal(e.anchor.canonicalSwingId,s1.id);})();
(function eventIdentityIsDeterministic(){var a=projector.eventId('EQ_MEMBER_ATTACHED',eq.id,s1.id,4000),b=projector.eventId('EQ_MEMBER_ATTACHED',eq.id,s1.id,4000);assert.equal(a,b);assert.notEqual(a,projector.eventId('EQ_MEMBER_ATTACHED',eq.id,s2.id,4000));})();
(function incrementalEqualsFullReplay(){var events=stream(eq);events.push(audit.lifecycleEvent(eq,'ACTIVE','TOUCHED',7000));var full=projector.projectEqState(events,7000).map(function(o){delete o.evaluationTime;return o;});assert.deepStrictEqual(projector.incrementalProject(events),full);})();
(function deterministicReplayUsesCapturedEventsOnly(){var events=stream(eq),first={allEvents:events};var a=audit.deterministicEventReplay(first,'POP',4000),b=audit.deterministicEventReplay(first,'POP',4000);assert.deepStrictEqual(a,b);assert.equal(a.populationHash,'POP');})();
(function productionNormalizationEqualsProjection(){var events=stream(eq),store={};events.sort(projector.order).forEach(function(e){projector.applyEvent(store,e);});assert.deepStrictEqual(audit.normalizeProjection(store),audit.normalizeProduction([eq]));})();
(function boundedAnchorMustDirectlyOwnEveryPair(){var first={objectEvents:[audit.creationEvent(eq)],membershipEvents:stream(eq).filter(function(e){return e.eventType==='EQ_MEMBER_ATTACHED';})};assert.equal(audit.boundedAnchorAudit(first).BOUNDED_ANCHOR_VIOLATIONS,0);var bad=object('BTCUSDT:EQH:1000','EQH',[s1,s2,s3]);bad.metadata.validPairIds=['EQH:'+s1.id+':'+s2.id,'EQH:'+s2.id+':'+s3.id];var badFirst={objectEvents:[audit.creationEvent(bad)],membershipEvents:stream(bad).filter(function(e){return e.eventType==='EQ_MEMBER_ATTACHED';})};assert.equal(audit.boundedAnchorAudit(badFirst).BOUNDED_ANCHOR_VIOLATIONS,1);})();
(function frozen806ComparisonRequiresExactIdentityTimeAndPrice(){var frozen=[],events=[];for(var i=0;i<806;i++){var id='S'+i,objectId='E'+i;frozen.push({objectId:objectId,lastConfirmedAt:10,memberSwingIds:[id],memberPrices:[100+i]});events.push({eqObjectId:objectId,canonicalSwingId:id,availableAt:10,memberPrice:100+i});}var result=audit.compareFrozen(frozen,events,frozen.map(function(o){return o.memberSwingIds[0];}),20);assert.equal(result.FROZEN_806_EXPECTED,806);assert.equal(result.FROZEN_806_MATCHED,806);assert.equal(result.FROZEN_806_MISSING,0);assert.equal(result.FROZEN_806_CONFLICTING,0);})();
(function futureLeakAuditRejectsPrematureFacts(){var good={objectEvents:[audit.creationEvent(eq)],membershipEvents:stream(eq).filter(function(e){return e.eventType==='EQ_MEMBER_ATTACHED';}),lifecycleEvents:[]};assert.equal(audit.futureLeakAudit(good).FUTURE_LEAK_VIOLATIONS,0);var bad=JSON.parse(JSON.stringify(good));bad.membershipEvents[0].availableAt=1999;assert.equal(audit.futureLeakAudit(bad).FUTURE_LEAK_VIOLATIONS,2);})();

console.log('EQH/EQL Historical Membership Event Stream Audit V1 tests passed');
