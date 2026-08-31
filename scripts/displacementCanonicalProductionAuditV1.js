'use strict';
var fs=require('fs'),path=require('path'),crypto=require('crypto');
var thresholds=require('../config/thresholds');
var single=require('../events/displacementDetector');
var multi=require('../events/multiCandleDisplacementDetector');
var replayState=require('../replay/replayState');
var replayEngine=require('../replay/replayEngine');
var eventRegistry=require('../events/eventRegistry');
var displacementWatch=require('../stats/displacementWatch');

var ROOT=path.join(__dirname,'..');
var FIXTURES=path.join(ROOT,'research','watch-narrative-sweep-association-audit-v1','fixtures');
var OUTPUT=path.join(ROOT,'production-audits','displacement-a-c2-canonical-cutover-v1','population.json');
var SYMBOLS=[{symbol:'BTCUSDT',tickSize:0.1},{symbol:'ZECUSDT',tickSize:0.01}];
function clone(x){return JSON.parse(JSON.stringify(x));}
function hash(x){return crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');}
function countBy(rows,read){var out={};rows.forEach(function(row){var key=read(row);out[key]=(out[key]||0)+1;});return out;}
function canonicalProjection(store,at,symbol){return store.getAsOf(at,symbol).map(function(d){return{
    id:d.id,direction:d.direction,startIndex:d.startIndex,endIndex:d.endIndex,startAt:d.startAt,endAt:d.endAt,
    confirmedAt:d.confirmedAt,sourceDetections:d.sourceDetections
};});}

function runOne(spec){
    var fixture=JSON.parse(fs.readFileSync(path.join(FIXTURES,spec.symbol+'-5m-futures.json'),'utf8'));
    var candles=fixture.candles, state=replayState.createReplayState({symbol:spec.symbol,timeframe:'5m'});
    state.eventRegistry=eventRegistry.createEventRegistry(); state.atrSeries={};
    var prevAtr=null, rawA=[],rawC2=[],watchStore=displacementWatch.createWatchStore([],{}),firstTouchIds=[];
    var prefixIndexes=[]; for(var p=1;p<=10;p++) prefixIndexes.push(Math.floor((candles.length-1)*p/10));
    var prefixHashes={};
    function emit(d,evaluationTime){
        var w=displacementWatch.buildWatch({symbol:spec.symbol,displacement:d,evaluationTime:evaluationTime,
            sweepEvents:state.eventRegistry.getByType(spec.symbol,'LIQUIDITY_SWEEP'),candles:candles});
        if(w)watchStore.upsert(w);
    }
    for(var i=0;i<candles.length;i++){
        var candle=candles[i],evaluationTime=candle.closeTime;
        replayState.incrementalLiquidity(state,candles,i,{tickSize:spec.tickSize},evaluationTime);
        prevAtr=replayEngine._updateAtrIncremental(state.atrSeries,candles,i,prevAtr,
            thresholds.events.displacement.multiCandle.atrPeriod);
        var a=single.detectSingleCandleDisplacement([candle],{symbol:spec.symbol,timeframe:'5m',baseIndex:i,
            atrSeries:state.atrSeries,thresholds:thresholds});
        var c2=multi.detectAt(candles,i,{symbol:spec.symbol,timeframe:'5m',atrSeries:state.atrSeries,thresholds:thresholds});
        rawA=rawA.concat(a);rawC2=rawC2.concat(c2);
        var ev=replayState.incrementalEvents(state,candle,i,evaluationTime,a.concat(c2));
        ev.displacements.forEach(function(d){emit(d,evaluationTime);});
        state.displacementStore.getEndingAt(i-1,evaluationTime,spec.symbol).forEach(function(d){emit(d,evaluationTime);});
        var touched=watchStore.onCandle(candle);
        touched.forEach(function(w){firstTouchIds.push(w.notificationKey);watchStore.markNotified(w.id,candle.closeTime);});
        if(prefixIndexes.indexOf(i)!==-1)prefixHashes[i]=hash(canonicalProjection(state.displacementStore,evaluationTime,spec.symbol));
    }
    var canon=state.displacementStore.getAll(spec.symbol),watches=watchStore.getAll();
    var prefixMutations=0;Object.keys(prefixHashes).forEach(function(index){var at=candles[Number(index)].closeTime;
        if(prefixHashes[index]!==hash(canonicalProjection(state.displacementStore,at,spec.symbol)))prefixMutations++;});
    return{symbol:spec.symbol,candles:candles,rawA:rawA,rawC2:rawC2,canon:canon,watches:watches,
        firstTouchIds:firstTouchIds,prefixCheckCount:Object.keys(prefixHashes).length,prefixMutations:prefixMutations};
}

function replayCanonical(run,endIndex){
    var state=replayState.createReplayState({symbol:run.symbol,timeframe:'5m'}),prev=null;state.eventRegistry=eventRegistry.createEventRegistry();state.atrSeries={};
    for(var i=0;i<=endIndex;i++){var c=run.candles[i];prev=replayEngine._updateAtrIncremental(state.atrSeries,run.candles,i,prev,thresholds.events.displacement.multiCandle.atrPeriod);
        var a=single.detectSingleCandleDisplacement([c],{symbol:run.symbol,timeframe:'5m',baseIndex:i,atrSeries:state.atrSeries,thresholds:thresholds});
        var c2=multi.detectAt(run.candles,i,{symbol:run.symbol,timeframe:'5m',atrSeries:state.atrSeries,thresholds:thresholds});
        state.displacementStore.process(a.concat(c2),c.closeTime);}
    return state.displacementStore.getAll(run.symbol);
}

function main(){var started=Date.now(),runs=SYMBOLS.map(runOne),allCanon=[],allWatches=[],allTouches=[],rawA=[],rawC2=[];
    runs.forEach(function(r){allCanon=allCanon.concat(r.canon);allWatches=allWatches.concat(r.watches);allTouches=allTouches.concat(r.firstTouchIds);rawA=rawA.concat(r.rawA);rawC2=rawC2.concat(r.rawC2);});
    var c2ByN=countBy(rawC2,function(r){return 'N'+r.metrics.N;}),sourceCounts=allCanon.map(function(d){var sources=d.sourceDetections||[];return{d:d,a:sources.filter(function(s){return s.source==='SINGLE_CANDLE_A';}).length,c2:sources.filter(function(s){return s.source==='MULTI_CANDLE_C2';}).length,later:sources.filter(function(s){return s.attachedAt>d.confirmedAt;}).length};});
    var uniqueTouches=new Set(allTouches),watchIds=countBy(allWatches,function(w){return w.canonicalDisplacementId;}),duplicateWatch=Object.keys(watchIds).filter(function(id){return watchIds[id]>1;}).length;
    var restartMutations=0;runs.forEach(function(r){var rebuilt=replayCanonical(r,r.candles.length-1);if(hash(rebuilt)!==hash(r.canon))restartMutations++;});
    var report={task:'DISPLACEMENT_A_C2_CANONICAL_PRODUCTION_CUTOVER_V1',dataset:'BTCUSDT+ZECUSDT USD-M Futures frozen 2026-07-29..2026-08-30',
        candleCount:runs.reduce(function(n,r){return n+r.candles.length;},0),A_RAW_COUNT:rawA.length,
        C2_N2_RAW_COUNT:c2ByN.N2||0,C2_N3_RAW_COUNT:c2ByN.N3||0,C2_N4_RAW_COUNT:c2ByN.N4||0,C2_N5_RAW_COUNT:c2ByN.N5||0,
        C2_REFERENCE_POPULATION_MATCH:(c2ByN.N2===4365&&c2ByN.N3===4912&&c2ByN.N4===3998&&c2ByN.N5===3033)?'PASS':'FAIL',
        CANONICAL_DISPLACEMENT_COUNT:allCanon.length,CANONICAL_BULLISH_COUNT:allCanon.filter(function(d){return d.direction==='BULLISH';}).length,CANONICAL_BEARISH_COUNT:allCanon.filter(function(d){return d.direction==='BEARISH';}).length,
        A_ONLY_CANONICAL_COUNT:sourceCounts.filter(function(x){return x.a&& !x.c2;}).length,C2_ONLY_CANONICAL_COUNT:sourceCounts.filter(function(x){return !x.a&&x.c2;}).length,A_AND_C2_CANONICAL_COUNT:sourceCounts.filter(function(x){return x.a&&x.c2;}).length,
        CANONICAL_WITH_A_SOURCE_COUNT:sourceCounts.filter(function(x){return x.a;}).length,CANONICAL_WITH_C2_SOURCE_COUNT:sourceCounts.filter(function(x){return x.c2;}).length,CANONICAL_WITH_BOTH_SOURCE_COUNT:sourceCounts.filter(function(x){return x.a&&x.c2;}).length,CANONICAL_WITH_LATER_EVIDENCE_COUNT:sourceCounts.filter(function(x){return x.later;}).length,LATER_EVIDENCE_ATTACHMENT_COUNT:sourceCounts.reduce(function(n,x){return n+x.later;},0),MAX_SOURCE_DETECTIONS_PER_CANONICAL:sourceCounts.reduce(function(n,x){return Math.max(n,x.d.sourceDetections.length);},0),
        TOTAL_RAW_DISPLACEMENT_DETECTIONS:rawA.length+rawC2.length,RAW_COLLAPSED_BY_CANONICALIZATION:rawA.length+rawC2.length-allCanon.length,MULTI_N_COLLAPSED_COUNT:rawC2.length-sourceCounts.filter(function(x){return x.c2;}).length,A_C2_OVERLAP_COLLAPSED_COUNT:sourceCounts.filter(function(x){return x.a&&x.c2;}).length,
        WATCH_COUNT:allWatches.length,WATCH_BULLISH_COUNT:allWatches.filter(function(w){return w.direction==='BULLISH';}).length,WATCH_BEARISH_COUNT:allWatches.filter(function(w){return w.direction==='BEARISH';}).length,WATCH_NO_FVG_COUNT:allWatches.filter(function(w){return w.state==='WATCH_NO_FVG';}).length,FIRST_TOUCH_COUNT:allTouches.length,
        DUPLICATE_WATCH_FROM_A_C2:duplicateWatch,DUPLICATE_FIRST_TOUCH_ID_COUNT:allTouches.length-uniqueTouches.size,
        PREFIX_CHECK_COUNT:runs.reduce(function(n,r){return n+r.prefixCheckCount;},0),PREFIX_MUTATIONS:runs.reduce(function(n,r){return n+r.prefixMutations;},0),RESTART_CHECK_COUNT:runs.length,RESTART_IDENTITY_MUTATIONS:restartMutations,
        replayRuntimeMs:Date.now()-started,bySymbol:runs.map(function(r){return{symbol:r.symbol,A_RAW_COUNT:r.rawA.length,C2_RAW_COUNT:r.rawC2.length,CANONICAL_COUNT:r.canon.length,WATCH_COUNT:r.watches.length,FIRST_TOUCH_COUNT:r.firstTouchIds.length};})};
    fs.mkdirSync(path.dirname(OUTPUT),{recursive:true});fs.writeFileSync(OUTPUT,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}
if(require.main===module)main();
module.exports={runOne:runOne,replayCanonical:replayCanonical};
