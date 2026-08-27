'use strict';
var assert = require('assert');
var projector = require('../audit/swingStateProjectorV1');
var design = require('../scripts/swingMultiDimensionalStateModelDesignV1');

function base() {
    return {
        identity: { canonicalSwingId:'S1',symbol:'BTCUSDT',timeframe:'5m',side:'SWING_HIGH',price:100,occurredAt:0,confirmedAt:10 },
        formation: { availableAt:10,immutableAfterConfirmation:true,prominenceATR:1 },
        topology: { status:'FORMATION_SNAPSHOT',availableAt:10,updatedAt:10,formationSnapshot:{sameSideCountWithin0_5ATR:0},eqMemberships:[] },
        liquidityRoles: { availableAt:10,updatedAt:10,atConfirmation:[{role:'BSL'}],assignments:[] },
        context: { availableAt:10,atConfirmation:{nearestHigherOrderType:null} }
    };
}
function e(id,type,at,sequence,payload){return{id:id,type:type,swingId:'S1',availableAt:at,sequence:sequence||0,payload:payload||{}};}

(function confirmedAtAvailability() {
    assert.equal(projector.getSwingFormationState(base(),9).status,'NOT_CONFIRMED');
    var at10=projector.getSwingFormationState(base(),10);
    assert.equal(at10.status,'CONFIRMED');
    assert.equal(at10.reaction,undefined);
})();

(function futureLeakRejectionAndPastStateImmutability() {
    var events=[e('r','REACTION_STARTED',20,20,{reactionLegId:'L1'}),e('m','STRUCTURAL_MSS_ATTRIBUTED',30,100,{sourceReactionLegId:'L1',reference:{swingId:'R'},mss:{id:'M1'}})];
    var early=projector.projectSwingState(base(),events,10),prefix=projector.projectSwingState(base(),[],10);
    assert.deepStrictEqual(early,prefix);
    assert.equal(early.reaction.status,'NOT_STARTED');
    assert.equal(early.structuralImpact.status,'NONE');
})();

(function reactionTerminationAndNewDeliveryIsolation() {
    var events=[e('r1','REACTION_STARTED',20,20,{reactionLegId:'L1'}),e('r2','REACTION_TERMINATED',30,90,{endReason:'RETURN_TO_SWING'}),e('window','REACTION_WINDOW_OBSERVED',40,40,{horizonBars:5,observation:{reactionATR:2}})];
    var state=projector.projectSwingState(base(),events,50);
    assert.equal(state.reaction.status,'TERMINATED');
    assert.equal(state.reaction.fixedWindowObservations['5'].reactionATR,2);
})();

(function attributedMssProvenance() {
    var payload={sourceSwingId:'S1',sourceReactionLegId:'L1',reference:{swingId:'REF',price:95,confirmedAt:5},mss:{id:'MSS1',confirmedAt:30}};
    var state=projector.projectSwingState(base(),[e('m','STRUCTURAL_MSS_ATTRIBUTED',30,100,payload)],30);
    assert.equal(state.structuralImpact.status,'STRUCTURAL_MSS_CONFIRMED');
    assert.equal(state.structuralImpact.reference.swingId,'REF');
    assert.equal(state.structuralImpact.attributionReactionLegId,'L1');
})();

(function displacementRequiresAndPreservesSourceProvenance() {
    var events=[e('m','STRUCTURAL_MSS_ATTRIBUTED',30,100,{sourceReactionLegId:'L1',reference:{swingId:'REF'},mss:{id:'MSS1'}}),e('d','DISPLACEMENT_ATTRIBUTED',31,110,{displacementId:'D1',sourceMssId:'MSS1',sourceReactionLegId:'L1',sourceSwingId:'S1'})];
    var state=projector.projectSwingState(base(),events,31);
    assert.equal(state.structuralImpact.status,'SAME_DELIVERY_DISPLACEMENT_CONFIRMED');
    assert.equal(state.structuralImpact.displacement.sourceMssId,'MSS1');
})();

(function lifecycleTemporalProjectionIsMonotonic() {
    var events=[e('t','LIQUIDITY_TOUCHED',20,200,{}),e('s','LIQUIDITY_SWEPT',30,200,{}),e('b','LIQUIDITY_BROKEN',40,200,{})];
    assert.equal(projector.projectSwingState(base(),events,25).lifecycle.status,'TOUCHED');
    assert.equal(projector.projectSwingState(base(),events,35).lifecycle.status,'SWEPT');
    assert.equal(projector.projectSwingState(base(),events,45).lifecycle.status,'BROKEN');
    assert.equal(projector.projectSwingState(base(),events,45).formation.prominenceATR,1);
})();

(function lifecycleRegressionThrows() {
    var events=[e('b','LIQUIDITY_BROKEN',20,200,{}),e('t','LIQUIDITY_TOUCHED',30,200,{})];
    assert.throws(function(){projector.projectSwingState(base(),events,40);},/Lifecycle regression/);
})();

(function eqMembershipIsRegistryOwnedAndTimeLocal() {
    var eq=e('eq','EQ_MEMBERSHIP_ASSIGNED',30,5,{eqObjectId:'EQH:1',eqRole:'EQH_MEMBER',sourceOfTruth:'EQH_EQL_REGISTRY'});
    assert.equal(projector.projectSwingState(base(),[eq],20).topology.eqMemberships.length,0);
    var state=projector.projectSwingState(base(),[eq],30);
    assert.equal(state.topology.eqMemberships[0].eqObjectId,'EQH:1');
    assert.equal(state.liquidityRoles.assignments[0].sourceOfTruth,'EQH_EQL_REGISTRY');
})();

(function incrementalEqualsFullReplay() {
    var events=[e('r','REACTION_STARTED',20,20,{reactionLegId:'L1'}),e('t','LIQUIDITY_TOUCHED',25,200,{})];
    assert.deepStrictEqual(projector.projectSwingState(base(),events,30),projector.projectIncrementally(base(),events,30));
})();

(function schemaHasNoScoreAndExamplesPreserveFormation() {
    var schema=JSON.stringify(design.schema());
    assert.equal(/significanceScore|overallScore/.test(schema),false);
    var examples=design.syntheticExamples();
    assert.equal(examples.length,5);
    examples.forEach(function(ex){var confirmed=ex.timeline.filter(function(x){return x.state.status==='CONFIRMED';});if(confirmed.length>1){var first=confirmed[0].state.formation,last=confirmed[confirmed.length-1].state.formation;assert.deepStrictEqual(first,last);}});
})();

console.log('Swing Multi-Dimensional State Model Design V1 tests passed');
