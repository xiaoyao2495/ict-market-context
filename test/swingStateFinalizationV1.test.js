'use strict';

var assert = require('assert');
var projector = require('../audit/swingStateProjectorV1');
var policyContract = require('../audit/reactionBoundaryPolicyV1');
var B = policyContract.POLICY_ID.RETURN_TO_SWING_ORIGIN;
var C = policyContract.POLICY_ID.OPPOSITE_STRUCTURAL_RESET;

function policy(id) { return policyContract.getReactionBoundaryPolicy(id, 'v1'); }
function policyValue(id) { return policy(id).reactionBoundaryPolicy; }
function base() {
    return {
        identity: { canonicalSwingId:'S1', symbol:'BTCUSDT', timeframe:'5m', side:'SWING_HIGH', price:100, occurredAt:0, confirmedAt:10 },
        formation: { availableAt:10, immutableAfterConfirmation:true, prominenceATR:1, pivotGeometry:{ leftBars:2, rightBars:2 } },
        topology: { status:'FORMATION_SNAPSHOT', availableAt:10, updatedAt:10, formationSnapshot:{ sameSideCountWithin0_5ATR:0 }, eqMemberships:[] },
        liquidityRoles: { availableAt:10, updatedAt:10, atConfirmation:[{role:'BSL'}], assignments:[] },
        context: { availableAt:10, atConfirmation:{ nearestHigherOrderType:null } }
    };
}
function event(id,type,at,sequence,payload){return{id:id,type:type,swingId:'S1',availableAt:at,sequence:sequence||0,payload:payload||{}};}
function reaction(id) {
    var p=policyValue(id);
    return [
        event('r1','REACTION_OBSERVATION_STARTED',20,10,{reactionLegId:'L1',reactionBoundaryPolicy:p,parameterDependent:false}),
        event('r2','REACTION_STARTED',21,20,{reactionLegId:'L1',reactionBoundaryPolicy:p}),
        event('r3','REACTION_EVIDENCE_UPDATED',22,30,{reactionLegId:'L1',reactionBoundaryPolicy:p,frontier:95,evidence:{mfeATR:1}}),
        event('r4','REACTION_TERMINATED',29,90,{reactionLegId:'L1',reactionBoundaryPolicy:p,endReason:id})
    ];
}
function structural(id) {
    var p=policyValue(id);
    return [
        event('m','STRUCTURAL_MSS_ATTRIBUTED',25,100,{sourceSwingId:'S1',sourceReactionLegId:'L1',reactionBoundaryPolicy:p,reference:{swingId:'REF',price:95,confirmedAt:9},mss:{id:'M1',confirmedAt:25}}),
        event('d','DISPLACEMENT_ATTRIBUTED',26,110,{sourceSwingId:'S1',sourceReactionLegId:'L1',reactionBoundaryPolicy:p,sourceMssId:'M1',displacementId:'D1'}),
        event('f','FOLLOW_THROUGH_UPDATED',28,123,{sourceSwingId:'S1',sourceReactionLegId:'L1',reactionBoundaryPolicy:p,sourceMssId:'M1',sourceDisplacementId:'D1',horizonBars:3})
    ];
}

(function baseSwingProjection() {
    var state=projector.projectSwingState(base(),[],10,policy(B));
    assert.equal(state.status,'CONFIRMED');
    assert.equal(state.projectionPolicyIdentity,B+':v1');
})();

(function formationImmutable() {
    var initial=projector.projectSwingState(base(),[],10,policy(B));
    var later=projector.projectSwingState(base(),reaction(B).concat(structural(B)),40,policy(B));
    assert.deepStrictEqual(later.formation,initial.formation);
})();

(function eqMembershipAppearsOnlyWhenAvailable() {
    var eq=event('eq','EQ_MEMBERSHIP_ASSIGNED',30,5,{eqObjectId:'EQH:1',eqRole:'EQH_MEMBER',sourceOfTruth:'EQ_TEMPORAL_EVENT_STREAM'});
    assert.equal(projector.projectSwingState(base(),[eq],29,policy(B)).topology.eqMemberships.length,0);
    assert.equal(projector.projectSwingState(base(),[eq],30,policy(B)).topology.eqMemberships.length,1);
})();

(function lifecycleTransitionIsTemporalSafe() {
    var swept=event('life','LIQUIDITY_SWEPT',30,200,{sourceLiquidityId:'S1'});
    assert.equal(projector.projectSwingState(base(),[swept],29,policy(B)).lifecycle.status,'ACTIVE');
    assert.equal(projector.projectSwingState(base(),[swept],30,policy(B)).lifecycle.status,'SWEPT');
})();

(function reactionBProvenance() {
    var state=projector.projectSwingState(base(),reaction(B),40,policy(B));
    assert.equal(state.reaction.policy.policyId,B);
    assert.equal(state.reaction.policy.policyVersion,'v1');
    assert.ok(state.reaction.policy.terminationSemantic);
})();

