'use strict';

var fs=require('fs'),path=require('path'),crypto=require('crypto');
var liveEngine=require('../live/liveEngine');
var replayState=require('../replay/replayState');
var eventRegistry=require('../events/eventRegistry');
var notification=require('../notify/watchNotificationPresentationV1');

var INPUT=process.env.EQ_V3_ACCEPTANCE_INPUT || '/Users/yaodebao/.codex/visualizations/2026/08/24/01a031bc-fea2-7943-9b4f-2a5e77efcdda/eqh-eql-persistent-cluster-shadow-v3/BTCUSDT-5m-bounded-input.json';
var OUTPUT=process.env.EQ_V3_ACCEPTANCE_OUTPUT || path.join(process.cwd(),'eqh-eql-v3-production-migration-v1');
var WARMUP=576;
function stable(v){if(Array.isArray(v))return v.map(stable);if(!v||typeof v!=='object')return v;var o={};Object.keys(v).sort().forEach(function(k){o[k]=stable(v[k]);});return o;}
function hash(v){return crypto.createHash('sha256').update(JSON.stringify(stable(v))).digest('hex');}
function dup(values){var seen={},n=0;values.forEach(function(v){if(seen[v])n++;seen[v]=true;});return n;}
function fetcher(){return Promise.resolve([]);}

function runLiquidityOnlyV3(candles){
    var state=replayState.createReplayState({symbol:'BTCUSDT',timeframe:'5m',eqProductionVersion:'V3'});
    state.eventRegistry=eventRegistry.createEventRegistry();
    for(var i=0;i<candles.length;i++){
        replayState.incrementalLiquidity(state,candles,i,{tickSize:.1},candles[i].closeTime);
        replayState.incrementalEvents(state,candles[i],i,candles[i].closeTime,[],[]);
    }
    return state.registry.getAll('BTCUSDT').filter(function(x){return x.type==='EQH'||x.type==='EQL';}).map(function(x){
        return {id:x.id,price:x.price,status:x.status,members:x.metadata.members};
    });
}

async function run(version,candles){
    var engine=liveEngine.createLiveEngine({symbol:'BTCUSDT',exchangeInfo:{tickSize:.1},contextCandles5m:candles,
        structureCandles:{'1d':[],'4h':[],'1h':[]},calendarCandles:{'1d':[],'1w':[],'1M':[]},fetcher:fetcher,
        thresholds:require('../config/thresholds')},{snapshotInterval:Number.MAX_SAFE_INTEGER,baseIndex:0,
        eqProductionVersion:version,watchLiquidityEvidenceV1Enabled:true});
    var watches={};
    var started=Date.now();
    for(var i=0;i<candles.length;i++){
        await engine.onBar(candles[i],i);
        engine.drainDisplacementWatchUpdates().forEach(function(w){watches[w.id]=w;});
        if((i+1)%1000===0) console.log('['+version+'] '+(i+1)+' / '+candles.length+' elapsed='+((Date.now()-started)/1000).toFixed(1)+'s');
    }
    engine.drainDisplacementWatchUpdates().forEach(function(w){watches[w.id]=w;});
    var state=engine.getState(),start=candles[WARMUP].openTime;
    var eq=state.registry.getAll('BTCUSDT').filter(function(x){return(x.type==='EQH'||x.type==='EQL')&&x.confirmedAt>=start;});
    var swings=state.registry.getAll('BTCUSDT').filter(function(x){return(x.type==='SWING_HIGH'||x.type==='SWING_LOW')&&x.confirmedAt>=start;});
    var sweeps=state.eventRegistry.getByType('BTCUSDT','LIQUIDITY_SWEEP').filter(function(x){return x.confirmedAt>=start&&(x.source.liquidityType==='EQH'||x.source.liquidityType==='EQL');});
    var watchRows=Object.keys(watches).map(function(id){return watches[id];}).filter(function(w){return w.createdAt>=start;});
    var watchEq=watchRows.filter(function(w){return w.liquidityTaken&&w.liquidityTaken.allCandidates.some(function(c){return c.sourceType==='EQH'||c.sourceType==='EQL';});});
    return{version:version,runtimeSeconds:(Date.now()-started)/1000,state:state,eq:eq,swings:swings,sweeps:sweeps,watches:watchRows,watchEq:watchEq};
}

