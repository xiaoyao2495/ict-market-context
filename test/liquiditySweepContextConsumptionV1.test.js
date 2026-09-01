'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var swingProjector = require('../audit/swingContextProjectorV1');
var adapter = require('../audit/liquiditySweepContextConsumptionV1');

function swing(id, side, price) {
    return { canonicalSwingId:id, side:side, price:price, occurredAt:10, confirmedAt:20, timeframeMembership:{
        '5m':{member:true,htfSwingId:id,occurredAt:10,confirmedAt:20},
        '15m':{member:true,htfSwingId:'15:'+id,occurredAt:0,confirmedAt:40},
        '1h':{member:true,htfSwingId:'1h:'+id,occurredAt:0,confirmedAt:60},
        '4h':{member:true,htfSwingId:'4h:'+id,occurredAt:0,confirmedAt:80}
    }};
}
function makeProjector() {
    var swings=[swing('H','HIGH',110),swing('L','LOW',90),swing('L2','LOW',91)];
    var transitions=[];
    swings.forEach(function(s){transitions.push({sourceSwingId:s.canonicalSwingId,role:'LOCAL_SWING',status:'CANDIDATE',confirmedAt:20,sequence:0});});
    transitions.push({sourceSwingId:'H',role:'ACTIVE_PROTECTED',status:'ACTIVE_PROTECTED',confirmedAt:30,sequence:1});
    transitions.push({sourceSwingId:'H',role:'BROKEN',status:'BROKEN',confirmedAt:90,sequence:2});
    return swingProjector.createSwingContextProjectorV1({swings:swings,structuralTransitions:transitions});
}
function candidate(sourceId,sourceType,confirmedAt) { return {id:'SWEEP:'+sourceId+':'+confirmedAt,sourceId:sourceId,sourceType:sourceType,sourceTimeframe:'5m',side:/HIGH$|^H$/.test(sourceType)||sourceType==='SWING_HIGH'?'BSL':'SSL',sourcePrice:100,confirmedAt:confirmedAt}; }
function eqCandidate(confirmedAt) { var value=candidate('EQ1','EQL',confirmedAt);value.eqPartnerProvenance={currentPivot:{id:'P',price:100,confirmedAt:60},historicalPartners:[{id:'Z1',price:99,confirmedAt:20},{id:'Z2',price:101,confirmedAt:40}]};return value; }
function options(p) { return {projectSwingContextV1:p.projectSwingContextV1,eqMembersById:{EQ1:[{id:'L',availableAt:20},{id:'L2',availableAt:70}]}}; }