(function reactionCProvenance() {
    assert.equal(projector.projectSwingState(base(),reaction(C),40,policy(C)).reaction.policy.policyId,C);
})();

(function structuralImpactBProvenance() {
    var state=projector.projectSwingState(base(),reaction(B).concat(structural(B)),40,policy(B));
    assert.equal(state.structuralImpact.reactionBoundaryPolicy.policyId,B);
    assert.equal(state.structuralImpact.sourceReactionLegId,'L1');
    assert.equal(state.structuralImpact.reference.swingId,'REF');
    assert.equal(state.structuralImpact.mss.id,'M1');
    assert.equal(state.structuralImpact.displacement.displacementId,'D1');
})();

(function structuralImpactCProvenance() {
    assert.equal(projector.projectSwingState(base(),reaction(C).concat(structural(C)),40,policy(C)).structuralImpact.reactionBoundaryPolicy.policyId,C);
})();

(function bAndCCannotMix() {
    assert.throws(function(){projector.projectSwingState(base(),reaction(B).concat(structural(C)),40,policy(B));},function(error){return error.code==='REACTION_BOUNDARY_POLICY_MISMATCH';});
})();

(function noProductionPolicyFallback() {
    assert.strictEqual(policyContract.getProductionReactionBoundaryPolicy(),null);
    assert.throws(policyContract.requireProductionReactionBoundaryPolicy,function(error){return error.code==='NO_PRODUCTION_REACTION_BOUNDARY_POLICY_SELECTED';});
})();

(function futureMssCannotAffectPastState() {
    var events=reaction(B).concat(structural(B));
    assert.equal(projector.projectSwingState(base(),events,24,policy(B)).structuralImpact.mss,null);
})();

(function futureDisplacementCannotAffectPastState() {
    var state=projector.projectSwingState(base(),reaction(B).concat(structural(B)),25,policy(B));
    assert.equal(state.structuralImpact.mss.id,'M1');
    assert.equal(state.structuralImpact.displacement,null);
})();

(function futureLifecycleCannotAffectPastState() {
    var broken=event('broken','LIQUIDITY_BROKEN',50,200,{});
    assert.equal(projector.projectSwingState(base(),[broken],49,policy(B)).lifecycle.status,'ACTIVE');
})();

(function incrementalEqualsFullReplay() {
    var events=reaction(B).concat(structural(B));
    var at22=projector.projectSwingState(base(),events,22,policy(B));
    var incremental=projector.advanceSwingState(at22,events,40,policy(B));
    var full=projector.projectSwingState(base(),events,40,policy(B));
    assert.deepStrictEqual(incremental,full);
})();

(function historicalSnapshotIsImmutable() {
    var events=reaction(B).concat(structural(B));
    var past=projector.projectSwingState(base(),events,22,policy(B));
    var hash=projector.stateHash(past);
    projector.advanceSwingState(past,events,40,policy(B));
    assert.equal(projector.stateHash(past),hash);
})();

(function deterministicEventOrdering() {
    var p=policyValue(B),a=event('a','REACTION_STARTED',20,20,{reactionLegId:'L1',reactionBoundaryPolicy:p}),z=event('z','REACTION_OBSERVATION_STARTED',20,10,{reactionLegId:'L1',reactionBoundaryPolicy:p});
    assert.deepStrictEqual(projector.projectSwingState(base(),[a,z],20,policy(B)),projector.projectSwingState(base(),[z,a],20,policy(B)));
})();

(function deterministicSerializationAndHash() {
    var state=projector.projectSwingState(base(),reaction(B),40,policy(B));
    assert.equal(projector.stable(state),projector.stable(JSON.parse(JSON.stringify(state))));
    assert.equal(projector.stateHash(state),projector.stateHash(state));
})();

(function missingProvenanceRejected() {
    var unsafe=reaction(B);delete unsafe[0].payload.reactionBoundaryPolicy;
    assert.throws(function(){projector.projectSwingState(base(),unsafe,40,policy(B));},function(error){return error.code==='MISSING_REACTION_BOUNDARY_POLICY_PROVENANCE';});
})();

(function unknownPolicyRejected() {
    assert.throws(function(){projector.projectSwingState(base(),[],40,{policyId:B,policyVersion:'v2'});},function(error){return error.code==='UNKNOWN_REACTION_BOUNDARY_POLICY_VERSION';});
})();

(function allSevenSectionsPresent() {
    var state=projector.projectSwingState(base(),[],10,policy(C));
    ['formation','topology','liquidityRoles','context','reaction','structuralImpact','lifecycle'].forEach(function(section){assert.ok(state[section]);});
    assert.equal(/significanceScore|overallScore|qualityScore|importanceScore/.test(JSON.stringify(state)),false);
})();

console.log('SwingState Finalization V1 targeted tests passed (20/20)');