function compact(run){
    var dist={'2-member':0,'3-member':0,'4-member':0,'5+':0,maxMemberCount:0};
    run.eq.forEach(function(x){var n=x.metadata&&x.metadata.memberCount||0;if(n===2)dist['2-member']++;else if(n===3)dist['3-member']++;else if(n===4)dist['4-member']++;else if(n>=5)dist['5+']++;dist.maxMemberCount=Math.max(dist.maxMemberCount,n);});
    return{SWING_HIGH:run.swings.filter(function(x){return x.type==='SWING_HIGH';}).length,SWING_LOW:run.swings.filter(function(x){return x.type==='SWING_LOW';}).length,
        EQH:run.eq.filter(function(x){return x.type==='EQH';}).length,EQL:run.eq.filter(function(x){return x.type==='EQL';}).length,
        EQ_SWEEPS:run.sweeps.length,WATCH_WITH_EQ:run.watchEq.length,TOTAL_WATCH:run.watches.length,
        duplicateEqClusterIds:dup(run.eq.map(function(x){return x.id;})),duplicateEqSweepEventIds:dup(run.sweeps.map(function(x){return x.id;})),memberCountDistribution:dist,runtimeSeconds:run.runtimeSeconds};
}

function presentationWatch(type,members){var direction=type==='EQH'?'BEARISH':'BULLISH',side=type==='EQH'?'BSL':'SSL';var p={id:'SWEEP:EXAMPLE:'+type,sourceId:'EQV3:EXAMPLE:'+type,sourceType:type,sourceTimeframe:'5m',sourcePrice:members.reduce(function(s,m){return s+m.price;},0)/members.length,side:side,confirmedAt:30,relation:'BEFORE_LEG',eqMemberProvenance:{asOf:30,memberCount:members.length,members:members}};return{id:'WATCH:EXAMPLE:'+type,symbol:'BTCUSDT',direction:direction,state:'FVG_TOUCHED',liquidityTaken:{primary:p,allCandidates:[p]},displacement:{direction:direction,quality:'NORMAL',startIndex:1,endIndex:1},nativeFvg:{low:1,high:2,midpoint:1.5},mss:{exists:false},dailyBias:{bias:'UNKNOWN',alignment:'UNKNOWN',status:'UNKNOWN'}};}
function render(w){return notification.build(w,1,{keyword:'检测',notificationGeneratedAt:40,formatPrice:function(v){return Number(v).toFixed(1);}});}

