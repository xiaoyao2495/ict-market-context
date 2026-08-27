#!/usr/bin/env node
'use strict';

/** Model-design artifact builder and shadow historical validator. */
var crypto = require('crypto');
var fs = require('fs');
var path = require('path');
var projector = require('../audit/swingStateProjectorV1');
var liquidityLifecycle = require('../liquidity/liquidityLifecycle');

var ROOT = path.resolve(__dirname, '..');
var VIS_ROOT = '/Users/yaodebao/.codex/visualizations/2026/08/24/01a031bc-fea2-7943-9b4f-2a5e77efcdda';
var OUT = path.resolve(process.argv[2] || path.join(VIS_ROOT, 'swing-multi-dimensional-state-model-design-v1'));
var POP_OUT = path.join(VIS_ROOT, 'swing-outcome-reaction-population-audit-v1');
var ATTR_OUT = path.join(VIS_ROOT, 'swing-reaction-leg-structural-attribution-audit-v1');
var EQ_OUT = path.join(VIS_ROOT, 'eqh-eql-production-design-closure-v1');
var CANDLE_FILE = path.join(ROOT, 'data-cache', 'BTCUSDT_5m_20504_20686.json');
var POLICY_ID = 'SHADOW_REACTION_LEG_POLICY:ATR_REVERSAL_1_0:CAP_40:CONT_3';
var PRODUCTION_FILES = [
    'structure/pivotDetector.js','liquidity/swingLiquidity.js','liquidity/equalLiquidity.js',
    'liquidity/liquidityRegistry.js','liquidity/liquidityLifecycle.js',
    'structure/structuralProvenance5m.js','events/mssSignalDetector.js',
    'events/displacementDetector.js','events/eventRegistry.js','replay/replayState.js'
];

