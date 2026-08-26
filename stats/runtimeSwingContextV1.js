'use strict';

/**
 * Read-only runtime source for SwingContextV1.
 *
 * It reuses the production 2L/2R detector and Swing builder. It does not write
 * to structural state or the liquidity registry. MTF identity uses the frozen,
 * validated rule: same side + exact extremum price inside the HTF source candle.
 */
var pivotDetector = require('../structure/pivotDetector');
var swingLiquidity = require('../liquidity/swingLiquidity');

var TIMEFRAMES = ['5m', '15m', '1h', '4h'];
var INTERVALS = { '15m': 900000, '1h': 3600000, '4h': 14400000 };

function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function canonicalCandles(rows) {
    var byOpen={};(rows||[]).forEach(function(c){if(c&&c.closed!==false&&Number.isFinite(c.openTime))byOpen[c.openTime]=c;});
    return Object.keys(byOpen).map(function(k){return byOpen[k];}).sort(function(a,b){return a.openTime-b.openTime;});
}
function aggregate15m(rows) {
    var groups={},interval=INTERVALS['15m'];canonicalCandles(rows).forEach(function(c){var t=Math.floor(c.openTime/interval)*interval;(groups[t]||(groups[t]=[])).push(c);});
    return Object.keys(groups).map(Number).sort(function(a,b){return a-b;}).map(function(t){var g=groups[t].sort(function(a,b){return a.openTime-b.openTime;});if(g.length!==3||g[0].openTime!==t||g[2].closeTime!==t+interval-1)return null;return{openTime:t,closeTime:t+interval-1,open:g[0].open,high:Math.max.apply(Math,g.map(function(c){return c.high;})),low:Math.min.apply(Math,g.map(function(c){return c.low;})),close:g[2].close,volume:g.reduce(function(n,c){return n+Number(c.volume||0);},0),closed:true,source:'aggregate-5m'};}).filter(Boolean);
}
function detect(symbol,timeframe,rows){var cs=canonicalCandles(rows),p=pivotDetector.detectPivots(cs,{left:2,right:2});return swingLiquidity.buildSwingLiquidity(symbol,timeframe,p,cs,2);}
function sideOf(s){return s.type==='SWING_HIGH'?'HIGH':'LOW';}
function buildMembership(symbol,fiveRows,structureCandles) {
    var five=detect(symbol,'5m',fiveRows),byId={};
    five.forEach(function(s){byId[s.id]={canonicalSwingId:s.id,side:sideOf(s),price:s.price,occurredAt:s.sourceOpenTime,confirmedAt:s.confirmedAt,timeframeMembership:{'5m':{member:true,htfSwingId:s.id,occurredAt:s.sourceOpenTime,confirmedAt:s.confirmedAt},'15m':{member:false},'1h':{member:false},'4h':{member:false}}};});
    var sources={'15m':aggregate15m(fiveRows),'1h':canonicalCandles(structureCandles&&structureCandles['1h']),'4h':canonicalCandles(structureCandles&&structureCandles['4h'])};
    ['15m','1h','4h'].forEach(function(tf){var interval=INTERVALS[tf],cs=sources[tf],htf=detect(symbol,tf,cs);htf.forEach(function(h){var candidates=five.filter(function(s){return sideOf(s)===sideOf(h)&&s.price===h.price&&s.sourceOpenTime>=h.sourceOpenTime&&s.sourceOpenTime<h.sourceOpenTime+interval;});if(candidates.length!==1)return;var row=byId[candidates[0].id];if(!row)return;row.timeframeMembership[tf]={member:true,htfSwingId:h.id,occurredAt:h.sourceOpenTime,confirmedAt:h.confirmedAt,mappingProvenance:{method:'SIDE_AND_EXACT_EXTREMUM_PRICE_WITHIN_HTF_SOURCE_CANDLE_COVERAGE',priceOnly:false,nearestMatch:false,deterministicTieBreakApplied:false}};});});
    return byId;
}
function emptyMembership(){return{confirmed:false,swingId:null,occurredAt:null,confirmedAt:null,provenance:null};}
function createRuntimeSwingContextV1(options) {
    var opts=options||{},symbol=opts.symbol||'UNKNOWN',initial=canonicalCandles(opts.initialCandles5m||[]),membershipById=buildMembership(symbol,initial,opts.structureCandles||{}),builtThrough=initial.length?initial[initial.length-1].closeTime:-Infinity;
    function refresh(){var rows=canonicalCandles(opts.getCandles5m?opts.getCandles5m():initial),last=rows.length?rows[rows.length-1].closeTime:-Infinity;if(last<=builtThrough)return;membershipById=buildMembership(symbol,rows,opts.structureCandles||{});builtThrough=last;}
    function project(input){var req=input||{},evaluationTime=req.evaluationTime;if(!req.canonicalSwingId||!Number.isFinite(evaluationTime))return null;refresh();var registry=opts.getRegistry&&opts.getRegistry(),source=registry&&registry.getById&&registry.getById(req.canonicalSwingId);if(!source||source.confirmedAt>evaluationTime)return null;var structuralState=opts.getStructuralState&&opts.getStructuralState(),record=structuralState&&structuralState.swingBySourceId&&structuralState.swingBySourceId[req.canonicalSwingId];if(!record)return null;var eligible=(record.history||[]).map(function(h,i){return{entry:h,sequence:i};}).filter(function(x){return x.entry.confirmedAt<=evaluationTime;});var current=eligible.length?eligible[eligible.length-1]:null;if(!current)return null;var finalRow=membershipById[req.canonicalSwingId],memberships={};TIMEFRAMES.forEach(function(tf){var member=finalRow&&finalRow.timeframeMembership[tf];if(!member||!member.member||member.confirmedAt>evaluationTime){memberships[tf]=emptyMembership();return;}memberships[tf]={confirmed:true,swingId:member.htfSwingId,occurredAt:member.occurredAt,confirmedAt:member.confirmedAt,provenance:tf==='5m'?{source:'production confirmed 5m Swing identity',underlying5mCanonicalSwingId:req.canonicalSwingId}:{source:'validated confirmed MTF identity mapping',timeframe:tf,htfSwingId:member.htfSwingId,underlying5mCanonicalSwingId:req.canonicalSwingId,htfOccurredAt:member.occurredAt,htfConfirmedAt:member.confirmedAt,mapping:clone(member.mappingProvenance||null)}};});
        return{schemaVersion:'SwingContextV1',canonicalSwingId:req.canonicalSwingId,side:record.side,price:record.price,occurredAt:record.occurredAt,confirmedAt:record.confirmedAt,structural:{currentRole:current.entry.role,currentStatus:current.entry.status,roleAsOf:current.entry.confirmedAt,provenance:{sourceSwingId:req.canonicalSwingId,roleSource:'production structural5m.swingBySourceId history',transitionId:['SWING_CONTEXT_V1','STRUCTURAL_TRANSITION',req.canonicalSwingId,current.entry.confirmedAt,current.sequence,current.entry.role,current.entry.status].join(':'),transitionSequence:current.sequence,transitionRole:current.entry.role,transitionStatus:current.entry.status,effectiveAt:current.entry.confirmedAt,authoritativeStateCopied:false}},timeframeMembership:memberships,evaluationTime:evaluationTime,provenance:{projectionType:'READ_MODEL_AS_OF',swingIdentitySource:'production liquidity registry Swing identity',structuralSource:'production structural5m.swingBySourceId history',mtfSource:'validated confirmed MTF identity mapping',projectorVersion:'SwingContextV1',authoritativeRegistry:false}};
    }
    return{projectSwingContextV1:project,refresh:refresh,builtThrough:function(){return builtThrough;}};
}

module.exports={TIMEFRAMES:TIMEFRAMES,canonicalCandles:canonicalCandles,aggregate15m:aggregate15m,buildMembership:buildMembership,createRuntimeSwingContextV1:createRuntimeSwingContextV1};