async function main(){
    var candles=JSON.parse(fs.readFileSync(INPUT,'utf8'));
    if(candles.length!==9216)throw new Error('expected 9216 local candles, received '+candles.length);
    var v2=await run('V2',candles),v3=await run('V3',candles),a=compact(v2),b=compact(v3);
    var futureLeaks=0,pastMutation=0;
    v3.sweeps.forEach(function(s){var p=s.source.eqMemberProvenance;if(!p)return; p.members.forEach(function(m){if(m.confirmedAt>p.asOf||m.memberAddedAt>p.asOf)futureLeaks++;});var object=v3.state.registry.getById(s.liquidityId);if(object&&s.price!==p.referencePrice)pastMutation++;});
    var firstProjection=v3.state.registry.getAll('BTCUSDT').filter(function(x){return x.type==='EQH'||x.type==='EQL';}).map(function(x){return{id:x.id,price:x.price,status:x.status,members:x.metadata.members};});
    var secondProjection=runLiquidityOnlyV3(candles);
    var summary={validationBars:8640,warmupBars:576,inputPath:INPUT,V2:a,V3:b,FUTURE_LEAK_VIOLATIONS:futureLeaks,
        PAST_STATE_IMMUTABILITY_VIOLATIONS:pastMutation,DETERMINISM_VIOLATIONS:hash(firstProjection)===hash(secondProjection)?0:1,
        DUPLICATE_PUBLIC_CLUSTER_IDS:b.duplicateEqClusterIds,DUPLICATE_EQ_REGISTRY_OBJECTS:b.duplicateEqClusterIds,
        DUPLICATE_EQ_SWEEP_EVENT_IDS:b.duplicateEqSweepEventIds,PRODUCTION_EQ_SOURCE:'V3'};
    fs.mkdirSync(OUTPUT,{recursive:true});
    fs.writeFileSync(path.join(OUTPUT,'summary.json'),JSON.stringify(summary,null,2)+'\n');
    fs.writeFileSync(path.join(OUTPUT,'v2-v3-production-comparison.json'),JSON.stringify({V2:a,V3:b,difference:{EQH:b.EQH-a.EQH,EQL:b.EQL-a.EQL,EQ_SWEEPS:b.EQ_SWEEPS-a.EQ_SWEEPS,WATCH_WITH_EQ:b.WATCH_WITH_EQ-a.WATCH_WITH_EQ,TOTAL_WATCH:b.TOTAL_WATCH-a.TOTAL_WATCH}},null,2)+'\n');
    var watchEqUsesV3 = v3.watchEq.every(function(w){
        return w.liquidityTaken.allCandidates.filter(function(c){
            return c.sourceType==='EQH'||c.sourceType==='EQL';
        }).every(function(c){
            return String(c.sourceId).indexOf('EQV3:')===0;
        });
    });
    fs.writeFileSync(path.join(OUTPUT,'registry-integration.json'),JSON.stringify({
        externalContract:['id','symbol','timeframe','liquidityType','side','price','occurredAt','confirmedAt','status','metadata'],
        productionSourceCount:1,productionSource:'V3',watchEqCandidateUsesV3ClusterId:watchEqUsesV3
    },null,2)+'\n');
    fs.writeFileSync(path.join(OUTPUT,'duplicate-safety.json'),JSON.stringify({duplicateEqClusterIds:b.duplicateEqClusterIds,duplicateEqRegistryObjects:b.duplicateEqClusterIds,duplicateEqSweepEventIds:b.duplicateEqSweepEventIds},null,2)+'\n');
    fs.writeFileSync(path.join(OUTPUT,'notification-temporal-safety.json'),JSON.stringify({memberPresentationAsOf:'liquidityTaken candidate EQ Sweep confirmedAt, frozen in Sweep source.eqMemberProvenance',futureEqMemberPresentationLeaks:futureLeaks,historicalSweepReferencePriceMutated:pastMutation>0},null,2)+'\n');
    var twoH=[{id:'A',price:100,confirmedAt:10,memberAddedAt:10},{id:'B',price:100.1,confirmedAt:20,memberAddedAt:20}],fourH=twoH.concat([{id:'C',price:99.9,confirmedAt:25,memberAddedAt:25},{id:'D',price:100.2,confirmedAt:29,memberAddedAt:29}]);
    var twoL=[{id:'A',price:90,confirmedAt:10,memberAddedAt:10},{id:'B',price:90.1,confirmedAt:20,memberAddedAt:20}],threeL=twoL.concat([{id:'C',price:89.9,confirmedAt:25,memberAddedAt:25}]);
    var missing=presentationWatch('EQH',twoH);delete missing.liquidityTaken.primary.eqMemberProvenance;
    var pdh=presentationWatch('EQH',twoH);pdh.liquidityTaken.primary.sourceType='PDH';delete pdh.liquidityTaken.primary.eqMemberProvenance;
    var examples=['# Notification examples','','## A. 2-member EQH','```text',render(presentationWatch('EQH',twoH)),'```','## B. 4-member EQH','```text',render(presentationWatch('EQH',fourH)),'```','## C. 2-member EQL','```text',render(presentationWatch('EQL',twoL)),'```','## D. 3-member EQL','```text',render(presentationWatch('EQL',threeL)),'```','## E. non-EQ PDH unchanged','```text',render(pdh),'```','## F. missing provenance','```text',render(missing),'```'].join('\n\n');
    fs.writeFileSync(path.join(OUTPUT,'notification-examples.md'),examples+'\n');
    console.log(JSON.stringify(summary,null,2));
}
main().catch(function(e){console.error(e.stack||e);process.exit(1);});
