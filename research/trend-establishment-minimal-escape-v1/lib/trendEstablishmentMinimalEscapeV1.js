'use strict';
var escape=require('../../v3-establishment-structural-escape-audit-v1/lib/structuralEscapeV1');
function clean(p){return p?{type:p.type,price:p.price,occurredAt:p.occurredAt,confirmedAt:p.confirmedAt}:null;}
function stableValue(v){if(Array.isArray(v))return v.map(stableValue);if(v&&typeof v==='object'){var o={};Object.keys(v).sort().forEach(k=>{o[k]=stableValue(v[k]);});return o;}return Object.is(v,-0)?0:v;}
function stableJson(v){return JSON.stringify(stableValue(v),null,2)+'\n';}
function candidate(highProgression,lowProgression){if(highProgression==='UP'&&lowProgression==='UP')return'BULLISH';if(highProgression==='DOWN'&&lowProgression==='DOWN')return'BEARISH';return null;}
function build(payload,allPivots){
 var pivots=payload.structurePivots.map(clean),facts=escape.escapeFacts({transitionId:payload.transitionId||'PACKET',evaluationTime:payload.evaluationTime,direction:payload.candidateDirection,atr14:payload.atr14,currentClose:payload.currentClose,previousHigh:clean(payload.previousHigh),currentHigh:clean(payload.currentHigh),previousLow:clean(payload.previousLow),currentLow:clean(payload.currentLow),candidatePivots:pivots,allPivots:allPivots.map(clean)}),context={available:facts.status==='OK',contextHigh:null,contextLow:null,signedMidpointShiftAtr:null,envelopeOverlapIoU:null,closeEscapeAtr:null};
 if(facts.status==='OK'){context.contextHigh=clean(facts.contextHigh);context.contextLow=clean(facts.contextLow);context.signedMidpointShiftAtr=facts.signedMidpointShiftAtr;context.envelopeOverlapIoU=facts.envelopeOverlapIoU;context.closeEscapeAtr=facts.closeEscapeAtr;}
 return stableValue({evaluationTime:payload.evaluationTime,candidateDirection:payload.candidateDirection,currentClose:payload.currentClose,atr14:payload.atr14,localStructure:{latestTwoHighs:[clean(payload.previousHigh),clean(payload.currentHigh)],latestTwoLows:[clean(payload.previousLow),clean(payload.currentLow)],highDelta:payload.highDelta,highDeltaAtr:payload.highDeltaAtr,highProgression:payload.highProgression,lowDelta:payload.lowDelta,lowDeltaAtr:payload.lowDeltaAtr,lowProgression:payload.lowProgression,structurePivots:pivots,structureLegs:payload.structureLegs},precedingStructuralContext:context});
}
module.exports={candidate,build,stableValue,stableJson};