test('SWING_HIGH maps directly and structural role is as-of Sweep',function(){var p=makeProjector(),x=adapter.buildSweepContextV1(candidate('H','SWING_HIGH',50),options(p));assert.equal(x.contextApplicability,'SWING_DERIVED');assert.equal(x.canonicalSwingId,'H');assert.equal(x.swingContext.structural.currentRole,'ACTIVE_PROTECTED');assert.equal(x.evaluationTime,50);});
test('SWING_LOW maps directly with symmetric semantics',function(){var p=makeProjector(),x=adapter.buildSweepContextV1(candidate('L','SWING_LOW',50),options(p));assert.equal(x.canonicalSwingId,'L');assert.equal(x.swingContext.side,'LOW');assert.equal(x.liquidity.side,'SSL');});
test('future BROKEN does not backfill an old SweepContext',function(){var p=makeProjector(),x=adapter.buildSweepContextV1(candidate('H','SWING_HIGH',89),options(p));assert.equal(x.swingContext.structural.currentRole,'ACTIVE_PROTECTED');assert.notEqual(x.swingContext.structural.currentRole,'BROKEN');});
test('15m appears only at confirmedAt',function(){var p=makeProjector();assert.equal(adapter.buildSweepContextV1(candidate('H','SWING_HIGH',39),options(p)).swingContext.timeframeMembership['15m'].confirmed,false);assert.equal(adapter.buildSweepContextV1(candidate('H','SWING_HIGH',40),options(p)).swingContext.timeframeMembership['15m'].confirmed,true);});
test('future 1h and 4h memberships do not backfill',function(){var p=makeProjector(),x=adapter.buildSweepContextV1(candidate('H','SWING_HIGH',59),options(p));assert.equal(x.swingContext.timeframeMembership['1h'].confirmed,false);assert.equal(x.swingContext.timeframeMembership['4h'].confirmed,false);});
test('explicit liquidity preserves native identity and never guesses a Swing',function(){var x=adapter.buildSweepContextV1(candidate('BTC:PDH:2026-01-01','PDH',50),{});assert.equal(x.contextApplicability,'NON_SWING_LIQUIDITY');assert.equal(x.liquidity.sourceId,'BTC:PDH:2026-01-01');assert.equal(x.canonicalSwingId,null);assert.equal(x.swingContext,null);assert.equal(x.provenance.nearestSwingGuessing,false);});
test('EQ keeps point-in-time object identity and all frozen ATR50 partners',function(){var p=makeProjector(),x=adapter.buildSweepContextV1(eqCandidate(80),options(p));assert.equal(x.contextApplicability,'EQ_POINT_IN_TIME_CROSS_SOURCE');assert.equal(x.canonicalSwingId,null);assert.deepEqual(x.memberSwingContexts,[]);assert.deepEqual(x.provenance.historicalPartnerIds,['Z1','Z2']);assert.equal(x.provenance.clusterIdentity,false);});
test('later projection cannot rewrite an earlier frozen EQ partner snapshot',function(){var p=makeProjector(),c=eqCandidate(60),x=adapter.buildSweepContextV1(c,options(p)),before=adapter.hash(x);c.eqPartnerProvenance.historicalPartners.push({id:'FUTURE',confirmedAt:90});assert.equal(adapter.hash(x),before);});
test('multiple candidates are all preserved in original order',function(){var p=makeProjector(),cs=[candidate('L','SWING_LOW',50),candidate('N','NEW_YORK_LOW',50),candidate('EQ1','EQL',60)],w={id:'W',direction:'BULLISH',createdAt:60,updatedAt:60,liquidityTaken:{primary:cs[1],allCandidates:cs}},x=adapter.attachCandidateContextsShadow(w,options(p));assert.equal(x.candidateCountAfter,3);assert.deepEqual(x.candidateContexts.map(function(c){return c.liquidity.sourceId;}),['L','N','EQ1']);});
test('primary identity and WATCH envelope remain unchanged',function(){var p=makeProjector(),c=candidate('L','SWING_LOW',50),w={id:'W',direction:'BULLISH',createdAt:60,updatedAt:60,liquidityTaken:{primary:c,allCandidates:[c]}},before=adapter.hash(w),x=adapter.attachCandidateContextsShadow(w,options(p));assert.deepEqual(x.primaryAfter,x.primaryBefore);assert.equal(x.originalWatchHashBefore,before);assert.equal(x.originalWatchHashAfter,before);assert.equal(w.liquidityTaken.primary.sourceId,'L');});
test('past SweepContext snapshot is immutable',function(){var p=makeProjector(),x=adapter.buildSweepContextV1(candidate('H','SWING_HIGH',50),options(p)),h=adapter.hash(x);adapter.buildSweepContextV1(candidate('H','SWING_HIGH',100),options(p));assert.equal(adapter.hash(x),h);});
test('same input is deterministic across repeated projection',function(){var p=makeProjector(),c=candidate('EQ1','EQL',80);assert.equal(adapter.hash(adapter.buildSweepContextV1(c,options(p))),adapter.hash(adapter.buildSweepContextV1(c,options(p))));});
test('missing context fails safe without changing native source identity',function(){var x=adapter.buildSweepContextV1(candidate('MISSING','SWING_HIGH',50),{});assert.equal(x.contextApplicability,'UNRESOLVED');assert.equal(x.sourceCategory,'SWING_DERIVED');assert.equal(x.liquidity.sourceId,'MISSING');assert.equal(x.swingContext,null);});
test('unknown source type fails safe',function(){var x=adapter.buildSweepContextV1(candidate('X','NOT_A_SOURCE',50),{});assert.equal(x.contextApplicability,'UNRESOLVED');assert.equal(x.unresolvedReason,'UNSUPPORTED_LIQUIDITY_SOURCE_TYPE');});
test('lifecycle and structural role remain separately named dimensions',function(){var p=makeProjector(),x=adapter.buildSweepContextV1(candidate('H','SWING_HIGH',50),options(p));assert.equal(x.liquidity.lifecycle.stateAtEvaluation,'SWEPT');assert.equal(x.swingContext.structural.currentRole,'ACTIVE_PROTECTED');});