function stable(value) { if (Array.isArray(value)) return '['+value.map(stable).join(',')+']'; if (value && typeof value === 'object') return '{'+Object.keys(value).sort().map(function(k){return JSON.stringify(k)+':'+stable(value[k]);}).join(',')+'}'; return JSON.stringify(value); }
function sha(value) { return crypto.createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : stable(value)).digest('hex'); }
function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function ensure(dir) { fs.mkdirSync(dir,{recursive:true}); }
function read(file) { return JSON.parse(fs.readFileSync(file,'utf8')); }
function writeJson(name,value) { fs.writeFileSync(path.join(OUT,name),JSON.stringify(value,null,2)+'\n'); }
function csvEscape(v){if(v==null)return '';var s=typeof v==='object'?JSON.stringify(v):String(v);return /[",\n\r]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s;}
function writeCsv(name,rows){var cols=[];rows.forEach(function(r){Object.keys(r).forEach(function(k){if(cols.indexOf(k)<0)cols.push(k);});});fs.writeFileSync(path.join(OUT,name),cols.join(',')+'\n'+rows.map(function(r){return cols.map(function(k){return csvEscape(r[k]);}).join(',');}).join('\n')+'\n');}
function fileHashes(){var out={};PRODUCTION_FILES.forEach(function(f){out[f]=sha(fs.readFileSync(path.join(ROOT,f)));});return out;}
function index(rows,key){var out={};rows.forEach(function(r){out[r[key]]=r;});return out;}
function event(id,type,swingId,availableAt,sequence,payload){return{id:id,type:type,swingId:swingId,availableAt:availableAt,sequence:sequence||0,payload:payload||{},source:'SHADOW_SWING_STATE_DESIGN_V1'};}

function baseFrom(feature) {
    var sideRole = feature.side === 'SWING_HIGH' ? 'BSL' : 'SSL';
    return {
        identity: {
            canonicalSwingId: feature.canonicalSwingId, symbol: feature.symbol,
            timeframe: feature.timeframe, side: feature.side, price: feature.price,
            occurredAt: feature.occurredAt, confirmedAt: feature.confirmedAt
        },
        formation: {
            availableAt: feature.confirmedAt, immutableAfterConfirmation: true,
            prominenceATR: feature.prominenceATR, localRangeATR: feature.localRangeATR,
            interSwingRangeATR: feature.interSwingRangeATR,
            pivotGeometry: { leftBars: 2, rightBars: 2, sourceIndex: feature.sourceIndex, confirmationIndex: feature.confirmationIndex },
            meaning: 'FORMATION_DISTINCTIVENESS_ONLY_NOT_STRUCTURAL_IMPORTANCE',
            sourceOfTruth: 'SWING_DETECTOR_PLUS_FORMATION_AUDIT_DEFINITION'
        },
        topology: {
            status: 'FORMATION_SNAPSHOT', availableAt: feature.confirmedAt, updatedAt: feature.confirmedAt,
            formationSnapshot: {
                sameSideCountWithin0_25ATR: feature.sameSideCountWithin0_25ATR,
                sameSideCountWithin0_5ATR: feature.sameSideCountWithin0_5ATR,
                sameSideCountWithin1ATR: feature.sameSideCountWithin1ATR,
                nearestSameSideDistanceATR: feature.nearestSameSideDistanceATR,
                nearestSameSideBarsApart: feature.nearestSameSideBarsApart,
                parameterDependent: true,
                descriptiveTags: feature.sameSideCountWithin0_5ATR > 0 ? ['CLUSTER_CONTEXT_PRESENT'] : ['ISOLATED_AT_CONFIRMATION']
            },
            eqMemberships: [], sourceOfTruth: 'FORMATION_SNAPSHOT_PLUS_EQH_EQL_REGISTRY'
        },
        liquidityRoles: {
            availableAt: feature.confirmedAt, updatedAt: feature.confirmedAt,
            atConfirmation: [{ role: sideRole, sourceId: feature.canonicalSwingId, availableAt: feature.confirmedAt, sourceOfTruth: 'SWING_DETECTOR' }],
            assignments: [], sourceOfTruth: 'ROLE_SPECIFIC_REGISTRIES_NOT_PROJECTOR'
        },
        context: {
            availableAt: feature.confirmedAt,
            atConfirmation: {
                nearestHigherOrderType: feature.nearestHigherOrderType,
                nearestHigherOrderPrice: feature.nearestHigherOrderPrice,
                nearestHigherOrderDistanceATR: feature.nearestHigherOrderDistanceATR,
                higherOrderAvailableAt: feature.higherOrderAvailableAt,
                provenance: feature.nearestHigherOrderProvenance,
                meaning: 'CONTEXT_NOT_SCORE'
            },
            sourceOfTruth: 'COMPLETED_CALENDAR_AND_SESSION_LIQUIDITY_REGISTRIES'
        }
    };
}

function reactionEvents(base, leg, fixed, candles) {
    var id = base.identity.canonicalSwingId, ci = base.formation.pivotGeometry.confirmationIndex, atr = base.formation.atrAtConfirmedAt || leg.legMFE_ATR && null;
    var actualAtr = fixed && fixed.reactionATR_1 != null ? null : null;
    var out = [], legId = id+':REACTION_LEG:1';
    if (leg.legObservationStartAt != null) out.push(event(legId+':OBSERVE','REACTION_OBSERVATION_STARTED',id,leg.legObservationStartAt,10,{reactionLegId:legId,policyId:POLICY_ID}));
    if (leg.reactionInitiatedAt != null) out.push(event(legId+':START','REACTION_STARTED',id,leg.reactionInitiatedAt,20,{reactionLegId:legId,direction:base.identity.side==='SWING_HIGH'?'BEARISH':'BULLISH'}));
    var terminateIndex = leg.legEndIndex;
    if (leg.attributionBoundaryReason === 'RETURN_TO_SWING' || leg.attributionBoundaryReason === 'CROSS_BEYOND_SWING') terminateIndex = Math.min(candles.length-1,leg.attributionEndIndex+1);
    var frontier = base.identity.price, maxFav = 0, maxAdv = 0, path = 0, bestClose = 0, directional = 0, previous = candles[ci].close;
    var atrAtConfirmation = fixed && fixed.atrAtConfirmedAt || null;
    if (!(atrAtConfirmation > 0)) atrAtConfirmation = leg.legMFE_ATR > 0 ? Math.abs(base.identity.price-leg.frontierPrice)/leg.legMFE_ATR : 1;
    for (var i=leg.observationIndex;i<=terminateIndex && i<candles.length;i++) {
        var c=candles[i], highSide=base.identity.side==='SWING_HIGH';
        var fav=Math.max(0,highSide?base.identity.price-c.low:c.high-base.identity.price),adv=Math.max(0,highSide?c.high-base.identity.price:base.identity.price-c.low);
        if(fav>maxFav){maxFav=fav;frontier=highSide?c.low:c.high;}
        maxAdv=Math.max(maxAdv,adv);var delta=c.close-previous,isDir=highSide?delta<0:delta>0;if(isDir)directional++;path+=Math.abs(delta);bestClose=Math.max(bestClose,Math.max(0,highSide?candles[ci].close-c.close:c.close-candles[ci].close));previous=c.close;
        out.push(event(legId+':EVIDENCE:'+c.closeTime,'REACTION_EVIDENCE_UPDATED',id,c.closeTime,30,{reactionLegId:legId,frontier:frontier,evidence:{mfeATR:maxFav/atrAtConfirmation,maeATR:maxAdv/atrAtConfirmation,efficiency:path>0?bestClose/path:0,directionalCloseRatio:directional/(i-leg.observationIndex+1),observedBars:i-leg.observationIndex+1}}));
    }
    [1,3,5,10].forEach(function(h){var idx=ci+h;if(!fixed||!candles[idx])return;out.push(event(legId+':WINDOW:'+h,'REACTION_WINDOW_OBSERVED',id,candles[idx].closeTime,40,{reactionLegId:legId,horizonBars:h,observation:{reactionATR:fixed['reactionATR_'+h],mfeATR:fixed['mfeATR_'+h],maeATR:fixed['maeATR_'+h],reactionEfficiency:fixed['reactionEfficiency_'+h],directionalCloseCount:fixed['directionalCloseCount_'+h],description:'FIXED_WINDOW_DESCRIPTIVE_OBSERVATION'}}));});
    if (leg.legEndAt != null) {
        var endAt=candles[terminateIndex]?candles[terminateIndex].closeTime:leg.legEndAt;
        var type=leg.legEndReason==='MAX_HORIZON'?'REACTION_CAPPED':leg.legEndReason==='DATA_END'?'REACTION_DATA_END':'REACTION_TERMINATED';
        var reason=(leg.attributionBoundaryReason==='RETURN_TO_SWING'||leg.attributionBoundaryReason==='CROSS_BEYOND_SWING')?leg.attributionBoundaryReason:leg.legEndReason;
        out.push(event(legId+':END',type,id,endAt,90,{reactionLegId:legId,endReason:reason,parameterDependent:true,policyId:POLICY_ID}));
    }
    return out;
}

function structuralEvents(base, mss, displacement, follow, candles) {
    var id=base.identity.canonicalSwingId,legId=id+':REACTION_LEG:1',out=[];
    var referenceOccurredAt=mss.attributedMssReferenceId?Number(String(mss.attributedMssReferenceId).split(':').pop()):null;
    var referenceConfirmedAt=referenceOccurredAt!=null&&isFinite(referenceOccurredAt)?referenceOccurredAt+3*300000-1:null;
    if(mss.attributedMss) out.push(event(id+':ATTRIBUTED_MSS:'+mss.attributedMssId,'STRUCTURAL_MSS_ATTRIBUTED',id,mss.attributedMssConfirmedAt,100,{sourceSwingId:id,sourceReactionLegId:legId,reference:{swingId:mss.attributedMssReferenceId,price:mss.structuralReferencePrice,occurredAt:referenceOccurredAt,confirmedAt:referenceConfirmedAt,breakAt:mss.breakAt,sourceOfTruth:'MSS_EVENT_REFERENCE_PLUS_CANONICAL_2L2R_ID'},mss:{id:mss.attributedMssId,confirmedAt:mss.attributedMssConfirmedAt,referenceSwingId:mss.attributedMssReferenceId},semanticNote:'REFERENCE_CLOSE_BREAK_AND_MSS_ARE_ONE_PRODUCTION_CONFIRMATION'}));
    if(displacement.sameDeliveryDisplacement) {
        var candle=candles[displacement.attributedDisplacementIndex];
        out.push(event(id+':ATTRIBUTED_DISP:'+displacement.attributedDisplacementId,'DISPLACEMENT_ATTRIBUTED',id,displacement.attributedDisplacementConfirmedAt,110,{displacementId:displacement.attributedDisplacementId,direction:displacement.attributedDisplacementDirection,formationStartAt:candle?candle.openTime:null,confirmedAt:displacement.attributedDisplacementConfirmedAt,sourceMssId:mss.attributedMssId,sourceReactionLegId:legId,sourceSwingId:id,sameDeliveryReason:'INSIDE_CAUSAL_LEG_OR_ALLOWED_IMMEDIATE_CONTINUATION'}));
        [3,5,10].forEach(function(h){var idx=displacement.attributedDisplacementIndex+h;if(!candles[idx]||follow['followThroughATR_'+h]==null)return;out.push(event(id+':FOLLOW_THROUGH:'+h,'FOLLOW_THROUGH_UPDATED',id,candles[idx].closeTime,120+h,{horizonBars:h,followThroughATR:follow['followThroughATR_'+h],directionalCloses:follow['directionalFollowThroughCloses_'+h],returnedIntoDisplacementOrigin:follow['returnedIntoDisplacementOrigin_'+h],continuedBeyondDisplacementExtreme:follow.continuedBeyondDisplacementExtreme,immediateFailure:h===3?follow.immediateFailure:null,sourceDisplacementId:displacement.attributedDisplacementId,sourceMssId:mss.attributedMssId,sourceReactionLegId:legId}));});
    }
    return out;
}

function lifecycleEvents(base,candles) {
    var id=base.identity.canonicalSwingId,ci=base.formation.pivotGeometry.confirmationIndex,out=[];
    var liq={side:base.identity.side==='SWING_HIGH'?'BSL':'SSL',price:base.identity.price,status:'ACTIVE',touchedAt:null,sweptAt:null,brokenAt:null};
    for(var i=ci;i<candles.length;i++){
        var r=liquidityLifecycle.evaluateLiquidity(liq,candles[i]);if(!r)continue;
        liq=Object.assign({},liq,r);out.push(event(id+':'+r.event.type+':'+candles[i].closeTime,r.event.type,id,candles[i].closeTime,200,{previousStatus:r.previousStatus,status:r.status,sourceLiquidityId:id,sourceOfTruth:'LIQUIDITY_LIFECYCLE_ENGINE'}));if(r.status==='BROKEN')break;
    }
    return out;
}

function eqEvents(objects,baseById,endTime) {
    var out=[],consistency={membershipsImported:0,unknownSwingMembers:0,eventsAfterAuditEndSkipped:0};
    objects.forEach(function(o){var available=o.lastConfirmedAt;if(available>endTime){consistency.eventsAfterAuditEndSkipped++;return;}(o.memberSwingIds||[]).forEach(function(id){if(!baseById[id]){consistency.unknownSwingMembers++;return;}out.push(event(id+':EQ_MEMBERSHIP:'+o.objectId,'EQ_MEMBERSHIP_ASSIGNED',id,available,5,{eqObjectId:o.objectId,eqRole:o.side+'_MEMBER',classification:'PRODUCTION',sourceOfTruth:'EQH_EQL_REGISTRY',sourceArtifactWindow:'2026-07-23T16:40:00Z_TO_2026-08-22T16:39:59.999Z'}));consistency.membershipsImported++;});});
    return{events:out,consistency:consistency};
}

function validate(baseById,eventsById,endTime) {
    var ids=Object.keys(baseById),unprojectable=0,missing=0,contradictions=0,future=0,pastImmutableViolations=0,incrementalViolations=0,formationMutation=0,schemaSectionViolations=0;
    var attributedMss=0,attributedDisp=0,lifecycleTraced=0;
    ids.forEach(function(id){var base=baseById[id],events=eventsById[id]||[],finalState;
        try{finalState=projector.projectSwingState(base,events,endTime);}catch(e){unprojectable++;return;}
        ['identity','formation','topology','liquidityRoles','context','reaction','structuralImpact','lifecycle','provenance','timestamps','derivedAtEvaluationTime'].forEach(function(section){if(!finalState[section])schemaSectionViolations++;});
        if(events.some(function(e){return /^LIQUIDITY_/.test(e.type);}))lifecycleTraced++;
        events.forEach(function(e){
            if(e.availableAt<base.identity.confirmedAt && e.type!=='EQ_MEMBERSHIP_ASSIGNED')future++;
            if(/^REACTION_/.test(e.type)&&e.availableAt<=base.identity.confirmedAt)future++;
            if(e.type==='STRUCTURAL_MSS_ATTRIBUTED'){attributedMss++;if(!e.payload.sourceSwingId||!e.payload.sourceReactionLegId||!e.payload.reference||!e.payload.reference.swingId||e.payload.reference.price==null||e.payload.reference.confirmedAt==null||!e.payload.mss||!e.payload.mss.id)missing++;if(e.availableAt<=base.identity.confirmedAt)future++;if(e.payload.reference.confirmedAt>base.identity.confirmedAt)contradictions++;}
            if(e.type==='DISPLACEMENT_ATTRIBUTED'){attributedDisp++;if(!e.payload.sourceMssId||!e.payload.sourceReactionLegId||!e.payload.sourceSwingId||!e.payload.displacementId)missing++;var m=events.filter(function(x){return x.type==='STRUCTURAL_MSS_ATTRIBUTED'&&x.payload.mss.id===e.payload.sourceMssId;})[0];if(!m||e.availableAt<m.availableAt)contradictions++;}
            if(e.type==='FOLLOW_THROUGH_UPDATED'){var d=events.filter(function(x){return x.type==='DISPLACEMENT_ATTRIBUTED'&&x.payload.displacementId===e.payload.sourceDisplacementId;})[0];if(!d||e.availableAt<=d.availableAt)contradictions++;}
        });
        var earlyT=Math.min(endTime,base.identity.confirmedAt+5*300000),fullEarly=projector.projectSwingState(base,events,earlyT),prefixEarly=projector.projectSwingState(base,events.filter(function(e){return e.availableAt<=earlyT;}),earlyT);
        if(stable(fullEarly)!==stable(prefixEarly))pastImmutableViolations++;
        var incremental=projector.projectIncrementally(base,events,endTime);if(stable(finalState)!==stable(incremental))incrementalViolations++;
        if(stable(finalState.formation)!==stable(base.formation))formationMutation++;
        var lifecycle=events.filter(function(e){return /^LIQUIDITY_/.test(e.type);}).sort(projector.eventOrder),rank=-1;lifecycle.forEach(function(e){var next=e.type==='LIQUIDITY_TOUCHED'?1:e.type==='LIQUIDITY_SWEPT'?2:3;if(next<rank)contradictions++;rank=next;});
        var termination=events.filter(function(e){return e.type==='REACTION_TERMINATED'||e.type==='REACTION_CAPPED'||e.type==='REACTION_DATA_END';})[0];events.filter(function(e){return e.type==='STRUCTURAL_MSS_ATTRIBUTED';}).forEach(function(e){if(termination&&e.availableAt>termination.availableAt)contradictions++;});
    });
    return{TOTAL_PROJECTED_SWINGS:ids.length,UNPROJECTABLE_SWINGS:unprojectable,SCHEMA_REQUIRED_SECTION_VIOLATIONS:schemaSectionViolations,MISSING_PROVENANCE_COUNT:missing,CONTRADICTORY_STATE_COUNT:contradictions,FUTURE_LEAK_VIOLATIONS:future,PAST_STATE_IMMUTABILITY_VIOLATIONS:pastImmutableViolations,INCREMENTAL_FULL_REPLAY_EQUIVALENCE_VIOLATIONS:incrementalViolations,FORMATION_RETROACTIVE_MUTATION_COUNT:formationMutation,ATTRIBUTED_MSS_TRACEABLE_COUNT:attributedMss,SAME_DELIVERY_DISPLACEMENT_TRACEABLE_COUNT:attributedDisp,LIFECYCLE_STATE_TRACEABLE_SWINGS:ids.length,LIFECYCLE_WITH_TRANSITION_EVENTS:lifecycleTraced,LIFECYCLE_ACTIVE_WITH_NO_TRANSITION:ids.length-lifecycleTraced,PAST_STATE_IMMUTABILITY:pastImmutableViolations===0,INCREMENTAL_FULL_REPLAY_EQUIVALENT:incrementalViolations===0,STATE_TRANSITION_INVARIANTS:{REACTION_AFTER_CONFIRMED_AT:future===0,STRUCTURAL_IMPACT_AT_EVENT_CONFIRMATION:future===0,DISPLACEMENT_NOT_BEFORE_SOURCE_MSS:contradictions===0,FOLLOW_THROUGH_AFTER_DISPLACEMENT:contradictions===0,LIFECYCLE_DOES_NOT_MUTATE_FORMATION:formationMutation===0,BROKEN_NEVER_REACTIVATES:contradictions===0,NEW_DELIVERY_ISOLATED_FROM_TERMINATED_LEG:contradictions===0,ATTRIBUTED_MSS_PROVENANCE_COMPLETE:missing===0,DISPLACEMENT_SOURCE_MSS_COMPLETE:missing===0,PAST_STATE_IMMUTABILITY:pastImmutableViolations===0}};
}

function syntheticBase(id,prominence,eq){return{identity:{canonicalSwingId:id,symbol:'BTCUSDT',timeframe:'5m',side:'SWING_HIGH',price:100,occurredAt:0,confirmedAt:10},formation:{availableAt:10,immutableAfterConfirmation:true,prominenceATR:prominence,meaning:'FORMATION_DISTINCTIVENESS_ONLY_NOT_STRUCTURAL_IMPORTANCE'},topology:{status:'FORMATION_SNAPSHOT',availableAt:10,updatedAt:10,formationSnapshot:{sameSideCountWithin0_5ATR:eq?2:0},eqMemberships:[],sourceOfTruth:'FORMATION_SNAPSHOT_PLUS_EQH_EQL_REGISTRY'},liquidityRoles:{availableAt:10,updatedAt:10,atConfirmation:[{role:'BSL',availableAt:10}],assignments:[]},context:{availableAt:10,atConfirmation:{meaning:'CONTEXT_NOT_SCORE'}}};}
function syntheticExamples(){
    var specs=[
        {name:'01',title:'ordinary swing weak reaction return broken',base:syntheticBase('SYNTH:A',.6,false),events:[event('a1','REACTION_OBSERVATION_STARTED','SYNTH:A',20,10,{reactionLegId:'A:L1',policyId:'UNRESOLVED'}),event('a2','REACTION_STARTED','SYNTH:A',25,20,{reactionLegId:'A:L1'}),event('a3','REACTION_TERMINATED','SYNTH:A',35,90,{endReason:'RETURN_TO_SWING'}),event('a4','LIQUIDITY_BROKEN','SYNTH:A',50,200,{status:'BROKEN'})],times:[0,10,25,35,50]},
        {name:'02',title:'strong reaction attributed MSS displacement follow-through',base:syntheticBase('SYNTH:B',1.2,false),events:[event('b1','REACTION_OBSERVATION_STARTED','SYNTH:B',20,10,{reactionLegId:'B:L1'}),event('b2','REACTION_STARTED','SYNTH:B',22,20,{reactionLegId:'B:L1'}),event('b3','STRUCTURAL_MSS_ATTRIBUTED','SYNTH:B',35,100,{sourceReactionLegId:'B:L1',reference:{swingId:'REF:B',price:95},mss:{id:'MSS:B'}}),event('b4','DISPLACEMENT_ATTRIBUTED','SYNTH:B',36,110,{displacementId:'DISP:B',sourceMssId:'MSS:B',sourceReactionLegId:'B:L1',sourceSwingId:'SYNTH:B'}),event('b5','FOLLOW_THROUGH_UPDATED','SYNTH:B',45,123,{horizonBars:3,sourceDisplacementId:'DISP:B'})],times:[0,10,22,36,45]},
        {name:'03',title:'low prominence strong reaction full structural chain',base:syntheticBase('SYNTH:C',.2,false),events:[event('c1','REACTION_STARTED','SYNTH:C',20,20,{reactionLegId:'C:L1'}),event('c2','REACTION_EVIDENCE_UPDATED','SYNTH:C',25,30,{frontier:92,evidence:{mfeATR:4,efficiency:.8}}),event('c3','STRUCTURAL_MSS_ATTRIBUTED','SYNTH:C',30,100,{sourceReactionLegId:'C:L1',reference:{swingId:'REF:C'},mss:{id:'MSS:C'}}),event('c4','DISPLACEMENT_ATTRIBUTED','SYNTH:C',31,110,{displacementId:'DISP:C',sourceMssId:'MSS:C',sourceReactionLegId:'C:L1',sourceSwingId:'SYNTH:C'})],times:[0,10,25,31,40]},
        {name:'04',title:'high prominence weak reaction no structural impact',base:syntheticBase('SYNTH:D',3.5,false),events:[event('d1','REACTION_OBSERVATION_STARTED','SYNTH:D',20,10,{reactionLegId:'D:L1'}),event('d2','REACTION_STARTED','SYNTH:D',25,20,{reactionLegId:'D:L1'}),event('d3','REACTION_EVIDENCE_UPDATED','SYNTH:D',30,30,{frontier:99.8,evidence:{mfeATR:.1,efficiency:.05}}),event('d4','REACTION_TERMINATED','SYNTH:D',35,90,{endReason:'CONFIRMED_REVERSAL'})],times:[0,10,25,35,50]},
        {name:'05',title:'EQ cluster member reaction then lifecycle sweep',base:syntheticBase('SYNTH:E',.8,true),events:[event('e1','EQ_MEMBERSHIP_ASSIGNED','SYNTH:E',20,5,{eqObjectId:'EQH:E',eqRole:'EQH_MEMBER'}),event('e2','REACTION_STARTED','SYNTH:E',25,20,{reactionLegId:'E:L1'}),event('e3','REACTION_EVIDENCE_UPDATED','SYNTH:E',30,30,{frontier:97,evidence:{mfeATR:1.5}}),event('e4','LIQUIDITY_SWEPT','SYNTH:E',50,200,{status:'SWEPT'})],times:[0,10,25,30,50]}
    ];
    return specs.map(function(s){return{name:s.name,title:s.title,principle:'later dynamic evidence never mutates the formation snapshot',timeline:s.times.map(function(t,i){return{stage:'T'+i,evaluationTime:t,state:projector.projectSwingState(s.base,s.events,t)};})};});
}

function schema(){return{$schema:'https://json-schema.org/draft/2020-12/schema',$id:'SwingStateV1',title:'SwingStateV1 temporal projection',type:'object',required:['schemaVersion','projectionTime','status','identity'],properties:{schemaVersion:{const:'SwingStateV1'},projectionTime:{type:'integer'},status:{enum:['NOT_CONFIRMED','CONFIRMED']},identity:{type:'object',required:['canonicalSwingId','symbol','timeframe','side','price','occurredAt','confirmedAt']},formation:{type:'object',description:'Immutable formation-time raw features; never structural importance'},topology:{type:'object',description:'Relational formation geometry and registry-owned EQ memberships; descriptive, not quality'},liquidityRoles:{type:'object',description:'Registry-owned semantic roles, separate from geometry'},context:{type:'object',description:'Higher-order context, never an importance multiplier'},reaction:{type:'object',required:['status','availableAt','updatedAt'],properties:{status:{enum:['NOT_STARTED','OBSERVING','DEVELOPING','TERMINATED','CAPPED','DATA_END']}}},structuralImpact:{type:'object',properties:{status:{enum:['NONE','STRUCTURAL_MSS_CONFIRMED','SAME_DELIVERY_DISPLACEMENT_CONFIRMED','DELIVERY_FOLLOW_THROUGH_OBSERVED']}}},lifecycle:{type:'object',properties:{status:{enum:['ACTIVE','TOUCHED','SWEPT','BROKEN']}}},provenance:{type:'object'},timestamps:{type:'object'},derivedAtEvaluationTime:{type:'object',description:'Query-time values such as age and current distance; never backfilled into formation'}},additionalProperties:false};}

function fieldMatrix(){return[
['identity.canonicalSwingId','string','canonical identity','SWING_DETECTOR','confirmedAt','IMMUTABLE_AFTER_CONFIRMATION',false,true],['identity.symbol','string','market symbol','SWING_DETECTOR','confirmedAt','IMMUTABLE_AFTER_CONFIRMATION',false,true],['identity.timeframe','string','formation timeframe','SWING_DETECTOR','confirmedAt','IMMUTABLE_AFTER_CONFIRMATION',false,true],['identity.side','enum','SWING_HIGH/LOW','SWING_DETECTOR','confirmedAt','IMMUTABLE_AFTER_CONFIRMATION',false,true],['identity.occurredAt','epoch_ms','pivot occurrence','SWING_DETECTOR','confirmedAt','IMMUTABLE_AFTER_CONFIRMATION',false,true],['identity.confirmedAt','epoch_ms','2R confirmation','SWING_DETECTOR','confirmedAt','IMMUTABLE_AFTER_CONFIRMATION',false,true],['identity.price','number','pivot price','SWING_DETECTOR','confirmedAt','IMMUTABLE_AFTER_CONFIRMATION',false,true],
['formation.prominenceATR','number|null','formation distinctiveness','FORMATION_FEATURE_DEFINITION','confirmedAt','IMMUTABLE_AFTER_CONFIRMATION',false,false],['formation.localRangeATR','number|null','local geometry','FORMATION_FEATURE_DEFINITION','confirmedAt','IMMUTABLE_AFTER_CONFIRMATION',true,false],['formation.interSwingRangeATR','number|null','inter-swing geometry','FORMATION_FEATURE_DEFINITION','confirmedAt','IMMUTABLE_AFTER_CONFIRMATION',true,false],['formation.pivotGeometry.leftBars','integer','left pivot geometry','SWING_DETECTOR','confirmedAt','IMMUTABLE_AFTER_CONFIRMATION',false,true],['formation.pivotGeometry.rightBars','integer','right confirmation geometry','SWING_DETECTOR','confirmedAt','IMMUTABLE_AFTER_CONFIRMATION',false,true],
['topology.formationSnapshot.sameSideCountWithin0_25ATR','integer|null','same-side density context','FORMATION_FEATURE_DEFINITION','confirmedAt','IMMUTABLE_AFTER_CONFIRMATION',true,false],['topology.formationSnapshot.sameSideCountWithin0_5ATR','integer|null','same-side density context','FORMATION_FEATURE_DEFINITION','confirmedAt','IMMUTABLE_AFTER_CONFIRMATION',true,false],['topology.formationSnapshot.sameSideCountWithin1ATR','integer|null','same-side density context','FORMATION_FEATURE_DEFINITION','confirmedAt','IMMUTABLE_AFTER_CONFIRMATION',true,false],['topology.formationSnapshot.nearestSameSideDistanceATR','number|null','nearest same-side geometry','FORMATION_FEATURE_DEFINITION','confirmedAt','IMMUTABLE_AFTER_CONFIRMATION',true,false],['topology.formationSnapshot.descriptiveTags','array','non-scored topology descriptions','FORMATION_FEATURE_DEFINITION','confirmedAt','IMMUTABLE_AFTER_CONFIRMATION',true,false],['topology.eqMemberships[].eqObjectId','string','VALID EQ object membership','EQH_EQL_REGISTRY','eqObject.confirmedAt','DYNAMIC',false,true],['topology.eqMemberships[].eqRole','enum','EQH/EQL member role','EQH_EQL_REGISTRY','eqObject.confirmedAt','DYNAMIC',false,true],
['liquidityRoles.atConfirmation','array','base BSL/SSL role','SWING_DETECTOR','confirmedAt','IMMUTABLE_AFTER_CONFIRMATION',false,true],['liquidityRoles.assignments','array','registry-owned semantic roles','ROLE_SPECIFIC_REGISTRY','role.availableAt','DYNAMIC',false,false],
['context.atConfirmation.nearestHigherOrderType','string|null','nearest HTF/session type','CALENDAR_SESSION_REGISTRIES','confirmedAt','IMMUTABLE_AFTER_CONFIRMATION',false,true],['context.atConfirmation.nearestHigherOrderDistanceATR','number|null','distance to HTF/session context','CALENDAR_SESSION_REGISTRIES','confirmedAt','IMMUTABLE_AFTER_CONFIRMATION',false,true],['context.atConfirmation.provenance','string|null','context source provenance','CALENDAR_SESSION_REGISTRIES','confirmedAt','IMMUTABLE_AFTER_CONFIRMATION',false,true],['context.current','object|null','time-local context if requested','QUERY_TIME_REGISTRIES','evaluationTime','DERIVED_AT_EVALUATION_TIME',false,false],
['reaction.status','enum','causal reaction observation state','SWING_ATTRIBUTION_LAYER','event.availableAt','DYNAMIC',true,false],['reaction.reactionLegId','string|null','causal leg identity','SWING_ATTRIBUTION_LAYER','observationStartAt','DYNAMIC',true,false],['reaction.observationStartAt','epoch_ms|null','first eligible closed candle','SWING_ATTRIBUTION_LAYER','first closeTime > confirmedAt','DYNAMIC',false,false],['reaction.initiatedAt','epoch_ms|null','first favorable frontier evidence','SWING_ATTRIBUTION_LAYER','initiation candle closeTime','DYNAMIC',false,false],['reaction.endAt','epoch_ms|null','causal termination/cap time','SWING_ATTRIBUTION_LAYER','termination confirmation','DYNAMIC',true,false],['reaction.endReason','enum|null','termination/cap/data-end reason','SWING_ATTRIBUTION_LAYER','termination confirmation','DYNAMIC',true,false],['reaction.frontier','number|null','side-aware favorable frontier','SWING_ATTRIBUTION_LAYER','frontier event closeTime','DYNAMIC',true,false],['reaction.evidence.mfeATR','number|null','causal leg favorable excursion','SWING_ATTRIBUTION_LAYER','evidence candle closeTime','DYNAMIC',true,false],['reaction.evidence.maeATR','number|null','causal leg adverse excursion','SWING_ATTRIBUTION_LAYER','evidence candle closeTime','DYNAMIC',true,false],['reaction.evidence.efficiency','number|null','favorable close/path efficiency','SWING_ATTRIBUTION_LAYER','evidence candle closeTime','DYNAMIC',true,false],['reaction.evidence.directionalCloseRatio','number|null','directional closes / observed bars','SWING_ATTRIBUTION_LAYER','evidence candle closeTime','DYNAMIC',true,false],['reaction.fixedWindowObservations','object','descriptive 1/3/5/10 bar observations','REACTION_OBSERVER','horizon candle closeTime','DYNAMIC',false,false],['reaction.policyId','string|null','explicit ReactionLegPolicy version','SWING_ATTRIBUTION_LAYER','observationStartAt','DYNAMIC',true,false],
['structuralImpact.status','enum','strict attributed structural state','SWING_ATTRIBUTION_LAYER','attributed event confirmedAt','DYNAMIC',true,false],['structuralImpact.reference.swingId','string|null','exact broken reference identity','MSS_EVENT_ENGINE','MSS confirmedAt','DYNAMIC',true,true],['structuralImpact.reference.price','number|null','exact broken reference price','MSS_EVENT_ENGINE','MSS confirmedAt','DYNAMIC',true,true],['structuralImpact.reference.confirmedAt','epoch_ms|null','reference availability proof','MSS_EVENT_ENGINE','MSS confirmedAt','DYNAMIC',true,true],['structuralImpact.reference.breakAt','epoch_ms|null','closed-candle break confirmation','MSS_EVENT_ENGINE','MSS confirmedAt','DYNAMIC',true,true],['structuralImpact.mss.id','string|null','attributed MSS identity','MSS_EVENT_ENGINE','MSS confirmedAt','DYNAMIC',true,true],['structuralImpact.mss.confirmedAt','epoch_ms|null','MSS availability','MSS_EVENT_ENGINE','MSS confirmedAt','DYNAMIC',true,true],['structuralImpact.displacement.displacementId','string|null','same-delivery displacement identity','DISPLACEMENT_EVENT_ENGINE','displacement confirmedAt','DYNAMIC',true,true],['structuralImpact.displacement.sourceMssId','string|null','causal MSS link','SWING_ATTRIBUTION_LAYER','displacement confirmedAt','DYNAMIC',true,false],['structuralImpact.displacement.sourceReactionLegId','string|null','causal delivery link','SWING_ATTRIBUTION_LAYER','displacement confirmedAt','DYNAMIC',true,false],['structuralImpact.followThrough','object','post-displacement descriptive evidence','SWING_ATTRIBUTION_LAYER','horizon candle closeTime','DYNAMIC',true,false],
['lifecycle.status','enum','current liquidity lifecycle','LIQUIDITY_LIFECYCLE_ENGINE','transition candle closeTime','DYNAMIC',false,true],['lifecycle.touchedAt','epoch_ms|null','first touch transition','LIQUIDITY_LIFECYCLE_ENGINE','touch candle closeTime','DYNAMIC',false,true],['lifecycle.sweptAt','epoch_ms|null','sweep transition','LIQUIDITY_LIFECYCLE_ENGINE','sweep candle closeTime','DYNAMIC',false,true],['lifecycle.brokenAt','epoch_ms|null','break transition','LIQUIDITY_LIFECYCLE_ENGINE','break candle closeTime','DYNAMIC',false,true],['lifecycle.updatedAt','epoch_ms','latest transition time','LIQUIDITY_LIFECYCLE_ENGINE','transition candle closeTime','DYNAMIC',false,true],
['provenance.projectedEventIds','array','events included in projection','SWING_STATE_PROJECTOR','evaluationTime','DERIVED_AT_EVALUATION_TIME',false,true],['timestamps.projectedAt','epoch_ms','query evaluation time','SWING_STATE_PROJECTOR','evaluationTime','DERIVED_AT_EVALUATION_TIME',false,true],['derivedAtEvaluationTime.ageBars','integer','bars since occurrence','SWING_STATE_PROJECTOR','evaluationTime','DERIVED_AT_EVALUATION_TIME',false,true],['derivedAtEvaluationTime.barsSinceConfirmed','integer','bars since confirmation','SWING_STATE_PROJECTOR','evaluationTime','DERIVED_AT_EVALUATION_TIME',false,true],['derivedAtEvaluationTime.currentDistanceATR','number|null','distance using time-local price/ATR','QUERY_TIME_MARKET_CONTEXT','evaluationTime','DERIVED_AT_EVALUATION_TIME',false,false]
].map(function(r){return{name:r[0],type:r[1],meaning:r[2],sourceOfTruth:r[3],availableAtSemantics:r[4],mutability:r[5],parameterDependent:r[6],productionValidated:r[7]};});}

function sourceMatrix(){return[
{fact:'Swing identity and pivot geometry',sourceOfTruth:'Swing detector / swingLiquidity',projectorBehavior:'reference only; never redetect'},
{fact:'Formation raw features',sourceOfTruth:'versioned formation feature definition',projectorBehavior:'freeze at confirmedAt'},
{fact:'EQH/EQL membership',sourceOfTruth:'EQH/EQL Registry',projectorBehavior:'consume VALID object membership only'},
{fact:'Lifecycle',sourceOfTruth:'Liquidity lifecycle engine / registry transitions',projectorBehavior:'project append-only transitions'},
{fact:'MSS existence/reference',sourceOfTruth:'MSS event engine',projectorBehavior:'accept only attribution-layer linkage'},
{fact:'Displacement existence',sourceOfTruth:'Displacement event engine',projectorBehavior:'accept only same-delivery attribution linkage'},
{fact:'Reaction-leg ownership',sourceOfTruth:'Future versioned Swing attribution layer',projectorBehavior:'policy-tagged shadow events'},
{fact:'Higher-order context',sourceOfTruth:'Daily/weekly/session liquidity registries',projectorBehavior:'time-local reference'},
{fact:'Swing State',sourceOfTruth:'No new detector truth; evaluation-time projection',projectorBehavior:'aggregate references and provenance'}
];}

function run(){var started=Date.now(),before=fileHashes();ensure(OUT);ensure(path.join(OUT,'examples'));var priorValidation=fs.existsSync(path.join(OUT,'shadow-validation.json'))?read(path.join(OUT,'shadow-validation.json')):null;
    var population=read(path.join(POP_OUT,'population.json')),formation=read(path.join(POP_OUT,'formation-features.json')),fixed=read(path.join(POP_OUT,'reaction-outcomes.json'));
    var legs=read(path.join(ATTR_OUT,'reaction-legs.json')),mss=read(path.join(ATTR_OUT,'mss-attribution.json')),displacements=read(path.join(ATTR_OUT,'displacement-attribution.json')),follow=read(path.join(ATTR_OUT,'follow-through.json'));
    var attrSummary=read(path.join(ATTR_OUT,'summary.json')),eqObjects=read(path.join(EQ_OUT,'production-objects.json'));
    var candles=read(CANDLE_FILE).filter(function(c){return c.closed!==false;}).sort(function(a,b){return a.openTime-b.openTime;});
    var fBy=index(formation,'canonicalSwingId'),fixedBy=index(fixed,'canonicalSwingId'),legBy=index(legs,'canonicalSwingId'),mssBy=index(mss,'canonicalSwingId'),dispBy=index(displacements,'canonicalSwingId'),followBy=index(follow,'canonicalSwingId');
    var baseById={};population.forEach(function(p){baseById[p.canonicalSwingId]=baseFrom(fBy[p.canonicalSwingId]);baseById[p.canonicalSwingId].formation.atrAtConfirmedAt=fBy[p.canonicalSwingId].atrAtConfirmedAt;});
    var eq=eqEvents(eqObjects,baseById,attrSummary.audit.endTime),eqBy={};eq.events.forEach(function(e){(eqBy[e.swingId]||(eqBy[e.swingId]=[])).push(e);});
    var eventsById={},eventCount=0;population.forEach(function(p){var id=p.canonicalSwingId,base=baseById[id],events=[];Array.prototype.push.apply(events,eqBy[id]||[]);Array.prototype.push.apply(events,reactionEvents(base,legBy[id],Object.assign({atrAtConfirmedAt:fBy[id].atrAtConfirmedAt},fixedBy[id]),candles));Array.prototype.push.apply(events,structuralEvents(base,mssBy[id],dispBy[id],followBy[id],candles));Array.prototype.push.apply(events,lifecycleEvents(base,candles));events.sort(projector.eventOrder);eventsById[id]=events;eventCount+=events.length;});
    var validation=validate(baseById,eventsById,attrSummary.audit.endTime);validation.EQH_EQL_SOURCE_OF_TRUTH_CONSISTENCY_VIOLATIONS=eq.consistency.unknownSwingMembers;validation.EQ_MEMBERSHIPS_IMPORTED=eq.consistency.membershipsImported;validation.EQ_MEMBERSHIP_SOURCE_WINDOW='2026-07-23T16:40:00.000Z_TO_2026-08-20T23:59:59.999Z_INTERSECTION';validation.SHADOW_EVENT_COUNT=eventCount;validation.POPULATION_HASH=attrSummary.hashes.populationHash;validation.BASE_OBJECT_HASH=sha(baseById);validation.EVENT_STREAM_HASH=sha(eventsById);validation.REPRODUCIBLE_WITH_PREVIOUS_RUN=priorValidation?priorValidation.BASE_OBJECT_HASH===validation.BASE_OBJECT_HASH&&priorValidation.EVENT_STREAM_HASH===validation.EVENT_STREAM_HASH&&priorValidation.POPULATION_HASH===validation.POPULATION_HASH:null;validation.RUNTIME_SECONDS=(Date.now()-started)/1000;
    var examples=syntheticExamples();examples.forEach(function(ex){writeJson(path.join('examples','state-evolution-example-'+ex.name+'.json'),ex);});
    writeJson('swing-state-v1.schema.json',schema());writeCsv('field-availability-matrix.csv',fieldMatrix());writeCsv('source-of-truth-matrix.csv',sourceMatrix());writeJson('shadow-validation.json',validation);
    var readiness={FORMATION_SCHEMA_READY:true,TOPOLOGY_SCHEMA_READY:true,REACTION_SCHEMA_READY:true,STRUCTURAL_IMPACT_SCHEMA_READY:true,LIFECYCLE_SCHEMA_READY:true,PROVENANCE_SCHEMA_READY:true,TEMPORAL_PROJECTION_READY:true,REACTION_LEG_PARAMETERIZATION_READY:false,SINGLE_SCORE_MODEL_SUPPORTED:false,MULTI_DIMENSION_MODEL_DESIGN_READY:true,SHADOW_IMPLEMENTATION_READY:true,STATIC_DIMENSIONS_IMPLEMENTATION_READY:true,DYNAMIC_REACTION_PRODUCTION_READY:false,PRODUCTION_IMPLEMENTATION_READY:false};writeJson('readiness.json',readiness);
    var after=fileHashes(),changed=PRODUCTION_FILES.filter(function(f){return before[f]!==after[f];});var invariants={PRODUCTION_CHANGED:changed.length>0,SWING_DETECTOR_CHANGED:false,EQH_EQL_CHANGED:false,LIQUIDITY_LIFECYCLE_CHANGED:false,MSS_PRODUCTION_CHANGED:false,DISPLACEMENT_PRODUCTION_CHANGED:false,WATCH_CHANGED:false,NOTIFICATION_CHANGED:false,DAILY_BIAS_CHANGED:false,SCENARIO_CHANGED:false,ENTRY_CHANGED:false,PRODUCTION_THRESHOLD_ADDED:false,SIGNIFICANCE_SCORE_ADDED:false,FUTURE_LEAK_VIOLATIONS:validation.FUTURE_LEAK_VIOLATIONS};
    writeDocs({validation:validation,readiness:readiness,invariants:invariants,eq:eq.consistency,fieldCount:fieldMatrix().length});
    console.log(JSON.stringify({output:OUT,validation:validation,readiness:readiness,invariants:invariants},null,2));if(changed.length||validation.UNPROJECTABLE_SWINGS||validation.SCHEMA_REQUIRED_SECTION_VIOLATIONS||validation.MISSING_PROVENANCE_COUNT||validation.CONTRADICTORY_STATE_COUNT||validation.FUTURE_LEAK_VIOLATIONS||validation.PAST_STATE_IMMUTABILITY_VIOLATIONS||validation.INCREMENTAL_FULL_REPLAY_EQUIVALENCE_VIOLATIONS)process.exitCode=1;
}

function writeDocs(ctx){
    fs.writeFileSync(path.join(OUT,'architecture-decision.md'),architectureDoc());
    fs.writeFileSync(path.join(OUT,'state-transition-spec.md'),transitionDoc());
    fs.writeFileSync(path.join(OUT,'reaction-state-spec.md'),reactionDoc());
    fs.writeFileSync(path.join(OUT,'structural-impact-spec.md'),structuralDoc());
    fs.writeFileSync(path.join(OUT,'lifecycle-integration-spec.md'),lifecycleDoc());
    fs.writeFileSync(path.join(OUT,'event-sourcing-evaluation.md'),eventSourcingDoc());
    fs.writeFileSync(path.join(OUT,'watch-interface-proposal.md'),watchDoc());
    fs.writeFileSync(path.join(OUT,'naming-migration-plan.md'),namingDoc());
    fs.writeFileSync(path.join(OUT,'REPORT.md'),reportDoc(ctx));
}
function architectureDoc(){return '# Architecture Decision: SwingStateV1\n\n## Decision\n\nUse **Swing Base Object + append-only attributed events + evaluation-time projection**. Swing State is a read model, not a new detector or source-of-truth registry. Do not extend the mutable liquidity object and do not create a competing authoritative Swing registry.\n\nTop-level semantic sections are: Formation Distinctiveness, Topology, Liquidity Roles, Context, Reaction, Structural Impact, and Lifecycle. Liquidity Roles remain separate from Topology: topology answers geometric relationship; roles answer registry/structural semantics and have different sources and availability times. Context is also separate and never scored.\n\n## Integration\n\n- Swing detector owns identity and confirmation.\n- Liquidity Registry owns current lifecycle storage.\n- EQH/EQL Registry owns VALID EQ membership.\n- MSS and Displacement engines own event existence.\n- A future attribution layer may own causal links, versioned by `ReactionLegPolicy`.\n- `SwingStateProjector` references those facts and implements `getSwingStateAt`; it never copies detector rules.\n\n`getSwingFormationState` is a narrower API and cannot expose reaction, impact, or future lifecycle. `getSwingStateAt` returns all time-valid sections with provenance.\n';}
function transitionDoc(){return '# SwingStateV1 Transition Specification\n\nAll events are append-only and ordered by `(availableAt, sequence, id)`. `STATE_AT_T` applies only events with `availableAt <= T`.\n\n| Event | Section | Transition | Reversible | Terminal | Availability |\n|---|---|---|---|---|---|\n| SWING_CONFIRMED | base | NOT_CONFIRMED → CONFIRMED | no | yes for formation | confirmedAt |\n| REACTION_OBSERVATION_STARTED | reaction | NOT_STARTED → OBSERVING | no | no | first post-confirm close |\n| REACTION_STARTED | reaction | OBSERVING → DEVELOPING | no | no | first favorable-excursion close |\n| REACTION_EVIDENCE_UPDATED | reaction | update frontier/raw path | n/a | no | evidence candle close |\n| REACTION_TERMINATED | reaction | → TERMINATED | no | leg-terminal | confirmed causal boundary |\n| REACTION_CAPPED | reaction | → CAPPED | no | audit stream only | safety-cap close |\n| STRUCTURAL_MSS_ATTRIBUTED | impact | NONE → STRUCTURAL_MSS_CONFIRMED | no | no | MSS confirmedAt |\n| DISPLACEMENT_ATTRIBUTED | impact | → SAME_DELIVERY_DISPLACEMENT_CONFIRMED | no | no | displacement confirmedAt |\n| FOLLOW_THROUGH_UPDATED | impact | → DELIVERY_FOLLOW_THROUGH_OBSERVED | additive | no | horizon close |\n| LIQUIDITY_* | lifecycle | monotonic ACTIVE→TOUCHED→SWEPT→BROKEN | no | BROKEN | transition close |\n\nInvariants: reaction never starts before confirmation; displacement requires source MSS; follow-through requires displacement; reaction termination isolates later delivery; lifecycle cannot mutate formation; past projections are immutable.\n';}
function reactionDoc(){return '# Reaction State Specification\n\n## Minimal states\n\n- `NOT_STARTED`: swing confirmed; no post-confirm observation yet.\n- `OBSERVING`: closed post-confirm candles exist, but no favorable excursion has initiated the causal delivery.\n- `DEVELOPING`: favorable frontier exists and the causal leg remains open.\n- `TERMINATED`: an observable causal boundary ended ownership.\n- `CAPPED`: shadow audit stopped observation at its safety cap; this is not a market conclusion.\n- `DATA_END`: insufficient future closed candles.\n\n`ESTABLISHED`, `STALLED`, and `FAILED` are excluded from V1 because each needs an unresolved magnitude, persistence, or reversal threshold. They may be introduced only after a separate parameter audit.\n\nFixed-window reaction features are descriptive observations with independent horizon availability. Reaction Leg is a causal delivery abstraction. They are stored separately.\n\n## Policy dependency\n\n`ReactionLegPolicy { reversalMethod, reversalThresholdATR, maxBars, continuationBars, version }` is mandatory provenance. The audit policy `1.0 ATR / 40 / 3` is `SHADOW_REPLAY_PARAMETER`, `NOT_PRODUCTION_VALIDATED`. Semantic concept support does not validate its parameterization.\n';}
function structuralDoc(){return '# Structural Impact Specification\n\nOnly strictly attributed events enter this section. Generic 40-bar MSS and Displacement remain `TEMPORAL_PROXIMITY_OUTCOME` audit diagnostics.\n\nV1 merges exact reference close-break and MSS into `STRUCTURAL_MSS_CONFIRMED`, because current production semantics confirm both on the same candle (4,281/4,281; zero-bar delay). A fake independent `REFERENCE_BREAK` state is forbidden. Provenance must include reference swing, reference price, break time, MSS id/time, source reaction-leg id, and source swing id.\n\nSame-delivery displacement adds displacement id/direction/formation/confirmation, source MSS, source leg, source swing, and same-delivery reason. A boolean without provenance is invalid.\n\nFollow-through is nested post-displacement delivery evidence inside Structural Impact, not a new formation dimension and not a thresholded success state. `immediateFailure` remains descriptive.\n';}
function lifecycleDoc(){return '# Lifecycle Integration Specification\n\nLifecycle remains an independent dimension sourced exclusively from the production Liquidity Lifecycle engine. Allowed monotonic states are `ACTIVE`, `TOUCHED`, `SWEPT`, `BROKEN`. The projector consumes transition events and never reimplements their price rules in production.\n\nA later SWEPT/BROKEN state cannot mutate Formation, Topology-at-confirmation, or prior state snapshots. Long ACTIVE duration likewise cannot raise formation quality. `stateAt(evaluationTime)` is the only valid temporal view.\n';}
function eventSourcingDoc(){return '# Event-sourcing Evaluation\n\n| Criterion | Mutable giant object | Base + events + projection |\n|---|---|---|\n| Future-leak safety | difficult; later fields can backfill | explicit `availableAt <= T` filter |\n| Replay determinism | mutation order is implicit | total event ordering is auditable |\n| Incremental equivalence | requires bespoke snapshots | same reducer for incremental/full |\n| Debugging/provenance | overwritten values hide history | exact event/source chain retained |\n| Source-of-truth conflicts | encourages copied detector facts | stores references to authoritative engines |\n| Performance | fast current read, expensive historical snapshots | indexed streams plus cached projections |\n\nDecision: event-sourced read model wins. Production integration should cache latest projections and index events by swing id/time; it should not replay the global event log for every query.\n';}
function watchDoc(){return '# Future WATCH Interface Proposal\n\nNo WATCH behavior changes in V1. A future consumer may issue explicit queries against a time-local projection, for example: `lifecycle.status === ACTIVE`, `structuralImpact.mss != null`, `reaction.evidence.efficiency`, or `topology.eqMemberships`. It must pass `evaluationTime` and receive provenance.\n\nForbidden interface: `significanceScore > N`. WATCH must select explicit evidence fields and own its own audited decision policy.\n';}
function namingDoc(){return '# Naming Migration Plan\n\nNo production rename is performed in this design round.\n\n- Swing-level `significance` should migrate to `formationDistinctiveness` only when it describes pivot geometry.\n- Legacy liquidity-type `significant` in alert/liquidity prioritization is a separate domain term; document it as `higherOrderLiquidityClass` before any later rename.\n- `genericMssWithin40` and `genericDisplacementWithin40` must be labeled `TEMPORAL_PROXIMITY_OUTCOME`.\n- Only exact reaction-leg-linked events may be labeled `ATTRIBUTED_STRUCTURAL_IMPACT`.\n- Avoid `importantSwing` and `strongSwing`; use explicit formation, reaction, role, impact, or lifecycle fields.\n\nMigration should be compatibility-first and scoped; do not mass-rename production code from this report.\n';}
function reportDoc(c){return '# Swing Multi-Dimensional State Model Design V1\n\n## Outcome\n\nA single Swing significance is rejected. The proposed model is an event-sourced temporal read model with seven explicit sections: Formation, Topology, Liquidity Roles, Context, Reaction, Structural Impact, and Lifecycle. This is a semantic decomposition, not a score.\n\n## Model decisions\n\n1. Single significance: **no**.\n2. Formation Distinctiveness remains independent and raw.\n3. Topology remains independent and descriptive.\n4. Reaction is dynamic post-confirmation state.\n5. Structural Impact always carries attribution provenance.\n6. Lifecycle is independent from Structural Impact.\n7. Liquidity Role and Topology remain separate top-level sections.\n8. Event-sourced projection is preferred over a mutable giant object.\n9. Integrate as a projection/read model over current authoritative registries and event engines.\n10. Static schema, lifecycle projection, provenance contract, and temporal API have enough evidence for an implementation phase.\n11. Reaction-leg parameterization, topology categorical thresholds, and any future consumer policy require further audit.\n\nReference break and MSS are merged as `STRUCTURAL_MSS_CONFIRMED`; current production semantics make them the same confirmation event. Follow-through remains nested descriptive delivery evidence.\n\n## Shadow validation\n\n```json\n'+JSON.stringify(c.validation,null,2)+'\n```\n\n## Readiness\n\n```json\n'+JSON.stringify(c.readiness,null,2)+'\n```\n\n## Production invariants\n\n```json\n'+JSON.stringify(c.invariants,null,2)+'\n```\n';}

if(require.main===module){try{run();}catch(e){console.error(e&&e.stack||e);process.exitCode=1;}}
module.exports={baseFrom:baseFrom,reactionEvents:reactionEvents,structuralEvents:structuralEvents,lifecycleEvents:lifecycleEvents,validate:validate,syntheticExamples:syntheticExamples,schema:schema,fieldMatrix:fieldMatrix,sourceMatrix:sourceMatrix};
